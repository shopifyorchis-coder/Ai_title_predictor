// const express = require('express');
// const path = require('path');
// const app = express();
// require('dotenv').config();

// app.use(express.static(__dirname));

// app.get('/', (req, res) => {
//   res.sendFile(path.join(__dirname, 'index.html'));
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`TitleBoost running at http://localhost:${PORT}`);
//   console.log(`Shopify API Key loaded: ${process.env.SHOPIFY_API_KEY ? '✅ Yes' : '❌ Missing'}`);
//   console.log(`OpenAI Key loaded: ${process.env.OPENAI_API_KEY ? '✅ Yes' : '❌ Missing'}`);
// });



require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const session = require('express-session');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SHOPIFY_API_SECRET,
  resave: false,
  saveUninitialized: true
}));
app.use(express.static(__dirname));

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_APP_URL,
  SHOPIFY_SCOPES
} = process.env;

// ─── STEP 1: Merchant clicks install ───
app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.send('Missing shop parameter');

  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;

  const redirectUri = `${SHOPIFY_APP_URL}/auth/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES}&state=${state}&redirect_uri=${redirectUri}`;

  res.redirect(installUrl);
});

// ─── STEP 2: Shopify redirects back with code ───
app.get('/auth/callback', async (req, res) => {
  const { shop, code, state } = req.query;

  if (state !== req.session.state) {
    return res.status(403).send('Request origin cannot be verified');
  }

  try {
    // Exchange code for access token
    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code
      }
    );

    const accessToken = tokenRes.data.access_token;

    // Save token in session
    req.session.shop = shop;
    req.session.accessToken = accessToken;

    console.log(`✅ Shop installed: ${shop}`);
    res.redirect(`/?shop=${shop}`);

  } catch (err) {
    console.error('OAuth error:', err.message);
    res.status(500).send('OAuth failed: ' + err.message);
  }
});

// ─── STEP 3: API to fetch real products ───
app.get('/api/products', async (req, res) => {
  const shop = req.query.shop || req.session.shop;
  const accessToken = req.query.token || req.session.accessToken;

  if (!shop || !accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const response = await axios.get(
      `https://${shop}/admin/api/2024-01/products.json?limit=50&fields=id,title,handle,status,variants,images`,
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        }
      }
    );

    const products = response.data.products.map(p => ({
      id: p.id,
      name: p.title.split(' ').slice(0, 2).join(' '),
      title: p.title,
      sku: p.variants?.[0]?.sku || 'N/A',
      status: p.status,
      image: p.images?.[0]?.src || null,
      handle: p.handle
    }));

    res.json({ products, shop });

  } catch (err) {
    console.error('Products fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STEP 4: API to update a product title ───
app.put('/api/products/:id', async (req, res) => {
  const shop = req.query.shop || req.session.shop;
  const accessToken = req.query.token || req.session.accessToken;
  const { title } = req.body;

  if (!shop || !accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const response = await axios.put(
      `https://${shop}/admin/api/2024-01/products/${req.params.id}.json`,
      { product: { id: req.params.id, title } },
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ success: true, product: response.data.product });

  } catch (err) {
    console.error('Update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve main app ───
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TitleBoost running at http://localhost:${PORT}`);
  console.log(`Shopify API Key: ${SHOPIFY_API_KEY ? '✅' : '❌'}`);
  console.log(`App URL: ${SHOPIFY_APP_URL}`);
});