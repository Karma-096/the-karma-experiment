-- Fail-closed launch controls for the owner's confirmed Russian tax
-- jurisdiction. The public switch cannot be enabled until the wallet,
-- legal review and explicit owner approval are all recorded.

ALTER TABLE karma_internal.crypto_settings
  ADD COLUMN IF NOT EXISTS recipient_tax_jurisdiction text,
  ADD COLUMN IF NOT EXISTS legal_review_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS wallet_addresses_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS public_launch_approved_at timestamptz;

ALTER TABLE karma_internal.crypto_settings
  DROP CONSTRAINT IF EXISTS crypto_settings_tax_jurisdiction_check,
  DROP CONSTRAINT IF EXISTS crypto_settings_legal_review_status_check,
  DROP CONSTRAINT IF EXISTS crypto_settings_payment_launch_requirements;

ALTER TABLE karma_internal.crypto_settings
  ADD CONSTRAINT crypto_settings_tax_jurisdiction_check
    CHECK (recipient_tax_jurisdiction IS NULL OR recipient_tax_jurisdiction ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT crypto_settings_legal_review_status_check
    CHECK (legal_review_status IN ('pending','approved','rejected')),
  ADD CONSTRAINT crypto_settings_payment_launch_requirements
    CHECK (
      NOT payments_enabled OR (
        scanner_enabled
        AND legal_review_status = 'approved'
        AND wallet_addresses_verified_at IS NOT NULL
        AND public_launch_approved_at IS NOT NULL
      )
    );

UPDATE karma_internal.crypto_settings
   SET recipient_tax_jurisdiction = 'RU',
       legal_review_status = CASE
         WHEN legal_review_status = 'approved' THEN 'approved'
         ELSE 'pending'
       END,
       updated_at = clock_timestamp()
 WHERE singleton = true;

CREATE OR REPLACE FUNCTION public.get_karma_payment_options()
RETURNS TABLE (
  asset_id text,
  asset text,
  network text,
  chain_id bigint,
  kind text,
  decimals smallint,
  contract_address text,
  recipient_address text,
  minimum_confirmations integer,
  internal_transfers_supported boolean,
  qr_data_url text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT
    a.asset_id,
    a.asset,
    a.network,
    a.chain_id,
    a.kind,
    a.decimals,
    a.contract_address,
    a.recipient_address,
    a.minimum_confirmations,
    a.internal_transfers_supported,
    a.qr_data_url
  FROM karma_internal.crypto_assets AS a
  JOIN karma_internal.crypto_settings AS s ON s.singleton = true
  WHERE s.scanner_enabled = true
    AND s.payments_enabled = true
    AND s.legal_review_status = 'approved'
    AND s.wallet_addresses_verified_at IS NOT NULL
    AND s.public_launch_approved_at IS NOT NULL
    AND a.enabled = true
    AND a.recipient_address IS NOT NULL
    AND a.qr_data_url IS NOT NULL
  ORDER BY CASE a.asset_id
    WHEN 'usdt-tron' THEN 1
    WHEN 'btc-bitcoin' THEN 2
    WHEN 'eth-ethereum' THEN 3
    WHEN 'usdc-base' THEN 4
    WHEN 'bnb-bsc' THEN 5
    ELSE 99
  END;
$$;

REVOKE ALL ON FUNCTION public.get_karma_payment_options() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_karma_payment_options() TO anon, authenticated, service_role;
