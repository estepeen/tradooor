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
import { supabase, TABLES, generateId } from '../lib/supabase.js';

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
    if (model.startsWith('groq') && !this.groqApiKey) {
      console.warn('⚠️  GROQ_API_KEY not set - AI decisions will use fallback rules');
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
    
    try {
      // Sestav prompt
      const prompt = this.buildPrompt(signal, context);
      
      // Zavolej LLM
      const response = await this.callLLM(prompt);
      
      // Parse odpověď
      const decision = this.parseResponse(response, signal, context);
      decision.latencyMs = Date.now() - startTime;
      
      // Ulož do databáze
      if (this.config.enableLogging) {
        await this.saveDecision(decision, prompt, response);
      }
      
      return decision;
    } catch (error) {
      console.error('AI Decision error:', error);
      
      // Fallback na rule-based rozhodnutí
      return this.fallbackDecision(signal, context);
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
    return `You are an expert Solana memecoin trader analyzing a trading signal.

## SIGNAL INFORMATION
- Type: ${signal.type}
- Strength: ${signal.strength}
- Confidence: ${signal.confidence}%
- Initial Reasoning: ${signal.reasoning}
- Suggested Action: ${signal.suggestedAction}
- Risk Level: ${signal.riskLevel}

## WALLET METRICS (Trader who triggered this signal)
- Quality Score: ${context.walletScore}/100
- Win Rate: ${(context.walletWinRate * 100).toFixed(1)}%
- Recent 30d PnL: ${context.walletRecentPnl30d.toFixed(1)}%
- Total Trades: ${context.walletTotalTrades}
- Avg Hold Time: ${context.walletAvgHoldTimeMin.toFixed(0)} minutes

## TOKEN INFORMATION
- Symbol: ${context.tokenSymbol || 'Unknown'}
- Token Age: ${context.tokenAge.toFixed(0)} minutes
${context.tokenLiquidity ? `- Liquidity: $${context.tokenLiquidity.toLocaleString()}` : ''}
${context.tokenVolume24h ? `- 24h Volume: $${context.tokenVolume24h.toLocaleString()}` : ''}
${context.tokenMarketCap ? `- Market Cap: $${context.tokenMarketCap.toLocaleString()}` : ''}

## MARKET CONTEXT
${context.otherWalletsCount ? `- Other Smart Wallets Trading: ${context.otherWalletsCount}` : ''}
${context.consensusStrength ? `- Consensus Strength: ${context.consensusStrength}` : ''}
${context.recentTokenPerformance !== undefined ? `- Recent Token Performance: ${context.recentTokenPerformance.toFixed(1)}%` : ''}

## HISTORICAL PERFORMANCE ON SIMILAR TRADES
${context.similarTradesCount ? `- Similar Trades Analyzed: ${context.similarTradesCount}` : 'No historical data available'}
${context.similarTradesWinRate !== undefined ? `- Win Rate on Similar: ${(context.similarTradesWinRate * 100).toFixed(1)}%` : ''}
${context.similarTradesAvgPnl !== undefined ? `- Avg PnL on Similar: ${context.similarTradesAvgPnl.toFixed(1)}%` : ''}

## YOUR TASK
Analyze this signal and provide a trading decision. Consider:
1. The quality and track record of the trader
2. The token's characteristics (age, liquidity, volume)
3. The type and strength of the signal
4. Risk/reward ratio
5. Market conditions

Respond in JSON format:
{
  "decision": "buy" | "sell" | "hold" | "skip",
  "confidence": 0-100,
  "reasoning": "Your detailed analysis (2-3 sentences)",
  "suggestedPositionPercent": 5-20,
  "stopLossPercent": 10-50,
  "takeProfitPercent": 20-200,
  "expectedHoldTimeMinutes": 5-1440,
  "riskScore": 1-10
}

Important guidelines:
- For new tokens (<30 min old), be more cautious (higher risk, smaller position)
- For whale entries from high-score traders, be more aggressive
- For consensus signals (multiple wallets), increase confidence
- NEVER recommend position size > 20% of portfolio
- Always set stop-loss (10-50% depending on risk)
- Be skeptical of very new tokens with low liquidity`;
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
      throw new Error('GROQ_API_KEY not set. Get free key at https://console.groq.com');
    }

    // Select model based on config
    const groqModel = model === 'groq-fast' 
      ? 'llama-3.1-8b-instant'      // Faster, less accurate
      : 'llama-3.1-70b-versatile';  // Default, best quality

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
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    
    return {
      content: data.choices?.[0]?.message?.content || '',
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
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

    // Základní pravidla
    if (signal.suggestedAction === 'buy' && signal.confidence >= 60) {
      decision = 'buy';
      
      if (signal.type === 'whale-entry' && context.walletScore >= 80) {
        confidence = Math.min(95, confidence + 10);
        positionPercent = 12;
        riskScore = 3;
      } else if (signal.type === 'hot-token' && context.otherWalletsCount && context.otherWalletsCount >= 3) {
        confidence = Math.min(90, confidence + 5);
        positionPercent = 10;
        riskScore = 4;
      } else if (signal.type === 'early-sniper') {
        riskScore = 7; // Vyšší risk pro nové tokeny
        positionPercent = 7;
      }
    } else if (signal.suggestedAction === 'sell') {
      decision = 'sell';
    }

    // Snížení confidence pro nízké wallet scores
    if (context.walletScore < 60) {
      confidence = confidence * 0.8;
    }

    return {
      id: generateId(),
      tokenId: '',
      decision,
      confidence: Math.round(confidence),
      reasoning: `Fallback decision based on ${signal.type} signal (${signal.strength} strength). Wallet score: ${context.walletScore}`,
      suggestedPositionPercent: positionPercent,
      stopLossPercent: 25,
      takeProfitPercent: 50,
      expectedHoldTimeMinutes: 120,
      riskScore,
      model: 'rule-based-fallback',
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
    try {
      await supabase.from('AIDecision').insert({
        id: decision.id,
        tokenId: decision.tokenId,
        walletId: decision.walletId,
        signalId: decision.signalId,
        tradeId: decision.tradeId,
        decision: decision.decision,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        suggestedPositionPercent: decision.suggestedPositionPercent,
        stopLossPercent: decision.stopLossPercent,
        takeProfitPercent: decision.takeProfitPercent,
        expectedHoldTimeMinutes: decision.expectedHoldTimeMinutes,
        riskScore: decision.riskScore,
        model: decision.model,
        promptTokens: decision.promptTokens,
        completionTokens: decision.completionTokens,
        latencyMs: decision.latencyMs,
        prompt,
        response: response.content,
        createdAt: decision.createdAt.toISOString(),
      });
    } catch (error: any) {
      // Table might not exist - that's OK
      if (!error.message?.includes('does not exist')) {
        console.error('Failed to save AI decision:', error);
      }
    }
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
    let query = supabase
      .from('AIDecision')
      .select('*')
      .order('createdAt', { ascending: false });

    if (options?.tokenId) {
      query = query.eq('tokenId', options.tokenId);
    }
    if (options?.walletId) {
      query = query.eq('walletId', options.walletId);
    }
    if (options?.decision) {
      query = query.eq('decision', options.decision);
    }
    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      console.warn('Failed to get AI decision history:', error);
      return [];
    }

    return (data || []).map(row => ({
      id: row.id,
      signalId: row.signalId,
      tradeId: row.tradeId,
      tokenId: row.tokenId,
      walletId: row.walletId,
      decision: row.decision,
      confidence: row.confidence,
      reasoning: row.reasoning,
      suggestedPositionPercent: row.suggestedPositionPercent,
      stopLossPercent: row.stopLossPercent,
      takeProfitPercent: row.takeProfitPercent,
      expectedHoldTimeMinutes: row.expectedHoldTimeMinutes,
      riskScore: row.riskScore,
      model: row.model,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      latencyMs: row.latencyMs,
      createdAt: new Date(row.createdAt),
    }));
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

