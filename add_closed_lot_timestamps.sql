-- Přidat createdAt pokud neexistuje
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'ClosedLot' AND column_name = 'createdAt'
  ) THEN
    ALTER TABLE "ClosedLot" ADD COLUMN "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW();
  END IF;
END $$;

-- Přidat updatedAt pokud neexistuje
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'ClosedLot' AND column_name = 'updatedAt'
  ) THEN
    ALTER TABLE "ClosedLot" ADD COLUMN "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    
    -- Vytvořit trigger pro automatické aktualizování updatedAt
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW."updatedAt" = NOW();
      RETURN NEW;
    END;
    $$ language 'plpgsql';
    
    DROP TRIGGER IF EXISTS update_closed_lot_updated_at ON "ClosedLot";
    CREATE TRIGGER update_closed_lot_updated_at
      BEFORE UPDATE ON "ClosedLot"
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

