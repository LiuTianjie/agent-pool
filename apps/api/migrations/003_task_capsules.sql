ALTER TABLE pools DROP CONSTRAINT IF EXISTS pools_status_check;
ALTER TABLE pools ADD CONSTRAINT pools_status_check CHECK (status IN (
  'piloting', 'waiting_capacity', 'queued', 'running', 'paused', 'completed', 'cancelled'
));

ALTER TABLE task_units DROP CONSTRAINT IF EXISTS task_units_status_check;
ALTER TABLE task_units ADD CONSTRAINT task_units_status_check CHECK (status IN (
  'held', 'queued', 'leased', 'submitted', 'accepted', 'failed', 'cancelled'
));

ALTER TABLE pools
  ADD COLUMN task_capsule_ciphertext text,
  ADD COLUMN contract_hash text CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN delivery_mode text NOT NULL DEFAULT 'platform'
    CHECK (delivery_mode IN ('platform', 'webhook')),
  ADD COLUMN delivery_config_ciphertext text,
  ADD COLUMN launch_mode text NOT NULL DEFAULT 'immediate'
    CHECK (launch_mode IN ('pilot', 'immediate')),
  ADD COLUMN pilot_units integer NOT NULL DEFAULT 0 CHECK (pilot_units BETWEEN 0 AND 3),
  ADD COLUMN legacy_contract boolean NOT NULL DEFAULT true;

ALTER TABLE task_units
  ADD COLUMN is_pilot boolean NOT NULL DEFAULT false;

ALTER TABLE runner_nodes
  ADD COLUMN supports_direct_webhooks boolean NOT NULL DEFAULT false;

CREATE TABLE webhook_receipts (
  id uuid PRIMARY KEY,
  receipt_id text NOT NULL UNIQUE CHECK (char_length(receipt_id) BETWEEN 1 AND 200),
  lease_id uuid NOT NULL UNIQUE,
  unit_id uuid NOT NULL REFERENCES task_units(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL,
  contract_hash text NOT NULL CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
  result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  retryable boolean NOT NULL,
  reason_ciphertext text,
  attempt integer NOT NULL CHECK (attempt > 0),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_receipts_unit_attempt_idx
  ON webhook_receipts(unit_id, attempt DESC);

CREATE TABLE lease_submissions (
  lease_id uuid PRIMARY KEY,
  unit_id uuid NOT NULL REFERENCES task_units(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL,
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
