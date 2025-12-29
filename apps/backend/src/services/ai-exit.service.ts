/**
 * AI Exit Service
 *
 * LLM-powered exit strategy decisions for memecoin positions.
 * Uses GROQ (Llama 3.3 70B) for intelligent exit timing.
 *
 * Features:
 * - AI-powered exit evaluation
 * - Trailing stop recommendations
 * - Partial exit suggestions
 * - Volume/momentum analysis
 */

import { VirtualPositionRecord } from '../repositories/virtual-position.repository.js';
import { generateId } from '../lib/prisma.js';

// Exit decision types
export type ExitDecisionType =
  | 'hold'
  | 'partial_exit_25'
  | 'partial_exit_50'
  | 'partial_exit_75'
  | 'full_exit';

export type ExitUrgency = 'low' | 'medium' | 'high';

export interface AIExitDecision {
  id: string;
  positionId: string;
  decision: ExitDecisionType;
  confidence: number; // 0-100
  reasoning: string;
  urgency: ExitUrgency;
  suggestedTrailingStopPercent: number;
  riskScore: number; // 1-10
  model: string;
  latencyMs?: number;
  createdAt: Date;
  isFallback: boolean;
}

export interface ExitContext {
  // Position info
  position: VirtualPositionRecord;

  // Market data
  currentPriceUsd: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume1hUsd?: number;
  volumeTrend?: 'increasing' | 'stable' | 'decreasing';

  // Performance metrics
  pnlPercent: number;
  athPnlPercent: number;
  drawdownFromPeakPercent: number;
  holdTimeMinutes: number;

  // Wallet activity
  entryWalletCount: number;
  activeWalletCount: number;
  exitedWalletCount: number;
  recentExitDetails?: string;
}

export interface AIExitConfig {
  model?: 'groq' | 'groq-fast';
  temperature?: number;
  minPnlChangeForEval?: number; // Min PnL change % to trigger AI eval
  minDrawdownForEval?: number;  // Min drawdown % from peak to trigger AI eval
  minTimeBetweenEvals?: number; // Min minutes between AI evals
  enableLogging?: boolean;
}

const DEFAULT_CONFIG: AIExitConfig = {
  model: 'groq',
  temperature: 0.3,
  minPnlChangeForEval: 20,    // 20% change
  minDrawdownForEval: 20,     // 20% drawdown from peak
  minTimeBetweenEvals: 5,     // 5 minutes
  enableLogging: true,
};

export class AIExitService {
  private config: AIExitConfig;
  private groqApiKey?: string;

  constructor(config?: AIExitConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.groqApiKey = process.env.GROQ_API_KEY;

    if (!this.groqApiKey) {
      console.warn('⚠️  [AI Exit] GROQ_API_KEY not set - AI exit decisions will use fallback');
    }
  }

  /**
   * Checks if position should be evaluated by AI
   */
  shouldEvaluate(position: VirtualPositionRecord, context: ExitContext): boolean {
    // Check minimum time between evaluations
    if (position.lastAiEvaluation) {
      const timeSinceLastEval = (Date.now() - position.lastAiEvaluation.getTime()) / 60000;
      if (timeSinceLastEval < (this.config.minTimeBetweenEvals || 5)) {
        return false;
      }
    }

    // Check if significant change occurred
    const significantPnlChange = Math.abs(context.pnlPercent) >= (this.config.minPnlChangeForEval || 20);
    const significantDrawdown = context.drawdownFromPeakPercent >= (this.config.minDrawdownForEval || 20);
    const walletExitOccurred = context.exitedWalletCount > 0 &&
      (context.exitedWalletCount / context.entryWalletCount) >= 0.25; // 25%+ wallets exited

    return significantPnlChange || significantDrawdown || walletExitOccurred;
  }

  /**
   * Evaluates exit opportunity using AI
   */
  async evaluateExit(context: ExitContext): Promise<AIExitDecision> {
    const startTime = Date.now();

    // Check if AI is enabled
    if (process.env.ENABLE_AI_DECISIONS !== 'true' || !this.groqApiKey) {
      console.log(`⚠️  [AI Exit] Using fallback decision (AI disabled or no API key)`);
      return this.fallbackDecision(context);
    }

    try {
      console.log(`🤖 [AI Exit] Evaluating position ${context.position.id.substring(0, 8)}...`);
      console.log(`   PnL: ${context.pnlPercent.toFixed(1)}%, Drawdown: ${context.drawdownFromPeakPercent.toFixed(1)}%, Wallets: ${context.activeWalletCount}/${context.entryWalletCount}`);

      const prompt = this.buildPrompt(context);
      const response = await this.callGroq(prompt);
      const decision = this.parseResponse(response, context);

      decision.latencyMs = Date.now() - startTime;
      decision.isFallback = false;

      console.log(`✅ [AI Exit] Decision: ${decision.decision} (${decision.confidence}% confidence, ${decision.urgency} urgency)`);

      return decision;
    } catch (error: any) {
      const isRateLimit = error.message?.includes('rate_limit') || error.message?.includes('Rate limit');

      if (isRateLimit) {
        console.warn(`⚠️  [AI Exit] Rate limit - using fallback decision`);
      } else {
        console.error(`❌ [AI Exit] Error:`, error.message);
      }

      return this.fallbackDecision(context);
    }
  }

