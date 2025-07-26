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
    console.log('No user tokens, redirecting to /');
    return res.redirect('/');
  }

  const { task } = req.body;
  if (!task) {
    return res.status(400).send('Task is required');
  }

  // Check character limit
  if (task.length > MAX_TASK_LENGTH) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error - Task Too Long</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .container { max-width: 500px; margin: 0 auto; }
          .error { color: red; }
          a { color: #4285f4; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2 class="error">Task Too Long</h2>
          <p>Your task is ${task.length} characters long, but Google Tasks has a limit of ${MAX_TASK_LENGTH} characters.</p>
          <p>Please shorten your task and try again.</p>
          <a href="/">← Back to Try Again</a>
        </div>
      </body>
      </html>
    `);
  }

  try {
    const oAuth2Client = getOAuth2Client();
    oAuth2Client.setCredentials(JSON.parse(userTokens));
    
    const tasks = google.tasks({ version: 'v1', auth: oAuth2Client });
    await tasks.tasks.insert({
      tasklist: '@default',
      requestBody: { title: task },
    });

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Task Added</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .container { max-width: 500px; margin: 0 auto; }
          .success { color: green; }
          a { color: #4285f4; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2 class="success">Task Added Successfully!</h2>
          <p>Your task "${task}" has been added to your Google Tasks.</p>
          <a href="/">← Back to Add More Tasks</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .container { max-width: 500px; margin: 0 auto; }
          .error { color: red; }
          a { color: #4285f4; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2 class="error">Error Adding Task</h2>
          <p>Error: ${err.message}</p>
          <a href="/">← Back to Try Again</a>
        </div>
      </body>
      </html>
    `);
  }
});

// Handle logout
app.post('/logout', (req, res) => {
  res.clearCookie('userTokens');
  res.redirect('/');
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
      prompt: 'consent',
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
        .logout { background: #dc3545; }
        .char-count { font-size: 12px; color: #666; text-align: right; margin-top: 5px; }
        .char-count.warning { color: #ff9800; }
        .char-count.error { color: #f44336; }
        .limit-info { font-size: 12px; color: #666; margin-bottom: 10px; }
      </style>
      <script>
        function updateCharCount() {
          const textarea = document.getElementById('task');
          const charCount = document.getElementById('charCount');
          const count = textarea.value.length;
          const maxLength = ${MAX_TASK_LENGTH};
          
          charCount.textContent = count + '/' + maxLength + ' characters';
          
          if (count > maxLength) {
            charCount.className = 'char-count error';
          } else if (count > maxLength * 0.9) {
            charCount.className = 'char-count warning';
          } else {
            charCount.className = 'char-count';
          }
        }
        
        function validateForm() {
          const textarea = document.getElementById('task');
          const count = textarea.value.length;
          const maxLength = ${MAX_TASK_LENGTH};
          
          if (count > maxLength) {
            alert('Task is too long! Maximum ${MAX_TASK_LENGTH} characters allowed.');
            return false;
          }
          return true;
        }
      </script>
    </head>
    <body>
      <div class="container">
        <h2>Google Tasks MVP</h2>
        <div class="limit-info">Google Tasks has a limit of ${MAX_TASK_LENGTH} characters per task.</div>
        <form method="POST" action="/add-task" onsubmit="return validateForm()">
          <textarea 
            id="task" 
            name="task" 
            placeholder="Enter a task (max ${MAX_TASK_LENGTH} characters)" 
            required 
            oninput="updateCharCount()"
            maxlength="${MAX_TASK_LENGTH}"
          ></textarea>
          <div id="charCount" class="char-count">0/${MAX_TASK_LENGTH} characters</div>
          <button type="submit">Add Task</button>
        </form>
        <form method="POST" action="/logout" style="margin-top: 20px;">
          <button type="submit" class="logout">Logout</button>
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
