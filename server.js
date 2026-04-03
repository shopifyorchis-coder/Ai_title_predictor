require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const session = require('express-session');

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SHOPIFY_API_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: 'none',
    secure: true,
    httpOnly: true
  }
}));
app.use(express.static(__dirname, { index: false }));

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_APP_URL,
  SHOPIFY_SCOPES,
  OPENAI_API_KEY
} = process.env;

const SHOPIFY_API_VERSION = '2024-01';
const SHOP_DOMAIN_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const TOKENS_PATH = path.join(__dirname, 'shop_tokens.json');

function normalizeShop(shop) {
  if (typeof shop !== 'string') return null;
  const normalized = shop.trim().toLowerCase();
  return SHOP_DOMAIN_REGEX.test(normalized) ? normalized : null;
}

function buildShopifyUrl(shop, pathname) {
  return `https://${shop}${pathname}`;
}

function readTokenStore() {
  try {
    if (!fs.existsSync(TOKENS_PATH)) return {};
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  } catch (error) {
    console.error('Token store read error:', error.message);
    return {};
  }
}

function writeTokenStore(store) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(store, null, 2));
}

function saveShopAuth(shop, accessToken, host) {
  const store = readTokenStore();
  store[shop] = {
    accessToken,
    host: host || '',
    updatedAt: new Date().toISOString()
  };
  writeTokenStore(store);
}

function getStoredShopAuth(shop) {
  const normalizedShop = normalizeShop(shop);
  if (!normalizedShop) return null;

  const record = readTokenStore()[normalizedShop];
  if (!record || !record.accessToken) return null;

  return {
    shop: normalizedShop,
    accessToken: record.accessToken,
    host: normalizeHost(record.host) || null
  };
}

function normalizeHost(host) {
  if (typeof host !== 'string') return null;
  const normalized = host.trim();
  return normalized ? normalized : null;
}

function buildAppRedirectQuery(params) {
  const query = new URLSearchParams();
  if (params.shop) query.set('shop', params.shop);
  if (params.host) query.set('host', params.host);
  if (params.embedded) query.set('embedded', params.embedded);
  return query.toString();
}

function renderEmbeddedHtml(req) {
  const shop = normalizeShop(req.query.shop || req.session.shop);
  const storedAuth = shop ? getStoredShopAuth(shop) : null;
  const host = normalizeHost(req.query.host || req.session.host || storedAuth?.host);
  const embedded = typeof req.query.embedded === 'string'
    ? req.query.embedded
    : (req.session.embedded ? '1' : '');
  const bootstrap = {
    shopifyApiKey: SHOPIFY_API_KEY || '',
    host: host || '',
    shop: shop || '',
    embedded: embedded === '1'
  };
  const appBridgeHead = `
<meta name="shopify-api-key" content="${SHOPIFY_API_KEY || ''}" />
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<script>window.__SHOPIFY_CONFIG__=${JSON.stringify(bootstrap)};</script>
</head>`;
  return INDEX_HTML.replace('</head>', appBridgeHead);
}

app.use((req, res, next) => {
  const shop = normalizeShop(req.query.shop || req.session?.shop);
  const frameAncestors = shop
    ? `frame-ancestors https://${shop} https://admin.shopify.com;`
    : "frame-ancestors https://admin.shopify.com https://*.myshopify.com;";
  res.setHeader('Content-Security-Policy', frameAncestors);
  next();
});

