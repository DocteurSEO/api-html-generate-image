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
      '--single-process',
      '--font-render-hinting=medium',
      '--enable-font-antialiasing',
      '--force-color-profile=srgb'
    ],
    ignoreDefaultArgs: ['--disable-font-subpixel-positioning']
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
app.use(express.json({ limit: "10mb" }));

let browser;
let page;

// Initialisation optimisée de la page
async function initializePage() {
  if (!page) {
    page = await browser.newPage();
    await page.setRequestInterception(true);
    
    page.on('request', request => {
      if (['media', 'image'].includes(request.resourceType()) && !request.url().includes('fonts')) {
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
    const { width = 800, height = 600, quality = 80, format = 'jpeg' } = options;

    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { 
      waitUntil: ["load", "networkidle0"],
      timeout: CONFIG.PAGE_TIMEOUT 
    });

    // Use evaluate to wait for any animations or transitions to complete
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));

    let output;
    if (format.toLowerCase() === 'pdf') {
      output = await page.pdf({
        width: `${width}px`,
        height: `${height}px`,
        printBackground: true
      });
    } else {
      output = await page.screenshot({
        type: format.toLowerCase(),
        quality: format.toLowerCase() === 'jpeg' ? quality : undefined,
        fullPage: false,
        omitBackground: false
      });
    }

    cache.set(hash, output);
    return output;
  } catch (error) {
    console.error('Generation error:', error);
    console.error('HTML content:', html);
    throw error;
  }
}

// Routes simplifiées
// Add a new POST endpoint
app.post("/image", async (req, res) => {
  try {
    if (!req.body.html) {
      return res.status(400).json({ error: "HTML required" });
    }

    const options = {
      width: parseInt(req.body.width) || 800,
      height: parseInt(req.body.height) || 600,
      quality: parseInt(req.body.quality) || 80,
      format: req.body.format || 'jpeg'
    };

    // Validate dimensions
    if (options.width < 1 || options.width > 4000 || options.height < 1 || options.height > 4000) {
      return res.status(400).json({ error: "Invalid dimensions. Width and height must be between 1 and 4000 pixels" });
    }

    // Validate quality
    if (options.quality < 1 || options.quality > 100) {
      return res.status(400).json({ error: "Invalid quality. Must be between 1 and 100" });
    }

    // Validate format
    if (!['jpeg', 'png', 'pdf'].includes(options.format.toLowerCase())) {
      return res.status(400).json({ error: "Invalid format. Must be jpeg, png, or pdf" });
    }

    const result = await generateImage(req.body.html, options);
    
    res.set({
      'Content-Type': options.format.toLowerCase() === 'pdf' ? 'application/pdf' : `image/${options.format}`,
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(result);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: "Generation failed" });
  }
});

// Keep the GET endpoint for backward compatibility
app.get("/image", async (req, res) => {
  try {
    let html;
    
    if (req.query.url) {
      try {
        const page = await initializePage();
        await page.goto(req.query.url, {
          waitUntil: ['load', 'networkidle0'],
          timeout: CONFIG.PAGE_TIMEOUT
        });
        html = await page.content();
      } catch (error) {
        return res.status(400).json({ error: "Failed to load URL" });
      }
    } else if (req.query.html) {
      html = decodeURIComponent(req.query.html);
    } else {
      return res.status(400).json({ error: "URL or HTML required" });
    }

    const options = {
      width: parseInt(req.query.width) || parseInt(req.query.w) || 800,
      height: parseInt(req.query.height) || parseInt(req.query.h) || 600,
      quality: parseInt(req.query.quality) || parseInt(req.query.q) || 80,
      format: req.query.format || 'jpeg'
    };

    // Validate dimensions
    if (options.width < 1 || options.width > 4000 || options.height < 1 || options.height > 4000) {
      return res.status(400).json({ error: "Invalid dimensions. Width and height must be between 1 and 4000 pixels" });
    }

    // Validate quality
    if (options.quality < 1 || options.quality > 100) {
      return res.status(400).json({ error: "Invalid quality. Must be between 1 and 100" });
    }

    // Validate format
    if (!['jpeg', 'png', 'pdf'].includes(options.format.toLowerCase())) {
      return res.status(400).json({ error: "Invalid format. Must be jpeg, png, or pdf" });
    }

    const result = await generateImage(html, options);
    
    res.set({
      'Content-Type': options.format.toLowerCase() === 'pdf' ? 'application/pdf' : `image/${options.format}`,
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(result);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: "Generation failed" });
  }
});

// Gestion des erreurs
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Server error' });
});

// Initialisation et gestion de l'arrêt
// Add these handlers at the top level
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown();
});

// Modify the shutdown function
async function shutdown() {
  console.log('Shutting down gracefully...');
  try {
    if (browser) await browser.close();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
    // add 
    // Force exit if graceful shutdown fails
    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Modify the initialize function to store the server instance
async function initialize() {
  try {
    browser = await puppeteer.launch(CONFIG.BROWSER_CONFIG);
    await initializePage();

    const server = app.listen(CONFIG.PORT, () => {
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

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

initialize();