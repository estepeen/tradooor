import { prisma } from '@solbot/db';

export class TokenRepository {
  async findByMintAddress(mintAddress: string) {
    return prisma.token.findUnique({
      where: { mintAddress },
    });
  }

  async findOrCreate(data: {
    mintAddress: string;
    symbol?: string;
    name?: string;
    decimals?: number;
  }) {
    const existing = await this.findByMintAddress(data.mintAddress);
    if (existing) {
      // Update if new data provided
      if (data.symbol || data.name) {
        return prisma.token.update({
          where: { mintAddress: data.mintAddress },
          data: {
            symbol: data.symbol ?? undefined,
            name: data.name ?? undefined,
          },
        });
      }
      return existing;
    }

    return prisma.token.create({
      data: {
        mintAddress: data.mintAddress,
        symbol: data.symbol ?? null,
        name: data.name ?? null,
        decimals: data.decimals ?? 9,
      },
    });
  }
}

