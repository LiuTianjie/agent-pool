DO $migration$
DECLARE
  fleet_count bigint;
BEGIN
  SELECT count(*) INTO fleet_count FROM official_fleets;

  IF fleet_count > 1 THEN
    RAISE EXCEPTION
      'Migration 006 requires one global Official Fleet owner, but found % owner rows',
      fleet_count
      USING
        ERRCODE = '23505',
        HINT = 'Resolve the conflicting owner bindings explicitly before retrying. Automatic Official Fleet owner migration is intentionally unsupported.';
  END IF;
END;
$migration$;

ALTER TABLE official_fleets
  ADD COLUMN singleton_slot smallint NOT NULL DEFAULT 1,
  ADD CONSTRAINT official_fleets_singleton_slot_check CHECK (singleton_slot = 1),
  ADD CONSTRAINT official_fleets_singleton_slot_unique UNIQUE (singleton_slot);

COMMENT ON COLUMN official_fleets.singleton_slot IS
  'Fixed slot enforcing one global Official Fleet owner; owner migration is never implicit.';
