use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};

/// Active position being monitored for SL/TP
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub token_mint: String,
    pub token_symbol: String,
    pub entry_price: f64,
    pub amount_tokens: u64,
    pub amount_sol_invested: f64,
    pub stop_loss_percent: f64,
    pub take_profit_percent: f64,
    pub stop_loss_price: f64,
    pub take_profit_price: f64,
    pub entry_time: chrono::DateTime<chrono::Utc>,
    pub tx_signature: String,
    /// Number of failed sell attempts (for "no route" errors)
    #[serde(default)]
    pub failed_sell_attempts: u32,
    /// If true, stop trying to sell (marked as unsellable)
    #[serde(default)]
    pub is_unsellable: bool,
    /// True if position was opened via pump.fun (should sell via pump.fun too)
    #[serde(default)]
    pub is_pumpfun: bool,
    /// True if entry price was synced with real PumpPortal price
    #[serde(default)]
    pub price_synced: bool,
    /// Highest price seen since entry (for logging only)
    #[serde(default)]
    pub high_price: f64,
    /// Signal type (ninja, consensus, etc.) - determines exit strategy
    #[serde(default)]
    pub signal_type: String,
    /// Scaled exit stage for NINJA signals (0=none, 1=sold 60% at +30%, 2=sold 20% at +40%, 3=sold 20% at +50%)
    #[serde(default)]
    pub scaled_exit_stage: u8,
    /// Original token amount (before any partial sells)
    #[serde(default)]
    pub original_amount_tokens: u64,
}

impl Position {
    pub fn new(
        token_mint: String,
        token_symbol: String,
        entry_price: f64,
        amount_tokens: u64,
        amount_sol_invested: f64,
        stop_loss_percent: f64,  // e.g., 25 (always positive from backend, means -25%)
        take_profit_percent: f64, // e.g., 50 (means +50%)
        tx_signature: String,
        is_pumpfun: bool,        // true if bought via pump.fun bonding curve
    ) -> Self {
        Self::new_with_signal_type(
            token_mint,
            token_symbol,
            entry_price,
            amount_tokens,
            amount_sol_invested,
            stop_loss_percent,
            take_profit_percent,
            tx_signature,
            is_pumpfun,
            String::new(), // default empty signal type
        )
    }

    pub fn new_with_signal_type(
        token_mint: String,
        token_symbol: String,
        entry_price: f64,
        amount_tokens: u64,
        amount_sol_invested: f64,
        stop_loss_percent: f64,
        take_profit_percent: f64,
        tx_signature: String,
        is_pumpfun: bool,
        signal_type: String,
    ) -> Self {
        // SL comes as positive number (e.g., 25 means -25% from entry)
        let sl_multiplier = 1.0 - stop_loss_percent.abs() / 100.0;
        let stop_loss_price = entry_price * sl_multiplier;

        // TP comes as positive number (e.g., 50 means +50% from entry)
        let take_profit_price = entry_price * (1.0 + take_profit_percent.abs() / 100.0);

        let is_ninja = signal_type == "ninja";

        info!(
            "📊 Position created ({}, {}): {} @ ${:.10} | SL: ${:.10} (-{:.0}%) | TP: ${:.10} (+{:.0}%){}",
            if is_pumpfun { "pump.fun" } else { "Jupiter" },
            if is_ninja { "NINJA scaled exits" } else { "standard" },
            token_symbol,
            entry_price,
            stop_loss_price,
            stop_loss_percent.abs(),
            take_profit_price,
            take_profit_percent.abs(),
            if is_ninja { " | Scaled: 80%@+30%, 15%@+50%, 5%@+80%" } else { "" }
        );

        Self {
            token_mint,
            token_symbol,
            entry_price,
            amount_tokens,
            amount_sol_invested,
            stop_loss_percent,
            take_profit_percent,
            stop_loss_price,
            take_profit_price,
            entry_time: chrono::Utc::now(),
            tx_signature,
            failed_sell_attempts: 0,
            is_unsellable: false,
            is_pumpfun,
            price_synced: false,
            high_price: entry_price, // For logging only
            signal_type,
            scaled_exit_stage: 0,
            original_amount_tokens: amount_tokens,
        }
    }

