import { Router } from 'express';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';

const router = Router();
const smartWalletRepo = new SmartWalletRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const tradeRepo = new TradeRepository();
const metricsCalculator = new MetricsCalculatorService(
  smartWalletRepo,
  tradeRepo,
  metricsHistoryRepo
);

// GET /api/smart-wallets - List all smart wallets with pagination and filters
router.get('/', async (req, res) => {
  try {
    console.log('📥 GET /api/smart-wallets - Request received');
    console.log('📦 Query params:', JSON.stringify(req.query, null, 2));

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 50;
    const minScore = req.query.minScore ? parseFloat(req.query.minScore as string) : undefined;
    const tags = req.query.tags ? (req.query.tags as string).split(',') : undefined;
    const search = req.query.search as string | undefined;
    const sortBy = req.query.sortBy as 'score' | 'winRate' | 'recentPnl30dPercent' | undefined;
    const sortOrder = (req.query.sortOrder as 'asc' | 'desc') || 'desc';

    console.log(`🔍 Fetching wallets - page: ${page}, pageSize: ${pageSize}`);
    const result = await smartWalletRepo.findAll({
      page,
      pageSize,
      minScore,
      tags,
      search,
      sortBy,
      sortOrder,
    });

    console.log(`✅ Found ${result.wallets.length} wallets (total: ${result.total})`);
    res.json(result);
  } catch (error: any) {
    console.error('❌ Error fetching smart wallets:');
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    console.error('Full error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    });
  }
});

// GET /api/smart-wallets/:id - Get wallet details
router.get('/:id', async (req, res) => {
  try {
    console.log(`📥 GET /api/smart-wallets/:id - Request received for ID: ${req.params.id}`);
    const wallet = await smartWalletRepo.findById(req.params.id);
    if (!wallet) {
      console.log(`❌ Wallet not found: ${req.params.id}`);
      return res.status(404).json({ error: 'Wallet not found' });
    }

    console.log(`✅ Wallet found, fetching metrics history and advanced stats`);
    // Get metrics history for charts
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const metricsHistory = await metricsHistoryRepo.findByWalletId(wallet.id, thirtyDaysAgo);

    // Get advanced stats
    const advancedStats = await metricsCalculator.calculateAdvancedStats(wallet.id);

    console.log(`✅ Returning wallet details with ${metricsHistory.length} history records`);
    res.json({
      ...wallet,
      metricsHistory,
      advancedStats,
    });
  } catch (error: any) {
    console.error('❌ Error fetching wallet details:');
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    });
  }
});

// POST /api/smart-wallets - Create new smart wallet
router.post('/', async (req, res) => {
  try {
    console.log('📥 POST /api/smart-wallets - Request received');
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));

    const { address, label, tags } = req.body;

    if (!address) {
      console.log('❌ Validation error: Address is required');
      return res.status(400).json({ error: 'Address is required' });
    }

    console.log(`🔍 Checking if wallet exists: ${address}`);
    // Check if wallet already exists
    const existing = await smartWalletRepo.findByAddress(address);
    if (existing) {
      console.log(`⚠️  Wallet already exists: ${address}`);
      return res.status(409).json({ error: 'Wallet already exists' });
    }

    console.log(`✅ Wallet not found, creating new wallet: ${address}`);
    const wallet = await smartWalletRepo.create({
      address,
      label,
      tags,
    });

    console.log(`✅ Wallet created successfully: ${wallet.id}`);
    res.status(201).json(wallet);
  } catch (error: any) {
    console.error('❌ Error creating smart wallet:');
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    console.error('Full error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    });
  }
});

export { router as smartWalletRouter };

