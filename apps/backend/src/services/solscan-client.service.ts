import dotenv from 'dotenv';

dotenv.config();

type SolscanPortfolioResponse = {
  success: boolean;
  data?: {
    total_value?: number;
    native_balance?: {
      amount?: number;
      balance?: number;
      token_price?: number;
      token_decimals?: number;
      token_name?: string;
      token_symbol?: string;
      token_icon?: string;
      value?: number;
    };
    tokens?: Array<{
      token_address: string;
      amount?: number;
      balance?: number;
      token_price?: number;
      token_decimals?: number;
      token_name?: string;
      token_symbol?: string;
      token_icon?: string;
      value?: number;
    }>;
  };
};

export class SolscanClient {
  private apiKey?: string;
  private baseUrl: string;
  private publicBaseUrl: string;

  constructor() {
    this.apiKey = process.env.SOLSCAN_API_KEY || process.env.SOLSCAN_TOKEN || process.env.SOLSCAN_KEY;
    this.baseUrl = process.env.SOLSCAN_API_URL || 'https://pro-api.solscan.io/v2.0';
    this.publicBaseUrl = process.env.SOLSCAN_PUBLIC_API_URL || 'https://public-api.solscan.io';
    if (!this.apiKey) {
      console.warn('⚠️  SolscanClient: SOLSCAN_API_KEY is not set. Live portfolio refresh will be disabled.');
    }
  }

  isAvailable() {
    return !!this.apiKey;
  }

