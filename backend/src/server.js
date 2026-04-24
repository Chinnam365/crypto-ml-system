const express = require('express');

const app = express();

app.get('/', (req, res) => {
  res.send('Crypto ML App Running 🚀');
});

app.listen(3000, () => {
  console.log('Server running');
});
