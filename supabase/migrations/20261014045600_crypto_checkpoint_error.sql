ALTER TABLE karma_internal.crypto_checkpoints
  ADD COLUMN IF NOT EXISTS last_error text
  CHECK (last_error IS NULL OR length(last_error) <= 300);
