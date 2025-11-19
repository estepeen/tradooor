# Helius Webhooks Setup

Tento dokument popisuje, jak nastavit Helius webhooks pro real-time sledování transakcí.

## Přehled

Helius webhooks umožňují real-time notifikace o transakcích pro sledované wallet adresy. Místo pollingu každou minutu dostáváme notifikaci okamžitě, když wallet provede swap.

## Výhody

- ✅ **Real-time aktualizace** - obchody se ukládají okamžitě po provedení
- ✅ **Méně API volání** - jen když je nová transakce (ne každou minutu)
- ✅ **Efektivnější** - pro 50 wallets s průměrně 100 swapy měsíčně = 5,000 kreditů (v free plánu)
- ✅ **Automatické** - žádný manuální refresh potřebný

## Nastavení

### 1. Environment Variables

Přidej do `.env` souboru:

```env
# Helius API Key (povinné)
HELIUS_API_KEY=your_helius_api_key

# Webhook URL (volitelné - pokud není nastaveno, použije se API_URL + /api/webhooks/helius)
HELIUS_WEBHOOK_URL=https://your-domain.com/api/webhooks/helius

# Nebo použij API_URL (pokud není HELIUS_WEBHOOK_URL)
API_URL=https://your-domain.com
```

**Důležité pro production:**
- Webhook URL musí být veřejně dostupná (Helius musí být schopen poslat POST request)
- Pro localhost development použij nástroj jako [ngrok](https://ngrok.com/) nebo [localtunnel](https://localtunnel.github.io/www/)

### 2. Inicializace Webhooku

Po nastavení environment variables:

1. **Spusť backend server:**
```bash
pnpm --filter backend dev
```

2. **Nastav webhook pro všechny existující walletky:**
```bash
curl -X POST http://localhost:3001/api/smart-wallets/setup-webhook
```

Nebo použij frontend - přidá se tlačítko pro setup webhooku.

### 3. Automatické vytváření webhooku

Webhook se automaticky vytvoří/aktualizuje při:
- Přidání nové wallet (POST `/api/smart-wallets`)
- Synchronizaci walletek (POST `/api/smart-wallets/sync`)

## Jak to funguje

1. **Webhook vytvoření:**
   - Při přidání wallet se vytvoří/aktualizuje Helius webhook
   - Webhook sleduje všechny trackované wallet adresy
   - Helius umožňuje až 100,000 adres v jednom webhooku

2. **Příjem notifikací:**
   - Když wallet provede swap, Helius pošle POST request na `/api/webhooks/helius`
   - Backend zpracuje transakci a uloží ji do DB
   - Automaticky se přepočítají metriky

3. **Zpracování transakce:**
   - Normalizace swapu (stejná logika jako při pollingu)
   - Uložení do DB
   - Výpočet PnL (pro SELL trades)
   - Přepočet metrik

## Open/Closed Positions

Open a Closed positions se počítají z recent trades:

- **Open Positions**: BUY trades, které ještě nejsou uzavřené SELL tradeem (balance > 0)
- **Closed Positions**: BUY trades, které jsou uzavřené SELL tradeem (balance <= 0)
- **PnL**: Počítá se z rozdílu SOL (base currency) - `proceedsBase - costBase`

## Monitoring

Webhook endpoint loguje:
- Počet přijatých transakcí
- Počet uložených swapů
- Počet přeskočených (duplikáty, non-swapy)
- Chyby při zpracování

## Troubleshooting

### Webhook nefunguje

1. **Zkontroluj, že webhook URL je veřejně dostupná:**
   ```bash
   curl -X POST https://your-domain.com/api/webhooks/helius
   ```

2. **Zkontroluj Helius dashboard:**
   - Jdi na https://dashboard.helius.dev/
   - Zkontroluj, že webhook existuje a má správné URL

3. **Zkontroluj backend logy:**
   - Měly by se zobrazit logy při příjmu webhook notifikací

### Webhook přijímá notifikace, ale neukládá trades

1. **Zkontroluj, že wallet adresa je v DB:**
   - Webhook hledá wallet podle adresy z transakce
   - Pokud wallet není v DB, transakce se přeskočí

2. **Zkontroluj logy:**
   - Měly by se zobrazit důvody, proč se trade nepřidal (duplikát, non-swap, atd.)

## Cena

- **Free plán**: 1 milion kreditů měsíčně
- **Každá webhook notifikace**: 1 kredit
- **Pro 50 wallets s průměrně 100 swapy měsíčně**: 5,000 kreditů → ✅ V free plánu

## API Endpoints

- `POST /api/webhooks/helius` - Příjem webhook notifikací (voláno Helius)
- `POST /api/smart-wallets/setup-webhook` - Nastavení webhooku pro všechny walletky