  async getAccountPortfolio(address: string, excludeLowScoreTokens = true): Promise<SolscanPortfolioResponse['data'] | null> {
    if (!this.apiKey) return null;
    const url = new URL(`${this.baseUrl}/account/portfolio`);
    url.searchParams.set('address', address);
    if (excludeLowScoreTokens) url.searchParams.set('exclude_low_score_tokens', 'true');

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        // Solscan pro API expects 'token' header
        token: this.apiKey,
      } as any,
    });

    if (!res.ok) {
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => '');
      }
      const details = typeof body === 'string' ? body : JSON.stringify(body);
      const err = new Error(`Solscan API error: ${res.status} ${res.statusText} - ${details}`);
      // Attach status for route handler
      (err as any).status = res.status;
      throw err;
    }
    const json = (await res.json()) as SolscanPortfolioResponse;
    if (!json?.success) {
      return null;
    }
    return json.data ?? null;
  }

  /**
   * PUBLIC API (no key): GET /account/tokens?address=...
   * Returns array of token holdings (may include priceUsdt for some).
   * Docs: https://pro-api.solscan.io/pro-api-docs/v2.0/reference/v2-account-portfolio (concept),
   * but here we use public v1: /account/tokens
   */
  async getPublicAccountTokens(address: string): Promise<any[]> {
    const url = `${this.publicBaseUrl}/account/tokens?address=${address}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json' } as any,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`Solscan public API error: ${res.status} ${res.statusText} - ${txt}`);
      (err as any).status = res.status;
      throw err;
    }
    const tokens = await res.json();
    return Array.isArray(tokens) ? tokens : [];
  }

  /**
   * PUBLIC API: GET /account?address=...
   * Useful to get lamports for native SOL balance.
   */
  async getPublicAccount(address: string): Promise<{ lamports?: number } | null> {
    const url = `${this.publicBaseUrl}/account?address=${address}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json' } as any,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`Solscan public API error: ${res.status} ${res.statusText} - ${txt}`);
      (err as any).status = res.status;
      throw err;
    }
    try {
      const json = await res.json();
      return json || null;
    } catch {
      return null;
    }
  }

  /**
   * Get transaction details from Solscan API
   * Pro API: GET /transaction/details?tx={signature}
   * Public API: GET /transaction?tx={signature}
   * 
   * Returns transaction value in USD if available, or SOL amount (caller converts to USD)
   */
  async getTransactionValue(txSignature: string): Promise<number | null> {
    // Try Pro API first if we have API key (better data quality)
    if (this.apiKey) {
      try {
        const url = `${this.baseUrl}/transaction/details?tx=${txSignature}`;
        const res = await fetch(url, {
          headers: {
            accept: 'application/json',
            token: this.apiKey,
          } as any,
        });

        if (res.ok) {
          const data = await res.json() as {
            success?: boolean;
            data?: {
              valueUsd?: string | number;
              nativeTransfers?: Array<{ amount?: string; lamport?: string }>;
              solTransfers?: Array<{ amount?: string }>;
              tokenTransfers?: Array<{ valueUsd?: string | number }>;
            };
            solTransfers?: Array<{ amount?: string }>;
          };
          console.log(`   📊 Solscan Pro API response for ${txSignature.substring(0, 16)}...:`, JSON.stringify(data).substring(0, 500));
          
          // Pro API structure - look for USD value or SOL amount
          if (data?.success && data?.data) {
            // Try to get USD value directly
            if (data.data.valueUsd !== undefined && data.data.valueUsd !== null) {
              const valueUsd = parseFloat(String(data.data.valueUsd));
              if (valueUsd > 0) {
                console.log(`   ✅ Got USD value from Solscan Pro API: $${valueUsd.toFixed(2)}`);
                return valueUsd;
              }
            }
            
            // Try to get total value from native balance changes
            if (data.data.nativeTransfers && Array.isArray(data.data.nativeTransfers)) {
              let totalSol = 0;
              for (const transfer of data.data.nativeTransfers) {
                const amount = parseFloat(transfer.amount || transfer.lamport || '0');
                if (amount > 0) {
                  totalSol += amount / 1e9; // Convert lamports to SOL
                }
              }
              if (totalSol > 0) {
                console.log(`   ✅ Got SOL amount from Solscan Pro API: ${totalSol.toFixed(6)} SOL`);
                return totalSol; // Return SOL, caller converts to USD
              }
            }
            
            // Or get SOL amount from solTransfers
            if (data.data.solTransfers && Array.isArray(data.data.solTransfers)) {
              let totalSol = 0;
              for (const transfer of data.data.solTransfers) {
                const amount = parseFloat(transfer.amount || '0');
                if (amount > 0) totalSol += amount;
              }
              if (totalSol > 0) {
                console.log(`   ✅ Got SOL amount from Solscan Pro API (solTransfers): ${totalSol.toFixed(6)} SOL`);
                return totalSol; // Return SOL, caller converts to USD
              }
            }
            
            // Try token transfers with USD value
            if (data.data.tokenTransfers && Array.isArray(data.data.tokenTransfers)) {
              for (const transfer of data.data.tokenTransfers) {
                if (transfer.valueUsd !== undefined && transfer.valueUsd !== null) {
                  const valueUsd = parseFloat(String(transfer.valueUsd));
                  if (valueUsd > 0) {
                    console.log(`   ✅ Got USD value from token transfer: $${valueUsd.toFixed(2)}`);
                    return valueUsd;
                  }
                }
              }
            }
          }
        } else {
          const errorText = await res.text().catch(() => '');
          console.warn(`⚠️  Solscan Pro API error (${res.status}): ${errorText.substring(0, 200)}`);
        }
      } catch (error: any) {
        console.warn(`⚠️  Error fetching transaction value from Solscan Pro API: ${error.message}`);
      }
    }

    // Fallback to Public API if Pro API failed or no API key
    try {
      const url = `${this.publicBaseUrl}/transaction?tx=${txSignature}`;
      const res = await fetch(url, {
        headers: { accept: 'application/json' } as any,
      });
      if (res.ok) {
        const data = await res.json() as { solTransfers?: Array<{ amount?: string }> };
        // Public API might have different structure, try to extract value
        const dataTyped = data;
        if (dataTyped?.solTransfers && Array.isArray(dataTyped.solTransfers)) {
          // Sum up SOL transfers
          let totalSol = 0;
          for (const transfer of dataTyped.solTransfers) {
            const amount = parseFloat(transfer.amount || '0');
            if (amount > 0) totalSol += amount;
          }
          if (totalSol > 0) {
            console.log(`   ✅ Got SOL amount from Solscan Public API: ${totalSol.toFixed(6)} SOL`);
            return totalSol; // Return SOL, caller converts to USD
          }
        }
      }
    } catch (error: any) {
      console.warn(`⚠️  Error fetching transaction value from Solscan Public API: ${error.message}`);
    }

    return null;
  }

  /**
   * Get the largest SOL amount from a transaction (for swap value detection)
   * Returns the largest SOL transfer amount in SOL (not USD)
   * This is used to get the actual swap value instead of just fees
   */
  async getLargestSolAmount(txSignature: string): Promise<number | null> {
    if (!this.apiKey) {
      // Try public API as fallback
      try {
        const url = `${this.publicBaseUrl}/transaction?tx=${txSignature}`;
        const res = await fetch(url, {
          headers: { accept: 'application/json' } as any,
        });
        if (res.ok) {
          const data = await res.json() as { solTransfers?: Array<{ amount?: string }> };
          if (data?.solTransfers && Array.isArray(data.solTransfers)) {
            let largestSol = 0;
            for (const transfer of data.solTransfers) {
              const amount = parseFloat(transfer.amount || '0');
              if (amount > largestSol) {
                largestSol = amount;
              }
            }
            if (largestSol > 0) {
              console.log(`   ✅ Got largest SOL amount from Solscan Public API: ${largestSol.toFixed(6)} SOL`);
              return largestSol;
            }
          }
        }
      } catch (error: any) {
        console.warn(`⚠️  Error fetching from Solscan Public API: ${error.message}`);
      }
      return null;
    }

    // Try Pro API first
    try {
      const url = `${this.baseUrl}/transaction/details?tx=${txSignature}`;
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          token: this.apiKey,
        } as any,
      });

      if (res.ok) {
        const data = await res.json() as {
          success?: boolean;
          data?: {
            nativeTransfers?: Array<{ amount?: string; lamport?: string }>;
            solTransfers?: Array<{ amount?: string }>;
          };
        };

        let largestSol = 0;

        if (data?.success && data?.data) {
          // Check nativeTransfers (in lamports)
          if (data.data.nativeTransfers && Array.isArray(data.data.nativeTransfers)) {
            for (const transfer of data.data.nativeTransfers) {
              const amountLamports = parseFloat(transfer.amount || transfer.lamport || '0');
              const amountSol = amountLamports / 1e9;
              if (amountSol > largestSol) {
                largestSol = amountSol;
              }
            }
          }

          // Check solTransfers (already in SOL)
          if (data.data.solTransfers && Array.isArray(data.data.solTransfers)) {
            for (const transfer of data.data.solTransfers) {
              const amount = parseFloat(transfer.amount || '0');
              if (amount > largestSol) {
                largestSol = amount;
              }
            }
          }
        }

        if (largestSol > 0) {
          console.log(`   ✅ Got largest SOL amount from Solscan Pro API: ${largestSol.toFixed(6)} SOL`);
          return largestSol;
        }
      } else {
        const errorText = await res.text().catch(() => '');
        console.warn(`⚠️  Solscan Pro API error (${res.status}): ${errorText.substring(0, 200)}`);
      }
    } catch (error: any) {
      console.warn(`⚠️  Error fetching largest SOL amount from Solscan Pro API: ${error.message}`);
    }

    // Fallback to Public API
    try {
      const url = `${this.publicBaseUrl}/transaction?tx=${txSignature}`;
      const res = await fetch(url, {
        headers: { accept: 'application/json' } as any,
      });
      if (res.ok) {
        const data = await res.json() as { solTransfers?: Array<{ amount?: string }> };
        if (data?.solTransfers && Array.isArray(data.solTransfers)) {
          let largestSol = 0;
          for (const transfer of data.solTransfers) {
            const amount = parseFloat(transfer.amount || '0');
            if (amount > largestSol) {
              largestSol = amount;
            }
          }
          if (largestSol > 0) {
            console.log(`   ✅ Got largest SOL amount from Solscan Public API: ${largestSol.toFixed(6)} SOL`);
            return largestSol;
          }
        }
      }
    } catch (error: any) {
      console.warn(`⚠️  Error fetching largest SOL amount from Solscan Public API: ${error.message}`);
    }

    return null;
  }
}


