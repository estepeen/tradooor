/**
 * AI Decision Service
 * 
 * LLM-powered rozhodovací vrstva pro trading signály.
 * Podporuje multiple providers:
 * - Groq (FREE, default) - Llama 3.1 70B, extrémně rychlé (~200ms)
 * - OpenAI GPT-4 / GPT-4o-mini
 * - Anthropic Claude 3.5 Sonnet
 * 
 * Features:
 * - Evaluace signálů
 * - Generování doporučení
 * - Position sizing
 * - Risk assessment
 */

import { AdvancedSignal, SignalContext, AdvancedSignalType } from './advanced-signals.service.js';
import { generateId } from '../lib/prisma.js';

// AI Decision types
export interface AIDecision {
  id: string;
  signalId?: string;
  tradeId?: string;
  tokenId: string;
  walletId?: string;
  decision: 'buy' | 'sell' | 'hold' | 'skip';
  confidence: number; // 0-100
  reasoning: string;
  suggestedPositionPercent?: number;
  stopLossPercent?: number;
  takeProfitPercent?: number;
  expectedHoldTimeMinutes?: number;
  riskScore: number; // 1-10
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  createdAt: Date;
  isFallback?: boolean; // true if this is a fallback decision (not from AI)
}

export interface AIContext {
  // Signal info
  signal?: AdvancedSignal;
  signalType?: AdvancedSignalType;
  
  // Wallet metrics
  walletScore: number;
  walletWinRate: number;
  walletRecentPnl30d: number;
  walletTotalTrades: number;
  walletAvgHoldTimeMin: number;
  
  // Token info
  tokenSymbol?: string;
  tokenAge: number;
  tokenLiquidity?: number;
  tokenVolume24h?: number;
  tokenMarketCap?: number;
  
  // Market context
  otherWalletsCount?: number;
  consensusStrength?: string;
  recentTokenPerformance?: number;
  
  // Historical performance on similar trades
  similarTradesCount?: number;
  similarTradesWinRate?: number;
  similarTradesAvgPnl?: number;
}

export type AIModel = 
  | 'groq'           // FREE - Llama 3.1 70B (default, recommended)
  | 'groq-fast'      // FREE - Llama 3.1 8B (faster, less accurate)
  | 'gpt-4-turbo' 
  | 'gpt-4o' 
  | 'gpt-4o-mini' 
  | 'claude-3-5-sonnet';

export interface AIDecisionConfig {
  model?: AIModel;
  temperature?: number;
  minConfidenceThreshold?: number;
  enableLogging?: boolean;
}

const DEFAULT_CONFIG: AIDecisionConfig = {
  model: 'groq',  // FREE! Llama 3.1 70B via Groq
  temperature: 0.3,
  minConfidenceThreshold: 60,
  enableLogging: true,
};

export class AIDecisionService {
  private config: AIDecisionConfig;
  private groqApiKey?: string;
  private openaiApiKey?: string;
  private anthropicApiKey?: string;

  constructor(config?: AIDecisionConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.groqApiKey = process.env.GROQ_API_KEY;
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    this.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    
    // Log which provider is being used
    const model = this.config.model || 'groq';
    if (model.startsWith('groq')) {
      if (this.groqApiKey) {
        console.log(`✅ [AI Decision] GROQ_API_KEY loaded (${this.groqApiKey.substring(0, 10)}...)`);
      } else {
        console.warn('⚠️  [AI Decision] GROQ_API_KEY not set - AI decisions will return null');
        console.warn('   💡 Set GROQ_API_KEY in .env file to enable AI decisions');
      }
    }
  }

