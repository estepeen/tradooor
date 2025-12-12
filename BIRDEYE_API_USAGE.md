# Birdeye API Usage Analysis

## Current Usage (100 wallets)

### Token Prices (Portfolio endpoint)

**Assumptions:**
- 100 wallets
- Average number of closed positions per wallet varies
- Frontend refresh: every 10 minutes
- Backend cache TTL: 10 minutes
- Batch size: 10 tokens per request

**Calculations:**
- Requests per refresh: 1000 tokens / 10 = 100 requests
- Refreshes per hour: 6 (every 10 minutes)
- Refreshes per day: 144
- Refreshes per month: 4,320
- **Total requests per month (no cache): 432,000**

**With cache (realistic):**
- Cache TTL = 10 minutes
- First request in each window makes API calls
- **Total requests per month: ~432,000** (if cache expires exactly when refresh happens)

**Problem:** Race condition between cache expiry and refresh timing means most requests still hit API.

### Token Metadata (Collector service)

**Assumptions:**
- Collector runs every 5 minutes
- Average 5-10 new tokens per collection round
- Batch size: 5 tokens per request

**Calculations:**
- Requests per collection: 10 tokens / 5 = 2 requests
- Collections per hour: 12 (every 5 minutes)
- Collections per day: 288
- Collections per month: 8,640
- **Total requests per month: ~17,280**

### Total Monthly Usage (Current)

**Worst case (no cache):**
- Token prices: 432,000 requests
- Token metadata: 17,280 requests
- **Total: ~449,280 requests/month**

**Realistic (with cache):**
- Token prices: ~200,000-300,000 requests (cache reduces but not perfectly)
- Token metadata: 17,280 requests
- **Total: ~217,280-317,280 requests/month**

**Limit: 30,000 requests/month**

## Optimizations Needed

### 1. Increase Cache TTL (Critical)
- Change token price cache from 10 minutes to **30 minutes**
- Reduces refresh frequency by 3x
- **Impact: ~100,000-150,000 requests/month saved**

### 2. Increase Frontend Refresh Interval
- Change from 10 minutes to **30 minutes**
- Users can manually refresh if needed
- **Impact: ~200,000 requests/month saved**

### 3. Optimize Batch Size
- Current: 10 tokens per request
- Birdeye API may support larger batches
- **Impact: ~50,000 requests/month saved**

### 4. Add Deduplication
- Don't fetch prices for tokens already fetched in same request batch
- **Impact: ~20,000 requests/month saved**

### 5. Reduce Collector Frequency
- Current: every 5 minutes
- Change to **15 minutes** (3x reduction)
- **Impact: ~11,500 requests/month saved**

## Optimized Usage (After Optimizations)

### Token Prices
- Refresh: every 30 minutes
- Cache TTL: 30 minutes
- Refreshes per month: 1,440
- Requests per refresh: 100
- **Total: ~144,000 requests/month**

### Token Metadata
- Collections per month: 2,880 (every 15 minutes)
- Requests per collection: 2
- **Total: ~5,760 requests/month**

### Total Optimized: ~150,000 requests/month

**Still exceeds limit!** Need additional optimizations:

### Additional Optimizations

6. **Server-side caching layer (Redis/database)**
   - Store prices in database with TTL
   - All users share same cache
   - **Impact: Could reduce to ~50,000 requests/month**

7. **Price update service (cron job)**
   - Background service updates prices every 30 minutes
   - Frontend always reads from database cache
   - **Impact: ~50,000 requests/month**

8. **Lazy loading**
   - Only fetch prices when user opens portfolio tab
   - Don't fetch on page load
   - **Impact: ~50,000 requests/month saved**

## Recommended Implementation

1. ✅ Increase cache TTL to 30 minutes
2. ✅ Increase frontend refresh to 30 minutes
3. ✅ Remove legacy Solana collector (Helius webhook only, zero polling)
4. ⚠️ Implement database-backed price cache (critical for 100 wallets)
5. ⚠️ Consider price update cron job instead of on-demand fetching

## Expected Final Usage

With all optimizations:
- **Token prices: ~50,000 requests/month** (database cache + cron)
- **Token metadata: ~5,760 requests/month**
- **Total: ~55,760 requests/month**

**Still exceeds 30,000 limit!** May need:
- Upgrade Birdeye plan
- Or implement hybrid approach (Birdeye + DexScreener fallback)






