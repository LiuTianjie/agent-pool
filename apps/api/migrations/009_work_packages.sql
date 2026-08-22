ALTER TABLE pools DROP CONSTRAINT IF EXISTS pools_total_units_check;
ALTER TABLE pools ADD CONSTRAINT pools_total_units_check
  CHECK (total_units BETWEEN 1 AND 1000000);

ALTER TABLE pools DROP CONSTRAINT IF EXISTS pools_dataset_mode_check;
ALTER TABLE pools ADD CONSTRAINT pools_dataset_mode_check
  CHECK (dataset_mode IN ('inline', 'https', 'work'));

ALTER TABLE pools
  ADD COLUMN IF NOT EXISTS work_package_url_ciphertext text,
  ADD COLUMN IF NOT EXISTS answers_url_ciphertext text,
  ADD COLUMN IF NOT EXISTS answers_host text;

ALTER TABLE task_units
  ADD COLUMN IF NOT EXISTS answer_sha256 text,
  ADD COLUMN IF NOT EXISTS answer_offset bigint,
  ADD COLUMN IF NOT EXISTS answer_length integer;

ALTER TABLE task_units DROP CONSTRAINT IF EXISTS task_units_answer_sha256_check;
ALTER TABLE task_units ADD CONSTRAINT task_units_answer_sha256_check
  CHECK (answer_sha256 IS NULL OR answer_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE task_units DROP CONSTRAINT IF EXISTS task_units_answer_offset_check;
ALTER TABLE task_units ADD CONSTRAINT task_units_answer_offset_check
  CHECK (answer_offset IS NULL OR answer_offset >= 0);
ALTER TABLE task_units DROP CONSTRAINT IF EXISTS task_units_answer_length_check;
ALTER TABLE task_units ADD CONSTRAINT task_units_answer_length_check
  CHECK (answer_length IS NULL OR answer_length > 0);

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check CHECK (kind IN (
  'dev_topup',
  'dev_withdrawal',
  'pool_lock',
  'pool_refund',
  'unit_settlement',
  'earning_release',
  'self_settlement'
));