  /**
   * Evaluuje signál pomocí LLM a vrací rozhodnutí
   */
  async evaluateSignal(
    signal: AdvancedSignal,
    context: AIContext
  ): Promise<AIDecision> {
    const startTime = Date.now();
    const model = this.config.model || 'groq';
    
    // Global switch to enable/disable AI layer
    if (process.env.ENABLE_AI_DECISIONS !== 'true') {
      console.warn(`⚠️  [AI Decision] AI layer disabled via ENABLE_AI_DECISIONS env - skipping evaluation for ${signal.type}`);
      return null as any;
    }
    
    try {
      console.log(`🤖 [AI Decision] Calling Groq API for ${signal.type} signal...`);
      console.log(`   Context: walletScore=${context.walletScore}, tokenAge=${context.tokenAge}min, liquidity=${context.tokenLiquidity ? `$${(context.tokenLiquidity / 1000).toFixed(1)}K` : 'unknown'}`);
      console.log(`   API Key: ${this.groqApiKey ? `${this.groqApiKey.substring(0, 10)}...` : 'NOT SET'}`);
      
      // Sestav prompt
      const prompt = this.buildPrompt(signal, context);
      console.log(`   📝 Prompt length: ${prompt.length} chars`);
      
      // Zavolej LLM
      console.log(`   🌐 Calling Groq API...`);
      const response = await this.callLLM(prompt);
      console.log(`   ✅ Groq API response received (${response.content.length} chars)`);
      
      // Parse odpověď
      const decision = this.parseResponse(response, signal, context);
      decision.latencyMs = Date.now() - startTime;
      decision.isFallback = false;
      
      console.log(`✅ [AI Decision] ${signal.type} signal evaluated: ${decision.decision} (${decision.confidence}% confidence, ${decision.latencyMs}ms)`);
      
      // Ulož do databáze
      if (this.config.enableLogging) {
        await this.saveDecision(decision, prompt, response);
      }
      
      return decision;
    } catch (error: any) {
      const errorMessage = error.message || String(error);
      const isRateLimit = errorMessage.includes('rate_limit') || errorMessage.includes('Rate limit');
      
      if (isRateLimit) {
        console.warn(`⚠️  [AI Decision] Rate limit reached for ${signal.type} signal - using fallback decision`);
        console.warn(`   💡 Consider upgrading Groq plan or reducing AI evaluation frequency`);
        
        // Return fallback decision instead of null when rate limited
        // This way Discord will still show AI decision (even if rule-based)
        const fallback = this.fallbackDecision(signal, context);
        fallback.isFallback = true; // Mark as fallback so caller knows it's not from AI
        return fallback;
      }
      
      console.error(`❌ [AI Decision] Error evaluating ${signal.type} signal:`, errorMessage);
      console.error(`   Error details:`, error);
      if (error.stack) {
        console.error(`   Stack:`, error.stack);
      }
      console.error(`   Returning null - no AI decision available`);
      
      // Return null for other errors - caller should handle this
      return null as any;
    }
  }

  /**
   * Batch evaluace více signálů
   */
  async evaluateSignals(
    signals: Array<{ signal: AdvancedSignal; context: AIContext }>
  ): Promise<AIDecision[]> {
    // Pro efektivitu zpracuj paralelně (max 5 současně)
    const batchSize = 5;
    const results: AIDecision[] = [];
    
    for (let i = 0; i < signals.length; i += batchSize) {
      const batch = signals.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(({ signal, context }) => this.evaluateSignal(signal, context))
      );
      results.push(...batchResults);
    }
    