function verifyShopifyHmac(query) {
  const { hmac, signature, ...rest } = query;
  if (!hmac || typeof hmac !== 'string') return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(',') : rest[key]}`)
    .join('&');

  const digest = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(message)
    .digest('hex');

  const provided = Buffer.from(hmac, 'utf8');
  const expected = Buffer.from(digest, 'utf8');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function getSessionAuth(req, res) {
  const shop = normalizeShop(req.query.shop || req.session.shop);
  const accessToken = req.session.accessToken;

  if (!shop) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }

  if (accessToken && shop === req.session.shop) {
    return { shop, accessToken };
  }

  const storedAuth = getStoredShopAuth(shop);
  if (!storedAuth) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }

  req.session.shop = storedAuth.shop;
  req.session.accessToken = storedAuth.accessToken;
  req.session.host = storedAuth.host;

  return { shop: storedAuth.shop, accessToken: storedAuth.accessToken };
}

async function generateJsonCompletion(prompt, maxTokens = 512) {
  if (!OPENAI_API_KEY) {
    const error = new Error('OpenAI API key is not configured on the server');
    error.status = 503;
    throw error;
  }

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return JSON.parse(response.data.choices[0].message.content);
}

app.get('/auth', (req, res) => {
  const shop = normalizeShop(req.query.shop);
  if (!shop) return res.status(400).send('Invalid shop parameter');

  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;
  req.session.shop = shop;
  req.session.host = normalizeHost(req.query.host) || req.session.host || null;
  req.session.embedded = req.query.embedded === '1';

  const redirectUri = `${SHOPIFY_APP_URL}/auth/callback`;
  const installUrl = `${buildShopifyUrl(shop, '/admin/oauth/authorize')}?client_id=${encodeURIComponent(SHOPIFY_API_KEY)}&scope=${encodeURIComponent(SHOPIFY_SCOPES)}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(installUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code, state } = req.query;
  const normalizedShop = normalizeShop(shop);
  const host = normalizeHost(req.query.host) || req.session.host;
  const embedded = req.query.embedded === '1' || req.session.embedded;

  if (!normalizedShop || !code || !verifyShopifyHmac(req.query)) {
    return res.status(403).send('Request origin cannot be verified');
  }

  if (state !== req.session.state) {
    return res.status(403).send('Request origin cannot be verified');
  }

  try {
    const tokenRes = await axios.post(
      buildShopifyUrl(normalizedShop, '/admin/oauth/access_token'),
      {
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code
      }
    );

    req.session.shop = normalizedShop;
    req.session.accessToken = tokenRes.data.access_token;
    req.session.host = host || null;
    req.session.embedded = Boolean(embedded);
    saveShopAuth(normalizedShop, tokenRes.data.access_token, host);
    delete req.session.state;

    console.log(`Shop installed: ${normalizedShop}`);
    res.redirect(`/?${buildAppRedirectQuery({ shop: normalizedShop, host, embedded: embedded ? '1' : '' })}`);
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.status(500).send('OAuth failed: ' + err.message);
  }
});

app.get('/api/products', async (req, res) => {
  const auth = getSessionAuth(req, res);
  if (!auth) return;
  const { shop, accessToken } = auth;

  try {
    const response = await axios.get(
      buildShopifyUrl(shop, `/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=50&fields=id,title,handle,status,variants,images`),
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        }
      }
    );

    const products = response.data.products.map((product) => ({
      id: product.id,
      name: product.title.split(' ').slice(0, 2).join(' '),
      title: product.title,
      sku: product.variants?.[0]?.sku || 'N/A',
      status: product.status,
      image: product.images?.[0]?.src || null,
      handle: product.handle
    }));

    res.json({ products, shop });
  } catch (err) {
    console.error('Products fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  const auth = getSessionAuth(req, res);
  if (!auth) return;
  const { shop, accessToken } = auth;
  const { title } = req.body || {};

  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }

  try {
    const response = await axios.put(
      buildShopifyUrl(shop, `/admin/api/${SHOPIFY_API_VERSION}/products/${req.params.id}.json`),
      { product: { id: req.params.id, title: title.trim() } },
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

app.get('/api/config', (req, res) => {
  const shop = normalizeShop(req.query.shop || req.session.shop);
  const storedAuth = shop ? getStoredShopAuth(shop) : null;
  res.json({
    openaiConfigured: Boolean(OPENAI_API_KEY),
    shopifyApiKey: SHOPIFY_API_KEY || '',
    host: normalizeHost(req.query.host || req.session.host || storedAuth?.host) || '',
    shop: shop || ''
  });
});

app.post('/api/optimize-title', async (req, res) => {
  const { title, sku } = req.body || {};

  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Product title is required' });
  }

  const prompt = `You are a Shopify SEO expert. Rewrite this product title: compelling, SEO-optimized, under 70 chars. Also suggest meta title (under 60 chars) and meta description (under 160 chars).
Original: "${title.trim()}" SKU: "${typeof sku === 'string' ? sku.trim() : ''}"
Respond ONLY in JSON: {"optimized_title":"...","meta_title":"...","meta_description":"...","keywords":["k1","k2","k3"]}`;

  try {
    const data = await generateJsonCompletion(prompt, 512);
    res.json(data);
  } catch (err) {
    console.error('Optimize title error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/suggest-tags', async (req, res) => {
  const { title, count = 10 } = req.body || {};

  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Product title is required' });
  }

  const safeCount = Math.min(Math.max(Number(count) || 10, 1), 20);
  const prompt = `Generate ${safeCount} highly relevant Shopify product tags for: "${title.trim()}". Tags should be specific searchable keywords.
Respond ONLY in JSON: {"tags":["tag1","tag2",...]}`;

  try {
    const data = await generateJsonCompletion(prompt, 256);
    res.json({ tags: Array.isArray(data.tags) ? data.tags : [] });
  } catch (err) {
    console.error('Suggest tags error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.type('html').send(renderEmbeddedHtml(req));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TitleBoost running at http://localhost:${PORT}`);
  console.log(`Shopify API Key: ${SHOPIFY_API_KEY ? 'yes' : 'missing'}`);
  console.log(`OpenAI API Key: ${OPENAI_API_KEY ? 'yes' : 'missing'}`);
  console.log(`App URL: ${SHOPIFY_APP_URL}`);
});
