// Shared types between backend and frontend

export type TradeSide = 'buy' | 'sell' | 'add' | 'remove';

export interface SmartWalletRollingStats {
  realizedPnlUsd: number;
  realizedRoiPercent: number;
  winRate: number;
  medianTradeRoiPercent: number;
  percentile5TradeRoiPercent: number;
  percentile95TradeRoiPercent: number;
  maxDrawdownPercent: number;
  volatilityPercent: number;
  medianHoldMinutesWinners: number;
  medianHoldMinutesLosers: number;
  numClosedTrades: number;
  totalVolumeUsd: number;
  avgTradeSizeUsd: number;
}

export interface SmartWalletBehaviourStats {
  shareLowLiquidity: number;
  shareNewTokens: number;
  avgLiquidityUsd: number;
  sampleTrades: number;
}

export interface SmartWalletScoreBreakdown {
  profitabilityScore: number;
  consistencyScore: number;
  riskScore: number;
  behaviourScore: number;
  sampleFactor: number;
  walletScoreRaw: number;
  smartScore: number;
  legacyScore?: number;
}

export interface SmartWalletAdvancedStats {
  profitFactor?: number;
  bestTrade?: {
    pnlPercent: number;
    pnlBase: number;
    tokenId: string;
  };
  worstTrade?: {
    pnlPercent: number;
    pnlBase: number;
    tokenId: string;
  };
  largestWin?: {
    pnlPercent: number;
    pnlBase: number;
    tokenId: string;
  } | null;
  largestLoss?: {
    pnlPercent: number;
    pnlBase: number;
    tokenId: string;
  } | null;
  avgWin?: number;
  avgLoss?: number;
  maxWinStreak?: number;
  maxLossStreak?: number;
  tokenStats?: Array<{
    tokenId: string;
    count: number;
    totalPnl: number;
    wins: number;
    losses: number;
    winRate: number;
  }>;
  dexStats?: Array<{
    dex: string;
    count: number;
    totalPnl: number;
  }>;
  rolling?: Record<string, SmartWalletRollingStats>;
  behaviour?: SmartWalletBehaviourStats;
  scoreBreakdown?: SmartWalletScoreBreakdown;
}

export interface SmartWallet {
  id: string;
  address: string;
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
  recentPnl30dUsd?: number;
  lastTradeTimestamp?: Date | null;
  advancedStats?: SmartWalletAdvancedStats | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Token {
  id: string;
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  firstSeenAt: Date;
  updatedAt: Date;
}

export interface Trade {
  id: string;
  txSignature: string;
  walletId: string;
  tokenId: string;
  side: TradeSide;
  amountToken: number;
  amountBase: number;
  priceBasePerToken: number;
  timestamp: Date;
  dex: string;
  positionId: string | null;
  meta: Record<string, any> | null;
  valueUsd?: number | null;
  pnlUsd?: number | null;
  pnlPercent?: number | null;
  positionChangePercent?: number | null;
  token?: Token | null;
  wallet?: SmartWallet | null;
  features?: TradeFeature | null;
}

export interface TradeFeature {
  id: string;
  tradeId: string;
  walletId: string;
  tokenId: string;
  sizeToken?: number | null;
  sizeUsd?: number | null;
  priceUsd?: number | null;
  slippageBps?: number | null;
  dex?: string | null;
  txTimestamp?: Date | null;
  positionSizeBeforeToken?: number | null;
  positionSizeBeforeUsd?: number | null;
  positionSizeAfterToken?: number | null;
  positionSizeAfterUsd?: number | null;
  positionSizeChangeMultiplier?: number | null;
  avgEntryPriceBeforeUsd?: number | null;
  avgEntryPriceAfterUsd?: number | null;
  realizedPnlUsd?: number | null;
  realizedPnlPercent?: number | null;
  holdTimeSeconds?: number | null;
  tokenAgeSeconds?: number | null;
  liquidityUsd?: number | null;
  volume1hUsd?: number | null;
  volume24hUsd?: number | null;
  fdvUsd?: number | null;
  trend5mPercent?: number | null;
  trend30mPercent?: number | null;
  solPriceUsd?: number | null;
  hourOfDay?: number | null;
  dayOfWeek?: number | null;
  baseTokenSymbol?: string | null;
  meta?: Record<string, any> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SmartWalletMetricsHistory {
  id: string;
  walletId: string;
  timestamp: Date;
  score: number;
  totalTrades: number;
  winRate: number;
  avgRr: number;
  avgPnlPercent: number;
  pnlTotalBase: number;
  avgHoldingTimeMin: number;
  maxDrawdownPercent: number;
  recentPnl30dPercent: number;
}

export interface TokenMarketSnapshot {
  id: string;
  tokenId: string;
  timestamp: Date;
  price: number;
  liquidity: number;
  volume1m: number;
  volume5m: number;
  holdersCount: number | null;
  smartWalletHolders: number;
}

// API Response types
export interface SmartWalletListResponse {
  wallets: SmartWallet[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TradeListResponse {
  trades: Trade[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MetricsHistoryResponse {
  metrics: SmartWalletMetricsHistory[];
}