  /**
   * Builds prompt for exit evaluation
   */
  private buildPrompt(context: ExitContext): string {
    const { position } = context;

    const holdTimeStr = context.holdTimeMinutes >= 60
      ? `${Math.floor(context.holdTimeMinutes / 60)}h ${context.holdTimeMinutes % 60}m`
      : `${context.holdTimeMinutes}m`;

    const walletExitPercent = context.entryWalletCount > 0
      ? ((context.exitedWalletCount / context.entryWalletCount) * 100).toFixed(0)
      : '0';

    return `Analyze this Solana memecoin position for exit timing. Return JSON only.

Position:
- Entry: $${position.entryPriceUsd.toFixed(8)}
- Current: $${context.currentPriceUsd.toFixed(8)} (${context.pnlPercent >= 0 ? '+' : ''}${context.pnlPercent.toFixed(1)}%)
- ATH: +${context.athPnlPercent.toFixed(1)}%
- Drawdown from peak: ${context.drawdownFromPeakPercent.toFixed(1)}%
- Hold time: ${holdTimeStr}

Market:
${context.marketCapUsd ? `- MCap: $${(context.marketCapUsd / 1000).toFixed(1)}K` : ''}
${context.liquidityUsd ? `- Liquidity: $${(context.liquidityUsd / 1000).toFixed(1)}K` : ''}
${context.volumeTrend ? `- Volume trend: ${context.volumeTrend}` : ''}

Wallets:
- Original: ${context.entryWalletCount}
- Still holding: ${context.activeWalletCount}
- Exited: ${context.exitedWalletCount} (${walletExitPercent}%)
${context.recentExitDetails ? `- Recent exits: ${context.recentExitDetails}` : ''}

Rules:
- Memecoins are volatile - 10x can become 2x quickly
- If 50%+ wallets exited, strongly consider exit
- If drawdown >40% from peak, evaluate partial exit
- If profit >100% and volume decreasing, consider taking some profit
- If still early (<30min) and pumping, let it run
- Trailing stop should be 15-40% depending on volatility

JSON:
{"decision":"hold|partial_exit_25|partial_exit_50|partial_exit_75|full_exit","confidence":0-100,"reasoning":"2-3 sentences","urgency":"low|medium|high","suggestedTrailingStopPercent":15-40,"riskScore":1-10}`;
  }

