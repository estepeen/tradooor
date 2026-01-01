mod config;
mod jupiter;
mod jito;
mod redis;
mod position;
mod trader;
mod birdeye;
mod pumpportal;
mod pumpfun_trade;

use anyhow::Result;
use std::sync::Arc;
use tracing::{info, warn, error, Level};
use tracing_subscriber::FmtSubscriber;

use crate::config::Config;
use crate::redis::RedisListener;
use crate::trader::SpectreTrader;
use crate::birdeye::BirdeyeClient;
use crate::pumpportal::PumpPortalClient;
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

    // Subscribe to pre-signals for Fast Confirm optimization
    let mut pre_signal_rx = redis_listener.lock().await.subscribe_pre_signals().await?;

    // Initialize Birdeye/DexScreener client for price monitoring (fallback)
    let birdeye = Arc::new(BirdeyeClient::new(config.birdeye_api_key.clone()));

    // Initialize PumpPortal WebSocket client for real-time pump.fun prices
    let mut pumpportal = PumpPortalClient::new();

    // Get SOL price for PumpPortal (from DexScreener)
    let sol_price = birdeye.get_price("So11111111111111111111111111111111111111112").await.unwrap_or(200.0);
    info!("💰 SOL price: ${:.2}", sol_price);

    // Start PumpPortal WebSocket
    let price_rx = pumpportal.start(sol_price).await?;
    let pumpportal = Arc::new(pumpportal);

    info!("🔌 PumpPortal WebSocket started for real-time pump.fun prices");

    // Shutdown channel
    let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
    let shutdown_rx = shutdown_tx.subscribe();

    // Start position monitor in background
    let monitor_trader = trader.clone();
    let monitor_birdeye = birdeye.clone();
    let monitor_pumpportal = pumpportal.clone();
    let monitor_redis = redis_listener.clone();
    let check_interval = config.position_check_interval_secs;

    let monitor_handle = tokio::spawn(async move {
        position_monitor(
            monitor_trader,
            monitor_pumpportal,
            monitor_birdeye,
            monitor_redis,
            check_interval,
            shutdown_rx,
            price_rx
        ).await;
    });

    // Start pre-signal handler in background (Fast Confirm optimization)
    let presignal_trader = trader.clone();
    let presignal_handle = tokio::spawn(async move {
        info!("⚡ Fast Confirm: Pre-signal handler started");
        while let Some(pre_signal) = pre_signal_rx.recv().await {
            presignal_trader.prepare_tx_for_presignal(&pre_signal).await;
        }
        info!("⚡ Pre-signal handler stopped");
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

                    // Subscribe to real-time price updates for this token
                    if let Err(e) = pumpportal.subscribe_token(&signal.token_mint).await {
                        warn!("⚠️ Failed to subscribe to price updates: {}", e);
                    }

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
    presignal_handle.abort(); // Stop pre-signal handler

    info!("👋 SPECTRE shutting down...");
    Ok(())
}

/// Background task for monitoring positions and executing SL/TP
/// Uses PumpPortal WebSocket for real-time pump.fun prices,
/// falls back to DexScreener for non-pump.fun tokens
async fn position_monitor(
    trader: Arc<SpectreTrader>,
    pumpportal: Arc<PumpPortalClient>,
    birdeye: Arc<BirdeyeClient>,
    redis_listener: Arc<tokio::sync::Mutex<RedisListener>>,
    check_interval_secs: u64,
    mut shutdown_rx: tokio::sync::broadcast::Receiver<()>,
    mut price_rx: tokio::sync::mpsc::UnboundedReceiver<crate::pumpportal::PriceUpdate>,
) {
    let check_interval = tokio::time::Duration::from_secs(check_interval_secs);

    info!("📊 Position monitor started");
    info!("   - Real-time pump.fun prices via PumpPortal WebSocket");
    info!("   - Fallback to DexScreener every {}s for non-pump.fun tokens", check_interval_secs);

    loop {
        tokio::select! {
            // Handle real-time price updates from PumpPortal
            Some(price_update) = price_rx.recv() => {
                // Check if we have a position for this token
                if let Some(position) = trader.position_manager().get_position(&price_update.token_mint).await {
                    let current_price = price_update.price_usd;

                    // Sync entry price on first update (fixes price discrepancy)
                    // This updates entry_price, SL, and TP based on real PumpPortal price
                    if position.needs_price_sync() {
                        trader.position_manager().sync_entry_price(&price_update.token_mint, current_price).await;
                        // Get updated position after sync
                        continue; // Skip this update, next one will have synced prices
                    }

                    // Update trailing stop loss (raises SL as price goes up)
                    trader.position_manager().update_trailing_sl(&price_update.token_mint, current_price).await;

                    // Get updated position after potential trailing SL update
                    let position = trader.position_manager().get_position(&price_update.token_mint).await
                        .unwrap_or(position);

                    // Calculate PnL
                    let pnl = position.calculate_pnl(current_price);

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
                        execute_exit(&trader, &redis_listener, &position.token_mint, exit_reason).await;
                    }
                }
            }

            // Periodic check for positions (fallback for tokens not on pump.fun)
            _ = tokio::time::sleep(check_interval) => {
                let positions = trader.position_manager().get_all_positions().await;

                if positions.is_empty() {
                    continue;
                }

                info!("📊 Checking {} position(s)...", positions.len());

                for position in positions {
                    // First try PumpPortal cache (real-time)
                    let current_price = if let Some(price) = pumpportal.get_price(&position.token_mint).await {
                        price
                    } else {
                        // Fallback to DexScreener for non-pump.fun tokens
                        match birdeye.get_price(&position.token_mint).await {
                            Ok(price) => price,
                            Err(e) => {
                                warn!("⚠️ Failed to get price for {}: {}", position.token_symbol, e);
                                continue;
                            }
                        }
                    };

                    // Update trailing stop loss (raises SL as price goes up)
                    trader.position_manager().update_trailing_sl(&position.token_mint, current_price).await;

                    // Get updated position after potential trailing SL update
                    let position = trader.position_manager().get_position(&position.token_mint).await
                        .unwrap_or(position);

                    // Calculate PnL
                    let pnl = position.calculate_pnl(current_price);
                    let trailing_status = if position.trailing_active { " [TRAILING]" } else { "" };
                    info!(
                        "   {} @ ${:.10} | PnL: {:.1}% | SL: ${:.10} | TP: ${:.10}{}",
                        position.token_symbol,
                        current_price,
                        pnl.pnl_percent,
                        position.stop_loss_price,
                        position.take_profit_price,
                        trailing_status
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
                        execute_exit(&trader, &redis_listener, &position.token_mint, exit_reason).await;
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

/// Helper to execute exit and publish result
async fn execute_exit(
    trader: &Arc<SpectreTrader>,
    redis_listener: &Arc<tokio::sync::Mutex<RedisListener>>,
    token_mint: &str,
    exit_reason: ExitReason,
) {
    match trader.execute_sell(token_mint, exit_reason).await {
        Ok(result) => {
            if result.success {
                info!("✅ Exit executed successfully!");
                info!("   TX: {}", result.tx_signature.as_deref().unwrap_or("N/A"));

                // Publish result back to Node.js
                if let Err(e) = redis_listener.lock().await.publish_trade_result(&result).await {
                    warn!("⚠️ Failed to publish trade result: {}", e);
                }
            } else {
                let error_msg = result.error.as_deref().unwrap_or("Unknown");
                error!("❌ Exit failed: {}", error_msg);

                // If quote failed (no route), increment failed sell counter
                if error_msg.contains("no route") || error_msg.contains("COULD_NOT_FIND") || error_msg.contains("quote failed") {
                    trader.position_manager().increment_failed_sell(token_mint).await;
                }
            }
        }
        Err(e) => {
            error!("❌ Exit error: {}", e);

            // Also increment on error
            let error_str = e.to_string();
            if error_str.contains("no route") || error_str.contains("COULD_NOT_FIND") {
                trader.position_manager().increment_failed_sell(token_mint).await;
            }
        }
    }
}
