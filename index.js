const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const SCOPES = ['https://www.googleapis.com/auth/tasks'];

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
    
    res.setHeader('Set-Cookie', `userTokens=${JSON.stringify(tokens)}; Path=/; HttpOnly`);
    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.status(500).send(`OAuth2 error: ${err.message}`);
  }
});

// Handle add task
app.post('/add-task', async (req, res) => {
  const userTokens = req.cookies && req.cookies.userTokens;
  if (!userTokens) {
    return res.redirect('/');
  }

  const { task } = req.body;
  if (!task) {
    return res.status(400).send('Task is required');
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
  res.setHeader('Set-Cookie', 'userTokens=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/');
});

// Main page
app.get('/', (req, res) => {
  const isAuthenticated = req.cookies && req.cookies.userTokens;
  
  if (!isAuthenticated) {
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
  
  // Show task creation form
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Google Tasks MVP</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .container { max-width: 500px; margin: 0 auto; }
        input { width: 100%; padding: 8px; margin: 10px 0; }
        button { background: #4285f4; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
        .logout { background: #dc3545; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>Google Tasks MVP</h2>
        <form method="POST" action="/add-task">
          <input name="task" placeholder="Enter a task" required />
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
