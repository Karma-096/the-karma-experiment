BEGIN;

DO $test$
DECLARE
  token text := '00000000-0000-4000-8000-000000000099';
  claim jsonb;
  replay jsonb;
  run_id uuid;
  first_result jsonb;
  second_result jsonb;
  observation_id uuid;
  contribution_count bigint;
  participant_count bigint;
  test_hash text := repeat('a',64);
  payload jsonb;
  attribution_id uuid;
  payment_option_count bigint;
BEGIN
  IF (SELECT scanner_enabled OR payments_enabled FROM karma_internal.crypto_settings WHERE singleton) THEN
    RAISE EXCEPTION 'Payment safety flags must remain disabled';
  END IF;
  SELECT count(*) INTO payment_option_count FROM public.get_karma_payment_options();
  IF payment_option_count <> 0 THEN RAISE EXCEPTION 'Disabled launch exposed payment options'; END IF;
  UPDATE karma_internal.crypto_assets
     SET qr_data_url='data:image/png;base64,' || repeat('A',120)
   WHERE asset_id='btc-bitcoin';
  UPDATE karma_internal.crypto_settings
     SET scanner_enabled=true,payments_enabled=true
   WHERE singleton=true;
  SELECT count(*) INTO payment_option_count
    FROM public.get_karma_payment_options()
   WHERE asset_id='btc-bitcoin';
  IF payment_option_count <> 1 THEN RAISE EXCEPTION 'Enabled launch did not expose the configured option'; END IF;
  UPDATE karma_internal.crypto_settings
     SET scanner_enabled=false,payments_enabled=false
   WHERE singleton=true;
  UPDATE karma_internal.crypto_assets SET qr_data_url=NULL WHERE asset_id='btc-bitcoin';
  IF has_schema_privilege('anon','karma_internal','USAGE')
     OR has_table_privilege('anon','karma_internal.crypto_observations','SELECT')
     OR has_table_privilege('authenticated','karma_internal.crypto_observations','SELECT')
     OR has_function_privilege('anon','public.record_karma_crypto_observation(uuid,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'Public cryptocurrency privileges detected';
  END IF;
  IF NOT has_function_privilege('anon','public.get_karma_payment_options()','EXECUTE') THEN
    RAISE EXCEPTION 'Public payment options RPC is unavailable';
  END IF;
  SELECT count(*) INTO contribution_count FROM public.karma_contributions;
  SELECT count(*) INTO participant_count FROM public.karma_participants;
  INSERT INTO karma_internal.crypto_scan_invocations(token_hash,mode,expires_at)
  VALUES(encode(extensions.digest(token,'sha256'),'hex'),'manual',clock_timestamp()+interval '5 minutes');
  claim := public.claim_karma_crypto_scan_invocation(token);
  IF NOT coalesce((claim->>'authorized')::boolean,false) THEN RAISE EXCEPTION 'Valid one-time token rejected'; END IF;
  run_id := (claim->>'run_id')::uuid;
  replay := public.claim_karma_crypto_scan_invocation(token);
  IF coalesce((replay->>'authorized')::boolean,false) THEN RAISE EXCEPTION 'Invocation token replay accepted'; END IF;

  payload := jsonb_build_object(
    'asset_id','btc-bitcoin','transaction_hash',test_hash,'amount_atomic','100000',
    'amount_decimal','0.001','decimals',8,'block_height',900000,'block_hash',repeat('b',64),
    'confirmations',6,'observed_at','2026-10-14T00:00:00Z','status','confirmed',
    'provider_evidence',jsonb_build_array(jsonb_build_object('operator','A'),jsonb_build_object('operator','B')),
    'valuation_status','valued','price_usd','65000.00','amount_usd','65.00',
    'valuation_sources',jsonb_build_array(jsonb_build_object('operator','CoinGecko'),jsonb_build_object('operator','CCData')),
    'valued_at','2026-10-14T00:00:00Z'
  );
  first_result := public.record_karma_crypto_observation(run_id,payload);
  second_result := public.record_karma_crypto_observation(run_id,payload);
  observation_id := (first_result->>'observation_id')::uuid;
  IF observation_id IS DISTINCT FROM (second_result->>'observation_id')::uuid THEN RAISE EXCEPTION 'Duplicate transaction was not idempotent'; END IF;
  IF coalesce((first_result->>'published_financial_record')::boolean,false) THEN RAISE EXCEPTION 'Disabled payment created a public contribution'; END IF;
  IF (SELECT count(*) FROM karma_internal.crypto_observations WHERE asset_id='btc-bitcoin' AND transaction_hash=test_hash)<>1 THEN RAISE EXCEPTION 'Duplicate private observation created'; END IF;
  IF (SELECT count(*) FROM public.karma_contributions)<>contribution_count THEN RAISE EXCEPTION 'Contribution data changed while payments disabled'; END IF;

  attribution_id := public.submit_karma_crypto_attribution_claim(observation_id,'PRIVATE_QA','DE',false,false,'manual_owner_review',repeat('c',64));
  IF attribution_id IS NULL THEN RAISE EXCEPTION 'Private attribution claim not recorded'; END IF;
  BEGIN
    PERFORM public.submit_karma_crypto_attribution_claim(observation_id,'INVALID_QA','DE',true,false,'manual_owner_review',repeat('d',64));
    RAISE EXCEPTION 'Ranking opt-in accepted without publication consent';
  EXCEPTION WHEN unique_violation OR invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.approve_karma_crypto_attribution(attribution_id,'qa-review');
    RAISE EXCEPTION 'Attribution approved while payments disabled';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  payload := payload || jsonb_build_object('status','reorged','valuation_status','valued','revocation_reason','synthetic_reorg');
  PERFORM public.record_karma_crypto_observation(run_id,payload);
  IF NOT EXISTS(SELECT 1 FROM karma_internal.crypto_observations WHERE id=observation_id AND status='reorged' AND NOT canonical AND revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Reorganization did not revoke canonical status';
  END IF;
  IF (SELECT count(*) FROM public.karma_participants)<>participant_count THEN RAISE EXCEPTION 'Participant data changed'; END IF;
END
$test$;

ROLLBACK;

SELECT jsonb_build_object(
  'result','PASS',
  'covered',jsonb_build_array('disabled public payment gate','enabled public payment gate','RLS/grants','one-time token replay','idempotency','no public contribution','consent gate','approval gate','reorg revocation','rollback')
) AS crypto_database_contract;
