const express = require("express");
const puppeteer = require("puppeteer");
const Queue = require("bull");
const crypto = require("crypto");
const LRU = require("lru-cache");
const compression = require("compression");
const cors = require("cors");
const cluster = require("cluster");
const numCPUs = require("os").cpus().length;

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 3001,
  CACHE_MAX_ITEMS: 100,
  CACHE_TTL: 1800000,
  PAGE_TIMEOUT: 5000,
  BROWSER_POOL_SIZE: 3,
  REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
  BROWSER_CONFIG: {
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--js-flags=--max-old-space-size=512'
    ]
  }
};

// File d'attente Bull
const imageQueue = new Queue('image-generation', CONFIG.REDIS_URL);

// Cache optimisé
const cache = new LRU({
  max: CONFIG.CACHE_MAX_ITEMS,
  ttl: CONFIG.CACHE_TTL,
  updateAgeOnGet: true
});

// Pool de navigateurs
class BrowserPool {
  constructor() {
    this.browsers = [];
    this.pages = [];
    this.currentIndex = 0;
  }

  async initialize() {
    for (let i = 0; i < CONFIG.BROWSER_POOL_SIZE; i++) {
      const browser = await puppeteer.launch(CONFIG.BROWSER_CONFIG);
      const page = await browser.newPage();
      await this.setupPage(page);
      
      this.browsers.push(browser);
      this.pages.push(page);
    }
  }

  async setupPage(page) {
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (['media', 'font', 'image'].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });
  }

  getNextPage() {
    const page = this.pages[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.pages.length;
    return page;
  }

  async cleanup() {
    await Promise.all(this.browsers.map(browser => browser.close()));
  }
}

const browserPool = new BrowserPool();

// Fonction de génération d'image optimisée
async function generateImage(html, options = {}) {
  const hash = crypto.createHash("md5").update(html + JSON.stringify(options)).digest("hex");
  
  const cached = cache.get(hash);
  if (cached) return cached;

  const page = browserPool.getNextPage();
  
  try {
    const { width = 800, height = 600, quality = 80, format = 'jpeg' } = options;

    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { 
      waitUntil: ["load", "networkidle0"],
      timeout: CONFIG.PAGE_TIMEOUT 
    });

    // Attente optimisée basée sur le contenu
    await page.evaluate(() => {
      return new Promise(resolve => {
        if (document.readyState === 'complete') {
          resolve();
        } else {
          window.addEventListener('load', resolve);
        }
      });
    });

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
        fullPage: false
      });
    }

    cache.set(hash, output);
    return output;
  } catch (error) {
    console.error('Generation error:', error);
    throw error;
  }
}

// Configuration du processeur de file d'attente
imageQueue.process(async (job) => {
  const { html, options } = job.data;
  return await generateImage(html, options);
});

// Application Express
const app = express();
app.use(cors());
app.use(compression());
app.use(express.json({ limit: "50mb" }));

// Routes optimisées
app.post("/image", async (req, res) => {
  try {
    const { html, ...options } = req.body;
    
    if (!html) {
      return res.status(400).json({ error: "HTML required" });
    }

    // Validation des options
    const validatedOptions = validateOptions(options);
    if (validatedOptions.error) {
      return res.status(400).json({ error: validatedOptions.error });
    }

    // Ajout du job à la file d'attente
    const job = await imageQueue.add({ html, options: validatedOptions });
    
    // Mode synchrone ou asynchrone selon le paramètre
    if (req.query.async === 'true') {
      return res.json({ jobId: job.id });
    }

    const result = await job.finished();
    
    res.set({
      'Content-Type': options.format === 'pdf' ? 'application/pdf' : `image/${options.format}`,
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(result);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: "Generation failed" });
  }
});

// Route pour vérifier le statut d'un job
app.get("/status/:jobId", async (req, res) => {
  try {
    const job = await imageQueue.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const state = await job.getState();
    const result = job.returnvalue;
    
    if (state === 'completed' && result) {
      res.set({
        'Content-Type': job.data.options.format === 'pdf' ? 'application/pdf' : `image/${job.data.options.format}`,
        'Cache-Control': 'public, max-age=3600'
      });
      return res.end(result);
    }

    res.json({ state });
  } catch (error) {
    res.status(500).json({ error: "Status check failed" });
  }
});

// Fonction de validation des options
function validateOptions(options) {
  const validated = {
    width: parseInt(options.width) || 800,
    height: parseInt(options.height) || 600,
    quality: parseInt(options.quality) || 80,
    format: (options.format || 'jpeg').toLowerCase()
  };

  if (validated.width < 1 || validated.width > 4000 || 
      validated.height < 1 || validated.height > 4000) {
    return { error: "Invalid dimensions" };
  }

  if (validated.quality < 1 || validated.quality > 100) {
    return { error: "Invalid quality" };
  }

  if (!['jpeg', 'png', 'pdf'].includes(validated.format)) {
    return { error: "Invalid format" };
  }

  return validated;
}

// Gestion du clustering
if (cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);

  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
    // Replace the dead worker
    cluster.fork();
  });
} else {
  // Workers can share any TCP connection
  initialize();
}

// Initialisation
async function initialize() {
  try {
    await browserPool.initialize();
    
    app.listen(CONFIG.PORT, () => {
      console.log(`Worker ${process.pid} started on port ${CONFIG.PORT}`);
    });

    // Surveillance mémoire
    setInterval(() => {
      const used = process.memoryUsage().heapUsed / 1024 / 1024;
      if (used > 800) {
        cache.clear();
        console.log('Memory limit reached, cache cleared');
      }
    }, 30000);

  } catch (error) {
    console.error('Initialization failed:', error);
    process.exit(1);
  }
}

// Gestion de l'arrêt gracieux
async function shutdown() {
  console.log('Shutting down gracefully...');
  try {
    await browserPool.cleanup();
    await imageQueue.close();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', shutdown);
process.on('unhandledRejection', shutdown);