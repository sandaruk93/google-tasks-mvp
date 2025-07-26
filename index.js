const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

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
    
    // Extract action items (simple regex-based approach for MVP)
    const actionItems = extractActionItems(transcriptText);
    
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
  const userTokens = req.cookies && req.cookies.userTokens;
  
  if (!userTokens) {
    return res.json({ success: false, message: 'Not authenticated. Please sign in again.' });
  }

  const { tasks } = req.body;
  
  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
    return res.json({ success: false, message: 'No tasks provided for creation.' });
  }

  try {
    // Create tasks for each selected item
    const oAuth2Client = getOAuth2Client();
    oAuth2Client.setCredentials(JSON.parse(userTokens));
    
    const tasksAPI = google.tasks({ version: 'v1', auth: oAuth2Client });
    const createdTasks = [];
    
    for (const task of tasks) {
      if (task.trim()) {
        try {
          await tasksAPI.tasks.insert({
            tasklist: '@default',
            requestBody: { title: task.trim() },
          });
          createdTasks.push(task);
        } catch (err) {
          console.error('Error creating task:', err.message);
        }
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

// Function to extract action items from transcript text
function extractActionItems(text) {
  const actionItems = [];
  
  // Common action item patterns
  const patterns = [
    // "I will..." or "I'll..."
    /\bI\s+(?:will|'ll)\s+([^.!?]+[.!?])/gi,
    // "I need to..." or "I have to..."
    /\bI\s+(?:need\s+to|have\s+to)\s+([^.!?]+[.!?])/gi,
    // "I should..." or "I must..."
    /\bI\s+(?:should|must)\s+([^.!?]+[.!?])/gi,
    // "Action item: ..." or "TODO: ..."
    /(?:action\s+item|todo):\s*([^.!?]+[.!?])/gi,
    // "Next steps: ..."
    /next\s+steps?:\s*([^.!?]+[.!?])/gi,
    // "Follow up: ..."
    /follow\s+up:\s*([^.!?]+[.!?])/gi
  ];
  
  patterns.forEach(pattern => {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(match => {
        // Clean up the extracted text
        let cleanItem = match.replace(/^(?:I\s+(?:will|'ll|need\s+to|have\s+to|should|must)\s+|(?:action\s+item|todo):\s*|next\s+steps?:\s*|follow\s+up:\s*)/i, '');
        cleanItem = cleanItem.trim();
        
        if (cleanItem.length > 10 && cleanItem.length < 200) {
          actionItems.push(cleanItem);
        }
      });
    }
  });
  
  // Remove duplicates
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
        .container { max-width: 600px; margin: 0 auto; }
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
        .container { max-width: 500px; margin: 0 auto; }
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
            console.log('Response data:', data);
            if (data.success) {
              showToast(data.message, 'success');
              // Show task review section
              console.log('Tasks to display:', data.tasks);
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
          console.log('displayTaskReview called with tasks:', tasks);
          const taskReviewSection = document.getElementById('taskReviewSection');
          const taskList = document.getElementById('taskList');
          const confirmBtn = document.getElementById('confirmBtn');
          
          console.log('taskReviewSection element:', taskReviewSection);
          console.log('taskList element:', taskList);
          console.log('confirmBtn element:', confirmBtn);
          
          if (tasks.length === 0) {
            console.log('No tasks to display');
            taskReviewSection.style.display = 'none';
            return;
          }
          
          // Clear previous tasks
          taskList.innerHTML = '';
          
          // Create task items
          tasks.forEach((task, index) => {
            const taskItem = document.createElement('div');
            taskItem.style.cssText = 'border: 1px solid #ddd; padding: 15px; margin-bottom: 10px; border-radius: 4px; background: white;';
            taskItem.innerHTML = \`
              <div style="display: flex; align-items: flex-start; gap: 10px;">
                <input type="checkbox" id="task\${index}" checked style="margin-top: 3px;" onchange="updateConfirmButton()">
                <div style="flex: 1;">
                  <textarea 
                    id="taskText\${index}" 
                    style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; resize: vertical; min-height: 60px;"
                    oninput="updateTaskText(\${index})"
                  >\${task}</textarea>
                </div>
              </div>
            \`;
            taskList.appendChild(taskItem);
          });
          
          // Show review section
          console.log('Setting taskReviewSection display to block');
          taskReviewSection.style.display = 'block';
          console.log('Setting confirmBtn display to inline-block');
          confirmBtn.style.display = 'inline-block';
          
          // Scroll to review section
          console.log('Scrolling to review section');
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
          
          if (selectedTasks.length === 0) {
            showToast('Please enter text for at least one task', 'error');
            return;
          }
          
          // Show loading state
          confirmBtn.textContent = 'Creating Tasks...';
          confirmBtn.disabled = true;
          
          // Submit selected tasks
          fetch('/confirm-tasks', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ tasks: selectedTasks })
          })
          .then(response => response.json())
          .then(data => {
            if (data.success) {
              showToast(data.message, 'success');
              // Hide review section
              document.getElementById('taskReviewSection').style.display = 'none';
            } else {
              showToast(data.message, 'error');
            }
          })
          .catch(error => {
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
          <h3>Review Extracted Action Items</h3>
          <p style="color: #666; margin-bottom: 20px;">Select the tasks you want to add to your Google Tasks list. You can also edit the text for better accuracy.</p>
          <div id="taskList" style="margin-bottom: 20px;"></div>
          <div style="display: flex; gap: 10px; align-items: center;">
            <button type="button" id="selectAllBtn" onclick="toggleSelectAll()" style="background: #666; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Select All</button>
            <button type="button" id="confirmBtn" onclick="confirmTasks()" style="background: #4285f4; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; display: none;">Confirm</button>
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
