#!/bin/bash

# Skript pro kontrolu QuickNode webhooku
# Použití: ./check-quicknode-webhook.sh

echo "🔍 Kontrola QuickNode webhooku..."
echo ""

# 1. Test endpointu
echo "1️⃣  Test webhook endpointu:"
echo "   curl -X POST https://tradooor.stepanpanek.cz/api/webhooks/quicknode/test"
RESPONSE=$(curl -s -X POST https://tradooor.stepanpanek.cz/api/webhooks/quicknode/test)
echo "   Response: $RESPONSE"
echo ""

# 2. Kontrola PM2 logů (posledních 50 řádků)
echo "2️⃣  Poslední záznamy z backend logů:"
echo "   PM2 logs tradooor-backend --lines 50 --nostream | grep -i quicknode | tail -20"
echo ""
echo "   Spusť na serveru:"
echo "   pm2 logs tradooor-backend --lines 100 | grep -i quicknode"
echo ""

# 3. Kontrola Nginx logů
echo "3️⃣  Kontrola Nginx access logů (poslední QuickNode requesty):"
echo "   sudo tail -n 50 /var/log/nginx/tradooor-access.log | grep quicknode"
echo ""

# 4. Kontrola Nginx error logů
echo "4️⃣  Kontrola Nginx error logů:"
echo "   sudo tail -n 20 /var/log/nginx/tradooor-error.log"
echo ""

# 5. Kontrola, jestli se ukládají trady
echo "5️⃣  Kontrola posledních tradeů v DB:"
echo "   Spusť SQL dotaz na serveru:"
echo "   psql \$DATABASE_URL -c \"SELECT id, \"txSignature\", side, \"amountToken\", \"amountBase\", \"valueUsd\", timestamp, meta->>'source' as source FROM trades WHERE meta->>'source' = 'quicknode-webhook' ORDER BY timestamp DESC LIMIT 10;\""
echo ""

# 6. Kontrola QuickNode dashboardu
echo "6️⃣  QuickNode Dashboard:"
echo "   - Přihlas se na https://dashboard.quicknode.com"
echo "   - Jdi na Notifications → Streams"
echo "   - Zkontroluj, jestli je webhook aktivní a posílá notifikace"
echo "   - Zkontroluj delivery status (mělo by být 'Success')"
echo ""

# 7. Test s minimálním payloadem
echo "7️⃣  Test s minimálním payloadem:"
echo "   curl -X POST https://tradooor.stepanpanek.cz/api/webhooks/quicknode/test-minimal"
echo ""

# 8. Monitoring v reálném čase
echo "8️⃣  Monitoring v reálném čase (spusť na serveru):"
echo "   pm2 logs tradooor-backend --lines 0 | grep --line-buffered -i 'quicknode\\|webhook'"
echo ""

echo "✅ Kontrola dokončena!"
echo ""
echo "📊 Pro detailní monitoring spusť na serveru:"
echo "   watch -n 5 'pm2 logs tradooor-backend --lines 20 --nostream | grep -i quicknode | tail -10'"

