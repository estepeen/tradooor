#!/bin/bash
# Skript pro přidání createdAt a updatedAt do ClosedLot tabulky

set -e

cd "$(dirname "$0")/.."

echo "🔧 Adding createdAt and updatedAt columns to ClosedLot table..."

# Načti DATABASE_URL z .env souboru
if [ -f "apps/backend/.env" ]; then
  # Načti jen DATABASE_URL, ignoruj komentáře a prázdné řádky
  export DATABASE_URL=$(grep -E '^DATABASE_URL=' apps/backend/.env | cut -d '=' -f2- | tr -d '"' | tr -d "'")
fi

if [ -z "$DATABASE_URL" ]; then
  echo "❌ Error: DATABASE_URL not found in apps/backend/.env"
  exit 1
fi

# Spusť SQL skript pomocí psql s DATABASE_URL
psql "$DATABASE_URL" -f add_closed_lot_timestamps.sql

echo "✅ Successfully added createdAt and updatedAt columns to ClosedLot table"
echo "🔄 Regenerating Prisma client..."

cd packages/db
pnpm db:generate

echo "✅ Done! You can now restart the backend."

