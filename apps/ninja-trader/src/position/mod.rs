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
    pub entry_price_usd: f64,
    pub amount_tokens: u64,
    pub amount_sol_invested: f64,
    pub stop_loss_price: f64,
    pub take_profit_price: f64,
    pub entry_time: chrono::DateTime<chrono::Utc>,
    pub tx_signature: String,
}

impl Position {
    pub fn new(
        token_mint: String,
        token_symbol: String,
        entry_price_usd: f64,
        amount_tokens: u64,
        amount_sol_invested: f64,
        stop_loss_percent: f64,  // e.g., -25
        take_profit_percent: f64, // e.g., 50
        tx_signature: String,
    ) -> Self {
        let stop_loss_price = entry_price_usd * (1.0 + stop_loss_percent / 100.0);
        let take_profit_price = entry_price_usd * (1.0 + take_profit_percent / 100.0);

        info!(
            "📊 Position created: {} @ ${:.10} | SL: ${:.10} ({:.0}%) | TP: ${:.10} (+{:.0}%)",
            token_symbol,
            entry_price_usd,
            stop_loss_price,
            stop_loss_percent,
            take_profit_price,
            take_profit_percent
        );

        Self {
            token_mint,
            token_symbol,
            entry_price_usd,
            amount_tokens,
            amount_sol_invested,
            stop_loss_price,
            take_profit_price,
            entry_time: chrono::Utc::now(),
            tx_signature,
        }
    }

    /// Check if current price triggers SL or TP
    pub fn check_exit(&self, current_price: f64) -> Option<ExitReason> {
        if current_price <= self.stop_loss_price {
            Some(ExitReason::StopLoss)
        } else if current_price >= self.take_profit_price {
            Some(ExitReason::TakeProfit)
        } else {
            None
        }
    }

    /// Calculate current PnL
    pub fn calculate_pnl(&self, current_price: f64) -> PnL {
        let current_value = current_price * self.amount_tokens as f64;
        let entry_value = self.entry_price_usd * self.amount_tokens as f64;
        let pnl_usd = current_value - entry_value;
        let pnl_percent = (current_price / self.entry_price_usd - 1.0) * 100.0;

        PnL {
            pnl_usd,
            pnl_percent,
            current_price,
            entry_price: self.entry_price_usd,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExitReason {
    StopLoss,
    TakeProfit,
    Manual,
}

impl std::fmt::Display for ExitReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExitReason::StopLoss => write!(f, "Stop Loss"),
            ExitReason::TakeProfit => write!(f, "Take Profit"),
            ExitReason::Manual => write!(f, "Manual"),
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
}

impl Default for PositionManager {
    fn default() -> Self {
        Self::new()
    }
}
