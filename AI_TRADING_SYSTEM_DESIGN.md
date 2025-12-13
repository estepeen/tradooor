# AI Trading System - Architektura a Implementační Plán

## 🎯 Cíl

Vytvořit AI/LLM-powered trading systém, který:
- **Analyzuje** data z tracked wallets
- **Rozhoduje** kdy a co nakoupit/prodat pomocí LLM
- **Paper trading** - obchoduje na nečisto (simulace)
- **Učí se** z výsledků a zlepšuje se

## 📊 Co už máme připravené

### ✅ Data Infrastructure
- **ClosedLot** - bohatá data o každém uzavřeném trade (PnL, timing, market conditions)
- **Trade** - všechny obchody tracked wallets
- **SmartWallet** - metriky traderů (score, win rate, PnL)
- **Token** - metadata tokenů
- **CopytradingAnalyticsService** - analýza pro copytrading insights

### ✅ Dostupné metriky
- Wallet metrics: score, win rate, avg PnL %, recent PnL 30d
- Trade patterns: DCA, re-entry, scalping, swing trading
- Market conditions: entry/exit market cap, liquidity, volume
- Timing: entry/exit hour, day of week, hold time
- Risk management: stop-loss, take-profit detection

## 🏗️ Navrhovaná Architektura

### 1. **AI Decision Engine** (Jádro systému)

```
┌─────────────────────────────────────────────────────────┐
│              AI Trading Decision Engine                  │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  1. Signal Detection                                    │
│     └─ Monitoruje tracked wallets pro nové trades      │
│                                                          │
│  2. Context Builder                                     │
│     └─ Sestaví kontext pro LLM:                         │
│        - Wallet metrics                                 │
│        - Token data                                     │
│        - Market conditions                              │
│        - Historical patterns                            │
│        - Risk factors                                   │
│                                                          │
│  3. LLM Decision Maker                                  │
│     └─ Volá LLM API s kontextem                         │
│        - Prompt engineering                             │
│        - Structured output (JSON)                       │
│        - Confidence scoring                             │
│                                                          │
│  4. Risk Validator                                     │
│     └─ Validuje rozhodnutí proti risk rules            │
│                                                          │
│  5. Paper Trade Executor                                │
│     └─ Simuluje trade (ne skutečný)                    │
│                                                          │
│  6. Performance Tracker                                │
│     └─ Sleduje výsledky paper trades                   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 2. **LLM Integration Options**

#### Option A: OpenAI GPT-4/GPT-4 Turbo (Doporučeno)
**Výhody:**
- ✅ Nejlepší reasoning schopnosti
- ✅ Structured output (JSON mode)
- ✅ Function calling pro data fetching
- ✅ Konzistentní výsledky

**Nevýhody:**
- ❌ Cena (~$0.01-0.03 per decision)
- ❌ Latence (~1-3 sekundy)

**Použití:**
```typescript
// Prompt pro BUY decision
const buyPrompt = `
You are an expert crypto trader analyzing a potential trade.

WALLET METRICS:
- Score: ${wallet.score}/100
- Win Rate: ${wallet.winRate * 100}%
- Recent PnL (30d): ${wallet.recentPnl30dPercent}%
- Avg Hold Time: ${wallet.avgHoldingTimeMin} minutes

TOKEN DATA:
- Symbol: ${token.symbol}
- Market Cap: $${marketCap}
- Liquidity: $${liquidity}
- 24h Volume: $${volume24h}
- Token Age: ${tokenAgeMinutes} minutes

TRADER PATTERNS:
- Best Entry Time: ${bestEntryHour}h
- Preferred Token Age: ${preferredTokenAgeRange}
- Success Rate for Similar Trades: ${similarTradesWinRate}%

CURRENT MARKET CONDITIONS:
- SOL Price: $${solPrice}
- Market Trend: ${marketTrend}
- Volatility: ${volatility}

HISTORICAL PERFORMANCE:
${historicalTradesSummary}

Based on this data, should we BUY this token? Consider:
1. Wallet's track record with similar tokens
2. Current market conditions
3. Risk/reward ratio
4. Timing factors

Respond in JSON format:
{
  "decision": "BUY" | "SKIP",
  "confidence": 0.0-1.0,
  "reasoning": "explanation",
  "suggestedPositionSize": "percentage of portfolio",
  "stopLoss": "percentage",
  "takeProfit": "percentage",
  "expectedHoldTime": "minutes"
}
`;
```

#### Option B: Anthropic Claude 3.5 Sonnet
**Výhody:**
- ✅ Vynikající reasoning
- ✅ Velký context window (200k tokens)
- ✅ Structured output
- ✅ O něco levnější než GPT-4

**Nevýhody:**
- ❌ Stále relativně drahé
- ❌ Méně rozšířené než OpenAI

#### Option C: Local LLM (Ollama/Llama 3.1 70B)
**Výhody:**
- ✅ Zdarma (běží lokálně)
- ✅ Žádné API limity
- ✅ Soukromí dat

**Nevýhody:**
- ❌ Vyžaduje GPU (8GB+ VRAM)
- ❌ Pomalejší než cloud API
- ❌ Méně přesné než GPT-4/Claude

**Doporučení:** Začít s **GPT-4 Turbo** (nejlepší poměr cena/výkon), později možná hybrid (GPT-4 pro kritické rozhodnutí, local LLM pro jednodušší).

### 3. **Paper Trading System**

#### Database Schema
```sql
-- Paper Trading Positions
CREATE TABLE "PaperTrade" (
  "id" TEXT PRIMARY KEY,
  "walletId" TEXT REFERENCES "SmartWallet"("id"),
  "tokenId" TEXT REFERENCES "Token"("id"),
  "side" TEXT NOT NULL, -- 'buy' | 'sell'
  "amountToken" DECIMAL(36, 18),
  "amountBase" DECIMAL(36, 18),
  "priceBasePerToken" DECIMAL(36, 18),
  "timestamp" TIMESTAMP WITH TIME ZONE,
  "aiDecisionId" TEXT, -- Reference na AI decision
  "status" TEXT, -- 'pending' | 'executed' | 'cancelled'
  "realizedPnl" DECIMAL(36, 18), -- Po uzavření
  "meta" JSONB -- AI reasoning, confidence, etc.
);

