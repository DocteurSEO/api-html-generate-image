const express = require("express");
const puppeteer = require("puppeteer");
const Queue = require("bull");
const crypto = require("crypto");
const LRU = require("lru-cache");
const compression = require("compression");
const cors = require("cors");
const os = require("os");

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 3001,
  CACHE_MAX_ITEMS: process.env.CACHE_MAX_ITEMS || 20,
  CACHE_TTL: process.env.CACHE_TTL || 1800000, // 30 minutes
  PAGE_TIMEOUT: process.env.PAGE_TIMEOUT || 50000,
  BROWSER_CONFIG: {
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--js-flags=--max-old-space-size=512',
      '--disable-accelerated-2d-canvas',
      '--disable-speech-api',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad'
    ],
    ignoreDefaultArgs: ['--disable-font-subpixel-positioning']
  },
  PAGE_POOL_SIZE: process.env.PAGE_POOL_SIZE || 3
};

class BrowserPool {
  constructor() {
    this.pagePool = [];
    this.browser = null;
    this.isShuttingDown = false;
    this.activeRequests = 0;
  }

  async initialize() {
    this.browser = await puppeteer.launch(CONFIG.BROWSER_CONFIG);
    await this.createPool();
  }

  async createPool() {
    while (this.pagePool.length < CONFIG.PAGE_POOL_SIZE) {
      const page = await this.browser.newPage();
      await this.optimizePage(page);
      this.pagePool.push(page);
    }
  }

  async optimizePage(page) {
    page.setRequestInterception(true);
    page.on('request', request => {
      if (['media'].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.evaluateOnNewDocument(() => {
      window.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = '* { animation: none !important; transition: none !important; }';
        document.head.appendChild(style);
      });
    });
  }

  async getPage() {
    if (this.isShuttingDown) throw new Error('Browser pool is shutting down');
    
    const page = this.pagePool.pop();
    if (!page) {
      const newPage = await this.browser.newPage();
      await this.optimizePage(newPage);
      return newPage;
    }
    return page;
  }

  async releasePage(page) {
    if (this.pagePool.length < CONFIG.PAGE_POOL_SIZE) {
      await page.reload();
      this.pagePool.push(page);
    } else {
      await page.close();
    }
  }

  async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    try {
      await Promise.all(this.pagePool.map(page => page.close()));
      this.pagePool.length = 0;
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    } catch (error) {
      console.error('Error shutting down browser pool:', error);
    }
  }
}

class ImageGenerator {
  constructor() {
    this.app = express();
    this.cache = new LRU({
      max: CONFIG.CACHE_MAX_ITEMS,
      ttl: CONFIG.CACHE_TTL,
      updateAgeOnGet: true,
      dispose: (key, value) => {
        console.log(`Cache item removed: ${key}`);
      }
    });
    this.pool = new BrowserPool();
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(compression({
      level: 6,
      threshold: 10 * 1024
    }));
    this.app.use(express.json({ limit: "10mb" }));
    this.app.use(express.urlencoded({ extended: true, limit: "10mb" }));
  }

  setupRoutes() {
    this.app.get("/health", (req, res) => {
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage()
      });
    });

    this.app.post("/image", this.generateImage.bind(this));
    this.app.get("/capture", this.captureUrl.bind(this));
  }

  async generateImage(req, res) {
    try {
      if (!req.body.html) {
        return res.status(400).json({ error: "HTML required" });
      }

      const options = this.validateOptions(req.body);
      if (options.error) {
        return res.status(400).json(options);
      }

      const hash = crypto.createHash("md5").update(req.body.html + JSON.stringify(options)).digest("hex");
      const cached = this.cache.get(hash);
      if (cached) {
        return res.end(cached);
      }

      const page = await this.pool.getPage();
      try {
        await page.setViewport(options);
        await page.setContent(req.body.html, { 
          waitUntil: ["domcontentloaded"],
          timeout: CONFIG.PAGE_TIMEOUT 
        });

        const result = await this.generateOutput(page, options);
        this.cache.set(hash, result);
          
        if (options.format === 'pdf') {
          res.setHeader('Content-Type', 'application/pdf');
        } else {
          res.setHeader('Content-Type', `image/${options.format}`);
        }



        res.end(result);
      } catch (error) {
        console.error('Generation error:', error);
        throw error;
      } finally {
        await this.pool.releasePage(page);
      }
    } catch (error) {
      res.status(500).json({ error: "Generation failed" });
    }
  }

  async captureUrl(req, res) {
    try {
      const url = req.query.url;
      if (!url) {
        return res.status(400).json({ error: "URL required" });
      }

      const options = this.validateOptions(req.query);
      if (options.error) {
        return res.status(400).json(options);
      }

      const hash = crypto.createHash("md5").update(url + JSON.stringify(options)).digest("hex");
      const cached = this.cache.get(hash);
      if (cached) {
        return res.end(cached);
      }

      const page = await this.pool.getPage();
      try {
        await page.setViewport(options);
        await page.goto(url, { 
          waitUntil: ["domcontentloaded"],
          timeout: CONFIG.PAGE_TIMEOUT 
        });

        const result = await this.generateOutput(page, options);
        this.cache.set(hash, result);
        res.end(result);
      } catch (error) {
        console.error('Capture error:', error);
        throw error;
      } finally {
        await this.pool.releasePage(page);
      }
    } catch (error) {
      res.status(500).json({ error: "Capture failed" });
    }
  }

  validateOptions(params) {
    const options = {
      width: parseInt(params.width) || 800,
      height: parseInt(params.height) || 600,
      quality: parseInt(params.quality) || 80,
      format: (params.format || 'jpeg').toLowerCase(),
      fullPage: params.fullPage === 'true'
    };
  if(params.format =='png'.toLocaleLowerCase()){
    //remove quality
    delete options['quality']
  }
    if (options.width < 1 || options.width > 4000 || 
        options.height < 1 || options.height > 4000) {
      return { error: "Invalid dimensions" };
    }

    if (options.quality < 1 || options.quality > 100) {
      return { error: "Invalid quality" };
    }

    if (!['jpeg', 'png', 'pdf'].includes(options.format)) {
      return { error: "Invalid format" };
    }

    return options;
  }

  async generateOutput(page, options) {
    if (options.format === 'pdf') {
      return await page.pdf({
        width: `${options.width}px`,
        height: `${options.height}px`,
        printBackground: true,
        preferCSSPageSize: true
      });
    } else {
      return await page.screenshot({
        type: options.format,
        width: options.width,
        height: options.height,
        quality: options.quality,
        fullPage: options.fullPage,
        optimizeForSpeed: true
      });
    }
  }
}

// Initialize and start server
async function main() {
  const generator = new ImageGenerator();
  const pool = generator.pool;

  try {
    await pool.initialize();
    
    const server = generator.app.listen(CONFIG.PORT, () => {
      console.log(`Server running on port ${CONFIG.PORT}`);
    });

    // Setup shutdown handlers
    process.on('SIGTERM', () => pool.shutdown());
    process.on('SIGINT', () => pool.shutdown());
    process.on('uncaughtException', (err) => {
      console.error('Uncaught Exception:', err);
      pool.shutdown();
    });
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', reason, promise);
      pool.shutdown();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();