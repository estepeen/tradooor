#!/bin/bash
# Skript pro debug - zkontroluje pořadí sloupců v ClosedLot tabulce

set -e

cd "$(dirname "$0")/.."

# Načti DATABASE_URL z .env souboru
if [ -f "apps/backend/.env" ]; then
  export DATABASE_URL=$(grep -E '^DATABASE_URL=' apps/backend/.env | cut -d '=' -f2- | tr -d '"' | tr -d "'")
fi

if [ -z "$DATABASE_URL" ]; then
  echo "❌ Error: DATABASE_URL not found in apps/backend/.env"
  exit 1
fi

echo "🔍 Checking column order in ClosedLot table..."

psql "$DATABASE_URL" -c "
SELECT 
  ordinal_position,
  column_name, 
  data_type, 
  is_nullable,
  column_default
FROM information_schema.columns 
WHERE table_name = 'ClosedLot' 
ORDER BY ordinal_position;
"

echo ""
echo "✅ Check complete!"



