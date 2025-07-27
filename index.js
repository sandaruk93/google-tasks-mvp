const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Check if Gemini API key is set
if (!process.env.GEMINI_API_KEY) {
  console.warn('GEMINI_API_KEY not found in environment variables. Task extraction will fall back to regex patterns.');
}

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

const SCOPES = ['https://www.googleapis.com/auth/tasks'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes
const MAX_TASK_LENGTH = 8192; // Google Tasks character limit

function getOAuth2Client() {
  console.log('REDIRECT_URI from env:', process.env.REDIRECT_URI);
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
}

// Handle OAuth callback
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  try {
    const oAuth2Client = getOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(code);
    
    console.log('OAuth tokens received:', Object.keys(tokens));
    
    // Set cookie with better options
    res.cookie('userTokens', JSON.stringify(tokens), {
      httpOnly: true,
      secure: false, // Set to true in production with HTTPS
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    
    console.log('Cookie set, redirecting to /');
    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.status(500).send(`OAuth2 error: ${err.message}`);
  }
});

// Handle add task
app.post('/add-task', async (req, res) => {
  const userTokens = req.cookies && req.cookies.userTokens;
  console.log('User tokens in add-task:', userTokens ? 'PRESENT' : 'MISSING');
  
  if (!userTokens) {
    console.log('No user tokens, returning error');
    return res.json({ success: false, message: 'Not authenticated. Please sign in again.' });
  }

  const { task } = req.body;
  if (!task) {
    return res.json({ success: false, message: 'Task is required' });
  }

  // Check character limit
  if (task.length > MAX_TASK_LENGTH) {
    return res.json({ 
      success: false, 
      message: `Task is too long (${task.length} characters). Maximum ${MAX_TASK_LENGTH} characters allowed.` 
    });
  }

  try {
    const oAuth2Client = getOAuth2Client();
    const tokens = JSON.parse(userTokens);
    
    oAuth2Client.setCredentials(tokens);
    
    // Check if we need to refresh the token
    if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
      console.log('Token expired, attempting refresh...');
      try {
        const { credentials } = await oAuth2Client.refreshAccessToken();
        console.log('Token refreshed successfully');
        oAuth2Client.setCredentials(credentials);
      } catch (refreshError) {
        console.error('Failed to refresh token:', refreshError.message);
        return res.json({ success: false, message: 'Authentication expired. Please sign in again.' });
      }
    }
    
    const tasks = google.tasks({ version: 'v1', auth: oAuth2Client });
    await tasks.tasks.insert({
      tasklist: '@default',
      requestBody: { title: task },
    });

    res.json({ success: true, message: 'Task added successfully!' });
  } catch (err) {
    res.json({ success: false, message: `Error: ${err.message}` });
  }
});

// Handle transcript processing
app.post('/process-transcript', upload.single('transcript'), async (req, res) => {
  const userTokens = req.cookies && req.cookies.userTokens;
  
  if (!userTokens) {
    return res.json({ success: false, message: 'Not authenticated. Please sign in again.' });
  }

  if (!req.file) {
    return res.json({ success: false, message: 'No file uploaded' });
  }

  try {
    // Parse PDF content
    const pdfData = await pdfParse(req.file.buffer);
    const transcriptText = pdfData.text;
    
    console.log('PDF parsed successfully, length:', transcriptText.length);
    
    // Extract action items using Gemini AI
    const actionItems = await extractActionItems(transcriptText);
    
    if (actionItems.length === 0) {
      return res.json({ 
        success: true, 
        message: 'Transcript processed successfully, but no action items were found.',
        tasks: []
      });
    }
    
    // Return extracted tasks for user review
    res.json({ 
      success: true, 
      message: `Found ${actionItems.length} potential action items. Please review and select the ones you want to add.`,
      tasks: actionItems
    });
    
  } catch (err) {
    console.error('Error processing transcript:', err);
    res.json({ success: false, message: `Error processing transcript: ${err.message}` });
  }
});

// Handle task confirmation and creation
app.post('/confirm-tasks', async (req, res) => {
  console.log('confirm-tasks endpoint called');
  console.log('Request body:', req.body);
  
  const userTokens = req.cookies && req.cookies.userTokens;
  console.log('User tokens present:', !!userTokens);
  
  if (!userTokens) {
    console.log('No user tokens found');
    return res.json({ success: false, message: 'Not authenticated. Please sign in again.' });
  }

  const { tasks } = req.body;
  console.log('Tasks received:', tasks);
  
  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
    console.log('Invalid tasks data:', tasks);
    return res.json({ success: false, message: 'No tasks provided for creation.' });
  }

        try {
    // Create tasks for each selected item
    const oAuth2Client = getOAuth2Client();
    console.log('OAuth2Client created');
    
    const tokens = JSON.parse(userTokens);
    console.log('Token keys:', Object.keys(tokens));
    console.log('Has refresh token:', !!tokens.refresh_token);
    
    oAuth2Client.setCredentials(tokens);
    console.log('Credentials set');
    
    // Check if we need to refresh the token
    if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
      console.log('Token expired, attempting refresh...');
      try {
        const { credentials } = await oAuth2Client.refreshAccessToken();
        console.log('Token refreshed successfully');
        oAuth2Client.setCredentials(credentials);
      } catch (refreshError) {
        console.error('Failed to refresh token:', refreshError.message);
        return res.json({ success: false, message: 'Authentication expired. Please sign in again.' });
      }
    }
    
    const tasksAPI = google.tasks({ version: 'v1', auth: oAuth2Client });
    console.log('Tasks API initialized');
    const createdTasks = [];
    
    for (const taskObj of tasks) {
      // Handle both old string format and new object format
      const taskText = typeof taskObj === 'string' ? taskObj : taskObj.task;
      const deadline = typeof taskObj === 'string' ? null : taskObj.deadline;
      
      console.log('Processing task:', taskText);
      console.log('Deadline:', deadline);
      
      if (taskText && taskText.trim()) {
        try {
          console.log('Creating task with title:', taskText.trim());
          console.log('Calling Google Tasks API...');
          
          // Prepare task request body
          const requestBody = { title: taskText.trim() };
          
          // Add due date if deadline is provided
          if (deadline) {
            const dueDate = new Date(deadline);
            if (!isNaN(dueDate.getTime())) {
              requestBody.due = dueDate.toISOString();
              console.log('Adding due date:', requestBody.due);
            }
          }
          
          const result = await tasksAPI.tasks.insert({
            tasklist: '@default',
            requestBody: requestBody,
          });
          console.log('Task created successfully:', result.data);
          createdTasks.push(taskText);
        } catch (err) {
          console.error('Error creating task:', err.message);
          console.error('Full error:', err);
          console.error('Error stack:', err.stack);
        }
      } else {
        console.log('Skipping empty task');
      }
    }
    
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
    console.error('Error creating tasks:', err);
    res.json({ success: false, message: `Error creating tasks: ${err.message}` });
  }
});

