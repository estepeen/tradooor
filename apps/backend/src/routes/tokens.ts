import { Router } from 'express';
import { TokenRepository } from '../repositories/token.repository.js';
import { HeliusClient } from '../services/helius-client.service.js';
import { TokenMetadataBatchService } from '../services/token-metadata-batch.service.js';
import { supabase, TABLES } from '../lib/supabase.js';

const router = Router();
const tokenRepo = new TokenRepository();
const heliusClient = new HeliusClient();
const tokenMetadataBatchService = new TokenMetadataBatchService(heliusClient, tokenRepo);

// POST /api/tokens/enrich-symbols - Hromadné doplnění/oprava symbolů a názvů tokenů
router.post('/enrich-symbols', async (req, res) => {
  try {
    // Načti nějaký počet tokenů a pak je odfiltruj v Node (jednodušší než komplikované .or podmínky)
    const { data: allTokens, error: fetchError } = await supabase
      .from(TABLES.TOKEN)
      .select('id, mintAddress, symbol, name')
      .limit(500); // vezmeme prvních 500 a dále můžeme endpoint volat opakovaně

    if (fetchError) {
      throw new Error(`Failed to fetch tokens: ${fetchError.message}`);
    }

    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    const tokensWithoutSymbol = (allTokens || []).filter((t: any) => {
      const sym = (t.symbol || '').trim();
      if (!sym) return true; // úplně chybí

      // Heuristika: symbol je příliš dlouhý a vypadá jako base58 -> pravděpodobně CA, chceme ho nahradit
      if (sym.length > 15 && base58Regex.test(sym)) {
        return true;
      }

      // Zkrácená adresa typu "abcd...wxyz"
      if (sym.includes('...')) {
        return true;
      }

      return false;
    });

    if (tokensWithoutSymbol.length === 0) {
      return res.json({
        message: 'No tokens to enrich found',
        updated: 0,
        failed: 0,
      });
    }

    console.log(`📝 Found ${tokensWithoutSymbol.length} tokens to enrich (missing/invalid symbols), enriching...`);

    let updated = 0;
    let failed = 0;

    // Helius Token Metadata API podporuje batch dotazy - zpracuj po 50 tokenech najednou
    const BATCH_SIZE = 50;
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';

    for (let i = 0; i < tokensWithoutSymbol.length; i += BATCH_SIZE) {
      const batch = tokensWithoutSymbol.slice(i, i + BATCH_SIZE);
      console.log(`📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} tokens)...`);

      // Rozděl na SOL a ostatní tokeny
      const solTokens = batch.filter(t => t.mintAddress === WSOL_MINT);
      const otherTokens = batch.filter(t => t.mintAddress !== WSOL_MINT);

      // Zpracuj SOL tokeny
      for (const token of solTokens) {
        try {
          const { error: updateError } = await supabase
            .from(TABLES.TOKEN)
            .update({
              symbol: 'SOL',
              name: 'Solana',
              decimals: 9,
            })
            .eq('id', token.id);

          if (updateError) {
            console.error(`❌ Failed to update SOL token:`, updateError.message);
            failed++;
          } else {
            console.log(`✅ Updated SOL token`);
            updated++;
          }
        } catch (error: any) {
          console.error(`❌ Error updating SOL token:`, error.message);
          failed++;
        }
      }

      // Token metadata enrichment removed - only webhook processing enriches tokens
      // All tokens should have metadata from webhook processing already
      if (otherTokens.length > 0) {
        console.log(`⚠️  Skipping ${otherTokens.length} tokens - metadata enrichment only via webhook`);
        failed += otherTokens.length;
      }

      // Malé zpoždění mezi batch dotazy
      if (i + BATCH_SIZE < tokensWithoutSymbol.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    res.json({
      message: `Enriched ${updated} tokens, ${failed} failed`,
      updated,
      failed,
      total: tokensWithoutSymbol.length,
    });
  } catch (error: any) {
    console.error('Error enriching token symbols:', error);
    res.status(500).json({ error: 'Internal server error', message: error?.message });
  }
});

export { router as tokensRouter };

