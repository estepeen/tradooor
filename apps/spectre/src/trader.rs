use anyhow::{anyhow, Result};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    signature::{Keypair, Signer},
    transaction::VersionedTransaction,
};
use std::sync::Arc;
use tracing::{info, warn, error};

use crate::config::Config;
use crate::jupiter::JupiterClient;
use crate::jito::JitoClient;
use crate::pumpfun_trade::PumpfunTrader;
use crate::position::{Position, PositionManager, ExitReason};
use crate::redis::{SpectreSignal, SpectrePreSignal, TradeResult};

use std::collections::HashMap;
use tokio::sync::RwLock;

/// Prepared transaction ready for immediate execution
#[derive(Debug, Clone)]
pub struct PreparedTx {
    pub token_mint: String,
    pub token_symbol: String,
    pub tx_bytes: Vec<u8>,
    pub created_at: std::time::Instant,
    pub market_cap_usd: Option<f64>,
    pub entry_price_usd: Option<f64>,
}

/// Cache for prepared transactions (from pre-signals)
/// Expires after 60 seconds to avoid stale transactions
pub struct PreparedTxCache {
    cache: RwLock<HashMap<String, PreparedTx>>,
    expiry_secs: u64,
}

impl PreparedTxCache {
    pub fn new(expiry_secs: u64) -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            expiry_secs,
        }
    }

    pub async fn insert(&self, token_mint: String, prepared: PreparedTx) {
        let mut cache = self.cache.write().await;
        info!(
            "⚡ TX prepared for {} ({}) - ready for fast execution",
            prepared.token_symbol,
            &token_mint[..16.min(token_mint.len())]
        );
        cache.insert(token_mint, prepared);
    }

    pub async fn get(&self, token_mint: &str) -> Option<PreparedTx> {
        let cache = self.cache.read().await;
        if let Some(prepared) = cache.get(token_mint) {
            // Check if expired
            if prepared.created_at.elapsed().as_secs() < self.expiry_secs {
                return Some(prepared.clone());
            }
        }
        None
    }

    pub async fn remove(&self, token_mint: &str) {
        let mut cache = self.cache.write().await;
        cache.remove(token_mint);
    }

    /// Clean up expired entries
    pub async fn cleanup_expired(&self) {
        let mut cache = self.cache.write().await;
        let expiry = self.expiry_secs;
        cache.retain(|_, v| v.created_at.elapsed().as_secs() < expiry);
    }
}

pub struct SpectreTrader {
    config: Config,
    rpc_client: Arc<RpcClient>,
    jupiter: JupiterClient,
    jito: JitoClient,
    pumpfun: PumpfunTrader,
    position_manager: PositionManager,
    prepared_tx_cache: PreparedTxCache,
}

impl SpectreTrader {
    pub fn new(config: Config) -> Self {
        let rpc_client = Arc::new(RpcClient::new_with_commitment(
            config.rpc_url.clone(),
            CommitmentConfig::confirmed(),
        ));

        Self {
            jupiter: JupiterClient::with_api_key(config.jupiter_api_key.clone()),
            jito: JitoClient::new(&config.jito_block_engine_url),
            pumpfun: PumpfunTrader::new(),
            position_manager: PositionManager::new(),
            prepared_tx_cache: PreparedTxCache::new(60), // 60 second expiry
            config,
            rpc_client,
        }
    }

    /// Prepare TX for a pre-signal (after 1st wallet buy)
    /// This allows us to execute immediately when 2nd wallet confirms
    pub async fn prepare_tx_for_presignal(&self, pre_signal: &SpectrePreSignal) {
        let token_mint = &pre_signal.token_mint;
        let token_symbol = &pre_signal.token_symbol;

        // Check if we already have a position (shouldn't prepare if we do)
        if self.position_manager.has_position(token_mint).await {
            warn!("⚠️ Already have position in {}, skipping TX preparation", token_symbol);
            return;
        }

        // Get buy transaction from PumpPortal
        let slippage_percent = (self.config.slippage_bps / 100) as u16;
        let priority_fee_sol = self.config.jito_tip_lamports as f64 / 1e9;

        match self.pumpfun.get_buy_transaction(
            &self.config.wallet_pubkey().to_string(),
            token_mint,
            self.config.trade_amount_sol,
            slippage_percent,
            priority_fee_sol,
        ).await {
            Ok(tx_bytes) => {
                let prepared = PreparedTx {
                    token_mint: token_mint.clone(),
                    token_symbol: token_symbol.clone(),
                    tx_bytes,
                    created_at: std::time::Instant::now(),
                    market_cap_usd: pre_signal.market_cap_usd,
                    entry_price_usd: pre_signal.entry_price_usd,
                };
                self.prepared_tx_cache.insert(token_mint.clone(), prepared).await;
            }
            Err(e) => {
                warn!("⚠️ Failed to prepare TX for {}: {}", token_symbol, e);
            }
        }
    }

    /// Get prepared TX cache reference
    pub fn prepared_tx_cache(&self) -> &PreparedTxCache {
        &self.prepared_tx_cache
    }

