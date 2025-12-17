#!/bin/bash
# Skript pro kontrolu, jestli createdAt a updatedAt sloupce existují v ClosedLot tabulce

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

echo "🔍 Checking if createdAt and updatedAt columns exist in ClosedLot table..."

psql "$DATABASE_URL" -c "
SELECT 
  column_name, 
  data_type, 
  is_nullable,
  column_default
FROM information_schema.columns 
WHERE table_name = 'ClosedLot' 
  AND column_name IN ('createdAt', 'updatedAt')
ORDER BY column_name;
"

echo ""
echo "✅ Check complete!"

