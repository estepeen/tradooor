import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { smartWalletRouter } from './routes/smart-wallets.js';
import { tradesRouter } from './routes/trades.js';
import { statsRouter } from './routes/stats.js';

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

// Debug middleware (after JSON/body parsing to avoid undefined body)
app.use((req, res, next) => {
  console.log(`\n🌐 ${new Date().toISOString()} ${req.method} ${req.path}`);
  if (req.query && Object.keys(req.query).length > 0) {
    console.log('   Query:', req.query);
  }
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    console.log('   Body:', JSON.stringify(req.body, null, 2));
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
      stats: '/api/stats',
    },
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/smart-wallets', smartWalletRouter);
app.use('/api/trades', tradesRouter);
app.use('/api/stats', statsRouter);

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
  console.log(`   GET  /api/smart-wallets/:id`);
  console.log(`   GET  /api/trades`);
  console.log(`   GET  /api/stats/overview`);
  console.log(`\n🔍 Debug mode: ${process.env.NODE_ENV === 'development' ? 'ON' : 'OFF'}`);
});