    /// Execute buy order for a signal with retry logic
    /// Routes NINJA signals to pump.fun, CONSENSUS signals to Jupiter
    pub async fn execute_buy(&self, signal: &SpectreSignal) -> Result<TradeResult> {
        let token_mint = &signal.token_mint;
        let token_symbol = &signal.token_symbol;

        // Check if we already have a position
        if self.position_manager.has_position(token_mint).await {
            warn!("⚠️ Already have position in {}, skipping", token_symbol);
            return Ok(self.create_error_result(signal, "Already have position", 1, None));
        }

        // Route based on signal type:
        // - NINJA (micro-cap $5K-$20K) -> pump.fun bonding curve (more reliable)
        // - CONSENSUS ($20K+) -> Jupiter (token likely graduated to Raydium)
        let is_ninja = signal.signal_type.to_lowercase() == "ninja";

        info!(
            "👻 Executing BUY via {}: {} ({}) - MCap: ${:.0}",
            if is_ninja { "PUMP.FUN" } else { "JUPITER" },
            token_symbol,
            token_mint,
            signal.market_cap_usd.unwrap_or(0.0)
        );

        if is_ninja {
            self.execute_buy_pumpfun(signal).await
        } else {
            self.execute_buy_jupiter(signal).await
        }
    }

    /// Execute buy via pump.fun bonding curve (for NINJA signals)
    /// Uses prepared TX from cache if available (Fast Confirm optimization)
    async fn execute_buy_pumpfun(&self, signal: &SpectreSignal) -> Result<TradeResult> {
        const MAX_ATTEMPTS: u32 = 2;

        let token_mint = &signal.token_mint;
        let token_symbol = &signal.token_symbol;

        // ⚡ FAST CONFIRM: Check if we have a prepared TX from pre-signal
        let prepared_tx = self.prepared_tx_cache.get(token_mint).await;
        let used_prepared = prepared_tx.is_some();

        if used_prepared {
            info!("⚡ Using PREPARED TX for {} (Fast Confirm)", token_symbol);
        }

        for attempt in 1..=MAX_ATTEMPTS {
            let start = std::time::Instant::now();

            // 1. Get transaction - from cache or PumpPortal
            let tx_bytes = if let Some(ref prepared) = prepared_tx {
                if attempt == 1 {
                    // Use prepared TX on first attempt
                    prepared.tx_bytes.clone()
                } else {
                    // Get fresh TX on retry (prepared might be stale)
                    self.get_fresh_pumpfun_tx(token_mint).await?
                }
            } else {
                // No prepared TX, get fresh one
                match self.get_fresh_pumpfun_tx(token_mint).await {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        error!("❌ [Attempt {}/{}] PumpPortal buy failed: {}", attempt, MAX_ATTEMPTS, e);
                        if attempt < MAX_ATTEMPTS {
                            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                            continue;
                        }
                        return Ok(self.create_error_result(signal, &format!("PumpPortal failed: {}", e), attempt, None));
                    }
                }
            };

            // Remove from cache after use (regardless of success)
            if used_prepared {
                self.prepared_tx_cache.remove(token_mint).await;
            }

            // 2. Sign transaction
            let signed_tx = match self.pumpfun.sign_transaction(&tx_bytes, &self.config.wallet) {
                Ok(tx) => tx,
                Err(e) => {
                    error!("❌ [Attempt {}/{}] Failed to sign TX: {}", attempt, MAX_ATTEMPTS, e);
                    if attempt < MAX_ATTEMPTS {
                        continue;
                    }
                    return Ok(self.create_error_result(signal, &format!("Sign failed: {}", e), attempt, None));
                }
            };

            // 3. Send via Jito bundle for MEV protection
            let tx_sig = match self.jito.send_bundle(&signed_tx).await {
                Ok(id) => id,
                Err(e) => {
                    warn!("⚠️ [Attempt {}/{}] Jito bundle failed, falling back to RPC: {}", attempt, MAX_ATTEMPTS, e);
                    match self.rpc_client.send_and_confirm_transaction(&signed_tx).await {
                        Ok(sig) => sig.to_string(),
                        Err(rpc_e) => {
                            error!("❌ [Attempt {}/{}] RPC also failed: {}", attempt, MAX_ATTEMPTS, rpc_e);
                            if attempt < MAX_ATTEMPTS {
                                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                                continue;
                            }
                            return Ok(self.create_error_result(signal, &format!("TX failed: {}", rpc_e), attempt, None));
                        }
                    }
                }
            };

            let elapsed = start.elapsed();

            // Use signal price as entry (we don't have exact quote from pump.fun)
            let entry_price = signal.entry_price_usd.unwrap_or(0.0);

            // Estimate tokens received (we'll update from on-chain later if needed)
            // For now, estimate from market cap and SOL invested
            let estimated_tokens = if entry_price > 0.0 {
                ((self.config.trade_amount_sol * 200.0) / entry_price) as u64 // Rough SOL price estimate
            } else {
                0
            };

            // Create position for SL/TP monitoring (mark as pump.fun position)
            let position = Position::new(
                token_mint.clone(),
                token_symbol.clone(),
                entry_price,
                estimated_tokens,
                self.config.trade_amount_sol,
                signal.stop_loss_percent,
                signal.take_profit_percent,
                tx_sig.clone(),
                true, // is_pumpfun = true
            );
            self.position_manager.add_position(position).await;

            info!(
                "✅ PUMP.FUN BUY executed (attempt {}): ~{} tokens for {} SOL (took: {:?})",
                attempt,
                estimated_tokens,
                self.config.trade_amount_sol,
                elapsed
            );

            return Ok(TradeResult {
                success: true,
                token_mint: token_mint.clone(),
                token_symbol: token_symbol.clone(),
                action: "buy".to_string(),
                amount_sol: self.config.trade_amount_sol,
                amount_tokens: Some(estimated_tokens as f64),
                price_per_token: Some(entry_price),
                tx_signature: Some(tx_sig),
                error: None,
                latency_ms: elapsed.as_millis() as u64,
                timestamp: chrono::Utc::now().to_rfc3339(),
                signal_type: Some(signal.signal_type.clone()),
                signal_strength: Some(signal.strength.clone()),
                market_cap_usd: signal.market_cap_usd,
                liquidity_usd: signal.liquidity_usd,
                entry_price_usd: signal.entry_price_usd,
                stop_loss_percent: Some(signal.stop_loss_percent),
                take_profit_percent: Some(signal.take_profit_percent),
                trigger_wallets: Some(signal.wallets.clone()),
                attempt_number: attempt,
                price_at_signal: signal.entry_price_usd,
                price_at_trade: signal.entry_price_usd,
                price_change_percent: Some(0.0),
                signal_timestamp: Some(signal.timestamp.clone()),
            });
        }

