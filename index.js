const express = require("express");
const puppeteer = require("puppeteer");
const Queue = require("bull");
const crypto = require("crypto");
const LRU = require("lru-cache");
const compression = require("compression");
const cors = require("cors");
const genericPool = require("generic-pool");
const cluster = require("cluster");
const promClient = require('prom-client');
const os = require('os');

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 3001,
  CACHE_MAX_SIZE: 500000000, // 500MB
  CACHE_TTL: 1800000, // 30 min
  PAGE_TIMEOUT: 10000,
  POOL: {
    BROWSER: {
      max: 4,
      min: 2
    },
    PAGE: {
      max: 10,
      min: 5
    }
  },
  BROWSER_CONFIG: {
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--js-flags=--max-old-space-size=512'
    ]
  }
};

// Prometheus metrics
const register = new promClient.Registry();
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'code'],
  buckets: [0.1, 0.5, 1, 2, 5]
});
register.registerMetric(httpRequestDuration);

// Cache with size tracking
const cache = new LRU({
  maxSize: CONFIG.CACHE_MAX_SIZE,
  ttl: CONFIG.CACHE_TTL,
  sizeCalculation: (value) => value.length
});

// Browser pool
const browserPool = genericPool.createPool({
  create: () => puppeteer.launch(CONFIG.BROWSER_CONFIG),
  destroy: (browser) => browser.close()
}, CONFIG.POOL.BROWSER);

// Page pool
const pagePool = genericPool.createPool({
  create: async () => {
    const browser = await browserPool.acquire();
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    
    page.on('request', (req) => {
      ['image', 'font', 'stylesheet', 'media'].includes(req.resourceType()) 
        ? req.abort() 
        : req.continue();
    });
    
    return { page, browser };
  },
  destroy: async ({ page, browser }) => {
    await page.close();
    await browserPool.release(browser);
  }
}, CONFIG.POOL.PAGE);

// Bull queue
const imageQueue = new Queue('image-generation', process.env.REDIS_URL || 'redis://localhost:6379');

// Express app
const createApp = () => {
  const app = express();
  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit: "10mb" }));

  // Metrics endpoint
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  // Image endpoints
  app.post("/image", async (req, res) => {
    const end = httpRequestDuration.startTimer();
    try {
      const job = await imageQueue.add({
        html: req.body.html,
        options: req.body
      });
      
      res.json({ 
        jobId: job.id,
        statusUrl: `/job/${job.id}`
      });
    } catch (error) {
      end({ method: 'POST', route: '/image', code: 500 });
      res.status(500).json({ error: "Job creation failed" });
    }
    end({ method: 'POST', route: '/image', code: 200 });
  });

  app.get("/job/:id", async (req, res) => {
    const job = await imageQueue.getJob(req.params.id);
    
    if (!job) return res.status(404).json({ error: "Job not found" });
    
    const state = await job.getState();
    const progress = job.progress();
    
    res.json({
      id: job.id,
      state,
      progress,
      result: state === 'completed' ? job.returnvalue : null
    });
  });

  return app;
};

// Image generation worker
imageQueue.process(os.cpus().length, async (job) => {
  const { html, options } = job.data;
  const hash = crypto.createHash("sha256").update(html + JSON.stringify(options)).digest("hex");
  
  if (cache.has(hash)) {
    return cache.get(hash);
  }

  const { page } = await pagePool.acquire();
  try {
    const { width = 800, height = 600, quality = 80, format = 'jpeg' } = options;
    
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.setContent(html, { 
      waitUntil: "networkidle0",
      timeout: CONFIG.PAGE_TIMEOUT 
    });

    await page.waitForFunction(() => 
      document.readyState === 'complete' && 
      (window.renderingComplete === true || !window.renderingComplete),
      { timeout: CONFIG.PAGE_TIMEOUT }
    );

    let output;
    if (format === 'pdf') {
      output = await page.pdf({
        width: `${width}px`,
        height: `${height}px`,
        printBackground: true
      });
    } else {
      output = await page.screenshot({
        type: format,
        quality: format === 'jpeg' ? quality : undefined,
        fullPage: false,
        omitBackground: false
      });
    }

    cache.set(hash, output);
    return output;
  } finally {
    await pagePool.release({ page });
    await page.evaluate(() => document.body.innerHTML = '');
  }
});

// Cluster management
if (cluster.isPrimary) {
  // Pre-warm pools
  browserPool.start();
  pagePool.start();

  for (let i = 0; i < os.cpus().length; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker) => {
    console.log(`Worker ${worker.process.pid} died`);
    cluster.fork();
  });
} else {
  const app = createApp();
  const server = app.listen(CONFIG.PORT, () => {
    console.log(`Worker ${process.pid} listening on ${CONFIG.PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log(`Worker ${process.pid} shutting down`);
    await browserPool.drain();
    await pagePool.drain();
    await imageQueue.close();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}