    /// Short initial period to wait for first price sync (in seconds)
    /// We need at least one PumpPortal price update to sync entry_price
    const PRICE_SYNC_WAIT_SECS: i64 = 3;

    /// Check if we're still waiting for initial price sync
    /// Returns true only for the first few seconds after position creation
    pub fn is_waiting_for_price_sync(&self) -> bool {
        let elapsed = chrono::Utc::now() - self.entry_time;
        elapsed.num_seconds() < Self::PRICE_SYNC_WAIT_SECS
    }

    /// Update entry price and recalculate SL/TP based on real PumpPortal price
    /// This syncs our position with actual bonding curve price (only once!)
    pub fn sync_with_real_price(&mut self, real_price: f64) {
        if self.price_synced {
            return; // Already synced, don't update again
        }

        let old_entry = self.entry_price;
        self.entry_price = real_price;
        self.high_price = real_price; // Initialize high price tracking
        self.price_synced = true; // Mark as synced so we don't update again

        // Recalculate SL/TP from new entry price
        let sl_multiplier = 1.0 - self.stop_loss_percent.abs() / 100.0;
        self.stop_loss_price = real_price * sl_multiplier;

        self.take_profit_price = real_price * (1.0 + self.take_profit_percent.abs() / 100.0);

        info!(
            "🔄 Price synced for {}: ${:.10} -> ${:.10} | New SL: ${:.10} | New TP: ${:.10}",
            self.token_symbol,
            old_entry,
            real_price,
            self.stop_loss_price,
            self.take_profit_price
        );
    }

    /// Update high price for logging (no trailing SL - we use scaled exits)
    pub fn update_high_price(&mut self, current_price: f64) {
        if current_price > self.high_price {
            self.high_price = current_price;
        }
    }

    /// Check if entry price has been synced with real PumpPortal price
    pub fn needs_price_sync(&self) -> bool {
        // Only sync pump.fun positions that haven't been synced yet
        self.is_pumpfun && !self.price_synced
    }

    // NINJA scaled exit thresholds (conservative: +30%→80%, +50%→15%, +80%→5%)
    const NINJA_TP1_PERCENT: f64 = 30.0;  // +30% -> sell 80%
    const NINJA_TP2_PERCENT: f64 = 50.0;  // +50% -> sell 15%
    const NINJA_TP3_PERCENT: f64 = 80.0;  // +80% -> sell remaining 5%

    const NINJA_TP1_SELL_PERCENT: f64 = 80.0;  // Sell 80% of position at TP1
    const NINJA_TP2_SELL_PERCENT: f64 = 75.0;  // Sell 75% of remaining (= 15% of original) at TP2
    const NINJA_TP3_SELL_PERCENT: f64 = 100.0; // Sell 100% of remaining (= 5% of original) at TP3

    /// Check if this is a NINJA signal (uses scaled exits)
    pub fn is_ninja(&self) -> bool {
        self.signal_type == "ninja"
    }

