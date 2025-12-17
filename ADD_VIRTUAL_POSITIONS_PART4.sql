-- PART 4: Triggers for updatedAt
-- Spusť tuto část ČTVRTOU

CREATE OR REPLACE FUNCTION update_virtual_position_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS virtual_position_updated_at ON "VirtualPosition";
CREATE TRIGGER virtual_position_updated_at
  BEFORE UPDATE ON "VirtualPosition"
  FOR EACH ROW
  EXECUTE FUNCTION update_virtual_position_updated_at();

DROP TRIGGER IF EXISTS position_wallet_activity_updated_at ON "PositionWalletActivity";
CREATE TRIGGER position_wallet_activity_updated_at
  BEFORE UPDATE ON "PositionWalletActivity"
  FOR EACH ROW
  EXECUTE FUNCTION update_virtual_position_updated_at();

