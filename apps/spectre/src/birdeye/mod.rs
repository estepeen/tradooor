use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::Deserialize;
use tracing::{debug, warn, info};

const BIRDEYE_API_URL: &str = "https://public-api.birdeye.so";
const PUMPFUN_API_URL: &str = "https://frontend-api.pump.fun";

// Pump.fun tokens have 1 billion total supply with 6 decimals
const PUMP_FUN_TOTAL_SUPPLY: f64 = 1_000_000_000.0;

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
struct PumpFunCoin {
    mint: String,
    #[serde(default)]
    market_cap: f64,
    #[serde(default)]
    usd_market_cap: f64,
    #[serde(default)]
    virtual_sol_reserves: Option<f64>,
    #[serde(default)]
    virtual_token_reserves: Option<f64>,
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
    /// First tries pump.fun API (no rate limit), falls back to Birdeye
    pub async fn get_price(&self, token_mint: &str) -> Result<f64> {
        // 1. Try pump.fun API first (no rate limit, works for pump.fun tokens)
        if let Ok(price) = self.get_price_from_pumpfun(token_mint).await {
            return Ok(price);
        }

        // 2. Fall back to Birdeye for non-pump.fun tokens
        self.get_price_from_birdeye(token_mint).await
    }

    /// Get price from pump.fun API (no rate limit)
    async fn get_price_from_pumpfun(&self, token_mint: &str) -> Result<f64> {
        let url = format!("{}/coins/{}", PUMPFUN_API_URL, token_mint);

        let response = self.client
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(anyhow!("pump.fun API error: {}", response.status()));
        }

        let coin: PumpFunCoin = response.json().await?;

        // Calculate price from market cap or reserves
        let price = if coin.usd_market_cap > 0.0 {
            // MCap / Total Supply = Price
            coin.usd_market_cap / PUMP_FUN_TOTAL_SUPPLY
        } else if let (Some(sol_reserves), Some(token_reserves)) = (coin.virtual_sol_reserves, coin.virtual_token_reserves) {
            // Bonding curve price calculation
            // This is approximate - actual price depends on SOL/USD rate
            if token_reserves > 0.0 {
                // Get SOL price (use a rough estimate or fetch from elsewhere)
                let sol_price_usd = 200.0; // TODO: Get actual SOL price
                (sol_reserves / token_reserves) * sol_price_usd
            } else {
                return Err(anyhow!("No price data from pump.fun"));
            }
        } else {
            return Err(anyhow!("No market cap or reserves from pump.fun"));
        };

        debug!("pump.fun price for {}: ${:.10}", &token_mint[..8.min(token_mint.len())], price);
        Ok(price)
    }

    /// Get price from Birdeye API
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
