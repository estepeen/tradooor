#!/bin/bash
# Skript pro změnu sellTradeId na nullable pomocí Prisma migrate

set -e

cd "$(dirname "$0")/.."

echo "🔧 Making sellTradeId nullable in ClosedLot table..."

cd packages/db

# Vytvoř migraci
pnpm db:migrate dev --name make_sell_trade_id_nullable --create-only

echo ""
echo "📝 Uprav migrační soubor v prisma/migrations/.../migration.sql"
echo "   Přidej: ALTER TABLE \"ClosedLot\" ALTER COLUMN \"sellTradeId\" DROP NOT NULL;"
echo ""
echo "Pak spusť: pnpm db:migrate deploy"

