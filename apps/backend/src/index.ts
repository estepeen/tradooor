import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { smartWalletRouter } from './routes/smart-wallets.js';
import { tradesRouter } from './routes/trades.js';
import { statsRouter } from './routes/stats.js';
import { tokensRouter } from './routes/tokens.js';
import webhookRouter from './routes/webhooks.js';

// Zkontroluj, jestli nemáme chybu při načítání dotenv.
const dotenvResult = dotenv.config();
if (dotenvResult.error) {
  console.error('❌ Chyba při načítání .env souboru:', dotenvResult.error);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Webhook routes - musí být před debug middleware, aby odpovídaly rychle
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

// API routes (webhook router už je zaregistrovaný výše)
app.use('/api/smart-wallets', smartWalletRouter);
app.use('/api/trades', tradesRouter);
app.use('/api/stats', statsRouter);
app.use('/api/tokens', tokensRouter);

// Ošetření chyb "route not found"
app.use((req, res, next) => {
  res.status(404).json({ error: 'Route not found', path: req.originalUrl });
});

// Ošetření ostatních chyb Expressu
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('❌ Neočekávaná chyba:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
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