    /// Check if current price triggers SL or TP
    /// Returns None if position is marked as unsellable or waiting for price sync
    /// For NINJA signals, returns ScaledTakeProfit with percentage to sell
    pub fn check_exit(&self, current_price: f64) -> Option<ExitReason> {
        if self.is_unsellable {
            return None;
        }

        // Don't check exits until we've synced price from PumpPortal
        if self.needs_price_sync() {
            return None;
        }

        // Stop loss always triggers full exit
        if current_price <= self.stop_loss_price {
            return Some(ExitReason::StopLoss);
        }

        // For NINJA signals, use scaled exits
        if self.is_ninja() {
            let profit_percent = (current_price / self.entry_price - 1.0) * 100.0;

            // Check each TP level based on current stage
            match self.scaled_exit_stage {
                0 if profit_percent >= Self::NINJA_TP1_PERCENT => {
                    // Stage 0 -> 1: Sell 60% at +30%
                    Some(ExitReason::ScaledTakeProfit {
                        stage: 1,
                        sell_percent: Self::NINJA_TP1_SELL_PERCENT,
                        trigger_percent: Self::NINJA_TP1_PERCENT,
                    })
                }
                1 if profit_percent >= Self::NINJA_TP2_PERCENT => {
                    // Stage 1 -> 2: Sell 50% of remaining (20% of original) at +40%
                    Some(ExitReason::ScaledTakeProfit {
                        stage: 2,
                        sell_percent: Self::NINJA_TP2_SELL_PERCENT,
                        trigger_percent: Self::NINJA_TP2_PERCENT,
                    })
                }
                2 if profit_percent >= Self::NINJA_TP3_PERCENT => {
                    // Stage 2 -> 3: Sell 100% of remaining (20% of original) at +50%
                    Some(ExitReason::ScaledTakeProfit {
                        stage: 3,
                        sell_percent: Self::NINJA_TP3_SELL_PERCENT,
                        trigger_percent: Self::NINJA_TP3_PERCENT,
                    })
                }
                _ => None,
            }
        } else {
            // Standard exit: full position at TP
            if current_price >= self.take_profit_price {
                Some(ExitReason::TakeProfit)
            } else {
                None
            }
        }
    }

    /// Advance to next scaled exit stage and reduce position
    /// Returns the amount of tokens to sell
    pub fn advance_scaled_exit(&mut self, stage: u8, sell_percent: f64) -> u64 {
        let tokens_to_sell = (self.amount_tokens as f64 * sell_percent / 100.0) as u64;
        self.amount_tokens = self.amount_tokens.saturating_sub(tokens_to_sell);
        self.scaled_exit_stage = stage;

        info!(
            "🎯 NINJA scaled exit stage {} for {}: selling {} tokens ({:.0}%), {} remaining",
            stage,
            self.token_symbol,
            tokens_to_sell,
            sell_percent,
            self.amount_tokens
        );

        tokens_to_sell
    }

    /// Check if position is fully closed (no more tokens)
    pub fn is_fully_closed(&self) -> bool {
        self.amount_tokens == 0
    }

