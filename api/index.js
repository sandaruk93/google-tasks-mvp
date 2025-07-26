const { google } = require('googleapis');

module.exports = (req, res) => {
  const SCOPES = ['https://www.googleapis.com/auth/tasks'];
  
  function getOAuth2Client() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.REDIRECT_URI
    );
  }

  // Check if user is authenticated (simple session check)
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
        <form method="POST" action="/api/add-task">
          <input name="task" placeholder="Enter a task" required />
          <button type="submit">Add Task</button>
        </form>
        <form method="POST" action="/api/logout" style="margin-top: 20px;">
          <button type="submit" class="logout">Logout</button>
        </form>
      </div>
    </body>
    </html>
  `);
}; 