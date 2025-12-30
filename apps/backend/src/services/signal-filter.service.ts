/**
 * Signal Filter Service
 *
 * Centralizovaná služba pro filtrování signálů.
 * Pravidla definovaná zde se používají pro:
 * - Discord notifikace
 * - Web dashboard (Signals tabulka)
 * - Web notifikace (budoucí)
 *
 * Změny pravidel na jednom místě = změny všude.
 */

import { AdvancedSignal, AdvancedSignalType } from './advanced-signals.service.js';

// =============================================
// SIGNAL FILTER CONFIGURATION
// =============================================

/**
 * Povolené typy signálů pro BUY akce
 * Signály těchto typů se odešlou do Discord a zobrazí na webu
 */
export const ALLOWED_BUY_SIGNAL_TYPES: AdvancedSignalType[] = [
  'consensus',
  'consensus-update',
  'accumulation',
  'conviction-buy',
];

/**
 * Povolené typy signálů pro SELL akce
 */
export const ALLOWED_SELL_SIGNAL_TYPES: AdvancedSignalType[] = [
  'exit-warning',
];

/**
 * Všechny povolené typy signálů (BUY + SELL)
 */
export const ALL_ALLOWED_SIGNAL_TYPES: AdvancedSignalType[] = [
  ...ALLOWED_BUY_SIGNAL_TYPES,
  ...ALLOWED_SELL_SIGNAL_TYPES,
];

/**
 * Minimální síla signálu pro jednotlivé typy
 * 'weak' | 'medium' | 'strong'
 */
export const MIN_SIGNAL_STRENGTH: Partial<Record<AdvancedSignalType, 'weak' | 'medium' | 'strong'>> = {
  'accumulation': 'medium',  // WEAK accumulation se neposílá
  'consensus': 'weak',       // Všechny consensus se posílají
  'consensus-update': 'weak',
  'conviction-buy': 'weak',  // Všechny conviction se posílají
  'exit-warning': 'weak',
};

/**
 * Minimální confidence pro jednotlivé typy (0-100)
 */
export const MIN_SIGNAL_CONFIDENCE: Partial<Record<AdvancedSignalType, number>> = {
  // Zatím žádné confidence filtry
};

// =============================================
// FILTER SERVICE
// =============================================

export interface SignalFilterResult {
  passed: boolean;
  reason?: string;
}

export class SignalFilterService {
  /**
   * Zkontroluje, zda signál prošel všemi filtry
   * Používá se pro Discord notifikace i web dashboard
   */
  shouldProcessSignal(signal: AdvancedSignal): SignalFilterResult {
    // 1. Check signal type is allowed
    const typeAllowed = this.isSignalTypeAllowed(signal.type, signal.suggestedAction);
    if (!typeAllowed.passed) {
      return typeAllowed;
    }

    // 2. Check minimum strength
    const strengthOk = this.meetsMinStrength(signal.type, signal.strength);
    if (!strengthOk.passed) {
      return strengthOk;
    }

    // 3. Check minimum confidence
    const confidenceOk = this.meetsMinConfidence(signal.type, signal.confidence);
    if (!confidenceOk.passed) {
      return confidenceOk;
    }

    // 4. Additional type-specific filters
    const typeSpecificOk = this.passesTypeSpecificFilters(signal);
    if (!typeSpecificOk.passed) {
      return typeSpecificOk;
    }

    return { passed: true };
  }

  /**
   * Check if signal type is in allowed list
   */
  isSignalTypeAllowed(type: AdvancedSignalType, action: 'buy' | 'sell' | 'hold' | 'watch'): SignalFilterResult {
    // Only process 'buy' and 'sell' actions, filter out 'hold' and 'watch'
    if (action === 'hold' || action === 'watch') {
      return { passed: false, reason: `Action '${action}' is not actionable` };
    }

    if (action === 'buy') {
      if (!ALLOWED_BUY_SIGNAL_TYPES.includes(type)) {
        return { passed: false, reason: `Signal type '${type}' not allowed for BUY` };
      }
    } else if (action === 'sell') {
      if (!ALLOWED_SELL_SIGNAL_TYPES.includes(type)) {
        return { passed: false, reason: `Signal type '${type}' not allowed for SELL` };
      }
    }
    return { passed: true };
  }

