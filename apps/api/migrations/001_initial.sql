CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower_unique ON users ((lower(email)));

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);

CREATE TABLE wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  purchased_available bigint NOT NULL DEFAULT 0 CHECK (purchased_available >= 0),
  purchased_locked bigint NOT NULL DEFAULT 0 CHECK (purchased_locked >= 0),
  earned_pending bigint NOT NULL DEFAULT 0 CHECK (earned_pending >= 0),
  earned_available bigint NOT NULL DEFAULT 0 CHECK (earned_available >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_ledger (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket text NOT NULL CHECK (bucket IN (
    'purchased_available', 'purchased_locked', 'earned_pending', 'earned_available'
  )),
  delta bigint NOT NULL CHECK (delta <> 0),
  kind text NOT NULL CHECK (kind IN (
    'dev_topup', 'dev_withdrawal', 'pool_lock', 'pool_refund', 'unit_settlement', 'earning_release'
  )),
  reference_type text,
  reference_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credit_ledger_user_created_idx ON credit_ledger(user_id, created_at DESC);

CREATE TABLE withdrawal_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credits bigint NOT NULL CHECK (credits > 0),
  status text NOT NULL CHECK (status IN ('simulated_paid')),
  note text NOT NULL DEFAULT 'Development simulation only; no fiat payment was made.',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX withdrawal_requests_user_created_idx
  ON withdrawal_requests(user_id, created_at DESC);

CREATE TABLE pools (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  category text NOT NULL CHECK (category IN ('text', 'data', 'coding', 'research', 'math', 'vision', 'other')),
  requested_agent text NOT NULL CHECK (requested_agent IN ('codex', 'claude', 'mock')),
  requested_model text NOT NULL CHECK (char_length(requested_model) BETWEEN 1 AND 120),
  public_summary text NOT NULL CHECK (char_length(public_summary) BETWEEN 8 AND 300),
  secret_instruction_ciphertext text NOT NULL,
  reward_per_unit bigint NOT NULL CHECK (reward_per_unit > 0),
  validation_mode text NOT NULL CHECK (validation_mode IN ('auto', 'manual')),
  output_schema jsonb,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  required_concurrency integer NOT NULL CHECK (required_concurrency BETWEEN 1 AND 20000),
  max_unit_seconds integer NOT NULL CHECK (max_unit_seconds BETWEEN 10 AND 3600),
  deadline_at timestamptz NOT NULL,
  total_units integer NOT NULL CHECK (total_units BETWEEN 1 AND 20000),
  status text NOT NULL DEFAULT 'waiting_capacity' CHECK (status IN (
    'waiting_capacity', 'queued', 'running', 'paused', 'completed', 'cancelled'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  terminal_reason text CHECK (terminal_reason IN ('deadline', 'cancelled_by_publisher'))
);

CREATE INDEX pools_owner_created_idx ON pools(owner_id, created_at DESC);
CREATE INDEX pools_active_match_idx ON pools(status, category, requested_agent, requested_model, deadline_at);

CREATE TABLE runner_credentials (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT 'Agent Pool CLI',
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_authorizations (
  id uuid PRIMARY KEY,
  device_code_hash text NOT NULL UNIQUE,
  user_code_hash text NOT NULL UNIQUE,
  runner_label text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'consumed', 'expired')),
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  runner_credential_id uuid REFERENCES runner_credentials(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_authorizations_expiry_idx ON device_authorizations(expires_at);

CREATE TABLE runner_nodes (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL REFERENCES runner_credentials(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  platform text,
  runner_version text,
  status text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'paused', 'offline')),
  max_concurrency integer NOT NULL DEFAULT 1 CHECK (max_concurrency BETWEEN 1 AND 64),
  active_leases integer NOT NULL DEFAULT 0 CHECK (active_leases >= 0),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (credential_id, name)
);

CREATE INDEX runner_nodes_owner_idx ON runner_nodes(owner_id, created_at DESC);
CREATE INDEX runner_nodes_online_idx ON runner_nodes(status, last_seen_at DESC);

CREATE TABLE runner_capabilities (
  node_id uuid NOT NULL REFERENCES runner_nodes(id) ON DELETE CASCADE,
  adapter text NOT NULL CHECK (adapter IN ('codex', 'claude', 'mock')),
  supported_models text[] NOT NULL CHECK (cardinality(supported_models) > 0 AND NOT ('*' = ANY(supported_models))),
  version text,
  PRIMARY KEY (node_id, adapter)
);

CREATE TABLE runner_certifications (
  id uuid PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES runner_nodes(id) ON DELETE CASCADE,
  adapter text NOT NULL CHECK (adapter IN ('codex', 'claude', 'mock')),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 120),
  certified_concurrency integer NOT NULL CHECK (certified_concurrency >= 0),
  p50_ms integer NOT NULL CHECK (p50_ms >= 0),
  p95_ms integer NOT NULL CHECK (p95_ms >= 0),
  success_rate double precision NOT NULL CHECK (success_rate BETWEEN 0 AND 1),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, adapter, model)
);

CREATE INDEX runner_certifications_lookup_idx
  ON runner_certifications(adapter, model, expires_at);

CREATE TABLE benchmark_attempts (
  id uuid PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES runner_nodes(id) ON DELETE CASCADE,
  adapter text NOT NULL CHECK (adapter IN ('codex', 'claude', 'mock')),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 120),
  requested_concurrency integer NOT NULL CHECK (requested_concurrency BETWEEN 1 AND 64),
  challenge_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed', 'expired')),
  expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz
);

CREATE INDEX benchmark_attempts_node_idx ON benchmark_attempts(node_id, started_at DESC);

CREATE TABLE task_units (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  label_ciphertext text,
  input_ciphertext text NOT NULL,
  expected_output_ciphertext text,
  result_ciphertext text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'leased', 'submitted', 'accepted', 'failed', 'cancelled'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_id uuid UNIQUE,
  leased_runner_id uuid REFERENCES runner_nodes(id) ON DELETE SET NULL,
  lease_expires_at timestamptz,
  stage text,
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  validation jsonb,
  failure_reason text,
  submitted_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id, ordinal)
);

CREATE INDEX task_units_pool_status_idx ON task_units(pool_id, status);
CREATE INDEX task_units_lease_expiry_idx ON task_units(status, lease_expires_at) WHERE status = 'leased';
CREATE INDEX task_units_queue_idx ON task_units(status, created_at) WHERE status = 'queued';

CREATE TABLE settlements (
  id uuid PRIMARY KEY,
  unit_id uuid NOT NULL UNIQUE REFERENCES task_units(id),
  pool_id uuid NOT NULL REFERENCES pools(id),
  publisher_id uuid NOT NULL REFERENCES users(id),
  worker_id uuid NOT NULL REFERENCES users(id),
  amount bigint NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'released')),
  release_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE INDEX settlements_worker_release_idx ON settlements(worker_id, status, release_at);

CREATE TABLE user_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN (
    'pool.updated', 'unit.updated', 'wallet.updated', 'runner.updated', 'system.pulse'
  )),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_events_user_id_id_idx ON user_events(user_id, id DESC);
