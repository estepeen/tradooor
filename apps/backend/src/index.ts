import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { smartWalletRouter } from './routes/smart-wallets.js';
import { tradesRouter } from './routes/trades.js';
import { statsRouter } from './routes/stats.js';
import { tokensRouter } from './routes/tokens.js';
import webhookRouter, { processHeliusWebhook } from './routes/webhooks.js';

// Check if there's an error loading dotenv
const dotenvResult = dotenv.config();
if (dotenvResult.error) {
  console.error('❌ Error loading .env file:', dotenvResult.error);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration with detailed logging
const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    // Log all CORS requests for debugging
    console.log(`🌐 [CORS] Request from origin: ${origin || 'no origin'}`);
    
    // Allow requests with no origin (like mobile apps, Postman, curl)
    if (!origin) {
      console.log(`✅ [CORS] Allowing request with no origin`);
      return callback(null, true);
    }
    
    // Allow all origins for now (can be restricted later)
    console.log(`✅ [CORS] Allowing origin: ${origin}`);
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Access-Control-Request-Method', 'Access-Control-Request-Headers'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Additional CORS logging middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const method = req.method;
  
  if (method === 'OPTIONS') {
    console.log(`🔍 [CORS] Preflight OPTIONS request from: ${origin}`);
    console.log(`🔍 [CORS] Request headers:`, req.headers['access-control-request-method'], req.headers['access-control-request-headers']);
  }
  
  // Log response headers after CORS middleware
  res.on('finish', () => {
    console.log(`📤 [CORS] Response headers:`, {
      'Access-Control-Allow-Origin': res.getHeader('Access-Control-Allow-Origin'),
      'Access-Control-Allow-Methods': res.getHeader('Access-Control-Allow-Methods'),
      'Access-Control-Allow-Headers': res.getHeader('Access-Control-Allow-Headers'),
      'Access-Control-Allow-Credentials': res.getHeader('Access-Control-Allow-Credentials'),
    });
  });
  
  next();
});