        Ok(self.create_error_result(signal, "Max attempts exhausted", MAX_ATTEMPTS, None))
    }

    /// Execute buy via Jupiter (for CONSENSUS signals - graduated tokens)
    async fn execute_buy_jupiter(&self, signal: &SpectreSignal) -> Result<TradeResult> {
        const MAX_ATTEMPTS: u32 = 2;
        const MAX_PRICE_CHANGE_PERCENT: f64 = 30.0;

        let token_mint = &signal.token_mint;
        let token_symbol = &signal.token_symbol;
        let signal_price = signal.entry_price_usd;

        // Try up to MAX_ATTEMPTS times
        for attempt in 1..=MAX_ATTEMPTS {
            let start = std::time::Instant::now();

            // Convert SOL to lamports
            let amount_lamports = (self.config.trade_amount_sol * 1e9) as u64;

            // 1. Get quote from Jupiter
            let quote = match self.jupiter.get_quote(
                token_mint,
                amount_lamports,
                self.config.slippage_bps,
            ).await {
                Ok(q) => q,
                Err(e) => {
                    error!("❌ [Attempt {}/{}] Failed to get Jupiter quote: {}", attempt, MAX_ATTEMPTS, e);
                    if attempt < MAX_ATTEMPTS {
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                        continue;
                    }
                    return Ok(self.create_error_result(signal, &format!("Quote failed: {}", e), attempt, None));
                }
            };

            let out_amount: u64 = quote.out_amount.parse().unwrap_or(0);

            // Calculate current price from quote (SOL per token)
            let current_price = if out_amount > 0 {
                Some(self.config.trade_amount_sol / (out_amount as f64))
            } else {
                None
            };

            // Check price change from signal (if we have both prices)
            let price_change_percent = match (signal_price, current_price) {
                (Some(signal_p), Some(current_p)) if signal_p > 0.0 => {
                    let change = ((current_p - signal_p) / signal_p) * 100.0;
                    Some(change)
                }
                _ => None
            };

            // Skip if price jumped too much
            if let Some(change) = price_change_percent {
                if change > MAX_PRICE_CHANGE_PERCENT {
                    warn!(
                        "⚠️ Price jumped {:.1}% since signal (max {}%), skipping {}",
                        change, MAX_PRICE_CHANGE_PERCENT, token_symbol
                    );
                    return Ok(TradeResult {
                        success: false,
                        token_mint: token_mint.clone(),
                        token_symbol: token_symbol.clone(),
                        action: "buy".to_string(),
                        amount_sol: self.config.trade_amount_sol,
                        amount_tokens: None,
                        price_per_token: current_price,
                        tx_signature: None,
                        error: Some(format!("Price jumped {:.1}% > {}% max", change, MAX_PRICE_CHANGE_PERCENT)),
                        latency_ms: start.elapsed().as_millis() as u64,
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        signal_type: Some(signal.signal_type.clone()),
                        signal_strength: Some(signal.strength.clone()),
                        market_cap_usd: signal.market_cap_usd,
                        liquidity_usd: signal.liquidity_usd,
                        entry_price_usd: signal.entry_price_usd,
                        stop_loss_percent: Some(signal.stop_loss_percent),
                        take_profit_percent: Some(signal.take_profit_percent),
                        trigger_wallets: Some(signal.wallets.clone()),
                        attempt_number: attempt,
                        price_at_signal: signal_price,
                        price_at_trade: current_price,
                        price_change_percent,
                        signal_timestamp: Some(signal.timestamp.clone()),
                    });
                }
            }

            // 2. Get swap transaction AND blockhash in parallel for lower latency
            let rpc_client = self.rpc_client.clone();
            let wallet_pubkey = self.config.wallet_pubkey();
            let jito_tip = self.config.jito_tip_lamports;

            let blockhash_future = rpc_client.get_latest_blockhash();
            let swap_tx_future = self.jupiter.get_swap_transaction(
                quote,
                &wallet_pubkey,
                jito_tip,
            );

            let (blockhash_result, swap_tx_result) = tokio::join!(blockhash_future, swap_tx_future);

            let recent_blockhash = match blockhash_result {
                Ok(bh) => bh,
                Err(e) => {
                    error!("❌ [Attempt {}/{}] Failed to get blockhash: {}", attempt, MAX_ATTEMPTS, e);
                    if attempt < MAX_ATTEMPTS {
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                        continue;
                    }
                    return Ok(self.create_error_result(signal, &format!("Blockhash failed: {}", e), attempt, current_price));
                }
            };

            let (transaction, _last_valid_block) = match swap_tx_result {
                Ok(tx) => tx,
                Err(e) => {
                    error!("❌ [Attempt {}/{}] Failed to get swap transaction: {}", attempt, MAX_ATTEMPTS, e);
                    if attempt < MAX_ATTEMPTS {
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                        continue;
                    }
                    return Ok(self.create_error_result(signal, &format!("Swap tx failed: {}", e), attempt, current_price));
                }
            };

            let signed_tx = self.sign_versioned_transaction(transaction, recent_blockhash)?;

            // 4. Send via Jito bundle for MEV protection
            let bundle_id = match self.jito.send_bundle(&signed_tx).await {
                Ok(id) => id,
                Err(e) => {
                    warn!("⚠️ [Attempt {}/{}] Jito bundle failed, falling back to RPC: {}", attempt, MAX_ATTEMPTS, e);
                    // Fallback to direct RPC submission
                    match self.rpc_client.send_and_confirm_transaction(&signed_tx).await {
                        Ok(sig) => sig.to_string(),
                        Err(e) => {
                            error!("❌ [Attempt {}/{}] Transaction failed: {}", attempt, MAX_ATTEMPTS, e);
                            if attempt < MAX_ATTEMPTS {
                                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                                continue;
                            }
                            return Ok(self.create_error_result(signal, &format!("TX failed: {}", e), attempt, current_price));
                        }
                    }
                }
            };

            let elapsed = start.elapsed();

            // Use actual trade price (from quote), not signal price
            // current_price = SOL amount / tokens received
            let actual_entry_price = current_price.unwrap_or_else(|| {
                // Fallback to signal price if we couldn't calculate
                signal.entry_price_usd.unwrap_or(0.0)
            });

            // 5. Create position for SL/TP monitoring (Jupiter = not pump.fun)
            let position = Position::new(
                token_mint.clone(),
                token_symbol.clone(),
                actual_entry_price,  // Use actual trade price!
                out_amount,
                self.config.trade_amount_sol,
                signal.stop_loss_percent,
                signal.take_profit_percent,
                bundle_id.clone(),
                false, // is_pumpfun = false (Jupiter)
            );
            self.position_manager.add_position(position).await;

            info!(
                "✅ BUY executed (attempt {}): {} tokens for {} SOL (took: {:?})",
                attempt,
                out_amount,
                self.config.trade_amount_sol,
                elapsed
            );

            return Ok(TradeResult {
                success: true,
                token_mint: token_mint.clone(),
                token_symbol: token_symbol.clone(),
                action: "buy".to_string(),
                amount_sol: self.config.trade_amount_sol,
                amount_tokens: Some(out_amount as f64),
                price_per_token: Some(actual_entry_price),
                tx_signature: Some(bundle_id),
                error: None,
                latency_ms: elapsed.as_millis() as u64,
                timestamp: chrono::Utc::now().to_rfc3339(),
                signal_type: Some(signal.signal_type.clone()),
                signal_strength: Some(signal.strength.clone()),
                market_cap_usd: signal.market_cap_usd,
                liquidity_usd: signal.liquidity_usd,
                entry_price_usd: signal.entry_price_usd,
                stop_loss_percent: Some(signal.stop_loss_percent),
                take_profit_percent: Some(signal.take_profit_percent),
                trigger_wallets: Some(signal.wallets.clone()),
                attempt_number: attempt,
                price_at_signal: signal_price,
                price_at_trade: current_price,
                price_change_percent,
                signal_timestamp: Some(signal.timestamp.clone()),
            });
        }

        // Should never reach here, but just in case
        Ok(self.create_error_result(signal, "Max attempts exhausted", MAX_ATTEMPTS, None))
    }

    /// Helper to get fresh TX from PumpPortal (used when no prepared TX or on retry)
    async fn get_fresh_pumpfun_tx(&self, token_mint: &str) -> Result<Vec<u8>> {
        let slippage_percent = (self.config.slippage_bps / 100) as u16;
        let priority_fee_sol = self.config.jito_tip_lamports as f64 / 1e9;

        self.pumpfun.get_buy_transaction(
            &self.config.wallet_pubkey().to_string(),
            token_mint,
            self.config.trade_amount_sol,
            slippage_percent,
            priority_fee_sol,
        ).await
    }

    /// Helper to create error TradeResult with all signal context
    fn create_error_result(&self, signal: &SpectreSignal, error: &str, attempt: u32, current_price: Option<f64>) -> TradeResult {
        TradeResult {
            success: false,
            token_mint: signal.token_mint.clone(),
            token_symbol: signal.token_symbol.clone(),
            action: "buy".to_string(),
            amount_sol: self.config.trade_amount_sol,
            amount_tokens: None,
            price_per_token: None,
            tx_signature: None,
            error: Some(error.to_string()),
            latency_ms: 0,
            timestamp: chrono::Utc::now().to_rfc3339(),
            signal_type: Some(signal.signal_type.clone()),
            signal_strength: Some(signal.strength.clone()),
            market_cap_usd: signal.market_cap_usd,
            liquidity_usd: signal.liquidity_usd,
            entry_price_usd: signal.entry_price_usd,
            stop_loss_percent: Some(signal.stop_loss_percent),
            take_profit_percent: Some(signal.take_profit_percent),
            trigger_wallets: Some(signal.wallets.clone()),
            attempt_number: attempt,
            price_at_signal: signal.entry_price_usd,
            price_at_trade: current_price,
            price_change_percent: None,
            signal_timestamp: Some(signal.timestamp.clone()),
        }
    }

    /// Execute sell order (SL/TP triggered) with retry logic
    /// Routes to pump.fun or Jupiter based on how position was opened
    pub async fn execute_sell(&self, token_mint: &str, reason: ExitReason) -> Result<TradeResult> {
        let position = match self.position_manager.get_position(token_mint).await {
            Some(p) => p,
            None => {
                return Err(anyhow!("No position found for {}", token_mint));
            }
        };

        info!(
            "🔴 Executing SELL via {} ({}): {} - {} tokens",
            if position.is_pumpfun { "PUMP.FUN" } else { "JUPITER" },
            reason,
            position.token_symbol,
            position.amount_tokens
        );

        if position.is_pumpfun {
            self.execute_sell_pumpfun(token_mint, &position, reason).await
        } else {
            self.execute_sell_jupiter(token_mint, &position, reason).await
        }
    }

    /// Execute sell via pump.fun bonding curve
    async fn execute_sell_pumpfun(&self, token_mint: &str, position: &Position, reason: ExitReason) -> Result<TradeResult> {
        const MAX_SELL_ATTEMPTS: u32 = 3;
        const RETRY_DELAY_MS: u64 = 500;

        for attempt in 1..=MAX_SELL_ATTEMPTS {
            let start = std::time::Instant::now();

            // Increase slippage on retries
            let slippage_percent = (self.config.slippage_bps / 100) as u16 + ((attempt - 1) * 5) as u16;
            let priority_fee_sol = self.config.jito_tip_lamports as f64 / 1e9;

            // 1. Get sell transaction from PumpPortal
            let tx_bytes = match self.pumpfun.get_sell_transaction(
                &self.config.wallet_pubkey().to_string(),
                token_mint,
                position.amount_tokens,
                slippage_percent,
                priority_fee_sol,
            ).await {
                Ok(bytes) => bytes,
                Err(e) => {
                    error!("❌ [Sell Attempt {}/{}] PumpPortal sell failed: {}", attempt, MAX_SELL_ATTEMPTS, e);
                    if attempt < MAX_SELL_ATTEMPTS {
                        tokio::time::sleep(tokio::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                        continue;
                    }
                    return Ok(TradeResult {
                        success: false,
                        token_mint: token_mint.to_string(),
                        token_symbol: position.token_symbol.clone(),
                        action: "sell".to_string(),
                        amount_sol: 0.0,
                        amount_tokens: Some(position.amount_tokens as f64),
                        price_per_token: None,
                        tx_signature: None,
                        error: Some(format!("PumpPortal sell failed: {}", e)),
                        latency_ms: start.elapsed().as_millis() as u64,
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        signal_type: None,
                        signal_strength: None,
                        market_cap_usd: None,
                        liquidity_usd: None,
                        entry_price_usd: Some(position.entry_price),
                        stop_loss_percent: Some(position.stop_loss_percent),
                        take_profit_percent: Some(position.take_profit_percent),
                        trigger_wallets: None,
                        attempt_number: attempt,
                        price_at_signal: None,
                        price_at_trade: None,
                        price_change_percent: None,
                        signal_timestamp: None,
                    });
                }
            };

            // 2. Sign transaction
            let signed_tx = match self.pumpfun.sign_transaction(&tx_bytes, &self.config.wallet) {
                Ok(tx) => tx,
                Err(e) => {
                    error!("❌ [Sell Attempt {}/{}] Failed to sign TX: {}", attempt, MAX_SELL_ATTEMPTS, e);
                    if attempt < MAX_SELL_ATTEMPTS {
                        continue;
                    }
                    return Ok(TradeResult {
                        success: false,
                        token_mint: token_mint.to_string(),
                        token_symbol: position.token_symbol.clone(),
                        action: "sell".to_string(),
                        amount_sol: 0.0,
                        amount_tokens: Some(position.amount_tokens as f64),
                        price_per_token: None,
                        tx_signature: None,
                        error: Some(format!("Sign failed: {}", e)),
                        latency_ms: start.elapsed().as_millis() as u64,
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        signal_type: None,
                        signal_strength: None,
                        market_cap_usd: None,
                        liquidity_usd: None,
                        entry_price_usd: Some(position.entry_price),
                        stop_loss_percent: Some(position.stop_loss_percent),
                        take_profit_percent: Some(position.take_profit_percent),
                        trigger_wallets: None,
                        attempt_number: attempt,
                        price_at_signal: None,
                        price_at_trade: None,
                        price_change_percent: None,
                        signal_timestamp: None,
                    });
                }
            };

            // 3. Send via Jito bundle
            let tx_sig = match self.jito.send_bundle(&signed_tx).await {
                Ok(id) => id,
                Err(e) => {
                    warn!("⚠️ [Sell Attempt {}/{}] Jito failed, trying RPC: {}", attempt, MAX_SELL_ATTEMPTS, e);
                    match self.rpc_client.send_and_confirm_transaction(&signed_tx).await {
                        Ok(sig) => sig.to_string(),
                        Err(rpc_e) => {
                            error!("❌ [Sell Attempt {}/{}] RPC also failed: {}", attempt, MAX_SELL_ATTEMPTS, rpc_e);
                            if attempt < MAX_SELL_ATTEMPTS {
                                tokio::time::sleep(tokio::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                                continue;
                            }
                            return Ok(TradeResult {
                                success: false,
                                token_mint: token_mint.to_string(),
                                token_symbol: position.token_symbol.clone(),
                                action: "sell".to_string(),
                                amount_sol: 0.0,
                                amount_tokens: Some(position.amount_tokens as f64),
                                price_per_token: None,
                                tx_signature: None,
                                error: Some(format!("TX failed: {}", rpc_e)),
                                latency_ms: start.elapsed().as_millis() as u64,
                                timestamp: chrono::Utc::now().to_rfc3339(),
                                signal_type: None,
                                signal_strength: None,
                                market_cap_usd: None,
                                liquidity_usd: None,
                                entry_price_usd: Some(position.entry_price),
                                stop_loss_percent: Some(position.stop_loss_percent),
                                take_profit_percent: Some(position.take_profit_percent),
                                trigger_wallets: None,
                                attempt_number: attempt,
                                price_at_signal: None,
                                price_at_trade: None,
                                price_change_percent: None,
                                signal_timestamp: None,
                            });
                        }
                    }
                }
            };

            // SUCCESS!
            self.position_manager.remove_position(token_mint).await;

            let elapsed = start.elapsed();
            info!(
                "✅ PUMP.FUN SELL executed (attempt {}) ({}): {} tokens sold (took: {:?})",
                attempt,
                reason,
                position.amount_tokens,
                elapsed
            );

            return Ok(TradeResult {
                success: true,
                token_mint: token_mint.to_string(),
                token_symbol: position.token_symbol.clone(),
                action: "sell".to_string(),
                amount_sol: position.amount_sol_invested, // Approximate, we don't know exact return
                amount_tokens: Some(position.amount_tokens as f64),
                price_per_token: None,
                tx_signature: Some(tx_sig),
                error: None,
                latency_ms: elapsed.as_millis() as u64,
                timestamp: chrono::Utc::now().to_rfc3339(),
                signal_type: None,
                signal_strength: None,
                market_cap_usd: None,
                liquidity_usd: None,
                entry_price_usd: Some(position.entry_price),
                stop_loss_percent: Some(position.stop_loss_percent),
                take_profit_percent: Some(position.take_profit_percent),
                trigger_wallets: None,
                attempt_number: attempt,
                price_at_signal: None,
                price_at_trade: None,
                price_change_percent: None,
                signal_timestamp: None,
            });
        }

        Err(anyhow!("Pump.fun sell failed after max attempts"))
    }

    /// Execute sell via Jupiter (for graduated tokens)
    async fn execute_sell_jupiter(&self, token_mint: &str, position: &Position, reason: ExitReason) -> Result<TradeResult> {
        const MAX_SELL_ATTEMPTS: u32 = 5;
        const RETRY_DELAY_MS: u64 = 1000;

        let mut last_error: Option<String> = None;

        for attempt in 1..=MAX_SELL_ATTEMPTS {
            let start = std::time::Instant::now();

            // 1. Get sell quote with increasing slippage on retries
            let extra_slippage = 500 + (attempt - 1) * 200; // Start at 5%, add 2% per retry
            let quote = match self.jupiter.get_sell_quote(
                token_mint,
                position.amount_tokens,
                self.config.slippage_bps + extra_slippage as u16,
            ).await {
                Ok(q) => q,
                Err(e) => {
                    error!("❌ [Sell Attempt {}/{}] Failed to get quote: {}", attempt, MAX_SELL_ATTEMPTS, e);
                    last_error = Some(format!("Sell quote failed: {}", e));
                    if attempt < MAX_SELL_ATTEMPTS {
                        tokio::time::sleep(tokio::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                        continue;
                    }
                    // Final attempt failed
                    return Ok(TradeResult {
                        success: false,
                        token_mint: token_mint.to_string(),
                        token_symbol: position.token_symbol.clone(),
                        action: "sell".to_string(),
                        amount_sol: 0.0,
                        amount_tokens: Some(position.amount_tokens as f64),
                        price_per_token: None,
                        tx_signature: None,
                        error: last_error,
                        latency_ms: start.elapsed().as_millis() as u64,
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        signal_type: None,
                        signal_strength: None,
                        market_cap_usd: None,
                        liquidity_usd: None,
                        entry_price_usd: Some(position.entry_price),
                        stop_loss_percent: Some(position.stop_loss_percent),
                        take_profit_percent: Some(position.take_profit_percent),
                        trigger_wallets: None,
                        attempt_number: attempt,
                        price_at_signal: None,
                        price_at_trade: None,
                        price_change_percent: None,
                        signal_timestamp: None,
                    });
                }
            };

            let out_lamports: u64 = quote.out_amount.parse().unwrap_or(0);
            let out_sol = out_lamports as f64 / 1e9;

            // 2. Get swap transaction
            let (transaction, _) = match self.jupiter.get_swap_transaction(
                quote,
                &self.config.wallet_pubkey(),
                self.config.jito_tip_lamports,
            ).await {
                Ok(tx) => tx,
                Err(e) => {
                    error!("❌ [Sell Attempt {}/{}] Failed to get swap TX: {}", attempt, MAX_SELL_ATTEMPTS, e);
                    last_error = Some(format!("Swap TX failed: {}", e));
                    if attempt < MAX_SELL_ATTEMPTS {
                        tokio::time::sleep(tokio::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                        continue;
                    }
                    return Ok(TradeResult {
                        success: false,
                        token_mint: token_mint.to_string(),
                        token_symbol: position.token_symbol.clone(),
                        action: "sell".to_string(),
                        amount_sol: 0.0,
                        amount_tokens: Some(position.amount_tokens as f64),
                        price_per_token: None,
                        tx_signature: None,
                        error: last_error,
                        latency_ms: start.elapsed().as_millis() as u64,
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        signal_type: None,
                        signal_strength: None,
                        market_cap_usd: None,
                        liquidity_usd: None,
                        entry_price_usd: Some(position.entry_price),
                        stop_loss_percent: Some(position.stop_loss_percent),
                        take_profit_percent: Some(position.take_profit_percent),
                        trigger_wallets: None,
                        attempt_number: attempt,
                        price_at_signal: None,
                        price_at_trade: None,
                        price_change_percent: None,
                        signal_timestamp: None,
                    });
                }
            };

            // 3. Sign and send
            let recent_blockhash = match self.rpc_client.get_latest_blockhash().await {
                Ok(bh) => bh,
                Err(e) => {
                    error!("❌ [Sell Attempt {}/{}] Failed to get blockhash: {}", attempt, MAX_SELL_ATTEMPTS, e);
                    last_error = Some(format!("Blockhash failed: {}", e));
                    if attempt < MAX_SELL_ATTEMPTS {
                        tokio::time::sleep(tokio::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                        continue;
                    }
                    return Ok(TradeResult {
                        success: false,
                        token_mint: token_mint.to_string(),
                        token_symbol: position.token_symbol.clone(),
                        action: "sell".to_string(),
                        amount_sol: 0.0,
                        amount_tokens: Some(position.amount_tokens as f64),
                        price_per_token: None,
                        tx_signature: None,
                        error: last_error,
                        latency_ms: start.elapsed().as_millis() as u64,
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        signal_type: None,
                        signal_strength: None,
                        market_cap_usd: None,
                        liquidity_usd: None,
                        entry_price_usd: Some(position.entry_price),
                        stop_loss_percent: Some(position.stop_loss_percent),
                        take_profit_percent: Some(position.take_profit_percent),
                        trigger_wallets: None,
                        attempt_number: attempt,
                        price_at_signal: None,
                        price_at_trade: None,
                        price_change_percent: None,
                        signal_timestamp: None,
                    });
                }
            };

            let signed_tx = match self.sign_versioned_transaction(transaction, recent_blockhash) {
                Ok(tx) => tx,
                Err(e) => {
                    error!("❌ [Sell Attempt {}/{}] Failed to sign TX: {}", attempt, MAX_SELL_ATTEMPTS, e);
                    last_error = Some(format!("Sign failed: {}", e));
                    if attempt < MAX_SELL_ATTEMPTS {
                        tokio::time::sleep(tokio::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                        continue;
                    }
                    return Ok(TradeResult {
                        success: false,
                        token_mint: token_mint.to_string(),
                        token_symbol: position.token_symbol.clone(),
                        action: "sell".to_string(),
                        amount_sol: 0.0,
                        amount_tokens: Some(position.amount_tokens as f64),
                        price_per_token: None,
                        tx_signature: None,
                        error: last_error,
                        latency_ms: start.elapsed().as_millis() as u64,
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        signal_type: None,
                        signal_strength: None,
                        market_cap_usd: None,
                        liquidity_usd: None,
                        entry_price_usd: Some(position.entry_price),
                        stop_loss_percent: Some(position.stop_loss_percent),
                        take_profit_percent: Some(position.take_profit_percent),
                        trigger_wallets: None,
                        attempt_number: attempt,
                        price_at_signal: None,
                        price_at_trade: None,
                        price_change_percent: None,
                        signal_timestamp: None,
                    });
                }
            };

            // Try Jito first, then fallback to RPC
            let tx_sig = match self.jito.send_bundle(&signed_tx).await {
                Ok(id) => id,
                Err(jito_err) => {
                    warn!("⚠️ [Sell Attempt {}/{}] Jito failed, trying RPC: {}", attempt, MAX_SELL_ATTEMPTS, jito_err);
                    match self.rpc_client.send_and_confirm_transaction(&signed_tx).await {
                        Ok(sig) => sig.to_string(),
                        Err(rpc_err) => {
                            error!("❌ [Sell Attempt {}/{}] RPC also failed: {}", attempt, MAX_SELL_ATTEMPTS, rpc_err);
                            last_error = Some(format!("TX failed: Jito={}, RPC={}", jito_err, rpc_err));
                            if attempt < MAX_SELL_ATTEMPTS {
                                tokio::time::sleep(tokio::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                                continue;
                            }
                            return Ok(TradeResult {
                                success: false,
                                token_mint: token_mint.to_string(),
                                token_symbol: position.token_symbol.clone(),
                                action: "sell".to_string(),
                                amount_sol: 0.0,
                                amount_tokens: Some(position.amount_tokens as f64),
                                price_per_token: None,
                                tx_signature: None,
                                error: last_error,
                                latency_ms: start.elapsed().as_millis() as u64,
                                timestamp: chrono::Utc::now().to_rfc3339(),
                                signal_type: None,
                                signal_strength: None,
                                market_cap_usd: None,
                                liquidity_usd: None,
                                entry_price_usd: Some(position.entry_price),
                                stop_loss_percent: Some(position.stop_loss_percent),
                                take_profit_percent: Some(position.take_profit_percent),
                                trigger_wallets: None,
                                attempt_number: attempt,
                                price_at_signal: None,
                                price_at_trade: None,
                                price_change_percent: None,
                                signal_timestamp: None,
                            });
                        }
                    }
                }
            };

            // SUCCESS! Remove position and return
            self.position_manager.remove_position(token_mint).await;

            let elapsed = start.elapsed();
            let pnl_sol = out_sol - position.amount_sol_invested;
            let pnl_percent = (out_sol / position.amount_sol_invested - 1.0) * 100.0;

            info!(
                "✅ SELL executed (attempt {}) ({}): {} SOL received | PnL: {:.4} SOL ({:.1}%) | took: {:?}",
                attempt,
                reason,
                out_sol,
                pnl_sol,
                pnl_percent,
                elapsed
            );

            return Ok(TradeResult {
                success: true,
                token_mint: token_mint.to_string(),
                token_symbol: position.token_symbol.clone(),
                action: "sell".to_string(),
                amount_sol: out_sol,
                amount_tokens: Some(position.amount_tokens as f64),
                price_per_token: None,
                tx_signature: Some(tx_sig),
                error: None,
                latency_ms: elapsed.as_millis() as u64,
                timestamp: chrono::Utc::now().to_rfc3339(),
                signal_type: None,
                signal_strength: None,
                market_cap_usd: None,
                liquidity_usd: None,
                entry_price_usd: Some(position.entry_price),
                stop_loss_percent: Some(position.stop_loss_percent),
                take_profit_percent: Some(position.take_profit_percent),
                trigger_wallets: None,
                attempt_number: attempt,
                price_at_signal: None,
                price_at_trade: None,
                price_change_percent: None,
                signal_timestamp: None,
            });
        }

        // Should never reach here
        Err(anyhow!("Sell failed after {} attempts", MAX_SELL_ATTEMPTS))
    }

    /// Sign a versioned transaction
    fn sign_versioned_transaction(
        &self,
        mut transaction: VersionedTransaction,
        recent_blockhash: solana_sdk::hash::Hash,
    ) -> Result<VersionedTransaction> {
        // Update blockhash in the message
        match &mut transaction.message {
            solana_sdk::message::VersionedMessage::Legacy(msg) => {
                msg.recent_blockhash = recent_blockhash;
            }
            solana_sdk::message::VersionedMessage::V0(msg) => {
                msg.recent_blockhash = recent_blockhash;
            }
        }

        // Sign with wallet
        let message_data = transaction.message.serialize();
        let signature = self.config.wallet.sign_message(&message_data);

        // Find the signer index and update signature
        transaction.signatures[0] = signature;

        Ok(transaction)
    }

    /// Get position manager reference
    pub fn position_manager(&self) -> &PositionManager {
        &self.position_manager
    }

    /// Check wallet balance
    pub async fn get_balance(&self) -> Result<f64> {
        let balance = self.rpc_client.get_balance(&self.config.wallet_pubkey()).await?;
        Ok(balance as f64 / 1e9)
    }
}
