use anyhow::Result;
use solana_sdk::signature::{Keypair, Signer};
use std::sync::Arc;

#[derive(Clone)]
pub struct Config {
    // RPC endpoints
    pub rpc_url: String,
    pub jito_block_engine_url: String,

    // Wallet
    pub wallet: Arc<Keypair>,

    // Trading parameters
    pub trade_amount_sol: f64,      // 0.1 SOL
    pub slippage_bps: u16,          // 1500 = 15%
    pub stop_loss_percent: f64,     // -25%
    pub take_profit_percent: f64,   // +50%

    // Jito
    pub jito_tip_lamports: u64,     // Tip for Jito bundle (e.g., 10000 = 0.00001 SOL)

    // Redis
    pub redis_url: String,
    pub redis_channel: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        dotenvy::dotenv().ok();

        // Load wallet from private key (base58 or byte array)
        let private_key = std::env::var("WALLET_PRIVATE_KEY")
            .expect("WALLET_PRIVATE_KEY must be set");

        let wallet = if private_key.starts_with('[') {
            // Byte array format: [1,2,3,...]
            let bytes: Vec<u8> = serde_json::from_str(&private_key)
                .expect("Invalid private key format");
            Keypair::from_bytes(&bytes)?
        } else {
            // Base58 format
            let bytes = bs58::decode(&private_key).into_vec()?;
            Keypair::from_bytes(&bytes)?
        };

        Ok(Config {
            rpc_url: std::env::var("RPC_URL")
                .unwrap_or_else(|_| "https://api.mainnet-beta.solana.com".to_string()),

            jito_block_engine_url: std::env::var("JITO_BLOCK_ENGINE_URL")
                .unwrap_or_else(|_| "https://mainnet.block-engine.jito.wtf".to_string()),

            wallet: Arc::new(wallet),

            trade_amount_sol: std::env::var("TRADE_AMOUNT_SOL")
                .unwrap_or_else(|_| "0.1".to_string())
                .parse()
                .unwrap_or(0.1),

            slippage_bps: std::env::var("SLIPPAGE_BPS")
                .unwrap_or_else(|_| "1500".to_string())
                .parse()
                .unwrap_or(1500), // 15%

            stop_loss_percent: std::env::var("STOP_LOSS_PERCENT")
                .unwrap_or_else(|_| "-25".to_string())
                .parse()
                .unwrap_or(-25.0),

            take_profit_percent: std::env::var("TAKE_PROFIT_PERCENT")
                .unwrap_or_else(|_| "50".to_string())
                .parse()
                .unwrap_or(50.0),

            jito_tip_lamports: std::env::var("JITO_TIP_LAMPORTS")
                .unwrap_or_else(|_| "100000".to_string()) // 0.0001 SOL default
                .parse()
                .unwrap_or(100000),

            redis_url: std::env::var("REDIS_URL")
                .unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string()),

            redis_channel: std::env::var("REDIS_CHANNEL")
                .unwrap_or_else(|_| "ninja_signals".to_string()),
        })
    }

    pub fn wallet_pubkey(&self) -> solana_sdk::pubkey::Pubkey {
        self.wallet.pubkey()
    }
}
