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
use crate::position::{Position, PositionManager, ExitReason};
use crate::redis::{SpectreSignal, TradeResult};

pub struct SpectreTrader {
    config: Config,
    rpc_client: Arc<RpcClient>,
    jupiter: JupiterClient,
    jito: JitoClient,
    position_manager: PositionManager,
}

impl SpectreTrader {
    pub fn new(config: Config) -> Self {
        let rpc_client = Arc::new(RpcClient::new_with_commitment(
            config.rpc_url.clone(),
            CommitmentConfig::confirmed(),
        ));

        Self {
            jupiter: JupiterClient::new(),
            jito: JitoClient::new(&config.jito_block_engine_url),
            position_manager: PositionManager::new(),
            config,
            rpc_client,
        }
    }

    /// Execute buy order for a signal with retry logic
    /// Max 2 attempts, skip if price jumped more than 30% from signal
    pub async fn execute_buy(&self, signal: &SpectreSignal) -> Result<TradeResult> {
        const MAX_ATTEMPTS: u32 = 2;
        const MAX_PRICE_CHANGE_PERCENT: f64 = 30.0;

        let token_mint = &signal.token_mint;
        let token_symbol = &signal.token_symbol;
        let signal_price = signal.entry_price_usd;

        // Check if we already have a position
        if self.position_manager.has_position(token_mint).await {
            warn!("⚠️ Already have position in {}, skipping", token_symbol);
            return Ok(self.create_error_result(signal, "Already have position", 1, None));
        }

        info!(
            "👻 Executing BUY: {} ({}) - MCap: ${:.0}",
            token_symbol,
            token_mint,
            signal.market_cap_usd.unwrap_or(0.0)
        );

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
                    });
                }
            }

            // 2. Get swap transaction
            let (transaction, _last_valid_block) = match self.jupiter.get_swap_transaction(
                quote,
                &self.config.wallet_pubkey(),
                self.config.jito_tip_lamports,
            ).await {
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

            // 3. Sign transaction
            let recent_blockhash = match self.rpc_client.get_latest_blockhash().await {
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
            let entry_price = signal.entry_price_usd.unwrap_or(0.0);

            // 5. Create position for SL/TP monitoring
            let position = Position::new(
                token_mint.clone(),
                token_symbol.clone(),
                entry_price,
                out_amount,
                self.config.trade_amount_sol,
                signal.stop_loss_percent,
                signal.take_profit_percent,
                bundle_id.clone(),
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
                price_per_token: Some(entry_price),
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
            });
        }

        // Should never reach here, but just in case
        Ok(self.create_error_result(signal, "Max attempts exhausted", MAX_ATTEMPTS, None))
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
        }
    }

    /// Execute sell order (SL/TP triggered)
    pub async fn execute_sell(&self, token_mint: &str, reason: ExitReason) -> Result<TradeResult> {
        let start = std::time::Instant::now();

        let position = match self.position_manager.get_position(token_mint).await {
            Some(p) => p,
            None => {
                return Err(anyhow!("No position found for {}", token_mint));
            }
        };

        info!(
            "🔴 Executing SELL ({}): {} - {} tokens",
            reason,
            position.token_symbol,
            position.amount_tokens
        );

        // 1. Get sell quote
        let quote = match self.jupiter.get_sell_quote(
            token_mint,
            position.amount_tokens,
            self.config.slippage_bps + 500, // Extra slippage for sells
        ).await {
            Ok(q) => q,
            Err(e) => {
                error!("❌ Failed to get sell quote: {}", e);
                return Ok(TradeResult {
                    success: false,
                    token_mint: token_mint.to_string(),
                    token_symbol: position.token_symbol.clone(),
                    action: "sell".to_string(),
                    amount_sol: 0.0,
                    amount_tokens: Some(position.amount_tokens as f64),
                    price_per_token: None,
                    tx_signature: None,
                    error: Some(format!("Sell quote failed: {}", e)),
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
                    attempt_number: 1,
                    price_at_signal: None,
                    price_at_trade: None,
                    price_change_percent: None,
                });
            }
        };

        let out_lamports: u64 = quote.out_amount.parse().unwrap_or(0);
        let out_sol = out_lamports as f64 / 1e9;

        // 2. Get swap transaction
        let (transaction, _) = self.jupiter.get_swap_transaction(
            quote,
            &self.config.wallet_pubkey(),
            self.config.jito_tip_lamports,
        ).await?;

        // 3. Sign and send
        let recent_blockhash = self.rpc_client.get_latest_blockhash().await?;
        let signed_tx = self.sign_versioned_transaction(transaction, recent_blockhash)?;

        let tx_sig = match self.jito.send_bundle(&signed_tx).await {
            Ok(id) => id,
            Err(_) => {
                // Fallback to direct RPC
                self.rpc_client.send_and_confirm_transaction(&signed_tx).await?.to_string()
            }
        };

        // 4. Remove position
        self.position_manager.remove_position(token_mint).await;

        let elapsed = start.elapsed();
        let pnl_sol = out_sol - position.amount_sol_invested;
        let pnl_percent = (out_sol / position.amount_sol_invested - 1.0) * 100.0;

        info!(
            "✅ SELL executed ({}): {} SOL received | PnL: {:.4} SOL ({:.1}%) | took: {:?}",
            reason,
            out_sol,
            pnl_sol,
            pnl_percent,
            elapsed
        );

        Ok(TradeResult {
            success: true,
            token_mint: token_mint.to_string(),
            token_symbol: position.token_symbol,
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
            attempt_number: 1,
            price_at_signal: None,
            price_at_trade: None,
            price_change_percent: None,
        })
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
