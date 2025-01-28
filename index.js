const express = require("express");
const puppeteer = require("puppeteer");
const Queue = require("bull");
const crypto = require("crypto");
const LRU = require("lru-cache");
const compression = require("compression");
const cors = require("cors");

// Configuration optimisée
const CONFIG = {
  PORT: process.env.PORT || 3001,
  CACHE_MAX_ITEMS: 20,
  CACHE_TTL: 1800000, // 30 minutes
  PAGE_TIMEOUT: 5000,
  BROWSER_CONFIG: {
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--js-flags=--max-old-space-size=512',
      '--single-process'
    ]
  }
};

// Cache simple et léger
const cache = new LRU({
  max: CONFIG.CACHE_MAX_ITEMS,
  ttl: CONFIG.CACHE_TTL
});

// Application Express
const app = express();
app.use(cors());
app.use(compression());
app.use(express.json({ limit: "1mb" }));

let browser;
let page;

// Initialisation optimisée de la page
async function initializePage() {
  if (!page) {
    page = await browser.newPage();
    await page.setRequestInterception(true);
    
    page.on('request', request => {
      if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });
  }
  return page;
}

// Fonction de génération d'image optimisée
async function generateImage(html, options = {}) {
  const hash = crypto.createHash("md5").update(html + JSON.stringify(options)).digest("hex");
  
  const cached = cache.get(hash);
  if (cached) return cached;

  try {
    const page = await initializePage();
    const { width = 800, height = 600 } = options;

    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: CONFIG.PAGE_TIMEOUT });

    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 80,
      fullPage: false
    });

    cache.set(hash, screenshot);
    return screenshot;
  } catch (error) {
    console.error('Generation error:', error);
    throw error;
  }
}

// Routes simplifiées
app.get("/image", async (req, res) => {
  try {
    if (!req.query.html) {
      return res.status(400).json({ error: "HTML required" });
    }

    // Extract and validate image options from query parameters
    const options = {
      width: parseInt(req.query.width) || 800,
      height: parseInt(req.query.height) || 600,
      quality: parseInt(req.query.quality) || 80
    };

    // Validate dimensions
    if (options.width < 1 || options.width > 4000 || options.height < 1 || options.height > 4000) {
      return res.status(400).json({ error: "Invalid dimensions. Width and height must be between 1 and 4000 pixels" });
    }

    // Validate quality
    if (options.quality < 1 || options.quality > 100) {
      return res.status(400).json({ error: "Invalid quality. Must be between 1 and 100" });
    }

    const result = await generateImage(decodeURIComponent(req.query.html), options);
    
    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(result);
  } catch (error) {
    res.status(500).json({ error: "Generation failed" });
  }
});

// Gestion des erreurs
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Server error' });
});

// Initialisation et gestion de l'arrêt
async function initialize() {
  try {
    browser = await puppeteer.launch(CONFIG.BROWSER_CONFIG);
    await initializePage();

    app.listen(CONFIG.PORT, () => {
      console.log(`Server running on port ${CONFIG.PORT}`);
    });

    // Surveillance mémoire
    setInterval(() => {
      const used = process.memoryUsage().heapUsed / 1024 / 1024;
      if (used > 800) { // 800MB threshold
        cache.clear();
        console.log('Memory limit reached, cache cleared');
      }
    }, 30000);

  } catch (error) {
    console.error('Initialization failed:', error);
    process.exit(1);
  }
}

async function shutdown() {
  if (browser) await browser.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

initialize();