import { prisma, generateId } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';

export class SmartWalletRepository {
  async findAll(params?: {
    page?: number;
    pageSize?: number;
    minScore?: number;
    tags?: string[];
    search?: string;
    sortBy?: 'score' | 'winRate' | 'recentPnl30dUsd' | 'recentPnl30dPercent' | 'totalTrades' | 'lastTradeTimestamp' | 'label' | 'address';
    sortOrder?: 'asc' | 'desc';
  }) {
    const page = params?.page ?? 1;
    const pageSize = params?.pageSize ?? 50;
    const skip = (page - 1) * pageSize;

    // Build where clause
    const where: Prisma.SmartWalletWhereInput = {};

    if (params?.minScore !== undefined) {
      where.score = { gte: params.minScore };
    }

    if (params?.tags && params.tags.length > 0) {
      where.tags = { hasEvery: params.tags };
    }

    if (params?.search) {
      where.OR = [
        { address: { contains: params.search, mode: 'insensitive' } },
        { label: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    // Build orderBy
    const sortBy = params?.sortBy ?? 'score';
    const sortOrder = params?.sortOrder ?? 'desc';
    
    let orderBy: Prisma.SmartWalletOrderByWithRelationInput = {};
    
    // Only apply DB sorting for fields that exist in the database
    if (sortBy !== 'lastTradeTimestamp' && sortBy !== 'recentPnl30dUsd' && sortBy !== 'recentPnl30dPercent') {
      orderBy = { [sortBy]: sortOrder };
    }

    // Fetch wallets with pagination
    const [wallets, total] = await Promise.all([
      prisma.smartWallet.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
      }),
      prisma.smartWallet.count({ where }),
    ]);

    // Get last trade timestamp for each wallet using aggregation
    if (wallets.length > 0) {
      const walletIds = wallets.map(w => w.id);
      
      try {
        // Aggregate max timestamp per wallet
        const lastTrades = await prisma.trade.groupBy({
          by: ['walletId'],
          where: {
            walletId: { in: walletIds },
          },
          _max: {
            timestamp: true,
          },
        });

        const lastTradeMap = new Map<string, Date | null>();
        for (const row of lastTrades) {
          lastTradeMap.set(row.walletId, row._max.timestamp);
        }

        // Attach lastTradeTimestamp to each wallet
        wallets.forEach((wallet: any) => {
          const lastTimestamp = lastTradeMap.get(wallet.id);
          wallet.lastTradeTimestamp = lastTimestamp ? lastTimestamp.toISOString() : null;
        });
          } catch (error) {
        console.warn('⚠️ Error fetching last trade timestamps, continuing without:', error);
        wallets.forEach((wallet: any) => {
          wallet.lastTradeTimestamp = null;
        });
      }
    }

    // Map recentPnl30dUsd (DB) to recentPnl30dBase (SOL) for all wallets
    const mappedWallets = wallets.map((wallet: any) => ({
      ...wallet,
      recentPnl30dBase: wallet.recentPnl30dUsd ?? 0,
    }));

    return {
      wallets: mappedWallets,
      total,
      page,
      pageSize,
    };
  }

  async findById(id: string) {
    // Fetch wallet with recent trades and token info
    const wallet = await prisma.smartWallet.findUnique({
      where: { id },
      include: {
        trades: {
          take: 10,
          orderBy: { timestamp: 'desc' },
          include: {
            token: true,
          },
        },
      },
    });

    if (!wallet) {
      return null;
    }

    return {
      ...wallet,
      recentPnl30dBase: wallet.recentPnl30dUsd ?? 0,
    };
  }

  async findByAddress(address: string) {
    try {
      console.log(`🔍 SmartWalletRepository.findByAddress - Searching: ${address}`);
      
      const result = await prisma.smartWallet.findUnique({
        where: { address },
      });

      if (!result) {
          console.log(`✅ SmartWalletRepository.findByAddress - Found: no`);
        return null;
      }

      console.log(`✅ SmartWalletRepository.findByAddress - Found: yes`);
      return {
        ...result,
        recentPnl30dBase: result.recentPnl30dUsd ?? 0,
      };
    } catch (error: any) {
      console.error('❌ SmartWalletRepository.findByAddress - Error:', error?.message);
      throw error;
    }
  }

  async create(data: {
    address: string;
    label?: string;
    tags?: string[];
    twitterUrl?: string | null;
  }) {
    try {
      console.log('📝 SmartWalletRepository.create - Creating wallet:', data.address);
      
      const result = await prisma.smartWallet.create({
        data: {
          id: generateId(),
          address: data.address,
          label: data.label ?? null,
          tags: data.tags ?? [],
          twitterUrl: data.twitterUrl ?? null,
        },
      });

      console.log('✅ SmartWalletRepository.create - Wallet created:', result.id);
      return result;
    } catch (error: any) {
      console.error('❌ SmartWalletRepository.create - Error:');
      console.error('Error message:', error?.message);
      console.error('Error code:', error?.code);
      throw error;
    }
  }

  async update(id: string, data: Partial<{
    label: string | null;
    tags: string[];
    twitterUrl: string | null;
    score: number;
    enhancedScore: number;
    percentileRankWinRate: number;
    percentileRankRoi: number;
    positionDisciplineScore: number;
    timingIntelligenceScore: number;
    categorySpecializationBonus: number;
    marketRegime: string | null;
    totalTrades: number;
    winRate: number;
    avgRr: number;
    avgPnlPercent: number;
    pnlTotalBase: number;
    avgHoldingTimeMin: number;
    maxDrawdownPercent: number;
    recentPnl30dPercent: number;
    recentPnl30dUsd: number;
    advancedStats: Record<string, any> | null;
  }>) {
    // Validate advancedStats JSON
    const updateData = { ...data };
    if (updateData.advancedStats !== undefined && updateData.advancedStats !== null) {
      try {
        const jsonString = JSON.stringify(updateData.advancedStats);
        updateData.advancedStats = JSON.parse(jsonString) as any;
      } catch (error: any) {
        console.error('Error serializing advancedStats:', error);
        console.error('advancedStats value:', JSON.stringify(updateData.advancedStats, null, 2));
        updateData.advancedStats = null;
      }
    }

    const result = await prisma.smartWallet.update({
      where: { id },
      data: updateData as any,
    });

    return result;
  }

  async getAll(): Promise<Array<{ id: string; address: string; lastPumpfunTradeTimestamp: Date | null }>> {
    const wallets = await prisma.smartWallet.findMany({
      select: {
        id: true,
        address: true,
        lastPumpfunTradeTimestamp: true,
      },
    });

    return wallets;
  }

  async getAllAddresses() {
    const wallets = await prisma.smartWallet.findMany({
      select: { address: true },
    });

    return wallets.map(w => w.address);
  }

  /**
   * Batch create wallets
   * Returns created wallets and errors
   */
  async createBatch(wallets: Array<{
    address: string;
    label?: string | null;
    tags?: string[];
    twitterUrl?: string | null;
  }>) {
    if (wallets.length === 0) {
      return { created: [], errors: [] };
    }

    // Remove duplicates from input (keep first occurrence)
    const seenAddresses = new Set<string>();
    const uniqueWallets = wallets.filter(w => {
      if (seenAddresses.has(w.address)) {
        return false;
      }
      seenAddresses.add(w.address);
      return true;
    });

    // Check which wallets already exist
    const addresses = uniqueWallets.map(w => w.address);
    const existing = await prisma.smartWallet.findMany({
      where: {
        address: { in: addresses },
      },
      select: { address: true },
    });

    const existingAddresses = new Set(existing.map(w => w.address));
    const walletsToCreate = uniqueWallets.filter(w => !existingAddresses.has(w.address));

    if (walletsToCreate.length === 0) {
      return {
        created: [],
        errors: uniqueWallets.map(w => ({
          address: w.address,
          error: 'Wallet already exists',
        })),
      };
    }

    // Prepare data for batch insert
    const dataToInsert = walletsToCreate.map(w => ({
      id: generateId(),
      address: w.address,
      label: w.label ?? null,
      tags: w.tags ?? [],
      twitterUrl: w.twitterUrl ?? null,
    }));

    try {
      // Batch insert
      const result = await prisma.smartWallet.createMany({
        data: dataToInsert,
        skipDuplicates: true,
      });

      // Fetch created wallets to return full records
      const created = await prisma.smartWallet.findMany({
        where: {
          address: { in: walletsToCreate.map(w => w.address) },
        },
      });

      // Prepare errors for existing wallets
      const errors = uniqueWallets
        .filter(w => existingAddresses.has(w.address))
        .map(w => ({
          address: w.address,
          error: 'Wallet already exists',
        }));

      return {
        created,
        errors,
      };
    } catch (error: any) {
      // If batch insert fails, try individual inserts
      if (error.code === 'P2002') {
        console.warn('⚠️  Duplicate key error during batch insert, trying individual inserts...');
        const createdWallets: any[] = [];
        const errorWallets: Array<{ address: string; error: string }> = [];

        for (const wallet of walletsToCreate) {
          try {
            const singleCreated = await prisma.smartWallet.create({
              data: {
                id: generateId(),
                address: wallet.address,
                label: wallet.label ?? null,
                tags: wallet.tags ?? [],
                twitterUrl: wallet.twitterUrl ?? null,
              },
            });
            createdWallets.push(singleCreated);
          } catch (err: any) {
            if (err.code === 'P2002') {
                errorWallets.push({
                  address: wallet.address,
                  error: 'Wallet already exists',
    });
              } else {
                errorWallets.push({
                  address: wallet.address,
                error: err.message || 'Unknown error',
                });
            }
          }
        }

        // Prepare errors for existing wallets
        const existingErrors = uniqueWallets
          .filter(w => existingAddresses.has(w.address))
          .map(w => ({
            address: w.address,
            error: 'Wallet already exists',
          }));

        return {
          created: createdWallets,
          errors: [...existingErrors, ...errorWallets],
        };
      }
      throw new Error(`Failed to create wallets: ${error.message}`);
    }
  }

  async updateLastPumpfunTimestamp(walletId: string, timestamp: Date): Promise<void> {
    await prisma.smartWallet.update({
      where: { id: walletId },
      data: { lastPumpfunTradeTimestamp: timestamp },
    });
  }

  async delete(walletId: string): Promise<void> {
    await prisma.smartWallet.delete({
      where: { id: walletId },
    });
  }
}
