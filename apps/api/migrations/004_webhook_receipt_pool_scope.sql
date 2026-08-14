ALTER TABLE webhook_receipts
  ADD COLUMN pool_id uuid;

UPDATE webhook_receipts receipt
SET pool_id = unit.pool_id
FROM task_units unit
WHERE unit.id = receipt.unit_id;

ALTER TABLE webhook_receipts
  ALTER COLUMN pool_id SET NOT NULL,
  ADD CONSTRAINT webhook_receipts_pool_id_fkey
    FOREIGN KEY (pool_id) REFERENCES pools(id) ON DELETE CASCADE;

ALTER TABLE webhook_receipts
  DROP CONSTRAINT webhook_receipts_receipt_id_key,
  ADD CONSTRAINT webhook_receipts_pool_receipt_id_key UNIQUE (pool_id, receipt_id);
