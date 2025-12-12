# Helius Webhooks Setup

This document describes how to set up Helius webhooks for real-time transaction tracking.

## Overview

Helius webhooks enable real-time notifications about transactions for tracked wallet addresses. Instead of polling every minute, we receive a notification immediately when a wallet performs a swap.

## Benefits

- ✅ **Real-time updates** - trades are saved immediately after execution
- ✅ **Fewer API calls** - only when there's a new transaction (not every minute)
- ✅ **More efficient** - for 50 wallets with average 100 swaps per month = 5,000 credits (in free plan)
- ✅ **Automatic** - no manual refresh needed

## Setup

### 1. Environment Variables

Add to `.env` file:

```env
# Helius API Key (required)
HELIUS_API_KEY=your_helius_api_key

# Webhook URL (optional - if not set, uses API_URL + /api/webhooks/helius)
HELIUS_WEBHOOK_URL=https://your-domain.com/api/webhooks/helius

# Or use API_URL (if HELIUS_WEBHOOK_URL is not set)
API_URL=https://your-domain.com
```

**Important for production:**
- Webhook URL must be publicly accessible (Helius must be able to send POST request)
- For localhost development, use a tool like [ngrok](https://ngrok.com/) or [localtunnel](https://localtunnel.github.io/www/)

### 2. Webhook Initialization

After setting environment variables:

1. **Start backend server:**
```bash
pnpm --filter backend dev
```

2. **Set up webhook for all existing wallets:**
```bash
curl -X POST http://localhost:3001/api/smart-wallets/setup-webhook
```

Or use frontend - a button for webhook setup will be added.

### 3. Automatic Webhook Creation

Webhook is automatically created/updated when:
- Adding new wallet (POST `/api/smart-wallets`)
- Synchronizing wallets (POST `/api/smart-wallets/sync`)

## How It Works

1. **Webhook creation:**
   - When adding a wallet, Helius webhook is created/updated
   - Webhook tracks all tracked wallet addresses
   - Helius allows up to 100,000 addresses in one webhook

2. **Receiving notifications:**
   - When a wallet performs a swap, Helius sends POST request to `/api/webhooks/helius`
   - Backend processes transaction and saves it to DB
   - Metrics are automatically recalculated

3. **Transaction processing:**
   - Swap normalization (same logic as polling)
   - Save to DB
   - PnL calculation (for SELL trades)
   - Metrics recalculation

## Closed Positions

Closed positions are calculated from ClosedLot (FIFO párované trades):
- **Closed Positions**: BUY trades that are closed by SELL trade (balance <= 0)
- **PnL**: Calculated from SOL difference (base currency) - `proceedsBase - costBase`

## Monitoring

Webhook endpoint logs:
- Number of received transactions
- Number of saved swaps
- Number of skipped (duplicates, non-swaps)
- Processing errors

## Troubleshooting

### Webhook is not working

1. **Check that webhook URL is publicly accessible:**
   ```bash
   curl -X POST https://your-domain.com/api/webhooks/helius
   ```

2. **Check Helius dashboard:**
   - Go to https://dashboard.helius.dev/
   - Check that webhook exists and has correct URL

3. **Check backend logs:**
   - Should show logs when receiving webhook notifications

### Webhook receives notifications but doesn't save trades

1. **Check that wallet address is in DB:**
   - Webhook searches for wallet by address from transaction
   - If wallet is not in DB, transaction is skipped

2. **Check logs:**
   - Should show reasons why trade wasn't added (duplicate, non-swap, etc.)

## Cost

- **Free plan**: 1 million credits per month
- **Each webhook notification**: 1 credit
- **For 50 wallets with average 100 swaps per month**: 5,000 credits → ✅ In free plan

## API Endpoints

- `POST /api/webhooks/helius` - Receive webhook notifications (called by Helius)
- `POST /api/smart-wallets/setup-webhook` - Set up webhook for all wallets
