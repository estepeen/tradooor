use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use solana_sdk::{
    signature::{Keypair, Signer},
    transaction::VersionedTransaction,
};
use tracing::{debug, info, warn};

const PUMPPORTAL_API_URL: &str = "https://pumpportal.fun/api/trade-local";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpTradeRequest {
    pub public_key: String,
    pub action: String,        // "buy" or "sell"
    pub mint: String,          // token address
    pub amount: String,        // SOL amount for buy, token amount or "100%" for sell
    pub denominated_in_sol: String, // "true" or "false"
    pub slippage: u16,         // percentage (e.g., 10 = 10%)
    pub priority_fee: f64,     // in SOL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,  // "pump" for bonding curve
}

#[derive(Debug, Deserialize)]
pub struct PumpTradeResponse {
    // Response is raw bytes (base64 encoded transaction)
}

pub struct PumpfunTrader {
    client: Client,
}

impl PumpfunTrader {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("Failed to create HTTP client"),
        }
    }

    /// Get a buy transaction for pump.fun bonding curve
    /// Returns serialized transaction ready for signing
    pub async fn get_buy_transaction(
        &self,
        wallet_pubkey: &str,
        token_mint: &str,
        amount_sol: f64,
        slippage_percent: u16,
        priority_fee_sol: f64,
    ) -> Result<Vec<u8>> {
        let request = PumpTradeRequest {
            public_key: wallet_pubkey.to_string(),
            action: "buy".to_string(),
            mint: token_mint.to_string(),
            amount: amount_sol.to_string(),
            denominated_in_sol: "true".to_string(),
            slippage: slippage_percent,
            priority_fee: priority_fee_sol,
            pool: Some("pump".to_string()),
        };

        debug!("PumpPortal buy request: {:?}", request);

        let response = self.client
            .post(PUMPPORTAL_API_URL)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(anyhow!("PumpPortal API error {}: {}", status, error_text));
        }

        // Response is raw bytes (serialized transaction)
        let tx_bytes = response.bytes().await?;

        info!("📦 Got pump.fun transaction ({} bytes)", tx_bytes.len());

        Ok(tx_bytes.to_vec())
    }

    /// Get a sell transaction for pump.fun bonding curve
    /// Uses "100%" to sell all tokens (avoids token amount mismatch issues)
    pub async fn get_sell_transaction(
        &self,
        wallet_pubkey: &str,
        token_mint: &str,
        _amount_tokens: u64, // Ignored - we always sell 100%
        slippage_percent: u16,
        priority_fee_sol: f64,
    ) -> Result<Vec<u8>> {
        let request = PumpTradeRequest {
            public_key: wallet_pubkey.to_string(),
            action: "sell".to_string(),
            mint: token_mint.to_string(),
            amount: "100%".to_string(), // Always sell all tokens to avoid balance mismatch
            denominated_in_sol: "false".to_string(),
            slippage: slippage_percent,
            priority_fee: priority_fee_sol,
            pool: Some("pump".to_string()),
        };

        debug!("PumpPortal sell request: {:?}", request);

        let response = self.client
            .post(PUMPPORTAL_API_URL)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(anyhow!("PumpPortal API error {}: {}", status, error_text));
        }

        let tx_bytes = response.bytes().await?;

        info!("📦 Got pump.fun sell transaction ({} bytes)", tx_bytes.len());

        Ok(tx_bytes.to_vec())
    }

    /// Deserialize and sign a transaction from PumpPortal
    pub fn sign_transaction(
        &self,
        tx_bytes: &[u8],
        wallet: &Keypair,
    ) -> Result<VersionedTransaction> {
        // Deserialize the transaction
        let mut transaction: VersionedTransaction = bincode::deserialize(tx_bytes)
            .map_err(|e| anyhow!("Failed to deserialize transaction: {}", e))?;

        // Sign with wallet
        let message_data = transaction.message.serialize();
        let signature = wallet.sign_message(&message_data);

        // Update signature (first signer is our wallet)
        if transaction.signatures.is_empty() {
            transaction.signatures.push(signature);
        } else {
            transaction.signatures[0] = signature;
        }

        Ok(transaction)
    }
}

impl Default for PumpfunTrader {
    fn default() -> Self {
        Self::new()
    }
}
