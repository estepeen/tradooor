use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::Deserialize;
use tracing::{debug, warn};

const BIRDEYE_API_URL: &str = "https://public-api.birdeye.so";

#[derive(Debug, Deserialize)]
struct BirdeyeResponse<T> {
    success: bool,
    data: Option<T>,
}

#[derive(Debug, Deserialize)]
struct PriceData {
    value: f64,
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
    pub async fn get_price(&self, token_mint: &str) -> Result<f64> {
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
    pub async fn get_prices_batch(&self, token_mints: &[&str]) -> Result<Vec<(String, Option<f64>)>> {
        let mut results = Vec::new();

        // Birdeye doesn't have a batch endpoint for free tier, so we fetch sequentially
        // with small delays to avoid rate limiting
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
            // Small delay to avoid rate limiting
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }

        Ok(results)
    }
}

impl Default for BirdeyeClient {
    fn default() -> Self {
        Self::new(None)
    }
}
