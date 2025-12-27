import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatAddress(address: string, chars = 4): string {
  if (!address) return '';
  if (address.length <= chars * 2) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function formatMultiplier(percent: number): string {
  // Převod z procent na násobek: 120% = 1.2x, -30% = -0.3x
  const multiplier = percent / 100;
  return `${multiplier >= 0 ? '+' : ''}${multiplier.toFixed(2)}x`;
}

export function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || isNaN(value) || !Number.isFinite(value)) {
    return '0.00';
  }
  try {
    // Handle negative numbers - preserve sign
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    // Use toFixed for precise decimal control, then add thousand separators
    const fixed = absValue.toFixed(decimals);
    // Add thousand separators
    const parts = fixed.split('.');
    if (parts[0]) {
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    const formatted = parts.join('.');
    
    // Add minus sign back if negative
    return isNegative ? `-${formatted}` : formatted;
  } catch (error) {
    // Fallback to simple toFixed if anything goes wrong
    return Number(value).toFixed(decimals);
  }
}

/**
 * Normalize base token for display
 * WSOL → SOL (for Solana)
 * Returns normalized token symbol for display
 */
export function normalizeBaseToken(baseToken: string | null | undefined): string {
  if (!baseToken) return 'SOL'; // Default for Solana
  const normalized = baseToken.toUpperCase();
  // WSOL is wrapped SOL - display as SOL
  if (normalized === 'WSOL') return 'SOL';
  return normalized;
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear()).slice(-2);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year}, ${hours}:${minutes}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error('Failed to copy:', error);
    return false;
  }
}

export function formatTimeAgo(date: Date | string | null | undefined): string {
  if (!date) return 'Never';
  
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  
  // For longer periods, show the date
  return formatDate(d);
}

export function formatLastTrade(date: Date | string | null | undefined): string {
  if (!date) return 'Never';
  
  let d: Date;
  if (typeof date === 'string') {
    d = new Date(date);
  } else if (date instanceof Date) {
    d = date;
  } else {
    // Fallback for any other type
    d = new Date(date);
  }
  
  // Check if date is valid
  if (isNaN(d.getTime())) {
    console.warn('Invalid date in formatLastTrade:', date);
    return 'Never';
  }
  
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  
  // If date is in the future, something is wrong
  if (diffMs < 0) {
    console.warn('Date is in the future:', date, d);
    return 'Never';
  }
  
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  // Pokud je to méně než 24 hodin, zobraz relativní čas
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  
  // Pokud je to více než 7 dní, zobraz český formát (d.m.r, HH:MM)
  return formatDateTimeCZ(d);
}

export function formatDateTimeCZ(date: Date | string | null | undefined): string {
  if (!date) return 'Never';
  return formatDate(date);
}

export function formatHoldTime(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || minutes < 0) return '-';
  
  // If less than 1 minute, show "<1m"
  if (minutes < 1) {
    return '<1m';
  }
  
  // If less than 60 minutes, show minutes
  if (minutes < 60) {
    return `${Math.round(minutes)} min`;
  } else if (minutes < 60 * 24) {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return mins > 0 ? `${hours}h ${mins}min` : `${hours}h`;
  } else {
    const days = Math.floor(minutes / (60 * 24));
    const hours = Math.floor((minutes % (60 * 24)) / 60);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
}

