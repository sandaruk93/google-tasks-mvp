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
    oAuth2Client.setCredentials(JSON.parse(userTokens));
    
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
      
      oAuth2Client.setCredentials(JSON.parse(userTokens));
      console.log('Credentials set');
      
      const tasksAPI = google.tasks({ version: 'v1', auth: oAuth2Client });
      console.log('Tasks API initialized');
      const createdTasks = [];
    
    for (const task of tasks) {
      console.log('Processing task:', task);
      if (task.trim()) {
        try {
          console.log('Creating task with title:', task.trim());
          console.log('Calling Google Tasks API...');
          const result = await tasksAPI.tasks.insert({
            tasklist: '@default',
            requestBody: { title: task.trim() },
          });
          console.log('Task created successfully:', result.data);
          createdTasks.push(task);
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
    
    // Initialize Gemini model
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    // Create prompt for task extraction
    const prompt = 'You are an expert at identifying action items and tasks from meeting transcripts. ' +
      'Please analyze the following meeting transcript and extract all action items, tasks, and responsibilities that were assigned or mentioned. Focus on: ' +
      '1. Tasks assigned to specific people ' +
      '2. Action items that need to be completed ' +
      '3. Follow-up items ' +
      '4. Deadlines or time-sensitive tasks ' +
      '5. Responsibilities mentioned ' +
      'For each action item, provide a clear, concise description that would work as a task title. ' +
      'Return ONLY a JSON array of strings, where each string is a task description. Do not include any other text, explanations, or formatting. ' +
      'Example output format: ["Review the quarterly budget by Friday", "Schedule follow-up meeting with marketing team", "Update the project timeline"] ' +
      'Meeting transcript: ' + text;

    // Generate response from Gemini
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    console.log('Gemini response:', text);
    
    // Parse the JSON response
    let actionItems = [];
    try {
      // Clean up the response and parse JSON
      const cleanedText = text.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
      actionItems = JSON.parse(cleanedText);
      
      // Ensure it's an array
      if (!Array.isArray(actionItems)) {
        console.error('Gemini response is not an array:', actionItems);
        return [];
      }
      
      // Filter out empty or invalid items
      actionItems = actionItems.filter(item => 
        item && typeof item === 'string' && item.trim().length > 5 && item.trim().length < 300
      );
      
      console.log('Extracted action items:', actionItems);
      return actionItems;
      
    } catch (parseError) {
      console.error('Error parsing Gemini response:', parseError);
      console.error('Raw response:', text);
      return [];
    }
    
  } catch (error) {
    console.error('Error using Gemini AI:', error);
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
          actionItems.push(cleanItem);
        }
      });
    }
  });
  
  return [...new Set(actionItems)];
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
app.get('/account', (req, res) => {
  const userTokens = req.cookies && req.cookies.userTokens;
  
  if (!userTokens) {
    return res.redirect('/');
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Account Management - Google Tasks MVP</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .container { max-width: 900px; margin: 0 auto; }
        button { background: #4285f4; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; margin: 10px 5px; }
        .logout { background: #dc3545; }
        .switch-account { background: #4285f4; }
        .remove-account { background: #4285f4; }
        .back-btn { background: #4285f4; }
        .account-info { background: #f5f5f5; padding: 20px; border-radius: 8px; margin-bottom: 30px; }
        .account-info h2 { margin: 0 0 15px 0; color: #333; }
        .account-actions { display: flex; gap: 10px; flex-wrap: wrap; }
        .section { margin-bottom: 30px; }
        .section h3 { color: #555; margin-bottom: 15px; }
        
        /* Toast notification styles */
        .toast {
          position: fixed;
          top: 20px;
          right: 20px;
          padding: 12px 20px;
          border-radius: 4px;
          color: white;
          font-size: 14px;
          z-index: 1000;
          opacity: 0;
          transform: translateX(100%);
          transition: all 0.3s ease;
        }
        .toast.show {
          opacity: 1;
          transform: translateX(0);
        }
        .toast.success { background-color: #4caf50; }
        .toast.error { background-color: #f44336; }
        .toast.info { background-color: #2196f3; }
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
        <h1>Account Management</h1>
        
        <div class="account-info">
          <h2>Current Account Status</h2>
          <p><strong>Signed in with Google</strong></p>
          <p>You are currently signed in and can create tasks in your Google Tasks.</p>
        </div>
        
        <div class="section">
          <h3>Switch Google Account</h3>
          <p>Switch to a different Google account. This will force Google to show the account selection screen.</p>
          <a href="/switch-account" class="btn switch-account" style="text-decoration: none; display: inline-block;">Switch Account</a>
        </div>
        
        <div class="section">
          <h3>Remove Account</h3>
          <p>Completely remove this account from the app. You will need to sign in again to use the app.</p>
          <button onclick="removeAccount()" class="remove-account">Remove Account</button>
        </div>
        
        <div class="section">
          <h3>Logout</h3>
          <p>Logout from the current session. You can sign back in later.</p>
          <form method="POST" action="/logout" style="display: inline;">
            <button type="submit" class="logout">Logout</button>
          </form>
        </div>
        
        <div class="section">
          <a href="/" class="btn back-btn" style="text-decoration: none; display: inline-block;">Back to Tasks</a>
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
      scope: SCOPES
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
      <title>Upload meeting transcript - Google Tasks MVP</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .container { max-width: 900px; margin: 0 auto; }
        input, textarea { width: 100%; padding: 8px; margin: 10px 0; box-sizing: border-box; }
        textarea { height: 100px; resize: vertical; }
        button { background: #4285f4; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
        .char-count { font-size: 12px; color: #888; text-align: right; margin-top: 2px; margin-bottom: 10px; }
        .char-count.warning { color: #ff9800; }
        .char-count.error { color: #f44336; }
        .limit-info { font-size: 12px; color: #666; margin-bottom: 10px; }
        
        /* Toast notification styles */
        .toast {
          position: fixed;
          top: 20px;
          right: 20px;
          padding: 12px 20px;
          border-radius: 4px;
          color: white;
          font-size: 14px;
          z-index: 1000;
          opacity: 0;
          transform: translateX(100%);
          transition: all 0.3s ease;
        }
        .toast.show {
          opacity: 1;
          transform: translateX(0);
        }
        .toast.success { background-color: #4caf50; }
        .toast.error { background-color: #f44336; }
        .toast.info { background-color: #2196f3; }
        
        .loading { opacity: 0.6; pointer-events: none; }
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
          
          // Create task items in two columns
          const taskGrid = document.createElement('div');
          taskGrid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 20px;';
          
          // Responsive design for smaller screens
          if (window.innerWidth < 768) {
            taskGrid.style.cssText = 'display: grid; grid-template-columns: 1fr; gap: 20px;';
          }
          
          tasks.forEach((task, index) => {
            const taskItem = document.createElement('div');
            taskItem.style.cssText = 'border: 1px solid #ddd; padding: 15px; border-radius: 6px; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1);';
            taskItem.innerHTML = \`
              <div style="display: flex; align-items: flex-start; gap: 12px;">
                <div style="margin-top: 8px;">
                  <input type="checkbox" id="task\${index}" style="width: 18px; height: 18px; cursor: pointer;" onchange="updateConfirmButton()">
                </div>
                <div style="flex: 1;">
                  <textarea 
                    id="taskText\${index}" 
                    style="width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 4px; resize: none; height: 120px; font-size: 14px; line-height: 1.4; font-family: inherit;"
                    oninput="updateTaskText(\${index})"
                    placeholder="Edit task description here..."
                    maxlength="${MAX_TASK_LENGTH}"
                  >\${task}</textarea>
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
          
          // Collect selected tasks
          const selectedTasks = [];
          checkboxes.forEach(checkbox => {
            const index = checkbox.id.replace('task', '');
            const taskText = document.getElementById(\`taskText\${index}\`).value.trim();
            if (taskText) {
              selectedTasks.push(taskText);
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
        
        window.onload = function() { 
          // Focus is not needed for file upload
        };
      </script>
    </head>
    <body>
              <div class="container">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px;">
            <h2>Upload meeting transcript - Google Tasks MVP</h2>
            <a href="/account" style="text-decoration: none; color: #4285f4; font-size: 14px; font-weight: 500;">Account</a>
          </div>
          
                  <div class="limit-info">Upload a PDF meeting transcript (max 10MB). The tool will identify action items and let you review them before creating tasks.</div>
        <form onsubmit="event.preventDefault(); processTranscript();" enctype="multipart/form-data">
          <div style="border: 2px dashed #ccc; padding: 40px; text-align: center; border-radius: 8px; margin: 20px 0; background: #f9f9f9;">
            <input 
              type="file" 
              id="transcriptFile" 
              name="transcript" 
              accept=".pdf"
              style="display: none;"
              onchange="updateFileInfo()"
            />
            <div id="uploadArea" onclick="document.getElementById('transcriptFile').click();" style="cursor: pointer;">
              <div style="font-size: 48px; color: #666; margin-bottom: 10px;">📄</div>
              <div style="font-size: 18px; color: #333; margin-bottom: 10px;">Click to upload PDF transcript</div>
              <div style="font-size: 14px; color: #666;">Maximum file size: 10MB</div>
            </div>
            <div id="fileInfo" style="display: none; margin-top: 20px; padding: 15px; background: white; border-radius: 4px; border: 1px solid #ddd;">
              <div style="font-weight: bold; margin-bottom: 5px;">Selected file:</div>
              <div id="fileName" style="color: #4285f4;"></div>
              <div id="fileSize" style="font-size: 12px; color: #666; margin-top: 5px;"></div>
            </div>
          </div>
          <button type="submit" id="submitBtn" disabled>Process</button>
        </form>
        
        <!-- Task Review Section -->
        <div id="taskReviewSection" style="display: none; margin-top: 30px;">
          <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="margin: 0 0 10px 0; color: #333;">Review Extracted Action Items</h3>
            <p style="color: #666; margin: 0; font-size: 14px;">Select the tasks you want to add to your Google Tasks list. You can also edit the text for better accuracy.</p>
          </div>
          <div id="taskList" style="margin-bottom: 25px;"></div>
          <div style="display: flex; gap: 12px; align-items: center; padding: 15px; background: #f8f9fa; border-radius: 6px;">
            <button type="button" id="selectAllBtn" onclick="toggleSelectAll()" style="background: #666; color: white; padding: 10px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">Select All</button>
            <button type="button" id="confirmBtn" onclick="confirmTasks()" style="background: #4285f4; color: white; padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; display: none; font-size: 14px; font-weight: 500;">Confirm</button>
          </div>
        </div>
        </div>
    </body>
    </html>
  `);
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Google Tasks MVP running on port ${PORT}`);
  console.log('Environment variables:');
  console.log('GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'SET' : 'NOT SET');
  console.log('GOOGLE_CLIENT_SECRET:', process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'NOT SET');
  console.log('REDIRECT_URI:', process.env.REDIRECT_URI || 'NOT SET');
});