    /// Calculate current PnL
    pub fn calculate_pnl(&self, current_price: f64) -> PnL {
        let current_value = current_price * self.amount_tokens as f64;
        let entry_value = self.entry_price * self.amount_tokens as f64;
        let pnl_usd = current_value - entry_value;
        let pnl_percent = (current_price / self.entry_price - 1.0) * 100.0;

        PnL {
            pnl_usd,
            pnl_percent,
            current_price,
            entry_price: self.entry_price,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExitReason {
    StopLoss,
    TakeProfit,
    Manual,
    /// Scaled take profit for NINJA signals (partial sells)
    ScaledTakeProfit {
        stage: u8,           // 1, 2, or 3
        sell_percent: f64,   // Percentage of current position to sell
        trigger_percent: f64, // Profit % that triggered this exit
    },
}

impl ExitReason {
    /// Check if this is a partial exit (scaled TP)
    pub fn is_partial(&self) -> bool {
        matches!(self, ExitReason::ScaledTakeProfit { .. })
    }

    /// Get the sell percentage for scaled exits (100 for full exits)
    pub fn sell_percent(&self) -> f64 {
        match self {
            ExitReason::ScaledTakeProfit { sell_percent, .. } => *sell_percent,
            _ => 100.0, // Full exit for SL, TP, Manual
        }
    }
}

impl std::fmt::Display for ExitReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExitReason::StopLoss => write!(f, "Stop Loss"),
            ExitReason::TakeProfit => write!(f, "Take Profit"),
            ExitReason::Manual => write!(f, "Manual"),
            ExitReason::ScaledTakeProfit { stage, trigger_percent, .. } => {
                write!(f, "Take Profit #{} (+{:.0}%)", stage, trigger_percent)
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct PnL {
    pub pnl_usd: f64,
    pub pnl_percent: f64,
    pub current_price: f64,
    pub entry_price: f64,
}

/// Position manager - tracks all active positions
pub struct PositionManager {
    positions: Arc<RwLock<HashMap<String, Position>>>,
}

impl PositionManager {
    pub fn new() -> Self {
        Self {
            positions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn add_position(&self, position: Position) {
        let mut positions = self.positions.write().await;
        positions.insert(position.token_mint.clone(), position);
    }

    pub async fn remove_position(&self, token_mint: &str) -> Option<Position> {
        let mut positions = self.positions.write().await;
        positions.remove(token_mint)
    }

    pub async fn get_position(&self, token_mint: &str) -> Option<Position> {
        let positions = self.positions.read().await;
        positions.get(token_mint).cloned()
    }

    pub async fn get_all_positions(&self) -> Vec<Position> {
        let positions = self.positions.read().await;
        positions.values().cloned().collect()
    }

    pub async fn has_position(&self, token_mint: &str) -> bool {
        let positions = self.positions.read().await;
        positions.contains_key(token_mint)
    }

    pub async fn position_count(&self) -> usize {
        let positions = self.positions.read().await;
        positions.len()
    }

    /// Increment failed sell attempts and mark as unsellable if too many failures
    /// Returns true if position was marked as unsellable
    pub async fn increment_failed_sell(&self, token_mint: &str) -> bool {
        const MAX_SELL_FAILURES: u32 = 3;

        let mut positions = self.positions.write().await;
        if let Some(position) = positions.get_mut(token_mint) {
            position.failed_sell_attempts += 1;

            if position.failed_sell_attempts >= MAX_SELL_FAILURES {
                position.is_unsellable = true;
                warn!(
                    "⚠️ {} marked as UNSELLABLE after {} failed sell attempts (no route found)",
                    position.token_symbol, position.failed_sell_attempts
                );
                return true;
            }
        }
        false
    }

    /// Mark position as unsellable
    pub async fn mark_unsellable(&self, token_mint: &str, reason: &str) {
        let mut positions = self.positions.write().await;
        if let Some(position) = positions.get_mut(token_mint) {
            position.is_unsellable = true;
            warn!(
                "⚠️ {} marked as UNSELLABLE: {}",
                position.token_symbol, reason
            );
        }
    }

    /// Sync position's entry price with real PumpPortal price
    /// This fixes the price discrepancy between backend and PumpPortal
    /// Returns true if sync was performed
    pub async fn sync_entry_price(&self, token_mint: &str, real_price: f64) -> bool {
        let mut positions = self.positions.write().await;
        if let Some(position) = positions.get_mut(token_mint) {
            if position.needs_price_sync() {
                position.sync_with_real_price(real_price);
                return true;
            }
        }
        false
    }

    /// Update high price for logging (no trailing SL - we use scaled exits)
    pub async fn update_high_price(&self, token_mint: &str, current_price: f64) {
        let mut positions = self.positions.write().await;
        if let Some(position) = positions.get_mut(token_mint) {
            position.update_high_price(current_price);
        }
    }

    /// Advance scaled exit stage for NINJA signals
    /// Returns (tokens_to_sell, position_fully_closed)
    pub async fn advance_scaled_exit(&self, token_mint: &str, stage: u8, sell_percent: f64) -> Option<(u64, bool)> {
        let mut positions = self.positions.write().await;
        if let Some(position) = positions.get_mut(token_mint) {
            let tokens_to_sell = position.advance_scaled_exit(stage, sell_percent);
            let fully_closed = position.is_fully_closed();
            return Some((tokens_to_sell, fully_closed));
        }
        None
    }

    /// Update position after a partial sell (reduce tokens)
    pub async fn update_tokens_after_sell(&self, token_mint: &str, tokens_sold: u64) {
        let mut positions = self.positions.write().await;
        if let Some(position) = positions.get_mut(token_mint) {
            position.amount_tokens = position.amount_tokens.saturating_sub(tokens_sold);
            info!(
                "📊 Updated {} position: sold {} tokens, {} remaining",
                position.token_symbol,
                tokens_sold,
                position.amount_tokens
            );
        }
    }
}

impl Default for PositionManager {
    fn default() -> Self {
        Self::new()
    }
}