  /**
   * Check if signal meets minimum strength requirement
   */
  meetsMinStrength(
    type: AdvancedSignalType,
    strength: 'weak' | 'medium' | 'strong'
  ): SignalFilterResult {
    const minStrength = MIN_SIGNAL_STRENGTH[type] || 'weak';

    const strengthOrder = { 'weak': 1, 'medium': 2, 'strong': 3 };
    const signalStrengthValue = strengthOrder[strength] || 1;
    const minStrengthValue = strengthOrder[minStrength] || 1;

    if (signalStrengthValue < minStrengthValue) {
      return {
        passed: false,
        reason: `Signal strength '${strength}' is below minimum '${minStrength}' for type '${type}'`,
      };
    }

    return { passed: true };
  }

  /**
   * Check if signal meets minimum confidence requirement
   */
  meetsMinConfidence(type: AdvancedSignalType, confidence: number): SignalFilterResult {
    const minConfidence = MIN_SIGNAL_CONFIDENCE[type];

    if (minConfidence !== undefined && confidence < minConfidence) {
      return {
        passed: false,
        reason: `Signal confidence ${confidence}% is below minimum ${minConfidence}% for type '${type}'`,
      };
    }

    return { passed: true };
  }

  /**
   * Type-specific additional filters
   * Add custom logic here for specific signal types
   */
  passesTypeSpecificFilters(signal: AdvancedSignal): SignalFilterResult {
    // Example: conviction-buy specific filters
    // if (signal.type === 'conviction-buy') {
    //   if (signal.context.convictionMultiplier && signal.context.convictionMultiplier < 2) {
    //     return { passed: false, reason: 'Conviction multiplier too low' };
    //   }
    // }

    return { passed: true };
  }

  /**
   * Get list of all allowed signal types (for queries)
   */
  getAllowedSignalTypes(): AdvancedSignalType[] {
    return ALL_ALLOWED_SIGNAL_TYPES;
  }

  /**
   * Get list of allowed BUY signal types
   */
  getAllowedBuySignalTypes(): AdvancedSignalType[] {
    return ALLOWED_BUY_SIGNAL_TYPES;
  }

  /**
   * Get list of allowed SELL signal types
   */
  getAllowedSellSignalTypes(): AdvancedSignalType[] {
    return ALLOWED_SELL_SIGNAL_TYPES;
  }

  /**
   * Build Prisma where clause for filtering signals by type
   * Used in API queries
   */
  buildSignalTypeWhereClause(): { model?: { in: string[] } } | { OR: Array<{ meta: { path: string[]; equals: string } }> } {
    // SignalPerformance is linked to Signal model which uses 'model' field
    // But also check meta.signalType for newer signals
    return {
      model: { in: ALL_ALLOWED_SIGNAL_TYPES as string[] },
    };
  }

  /**
   * Filter an array of signals (post-query filtering)
   * Useful when signal type is stored in meta.signalType
   */
  filterSignals<T extends { signalType?: string; model?: string; strength?: string }>(
    signals: T[]
  ): T[] {
    return signals.filter(signal => {
      const type = (signal.signalType || signal.model || 'unknown') as AdvancedSignalType;
      const strength = (signal.strength || 'medium') as 'weak' | 'medium' | 'strong';

      // Check if type is allowed
      if (!ALL_ALLOWED_SIGNAL_TYPES.includes(type)) {
        return false;
      }

      // Check minimum strength
      const minStrength = MIN_SIGNAL_STRENGTH[type] || 'weak';
      const strengthOrder = { 'weak': 1, 'medium': 2, 'strong': 3 };
      if ((strengthOrder[strength] || 1) < (strengthOrder[minStrength] || 1)) {
        return false;
      }

      return true;
    });
  }
}

// Singleton instance for easy import
export const signalFilter = new SignalFilterService();
