import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { smartWalletRouter } from './routes/smart-wallets.js';
import { tradesRouter } from './routes/trades.js';
import { tokensRouter } from './routes/tokens.js';
import webhookRouter from './routes/webhooks.js';

// Check if there's an error loading dotenv
const dotenvResult = dotenv.config();
if (dotenvResult.error) {
  console.error('❌ Error loading .env file:', dotenvResult.error);
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// CORS configuration - allow all origins for development
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Access-Control-Request-Method', 'Access-Control-Request-Headers', 'Cache-Control'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
}));

// Handle OPTIONS preflight requests BEFORE other middleware
app.options('*', (req, res) => {
  const origin = req.headers.origin;
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, Access-Control-Request-Method, Access-Control-Request-Headers');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(204);
});

// Additional CORS headers for all responses (backup)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, Access-Control-Request-Method, Access-Control-Request-Headers');
  next();
});

// Helius webhook endpoint removed - using QuickNode only

// QuickNode webhook endpoint should also bypass the default JSON body limit by using raw body.
// The actual route handler logic lives in routes/webhooks.ts; here we only ensure the body
// size limit is large enough and respond as fast as possible.
app.post('/api/webhooks/quicknode', express.raw({ type: 'application/json', limit: '5mb' }), (req, res, next) => {
  // Parse Buffer to JSON and attach to req.body for downstream handlers
  try {
    if (Buffer.isBuffer(req.body)) {
      req.body = JSON.parse(req.body.toString('utf8'));
    }
  } catch (error) {
    console.error('❌ Error parsing QuickNode webhook body:', error);
    // Continue anyway, let router handle the error
  }
  next();
});

// Other routes use JSON parser (including /api/webhooks mounted below)
// Increase body size limit to handle larger QuickNode webhook payloads
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

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
      trades: '/api/trades',
      tokens: '/api/tokens',
      webhooks: '/api/webhooks/quicknode (POST)',
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
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, Access-Control-Request-Method, Access-Control-Request-Headers');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  
  res.status(204).send();
});

// API routes (webhook router is already registered above)
app.use('/api/smart-wallets', smartWalletRouter);
app.use('/api/trades', tradesRouter);
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