-- AI Decisions Log
CREATE TABLE "AIDecision" (
  "id" TEXT PRIMARY KEY,
  "walletId" TEXT REFERENCES "SmartWallet"("id"),
  "tokenId" TEXT REFERENCES "Token"("id"),
  "decisionType" TEXT, -- 'BUY' | 'SELL' | 'SKIP'
  "confidence" DECIMAL(5, 4), -- 0.0-1.0
  "reasoning" TEXT,
  "context" JSONB, -- Všechna data použitá pro rozhodnutí
  "llmModel" TEXT, -- 'gpt-4-turbo', 'claude-3.5-sonnet', etc.
  "llmResponse" JSONB, -- Raw LLM response
  "timestamp" TIMESTAMP WITH TIME ZONE,
  "executed" BOOLEAN DEFAULT false, -- Bylo rozhodnutí provedeno?
  "paperTradeId" TEXT REFERENCES "PaperTrade"("id")
);

-- Paper Trading Portfolio
CREATE TABLE "PaperPortfolio" (
  "id" TEXT PRIMARY KEY,
  "totalValueUsd" DECIMAL(36, 18),
  "totalCostUsd" DECIMAL(36, 18),
  "totalPnlUsd" DECIMAL(36, 18),
  "totalPnlPercent" DECIMAL(10, 4),
  "openPositions" INT,
  "closedPositions" INT,
  "winRate" DECIMAL(5, 4),
  "timestamp" TIMESTAMP WITH TIME ZONE
);
```

### 4. **Workflow**

```
1. Signal Detection (Real-time)
   └─ Webhook/Worker detekuje nový BUY trade od tracked wallet
      ↓
2. Context Building
   └─ AI Decision Service sestaví kontext:
      - Wallet metrics
      - Token data (market cap, liquidity, volume)
      - Market conditions
      - Historical patterns
      - Risk factors
      ↓
3. LLM Decision
   └─ Volá LLM API s promptem
      ↓
4. Decision Validation
   └─ Validuje proti risk rules:
      - Max position size
      - Max daily loss
      - Min liquidity
      - Min confidence threshold
      ↓
5. Paper Trade Execution
   └─ Pokud BUY: vytvoří PaperTrade
      - Simuluje nákup za aktuální cenu
      - Sleduje pozici
      ↓
6. Exit Signal Detection
   └─ Monitoruje:
      - Trader prodal (SELL signal)
      - Stop-loss hit
      - Take-profit hit
      - Time-based exit
      ↓
7. Exit Decision
   └─ LLM rozhodne o prodeji
      ↓
8. Paper Trade Closure
   └─ Uzavře pozici, vypočítá PnL
      ↓
9. Performance Analysis
   └─ Analyzuje výsledky, učí se
