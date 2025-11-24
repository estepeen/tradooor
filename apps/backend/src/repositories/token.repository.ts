import { supabase, TABLES, generateId } from '../lib/supabase.js';

export class TokenRepository {
  async findByMintAddress(mintAddress: string) {
    const { data: token, error } = await supabase
      .from(TABLES.TOKEN)
      .select('*')
      .eq('mintAddress', mintAddress)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      throw new Error(`Failed to fetch token: ${error.message}`);
    }

    return token;
  }

  async findByMintAddresses(mintAddresses: string[]) {
    if (!mintAddresses.length) {
      return [];
    }

    const { data: tokens, error } = await supabase
      .from(TABLES.TOKEN)
      .select('*')
      .in('mintAddress', mintAddresses);

    if (error) {
      throw new Error(`Failed to fetch tokens: ${error.message}`);
    }

    return tokens || [];
  }

  async findOrCreate(data: {
    mintAddress: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    forceUpdate?: boolean; // Pokud true, aktualizuj i když už token existuje
  }) {
    const existing = await this.findByMintAddress(data.mintAddress);
    if (existing) {
      // Update if new data provided (symbol, name, nebo decimals)
      // DŮLEŽITÉ: Aktualizuj i když máme prázdný symbol/name - může to být oprava garbage symbolu
      // DŮLEŽITÉ: Pokud forceUpdate=true nebo existing nemá symbol/name, vždy zkus aktualizovat
      const shouldUpdate = data.forceUpdate || 
        !existing.symbol || 
        !existing.name || 
        data.symbol !== undefined || 
        data.name !== undefined || 
        data.decimals !== undefined;
        
      if (shouldUpdate) {
        const updateData: any = {};
        
        // Aktualizuj symbol pouze pokud:
        // 1. Máme nový symbol (není undefined)
        // 2. A buď existing nemá symbol, nebo nový symbol je lepší (není prázdný)
        if (data.symbol !== undefined) {
          const existingSymbol = (existing.symbol || '').trim();
          const newSymbol = (data.symbol || '').trim();
          
          // Aktualizuj pokud: nemáme symbol, nebo máme nový neprázdný symbol
          if (!existingSymbol || (newSymbol && newSymbol !== existingSymbol)) {
            updateData.symbol = data.symbol || null;
          }
        }
        
        // Podobně pro name
        if (data.name !== undefined) {
          const existingName = (existing.name || '').trim();
          const newName = (data.name || '').trim();
          
          if (!existingName || (newName && newName !== existingName)) {
            updateData.name = data.name || null;
          }
        }
        
        // Decimals vždy aktualizuj pokud je definováno
        if (data.decimals !== undefined) {
          updateData.decimals = data.decimals;
        }

        // Aktualizuj pouze pokud máme nějaká data k aktualizaci
        if (Object.keys(updateData).length > 0) {
          const { data: updated, error } = await supabase
            .from(TABLES.TOKEN)
            .update(updateData)
            .eq('mintAddress', data.mintAddress)
            .select()
            .single();

          if (error) {
            throw new Error(`Failed to update token: ${error.message}`);
          }

          return updated;
        }
      }
      return existing;
    }

    // Create new token
    const { data: created, error } = await supabase
      .from(TABLES.TOKEN)
      .insert({
        id: generateId(),
        mintAddress: data.mintAddress,
        symbol: data.symbol ?? null,
        name: data.name ?? null,
        decimals: data.decimals ?? 9,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create token: ${error.message}`);
    }

    return created;
  }

  async findById(id: string) {
    const { data: token, error } = await supabase
      .from(TABLES.TOKEN)
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to fetch token by id: ${error.message}`);
    }

    return token;
  }
}
