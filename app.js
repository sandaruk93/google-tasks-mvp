const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const hpp = require('hpp');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');

// Import configurations
const { 
  rateLimitConfig, 
  speedLimiter, 
  securityHeaders, 
  corsConfig 
} = require('./config/security');

// Import middleware
const { 
  authenticateUser, 
  authorizeResource, 
  requestLogger, 
  errorHandler, 
  securityHeaders: customSecurityHeaders,
  validateSession,
  csrfProtection 
} = require('./middleware/security');

const { 
  sanitizeBody, 
  sanitizeQuery, 
  validateTask, 
  validateTextProcessing, 
  validateTaskConfirmation,
  validateRequestSize 
} = require('./middleware/validation');

const { 
  upload, 
  validateFileContent, 
  cleanupUploads, 
  handleUploadError 
} = require('./middleware/fileUpload');

// Import logging
const { logger } = require('./config/logger');

// Import existing functionality
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
require('dotenv').config();

const app = express();

// Security middleware setup
app.use(helmet(securityHeaders));
app.use(cors(corsConfig));
app.use(compression());
app.use(hpp());
app.use(mongoSanitize());

// Serve static files
app.use(express.static('public'));

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        service: 'omnia-google-tasks-bot',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Login route
app.get('/login', (req, res) => {
    const oAuth2Client = getOAuth2Client();
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent' // Force consent to get refresh token
    });
    res.redirect(authUrl);
});

// Logout route
app.post('/logout', (req, res) => {
    res.clearCookie('userTokens');
    res.clearCookie('csrfToken');
    res.json({ success: true, message: 'Logged out successfully' });
});

// Account information route
app.get('/api/account', authenticateUser, (req, res) => {
    try {
        const oAuth2Client = getOAuth2Client();
        oAuth2Client.setCredentials(req.userTokens);
        
        // Get user info from Google
        const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
        oauth2.userinfo.get()
            .then(response => {
                res.json({
                    success: true,
                    user: {
                        email: response.data.email,
                        name: response.data.name,
                        picture: response.data.picture
                    }
                });
            })
            .catch(error => {
                logger.error('Error getting user info', {
                    error: error.message,
                    userId: req.userId,
                    ip: req.ip
                });
                res.status(500).json({
                    success: false,
                    message: 'Error getting user information'
                });
            });
    } catch (error) {
        logger.error('Error in account route', {
            error: error.message,
            userId: req.userId,
            ip: req.ip
        });
        res.status(500).json({
            success: false,
            message: 'Error processing request'
        });
    }
});

// Custom security headers
app.use(customSecurityHeaders);

// Request parsing with limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Input sanitization
app.use(sanitizeBody);
app.use(sanitizeQuery);

// Request size validation
app.use(validateRequestSize);

// Rate limiting
app.use(rateLimitConfig.general);
app.use(speedLimiter);

// Request logging
app.use(requestLogger);

// Session validation
app.use(validateSession);

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Check if Gemini API key is set
if (!process.env.GEMINI_API_KEY) {
  logger.warn('GEMINI_API_KEY not found in environment variables. Task extraction will fall back to regex patterns.');
}

const SCOPES = ['https://www.googleapis.com/auth/tasks', 'https://www.googleapis.com/auth/userinfo.email'];
const MAX_TASK_LENGTH = 8192; // Google Tasks character limit

function getOAuth2Client() {
  logger.debug('Creating OAuth2 client', { redirectUri: process.env.REDIRECT_URI });
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
}

