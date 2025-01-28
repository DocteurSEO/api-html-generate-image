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

  // Gestionnaire de pages optimisé
  class PagePool {
    constructor() {
      this.pages = [];
      this.maxSize = 5;
    }

    async initialize(browser) {
      for (let i = 0; i < this.maxSize; i++) {
        const page = await this.createOptimizedPage(browser);
        this.pages.push({ page, inUse: false, lastUsed: Date.now() });
      }
    }

    async createOptimizedPage(browser) {
      const page = await browser.newPage();
      
      // Optimisations agressives
      await page.setJavaScriptEnabled(false);
      await page.setCacheEnabled(true);
      await page.setRequestInterception(true);
      
      page.on('request', request => {
        const type = request.resourceType();
        if (['image', 'stylesheet', 'font', 'script', 'media'].includes(type)) {
          request.abort();
        } else {
          request.continue();
        }
      });

      return page;
    }

    async acquire() {
      const availablePage = this.pages.find(p => !p.inUse);
      if (availablePage) {
        availablePage.inUse = true;
        availablePage.lastUsed = Date.now();
        return availablePage.page;
      }

      // Créer une nouvelle page si nécessaire
      const page = await this.createOptimizedPage(browser);
      this.pages.push({ page, inUse: true, lastUsed: Date.now() });
      return page;
    }

    async release(page) {
      const pageInfo = this.pages.find(p => p.page === page);
      if (pageInfo) {
        await page.goto('about:blank');
        await page.setJavaScriptEnabled(false);
        pageInfo.inUse = false;
      }
    }

    async cleanup() {
      const now = Date.now();
      for (const pageInfo of this.pages) {
        if (!pageInfo.inUse && (now - pageInfo.lastUsed > 300000)) {
          await pageInfo.page.close();
          this.pages = this.pages.filter(p => p !== pageInfo);
        }
      }
    }
  }

  // File d'attente optimisée
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

  // Fonction de génération d'image optimisée
  async function generateImage(html, options = {}) {
    const hash = crypto.createHash("md5")
      .update(html + JSON.stringify(options))
      .digest("hex");
    
    const cachedFile = path.join(CONFIG.CACHE_DIR, `${hash}.webp`);

    // Vérifier le cache mémoire
    const cachedImage = memoryCache.get(hash);
    if (cachedImage) {
      return { image: cachedImage, cached: true };
    }

    // Vérifier le cache fichier
    try {
      const fileExists = await fs.access(cachedFile)
        .then(() => true)
        .catch(() => false);
      
      if (fileExists) {
        const image = await fs.readFile(cachedFile);
        memoryCache.set(hash, image);
        return { image, cached: true };
      }
    } catch (err) {
      console.error('Cache access error:', err);
    }

    // Générer nouvelle image
    const page = await pagePool.acquire();
    try {
      const { width = 1280, height = 720, fullPage = true } = options;

      await page.setViewport({ 
        width, 
        height, 
        deviceScaleFactor: 1 
      });

      await Promise.race([
        page.setContent(html, { 
          waitUntil: "domcontentloaded",
          timeout: CONFIG.PAGE_TIMEOUT
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Rendering timeout')), CONFIG.PAGE_TIMEOUT)
        )
      ]);

      const screenshot = await page.screenshot({
        fullPage,
        type: 'jpeg',
        quality: 90
      });

      // Optimiser l'image avec Sharp
      const optimizedImage = await sharp(screenshot)
        .webp({
          quality: 80,
          effort: 4,
          lossless: false
        })
        .toBuffer();

      // Sauvegarder dans les caches
      await fs.writeFile(cachedFile, optimizedImage);
      memoryCache.set(hash, optimizedImage);

      return { image: optimizedImage, cached: false };
    } finally {
      await pagePool.release(page);
    }
  }

  // Traitement des jobs
  queue.process(async (job) => {
    const { html, options } = job.data;
    const result = await generateImage(html, options);
    return result.image;
  });

  // Configuration Express
  const app = express();
  app.use(compression());
  app.use(express.json({ limit: "2mb" }));

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
        const job = await queue.add({ html, options: options || {} }, {
            removeOnComplete: true,
            removeOnFail: true
        });

        console.log('Waiting for job to complete...');
        const result = await job.finished();
        console.log('Job completed, sending response...');

        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Disposition': 'inline; filename=screenshot.png'
        });
        res.end(Buffer.from(result));
    } catch (err) {
        console.error("Error generating image:", err);
        res.status(500).json({ error: err.message || "Internal Server Error" });
    }
});

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