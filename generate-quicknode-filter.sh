#!/bin/bash

# Skript pro generování QuickNode Streams filter funkce z wallets.csv
# Použití: ./generate-quicknode-filter.sh

echo "Generování QuickNode Streams filter z wallets.csv..."

# Extrahuj adresy z wallets.csv (3. sloupec, přeskoč hlavičku)
WALLETS=$(tail -n +3 wallets.csv | cut -d';' -f3 | grep -v '^$' | sort -u)

# Počet adres
COUNT=$(echo "$WALLETS" | wc -l | tr -d ' ')
echo "Nalezeno $COUNT unikátních wallet adres"

# Vytvoř JavaScript pole
JS_ARRAY=""
FIRST=true
while IFS= read -r wallet; do
  if [ -n "$wallet" ]; then
    if [ "$FIRST" = true ]; then
      JS_ARRAY="    '$wallet'"
      FIRST=false
    else
      JS_ARRAY="$JS_ARRAY,
    '$wallet'"
    fi
  fi
done <<< "$WALLETS"

# Vytvoř finální filter funkci
cat > quicknode-streams-filter-generated.js << EOF
/**
 * QuickNode Streams Filter Function - Auto-generated from wallets.csv
 * 
 * Generováno: $(date)
 * Počet tracked wallets: $COUNT
 * 
 * Instalace:
 * 1. Jdi do QuickNode Dashboard > Streams
 * 2. Vytvoř nový Stream nebo uprav existující
 * 3. Vlož tento kód do "Filter Function"
 * 4. Nastav webhook URL na: https://tradooor.stepanpanek.cz/api/webhooks/quicknode
 */

