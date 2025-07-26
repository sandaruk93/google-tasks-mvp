const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

const SCOPES = ['https://www.googleapis.com/auth/tasks'];
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
      <title>Google Tasks MVP</title>
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
        function updateCharCount() {
          const textarea = document.getElementById('task');
          const charCount = document.getElementById('charCount');
          const count = textarea.value.length;
          const maxLength = ${MAX_TASK_LENGTH};
          
          charCount.textContent = count + ' / ' + maxLength + ' characters';
          
          if (count > maxLength) {
            charCount.className = 'char-count error';
          } else if (count > maxLength * 0.9) {
            charCount.className = 'char-count warning';
          } else {
            charCount.className = 'char-count';
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
        
        function submitTask() {
          const textarea = document.getElementById('task');
          const submitBtn = document.getElementById('submitBtn');
          const task = textarea.value.trim();
          
          if (!task) {
            showToast('Please enter a task', 'error');
            return;
          }
          
          if (task.length > ${MAX_TASK_LENGTH}) {
            showToast(\`Task is too long (\${task.length} characters). Maximum ${MAX_TASK_LENGTH} characters allowed.\`, 'error');
            return;
          }
          
          // Show loading state
          submitBtn.textContent = 'Adding...';
          submitBtn.disabled = true;
          textarea.disabled = true;
          
          // Submit task via AJAX
          fetch('/add-task', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: \`task=\${encodeURIComponent(task)}\`
          })
          .then(response => response.json())
          .then(data => {
            if (data.success) {
              showToast(data.message, 'success');
              textarea.value = '';
              updateCharCount();
            } else {
              showToast(data.message, 'error');
              // If authentication error, redirect to home page
              if (data.message.includes('Not authenticated')) {
                setTimeout(() => {
                  window.location.href = '/';
                }, 2000);
              }
            }
          })
          .catch(error => {
            showToast('Network error. Please try again.', 'error');
          })
          .finally(() => {
            // Reset loading state
            submitBtn.textContent = 'Add Task';
            submitBtn.disabled = false;
            textarea.disabled = false;
            textarea.focus();
          });
        }
        
        function handleKeyPress(event) {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submitTask();
          }
        }
        
        window.onload = function() { 
          updateCharCount();
          document.getElementById('task').focus();
        };
      </script>
    </head>
    <body>
              <div class="container">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px;">
            <h2>Google Tasks MVP</h2>
            <a href="/account" class="btn" style="text-decoration: none; display: inline-block; background: #4285f4; color: white; padding: 8px 16px; font-size: 14px; border-radius: 4px;">Account</a>
          </div>
          
          <div class="limit-info">Google Tasks has a limit of ${MAX_TASK_LENGTH} characters per task.</div>
          <form onsubmit="event.preventDefault(); submitTask();">
            <textarea 
              id="task" 
              name="task" 
              placeholder="Enter a task (max ${MAX_TASK_LENGTH} characters) - Press Enter to add" 
              required 
              oninput="updateCharCount()"
              onkeypress="handleKeyPress(event)"
              maxlength="${MAX_TASK_LENGTH}"
            ></textarea>
            <div id="charCount" class="char-count">0 / ${MAX_TASK_LENGTH} characters</div>
            <button type="submit" id="submitBtn">Add Task</button>
          </form>
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
