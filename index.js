const express = require("express");
const puppeteer = require("puppeteer");
const Queue = require("bull");
const cluster = require("cluster");
const os = require("os");
const crypto = require("crypto");
const LRU = require("lru-cache");
const fs = require("fs").promises;
const path = require("path");
const compression = require("compression");
const cors = require("cors");  // Add this line

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 3001,
  WORKERS: 1,  // Reduced to 1 worker due to limited CPU
  CACHE_DIR: "./cache",
  MAX_MEMORY_CACHE: 50,  // Reduced for memory constraints
  CLEANUP_INTERVAL: 3600000,
  PAGE_TIMEOUT: 10000,  // Reduced timeout
  REQUEST_TIMEOUT: 15000,
  MAX_CONCURRENT_JOBS: 2,  // Reduced concurrent jobs
  MEMORY_LIMIT: 512 * 1024 * 1024,
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
      '--enable-low-end-device-mode',
      '--no-zygote',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run'
    ]
  }
};

// Memory cache initialization
const memoryCache = new LRU({
  max: CONFIG.MAX_MEMORY_CACHE,
  ttl: 1000 * 60 * 60,
  updateAgeOnGet: true,
  updateAgeOnHas: true
});

class PagePool {
  constructor(maxSize = 2) {  // Reduced pool size
    this.pages = [];
    this.maxSize = maxSize;
  }

  async initialize(browser) {
    for (let i = 0; i < this.maxSize; i++) {
      const page = await browser.newPage();
      await this.optimizePage(page);
      this.pages.push({ page, inUse: false, lastUsed: Date.now() });
    }
  }

  async optimizePage(page) {
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
        request.continue();
      } else {
        request.abort();
      }
    });
  }

  async acquire() {
    const availablePage = this.pages.find(p => !p.inUse);
    if (!availablePage) {
      throw new Error('No pages available in pool');
    }
    availablePage.inUse = true;
    availablePage.lastUsed = Date.now();
    return availablePage.page;
  }

  async release(page) {
    const pageInfo = this.pages.find(p => p.page === page);
    if (pageInfo) {
      pageInfo.inUse = false;
      pageInfo.lastUsed = Date.now();
    }
  }

  async cleanup() {
    const now = Date.now();
    const oldPages = this.pages.filter(
      p => !p.inUse && (now - p.lastUsed > 300000)
    );
    
    for (const pageInfo of oldPages) {
      try {
        await pageInfo.page.close();
        this.pages = this.pages.filter(p => p !== pageInfo);
        const newPage = await browser.newPage();
        await this.optimizePage(newPage);
        this.pages.push({ page: newPage, inUse: false, lastUsed: Date.now() });
      } catch (err) {
        console.error('Error during page cleanup:', err);
      }
    }
  }
}

if (cluster.isMaster) {
  console.log(`Master process ${process.pid} starting...`);
  
  // Create cache directory
  fs.mkdir(CONFIG.CACHE_DIR, { recursive: true }).catch(console.error);
  
  // Launch workers
  for (let i = 0; i < CONFIG.WORKERS; i++) {
    cluster.fork();
  }
  
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.id} died (${signal || code}). Restarting...`);
    cluster.fork();
  });
  
  // Cache cleanup
  const cleanupCache = async () => {
    try {
      const files = await fs.readdir(CONFIG.CACHE_DIR);
      const now = Date.now();
      
      await Promise.all(files.map(async file => {
        const filePath = path.join(CONFIG.CACHE_DIR, file);
        const stats = await fs.stat(filePath);
        
        if (now - stats.mtime.getTime() > 24 * 3600000) {
          await fs.unlink(filePath).catch(() => {});
        }
      }));
    } catch (err) {
      console.error('Cache cleanup error:', err);
    }
  };
  
  setInterval(cleanupCache, CONFIG.CLEANUP_INTERVAL);
  
} else {
  // Worker process
  let browser;
  let pagePool;
  
  const app = express();
  app.use(cors());  // Add this line
  app.use(compression());
  app.use(express.json({ limit: "2mb" }));
  
  // Queue setup
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
  
  queue.on('error', error => console.error('Queue error:', error));
  queue.on('failed', (job, error) => console.error('Job failed:', error));
  
  // Image generation function
  const generateImage = async (html, options = {}) => {
    const hash = crypto.createHash("md5")
      .update(html + JSON.stringify(options))
      .digest("hex");
    
    const cached = memoryCache.get(hash);
    if (cached) return cached;
    
    const page = await pagePool.acquire();
    try {
      const { width = 800, height = 600, fullPage = false } = options;  // Reduced default size
      
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await Promise.race([
        page.setContent(html, { 
          waitUntil: "domcontentloaded",
          timeout: 5000 
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
      ]);
      
      const screenshot = await page.screenshot({
        fullPage,
        type: 'jpeg',
        quality: 80  // Reduced quality for better performance
      });
      
      memoryCache.set(hash, screenshot);
      return screenshot;
    } finally {
      await pagePool.release(page);
    }
  };
  
  // Route handlers
  app.get("/image", async (req, res) => {
    console.log('GET request received at:', new Date().toISOString());
    
    if (!req.query.html) {
      console.log('No HTML provided');
      return res.status(400).json({ error: "HTML parameter is required" });
    }
    
    try {
      // Direct generation without queue
      console.log('Processing request directly...');
      const result = await generateImage(decodeURIComponent(req.query.html), {});
      console.log('Image generated successfully');
    
      res.set({
        'Content-Type': 'image/jpeg',
        'Content-Length': result.length,
        'Cache-Control': 'public, max-age=3600'
      });
      res.end(result);
      console.log('Response sent');
    } catch (err) {
      console.error('Request failed:', err);
      res.status(500).json({ error: err.message || "Internal server error" });
    }
  });
  
  app.post("/image", async (req, res) => {
    const { html, options } = req.body;
    
    if (!html) {
      return res.status(400).json({ error: "HTML content is required" });
    }
    
    try {
      const job = await queue.add({ html, options: options || {} });
      const result = await job.finished();
      
      res.set({
        'Content-Type': 'image/jpeg',
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
  
  // Error handler
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });
  
  // Initialization
  const initialize = async () => {
    try {
      browser = await puppeteer.launch(CONFIG.BROWSER_CONFIG);
      pagePool = new PagePool();
      await pagePool.initialize(browser);
      
      app.listen(CONFIG.PORT, () => {
        console.log(`Worker ${cluster.worker.id} running on port ${CONFIG.PORT}`);
      });
      
      // Periodic cleanup
      setInterval(() => pagePool.cleanup(), 300000);
      
      // Memory monitoring
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
  };
  
  // Shutdown handling
  const shutdown = async () => {
    if (browser) await browser.close();
    await queue.close();
    process.exit(0);
  };
  
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  
  initialize();
}