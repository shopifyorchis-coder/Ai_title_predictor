const express = require('express');
const path = require('path');
const app = express();
require('dotenv').config();

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TitleBoost running at http://localhost:${PORT}`);
  console.log(`Shopify API Key loaded: ${process.env.SHOPIFY_API_KEY ? '✅ Yes' : '❌ Missing'}`);
  console.log(`OpenAI Key loaded: ${process.env.OPENAI_API_KEY ? '✅ Yes' : '❌ Missing'}`);
});

// Save with `Ctrl + S`.


// **Step 6 — Run the app**

// node server.js

// You'll see:

// TitleBoost running at http://localhost:3000