```

## 🚀 Implementační Plán

### Fáze 1: Základní Paper Trading (Bez AI)
**Cíl:** Ověřit infrastrukturu

1. ✅ Vytvořit PaperTrade tabulku
2. ✅ Vytvořit PaperTradeService
3. ✅ Implementovat jednoduchý copytrading (kopíruje všechny BUY)
4. ✅ Sledovat paper portfolio
5. ✅ Dashboard pro paper trades

**Čas:** 1-2 dny

### Fáze 2: AI Decision Engine (Základní)
**Cíl:** Přidat LLM rozhodování

1. ✅ Vytvořit AIDecisionService
2. ✅ Integrovat OpenAI API
3. ✅ Vytvořit prompt templates
4. ✅ Implementovat context builder
5. ✅ Logovat všechna rozhodnutí

**Čas:** 2-3 dny

### Fáze 3: Pokročilé Features
**Cíl:** Zlepšit kvalitu rozhodnutí

1. ✅ Risk management rules
2. ✅ Position sizing logic
3. ✅ Stop-loss/take-profit automation
4. ✅ Multi-wallet aggregation
5. ✅ Confidence-based filtering

**Čas:** 3-5 dní

### Fáze 4: Learning & Optimization
**Cíl:** Systém se učí z výsledků

1. ✅ Performance tracking
2. ✅ A/B testing různých prompts
3. ✅ Fine-tuning podle výsledků
4. ✅ Pattern recognition improvements
5. ✅ Auto-adjustment confidence thresholds

**Čas:** 5-7 dní

## 💡 Best Practices

### 1. Prompt Engineering
- **Structured Output:** Vždy požádej o JSON
- **Few-shot Examples:** Ukaž příklady dobrých rozhodnutí
- **Chain of Thought:** Požádej LLM, aby vysvětlil reasoning
- **Context Window:** Použij relevantní data, ne všechno

### 2. Risk Management
- **Max Position Size:** Max 5-10% portfolia na trade
- **Max Daily Loss:** Pozastavit trading při -5% denně
- **Min Confidence:** Trade pouze pokud confidence > 0.7
- **Diversification:** Max 3-5 otevřených pozic najednou

### 3. Performance Tracking
- **Track Everything:** Každé rozhodnutí, každý trade
- **Compare Strategies:** A/B test různé prompty
- **Learn from Mistakes:** Analyzuj špatné trades
- **Iterate Fast:** Měň prompty podle výsledků

### 4. Cost Optimization
- **Batch Decisions:** Seskupit podobné rozhodnutí
- **Cache Context:** Ukládat sestavený kontext
- **Selective LLM Calls:** Použít LLM jen pro důležitá rozhodnutí
- **Local LLM Fallback:** Pro jednodušší rozhodnutí použít local LLM

## 📈 Metriky pro Hodnocení

### Paper Trading Performance
- **Total PnL %** - Celkový zisk/ztráta
- **Win Rate** - % ziskových trades
- **Avg PnL per Trade** - Průměrný zisk
- **Sharpe Ratio** - Risk-adjusted returns
- **Max Drawdown** - Maximální pokles
- **Profit Factor** - Gross profit / Gross loss

### AI Decision Quality
- **Decision Accuracy** - % správných rozhodnutí
- **Confidence Calibration** - Jak dobře confidence predikuje úspěch
- **False Positive Rate** - % špatných BUY signálů
- **False Negative Rate** - % zmeškaných dobrých příležitostí

## 🔧 Technické Detaily

### API Integration
```typescript
// OpenAI Integration
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function makeTradingDecision(context: TradingContext): Promise<AIDecision> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4-turbo-preview',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You are an expert crypto trader...'
      },
      {
        role: 'user',
        content: buildPrompt(context)
      }
    ],
    temperature: 0.3, // Lower = more consistent
  });
  
  return parseDecision(response.choices[0].message.content);
}
```

### Paper Trade Service
```typescript
class PaperTradeService {
  async executeBuy(decision: AIDecision): Promise<PaperTrade> {
    // 1. Validate decision
    // 2. Calculate position size
    // 3. Get current token price
    // 4. Create PaperTrade record
    // 5. Update paper portfolio
  }
  
  async executeSell(paperTrade: PaperTrade, decision: AIDecision): Promise<void> {
    // 1. Get current token price
    // 2. Calculate realized PnL
    // 3. Update PaperTrade status
    // 4. Update paper portfolio
  }
  
  async getPortfolio(): Promise<PaperPortfolio> {
    // Calculate current portfolio value
    // Sum all open positions
    // Calculate total PnL
  }
}
```

## 🎯 Doporučení

### Pro Start
1. **Začni jednoduše:** Základní copytrading bez AI
2. **Přidej AI postupně:** Nejdřív pro BUY, pak pro SELL
3. **Track vše:** Každé rozhodnutí, každý trade
4. **Iteruj rychle:** Měň prompty podle výsledků

### Pro Scale
1. **Multi-model:** Zkus různé LLM modely
2. **Ensemble:** Kombinuj rozhodnutí z více modelů
3. **Fine-tuning:** Fine-tune model na vlastních datech
4. **Reinforcement Learning:** Uč se z výsledků

### Pro Production
1. **Risk Limits:** Přísné limity na position size, daily loss
2. **Monitoring:** Alerting při anomáliích
3. **Backtesting:** Testuj strategie na historických datech
4. **Gradual Rollout:** Začni s malým kapitálem, postupně zvyšuj

## 📝 Next Steps

1. **Vytvoř PaperTrade tabulku** v databázi
2. **Implementuj PaperTradeService** pro základní paper trading
3. **Vytvoř AIDecisionService** s OpenAI integrací
4. **Vytvoř prompt templates** pro BUY/SELL rozhodnutí
5. **Implementuj signal detection** (monitor nové trades)
6. **Vytvoř dashboard** pro paper trading performance
7. **Spusť paper trading** a sleduj výsledky
8. **Iteruj a zlepšuj** podle výsledků

---

**Ready to start?** Začni s Fází 1 - základní paper trading bez AI, pak postupně přidávej AI vrstvu.
