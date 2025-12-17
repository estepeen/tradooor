import { prisma, generateId } from '../lib/prisma.js';

export class TokenRepository {
  async findByMintAddress(mintAddress: string) {
    try {
      const token = await prisma.token.findUnique({
        where: { mintAddress },
      });
      return token;
    } catch (error: any) {
      throw new Error(`Failed to fetch token: ${error.message}`);
    }
  }

  async findByMintAddresses(mintAddresses: string[]) {
    if (!mintAddresses.length) {
      return [];
    }

    try {
      const tokens = await prisma.token.findMany({
        where: {
          mintAddress: {
            in: mintAddresses,
          },
        },
      });
      return tokens;
    } catch (error: any) {
      throw new Error(`Failed to fetch tokens: ${error.message}`);
    }
  }

  async findOrCreate(data: {
    mintAddress: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    forceUpdate?: boolean;
  }) {
    const existing = await this.findByMintAddress(data.mintAddress);
    
    if (existing) {
      const shouldUpdate = data.forceUpdate || 
        !existing.symbol || 
        !existing.name || 
        data.symbol !== undefined || 
        data.name !== undefined || 
        data.decimals !== undefined;
        
      if (shouldUpdate) {
        const updateData: any = {};
        
        if (data.symbol !== undefined) {
          const existingSymbol = (existing.symbol || '').trim();
          const newSymbol = (data.symbol || '').trim();
          
          if (!existingSymbol || (newSymbol && newSymbol !== existingSymbol)) {
            updateData.symbol = data.symbol || null;
          }
        }
        
        if (data.name !== undefined) {
          const existingName = (existing.name || '').trim();
          const newName = (data.name || '').trim();
          
          if (!existingName || (newName && newName !== existingName)) {
            updateData.name = data.name || null;
          }
        }
        
        if (data.decimals !== undefined) {
          updateData.decimals = data.decimals;
        }
        
        if (Object.keys(updateData).length > 0) {
          try {
            const updated = await prisma.token.update({
              where: { id: existing.id },
              data: updateData,
            });
            return updated;
          } catch (error: any) {
            console.error(`Failed to update token ${existing.id}:`, error);
            return existing;
          }
        }
      }
      
      return existing;
    }

    try {
      const token = await prisma.token.create({
        data: {
          id: generateId(),
          mintAddress: data.mintAddress,
          symbol: data.symbol || null,
          name: data.name || null,
          decimals: data.decimals ?? 9,
        },
      });
      return token;
    } catch (error: any) {
      if (error.code === 'P2002') {
        return await this.findByMintAddress(data.mintAddress);
      }
      throw new Error(`Failed to create token: ${error.message}`);
    }
  }

  async findAll(params?: {
    page?: number;
    pageSize?: number;
    search?: string;
  }) {
    const page = params?.page ?? 1;
    const pageSize = params?.pageSize ?? 50;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    
    if (params?.search) {
      where.OR = [
        { symbol: { contains: params.search, mode: 'insensitive' } },
        { name: { contains: params.search, mode: 'insensitive' } },
        { mintAddress: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    try {
      const [tokens, total] = await Promise.all([
        prisma.token.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { firstSeenAt: 'desc' },
        }),
        prisma.token.count({ where }),
      ]);

      return {
        tokens,
        total,
        page,
        pageSize,
      };
    } catch (error: any) {
      throw new Error(`Failed to fetch tokens: ${error.message}`);
    }
  }
}
