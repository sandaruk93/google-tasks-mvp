const { google } = require('googleapis');

module.exports = async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing authorization code');
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
    const { tokens } = await oAuth2Client.getToken(code);
    
    // Set cookie with tokens (in production, use secure session management)
    res.setHeader('Set-Cookie', `userTokens=${JSON.stringify(tokens)}; Path=/; HttpOnly`);
    
    res.redirect('/');
  } catch (err) {
    res.status(500).send(`OAuth2 error: ${err.message}`);
  }
}; 