mod config;
mod jupiter;
mod jito;
mod redis;
mod position;
mod trader;
mod birdeye;

use anyhow::Result;
use std::sync::Arc;
use tracing::{info, warn, error, Level};
use tracing_subscriber::FmtSubscriber;

use crate::config::Config;
use crate::redis::RedisListener;
use crate::trader::SpectreTrader;
use crate::birdeye::BirdeyeClient;
use crate::position::ExitReason;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .with_target(false)
        .with_thread_ids(false)
        .compact()
        .init();

    info!("👻 SPECTRE starting...");

    // Load configuration
    let config = Config::from_env()?;

    info!("📝 Configuration:");
    info!("   RPC: {}", config.rpc_url);
    info!("   Jito: {}", config.jito_block_engine_url);
    info!("   Wallet: {}", config.wallet_pubkey());
    info!("   Trade amount: {} SOL", config.trade_amount_sol);
    info!("   Slippage: {}%", config.slippage_bps as f64 / 100.0);
    info!("   Stop Loss: {}%", config.stop_loss_percent);
    info!("   Take Profit: +{}%", config.take_profit_percent);
    info!("   Jito tip: {} lamports", config.jito_tip_lamports);
    info!("   Position check interval: {}s", config.position_check_interval_secs);

    // Initialize trader
    let trader = Arc::new(SpectreTrader::new(config.clone()));

    // Check balance
    match trader.get_balance().await {
        Ok(balance) => info!("💰 Wallet balance: {:.4} SOL", balance),
        Err(e) => warn!("⚠️ Failed to get balance: {}", e),
    }

    // Initialize Redis listener
    let redis_listener = Arc::new(tokio::sync::Mutex::new(
        RedisListener::new(&config.redis_url, &config.redis_channel).await?
    ));
    let mut signal_rx = redis_listener.lock().await.subscribe().await?;

    // Initialize Birdeye client for price monitoring
    let birdeye = Arc::new(BirdeyeClient::new(config.birdeye_api_key.clone()));

    // Shutdown channel
    let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
    let shutdown_rx = shutdown_tx.subscribe();

    // Start position monitor in background
    let monitor_trader = trader.clone();
    let monitor_birdeye = birdeye.clone();
    let monitor_redis = redis_listener.clone();
    let check_interval = config.position_check_interval_secs;

    let monitor_handle = tokio::spawn(async move {
        position_monitor(monitor_trader, monitor_birdeye, monitor_redis, check_interval, shutdown_rx).await;
    });

    info!("🚀 SPECTRE ready! Waiting for signals...");
    info!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Main loop - process signals
    while let Some(signal) = signal_rx.recv().await {
        info!("");
        info!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        info!("👻 SIGNAL RECEIVED");
        info!("   Token: {} ({})", signal.token_symbol, &signal.token_mint[..16.min(signal.token_mint.len())]);
        info!("   MCap: ${:.0}", signal.market_cap_usd.unwrap_or(0.0));
        info!("   Liquidity: ${:.0}", signal.liquidity_usd.unwrap_or(0.0));
        info!("   Strength: {}", signal.strength);
        info!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        // Execute buy
        match trader.execute_buy(&signal).await {
            Ok(result) => {
                if result.success {
                    info!("✅ Trade successful!");
                    info!("   TX: {}", result.tx_signature.as_deref().unwrap_or("N/A"));
                    info!("   Latency: {}ms", result.latency_ms);

                    // Publish result back to Node.js
                    if let Err(e) = redis_listener.lock().await.publish_trade_result(&result).await {
                        warn!("⚠️ Failed to publish trade result: {}", e);
                    }
                } else {
                    warn!("❌ Trade failed: {}", result.error.as_deref().unwrap_or("Unknown"));
                }
            }
            Err(e) => {
                error!("❌ Trade error: {}", e);
            }
        }
    }

    // Cleanup
    let _ = shutdown_tx.send(());
    let _ = monitor_handle.await;

    info!("👋 SPECTRE shutting down...");
    Ok(())
}

/// Background task for monitoring positions and executing SL/TP
async fn position_monitor(
    trader: Arc<SpectreTrader>,
    birdeye: Arc<BirdeyeClient>,
    redis_listener: Arc<tokio::sync::Mutex<RedisListener>>,
    check_interval_secs: u64,
    mut shutdown_rx: tokio::sync::broadcast::Receiver<()>,
) {
    let check_interval = tokio::time::Duration::from_secs(check_interval_secs);

    info!("📊 Position monitor started (checking every {}s)", check_interval_secs);

    loop {
        tokio::select! {
            _ = tokio::time::sleep(check_interval) => {
                let positions = trader.position_manager().get_all_positions().await;

                if positions.is_empty() {
                    continue;
                }

                info!("📊 Checking {} position(s)...", positions.len());

                for position in positions {
                    // Get current price from Birdeye
                    let current_price = match birdeye.get_price(&position.token_mint).await {
                        Ok(price) => price,
                        Err(e) => {
                            warn!("⚠️ Failed to get price for {}: {}", position.token_symbol, e);
                            continue;
                        }
                    };

                    // Calculate PnL
                    let pnl = position.calculate_pnl(current_price);
                    info!(
                        "   {} @ ${:.10} | PnL: {:.1}% | SL: ${:.10} | TP: ${:.10}",
                        position.token_symbol,
                        current_price,
                        pnl.pnl_percent,
                        position.stop_loss_price,
                        position.take_profit_price
                    );

                    // Check if we should exit
                    if let Some(exit_reason) = position.check_exit(current_price) {
                        let reason_str = match exit_reason {
                            ExitReason::StopLoss => "🛑 STOP LOSS",
                            ExitReason::TakeProfit => "🎯 TAKE PROFIT",
                            ExitReason::Manual => "👤 MANUAL",
                        };

                        info!("🚨 {} triggered for {} at ${:.10} ({:.1}%)",
                            reason_str,
                            position.token_symbol,
                            current_price,
                            pnl.pnl_percent
                        );

                        // Execute sell
                        match trader.execute_sell(&position.token_mint, exit_reason).await {
                            Ok(result) => {
                                if result.success {
                                    info!("✅ Exit executed successfully!");
                                    info!("   TX: {}", result.tx_signature.as_deref().unwrap_or("N/A"));

                                    // Publish result back to Node.js
                                    if let Err(e) = redis_listener.lock().await.publish_trade_result(&result).await {
                                        warn!("⚠️ Failed to publish trade result: {}", e);
                                    }
                                } else {
                                    error!("❌ Exit failed: {}", result.error.as_deref().unwrap_or("Unknown"));
                                }
                            }
                            Err(e) => {
                                error!("❌ Exit error: {}", e);
                            }
                        }
                    }
                }
            }
            _ = shutdown_rx.recv() => {
                info!("📊 Position monitor shutting down...");
                break;
            }
        }
    }
}