// Function to extract action items from transcript text using Gemini AI
async function extractActionItems(text) {
  try {
    console.log('Using Gemini AI to extract action items...');
    
    // Check if Gemini API key is available
    if (!process.env.GEMINI_API_KEY) {
      console.log('Gemini API key not found, falling back to regex extraction');
      return extractActionItemsFallback(text);
    }
    
    // Initialize Gemini model
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    // Create prompt for task extraction with deadline detection
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

    // Generate response from Gemini
    console.log('Calling Gemini API...');
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const geminiResponse = response.text();
    
    console.log('Gemini response received, length:', geminiResponse.length);
    console.log('Gemini response:', geminiResponse);
    
    // Parse the JSON response
    let actionItems = [];
    try {
      // Clean up the response and parse JSON
      const cleanedText = geminiResponse.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
      console.log('Cleaned response for JSON parsing:', cleanedText);
      actionItems = JSON.parse(cleanedText);
      
      // Ensure it's an array
      if (!Array.isArray(actionItems)) {
        console.error('Gemini response is not an array:', actionItems);
        console.error('Response type:', typeof actionItems);
        return [];
      }
      
      // Filter out empty or invalid items and convert to new format
      actionItems = actionItems.filter(item => {
        if (!item || typeof item !== 'object') {
          console.log('Skipping invalid item:', item);
          return false;
        }
        
        // Handle both old string format and new object format
        if (typeof item === 'string') {
          // Convert old string format to new object format
          return item.trim().length > 5 && item.trim().length < 300;
        } else if (item.task) {
          // New object format
          return item.task.trim().length > 5 && item.task.trim().length < 300;
        }
        return false;
      }).map(item => {
        // Convert to consistent object format
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
      
      console.log('Extracted action items:', actionItems);
      return actionItems;
      
    } catch (parseError) {
      console.error('Error parsing Gemini response:', parseError);
      console.error('Raw response:', geminiResponse);
      console.log('Falling back to regex extraction due to parsing error');
      return extractActionItemsFallback(text);
    }
    
  } catch (error) {
    console.error('Error using Gemini AI:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    console.log('Falling back to regex extraction due to Gemini error');
    // Fallback to basic regex extraction if Gemini fails
    return extractActionItemsFallback(text);
  }
}

// Fallback function using regex patterns (in case Gemini fails)
function extractActionItemsFallback(text) {
  const actionItems = [];
  
  // Basic patterns for fallback
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
  
  // Remove duplicates based on task text
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

// Handle logout
app.post('/logout', (req, res) => {
  res.clearCookie('userTokens');
  res.redirect('/');
});

// Handle switch account - forces Google to show account picker
app.get('/switch-account', (req, res) => {
  // Clear current tokens
  res.clearCookie('userTokens');
  
  const oAuth2Client = getOAuth2Client();
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'select_account' // Forces Google to show account picker
  });
  
  res.redirect(url);
});

// Handle remove account - clears tokens and redirects to home
app.post('/remove-account', (req, res) => {
  res.clearCookie('userTokens');
  res.json({ success: true, message: 'Account removed successfully' });
});

// Account management page
app.get('/account', async (req, res) => {
  const userTokens = req.cookies && req.cookies.userTokens;
  
  if (!userTokens) {
    return res.redirect('/');
  }
  
  // Extract user email from Google API
  let userEmail = 'Signed in with Google';
  try {
    const tokens = JSON.parse(userTokens);
    const oAuth2Client = getOAuth2Client();
    oAuth2Client.setCredentials(tokens);
    
    // Get user info from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const userInfo = await oauth2.userinfo.get();
    userEmail = userInfo.data.email;
  } catch (e) {
    console.error('Error getting user email:', e.message);
    // Use default message if API call fails
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Account - Google Tasks MVP</title>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
          margin: 0; 
          padding: 0; 
          background-color: #f8f9fa; 
          color: #333; 
        }
        .container { 
          max-width: 600px; 
          margin: 0 auto; 
          padding: 40px 20px; 
          background: white; 
          min-height: 100vh; 
          box-shadow: 0 0 20px rgba(0,0,0,0.1); 
        }
        .header {
          display: flex;
          align-items: center;
          margin-bottom: 40px;
          padding-bottom: 20px;
          border-bottom: 1px solid #e9ecef;
        }
        .back-btn {
          background: none;
          border: none;
          color: #4285f4;
          font-size: 16px;
          cursor: pointer;
          padding: 8px 12px;
          border-radius: 6px;
          text-decoration: none;
          display: flex;
          align-items: center;
          transition: all 0.2s ease;
        }
        .back-btn:hover {
          background: #f8f9fa;
        }
        .page-title {
          font-size: 28px;
          font-weight: 600;
          color: #1a1a1a;
          margin: 0;
        }
        .user-info {
          background: #f8f9fa;
          padding: 24px;
          border-radius: 12px;
          margin-bottom: 32px;
          border: 1px solid #e9ecef;
        }
        .user-email {
          font-size: 18px;
          font-weight: 500;
          color: #1a1a1a;
          margin: 0 0 8px 0;
        }
        .user-subtitle {
          font-size: 14px;
          color: #6c757d;
          margin: 0;
        }
        
        .account-actions {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
          gap: 24px;
          margin-top: 32px;
        }
        
        .action-card {
          background: white;
          border: 1px solid #e9ecef;
          border-radius: 16px;
          padding: 32px;
          text-align: center;
          transition: all 0.3s ease;
          box-shadow: 0 2px 8px rgba(0,0,0,0.05);
        }
        
        .action-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 8px 32px rgba(0,0,0,0.1);
        }
        
        .action-icon {
          font-size: 48px;
          margin-bottom: 20px;
        }
        
        .action-title {
          font-size: 20px;
          font-weight: 600;
          color: #1a1a1a;
          margin: 0 0 12px 0;
        }
        
        .action-subtitle {
          font-size: 14px;
          color: #6c757d;
          margin: 0 0 24px 0;
          line-height: 1.5;
        }
        
        .action-btn {
          display: inline-block;
          padding: 12px 24px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          text-decoration: none;
          cursor: pointer;
          border: none;
          transition: all 0.2s ease;
          min-width: 140px;
        }
        
        .action-btn.primary {
          background: linear-gradient(135deg, #4285f4 0%, #3367d6 100%);
          color: white;
          box-shadow: 0 4px 12px rgba(66, 133, 244, 0.3);
        }
        
        .action-btn.primary:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(66, 133, 244, 0.4);
        }
        
        .action-btn.danger {
          background: linear-gradient(135deg, #dc3545 0%, #c82333 100%);
          color: white;
          box-shadow: 0 4px 12px rgba(220, 53, 69, 0.3);
        }
        
        .action-btn.danger:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(220, 53, 69, 0.4);
        }
        
        .action-btn.outline-danger {
          background: transparent;
          color: #dc3545;
          border: 1px solid #dc3545;
        }
        
        .action-btn.outline-danger:hover {
          background: #dc3545;
          color: white;
          transform: translateY(-2px);
        }
        
        /* Toast notification styles */
        .toast {
          position: fixed;
          top: 20px;
          right: 20px;
          padding: 12px 20px;
          border-radius: 8px;
          color: white;
          font-size: 14px;
          z-index: 1000;
          opacity: 0;
          transform: translateX(100%);
          transition: all 0.3s ease;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }
        .toast.show {
          opacity: 1;
          transform: translateX(0);
        }
        .toast.success { background-color: #28a745; }
        .toast.error { background-color: #dc3545; }
        .toast.info { background-color: #17a2b8; }
      </style>
      <script>
        function showToast(message, type = 'info') {
          // Remove existing toasts
          const existingToasts = document.querySelectorAll('.toast');
          existingToasts.forEach(toast => toast.remove());
          
          // Create new toast
          const toast = document.createElement('div');
          toast.className = \`toast \${type}\`;
          toast.textContent = message;
          document.body.appendChild(toast);
          
          // Show toast
          setTimeout(() => toast.classList.add('show'), 100);
          
          // Hide toast after 3 seconds
          setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
          }, 3000);
        }
        
        function removeAccount() {
          if (confirm('Are you sure you want to remove this account? You will need to sign in again.')) {
            fetch('/remove-account', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              }
            })
            .then(response => response.json())
            .then(data => {
              if (data.success) {
                showToast(data.message, 'success');
                setTimeout(() => {
                  window.location.href = '/';
                }, 1500);
              } else {
                showToast(data.message, 'error');
              }
            })
            .catch(error => {
              showToast('Network error. Please try again.', 'error');
            });
          }
        }
      </script>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div style="display: flex; align-items: center; gap: 20px;">
            <a href="/" class="back-btn">← Back</a>
            <h1 class="page-title">Account</h1>
          </div>
        </div>
        
        <div class="main-content">
          <div class="hero-section">
            <h1 class="hero-title">Account Management</h1>
            <p class="hero-subtitle">Manage your account settings and preferences</p>
          </div>
          
          <div class="user-info">
            <p class="user-email">You are signed in as ${userEmail}</p>
            <p class="user-subtitle">You can create and manage tasks in your Google Tasks</p>
          </div>
          
          <div class="account-actions">
            <div class="action-card">
              <div class="action-icon">🔄</div>
              <h3 class="action-title">Switch Account</h3>
              <p class="action-subtitle">Sign in with a different Google account</p>
              <a href="/switch-account" class="action-btn primary">Switch Account</a>
            </div>
            
            <div class="action-card">
              <div class="action-icon">🗑️</div>
              <h3 class="action-title">Remove Account</h3>
              <p class="action-subtitle">Completely remove this account from the app</p>
              <button onclick="removeAccount()" class="action-btn outline-danger">Remove Account</button>
            </div>
            
            <div class="action-card">
              <div class="action-icon">🚪</div>
              <h3 class="action-title">Logout</h3>
              <p class="action-subtitle">Sign out from your current session</p>
              <form method="POST" action="/logout" style="display: inline;">
                <button type="submit" class="action-btn danger">Logout</button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Main page
app.get('/', (req, res) => {
  const userTokens = req.cookies && req.cookies.userTokens;
  console.log('User tokens on main page:', userTokens ? 'PRESENT' : 'MISSING');
  console.log('All cookies:', req.cookies);
  
  if (!userTokens) {
    const oAuth2Client = getOAuth2Client();
    const url = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent' // Force consent screen to get refresh token
    });
    
    console.log('Generated OAuth URL:', url);
    
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Google Tasks MVP</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .container { max-width: 500px; margin: 0 auto; }
          .btn { background: #4285f4; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>Google Tasks MVP</h2>
          <p>Sign in with Google to create tasks:</p>
          <a href="${url}" class="btn">Sign in with Google</a>
        </div>
      </body>
      </html>
    `);
  }
  
  // Show task creation form with character limit
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Omnia - AI-Powered Task Extraction</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          color: #333;
        }
        
        .container { 
          max-width: 1200px; 
          margin: 0 auto; 
          padding: 20px;
          background: white;
          min-height: 100vh;
          box-shadow: 0 0 50px rgba(0,0,0,0.1);
        }
        
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px 0;
          border-bottom: 1px solid #e9ecef;
          margin-bottom: 40px;
        }
        
        .logo {
          font-size: 32px;
          font-weight: 700;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        
        .nav-menu {
          display: flex;
          align-items: center;
          gap: 20px;
        }
        
        .dropdown {
          position: relative;
          display: inline-block;
        }
        
        .dropdown-btn {
          background: none;
          border: none;
          color: #4285f4;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          padding: 8px 12px;
          border-radius: 6px;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        
        .dropdown-btn:hover {
          background: #f8f9fa;
        }
        
        .dropdown-content {
          display: none;
          position: absolute;
          right: 0;
          background: white;
          min-width: 200px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.1);
          border-radius: 8px;
          z-index: 1000;
          overflow: hidden;
        }
        
        .dropdown-content a {
          color: #333;
          padding: 12px 16px;
          text-decoration: none;
          display: block;
          transition: background 0.2s ease;
          font-size: 14px;
        }
        
        .dropdown-content a:hover {
          background: #f8f9fa;
        }
        
        .dropdown:hover .dropdown-content {
          display: block;
        }
        
        .account-link {
          text-decoration: none;
          color: #4285f4;
          font-size: 14px;
          font-weight: 500;
          padding: 8px 12px;
          border-radius: 6px;
          transition: all 0.2s ease;
        }
        
        .account-link:hover {
          background: #f8f9fa;
        }
        
        .main-content {
          max-width: 800px;
          margin: 0 auto;
        }
        
        .hero-section {
          text-align: center;
          margin-bottom: 40px;
        }
        
        .hero-title {
          font-size: 36px;
          font-weight: 700;
          color: #1a1a1a;
          margin-bottom: 16px;
          line-height: 1.2;
        }
        
        .hero-subtitle {
          font-size: 18px;
          color: #666;
          margin-bottom: 32px;
          line-height: 1.6;
        }
        
        .upload-section {
          background: #f8f9fa;
          border-radius: 16px;
          padding: 40px;
          margin-bottom: 20px;
          border: 2px dashed #dee2e6;
          transition: all 0.3s ease;
        }
        
        .upload-section:hover {
          border-color: #4285f4;
          background: #f0f4ff;
        }
        
        .upload-section.dragover {
          border-color: #4285f4;
          background: #f0f4ff;
          transform: scale(1.02);
        }
        
        .upload-area {
          text-align: center;
          cursor: pointer;
        }
        
        .upload-icon {
          font-size: 64px;
          color: #4285f4;
          margin-bottom: 20px;
        }
        
        .upload-title {
          font-size: 24px;
          font-weight: 600;
          color: #1a1a1a;
          margin-bottom: 12px;
        }
        
        .upload-subtitle {
          font-size: 16px;
          color: #666;
          margin-bottom: 8px;
        }
        
        .upload-info {
          font-size: 14px;
          color: #888;
        }
        
        .file-info {
          display: none;
          margin-top: 24px;
          padding: 20px;
          background: white;
          border-radius: 12px;
          border: 1px solid #e9ecef;
          box-shadow: 0 4px 12px rgba(0,0,0,0.05);
        }
        
        .process-btn {
          background: linear-gradient(135deg, #4285f4 0%, #3367d6 100%);
          color: white;
          padding: 16px 32px;
          border: none;
          border-radius: 12px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          margin-top: 24px;
          box-shadow: 0 4px 12px rgba(66, 133, 244, 0.3);
        }
        
        .process-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(66, 133, 244, 0.4);
        }
        
        .process-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }
        
        .task-review-section {
          display: none;
          margin-top: 40px;
          padding: 32px;
          background: white;
          border-radius: 16px;
          border: 1px solid #e9ecef;
          box-shadow: 0 8px 32px rgba(0,0,0,0.1);
        }
        
        .review-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 24px;
          flex-wrap: wrap;
          gap: 16px;
        }
        
        .review-title {
          font-size: 24px;
          font-weight: 600;
          color: #1a1a1a;
        }
        
        .review-actions {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
        }
        
        .btn {
          padding: 10px 20px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          border: none;
          transition: all 0.2s ease;
        }
        
        .btn-primary {
          background: #4285f4;
          color: white;
        }
        
        .btn-primary:hover {
          background: #3367d6;
        }
        
        .btn-secondary {
          background: #f8f9fa;
          color: #333;
          border: 1px solid #dee2e6;
        }
        
        .btn-secondary:hover {
          background: #e9ecef;
        }
        
        .task-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
          gap: 24px;
          margin-top: 24px;
        }
        
        .task-item {
          border: 1px solid #e9ecef;
          border-radius: 12px;
          padding: 20px;
          background: white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.05);
          transition: all 0.2s ease;
        }
        
        .task-item:hover {
          box-shadow: 0 4px 16px rgba(0,0,0,0.1);
        }
        
        .task-content {
          display: flex;
          align-items: flex-start;
          gap: 16px;
        }
        
        .task-checkbox {
          width: 20px;
          height: 20px;
          cursor: pointer;
          margin-top: 8px;
        }
        
        .task-textarea {
          width: 100%;
          padding: 16px;
          border: 1px solid #dee2e6;
          border-radius: 8px;
          resize: none;
          height: 120px;
          font-size: 14px;
          line-height: 1.5;
          font-family: inherit;
          transition: border-color 0.2s ease;
        }
        
        .task-textarea:focus {
          outline: none;
          border-color: #4285f4;
          box-shadow: 0 0 0 3px rgba(66, 133, 244, 0.1);
        }
        
        .deadline-section {
          margin-top: 16px;
          padding: 16px;
          background: #f8f9fa;
          border-radius: 8px;
          border-left: 4px solid #4285f4;
        }
        
        .deadline-label {
          font-size: 12px;
          color: #666;
          margin-bottom: 8px;
          font-weight: 500;
        }
        
        .deadline-input {
          width: 100%;
          padding: 12px;
          border: 1px solid #dee2e6;
          border-radius: 6px;
          font-size: 14px;
          transition: border-color 0.2s ease;
        }
        
        .deadline-input:focus {
          outline: none;
          border-color: #4285f4;
        }
        
        .deadline-help {
          font-size: 11px;
          color: #888;
          margin-top: 6px;
        }
        
        /* Toast notification styles */
        .toast {
          position: fixed;
          top: 20px;
          right: 20px;
          padding: 16px 24px;
          border-radius: 8px;
          color: white;
          font-size: 14px;
          font-weight: 500;
          z-index: 1000;
          opacity: 0;
          transform: translateX(100%);
          transition: all 0.3s ease;
          box-shadow: 0 8px 32px rgba(0,0,0,0.15);
        }
        
        .toast.show {
          opacity: 1;
          transform: translateX(0);
        }
        
        .toast.success { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); }
        .toast.error { background: linear-gradient(135deg, #dc3545 0%, #e74c3c 100%); }
        .toast.info { background: linear-gradient(135deg, #17a2b8 0%, #20c997 100%); }
        
        /* Responsive design */
        @media (max-width: 768px) {
          .container {
            padding: 16px;
          }
          
          .header {
            flex-direction: column;
            gap: 16px;
            text-align: center;
          }
          
          .nav-menu {
            justify-content: center;
          }
          
          .hero-title {
            font-size: 28px;
          }
          
          .hero-subtitle {
            font-size: 16px;
          }
          
          .upload-section {
            padding: 24px;
          }
          
          .upload-icon {
            font-size: 48px;
          }
          
          .upload-title {
            font-size: 20px;
          }
          
          .task-grid {
            grid-template-columns: 1fr;
            gap: 16px;
          }
          
          .review-header {
            flex-direction: column;
            align-items: stretch;
          }
          
          .review-actions {
            justify-content: center;
          }
        }
      </style>
      <script>
        function updateFileInfo() {
          const fileInput = document.getElementById('transcriptFile');
          const fileInfo = document.getElementById('fileInfo');
          const fileName = document.getElementById('fileName');
          const fileSize = document.getElementById('fileSize');
          const submitBtn = document.getElementById('submitBtn');
          
          if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            const maxSize = ${MAX_FILE_SIZE};
            
            fileName.textContent = file.name;
            fileSize.textContent = \`Size: \${(file.size / 1024 / 1024).toFixed(2)} MB\`;
            fileInfo.style.display = 'block';
            
            if (file.size > maxSize) {
              showToast(\`File too large (\${(file.size / 1024 / 1024).toFixed(2)} MB). Maximum 10MB allowed.\`, 'error');
              submitBtn.disabled = true;
            } else {
              submitBtn.disabled = false;
            }
          } else {
            fileInfo.style.display = 'none';
            submitBtn.disabled = true;
          }
        }
        
        function showToast(message, type = 'info') {
          // Remove existing toasts
          const existingToasts = document.querySelectorAll('.toast');
          existingToasts.forEach(toast => toast.remove());
          
          // Create new toast
          const toast = document.createElement('div');
          toast.className = \`toast \${type}\`;
          toast.textContent = message;
          document.body.appendChild(toast);
          
          // Show toast
          setTimeout(() => toast.classList.add('show'), 100);
          
          // Hide toast after 3 seconds
          setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
          }, 3000);
        }
        
        function processTranscript() {
          const fileInput = document.getElementById('transcriptFile');
          const submitBtn = document.getElementById('submitBtn');
          
          if (!fileInput.files.length) {
            showToast('Please select a PDF file', 'error');
            return;
          }
          
          const file = fileInput.files[0];
          const maxSize = ${MAX_FILE_SIZE};
          
          if (file.size > maxSize) {
            showToast(\`File too large (\${(file.size / 1024 / 1024).toFixed(2)} MB). Maximum 10MB allowed.\`, 'error');
            return;
          }
          
          // Show loading state
          submitBtn.textContent = 'Processing...';
          submitBtn.disabled = true;
          
          // Create FormData for file upload
          const formData = new FormData();
          formData.append('transcript', file);
          
          // Submit transcript via AJAX
          fetch('/process-transcript', {
            method: 'POST',
            body: formData
          })
          .then(response => response.json())
          .then(data => {
            if (data.success) {
              showToast(data.message, 'success');
              // Show task review section
              displayTaskReview(data.tasks);
              // Reset file input
              fileInput.value = '';
              document.getElementById('fileInfo').style.display = 'none';
            } else {
              showToast(data.message, 'error');
            }
          })
          .catch(error => {
            showToast('Network error. Please try again.', 'error');
          })
          .finally(() => {
            // Reset loading state
            submitBtn.textContent = 'Process';
            submitBtn.disabled = false;
          });
        }
        
        function displayTaskReview(tasks) {
          const taskReviewSection = document.getElementById('taskReviewSection');
          const taskList = document.getElementById('taskList');
          const confirmBtn = document.getElementById('confirmBtn');
          
          if (tasks.length === 0) {
            taskReviewSection.style.display = 'none';
            return;
          }
          
          // Clear previous tasks
          taskList.innerHTML = '';
          
          // Create task grid
          const taskGrid = document.createElement('div');
          taskGrid.className = 'task-grid';
          
          tasks.forEach((taskObj, index) => {
            // Handle both old string format and new object format
            const taskText = typeof taskObj === 'string' ? taskObj : taskObj.task;
            const deadline = typeof taskObj === 'string' ? null : taskObj.deadline;
            const deadlineText = typeof taskObj === 'string' ? null : taskObj.deadlineText;
            
            const taskItem = document.createElement('div');
            taskItem.className = 'task-item';
            
            // Create deadline display and input
            let deadlineHtml = '';
            if (deadline || deadlineText) {
              const deadlineDate = deadline ? new Date(deadline) : null;
              const formattedDate = deadlineDate ? deadlineDate.toISOString().slice(0, 16) : '';
              deadlineHtml = \`
                <div class="deadline-section">
                  <div class="deadline-label">
                    <strong>Deadline:</strong> \${deadlineText || 'Detected deadline'}
                  </div>
                  <input 
                    type="datetime-local" 
                    id="deadline\${index}" 
                    value="\${formattedDate}"
                    class="deadline-input"
                    onchange="updateDeadline(\${index})"
                  >
                  <div class="deadline-help">
                    You can modify the date and time above
                  </div>
                </div>
              \`;
            }
            
            taskItem.innerHTML = \`
              <div class="task-content">
                <div>
                  <input type="checkbox" id="task\${index}" class="task-checkbox" onchange="updateConfirmButton()">
                </div>
                <div style="flex: 1;">
                  <textarea 
                    id="taskText\${index}" 
                    class="task-textarea"
                    oninput="updateTaskText(\${index})"
                    placeholder="Edit task description here..."
                    maxlength="${MAX_TASK_LENGTH}"
                  >\${taskText}</textarea>
                  \${deadlineHtml}
                </div>
              </div>
            \`;
            taskGrid.appendChild(taskItem);
          });
          
          taskList.appendChild(taskGrid);
          
          // Show review section
          taskReviewSection.style.display = 'block';
          confirmBtn.style.display = 'inline-block';
          
          // Initialize the select all button text
          initializeSelectAllButton();
          
          // Scroll to review section
          taskReviewSection.scrollIntoView({ behavior: 'smooth' });
        }
        
        function updateTaskText(index) {
          // This function can be used for any text editing validation if needed
        }
        
        function updateDeadline(index) {
          // This function can be used for deadline validation if needed
        }
        
        function toggleSelectAll() {
          const checkboxes = document.querySelectorAll('#taskList input[type="checkbox"]');
          const selectAllBtn = document.getElementById('selectAllBtn');
          const allChecked = Array.from(checkboxes).every(cb => cb.checked);
          
          checkboxes.forEach(checkbox => {
            checkbox.checked = !allChecked;
          });
          
          selectAllBtn.textContent = allChecked ? 'Select All' : 'Deselect All';
          updateConfirmButton();
        }
        
        // Initialize the select all button text when tasks are displayed
        function initializeSelectAllButton() {
          const checkboxes = document.querySelectorAll('#taskList input[type="checkbox"]');
          const selectAllBtn = document.getElementById('selectAllBtn');
          const allChecked = Array.from(checkboxes).every(cb => cb.checked);
          selectAllBtn.textContent = allChecked ? 'Select All' : 'Deselect All';
        }
        
        function updateConfirmButton() {
          const checkboxes = document.querySelectorAll('#taskList input[type="checkbox"]:checked');
          const confirmBtn = document.getElementById('confirmBtn');
          
          if (checkboxes.length > 0) {
            confirmBtn.style.display = 'inline-block';
            confirmBtn.textContent = \`Confirm (\${checkboxes.length} tasks)\`;
          } else {
            confirmBtn.style.display = 'none';
          }
        }
        
        function confirmTasks() {
          const checkboxes = document.querySelectorAll('#taskList input[type="checkbox"]:checked');
          const confirmBtn = document.getElementById('confirmBtn');
          
          if (checkboxes.length === 0) {
            showToast('Please select at least one task', 'error');
            return;
          }
          
          // Collect selected tasks with deadlines
          const selectedTasks = [];
          checkboxes.forEach(checkbox => {
            const index = checkbox.id.replace('task', '');
            const taskText = document.getElementById(\`taskText\${index}\`).value.trim();
            const deadlineInput = document.getElementById(\`deadline\${index}\`);
            const deadline = deadlineInput ? deadlineInput.value : null;
            
            if (taskText) {
              selectedTasks.push({
                task: taskText,
                deadline: deadline
              });
            }
          });
          
          console.log('Selected tasks to create:', selectedTasks);
          
          if (selectedTasks.length === 0) {
            showToast('Please enter text for at least one task', 'error');
            return;
          }
          
          // Show loading state
          confirmBtn.textContent = 'Creating Tasks...';
          confirmBtn.disabled = true;
          
          // Submit selected tasks
          console.log('Sending request to /confirm-tasks with data:', { tasks: selectedTasks });
          fetch('/confirm-tasks', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ tasks: selectedTasks })
          })
          .then(response => {
            console.log('Response status:', response.status);
            console.log('Response headers:', response.headers);
            if (!response.ok) {
              throw new Error(\`HTTP error! status: \${response.status}\`);
            }
            return response.json();
          })
          .then(data => {
            console.log('Response data:', data);
            if (data.success) {
              showToast(data.message, 'success');
              // Hide review section
              document.getElementById('taskReviewSection').style.display = 'none';
            } else {
              showToast(data.message, 'error');
            }
          })
          .catch(error => {
            console.error('Error in confirmTasks:', error);
            console.error('Error details:', error.message);
            showToast('Network error. Please try again.', 'error');
          })
          .finally(() => {
            // Reset loading state
            confirmBtn.textContent = \`Confirm (\${selectedTasks.length} tasks)\`;
            confirmBtn.disabled = false;
          });
        }
        
        // Drag and drop functionality
        function setupDragAndDrop() {
          const uploadSection = document.getElementById('uploadSection');
          const fileInput = document.getElementById('transcriptFile');
          
          // Prevent default drag behaviors
          ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            uploadSection.addEventListener(eventName, preventDefaults, false);
            document.body.addEventListener(eventName, preventDefaults, false);
          });
          
          // Highlight drop area when item is dragged over it
          ['dragenter', 'dragover'].forEach(eventName => {
            uploadSection.addEventListener(eventName, highlight, false);
          });
          
          ['dragleave', 'drop'].forEach(eventName => {
            uploadSection.addEventListener(eventName, unhighlight, false);
          });
          
          // Handle dropped files
          uploadSection.addEventListener('drop', handleDrop, false);
          
          function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
          }
          
          function highlight(e) {
            uploadSection.classList.add('dragover');
          }
          
          function unhighlight(e) {
            uploadSection.classList.remove('dragover');
          }
          
          function handleDrop(e) {
            const dt = e.dataTransfer;
            const files = dt.files;
            
            if (files.length > 0) {
              const file = files[0];
              
              // Check if it's a PDF file
              if (file.type === 'application/pdf') {
                fileInput.files = files;
                updateFileInfo();
              } else {
                showToast('Please select a PDF file', 'error');
              }
            }
          }
        }
        
        window.onload = function() { 
          setupDragAndDrop();
        };
      </script>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div style="display: flex; align-items: center; gap: 20px;">
            <div class="logo">Omnia</div>
          </div>
          <div class="nav-menu">
            <div class="dropdown">
              <button class="dropdown-btn">
                About ▼
              </button>
              <div class="dropdown-content">
                <a href="/privacy-policy">Privacy Policy</a>
                <a href="/terms-conditions">Terms & Conditions</a>
              </div>
            </div>
            <a href="/account" class="account-link">Account</a>
          </div>
        </div>
        
        <div class="main-content">
          <div class="hero-section">
            <h1 class="hero-title">AI-Powered Task Extraction</h1>
            <p class="hero-subtitle">Upload your meeting transcript and let our AI identify action items, deadlines, and create tasks in your Google Tasks automatically.</p>
          </div>
          
          <div class="upload-section" id="uploadSection">
            <input 
              type="file" 
              id="transcriptFile" 
              name="transcript" 
              accept=".pdf"
              style="display: none;"
              onchange="updateFileInfo()"
            />
            <div class="upload-area" onclick="document.getElementById('transcriptFile').click();">
              <div class="upload-icon">📄</div>
              <div class="upload-title">Upload Meeting Transcript</div>
              <div class="upload-subtitle">Click to select a PDF file or drag and drop</div>
              <div class="upload-info">Maximum file size: 10MB</div>
            </div>
            
            <div id="fileInfo" class="file-info">
              <div style="font-weight: 600; margin-bottom: 8px;">Selected file:</div>
              <div id="fileName" style="margin-bottom: 4px;"></div>
              <div id="fileSize" style="color: #666; font-size: 14px;"></div>
            </div>
          </div>
          
          <button type="button" id="submitBtn" class="process-btn" disabled onclick="processTranscript()">
            Process
          </button>
          
          <div id="taskReviewSection" class="task-review-section">
            <div class="review-header">
              <h2 class="review-title">Review Extracted Tasks</h2>
              <div class="review-actions">
                <button id="selectAllBtn" class="btn btn-secondary" onclick="toggleSelectAll()">Select All</button>
                <button id="confirmBtn" class="btn btn-primary" onclick="confirmTasks()" style="display: none;">Confirm (0 tasks)</button>
              </div>
            </div>
            <div id="taskList"></div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Privacy Policy page
app.get('/privacy-policy', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Privacy Policy - Omnia</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          color: #333;
        }
        
        .container { 
          max-width: 800px; 
          margin: 0 auto; 
          padding: 20px;
          background: white;
          min-height: 100vh;
          box-shadow: 0 0 50px rgba(0,0,0,0.1);
        }
        
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px 0;
          border-bottom: 1px solid #e9ecef;
          margin-bottom: 40px;
        }
        
        .logo {
          font-size: 32px;
          font-weight: 700;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        
        .back-link {
          text-decoration: none;
          color: #4285f4;
          font-size: 16px;
          font-weight: 500;
          padding: 8px 12px;
          border-radius: 6px;
          transition: all 0.2s ease;
        }
        
        .back-link:hover {
          background: #f8f9fa;
        }
        
        .content {
          line-height: 1.8;
          color: #333;
        }
        
        .content h1 {
          font-size: 32px;
          font-weight: 700;
          color: #1a1a1a;
          margin-bottom: 24px;
        }
        
        .content h2 {
          font-size: 24px;
          font-weight: 600;
          color: #1a1a1a;
          margin: 32px 0 16px 0;
        }
        
        .content h3 {
          font-size: 20px;
          font-weight: 600;
          color: #1a1a1a;
          margin: 24px 0 12px 0;
        }
        
        .content p {
          margin-bottom: 16px;
          font-size: 16px;
        }
        
        .content ul {
          margin-bottom: 16px;
          padding-left: 24px;
        }
        
        .content li {
          margin-bottom: 8px;
          font-size: 16px;
        }
        
        @media (max-width: 768px) {
          .container {
            padding: 16px;
          }
          
          .header {
            flex-direction: column;
            gap: 16px;
            text-align: center;
          }
          
          .content h1 {
            font-size: 28px;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div style="display: flex; align-items: center; gap: 20px;">
            <a href="/" class="back-link">← Back</a>
            <div class="logo">Omnia</div>
          </div>
        </div>
        
        <div class="content">
          <h1>Privacy Policy</h1>
          
          <p><strong>Last updated: [Date]</strong></p>
          
          <p>Welcome to Omnia. This Privacy Policy explains how we collect, use, and protect your information when you use our AI-powered task extraction service.</p>
          
          <h2>Information We Collect</h2>
          
          <h3>Meeting Transcripts</h3>
          <p>When you upload meeting transcripts, we temporarily process the content to extract action items and tasks. The transcript content is:</p>
          <ul>
            <li>Processed using AI to identify tasks and deadlines</li>
            <li>Not stored permanently on our servers</li>
            <li>Used only for the purpose of task extraction</li>
            <li>Deleted after processing is complete</li>
          </ul>
          
          <h3>Google Account Information</h3>
          <p>To create tasks in your Google Tasks, we require access to your Google account. We collect:</p>
          <ul>
            <li>Authentication tokens for Google Tasks API access</li>
            <li>No personal information beyond what's necessary for task creation</li>
            <li>Tokens are stored securely and can be revoked at any time</li>
          </ul>
          
          <h2>How We Use Your Information</h2>
          <p>We use the collected information to:</p>
          <ul>
            <li>Process meeting transcripts and extract action items</li>
            <li>Create tasks in your Google Tasks account</li>
            <li>Provide you with the core functionality of our service</li>
            <li>Improve our AI algorithms and service quality</li>
          </ul>
          
          <h2>Data Security</h2>
          <p>We implement appropriate security measures to protect your information:</p>
          <ul>
            <li>All data transmission is encrypted using HTTPS</li>
            <li>Authentication tokens are stored securely</li>
            <li>Meeting transcripts are processed in memory and not permanently stored</li>
            <li>Regular security audits and updates</li>
          </ul>
          
          <h2>Third-Party Services</h2>
          <p>We use the following third-party services:</p>
          <ul>
            <li><strong>Google APIs:</strong> For authentication and task creation</li>
            <li><strong>Gemini AI:</strong> For intelligent task extraction from transcripts</li>
          </ul>
          
          <h2>Your Rights</h2>
          <p>You have the right to:</p>
          <ul>
            <li>Access your personal information</li>
            <li>Request deletion of your data</li>
            <li>Revoke Google account access at any time</li>
            <li>Contact us with privacy concerns</li>
          </ul>
          
          <h2>Contact Us</h2>
          <p>If you have any questions about this Privacy Policy, please contact us at [contact information].</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Terms & Conditions page
app.get('/terms-conditions', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Terms & Conditions - Omnia</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          color: #333;
        }
        
        .container { 
          max-width: 800px; 
          margin: 0 auto; 
          padding: 20px;
          background: white;
          min-height: 100vh;
          box-shadow: 0 0 50px rgba(0,0,0,0.1);
        }
        
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px 0;
          border-bottom: 1px solid #e9ecef;
          margin-bottom: 40px;
        }
        
        .logo {
          font-size: 32px;
          font-weight: 700;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        
        .back-link {
          text-decoration: none;
          color: #4285f4;
          font-size: 16px;
          font-weight: 500;
          padding: 8px 12px;
          border-radius: 6px;
          transition: all 0.2s ease;
        }
        
        .back-link:hover {
          background: #f8f9fa;
        }
        
        .content {
          line-height: 1.8;
          color: #333;
        }
        
        .content h1 {
          font-size: 32px;
          font-weight: 700;
          color: #1a1a1a;
          margin-bottom: 24px;
        }
        
        .content h2 {
          font-size: 24px;
          font-weight: 600;
          color: #1a1a1a;
          margin: 32px 0 16px 0;
        }
        
        .content h3 {
          font-size: 20px;
          font-weight: 600;
          color: #1a1a1a;
          margin: 24px 0 12px 0;
        }
        
        .content p {
          margin-bottom: 16px;
          font-size: 16px;
        }
        
        .content ul {
          margin-bottom: 16px;
          padding-left: 24px;
        }
        
        .content li {
          margin-bottom: 8px;
          font-size: 16px;
        }
        
        @media (max-width: 768px) {
          .container {
            padding: 16px;
          }
          
          .header {
            flex-direction: column;
            gap: 16px;
            text-align: center;
          }
          
          .content h1 {
            font-size: 28px;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div style="display: flex; align-items: center; gap: 20px;">
            <a href="/" class="back-link">← Back</a>
            <div class="logo">Omnia</div>
          </div>
        </div>
        
        <div class="content">
          <h1>Terms & Conditions</h1>
          
          <p><strong>Last updated: [Date]</strong></p>
          
          <p>By using Omnia, you agree to these Terms & Conditions. Please read them carefully before using our service.</p>
          
          <h2>Service Description</h2>
          <p>Omnia is an AI-powered task extraction service that:</p>
          <ul>
            <li>Processes meeting transcripts to identify action items and deadlines</li>
            <li>Creates tasks in your Google Tasks account</li>
            <li>Provides an intuitive interface for reviewing and editing extracted tasks</li>
          </ul>
          
          <h2>Acceptable Use</h2>
          <p>You agree to use Omnia only for lawful purposes and in accordance with these Terms. You must not:</p>
          <ul>
            <li>Upload content that violates any applicable laws or regulations</li>
            <li>Use the service to process confidential or sensitive information without proper authorization</li>
            <li>Attempt to reverse engineer or compromise the service</li>
            <li>Use the service for any commercial purposes without our written consent</li>
          </ul>
          
          <h2>User Responsibilities</h2>
          <p>As a user of Omnia, you are responsible for:</p>
          <ul>
            <li>Ensuring you have the right to upload and process meeting transcripts</li>
            <li>Reviewing and validating extracted tasks before creation</li>
            <li>Managing your Google account access and permissions</li>
            <li>Maintaining the security of your account credentials</li>
          </ul>
          
          <h2>Intellectual Property</h2>
          <p>Omnia and its content are protected by intellectual property laws. You retain ownership of your meeting transcripts and created tasks.</p>
          
          <h2>Limitation of Liability</h2>
          <p>Omnia is provided "as is" without warranties. We are not liable for:</p>
          <ul>
            <li>Inaccuracies in task extraction or deadline detection</li>
            <li>Loss of data or service interruptions</li>
            <li>Any damages arising from the use of our service</li>
          </ul>
          
          <h2>Service Availability</h2>
          <p>We strive to maintain high service availability but cannot guarantee uninterrupted access. We may:</p>
          <ul>
            <li>Perform maintenance that temporarily affects service</li>
            <li>Update or modify features with reasonable notice</li>
            <li>Suspend service for security or technical reasons</li>
          </ul>
          
          <h2>Termination</h2>
          <p>We may terminate or suspend your access to Omnia at any time for violations of these Terms or for any other reason at our discretion.</p>
          
          <h2>Changes to Terms</h2>
          <p>We may update these Terms from time to time. Continued use of the service after changes constitutes acceptance of the new Terms.</p>
          
          <h2>Contact Information</h2>
          <p>For questions about these Terms & Conditions, please contact us at [contact information].</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Omnia running on port ' + PORT);
  console.log('Environment variables:');
  console.log('GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'SET' : 'NOT SET');
  console.log('GOOGLE_CLIENT_SECRET:', process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'NOT SET');
  console.log('REDIRECT_URI:', process.env.REDIRECT_URI || 'NOT SET');
  console.log('GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET');
});
