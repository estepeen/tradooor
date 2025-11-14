import { prisma } from '@solbot/db';
import type { Prisma } from '@solbot/db';

export class SmartWalletRepository {
  async findAll(params?: {
    page?: number;
    pageSize?: number;
    minScore?: number;
    tags?: string[];
    search?: string;
    sortBy?: 'score' | 'winRate' | 'recentPnl30dPercent';
    sortOrder?: 'asc' | 'desc';
  }) {
    const page = params?.page ?? 1;
    const pageSize = params?.pageSize ?? 50;
    const skip = (page - 1) * pageSize;

    const where: Prisma.SmartWalletWhereInput = {};

    if (params?.minScore !== undefined) {
      where.score = { gte: params.minScore };
    }

    if (params?.tags && params.tags.length > 0) {
      where.tags = { hasSome: params.tags };
    }

    if (params?.search) {
      where.OR = [
        { address: { contains: params.search, mode: 'insensitive' } },
        { label: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const orderBy: Prisma.SmartWalletOrderByWithRelationInput = {};
    if (params?.sortBy) {
      orderBy[params.sortBy] = params.sortOrder ?? 'desc';
    } else {
      orderBy.score = 'desc';
    }

    const [wallets, total] = await Promise.all([
      prisma.smartWallet.findMany({
        where,
        skip,
        take: pageSize,
        orderBy,
      }),
      prisma.smartWallet.count({ where }),
    ]);

    return {
      wallets,
      total,
      page,
      pageSize,
    };
  }

  async findById(id: string) {
    return prisma.smartWallet.findUnique({
      where: { id },
      include: {
        trades: {
          take: 10,
          orderBy: { timestamp: 'desc' },
          include: { token: true },
        },
      },
    });
  }

  async findByAddress(address: string) {
    try {
      console.log(`🔍 SmartWalletRepository.findByAddress - Searching: ${address}`);
      const result = await prisma.smartWallet.findUnique({
        where: { address },
      });
      console.log(`✅ SmartWalletRepository.findByAddress - Found: ${result ? 'yes' : 'no'}`);
      return result;
    } catch (error: any) {
      console.error('❌ SmartWalletRepository.findByAddress - Error:', error?.message);
      throw error;
    }
  }

  async create(data: {
    address: string;
    label?: string;
    tags?: string[];
  }) {
    try {
      console.log('📝 SmartWalletRepository.create - Creating wallet:', data.address);
      const result = await prisma.smartWallet.create({
        data: {
          address: data.address,
          label: data.label ?? null,
          tags: data.tags ?? [],
        },
      });
      console.log('✅ SmartWalletRepository.create - Wallet created:', result.id);
      return result;
    } catch (error: any) {
      console.error('❌ SmartWalletRepository.create - Error:');
      console.error('Error message:', error?.message);
      console.error('Error code:', error?.code);
      console.error('Error meta:', error?.meta);
      throw error;
    }
  }

  async update(id: string, data: Partial<{
    label: string | null;
    tags: string[];
    score: number;
    totalTrades: number;
    winRate: number;
    avgRr: number;
    avgPnlPercent: number;
    pnlTotalBase: number;
    avgHoldingTimeMin: number;
    maxDrawdownPercent: number;
    recentPnl30dPercent: number;
  }>) {
    return prisma.smartWallet.update({
      where: { id },
      data,
    });
  }

  async getAllAddresses() {
    const wallets = await prisma.smartWallet.findMany({
      select: { address: true },
    });
    return wallets.map(w => w.address);
  }
}

