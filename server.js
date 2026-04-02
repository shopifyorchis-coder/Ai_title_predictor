const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(3000, () => {
  console.log('TitleBoost running at http://localhost:3000');
});

// Save with `Ctrl + S`.


// **Step 6 — Run the app**

// node server.js

// You'll see:

// TitleBoost running at http://localhost:3000