// Enhanced OAuth callback with security logging
app.get('/oauth2callback', rateLimitConfig.auth, async (req, res) => {
  const code = req.query.code;
  if (!code) {
    logger.warn('OAuth callback missing authorization code', {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    return res.status(400).send('Missing authorization code');
  }

  try {
    const oAuth2Client = getOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(code);
    
    logger.info('OAuth tokens received', {
      tokenKeys: Object.keys(tokens),
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    // Set secure cookie with better options
    res.cookie('userTokens', JSON.stringify(tokens), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    
    // Generate CSRF token
    const csrfToken = require('crypto').randomBytes(32).toString('hex');
    res.cookie('csrfToken', csrfToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    
    logger.info('OAuth authentication successful', {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    res.redirect('/');
  } catch (err) {
    logger.error('OAuth error', {
      error: err.message,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    res.status(500).send(`OAuth2 error: ${err.message}`);
  }
});

// Enhanced task creation with validation and logging
app.post('/add-task', 
  rateLimitConfig.tasks,
  authenticateUser,
  csrfProtection,
  authorizeResource('tasks'),
  validateTask,
  async (req, res) => {
    const { task } = req.body;
    
    try {
      const oAuth2Client = getOAuth2Client();
      const tokens = req.userTokens;
      
      oAuth2Client.setCredentials(tokens);
      
      // Check if we need to refresh the token
      if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
        logger.info('Token expired, attempting refresh', {
          userId: req.userId,
          ip: req.ip
        });
        
        try {
          const { credentials } = await oAuth2Client.refreshAccessToken();
          tokens.access_token = credentials.access_token;
          tokens.expiry_date = credentials.expiry_date;
          
          // Update cookie with new tokens
          res.cookie('userTokens', JSON.stringify(tokens), {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
          });
          
          logger.info('Token refreshed successfully', {
            userId: req.userId,
            ip: req.ip
          });
        } catch (refreshError) {
          logger.error('Token refresh failed', {
            error: refreshError.message,
            userId: req.userId,
            ip: req.ip
          });
          
          return res.status(401).json({
            success: false,
            message: 'Authentication expired. Please sign in again.'
          });
        }
      }
      
      const tasks = google.tasks({ version: 'v1', auth: oAuth2Client });
      
      const taskList = await tasks.tasklists.list();
      const defaultList = taskList.data.items.find(list => list.title === 'My Tasks') || taskList.data.items[0];
      
      if (!defaultList) {
        logger.error('No task list found', {
          userId: req.userId,
          ip: req.ip
        });
        
        return res.status(500).json({
          success: false,
          message: 'No task list available'
        });
      }
      
      const createdTask = await tasks.tasks.insert({
        tasklist: defaultList.id,
        resource: {
          title: task,
          notes: 'Created via Google Meet Tasks Bot'
        }
      });
      
      logger.info('Task created successfully', {
        taskId: createdTask.data.id,
        userId: req.userId,
        ip: req.ip
      });
      
      logTaskOperation('create', {
        taskId: createdTask.data.id,
        userId: req.userId,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      
      res.json({
        success: true,
        message: 'Task created successfully',
        taskId: createdTask.data.id
      });
    } catch (error) {
      logger.error('Task creation failed', {
        error: error.message,
        userId: req.userId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        message: 'Failed to create task'
      });
    }
  }
);

// Enhanced file upload processing with security
app.post('/process-transcript', 
  rateLimitConfig.upload,
  authenticateUser,
  csrfProtection,
  authorizeResource('files'),
  upload.single('transcript'),
  validateFileContent,
  async (req, res) => {
    try {
      // Parse PDF content
      const pdfData = await pdfParse(req.file.buffer);
      const transcriptText = pdfData.text;
      
      logger.info('PDF parsed successfully', {
        userId: req.userId,
        textLength: transcriptText.length,
        ip: req.ip
      });
      
      // Extract action items using Gemini AI
      const actionItems = await extractActionItems(transcriptText);
      
      if (actionItems.length === 0) {
        logger.info('No action items found in transcript', {
          userId: req.userId,
          ip: req.ip
        });
        
        return res.json({ 
          success: true, 
          message: 'Transcript processed successfully, but no action items were found.',
          tasks: []
        });
      }
      
      logger.info('Action items extracted', {
        userId: req.userId,
        itemCount: actionItems.length,
        ip: req.ip
      });
      
      // Return extracted tasks for user review
      res.json({ 
        success: true, 
        message: `Found ${actionItems.length} potential action items. Please review and select the ones you want to add.`,
        tasks: actionItems
      });
      
    } catch (err) {
      logger.error('Error processing transcript', {
        error: err.message,
        userId: req.userId,
        ip: req.ip
      });
      res.json({ success: false, message: `Error processing transcript: ${err.message}` });
    } finally {
      // Clean up file buffer
      cleanupUploads(req, res, () => {});
    }
  }
);

// Enhanced text processing
app.post('/process-text', 
  rateLimitConfig.tasks,
  authenticateUser,
  csrfProtection,
  authorizeResource('tasks'),
  validateTextProcessing,
  async (req, res) => {
    const { text } = req.body;
    
    try {
      logger.info('Text processing started', {
        userId: req.userId,
        textLength: text.length,
        ip: req.ip
      });
      
      // Extract action items using Gemini AI
      const actionItems = await extractActionItems(text);
      
      if (actionItems.length === 0) {
        logger.info('No action items found in text', {
          userId: req.userId,
          ip: req.ip
        });
        
        return res.json({ 
          success: true, 
          message: 'Text processed successfully, but no action items were found.',
          tasks: []
        });
      }
      
      logger.info('Action items extracted from text', {
        userId: req.userId,
        itemCount: actionItems.length,
        ip: req.ip
      });
      
      // Return extracted tasks for user review
      res.json({ 
        success: true, 
        message: `Found ${actionItems.length} potential action items. Please review and select the ones you want to add.`,
        tasks: actionItems
      });
      
    } catch (err) {
      logger.error('Error processing text', {
        error: err.message,
        userId: req.userId,
        ip: req.ip
      });
      res.json({ success: false, message: `Error processing text: ${err.message}` });
    }
  }
);

// Enhanced task confirmation with validation
app.post('/confirm-tasks', 
  rateLimitConfig.tasks,
  authenticateUser,
  authorizeResource('tasks'),
  validateTaskConfirmation,
  async (req, res) => {
    const { tasks } = req.body;
    
    try {
      const oAuth2Client = getOAuth2Client();
      const tokens = req.userTokens;
      
      oAuth2Client.setCredentials(tokens);
      
      // Check if we need to refresh the token
      if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
        logger.info('Token expired, attempting refresh', {
          userId: req.userId,
          ip: req.ip
        });
        
        try {
          const { credentials } = await oAuth2Client.refreshAccessToken();
          logger.info('Token refreshed successfully', {
            userId: req.userId,
            ip: req.ip
          });
          oAuth2Client.setCredentials(credentials);
        } catch (refreshError) {
          logger.error('Failed to refresh token', {
            error: refreshError.message,
            userId: req.userId,
            ip: req.ip
          });
          return res.json({ success: false, message: 'Authentication expired. Please sign in again.' });
        }
      }
      
      const tasksAPI = google.tasks({ version: 'v1', auth: oAuth2Client });
      const createdTasks = [];
      
      for (const taskObj of tasks) {
        const taskText = typeof taskObj === 'string' ? taskObj : taskObj.task;
        const deadline = typeof taskObj === 'string' ? null : taskObj.deadline;
        
        if (taskText && taskText.trim()) {
          try {
            const requestBody = { title: taskText.trim() };
            
            if (deadline) {
              const dueDate = new Date(deadline);
              if (!isNaN(dueDate.getTime())) {
                requestBody.due = dueDate.toISOString();
              }
            }
            
            await tasksAPI.tasks.insert({
              tasklist: '@default',
              requestBody: requestBody,
            });
            
            createdTasks.push(taskText);
          } catch (err) {
            logger.error('Error creating individual task', {
              error: err.message,
              task: taskText,
              userId: req.userId,
              ip: req.ip
            });
          }
        }
      }
      
      logger.info('Tasks creation completed', {
        userId: req.userId,
        requestedCount: tasks.length,
        createdCount: createdTasks.length,
        ip: req.ip
      });
      
      if (createdTasks.length > 0) {
        res.json({ 
          success: true, 
          message: `Successfully created ${createdTasks.length} task(s).` 
        });
      } else {
        res.json({ 
          success: false, 
          message: 'Failed to create any tasks. Please try again.' 
        });
      }
      
    } catch (err) {
      logger.error('Error creating tasks', {
        error: err.message,
        userId: req.userId,
        ip: req.ip
      });
      res.json({ success: false, message: `Error creating tasks: ${err.message}` });
    }
  }
);

// Enhanced account switching
app.get('/switch-account', (req, res) => {
  logger.info('User switching account', {
    userId: req.userId || 'unknown',
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  res.clearCookie('userTokens');
  res.clearCookie('csrfToken');
  
  const oAuth2Client = getOAuth2Client();
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'select_account'
  });
  
  res.redirect(url);
});

// Enhanced account removal
app.post('/remove-account', (req, res) => {
  logger.info('User removing account', {
    userId: req.userId || 'unknown',
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  res.clearCookie('userTokens');
  res.clearCookie('csrfToken');
  res.json({ success: true, message: 'Account removed successfully' });
});

// Import the existing extractActionItems function
async function extractActionItems(text) {
  try {
    logger.debug('Using Gemini AI to extract action items', {
      textLength: text.length
    });
    
    if (!process.env.GEMINI_API_KEY) {
      logger.debug('Gemini API key not found, falling back to regex extraction');
      return extractActionItemsFallback(text);
    }
    
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = 'You are an expert at identifying action items and tasks from meeting transcripts. ' +
      'Please analyze the following meeting transcript and extract all action items, tasks, and responsibilities that were assigned or mentioned. Focus on: ' +
      '1. Tasks assigned to specific people ' +
      '2. Action items that need to be completed ' +
      '3. Follow-up items ' +
      '4. Deadlines or time-sensitive tasks ' +
      '5. Responsibilities mentioned ' +
      'For each action item, identify if there is a specific deadline or time reference mentioned. ' +
      'Return ONLY a JSON array of objects, where each object has: ' +
      '- "task": a clear, concise task description ' +
      '- "deadline": the deadline in ISO 8601 format (YYYY-MM-DDTHH:MM:SS) if mentioned, or null if no deadline ' +
      '- "deadlineText": the original deadline text as mentioned in the transcript (e.g., "by Friday", "tomorrow", "next week") ' +
      'Example output format: [{"task": "Review the quarterly budget", "deadline": "2024-01-15T17:00:00", "deadlineText": "by Friday"}, {"task": "Schedule follow-up meeting", "deadline": null, "deadlineText": null}] ' +
      'Meeting transcript: ' + text;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const geminiResponse = response.text();
    
    logger.debug('Gemini response received', {
      responseLength: geminiResponse.length
    });
    
    let actionItems = [];
    try {
      const cleanedText = geminiResponse.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
      actionItems = JSON.parse(cleanedText);
      
      if (!Array.isArray(actionItems)) {
        logger.error('Gemini response is not an array', {
          responseType: typeof actionItems
        });
        return [];
      }
      
      actionItems = actionItems.filter(item => {
        if (!item || typeof item !== 'object') {
          return false;
        }
        
        if (typeof item === 'string') {
          return item.trim().length > 5 && item.trim().length < 300;
        } else if (item.task) {
          return item.task.trim().length > 5 && item.task.trim().length < 300;
        }
        return false;
      }).map(item => {
        if (typeof item === 'string') {
          return {
            task: item.trim(),
            deadline: null,
            deadlineText: null
          };
        } else {
          return {
            task: item.task.trim(),
            deadline: item.deadline || null,
            deadlineText: item.deadlineText || null
          };
        }
      });
      
      logger.info('Action items extracted successfully', {
        itemCount: actionItems.length
      });
      
      return actionItems;
      
    } catch (parseError) {
      logger.error('Error parsing Gemini response', {
        error: parseError.message,
        rawResponse: geminiResponse
      });
      return extractActionItemsFallback(text);
    }
    
  } catch (error) {
    logger.error('Error using Gemini AI', {
      error: error.message,
      stack: error.stack
    });
    return extractActionItemsFallback(text);
  }
}

// Fallback function using regex patterns
function extractActionItemsFallback(text) {
  const actionItems = [];
  
  const patterns = [
    /\bI\s+(?:will|'ll)\s+([^.!?]+[.!?])/gi,
    /\bI\s+(?:need\s+to|have\s+to)\s+([^.!?]+[.!?])/gi,
    /(?:action\s+item|todo):\s*([^.!?]+[.!?])/gi,
    /next\s+steps?:\s*([^.!?]+[.!?])/gi,
    /follow\s+up:\s*([^.!?]+[.!?])/gi
  ];
  
  patterns.forEach(pattern => {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(match => {
        let cleanItem = match.replace(/^(?:I\s+(?:will|'ll|need\s+to|have\s+to)\s+|(?:action\s+item|todo):\s*|next\s+steps?:\s*|follow\s+up:\s*)/i, '');
        cleanItem = cleanItem.trim().replace(/^[.!?]+/, '').replace(/[.!?]+$/, '');
        
        if (cleanItem.length > 5 && cleanItem.length < 300) {
          actionItems.push({
            task: cleanItem,
            deadline: null,
            deadlineText: null
          });
        }
      });
    }
  });
  
  const uniqueTasks = [];
  const seenTasks = new Set();
  
  actionItems.forEach(item => {
    if (!seenTasks.has(item.task.toLowerCase())) {
      seenTasks.add(item.task.toLowerCase());
      uniqueTasks.push(item);
    }
  });
  
  return uniqueTasks;
}

// Error handling middleware (must be last)
app.use(handleUploadError);
app.use(errorHandler);

module.exports = app; 