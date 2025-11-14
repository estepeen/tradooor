import { Connection, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';

dotenv.config();

/**
 * Solana Collector Service
 * 
 * Listens to on-chain transactions for tracked smart wallets and stores trades.
 * 
 * Datový tok:
 * 1. Načte seznam sledovaných adres z databáze (smart_wallets.address)
 * 2. Napojí se na Solana RPC/WebSocket
 * 3. Poslouchá odchozí/incoming transakce pro tyto adresy
 * 4. U swapů/DEX interakcí uloží záznam do trades tabulky
 * 
 * TODO: Implementovat plnou logiku parsování transakcí:
 * - Parse swap transactions (Jupiter, Raydium, Pump.fun, Orca, atd.)
 * - Extract token addresses, amounts, prices
 * - Identify DEX from transaction signature/program ID
 * - Handle different transaction formats
 * - Detekce buy vs sell
 * - Výpočet ceny per token
 */
export class SolanaCollectorService {
  private connection: Connection;
  private isRunning = false;
  private subscriptionIds: number[] = [];
  private processedSignatures = new Set<string>(); // Cache pro již zpracované transakce

  constructor(
    private smartWalletRepo: SmartWalletRepository,
    private tradeRepo: TradeRepository,
    private tokenRepo: TokenRepository
  ) {
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  /**
   * Start listening to transactions for all tracked wallets
   * 
   * Načte seznam sledovaných adres z databáze a začne poslouchat jejich transakce.
   */
  async start() {
    if (this.isRunning) {
      console.log('⚠️  Collector is already running');
      return;
    }

    // 1. Načti seznam sledovaných adres z databáze
    const addresses = await this.smartWalletRepo.getAllAddresses();
    if (addresses.length === 0) {
      console.log('⚠️  No wallets to track. Add wallets first via API.');
      return;
    }

    console.log(`🚀 Starting collector for ${addresses.length} wallets...`);

    const publicKeys = addresses.map(addr => {
      try {
        return new PublicKey(addr);
      } catch (error) {
        console.error(`❌ Invalid address: ${addr}`, error);
        return null;
      }
    }).filter((pk): pk is PublicKey => pk !== null);

    // 2. Napoj se na Solana RPC/WebSocket a poslouchej transakce
    // TODO: Implementovat WebSocket subscription pro real-time updates
    // Pro teď používáme polling přes account changes
    
    for (const publicKey of publicKeys) {
      try {
        // Subscribe to account changes - když se změní balance, znamená to pravděpodobně transakci
        const subscriptionId = this.connection.onAccountChange(
          publicKey,
          async (accountInfo, context) => {
            // 3. Když detekujeme změnu, načti a zpracuj transakce
            await this.processAccountChange(publicKey.toString(), accountInfo);
          },
          'confirmed'
        );
        this.subscriptionIds.push(subscriptionId);
      } catch (error) {
        console.error(`❌ Error subscribing to ${publicKey.toString()}:`, error);
      }
    }

    this.isRunning = true;
    console.log(`✅ Collector started - tracking ${publicKeys.length} wallets`);
    
    // Initial fetch - načti poslední transakce pro všechny walletky
    console.log('📥 Fetching recent transactions for all wallets...');
    for (const address of addresses) {
      try {
        await this.fetchRecentTransactions(address, 20); // Posledních 20 transakcí
      } catch (error) {
        console.error(`❌ Error fetching recent transactions for ${address}:`, error);
      }
    }
  }

  /**
   * Stop listening to transactions
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    // Odstraň všechny subscriptiony
    for (const subscriptionId of this.subscriptionIds) {
      try {
        this.connection.removeAccountChangeListener(subscriptionId);
      } catch (error) {
        console.error('Error removing listener:', error);
      }
    }
    this.subscriptionIds = [];

    this.isRunning = false;
    console.log('🛑 Collector stopped');
  }

  /**
   * Process account change and extract trades
   * 
   * Když detekujeme změnu na účtu, načteme poslední transakce a zpracujeme je.
   */
  private async processAccountChange(address: string, accountInfo: any) {
    try {
      await this.fetchRecentTransactions(address, 5); // Načti posledních 5 transakcí
    } catch (error) {
      console.error(`❌ Error processing account change for ${address}:`, error);
    }
  }

  /**
   * Fetch and process recent transactions for a wallet
   */
  private async fetchRecentTransactions(address: string, limit: number = 10) {
    try {
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(address),
        { limit }
      );

      for (const sigInfo of signatures) {
        // Skip if already processed
        if (this.processedSignatures.has(sigInfo.signature)) {
          continue;
        }

        // Check if we already have this trade in database
        // TODO: Implementovat kontrolu přes tradeRepo.findByTxSignature()
        // Pro teď používáme in-memory cache
        if (this.processedSignatures.has(sigInfo.signature)) {
          continue;
        }

        // Fetch full transaction
        const tx = await this.connection.getTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });

        if (tx && tx.blockTime) {
          await this.parseTransaction(address, sigInfo.signature, tx);
          this.processedSignatures.add(sigInfo.signature);
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (error) {
      console.error(`❌ Error fetching recent transactions for ${address}:`, error);
      throw error;
    }
  }

  /**
   * Parse transaction and extract trade information
   * 
   * TODO: Implementovat plnou logiku parsování pro různé DEXy:
   * 
   * 1. Identifikace DEXu/protocolu z instruction data:
   *    - Jupiter: Program ID, instruction format
   *    - Raydium: Program ID, swap instruction
   *    - Pump.fun: Program ID, specific instruction format
   *    - Orca: Program ID, swap instruction
   * 
   * 2. Parsování swap instructions:
   *    - Extrakce token addresses (mint addresses)
   *    - Extrakce amounts (token amount, base amount)
   *    - Výpočet ceny per token
   * 
   * 3. Detekce buy vs sell:
   *    - Analýza token flow (který token jde dovnitř/ven)
   *    - Porovnání s base assetem (SOL/USDC/USDT)
   * 
   * 4. Uložení do databáze:
   *    - Vytvoření/načtení tokenu
   *    - Vytvoření trade záznamu
   */
  private async parseTransaction(
    walletAddress: string,
    txSignature: string,
    transaction: any
  ) {
    try {
      // TODO: Implementovat parsování
      // Pro teď je to placeholder - struktura je připravena

      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        console.warn(`⚠️  Wallet not found in database: ${walletAddress}`);
        return;
      }

      // TODO: Analýza transaction.instructions pro identifikaci DEXu
      // TODO: Extrakce token addresses, amounts, prices
      // TODO: Detekce buy vs sell
      
      // Placeholder - struktura pro budoucí implementaci:
      /*
      const dex = this.identifyDEX(transaction);
      const swapData = this.extractSwapData(transaction, walletAddress);
      
      if (!swapData) {
        // Není swap transakce, skip
        return;
      }

      const token = await this.tokenRepo.findOrCreate({
        mintAddress: swapData.tokenMint,
        symbol: null, // Můžeš později načíst z metadata
      });

      await this.tradeRepo.create({
        txSignature,
        walletId: wallet.id,
        tokenId: token.id,
        side: swapData.side, // 'buy' | 'sell'
        amountToken: swapData.amountToken,
        amountBase: swapData.amountBase,
        priceBasePerToken: swapData.priceBasePerToken,
        timestamp: new Date(transaction.blockTime * 1000),
        dex: dex,
        meta: {
          // Doplňkové údaje
          slot: transaction.slot,
          fee: transaction.meta?.fee,
        },
      });

      console.log(`✅ Trade saved: ${txSignature} - ${swapData.side} ${swapData.amountToken} tokens`);
      */

      // Pro teď jen logujeme
      console.log(`📝 TODO: Parse transaction ${txSignature.substring(0, 8)}... for wallet ${walletAddress.substring(0, 8)}...`);
      
    } catch (error) {
      console.error(`❌ Error parsing transaction ${txSignature}:`, error);
    }
  }

  /**
   * TODO: Helper method - identifikace DEXu z transakce
   * 
   * Analyzuje transaction.instructions a identifikuje, který DEX byl použit.
   * 
   * @returns DEX identifier (např. 'jupiter', 'raydium', 'pumpfun', 'orca')
   */
  private identifyDEX(transaction: any): string {
    // TODO: Implementovat
    // Analyzuj transaction.instructions[].programId
    // Porovnej s known DEX program IDs
    
    // Known DEX Program IDs (příklady):
    // Jupiter: různé program IDs podle verze
    // Raydium: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
    // Pump.fun: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
    // Orca: 9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP
    
    return 'unknown';
  }

  /**
   * TODO: Helper method - extrakce swap dat z transakce
   * 
   * Parsuje transaction instructions a extrahuje swap data.
   * 
   * @returns Swap data nebo null pokud to není swap
   */
  private extractSwapData(transaction: any, walletAddress: string): {
    tokenMint: string;
    side: 'buy' | 'sell';
    amountToken: number;
    amountBase: number;
    priceBasePerToken: number;
  } | null {
    // TODO: Implementovat
    // Analyzuj transaction.instructions
    // Extrahuj token addresses, amounts
    // Urči buy vs sell
    // Vypočítej cenu
    
    return null;
  }

  /**
   * Manually fetch and process historical transactions for a wallet
   * Useful for backfilling data
   */
  async fetchHistoricalTransactions(walletAddress: string, limit = 100) {
    try {
      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        throw new Error(`Wallet not found: ${walletAddress}`);
      }

      const publicKey = new PublicKey(walletAddress);
      const signatures = await this.connection.getSignaturesForAddress(publicKey, {
        limit,
      });

      console.log(`Found ${signatures.length} transactions for ${walletAddress}`);

      for (const sigInfo of signatures) {
        const tx = await this.connection.getTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (tx) {
          await this.parseTransaction(walletAddress, sigInfo.signature, tx);
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`Error fetching historical transactions:`, error);
      throw error;
    }
  }
}