  /**
   * Calls Groq API
   */
  private async callGroq(prompt: string): Promise<string> {
    if (!this.groqApiKey) {
      throw new Error('GROQ_API_KEY not set');
    }

    const model = this.config.model === 'groq-fast'
      ? 'llama-3.1-8b-instant'
      : 'llama-3.3-70b-versatile';

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.groqApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert Solana memecoin trader specializing in exit timing. Always respond with valid JSON only.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: this.config.temperature || 0.3,
        max_tokens: 512,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Parses AI response
   */
  private parseResponse(response: string, context: ExitContext): AIExitDecision {
    try {
      // Try to extract JSON from response
      let jsonStr = response;
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const parsed = JSON.parse(jsonStr);

      return {
        id: generateId(),
        positionId: context.position.id,
        decision: this.validateDecision(parsed.decision),
        confidence: Math.min(100, Math.max(0, parsed.confidence || 50)),
        reasoning: parsed.reasoning || 'No reasoning provided',
        urgency: this.validateUrgency(parsed.urgency),
        suggestedTrailingStopPercent: Math.min(50, Math.max(10, parsed.suggestedTrailingStopPercent || 20)),
        riskScore: Math.min(10, Math.max(1, parsed.riskScore || 5)),
        model: this.config.model || 'groq',
        createdAt: new Date(),
        isFallback: false,
      };
    } catch (error) {
      console.error(`❌ [AI Exit] Failed to parse response:`, error);
      return this.fallbackDecision(context);
    }
  }

  /**
   * Rule-based fallback decision when AI is unavailable
   */
  private fallbackDecision(context: ExitContext): AIExitDecision {
    let decision: ExitDecisionType = 'hold';
    let confidence = 50;
    let urgency: ExitUrgency = 'low';
    let reasoning = '';
    let trailingStop = 20;

    const walletExitPercent = context.entryWalletCount > 0
      ? (context.exitedWalletCount / context.entryWalletCount) * 100
      : 0;

    // Critical conditions - full exit
    if (walletExitPercent >= 75) {
      decision = 'full_exit';
      confidence = 85;
      urgency = 'high';
      reasoning = `${walletExitPercent.toFixed(0)}% of wallets have exited. High probability of dump.`;
    }
    // Most wallets exited - strong exit signal
    else if (walletExitPercent >= 50) {
      decision = 'partial_exit_75';
      confidence = 75;
      urgency = 'high';
      reasoning = `Half the wallets have exited. Consider securing most profits.`;
    }
    // Significant drawdown from peak
    else if (context.drawdownFromPeakPercent >= 50) {
      decision = 'full_exit';
      confidence = 70;
      urgency = 'high';
      reasoning = `Price dropped ${context.drawdownFromPeakPercent.toFixed(0)}% from peak. Cut losses.`;
    }
    // Moderate drawdown with wallet exits
    else if (context.drawdownFromPeakPercent >= 30 && walletExitPercent >= 25) {
      decision = 'partial_exit_50';
      confidence = 65;
      urgency = 'medium';
      reasoning = `${context.drawdownFromPeakPercent.toFixed(0)}% drawdown and ${walletExitPercent.toFixed(0)}% wallets exited.`;
    }
    // Good profit and some drawdown - secure some gains
    else if (context.pnlPercent >= 100 && context.drawdownFromPeakPercent >= 20) {
      decision = 'partial_exit_25';
      confidence = 60;
      urgency = 'medium';
      reasoning = `Strong +${context.pnlPercent.toFixed(0)}% profit with ${context.drawdownFromPeakPercent.toFixed(0)}% pullback. Secure some gains.`;
      trailingStop = 15;
    }
    // Great profit - consider partial exit
    else if (context.pnlPercent >= 200) {
      decision = 'partial_exit_25';
      confidence = 55;
      urgency = 'low';
      reasoning = `Excellent +${context.pnlPercent.toFixed(0)}% profit. Consider taking some off the table.`;
      trailingStop = 15;
    }
    // Still in profit, no major warnings
    else if (context.pnlPercent > 0) {
      decision = 'hold';
      confidence = 60;
      urgency = 'low';
      reasoning = `Position in profit at +${context.pnlPercent.toFixed(0)}%. No exit signals yet.`;
      trailingStop = context.pnlPercent >= 50 ? 20 : 25;
    }
    // In loss but no critical signals
    else {
      decision = 'hold';
      confidence = 50;
      urgency = 'medium';
      reasoning = `Position at ${context.pnlPercent.toFixed(0)}%. Monitoring for reversal or further deterioration.`;
      trailingStop = 30;
    }

    return {
      id: generateId(),
      positionId: context.position.id,
      decision,
      confidence,
      reasoning,
      urgency,
      suggestedTrailingStopPercent: trailingStop,
      riskScore: this.calculateRiskScore(context),
      model: 'fallback',
      createdAt: new Date(),
      isFallback: true,
    };
  }

  /**
   * Calculates risk score based on context
   */
  private calculateRiskScore(context: ExitContext): number {
    let risk = 5; // Base risk

    // Wallet exits increase risk
    const walletExitPercent = context.entryWalletCount > 0
      ? (context.exitedWalletCount / context.entryWalletCount) * 100
      : 0;
    if (walletExitPercent >= 50) risk += 3;
    else if (walletExitPercent >= 25) risk += 2;
    else if (walletExitPercent > 0) risk += 1;

    // Drawdown increases risk
    if (context.drawdownFromPeakPercent >= 40) risk += 2;
    else if (context.drawdownFromPeakPercent >= 20) risk += 1;

    // Volume trend
    if (context.volumeTrend === 'decreasing') risk += 1;

    // Low liquidity increases risk
    if (context.liquidityUsd && context.liquidityUsd < 20000) risk += 1;

    // Long hold time without much gain increases risk
    if (context.holdTimeMinutes > 120 && context.pnlPercent < 50) risk += 1;

    return Math.min(10, Math.max(1, risk));
  }

  private validateDecision(decision: string): ExitDecisionType {
    const valid: ExitDecisionType[] = ['hold', 'partial_exit_25', 'partial_exit_50', 'partial_exit_75', 'full_exit'];
    return valid.includes(decision as ExitDecisionType) ? decision as ExitDecisionType : 'hold';
  }

  private validateUrgency(urgency: string): ExitUrgency {
    const valid: ExitUrgency[] = ['low', 'medium', 'high'];
    return valid.includes(urgency as ExitUrgency) ? urgency as ExitUrgency : 'low';
  }
}
