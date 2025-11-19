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

// Speciální handler pro webhook endpoint - odpovídá okamžitě
// Musí být PŘED JSON parserem, aby se vyhnul parsování body
app.post('/api/webhooks/helius', express.raw({ type: 'application/json', limit: '10mb' }), (req, res) => {
  const startTime = Date.now();
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
  console.log('📨 ===== WEBHOOK REQUEST RECEIVED (IMMEDIATE) =====');
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   IP: ${clientIp}`);
  console.log(`   Content-Length: ${req.headers['content-length'] || 'unknown'}`);
  
  // Odpověz okamžitě PŘED jakýmkoliv zpracováním
  const responseTime = Date.now() - startTime;
  res.status(200).json({
    success: true,
    message: 'Webhook received, processing in background',
    responseTimeMs: responseTime,
  });

  // Zpracuj asynchronně na pozadí
  setImmediate(async () => {
    try {
      // Parse JSON z raw body
      const body = JSON.parse(req.body.toString());
      
      // Zavolej webhook handler z routeru
      const mockReq = {
        ...req,
        body,
        method: 'POST',
        path: '/helius',
        originalUrl: '/api/webhooks/helius',
      } as any;
      
      const mockRes = {
        status: () => mockRes,
        json: () => {},
        send: () => {},
      } as any;
      
      // Zavolej webhook handler
      await (webhookRouter as any).handle(mockReq, mockRes, () => {});
    } catch (error: any) {
      console.error('❌ Error processing webhook in background:', error);
      if (error.stack) {
        console.error('   Stack:', error.stack.split('\n').slice(0, 5).join('\n'));
      }
    }
  });
});

// Ostatní routes používají JSON parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Webhook routes (pro ostatní endpointy jako /test)
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
