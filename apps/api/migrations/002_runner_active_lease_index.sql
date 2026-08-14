CREATE INDEX IF NOT EXISTS task_units_runner_active_idx
  ON task_units (leased_runner_id, lease_expires_at)
  WHERE status = 'leased';
