use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::Deserialize;
use tracing::{debug, warn};

const BIRDEYE_API_URL: &str = "https://public-api.birdeye.so";
const DEXSCREENER_API_URL: &str = "https://api.dexscreener.com/latest/dex/tokens";

#[derive(Debug, Deserialize)]
struct BirdeyeResponse<T> {
    success: bool,
    data: Option<T>,
}

#[derive(Debug, Deserialize)]
struct PriceData {
    value: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DexScreenerResponse {
    pairs: Option<Vec<DexScreenerPair>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DexScreenerPair {
    chain_id: String,
    price_usd: Option<String>,
    #[serde(default)]
    liquidity: Option<DexScreenerLiquidity>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DexScreenerLiquidity {
    usd: Option<f64>,
}

pub struct BirdeyeClient {
    client: Client,
    api_key: Option<String>,
}

impl BirdeyeClient {
    pub fn new(api_key: Option<String>) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("Failed to create HTTP client"),
            api_key,
        }
    }

    /// Get current price in USD for a token
    /// First tries DexScreener (no rate limit, works for all DEX tokens),
    /// falls back to Birdeye for edge cases
    pub async fn get_price(&self, token_mint: &str) -> Result<f64> {
        // 1. Try DexScreener first (no rate limit, works for all Solana DEX tokens)
        if let Ok(price) = self.get_price_from_dexscreener(token_mint).await {
            return Ok(price);
        }

        // 2. Fall back to Birdeye for edge cases
        self.get_price_from_birdeye(token_mint).await
    }

    /// Get price from DexScreener API (no rate limit)
    async fn get_price_from_dexscreener(&self, token_mint: &str) -> Result<f64> {
        let url = format!("{}/{}", DEXSCREENER_API_URL, token_mint);

        let response = self.client
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(anyhow!("DexScreener API error: {}", response.status()));
        }

        let data: DexScreenerResponse = response.json().await?;

        // Find Solana pair with price
        if let Some(pairs) = data.pairs {
            for pair in pairs {
                if pair.chain_id == "solana" {
                    if let Some(price_str) = pair.price_usd {
                        if let Ok(price) = price_str.parse::<f64>() {
                            debug!("DexScreener price for {}: ${:.10}", &token_mint[..8.min(token_mint.len())], price);
                            return Ok(price);
                        }
                    }
                }
            }
        }

        Err(anyhow!("No Solana price data from DexScreener"))
    }

    /// Get price from Birdeye API (fallback, has rate limits)
    async fn get_price_from_birdeye(&self, token_mint: &str) -> Result<f64> {
        let url = format!("{}/defi/price?address={}", BIRDEYE_API_URL, token_mint);

        let mut request = self.client.get(&url)
            .header("accept", "application/json")
            .header("x-chain", "solana");

        if let Some(ref api_key) = self.api_key {
            request = request.header("X-API-KEY", api_key);
        }

        let response = request.send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(anyhow!("Birdeye API error {}: {}", status, error_text));
        }

        let data: BirdeyeResponse<PriceData> = response.json().await?;

        if !data.success {
            return Err(anyhow!("Birdeye returned success=false"));
        }

        data.data
            .map(|d| d.value)
            .ok_or_else(|| anyhow!("No price data returned"))
    }

    /// Get prices for multiple tokens at once (batch)
    #[allow(dead_code)]
    pub async fn get_prices_batch(&self, token_mints: &[&str]) -> Result<Vec<(String, Option<f64>)>> {
        let mut results = Vec::new();

        for mint in token_mints {
            match self.get_price(mint).await {
                Ok(price) => {
                    debug!("Price for {}: ${:.10}", &mint[..8.min(mint.len())], price);
                    results.push((mint.to_string(), Some(price)));
                }
                Err(e) => {
                    warn!("Failed to get price for {}: {}", &mint[..8.min(mint.len())], e);
                    results.push((mint.to_string(), None));
                }
            }
            // Small delay to be nice to APIs
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        }

        Ok(results)
    }
}

impl Default for BirdeyeClient {
    fn default() -> Self {
        Self::new(None)
    }
}
