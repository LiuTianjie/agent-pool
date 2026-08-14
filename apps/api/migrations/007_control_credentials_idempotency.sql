CREATE TABLE control_credentials (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) > 0 AND scopes <@ ARRAY[
      'account:read', 'pools:read', 'pools:write', 'wallet:read', 'wallet:write',
      'runners:read', 'runners:pair', 'fleet:read', 'fleet:write', 'profile:write', 'events:read',
      'credentials:read', 'credentials:write'
    ]::text[]
  ),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX control_credentials_owner_created_idx
  ON control_credentials(owner_id, created_at DESC);

CREATE TABLE control_device_authorizations (
  id uuid PRIMARY KEY,
  device_code_hash text NOT NULL UNIQUE,
  user_code_hash text NOT NULL UNIQUE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) > 0 AND scopes <@ ARRAY[
      'account:read', 'pools:read', 'pools:write', 'wallet:read', 'wallet:write',
      'runners:read', 'runners:pair', 'fleet:read', 'fleet:write', 'profile:write', 'events:read',
      'credentials:read', 'credentials:write'
    ]::text[]
  ),
  requested_ttl_seconds integer NOT NULL CHECK (
    requested_ttl_seconds BETWEEN 3600 AND 7776000
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'denied', 'consumed', 'expired')
  ),
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  control_credential_id uuid REFERENCES control_credentials(id) ON DELETE SET NULL,
  issued_token_ciphertext text,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  denied_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX control_device_authorizations_expiry_idx
  ON control_device_authorizations(expires_at);

ALTER TABLE device_authorizations ADD COLUMN issued_token_ciphertext text;

CREATE TABLE idempotency_records (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_scope text NOT NULL CHECK (char_length(route_scope) BETWEEN 1 AND 120),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (owner_id, route_scope, idempotency_key)
);

CREATE INDEX idempotency_records_expiry_idx ON idempotency_records(expires_at);

CREATE TABLE runner_idempotency_records (
  credential_id uuid NOT NULL REFERENCES runner_credentials(id) ON DELETE CASCADE,
  route_scope text NOT NULL CHECK (char_length(route_scope) BETWEEN 1 AND 120),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (credential_id, route_scope, idempotency_key)
);

CREATE INDEX runner_idempotency_records_expiry_idx
  ON runner_idempotency_records(expires_at);

ALTER TABLE user_events DROP CONSTRAINT user_events_type_check;
ALTER TABLE user_events ADD CONSTRAINT user_events_type_check CHECK (type IN (
  'pool.updated', 'unit.updated', 'wallet.updated', 'runner.updated',
  'credential.updated', 'system.pulse'
));