function main(payload) {
  // payload.data obsahuje bloky z getBlock
  if (!payload || !payload.data || !Array.isArray(payload.data)) {
    return null; // Nevalidní payload - neposílej webhook
  }

  // Tracked wallets (auto-generated from wallets.csv)
  const TRACKED_WALLETS = new Set([
$JS_ARRAY
  ]);

  // DEX program IDs, které nás zajímají (swapy)
  const DEX_PROGRAMS = new Set([
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6 aggregator
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpools
    'pump9xNzDDnyWJ1cg9CHG9g9o6CWGt77CajND4xqJcf', // Pump.fun
  ]);

  // Projdi všechny bloky a najdi relevantní transakce
  const filteredBlocks = [];

  for (const block of payload.data) {
    if (!block.transactions || !Array.isArray(block.transactions)) {
      continue;
    }

    const relevantTransactions = [];

    for (const tx of block.transactions) {
      const message = tx.transaction?.message;
      if (!message) continue;

      const accountKeys = message.accountKeys || [];
      const instructions = message.instructions || [];
      
      // 1. Zkontroluj, jestli transakce volá některý DEX program
      let hasDexProgram = false;
      for (const key of accountKeys) {
        const pubkey = typeof key === 'string' ? key : key?.pubkey;
        if (pubkey && DEX_PROGRAMS.has(pubkey)) {
          hasDexProgram = true;
          break;
        }
      }

      // Alternativně zkontroluj instructions
      if (!hasDexProgram) {
        for (const instruction of instructions) {
          const programIdIndex = instruction.programIdIndex;
          if (programIdIndex !== undefined && accountKeys[programIdIndex]) {
            const programId = typeof accountKeys[programIdIndex] === 'string'
              ? accountKeys[programIdIndex]
              : accountKeys[programIdIndex]?.pubkey;
            if (programId && DEX_PROGRAMS.has(programId)) {
              hasDexProgram = true;
              break;
            }
          }
        }
      }

      if (!hasDexProgram) continue;

      // 2. Zkontroluj, jestli některá z tracked wallets je v transakci
      let hasTrackedWallet = false;
      for (const key of accountKeys) {
        const pubkey = typeof key === 'string' ? key : key?.pubkey;
        if (pubkey && TRACKED_WALLETS.has(pubkey)) {
          hasTrackedWallet = true;
          break;
        }
      }

      // Zkontroluj také token balances (owner)
      if (!hasTrackedWallet) {
        const meta = tx.meta;
        if (meta) {
          const allBalances = [
            ...(meta.preTokenBalances || []),
            ...(meta.postTokenBalances || []),
          ];
          for (const balance of allBalances) {
            if (balance.owner && TRACKED_WALLETS.has(balance.owner)) {
              hasTrackedWallet = true;
              break;
            }
          }
        }
      }

      if (!hasTrackedWallet) continue;

      // 3. Zkontroluj, jestli je to skutečný swap (ne jen transfer)
      // Swap musí mít změnu v alespoň 2 různých tokenech (jeden jde dolů, druhý nahoru)
      const BASE_MINTS = new Set([
        'So11111111111111111111111111111111111111112', // WSOL/NATIVE_MINT
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      ]);

      const meta = tx.meta;
      if (!meta) continue;

      // Najdi tracked wallet v transakci
      let trackedWalletInTx = null;
      for (const key of accountKeys) {
        const pubkey = typeof key === 'string' ? key : key?.pubkey;
        if (pubkey && TRACKED_WALLETS.has(pubkey)) {
          trackedWalletInTx = pubkey;
          break;
        }
      }

      if (!trackedWalletInTx) {
        // Zkontroluj token balances
        const allBalances = [
          ...(meta.preTokenBalances || []),
          ...(meta.postTokenBalances || []),
        ];
        for (const balance of allBalances) {
          if (balance.owner && TRACKED_WALLETS.has(balance.owner)) {
            trackedWalletInTx = balance.owner;
            break;
          }
        }
      }

      if (!trackedWalletInTx) continue;

      const trackedWalletLower = trackedWalletInTx.toLowerCase();

      // Vypočítej změny v token balances
      const preMap = new Map(); // mint -> amount
      const postMap = new Map(); // mint -> amount

      const processBalances = (balances, targetMap) => {
        if (!Array.isArray(balances)) return;
        for (const balance of balances) {
          if (!balance.owner || balance.owner.toLowerCase() !== trackedWalletLower) continue;
          if (!balance.mint) continue;
          
          const amount = balance.uiTokenAmount?.uiAmount || 
                       (balance.uiTokenAmount?.amount ? 
                        Number(balance.uiTokenAmount.amount) / Math.pow(10, balance.uiTokenAmount.decimals || 0) : 
                        0);
          if (amount > 0) {
            targetMap.set(balance.mint, (targetMap.get(balance.mint) || 0) + amount);
          }
        }
      };

      processBalances(meta.preTokenBalances, preMap);
      processBalances(meta.postTokenBalances, postMap);

      // Vypočítej net changes
      const allMints = new Set([...preMap.keys(), ...postMap.keys()]);
      let tokensWithChange = 0;
      let hasBaseToken = false;

      for (const mint of allMints) {
        const pre = preMap.get(mint) || 0;
        const post = postMap.get(mint) || 0;
        const change = Math.abs(post - pre);
        
        // Ignoruj velmi malé změny (mohou být zaokrouhlovací chyby)
        if (change > 0.000001) {
          tokensWithChange++;
          if (BASE_MINTS.has(mint)) {
            hasBaseToken = true;
          }
        }
      }

      // Také zkontroluj native SOL změny
      if (!hasBaseToken && Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
        for (let i = 0; i < accountKeys.length; i++) {
          const pk = accountKeys[i];
          if (!pk || (typeof pk === 'string' ? pk : pk?.pubkey)?.toLowerCase() !== trackedWalletLower) continue;
          
          const pre = meta.preBalances[i] || 0;
          const post = meta.postBalances[i] || 0;
          const solChange = Math.abs(post - pre);
          if (solChange > 1000) { // Více než 0.000001 SOL
            hasBaseToken = true;
            tokensWithChange++; // Počítáme SOL jako jeden token
            break;
          }
        }
      }

      // Swap musí mít:
      // 1. Alespoň 2 tokeny se změnou (jeden jde dolů, druhý nahoru)
      // 2. Alespoň jeden z nich musí být base token (SOL/WSOL/USDC/USDT)
      if (tokensWithChange >= 2 && hasBaseToken) {
        relevantTransactions.push(tx);
      }
    }

    // Pokud blok obsahuje relevantní transakce, přidej ho do výsledku
    if (relevantTransactions.length > 0) {
      filteredBlocks.push({
        block: block.block,
        transactions: relevantTransactions,
      });
    }
  }

  // Pokud jsme našli relevantní transakce, vrať filtrovaný payload
  if (filteredBlocks.length > 0) {
    return {
      data: filteredBlocks,
    };
  }

  // Žádné relevantní transakce - neposílej webhook
  return null;
}
EOF

echo "✅ Vygenerován soubor: quicknode-streams-filter-generated.js"
echo "📋 Počet tracked wallets: $COUNT"
echo ""
echo "Další kroky:"
echo "1. Zkopíruj obsah quicknode-streams-filter-generated.js"
echo "2. Jdi do QuickNode Dashboard > Streams"
echo "3. Vlož kód do 'Filter Function'"
echo "4. Nastav webhook URL: https://tradooor.stepanpanek.cz/api/webhooks/quicknode"
echo "5. Ulož změny"

