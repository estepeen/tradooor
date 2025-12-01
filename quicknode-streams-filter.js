/**
 * QuickNode Streams Filter Function
 * 
 * Filtruje transakce přímo na QuickNode straně, takže na server dorazí jen swapy
 * pro konkrétní token páry (TROLL/SOL, TRUMP/USDC) přes DEX programy.
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

  // Token páry, které nás zajímají
  const TARGET_PAIRS = [
    // TROLL + WSOL (SOL)
    {
      token1: 'TROLL', // Nahraď skutečným TROLL mint address
      token1Mint: 'YOUR_TROLL_MINT_ADDRESS_HERE',
      token2: 'SOL',
      token2Mint: 'So11111111111111111111111111111111111111112', // WSOL/NATIVE_MINT
    },
    // TRUMP + USDC
    {
      token1: 'TRUMP', // Nahraď skutečným TRUMP mint address
      token1Mint: 'YOUR_TRUMP_MINT_ADDRESS_HERE',
      token2: 'USDC',
      token2Mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    },
  ];

  // DEX program IDs, které nás zajímají
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
      // 1. Zkontroluj, jestli transakce volá některý DEX program
      const message = tx.transaction?.message;
      if (!message) continue;

      const accountKeys = message.accountKeys || [];
      const instructions = message.instructions || [];
      
      // Zkontroluj accountKeys - DEX program musí být v accountKeys
      let hasDexProgram = false;
      for (const key of accountKeys) {
        const pubkey = typeof key === 'string' ? key : key?.pubkey;
        if (pubkey && DEX_PROGRAMS.has(pubkey)) {
          hasDexProgram = true;
          break;
        }
      }

      // Alternativně zkontroluj instructions - programId může být v instructions
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

      // 2. Zkontroluj, jestli transakce obsahuje oba minty z některého páru
      const meta = tx.meta;
      if (!meta) continue;

      // Sběr všech mintů z preTokenBalances a postTokenBalances
      const mintsInTx = new Set();
      
      const addMintsFromBalances = (balances) => {
        if (!Array.isArray(balances)) return;
        for (const balance of balances) {
          if (balance.mint) {
            mintsInTx.add(balance.mint);
          }
        }
      };

      addMintsFromBalances(meta.preTokenBalances);
      addMintsFromBalances(meta.postTokenBalances);

      // Zkontroluj, jestli obsahuje oba minty z některého páru
      let matchesPair = false;
      for (const pair of TARGET_PAIRS) {
        const hasToken1 = mintsInTx.has(pair.token1Mint);
        const hasToken2 = mintsInTx.has(pair.token2Mint);
        if (hasToken1 && hasToken2) {
          matchesPair = true;
          break;
        }
      }

      if (matchesPair) {
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

