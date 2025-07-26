module.exports = (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // Clear the user tokens cookie
  res.setHeader('Set-Cookie', 'userTokens=; Path=/; HttpOnly; Max-Age=0');
  
  res.redirect('/api');
}; 