    return results;
  }

  /**
   * Sestaví prompt pro LLM
   */
  private buildPrompt(signal: AdvancedSignal, context: AIContext): string {
    // Kompaktní prompt pro snížení spotřeby tokenů
    const walletInfo = `Score:${context.walletScore} WR:${(context.walletWinRate * 100).toFixed(0)}% PnL30d:${context.walletRecentPnl30d.toFixed(1)}%`;
    const tokenInfo = `${context.tokenSymbol || 'Unknown'} Age:${context.tokenAge.toFixed(0)}m${context.tokenLiquidity ? ` Liq:$${(context.tokenLiquidity/1000).toFixed(0)}K` : ''}${context.tokenVolume24h ? ` Vol24h:$${(context.tokenVolume24h/1000).toFixed(0)}K` : ''}`;
    const marketInfo = `${context.otherWalletsCount ? `Wallets:${context.otherWalletsCount}` : ''}${context.consensusStrength ? ` Strength:${context.consensusStrength}` : ''}`;
    
    return `Analyze Solana memecoin signal. Return JSON only.

Signal: ${signal.type} ${signal.strength} (${signal.confidence}% conf) ${signal.riskLevel} risk
Trader: ${walletInfo}
Token: ${tokenInfo}
${marketInfo ? `Market: ${marketInfo}` : ''}

Rules:
- New tokens (<30m): higher risk, smaller position
- High-score traders (>80): more aggressive
- Consensus (2+ wallets): increase confidence
- Max position: 20%
- Always set SL: 10-50%, TP: 20-200%

IMPORTANT for reasoning:
- Be concise but analytical: 2-3 sentences
- Round all numbers to max 2 decimals
- Include insight about profitability pattern:
  * "This setup historically profitable" or "Risky pattern - low success rate"
  * Mention if trader combo is strong/weak
  * Note any red/green flags (new token + high score = good, old token + low score = bad)
- Example: "Strong setup - 2 high-score traders (avg 75) on fresh 5m token with $24K liq. This combo typically yields 30-50% gains. LP locked adds safety."

JSON:
{"decision":"buy|sell|hold|skip","confidence":0-100,"reasoning":"2-3 analytical sentences with profitability insight","suggestedPositionPercent":5-20,"stopLossPercent":10-50,"takeProfitPercent":20-200,"expectedHoldTimeMinutes":5-1440,"riskScore":1-10}`;
  }

  /**
   * Zavolá LLM API
   */
  private async callLLM(prompt: string): Promise<{
    content: string;
    promptTokens?: number;
    completionTokens?: number;
  }> {
    const model = this.config.model || 'groq';
    
    if (model.startsWith('groq')) {
      return this.callGroq(prompt, model);
    } else if (model.startsWith('claude')) {
      return this.callClaude(prompt);
    } else {
      return this.callOpenAI(prompt, model);
    }
  }

  /**
   * Zavolá Groq API (FREE tier - Llama 3.1)
   * https://console.groq.com - get free API key
   */
  private async callGroq(prompt: string, model: string): Promise<{
    content: string;
    promptTokens?: number;
    completionTokens?: number;
  }> {
    if (!this.groqApiKey) {
      console.error(`❌ [AI Decision] GROQ_API_KEY not set in callGroq`);
      throw new Error('GROQ_API_KEY not set. Get free key at https://console.groq.com');
    }
    
    console.log(`   🔑 Using API key: ${this.groqApiKey.substring(0, 10)}...`);

    // Select model based on config
    // Note: llama-3.1-70b-versatile was decommissioned, using llama-3.3-70b-versatile as replacement
    const groqModel = model === 'groq-fast' 
      ? 'llama-3.1-8b-instant'      // Faster, less accurate
      : 'llama-3.3-70b-versatile';  // Default, best quality (replacement for decommissioned llama-3.1-70b-versatile)

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.groqApiKey}`,
      },
      body: JSON.stringify({
        model: groqModel,
        messages: [
          {
            role: 'system',
            content: 'You are an expert Solana memecoin trader. Always respond with valid JSON only, no markdown formatting, no code blocks.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: this.config.temperature || 0.3,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq API error: ${error}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
      
      const promptTokens = data.usage?.prompt_tokens || 0;
      const completionTokens = data.usage?.completion_tokens || 0;
      const totalTokens = data.usage?.total_tokens || (promptTokens + completionTokens);
      
      console.log(`   📊 Token usage: ${promptTokens} prompt + ${completionTokens} completion = ${totalTokens} total tokens`);
    
    return {
      content: data.choices?.[0]?.message?.content || '',
        promptTokens,
        completionTokens,
    };
  }

  /**
   * Zavolá OpenAI API
   */
  private async callOpenAI(prompt: string, model: string): Promise<{
    content: string;
    promptTokens?: number;
    completionTokens?: number;
  }> {
    if (!this.openaiApiKey) {
      throw new Error('OPENAI_API_KEY not set');
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert crypto trader. Always respond with valid JSON only, no markdown formatting.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: this.config.temperature || 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${error}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    
    return {
      content: data.choices?.[0]?.message?.content || '',
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    };
  }

  /**
   * Zavolá Anthropic Claude API
   */
  private async callClaude(prompt: string): Promise<{
    content: string;
    promptTokens?: number;
    completionTokens?: number;
  }> {
    if (!this.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `${prompt}\n\nRespond with valid JSON only, no markdown formatting.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error: ${error}`);
    }

    const data = await response.json() as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    
    return {
      content: data.content?.[0]?.text || '',
      promptTokens: data.usage?.input_tokens,
      completionTokens: data.usage?.output_tokens,
    };
  }

  /**
   * Parse LLM odpověď
   */
  private parseResponse(
    response: { content: string; promptTokens?: number; completionTokens?: number },
    signal: AdvancedSignal,
    context: AIContext
  ): AIDecision {
    try {
      // Vyčisti JSON (odstraň případné markdown backticks)
      let jsonContent = response.content.trim();
      if (jsonContent.startsWith('```')) {
        jsonContent = jsonContent.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      }
      
      const parsed = JSON.parse(jsonContent);
      
      return {
        id: generateId(),
        tokenId: '', // Will be set by caller
        decision: parsed.decision || 'skip',
        confidence: Math.min(100, Math.max(0, parsed.confidence || 0)),
        reasoning: parsed.reasoning || 'No reasoning provided',
        suggestedPositionPercent: Math.min(20, Math.max(5, parsed.suggestedPositionPercent || 10)),
        stopLossPercent: Math.min(50, Math.max(10, parsed.stopLossPercent || 20)),
        takeProfitPercent: Math.min(200, Math.max(20, parsed.takeProfitPercent || 50)),
        expectedHoldTimeMinutes: Math.min(1440, Math.max(5, parsed.expectedHoldTimeMinutes || 60)),
        riskScore: Math.min(10, Math.max(1, parsed.riskScore || 5)),
        model: this.config.model || 'groq',
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        createdAt: new Date(),
      };
    } catch (error) {
      console.error('Failed to parse LLM response:', error, response.content);
      return this.fallbackDecision(signal, context);
    }
  }

  /**
   * Fallback rozhodnutí (rule-based) pokud LLM selže
   */
  private fallbackDecision(signal: AdvancedSignal, context: AIContext): AIDecision {
    // Jednoduchá rule-based logika
    let decision: 'buy' | 'sell' | 'hold' | 'skip' = 'skip';
    let confidence = signal.confidence;
    let positionPercent = 10;
    let riskScore = 5;
    let stopLossPercent = 25;
    let takeProfitPercent = 50;
    let expectedHoldTimeMinutes = 120;

    // Základní pravidla
    if (signal.suggestedAction === 'buy' && signal.confidence >= 60) {
      decision = 'buy';
      
      // Adjust based on signal type
      if (signal.type === 'whale-entry' && context.walletScore >= 80) {
        confidence = Math.min(95, confidence + 10);
        positionPercent = 12;
        riskScore = 3;
        stopLossPercent = 20; // Tighter SL for high-quality whale
        takeProfitPercent = 75; // Higher TP for whale
      } else if (signal.type === 'consensus' || signal.type === 'consensus-update') {
        // Consensus signals - adjust based on wallet count and score
        const consensusStrength = context.otherWalletsCount || 1;
        if (consensusStrength >= 3) {
          confidence = Math.min(90, confidence + 8);
          positionPercent = 12;
          riskScore = 4;
          stopLossPercent = 22;
          takeProfitPercent = 60;
        } else if (consensusStrength >= 2) {
          confidence = Math.min(85, confidence + 5);
          positionPercent = 10;
          riskScore = 5;
          stopLossPercent = 25;
          takeProfitPercent = 50;
        }
      } else if (signal.type === 'hot-token' && context.otherWalletsCount && context.otherWalletsCount >= 3) {
        confidence = Math.min(90, confidence + 5);
        positionPercent = 10;
        riskScore = 4;
        stopLossPercent = 23;
        takeProfitPercent = 55;
      } else if (signal.type === 'early-sniper') {
        riskScore = 7; // Vyšší risk pro nové tokeny
        positionPercent = 7;
        stopLossPercent = 30; // Wider SL for new tokens
        takeProfitPercent = 80; // Higher TP potential
        expectedHoldTimeMinutes = 60; // Shorter hold for snipes
      } else if (signal.type === 'accumulation') {
        // Accumulation signals - more conservative
        riskScore = 6;
        positionPercent = 8;
        stopLossPercent = 28;
        takeProfitPercent = 65;
        expectedHoldTimeMinutes = 180; // Longer hold for accumulation
      }
      
      // Adjust based on wallet score
      if (context.walletScore >= 80) {
        confidence = Math.min(95, confidence + 5);
        riskScore = Math.max(1, riskScore - 1);
        positionPercent = Math.min(15, positionPercent + 2);
      } else if (context.walletScore < 60) {
        confidence = confidence * 0.8;
        riskScore = Math.min(10, riskScore + 1);
        positionPercent = Math.max(5, positionPercent - 2);
      }
      
      // Adjust based on token age
      if (context.tokenAge < 30) {
        // Very new token - more risky
        riskScore = Math.min(10, riskScore + 2);
        stopLossPercent = Math.max(30, stopLossPercent + 5);
        positionPercent = Math.max(5, positionPercent - 2);
      } else if (context.tokenAge > 1440) {
        // Older token - less risky
        riskScore = Math.max(1, riskScore - 1);
        stopLossPercent = Math.max(20, stopLossPercent - 3);
      }
      
      // Adjust based on liquidity
      if (context.tokenLiquidity && context.tokenLiquidity < 20000) {
        // Low liquidity - more risky
        riskScore = Math.min(10, riskScore + 1);
        stopLossPercent = Math.max(30, stopLossPercent + 3);
      } else if (context.tokenLiquidity && context.tokenLiquidity > 100000) {
        // High liquidity - less risky
        riskScore = Math.max(1, riskScore - 1);
        stopLossPercent = Math.max(20, stopLossPercent - 2);
      }
    } else if (signal.suggestedAction === 'sell') {
      decision = 'sell';
    }

    return {
      id: generateId(),
      tokenId: '',
      decision,
      confidence: Math.round(confidence),
      reasoning: `${signal.strength.charAt(0).toUpperCase() + signal.strength.slice(1)} ${signal.type} signal. Trader score ${Math.round(context.walletScore)}, token ${context.tokenAge >= 60 ? Math.round(context.tokenAge / 60) + 'h' : Math.round(context.tokenAge) + 'm'} old${context.tokenLiquidity ? `, $${Math.round(context.tokenLiquidity / 1000)}K liq` : ''}.`,
      suggestedPositionPercent: positionPercent,
      stopLossPercent,
      takeProfitPercent,
      expectedHoldTimeMinutes,
      riskScore,
      model: 'rule-based-fallback',
      isFallback: true,
      createdAt: new Date(),
    };
  }

  /**
   * Uloží rozhodnutí do databáze
   */
  private async saveDecision(
    decision: AIDecision,
    prompt: string,
    response: { content: string; promptTokens?: number; completionTokens?: number }
  ): Promise<void> {
    // Supabase removed - AIDecision table doesn't exist in Prisma schema
    // Skip saving for now (can be added to Prisma schema later if needed)
        return;
  }

  /**
   * Získá historická rozhodnutí pro analýzu
   */
  async getDecisionHistory(options?: {
    tokenId?: string;
    walletId?: string;
    decision?: 'buy' | 'sell' | 'hold' | 'skip';
    limit?: number;
  }): Promise<AIDecision[]> {
    // Supabase removed - AIDecision table doesn't exist in Prisma schema
    // Return empty array for now
      return [];
  }

  /**
   * Analyzuje performance AI rozhodnutí
   */
  async analyzePerformance(): Promise<{
    totalDecisions: number;
    buyDecisions: number;
    sellDecisions: number;
    skipDecisions: number;
    avgConfidence: number;
    avgLatencyMs: number;
    tokenUsage: { prompt: number; completion: number };
    modelBreakdown: Record<string, number>;
  }> {
    const decisions = await this.getDecisionHistory({ limit: 1000 });
    
    if (decisions.length === 0) {
      return {
        totalDecisions: 0,
        buyDecisions: 0,
        sellDecisions: 0,
        skipDecisions: 0,
        avgConfidence: 0,
        avgLatencyMs: 0,
        tokenUsage: { prompt: 0, completion: 0 },
        modelBreakdown: {},
      };
    }

    const buyDecisions = decisions.filter(d => d.decision === 'buy').length;
    const sellDecisions = decisions.filter(d => d.decision === 'sell').length;
    const skipDecisions = decisions.filter(d => d.decision === 'skip').length;
    
    const avgConfidence = decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length;
    const avgLatencyMs = decisions.reduce((sum, d) => sum + (d.latencyMs || 0), 0) / decisions.length;
    
    const promptTokens = decisions.reduce((sum, d) => sum + (d.promptTokens || 0), 0);
    const completionTokens = decisions.reduce((sum, d) => sum + (d.completionTokens || 0), 0);
    
    const modelBreakdown: Record<string, number> = {};
    for (const d of decisions) {
      modelBreakdown[d.model] = (modelBreakdown[d.model] || 0) + 1;
    }

    return {
      totalDecisions: decisions.length,
      buyDecisions,
      sellDecisions,
      skipDecisions,
      avgConfidence,
      avgLatencyMs,
      tokenUsage: { prompt: promptTokens, completion: completionTokens },
      modelBreakdown,
    };
  }
}

