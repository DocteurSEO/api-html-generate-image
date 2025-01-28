const express = require("express");
const puppeteer = require("puppeteer");
const Queue = require("bull");
const cluster = require("cluster");
const os = require("os");
const crypto = require("crypto");
const sharp = require("sharp");
const LRU = require("lru-cache");
const fs = require("fs").promises;
const path = require("path");
const compression = require("compression");

// Configuration avancée
const CONFIG = {
  PORT: process.env.PORT || 3001,
  WORKERS: process.env.WORKERS || os.cpus().length,
  CACHE_DIR: "./cache",
  MAX_MEMORY_CACHE: 200,  // Augmenté pour de meilleures performances
  CLEANUP_INTERVAL: 3600000,
  PAGE_TIMEOUT: 15000,
  REQUEST_TIMEOUT: 30000,  // Add request timeout
  MAX_CONCURRENT_JOBS: 5,
  MEMORY_LIMIT: 512 * 1024 * 1024, // 512MB par worker
  BROWSER_CONFIG: {
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-audio-output',
      '--js-flags=--max-old-space-size=512',
      '--single-process',
      '--disable-web-security',
      '--enable-low-end-device-mode'
    ]
  }
};

// Cache optimisé
const memoryCache = new LRU({
  max: CONFIG.MAX_MEMORY_CACHE,
  ttl: 1000 * 60 * 60,
  updateAgeOnGet: true,
  updateAgeOnHas: true
});

if (cluster.isMaster) {
  console.log(`Master process ${process.pid} starting...`);

  // Création du dossier cache
  fs.mkdir(CONFIG.CACHE_DIR, { recursive: true }).catch(console.error);

  // Lancement des workers
  for (let i = 0; i < CONFIG.WORKERS; i++) {
    cluster.fork();
  }

  // Gestion des workers
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.id} died (${signal || code}). Restarting...`);
    cluster.fork();
  });

  // Nettoyage intelligent du cache
  async function cleanupCache() {
    try {
      const files = await fs.readdir(CONFIG.CACHE_DIR);
      const now = Date.now();
      
      for (const file of files) {
        const filePath = path.join(CONFIG.CACHE_DIR, file);
        const stats = await fs.stat(filePath);
        
        if (now - stats.mtime.getTime() > 24 * 3600000) {
          await fs.unlink(filePath).catch(() => {});
        }
      }
    } catch (err) {
      console.error('Cache cleanup error:', err);
    }
  }

  setInterval(cleanupCache, CONFIG.CLEANUP_INTERVAL);

} else {
  let browser;
  let pagePool;

  // Configuration Express (keep only this one)
  const app = express();
  app.use(compression());
  app.use(express.json({ limit: "2mb" }));

  // Queue configuration and error handling
  const queue = new Queue("image-generation", {
    limiter: {
      max: CONFIG.MAX_CONCURRENT_JOBS,
      duration: 1000
    },
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: true,
      timeout: CONFIG.PAGE_TIMEOUT
    }
  });

  queue.on('error', (error) => {
    console.error('Queue error:', error);
  });

  queue.on('failed', (job, error) => {
    console.error('Job failed:', error);
  });

  // Generate Image function definition
  async function generateImage(html, options = {}) {
    console.log('Starting image generation...');
    try {
      const hash = crypto.createHash("md5")
        .update(html + JSON.stringify(options))
        .digest("hex");
      
      console.log('Generated hash:', hash);
      
      const page = await pagePool.acquire();
      console.log('Acquired page from pool');
  
      try {
        const { width = 1280, height = 720, fullPage = true } = options;
        console.log('Setting viewport:', { width, height });
  
        await page.setViewport({ width, height, deviceScaleFactor: 1 });
        console.log('Viewport set, setting content...');
  
        await page.setContent(html, { waitUntil: "domcontentloaded" });
        console.log('Content set, taking screenshot...');
  
        const screenshot = await page.screenshot({
          fullPage,
          type: 'jpeg',
          quality: 90
        });
        console.log('Screenshot taken');
  
        return screenshot;
      } finally {
        await pagePool.release(page);
        console.log('Page released back to pool');
      }
    } catch (error) {
      console.error('Error in generateImage:', error);
      throw error;
    }
  }

  // Route definitions
  app.get("/image", async (req, res) => {
    console.log('GET request received at:', new Date().toISOString());
    
    if (!req.query.html) {
      console.log('No HTML provided');
      return res.status(400).json({ error: "HTML parameter is required" });
    }
  
    try {
      console.log('Processing request...');
      const result = await generateImage(decodeURIComponent(req.query.html), {});
      console.log('Image generated successfully');
  
      res.set({
        'Content-Type': 'image/jpeg',
        'Content-Length': result.length
      });
      res.end(result);
      console.log('Response sent');
    } catch (err) {
      console.error('Request failed:', err);
      res.status(500).json({ error: err.message || "Internal server error" });
    }
  });

  // Traitement des jobs
  queue.process(async (job) => {
    const { html, options } = job.data;
    const result = await generateImage(html, options);
    return result.image;
  });

  // Remove this duplicate Express configuration
  // const app = express();
  // app.use(compression());
  // app.use(express.json({ limit: "2mb" }));

  // Routes
  app.post("/image", async (req, res) => {
    console.log('Received POST request:', req.body);
    const { html, options } = req.body;

    if (!html) {
      console.log('No HTML content provided');
      return res.status(400).json({ error: "HTML content is required" });
    }

    try {
      console.log('Adding job to queue...');
      const job = await queue.add({ html, options: options || {} });
      
      console.log('Waiting for job to complete...');
      const result = await job.finished();
      console.log('Job completed, sending response...');

      res.set({
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=3600',
        'X-Generated-By': `Worker-${cluster.worker.id}`
      });
      
      res.end(Buffer.from(result));
    } catch (err) {
      console.error("Generation error:", err);
      res.status(500).json({ 
        error: "Image generation failed",
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  // Gestion d'erreurs
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Initialisation
  async function initialize() {
    try {
      browser = await puppeteer.launch(CONFIG.BROWSER_CONFIG);
      pagePool = new PagePool();
      await pagePool.initialize(browser);
      
      app.listen(CONFIG.PORT, () => {
        console.log(`Worker ${cluster.worker.id} running on port ${CONFIG.PORT}`);
      });

      // Nettoyage périodique des pages
      setInterval(() => pagePool.cleanup(), 300000);

      // Monitoring mémoire
      setInterval(() => {
        const used = process.memoryUsage().heapUsed;
        if (used > CONFIG.MEMORY_LIMIT) {
          pagePool.cleanup();
        }
      }, 60000);

    } catch (err) {
      console.error('Initialization failed:', err);
      process.exit(1);
    }
  }

  // Gestion de l'arrêt
  async function shutdown() {
    if (browser) await browser.close();
    await queue.close();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  initialize();
}