ALTER TABLE runner_credentials
  ADD COLUMN operator_type text NOT NULL DEFAULT 'community'
    CHECK (operator_type IN ('community', 'official'));

ALTER TABLE device_authorizations
  ADD COLUMN client text NOT NULL DEFAULT 'agentpool-cli'
    CHECK (client IN ('agentpool-cli', 'agentpool-official-fleet'));

CREATE TABLE official_fleets (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'standby'
    CHECK (mode IN ('standby', 'offline')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runner_claim_grants (
  id uuid PRIMARY KEY,
  credential_id uuid NOT NULL REFERENCES runner_credentials(id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  pool_id uuid NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  max_units integer NOT NULL CHECK (max_units BETWEEN 1 AND 20000),
  claimed_units integer NOT NULL DEFAULT 0 CHECK (
    claimed_units >= 0 AND claimed_units <= max_units
  ),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE runner_nodes
  ADD CONSTRAINT runner_nodes_id_credential_unique UNIQUE (id, credential_id);

ALTER TABLE runner_claim_grants
  ADD CONSTRAINT runner_claim_grants_node_credential_fk
  FOREIGN KEY (node_id, credential_id)
  REFERENCES runner_nodes(id, credential_id) ON DELETE CASCADE;

CREATE INDEX runner_claim_grants_credential_active_idx
  ON runner_claim_grants(credential_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX runner_claim_grants_pool_active_idx
  ON runner_claim_grants(pool_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE runner_claim_leases (
  grant_id uuid NOT NULL REFERENCES runner_claim_grants(id) ON DELETE CASCADE,
  lease_id uuid NOT NULL UNIQUE,
  unit_id uuid NOT NULL REFERENCES task_units(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, lease_id)
);

CREATE INDEX runner_credentials_operator_owner_idx
  ON runner_credentials(operator_type, owner_id)
  WHERE revoked_at IS NULL;
