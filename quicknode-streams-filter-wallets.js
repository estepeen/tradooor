/**
 * QuickNode Streams Filter Function - Tracked Wallets Version
 * 
 * Filtruje transakce podle tracked wallets - posílá jen swapy pro sledované peněženky.
 * 
 * Instalace:
 * 1. Jdi do QuickNode Dashboard > Streams
 * 2. Vytvoř nový Stream nebo uprav existující
 * 3. Vlož tento kód do "Filter Function"
 * 4. Nastav webhook URL na: https://tradooor.stepanpanek.cz/api/webhooks/quicknode
 * 5. NAHRAĎ TRACKED_WALLETS pole skutečnými adresami z wallets.csv
 */

function main(payload) {
  // payload.data obsahuje bloky z getBlock
  if (!payload || !payload.data || !Array.isArray(payload.data)) {
    return null; // Nevalidní payload - neposílej webhook
  }

  // NAHRAĎ TYTO ADRESY SKUTEČNÝMI ADRESAMI Z wallets.csv
  // Můžeš je získat z: cat wallets.csv | cut -d',' -f1 | tail -n +2
  const TRACKED_WALLETS = new Set([
    '8rvAsDKeAcEjEkiZMug9k8v1y8mW6gQQiMobd89Uy7qR',
    '8MaVa9kdt3NW4Q5HyNAm1X5LbR8PQRVDc1W8NMVK88D5',
    // Přidej další adresy zde...
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

      if (hasTrackedWallet) {
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

