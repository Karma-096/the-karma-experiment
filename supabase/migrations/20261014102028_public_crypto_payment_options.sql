-- Public payment options remain fail-closed. Recipient data is returned only
-- when both global launch switches are enabled and the asset is enabled.

ALTER TABLE karma_internal.crypto_assets
  ADD COLUMN IF NOT EXISTS qr_data_url text;

ALTER TABLE karma_internal.crypto_assets
  DROP CONSTRAINT IF EXISTS crypto_assets_qr_data_url_check;

ALTER TABLE karma_internal.crypto_assets
  ADD CONSTRAINT crypto_assets_qr_data_url_check
  CHECK (
    qr_data_url IS NULL OR (
      length(qr_data_url) BETWEEN 100 AND 100000
      AND qr_data_url LIKE 'data:image/png;base64,%'
    )
  );

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

COMMENT ON FUNCTION public.get_karma_payment_options() IS
  'Returns public receiving options only after scanner and payment launch switches are both enabled.';
