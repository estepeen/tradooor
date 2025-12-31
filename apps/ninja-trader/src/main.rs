mod config;
mod jupiter;
mod jito;
mod redis;
mod position;
mod trader;

use anyhow::Result;
use tracing::{info, warn, error, Level};
use tracing_subscriber::FmtSubscriber;

use crate::config::Config;
use crate::redis::RedisListener;
use crate::trader::NinjaTrader;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .with_target(false)
        .with_thread_ids(false)
        .compact()
        .init();

    info!("🥷 NINJA Trader starting...");

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

    // Initialize trader
    let trader = NinjaTrader::new(config.clone());

    // Check balance
    match trader.get_balance().await {
        Ok(balance) => info!("💰 Wallet balance: {:.4} SOL", balance),
        Err(e) => warn!("⚠️ Failed to get balance: {}", e),
    }

    // Initialize Redis listener
    let mut redis_listener = RedisListener::new(&config.redis_url, &config.redis_channel).await?;
    let mut signal_rx = redis_listener.subscribe().await?;

    info!("🚀 NINJA Trader ready! Waiting for signals...");
    info!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Main loop - process signals
    while let Some(signal) = signal_rx.recv().await {
        info!("");
        info!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        info!("🥷 NINJA SIGNAL RECEIVED");
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
                    if let Err(e) = redis_listener.publish_trade_result(&result).await {
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

    info!("👋 NINJA Trader shutting down...");
    Ok(())
}

/// Background task for monitoring positions and executing SL/TP
#[allow(dead_code)]
async fn position_monitor(
    trader: std::sync::Arc<NinjaTrader>,
    mut shutdown_rx: tokio::sync::broadcast::Receiver<()>,
) {
    let check_interval = tokio::time::Duration::from_secs(5);

    loop {
        tokio::select! {
            _ = tokio::time::sleep(check_interval) => {
                let positions = trader.position_manager().get_all_positions().await;

                for _position in positions {
                    // TODO: Get current price from Jupiter or DEX
                    // For now, this is a placeholder
                    // let current_price = get_token_price(&position.token_mint).await;
                    //
                    // if let Some(exit_reason) = position.check_exit(current_price) {
                    //     match trader.execute_sell(&position.token_mint, exit_reason).await {
                    //         Ok(result) => {
                    //             info!("✅ Exit trade executed: {:?}", result);
                    //         }
                    //         Err(e) => {
                    //             error!("❌ Exit trade failed: {}", e);
                    //         }
                    //     }
                    // }
                }
            }
            _ = shutdown_rx.recv() => {
                info!("Position monitor shutting down...");
                break;
            }
        }
    }
}
