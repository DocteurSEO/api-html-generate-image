const express = require("express");
const puppeteer = require("puppeteer");
const Queue = require("bull");
const crypto = require("crypto");
const fs = require("fs");
const cluster = require("cluster");
const os = require("os");
const LRU = require('lru-cache');

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 3001,
  WORKERS: process.env.WORKERS || os.cpus().length,
  CACHE_DIR: "./cache",
  MAX_MEMORY_CACHE: 100, // Nombre maximum d'images en mémoire
  CLEANUP_INTERVAL: 3600000, // Nettoyage du cache toutes les heures
  PAGE_TIMEOUT: 30000, // Timeout de 30s pour le rendu
};

// Cache en mémoire avec LRU
const memoryCache = new LRU({
  max: CONFIG.MAX_MEMORY_CACHE,
  ttl: 1000 * 60 * 60 // 1 heure
});

if (cluster.isMaster) {
  // Configuration du dossier cache
  if (!fs.existsSync(CONFIG.CACHE_DIR)) {
    fs.mkdirSync(CONFIG.CACHE_DIR);
  }

  // Lancement des workers
  for (let i = 0; i < CONFIG.WORKERS; i++) {
    cluster.fork();
  }

  // Redémarrage des workers en cas de crash
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.id} died. Restarting...`);
    cluster.fork();
  });

  // Nettoyage périodique du cache
  setInterval(() => {
    const now = Date.now();
    fs.readdir(CONFIG.CACHE_DIR, (err, files) => {
      if (err) return;
      files.forEach(file => {
        const filePath = `${CONFIG.CACHE_DIR}/${file}`;
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          if (now - stats.mtime.getTime() > 24 * 3600000) { // Supprimer les fichiers plus vieux que 24h
            fs.unlink(filePath, () => {});
          }
        });
      });
    });
  }, CONFIG.CLEANUP_INTERVAL);

} else {
  // Code du worker
  let browser;
  
  // Add error handling for browser initialization
  async function initBrowser() {
    try {
      browser = await puppeteer.launch({
        headless: "new",
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-audio-output',
        ],
      });
    } catch (error) {
      console.error('Failed to launch browser:', error);
      process.exit(1);
    }
  }

  // Pool de pages précréées
  const pagePool = {
    pages: [],
    async init(size = 5) {
      for (let i = 0; i < size; i++) {
        const page = await browser.newPage();
        await page.setCacheEnabled(true);
        this.pages.push({ page, inUse: false });
      }
    },
    async acquire() {
      const available = this.pages.find(p => !p.inUse);
      if (available) {
        available.inUse = true;
        return available.page;
      }
      const page = await browser.newPage();
      await page.setCacheEnabled(true);
      this.pages.push({ page, inUse: true });
      return page;
    },
    release(page) {
      const pageInfo = this.pages.find(p => p.page === page);
      if (pageInfo) {
        pageInfo.inUse = false;
      }
    }
  };

  const queue = new Queue("image-generation", {
    limiter: {
      max: 5, // Nombre maximum de jobs simultanés
      duration: 1000
    }
  });

  async function generateImage(html, options = {}) {
    const hash = crypto.createHash("md5").update(html + JSON.stringify(options)).digest("hex");
    const cachedFile = `${CONFIG.CACHE_DIR}/${hash}.png`;

    // Vérifier le cache mémoire
    const cachedImage = memoryCache.get(hash);
    if (cachedImage) return cachedImage;

    // Vérifier le cache fichier
    if (fs.existsSync(cachedFile)) {
      const image = fs.readFileSync(cachedFile);
      memoryCache.set(hash, image);
      return image;
    }

    const page = await pagePool.acquire();
    try {
      const { width = 1280, height = 720, fullPage = true } = options;

      await page.setViewport({ width, height });
      await Promise.race([
        page.setContent(html, { waitUntil: "networkidle0" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), CONFIG.PAGE_TIMEOUT))
      ]);

      const screenshot = await page.screenshot({ 
        type: "png", 
        fullPage,
        optimizeForSpeed: true
      });

      // Sauvegarder dans les caches
      fs.writeFileSync(cachedFile, screenshot);
      memoryCache.set(hash, screenshot);

      return screenshot;
    } finally {
      pagePool.release(page);
    }
  }

  queue.process(async (job, done) => {
    const { html, options } = job.data;
    try {
      const image = await generateImage(html, options);
      done(null, image);
    } catch (err) {
      done(err);
    }
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(require('compression')());

  // Add GET route for images
  app.get("/image", async (req, res) => {
    const html = decodeURIComponent(req.query.html);
    const options = req.query.options ? JSON.parse(decodeURIComponent(req.query.options)) : {};

    if (!html) {
        return res.status(400).json({ error: "HTML content is required" });
    }

    try {
        const job = await queue.add({ html, options }, {
            removeOnComplete: true,
            removeOnFail: true
        });

        const result = await job.finished();
        
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

app.post("/image", async (req, res) => {
    const { html, options } = req.body;

    if (!html) {
        return res.status(400).json({ error: "HTML content is required" });
    }

    try {
        const job = await queue.add({ html, options: options || {} }, {
            removeOnComplete: true,
            removeOnFail: true
        });

        const result = await job.finished();

        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Disposition': 'inline; filename=screenshot.png'
        });
        res.end(Buffer.from(result));
    } catch (err) {
        console.error("Error generating image:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

  app.use((req, res) => {
    res.status(404).json({ error: "Route not found" });
  });

  // Initialisation
  (async () => {
    await initBrowser();
    await pagePool.init();
    app.listen(CONFIG.PORT, () => {
      console.log(`Worker ${cluster.worker.id} running on http://localhost:${CONFIG.PORT}`);
    });
  })();
  // Add graceful shutdown
  process.on('SIGTERM', async () => {
    if (browser) {
      await browser.close();
    }
    process.exit(0);
  });
}