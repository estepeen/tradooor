import { PublicKey } from '@solana/web3.js';

/**
 * Validate Solana wallet address
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse tags from string (comma-separated)
 */
export function parseTags(tagsString: string | undefined): string[] {
  if (!tagsString) return [];
  return tagsString
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

