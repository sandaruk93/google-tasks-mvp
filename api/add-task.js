const { google } = require('googleapis');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const userTokens = req.cookies && req.cookies.userTokens;
  if (!userTokens) {
    return res.redirect('/');
  }

  const { task } = req.body;
  if (!task) {
    return res.status(400).send('Task is required');
  }

  function getOAuth2Client() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.REDIRECT_URI
    );
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
}; 