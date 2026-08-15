ALTER TABLE pools
  ADD COLUMN dataset_mode text NOT NULL DEFAULT 'inline'
    CHECK (dataset_mode IN ('inline', 'https')),
  ADD COLUMN dataset_host text,
  ADD COLUMN dataset_url_ciphertext text;

ALTER TABLE task_units
  ALTER COLUMN input_ciphertext DROP NOT NULL,
  ADD COLUMN input_sha256 text CHECK (input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN source_offset bigint CHECK (source_offset IS NULL OR source_offset >= 0),
  ADD COLUMN source_length integer CHECK (source_length IS NULL OR source_length > 0);

ALTER TABLE task_units
  ADD CONSTRAINT task_units_input_present CHECK (
    input_ciphertext IS NOT NULL OR (input_sha256 IS NOT NULL AND source_offset IS NOT NULL AND source_length IS NOT NULL)
  );