// MINIMAL handler for webhook endpoint - responds immediately without any processing
// Must be BEFORE JSON parser to avoid body parsing
app.post('/api/webhooks/helius', express.raw({ type: 'application/json', limit: '10mb' }), (req, res) => {
  const startTime = Date.now();
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
  // Respond immediately BEFORE any processing (even before logging)
  res.status(200).json({ ok: true, message: 'webhook received' });
  
  // Log after sending response
  const responseTime = Date.now() - startTime;
  console.log('📨 ===== WEBHOOK REQUEST RECEIVED (IMMEDIATE) =====');
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   IP: ${clientIp}`);
  console.log(`   Response time: ${responseTime}ms`);
  console.log(`   Content-Length: ${req.headers['content-length'] || 'unknown'}`);

  // Process asynchronously in background
  setImmediate(async () => {
    const backgroundStartTime = Date.now();
    try {
      console.log('🔄 ===== BACKGROUND PROCESSING STARTED (FROM INDEX.TS) =====');
      
      // Parse JSON from raw body
      const body = JSON.parse(req.body.toString());
      console.log('   Parsed body keys:', Object.keys(body || {}));
      
      // Call webhook processing function
      console.log('   Calling processHeliusWebhook...');
      await processHeliusWebhook(body);
      
      const backgroundTime = Date.now() - backgroundStartTime;
      console.log(`✅ Background processing completed in ${backgroundTime}ms`);
    } catch (error: any) {
      const backgroundTime = Date.now() - backgroundStartTime;
      console.error(`❌ Error processing webhook in background (after ${backgroundTime}ms):`, error);
      if (error.message) {
        console.error('   Error message:', error.message);
      }
      if (error.stack) {
        console.error('   Stack:', error.stack.split('\n').slice(0, 5).join('\n'));
      }
    }
  });
});

// Other routes use JSON parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Webhook routes (for other endpoints like /test)
app.use('/api/webhooks', webhookRouter);

// Debug middleware (after JSON/body parsing to avoid undefined body)
// Skip logging for webhook endpoints to avoid slowing them down
app.use((req, res, next) => {
  // Skip debug logging for webhook endpoints (they need to respond quickly)
  if (req.path.startsWith('/api/webhooks')) {
    return next();
  }
  
  console.log(`\n🌐 ${new Date().toISOString()} ${req.method} ${req.path}`);
  if (req.query && Object.keys(req.query).length > 0) {
    console.log('   Query:', req.query);
  }
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    // Limit body logging to avoid performance issues
    const bodyStr = JSON.stringify(req.body);
    if (bodyStr.length > 500) {
      console.log('   Body:', bodyStr.substring(0, 500) + '... (truncated)');
    } else {
      console.log('   Body:', bodyStr);
    }
  }
  next();
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'SolBot API',
    version: '1.0.0',
      endpoints: {
        health: '/health',
        smartWallets: '/api/smart-wallets',
        smartWalletsSync: '/api/smart-wallets/sync (POST, sync from wallets.csv)',
        smartWalletsBackfill: '/api/smart-wallets/backfill (POST, backfill historical transactions)',
        smartWalletsPnl: '/api/smart-wallets/:id/pnl (GET, get PnL data)',
        trades: '/api/trades',
        tradesRecalculate: '/api/trades/recalculate-all (POST, re-process all trades with fixed logic)',
        stats: '/api/stats',
        tokensEnrich: '/api/tokens/enrich-symbols (POST, enrich token symbols from Helius)',
        webhooks: '/api/webhooks/helius (POST, receive Helius webhook notifications)',
      },
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// CORS test endpoint
app.get('/api/cors-test', (req, res) => {
  res.json({ 
    message: 'CORS test successful',
    origin: req.headers.origin,
    timestamp: new Date().toISOString(),
    headers: {
      origin: req.headers.origin,
      'access-control-request-method': req.headers['access-control-request-method'],
      'access-control-request-headers': req.headers['access-control-request-headers'],
    },
    responseHeaders: {
      'Access-Control-Allow-Origin': res.getHeader('Access-Control-Allow-Origin'),
      'Access-Control-Allow-Methods': res.getHeader('Access-Control-Allow-Methods'),
      'Access-Control-Allow-Headers': res.getHeader('Access-Control-Allow-Headers'),
    },
  });
});

// Explicit OPTIONS handler for all routes (fallback)
app.options('*', (req, res) => {
  console.log(`🔍 [CORS] Explicit OPTIONS handler called for: ${req.path}`);
  console.log(`🔍 [CORS] Origin: ${req.headers.origin}`);
  console.log(`🔍 [CORS] Request method: ${req.headers['access-control-request-method']}`);
  console.log(`🔍 [CORS] Request headers: ${req.headers['access-control-request-headers']}`);
  
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  
  res.status(204).send();
});

// API routes (webhook router is already registered above)
app.use('/api/smart-wallets', smartWalletRouter);
app.use('/api/trades', tradesRouter);
app.use('/api/stats', statsRouter);
app.use('/api/tokens', tokensRouter);

// Handle "route not found" errors
app.use((req, res, next) => {
  res.status(404).json({ error: 'Route not found', path: req.originalUrl });
});

// Handle other Express errors
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('❌ Unexpected error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Listen on 0.0.0.0 (all interfaces, IPv4 and IPv6) for external access
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend server running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 API endpoints:`);
  console.log(`   GET  /api/smart-wallets`);
  console.log(`   POST /api/smart-wallets`);
  console.log(`   POST /api/smart-wallets/sync (sync from wallets.csv)`);
  console.log(`   GET  /api/smart-wallets/:id`);
  console.log(`   GET  /api/trades`);
  console.log(`   GET  /api/stats/overview`);
  console.log(`\n🔍 Debug mode: ${process.env.NODE_ENV === 'development' ? 'ON' : 'OFF'}`);
});
