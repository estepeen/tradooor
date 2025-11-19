# CSV Import Guide

## Hromadný import wallet z CSV

Můžeš importovat více wallet najednou pomocí CSV souboru.

## CSV Formát

CSV soubor musí mít hlavičku s následujícími sloupci:

```csv
Name;Wallet
My Trader;7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Another Trader;9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM
```

### Sloupce:

- **Name** (volitelné, první sloupec) - Název pro wallet. Můžeš použít stejný name pro více wallet (např. pokud má jeden uživatel více wallet)
- **Wallet** (povinné, druhý sloupec) - Solana wallet address
- **tags** (volitelné) - Tagy oddělené čárkou nebo mezerou (např. "degen, sniper" nebo "degen sniper")

**Poznámka:** Podporuje se i starý formát `Label` místo `Name` a různé pořadí sloupců pro zpětnou kompatibilitu.

### Příklad CSV souboru:

**Základní formát (Name;Wallet se středníkem):**
```csv
Name;Wallet
Top Trader;7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Call Channel;9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM
Whale;5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1
```

**Jeden uživatel s více wallet (stejný Name):**
```csv
Name;Wallet
John Doe;7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
John Doe;9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM
John Doe;5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1
```

**S tagy:**
```csv
Name;Wallet;tags
Top Trader;7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU;degen sniper
Call Channel;9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM;calls
```

**Minimální formát (jen adresy):**
```csv
Wallet
7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM
```

**Poznámka:** Podporuje se i starý formát `Label` místo `Name` a různé pořadí sloupců pro zpětnou kompatibilitu.

## Použití

### 1. Přes curl:

```bash
curl -X POST http://localhost:3001/api/smart-wallets/import \
  -F "file=@wallets.csv"
```

### 2. Přes Postman/Insomnia:

1. Metoda: `POST`
2. URL: `http://localhost:3001/api/smart-wallets/import`
3. Body type: `form-data`
4. Key: `file` (type: File)
5. Value: vyber CSV soubor

### 3. Přes JavaScript/Fetch:

```javascript
const formData = new FormData();
formData.append('file', csvFile);

const response = await fetch('http://localhost:3001/api/smart-wallets/import', {
  method: 'POST',
  body: formData,
});

const result = await response.json();
console.log(result);
```

## Response

### Úspěšný import:

```json
{
  "success": true,
  "total": 10,
  "created": 8,
  "errors": 2,
  "createdWallets": [...],
  "errors": [
    {
      "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      "error": "Wallet already exists"
    }
  ]
}
```

### Chyby validace:

```json
{
  "error": "Validation errors found",
  "validationErrors": [
    {
      "row": 3,
      "address": "invalid-address",
      "error": "Invalid Solana address"
    }
  ],
  "validWallets": 5
}
```

## Omezení

- Maximální velikost souboru: 5MB
- Podporované formáty: CSV (.csv)
- Duplicitní adresy v CSV budou přeskočeny (pouze první bude importována)
- Wallet, které už existují v databázi, budou přeskočeny

## Tipy

- Použij UTF-8 encoding pro CSV soubor
- Prázdné řádky budou automaticky přeskočeny
- Sloupce jsou case-insensitive (address, Address, ADDRESS - všechny fungují)
- Tagy mohou být oddělené čárkou nebo mezerou

