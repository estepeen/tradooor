use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn, error, debug};

const PUMPPORTAL_WS_URL: &str = "wss://pumpportal.fun/api/data";

#[derive(Debug, Clone, Serialize)]
struct SubscribeMessage {
    method: String,
    keys: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeEvent {
    pub signature: Option<String>,
    pub mint: String,
    pub sol_amount: Option<f64>,
    pub token_amount: Option<f64>,
    pub is_buy: Option<bool>,
    pub user: Option<String>,
    pub timestamp: Option<i64>,
    pub virtual_sol_reserves: Option<f64>,
    pub virtual_token_reserves: Option<f64>,
    pub market_cap_sol: Option<f64>,
}

/// Price update from trade events
#[derive(Debug, Clone)]
pub struct PriceUpdate {
    pub token_mint: String,
    pub price_usd: f64,
    pub market_cap_usd: f64,
    pub timestamp: i64,
}

/// PumpPortal WebSocket client for real-time price monitoring
pub struct PumpPortalClient {
    /// Current prices for subscribed tokens (token_mint -> price_usd)
    prices: Arc<RwLock<HashMap<String, f64>>>,
    /// Channel to send subscribe requests
    subscribe_tx: Option<mpsc::UnboundedSender<String>>,
    /// Channel to receive price updates
    price_rx: Option<mpsc::UnboundedReceiver<PriceUpdate>>,
    /// SOL price in USD (updated periodically)
    sol_price_usd: Arc<RwLock<f64>>,
}

impl PumpPortalClient {
    pub fn new() -> Self {
        Self {
            prices: Arc::new(RwLock::new(HashMap::new())),
            subscribe_tx: None,
            price_rx: None,
            sol_price_usd: Arc::new(RwLock::new(200.0)), // Default SOL price
        }
    }

    /// Start the WebSocket connection and return price receiver
    pub async fn start(&mut self, initial_sol_price: f64) -> Result<mpsc::UnboundedReceiver<PriceUpdate>> {
        *self.sol_price_usd.write().await = initial_sol_price;

        let (subscribe_tx, subscribe_rx) = mpsc::unbounded_channel::<String>();
        let (price_tx, price_rx) = mpsc::unbounded_channel::<PriceUpdate>();

        self.subscribe_tx = Some(subscribe_tx);

        let prices = self.prices.clone();
        let sol_price = self.sol_price_usd.clone();

        // Spawn WebSocket handler
        tokio::spawn(async move {
            Self::ws_handler(subscribe_rx, price_tx, prices, sol_price).await;
        });

        Ok(price_rx)
    }

    /// Subscribe to price updates for a token
    pub async fn subscribe_token(&self, token_mint: &str) -> Result<()> {
        if let Some(ref tx) = self.subscribe_tx {
            tx.send(token_mint.to_string())
                .map_err(|e| anyhow!("Failed to send subscribe request: {}", e))?;
            info!("📡 Subscribing to price updates for {}", &token_mint[..8.min(token_mint.len())]);
        }
        Ok(())
    }

    /// Get current price for a token (from cache)
    pub async fn get_price(&self, token_mint: &str) -> Option<f64> {
        self.prices.read().await.get(token_mint).copied()
    }

    /// Update SOL price (call this periodically)
    pub async fn update_sol_price(&self, price: f64) {
        *self.sol_price_usd.write().await = price;
    }

