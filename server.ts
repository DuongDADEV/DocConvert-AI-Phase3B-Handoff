import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import { generalApiRateLimiter } from './server/middleware/rateLimiter.js';
import authRoutes from './server/routes/auth.js';
import documentRoutes from './server/routes/documents.js';
import jobRoutes from './server/routes/jobs.js';
import planRoutes from './server/routes/plans.js';
import auditRoutes from './server/routes/audit.js';
import { ocrWorker } from './server/services/ocrWorker.js';

export async function createApp() {
  const app = express();

  // 1. Dynamic Production-Ready CORS Configuration
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
    'https://docconvert-ai-kohl.vercel.app',
    ...(process.env.APP_URL ? [process.env.APP_URL.replace(/\/+$/, '')] : []),
    ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL.replace(/\/+$/, '')] : []),
  ];

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. server-to-server, curl, mobile apps)
      if (!origin) return callback(null, true);

      if (
        allowedOrigins.includes(origin) ||
        origin.endsWith('.vercel.app') ||
        process.env.NODE_ENV !== 'production'
      ) {
        return callback(null, true);
      }

      return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  }));

  // 2. Body Parsing & Rate Limiting
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));
  app.use('/api', generalApiRateLimiter);

  // 3. Health Check Endpoints (both root /health and /api/health)
  const healthResponse = (_req: express.Request, res: express.Response) => {
    res.json({
      status: 'ok',
      service: 'docconvert-ai-backend',
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      azureDocumentIntelligence: process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ? 'CONFIGURED' : 'UNCONFIGURED',
      timestamp: new Date().toISOString(),
    });
  };

  app.get('/health', healthResponse);
  app.get('/api/health', healthResponse);

  // 4. Mount API Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/documents', documentRoutes);
  app.use('/api/jobs', jobRoutes);
  app.use('/api/plans', planRoutes);
  app.use('/api/audit-logs', auditRoutes);

  // 5. Global Error Handler for API
  app.use('/api', (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled API Error:', err);
    res.status(err.status || 500).json({
      success: false,
      error: err.message || 'Đã xảy ra lỗi máy chủ nội bộ. Vui lòng thử lại.',
    });
  });

  // 6. Frontend Serving (Local Dev Vite Middleware vs Production Static)
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return app;
}

let serverInstance: any = null;

export async function startServer() {
  const app = await createApp();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  serverInstance = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`[DocConvert AI] Server is running on http://0.0.0.0:${PORT} (env: ${process.env.NODE_ENV || 'development'})`);
    // Explicitly scan and resume pending QUEUED / PROCESSING jobs on server startup
    try {
      await ocrWorker.resumeUnfinishedJobs();
    } catch (resumeErr) {
      console.warn('[DocConvert AI] Error resuming pending jobs on startup:', resumeErr);
    }
  });

  const gracefulShutdown = (signal: string) => {
    console.log(`[DocConvert AI] Received ${signal}. Initiating graceful shutdown...`);
    if (serverInstance) {
      serverInstance.close(() => {
        console.log('[DocConvert AI] HTTP server closed cleanly.');
        process.exit(0);
      });

      // Force exit if hanging after 10 seconds
      setTimeout(() => {
        console.error('[DocConvert AI] Force exiting after 10s timeout.');
        process.exit(1);
      }, 10000).unref();
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return serverInstance;
}

// Auto-start server when executed directly
startServer().catch((err) => {
  console.error('Failed to start DocConvert AI server:', err);
});

