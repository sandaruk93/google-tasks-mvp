const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const SCOPES = ['https://www.googleapis.com/auth/tasks'];

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
}

let userTokens = null; // In-memory for MVP

app.get('/', (req, res) => {
  if (!userTokens) {
    const oAuth2Client = getOAuth2Client();
    const url = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });
    return res.send(`<h2>Google Tasks MVP</h2><a href='${url}'>Sign in with Google</a>`);
  }
  res.send(`
    <h2>Google Tasks MVP</h2>
    <form method="POST" action="/add-task">
      <input name="task" placeholder="Enter a task" required style="width:300px;" />
      <button type="submit">Add Task</button>
    </form>
    <form method="POST" action="/logout" style="margin-top:20px;">
      <button type="submit">Logout</button>
    </form>
  `);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  const oAuth2Client = getOAuth2Client();
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    userTokens = tokens;
    res.redirect('/');
  } catch (err) {
    res.status(500).send('OAuth2 error: ' + err.message);
  }
});

app.post('/add-task', async (req, res) => {
  if (!userTokens) return res.redirect('/');
  const oAuth2Client = getOAuth2Client();
  oAuth2Client.setCredentials(userTokens);
  const tasks = google.tasks({ version: 'v1', auth: oAuth2Client });
  const { task } = req.body;
  try {
    await tasks.tasks.insert({
      tasklist: '@default',
      requestBody: { title: task },
    });
    res.send('<p>Task added! <a href="/">Back</a></p>');
  } catch (err) {
    res.send(`<p>Error: ${err.message} <a href="/">Back</a></p>`);
  }
});

app.post('/logout', (req, res) => {
  userTokens = null;
  res.redirect('/');
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Google Tasks MVP running on port ${PORT}`);
  });
}

module.exports = app;
