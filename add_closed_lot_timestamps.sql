-- Přidat createdAt pokud neexistuje
ALTER TABLE "ClosedLot" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Přidat updatedAt pokud neexistuje
ALTER TABLE "ClosedLot" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Vytvořit funkci pro automatické aktualizování updatedAt (pokud neexistuje)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Vytvořit trigger pro automatické aktualizování updatedAt
DROP TRIGGER IF EXISTS update_closed_lot_updated_at ON "ClosedLot";
CREATE TRIGGER update_closed_lot_updated_at
  BEFORE UPDATE ON "ClosedLot"
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

