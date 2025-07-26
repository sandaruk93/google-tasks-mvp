const { google } = require('googleapis');

module.exports = async (req, res) => {
  const SCOPES = ['https://www.googleapis.com/auth/tasks'];
  
  function getOAuth2Client() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.REDIRECT_URI
    );
  }

  // Handle OAuth callback
  if (req.url === '/oauth2callback' && req.method === 'GET') {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }

    try {
      const oAuth2Client = getOAuth2Client();
      const { tokens } = await oAuth2Client.getToken(code);
      
      res.setHeader('Set-Cookie', `userTokens=${JSON.stringify(tokens)}; Path=/; HttpOnly`);
      res.redirect('/');
      return;
    } catch (err) {
      return res.status(500).send(`OAuth2 error: ${err.message}`);
    }
  }

  // Handle add task
  if (req.url === '/add-task' && req.method === 'POST') {
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

      return res.send(`
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
      return res.send(`
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
  }

  // Handle logout
  if (req.url === '/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', 'userTokens=; Path=/; HttpOnly; Max-Age=0');
    return res.redirect('/');
  }

  // Main page (GET /)
  const isAuthenticated = req.cookies && req.cookies.userTokens;
  
  if (!isAuthenticated) {
    const oAuth2Client = getOAuth2Client();
    const url = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });
    
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
  return res.send(`
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
}; 