    /// WebSocket handler - maintains connection and processes messages
    async fn ws_handler(
        mut subscribe_rx: mpsc::UnboundedReceiver<String>,
        price_tx: mpsc::UnboundedSender<PriceUpdate>,
        prices: Arc<RwLock<HashMap<String, f64>>>,
        sol_price: Arc<RwLock<f64>>,
    ) {
        let mut subscribed_tokens: Vec<String> = Vec::new();
        let mut reconnect_delay = 1;

        loop {
            info!("🔌 Connecting to PumpPortal WebSocket...");

            match connect_async(PUMPPORTAL_WS_URL).await {
                Ok((ws_stream, _)) => {
                    info!("✅ Connected to PumpPortal WebSocket");
                    reconnect_delay = 1; // Reset delay on successful connection

                    let (mut write, mut read) = ws_stream.split();

                    // Re-subscribe to previously subscribed tokens
                    if !subscribed_tokens.is_empty() {
                        let msg = SubscribeMessage {
                            method: "subscribeTokenTrade".to_string(),
                            keys: subscribed_tokens.clone(),
                        };
                        if let Ok(json) = serde_json::to_string(&msg) {
                            let _ = write.send(Message::Text(json)).await;
                            info!("📡 Re-subscribed to {} tokens", subscribed_tokens.len());
                        }
                    }

                    loop {
                        tokio::select! {
                            // Handle new subscribe requests
                            Some(token_mint) = subscribe_rx.recv() => {
                                if !subscribed_tokens.contains(&token_mint) {
                                    subscribed_tokens.push(token_mint.clone());

                                    let msg = SubscribeMessage {
                                        method: "subscribeTokenTrade".to_string(),
                                        keys: vec![token_mint],
                                    };

                                    if let Ok(json) = serde_json::to_string(&msg) {
                                        if let Err(e) = write.send(Message::Text(json)).await {
                                            error!("Failed to send subscribe message: {}", e);
                                            break;
                                        }
                                    }
                                }
                            }

                            // Handle incoming WebSocket messages
                            Some(msg_result) = read.next() => {
                                match msg_result {
                                    Ok(Message::Text(text)) => {
                                        if let Ok(trade) = serde_json::from_str::<TradeEvent>(&text) {
                                            // Calculate price from trade data
                                            if let Some(price_update) = Self::calculate_price(&trade, &sol_price).await {
                                                // Update cache
                                                prices.write().await.insert(
                                                    price_update.token_mint.clone(),
                                                    price_update.price_usd
                                                );

                                                // Send update
                                                let _ = price_tx.send(price_update);
                                            }
                                        }
                                    }
                                    Ok(Message::Ping(data)) => {
                                        let _ = write.send(Message::Pong(data)).await;
                                    }
                                    Ok(Message::Close(_)) => {
                                        warn!("WebSocket closed by server");
                                        break;
                                    }
                                    Err(e) => {
                                        error!("WebSocket error: {}", e);
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    error!("Failed to connect to PumpPortal: {}", e);
                }
            }

            // Reconnect with exponential backoff
            warn!("🔄 Reconnecting in {}s...", reconnect_delay);
            tokio::time::sleep(tokio::time::Duration::from_secs(reconnect_delay)).await;
            reconnect_delay = (reconnect_delay * 2).min(60);
        }
    }

    /// Calculate USD price from trade event
    async fn calculate_price(trade: &TradeEvent, sol_price: &Arc<RwLock<f64>>) -> Option<PriceUpdate> {
        let sol_usd = *sol_price.read().await;

        // Calculate price from virtual reserves (bonding curve)
        if let (Some(sol_reserves), Some(token_reserves)) = (trade.virtual_sol_reserves, trade.virtual_token_reserves) {
            if token_reserves > 0.0 {
                // Price per token in SOL
                let price_sol = sol_reserves / token_reserves;
                let price_usd = price_sol * sol_usd;

                // Market cap = price * total supply (1B for pump.fun)
                let market_cap_usd = price_usd * 1_000_000_000.0;

                debug!(
                    "Price update for {}: ${:.10} (MCap: ${:.0})",
                    &trade.mint[..8.min(trade.mint.len())],
                    price_usd,
                    market_cap_usd
                );

                return Some(PriceUpdate {
                    token_mint: trade.mint.clone(),
                    price_usd,
                    market_cap_usd,
                    timestamp: trade.timestamp.unwrap_or_else(|| chrono::Utc::now().timestamp()),
                });
            }
        }

        // Fallback: calculate from trade amounts
        if let (Some(sol_amount), Some(token_amount)) = (trade.sol_amount, trade.token_amount) {
            if token_amount > 0.0 {
                let price_sol = sol_amount / token_amount;
                let price_usd = price_sol * sol_usd;
                let market_cap_usd = price_usd * 1_000_000_000.0;

                return Some(PriceUpdate {
                    token_mint: trade.mint.clone(),
                    price_usd,
                    market_cap_usd,
                    timestamp: trade.timestamp.unwrap_or_else(|| chrono::Utc::now().timestamp()),
                });
            }
        }

        None
    }
}

impl Default for PumpPortalClient {
    fn default() -> Self {
        Self::new()
    }
}
