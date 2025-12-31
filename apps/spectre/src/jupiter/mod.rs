use anyhow::{anyhow, Result};
use base64::Engine;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use solana_sdk::{
    pubkey::Pubkey,
    transaction::VersionedTransaction,
};
use tracing::info;

const JUPITER_QUOTE_API: &str = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API: &str = "https://quote-api.jup.ag/v6/swap";

// SOL mint address
pub const SOL_MINT: &str = "So11111111111111111111111111111111111111112";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteResponse {
    pub input_mint: String,
    pub in_amount: String,
    pub output_mint: String,
    pub out_amount: String,
    pub other_amount_threshold: String,
    pub swap_mode: String,
    pub slippage_bps: u16,
    pub price_impact_pct: String,
    pub route_plan: Vec<RoutePlan>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePlan {
    pub swap_info: SwapInfo,
    pub percent: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapInfo {
    pub amm_key: String,
    pub label: Option<String>,
    pub input_mint: String,
    pub output_mint: String,
    pub in_amount: String,
    pub out_amount: String,
    pub fee_amount: String,
    pub fee_mint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapRequest {
    pub quote_response: QuoteResponse,
    pub user_public_key: String,
    pub wrap_and_unwrap_sol: bool,
    pub use_shared_accounts: bool,
    pub prioritization_fee_lamports: u64,
    pub as_legacy_transaction: bool,
    pub use_token_ledger: bool,
    pub destination_token_account: Option<String>,
    pub dynamic_compute_unit_limit: bool,
    pub skip_user_accounts_rpc_calls: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapResponse {
    pub swap_transaction: String,
    pub last_valid_block_height: u64,
    pub prioritization_fee_lamports: Option<u64>,
}

pub struct JupiterClient {
    client: Client,
}

impl JupiterClient {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("Failed to create HTTP client"),
        }
    }

    /// Get quote for swapping SOL to token
    pub async fn get_quote(
        &self,
        output_mint: &str,
        amount_lamports: u64,
        slippage_bps: u16,
    ) -> Result<QuoteResponse> {
        let start = std::time::Instant::now();

        let url = format!(
            "{}?inputMint={}&outputMint={}&amount={}&slippageBps={}&onlyDirectRoutes=false&asLegacyTransaction=false",
            JUPITER_QUOTE_API,
            SOL_MINT,
            output_mint,
            amount_lamports,
            slippage_bps
        );

        let response = self.client
            .get(&url)
            .send()
            .await?;

        let elapsed = start.elapsed();

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow!("Jupiter quote failed: {}", error_text));
        }

        let quote: QuoteResponse = response.json().await?;

        info!(
            "📊 Jupiter quote: {} SOL -> {} tokens (impact: {}%, took: {:?})",
            amount_lamports as f64 / 1e9,
            quote.out_amount,
            quote.price_impact_pct,
            elapsed
        );

        Ok(quote)
    }

    /// Get swap transaction from Jupiter
    pub async fn get_swap_transaction(
        &self,
        quote: QuoteResponse,
        user_pubkey: &Pubkey,
        priority_fee_lamports: u64,
    ) -> Result<(VersionedTransaction, u64)> {
        let start = std::time::Instant::now();

        let request = SwapRequest {
            quote_response: quote,
            user_public_key: user_pubkey.to_string(),
            wrap_and_unwrap_sol: true,
            use_shared_accounts: true,
            prioritization_fee_lamports: priority_fee_lamports,
            as_legacy_transaction: false,
            use_token_ledger: false,
            destination_token_account: None,
            dynamic_compute_unit_limit: true,
            skip_user_accounts_rpc_calls: false,
        };

        let response = self.client
            .post(JUPITER_SWAP_API)
            .json(&request)
            .send()
            .await?;

        let elapsed = start.elapsed();

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow!("Jupiter swap request failed: {}", error_text));
        }

        let swap_response: SwapResponse = response.json().await?;

        // Decode the transaction
        let tx_bytes = base64::engine::general_purpose::STANDARD
            .decode(&swap_response.swap_transaction)?;

        let transaction: VersionedTransaction = bincode::deserialize(&tx_bytes)?;

        info!(
            "🔄 Jupiter swap tx prepared (took: {:?}, valid until block: {})",
            elapsed,
            swap_response.last_valid_block_height
        );

        Ok((transaction, swap_response.last_valid_block_height))
    }

    /// Get quote for selling token back to SOL
    pub async fn get_sell_quote(
        &self,
        input_mint: &str,
        amount_tokens: u64,
        slippage_bps: u16,
    ) -> Result<QuoteResponse> {
        let start = std::time::Instant::now();

        let url = format!(
            "{}?inputMint={}&outputMint={}&amount={}&slippageBps={}&onlyDirectRoutes=false&asLegacyTransaction=false",
            JUPITER_QUOTE_API,
            input_mint,
            SOL_MINT,
            amount_tokens,
            slippage_bps
        );

        let response = self.client
            .get(&url)
            .send()
            .await?;

        let elapsed = start.elapsed();

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow!("Jupiter sell quote failed: {}", error_text));
        }

        let quote: QuoteResponse = response.json().await?;

        info!(
            "📊 Jupiter sell quote: {} tokens -> {} SOL (impact: {}%, took: {:?})",
            amount_tokens,
            quote.out_amount,
            quote.price_impact_pct,
            elapsed
        );

        Ok(quote)
    }
}

impl Default for JupiterClient {
    fn default() -> Self {
        Self::new()
    }
}
