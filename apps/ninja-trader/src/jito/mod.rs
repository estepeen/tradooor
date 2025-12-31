use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::VersionedTransaction,
};
use std::str::FromStr;
use tracing::{info, warn};

// Jito tip accounts (rotate between them)
const JITO_TIP_ACCOUNTS: &[&str] = &[
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4bVmkzdtrnjk7QVksmMsr",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

#[derive(Debug, Serialize)]
struct JitoBundleRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    params: Vec<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct JitoBundleResponse {
    jsonrpc: String,
    result: Option<String>,
    error: Option<JitoError>,
}

#[derive(Debug, Deserialize)]
struct JitoError {
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
struct JitoTipResponse {
    jsonrpc: String,
    result: Option<Vec<String>>,
}

pub struct JitoClient {
    client: Client,
    block_engine_url: String,
}

impl JitoClient {
    pub fn new(block_engine_url: &str) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("Failed to create HTTP client"),
            block_engine_url: block_engine_url.to_string(),
        }
    }

    /// Get a random tip account
    pub fn get_tip_account(&self) -> Pubkey {
        let index = rand::random::<usize>() % JITO_TIP_ACCOUNTS.len();
        Pubkey::from_str(JITO_TIP_ACCOUNTS[index]).unwrap()
    }

    /// Create a tip instruction to add to the transaction
    pub fn create_tip_instruction(
        &self,
        payer: &Pubkey,
        tip_lamports: u64,
    ) -> solana_sdk::instruction::Instruction {
        let tip_account = self.get_tip_account();
        system_instruction::transfer(payer, &tip_account, tip_lamports)
    }

    /// Send a bundle with a single transaction + tip
    pub async fn send_bundle(
        &self,
        transaction: &VersionedTransaction,
    ) -> Result<String> {
        let start = std::time::Instant::now();

        // Serialize transaction to base58
        let tx_bytes = bincode::serialize(transaction)?;
        let tx_base58 = bs58::encode(&tx_bytes).into_string();

        // Build bundle request
        let request = JitoBundleRequest {
            jsonrpc: "2.0".to_string(),
            id: 1,
            method: "sendBundle".to_string(),
            params: vec![vec![tx_base58]],
        };

        let url = format!("{}/api/v1/bundles", self.block_engine_url);

        let response = self.client
            .post(&url)
            .json(&request)
            .send()
            .await?;

        let elapsed = start.elapsed();

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow!("Jito bundle submission failed: {}", error_text));
        }

        let bundle_response: JitoBundleResponse = response.json().await?;

        if let Some(error) = bundle_response.error {
            return Err(anyhow!("Jito error: {} (code: {})", error.message, error.code));
        }

        let bundle_id = bundle_response.result.ok_or_else(|| anyhow!("No bundle ID returned"))?;

        info!(
            "🚀 Jito bundle sent: {} (took: {:?})",
            bundle_id,
            elapsed
        );

        Ok(bundle_id)
    }

    /// Check bundle status
    pub async fn get_bundle_status(&self, bundle_id: &str) -> Result<BundleStatus> {
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getBundleStatuses",
            "params": [[bundle_id]]
        });

        let url = format!("{}/api/v1/bundles", self.block_engine_url);

        let response = self.client
            .post(&url)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow!("Failed to get bundle status: {}", error_text));
        }

        let result: serde_json::Value = response.json().await?;

        // Parse status from response
        if let Some(statuses) = result.get("result").and_then(|r| r.get("value")) {
            if let Some(status_arr) = statuses.as_array() {
                if let Some(first) = status_arr.first() {
                    if let Some(status) = first.get("confirmation_status").and_then(|s| s.as_str()) {
                        return Ok(match status {
                            "processed" => BundleStatus::Processed,
                            "confirmed" => BundleStatus::Confirmed,
                            "finalized" => BundleStatus::Finalized,
                            _ => BundleStatus::Pending,
                        });
                    }
                }
            }
        }

        Ok(BundleStatus::Unknown)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum BundleStatus {
    Pending,
    Processed,
    Confirmed,
    Finalized,
    Failed,
    Unknown,
}

impl std::fmt::Display for BundleStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BundleStatus::Pending => write!(f, "Pending"),
            BundleStatus::Processed => write!(f, "Processed"),
            BundleStatus::Confirmed => write!(f, "Confirmed"),
            BundleStatus::Finalized => write!(f, "Finalized"),
            BundleStatus::Failed => write!(f, "Failed"),
            BundleStatus::Unknown => write!(f, "Unknown"),
        }
    }
}
