use anyhow::Result;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{info, warn, error};

/// Signal received from Node.js backend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NinjaSignal {
    pub signal_type: String,           // "ninja"
    pub token_symbol: String,
    pub token_mint: String,
    pub market_cap_usd: Option<f64>,
    pub liquidity_usd: Option<f64>,
    pub entry_price_usd: Option<f64>,
    pub stop_loss_percent: f64,        // -25
    pub take_profit_percent: f64,      // +50
    pub strength: String,              // "STRONG", "MEDIUM", "WEAK"
    pub timestamp: String,
    pub wallets: Vec<SignalWallet>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalWallet {
    pub address: String,
    pub label: Option<String>,
    pub score: Option<f64>,
}

pub struct RedisListener {
    redis_url: String,
    queue_name: String,
    connection: redis::aio::MultiplexedConnection,
}

impl RedisListener {
    pub async fn new(redis_url: &str, queue_name: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let connection = client.get_multiplexed_async_connection().await?;

        info!("✅ Connected to Redis at {}", redis_url);

        Ok(Self {
            redis_url: redis_url.to_string(),
            queue_name: queue_name.to_string(),
            connection,
        })
    }

    /// Listen for NINJA signals using Redis LIST (BRPOP) and return a receiver channel
    /// This is more reliable than pubsub and ensures no signal is lost
    pub async fn subscribe(&self) -> Result<mpsc::UnboundedReceiver<NinjaSignal>> {
        let (tx, rx) = mpsc::unbounded_channel();

        let redis_url = self.redis_url.clone();
        let queue_name = self.queue_name.clone();

        info!("📡 Listening on Redis queue: {}", queue_name);

        // Spawn a task that polls Redis LIST using BRPOP
        tokio::spawn(async move {
            let client = match redis::Client::open(redis_url.as_str()) {
                Ok(c) => c,
                Err(e) => {
                    error!("Failed to open Redis client: {}", e);
                    return;
                }
            };

            let mut conn = match client.get_multiplexed_async_connection().await {
                Ok(c) => c,
                Err(e) => {
                    error!("Failed to get Redis connection: {}", e);
                    return;
                }
            };

            loop {
                // BRPOP with 1 second timeout - blocks until message available
                let result: redis::RedisResult<Option<(String, String)>> =
                    redis::cmd("BRPOP")
                        .arg(&queue_name)
                        .arg(1) // 1 second timeout
                        .query_async(&mut conn)
                        .await;

                match result {
                    Ok(Some((_key, payload))) => {
                        match serde_json::from_str::<NinjaSignal>(&payload) {
                            Ok(signal) => {
                                if signal.signal_type == "ninja" {
                                    info!(
                                        "🥷 Received NINJA signal: {} ({}) MCap: ${:.0}",
                                        signal.token_symbol,
                                        &signal.token_mint[..16.min(signal.token_mint.len())],
                                        signal.market_cap_usd.unwrap_or(0.0)
                                    );

                                    if tx.send(signal).is_err() {
                                        error!("Signal receiver dropped, stopping listener");
                                        break;
                                    }
                                }
                            }
                            Err(e) => {
                                let preview = &payload[..100.min(payload.len())];
                                warn!("Failed to parse signal: {} - payload: {}", e, preview);
                            }
                        }
                    }
                    Ok(None) => {
                        // Timeout - no message, continue polling
                    }
                    Err(e) => {
                        warn!("Redis BRPOP error: {}", e);
                        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                    }
                }
            }
        });

        Ok(rx)
    }

    /// Publish a trade result back to Node.js
    pub async fn publish_trade_result(&mut self, result: &TradeResult) -> Result<()> {
        let payload = serde_json::to_string(result)?;
        let _: () = self.connection.lpush("ninja_trade_results", payload).await?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeResult {
    pub success: bool,
    pub token_mint: String,
    pub token_symbol: String,
    pub action: String,              // "buy" or "sell"
    pub amount_sol: f64,
    pub amount_tokens: Option<f64>,
    pub price_per_token: Option<f64>,
    pub tx_signature: Option<String>,
    pub error: Option<String>,
    pub latency_ms: u64,
    pub timestamp: String,
}
