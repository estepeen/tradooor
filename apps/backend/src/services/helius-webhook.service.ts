/**
 * HeliusWebhookService - Správa Helius webhooků pro real-time sledování transakcí
 * 
 * Helius webhooks umožňují real-time notifikace o transakcích pro sledované wallet adresy.
 * Místo pollingu každou minutu dostáváme notifikaci okamžitě, když wallet provede transakci.
 * 
 * Dokumentace: https://docs.helius.dev/webhooks
 */

import dotenv from 'dotenv';

dotenv.config();

export interface HeliusWebhook {
  webhookID: string;
  wallet: string;
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: 'enhanced' | 'raw';
  authHeader?: string;
  encoding?: 'jsonParsed' | 'json';
  commitment?: 'finalized' | 'confirmed';
}

export class HeliusWebhookService {
  private apiKey: string;
  private baseUrl = 'https://api.helius.xyz/v0';
  private webhookUrl: string;

  constructor() {
    this.apiKey = process.env.HELIUS_API_KEY || '';
    // Webhook URL může být:
    // 1. Explicitně nastaveno v HELIUS_WEBHOOK_URL
    // 2. Nebo sestaveno z API_URL + /api/webhooks/helius
    // 3. Nebo použijeme localhost pro development
    const apiUrl = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    this.webhookUrl = process.env.HELIUS_WEBHOOK_URL || `${apiUrl}/api/webhooks/helius`;
    
    if (!this.apiKey) {
      throw new Error('HELIUS_API_KEY is required for webhook service');
    }
    
    console.log(`🔧 HeliusWebhookService initialized with webhook URL: ${this.webhookUrl}`);
  }

  /**
   * Vytvoří nový webhook pro sledování transakcí pro dané wallet adresy
   */
  async createWebhook(walletAddresses: string[]): Promise<string> {
    if (walletAddresses.length === 0) {
      throw new Error('At least one wallet address is required');
    }

    const payload = {
      webhookURL: this.webhookUrl,
      transactionTypes: ['SWAP'], // Sledujeme jen swapy
      accountAddresses: walletAddresses,
      webhookType: 'enhanced', // Enhanced API poskytuje už rozparsované swapy
    };

    console.log(`🔧 Creating webhook with URL: ${this.webhookUrl}`);
    console.log(`🔧 Payload:`, JSON.stringify(payload, null, 2));

    const response = await fetch(
      `${this.baseUrl}/webhooks?api-key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create webhook: ${response.status} ${error}`);
    }

    const data = await response.json();
    console.log(`✅ Created Helius webhook: ${data.webhookID} for ${walletAddresses.length} wallets`);
    return data.webhookID;
  }

  /**
   * Aktualizuje existující webhook s novými wallet adresami
   */
  async updateWebhook(webhookId: string, walletAddresses: string[]): Promise<void> {
    if (walletAddresses.length === 0) {
      throw new Error('At least one wallet address is required');
    }

    // Helius API vyžaduje všechny parametry při update, ne jen některé
    // Získej existující webhook, abychom měli všechny parametry
    const webhooks = await this.getAllWebhooks();
    const existingWebhook = webhooks.find(wh => wh.webhookID === webhookId);
    
    if (!existingWebhook) {
      throw new Error(`Webhook ${webhookId} not found`);
    }

    const payload = {
      webhookURL: existingWebhook.webhookURL, // Musí být stejné jako při vytvoření
      accountAddresses: walletAddresses,
      transactionTypes: ['SWAP'],
      webhookType: 'enhanced',
    };

    console.log(`🔧 Updating webhook ${webhookId} with ${walletAddresses.length} addresses`);
    console.log(`🔧 Payload:`, JSON.stringify(payload, null, 2));

    const response = await fetch(
      `${this.baseUrl}/webhooks/${webhookId}?api-key=${this.apiKey}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update webhook: ${response.status} ${error}`);
    }

    console.log(`✅ Updated Helius webhook: ${webhookId} with ${walletAddresses.length} wallets`);
  }

  /**
   * Získá všechny webhooky
   */
  async getAllWebhooks(): Promise<HeliusWebhook[]> {
    const response = await fetch(
      `${this.baseUrl}/webhooks?api-key=${this.apiKey}`
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get webhooks: ${response.status} ${error}`);
    }

    const data = await response.json();
    return data;
  }

  /**
   * Smaže webhook
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/webhooks/${webhookId}?api-key=${this.apiKey}`,
      {
        method: 'DELETE',
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to delete webhook: ${response.status} ${error}`);
    }

    console.log(`✅ Deleted Helius webhook: ${webhookId}`);
  }

  /**
   * Najde nebo vytvoří webhook pro všechny trackované walletky
   * Helius umožňuje až 100,000 adres v jednom webhooku
   */
  async ensureWebhookForAllWallets(walletAddresses: string[]): Promise<string> {
    if (walletAddresses.length === 0) {
      throw new Error('At least one wallet address is required');
    }

    // Zkus najít existující webhook s naším URL
    const webhooks = await this.getAllWebhooks();
    const existingWebhook = webhooks.find(
      (wh) => wh.webhookURL === this.webhookUrl && wh.webhookType === 'enhanced'
    );

    if (existingWebhook) {
      // Aktualizuj existující webhook s novými adresami
      // Zkombinuj existující adresy s novými (bez duplikátů)
      // accountAddresses může být pole nebo undefined
      const existingAddresses = Array.isArray(existingWebhook.accountAddresses) 
        ? existingWebhook.accountAddresses 
        : [];
      const allAddresses = Array.from(
        new Set([...existingAddresses, ...walletAddresses])
      );
      
      await this.updateWebhook(existingWebhook.webhookID, allAddresses);
      return existingWebhook.webhookID;
    } else {
      // Vytvoř nový webhook
      return await this.createWebhook(walletAddresses);
    }
  }
}

