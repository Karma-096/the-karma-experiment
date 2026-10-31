-- Forward-only repair; no wallet, approval, flag, cron, or data resets.

CREATE OR REPLACE FUNCTION public.claim_karma_crypto_scan_invocation(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE invocation karma_internal.crypto_scan_invocations%ROWTYPE;
DECLARE run_id uuid;
DECLARE settings karma_internal.crypto_settings%ROWTYPE;
DECLARE assets jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'Invalid invocation token' USING ERRCODE='22023';
  END IF;
  DELETE FROM karma_internal.crypto_scan_invocations WHERE expires_at < clock_timestamp() - interval '1 day';
  UPDATE karma_internal.crypto_scan_invocations
     SET claimed_at=clock_timestamp()
   WHERE token_hash=encode(extensions.digest(p_token,'sha256'),'hex')
     AND claimed_at IS NULL AND expires_at > clock_timestamp()
  RETURNING * INTO invocation;
  IF invocation.id IS NULL THEN
    RETURN jsonb_build_object('authorized',false);
  END IF;
  -- Serialize claims; never let overlapping cron/manual runs regress a cursor.
  PERFORM pg_catalog.pg_advisory_xact_lock(746231031);
  IF EXISTS(SELECT 1 FROM karma_internal.crypto_scan_runs WHERE status='running' AND started_at>clock_timestamp()-interval '10 minutes') THEN
    RETURN jsonb_build_object('authorized',false,'reason','scan_already_running');
  END IF;
  SELECT * INTO settings FROM karma_internal.crypto_settings WHERE singleton=true;
  INSERT INTO karma_internal.crypto_scan_runs(invocation_id,mode)
  VALUES(invocation.id,invocation.mode) RETURNING id INTO run_id;
  SELECT coalesce(jsonb_agg(row_data ORDER BY row_data->>'asset_id'),'[]'::jsonb) INTO assets
  FROM (
    SELECT jsonb_build_object(
      'asset_id',a.asset_id,'asset',a.asset,'network',a.network,'chain_id',a.chain_id,
      'kind',a.kind,'decimals',a.decimals,'contract_address',a.contract_address,
      'recipient_address',a.recipient_address,'minimum_confirmations',a.minimum_confirmations,
      'enabled',a.enabled,'scan_start_at',a.created_at,'checkpoint',to_jsonb(c),
      'known_observations',coalesce((SELECT jsonb_agg(jsonb_build_object(
        'transaction_hash',o.transaction_hash,'status',o.status,'block_height',o.block_height,
        'block_hash',o.block_hash,'confirmations',o.confirmations,'observed_at',o.observed_at,
        'amount_atomic',o.amount_atomic::text,'amount_decimal',o.amount::text,'decimals',o.decimals,
        'valuation_status',o.valuation_status,'price_usd',o.price_usd::text,
        'amount_usd',o.amount_usd::text,'valuation_sources',o.valuation_sources,'valued_at',o.valued_at
      ) ORDER BY o.first_seen_at DESC) FROM (
        SELECT * FROM karma_internal.crypto_observations recent
        WHERE recent.asset_id=a.asset_id AND recent.status IN ('confirmed','pending','needs_review','reorged')
        ORDER BY recent.last_checked_at ASC,recent.id ASC LIMIT 250
      ) o),'[]'::jsonb),
      'providers',coalesce((SELECT jsonb_agg(jsonb_build_object(
        'purpose',p.purpose,'operator',p.operator,'kind',p.kind,'url',p.base_url,'configuration',p.configuration
      ) ORDER BY p.purpose,p.operator) FROM karma_internal.crypto_providers p WHERE p.asset_id=a.asset_id AND p.enabled),'[]'::jsonb)
    ) AS row_data
    FROM karma_internal.crypto_assets a
    LEFT JOIN karma_internal.crypto_checkpoints c USING(asset_id)
    WHERE a.recipient_address IS NOT NULL
  ) configured;
  RETURN jsonb_build_object(
    'authorized',true,'run_id',run_id,'mode',invocation.mode,
    'scanner_enabled',settings.scanner_enabled,'payments_enabled',settings.payments_enabled,
    'assets',assets
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_karma_crypto_observation(p_run_id uuid,p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE a karma_internal.crypto_assets%ROWTYPE;
DECLARE settings karma_internal.crypto_settings%ROWTYPE;
DECLARE observation_id uuid;
DECLARE saved karma_internal.crypto_observations%ROWTYPE;
DECLARE linked_contribution uuid;
DECLARE tx_hash text := lower(btrim(p_payload->>'transaction_hash'));
DECLARE state text := p_payload->>'status';
DECLARE valuation_state text := coalesce(p_payload->>'valuation_status','pending');
DECLARE amount_atomic numeric;
DECLARE amount_value numeric;
DECLARE price_value numeric;
DECLARE usd_value numeric;
DECLARE valuation_source_text text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM karma_internal.crypto_scan_runs WHERE id=p_run_id AND status='running') THEN
    RAISE EXCEPTION 'Unknown scan run' USING ERRCODE='22023';
  END IF;
  SELECT * INTO a FROM karma_internal.crypto_assets WHERE asset_id=p_payload->>'asset_id';
  IF a.asset_id IS NULL OR tx_hash IS NULL OR tx_hash !~ '^(0x)?[0-9a-f]{64}$'
     OR state NOT IN ('pending','confirmed','failed','reorged','needs_review')
     OR valuation_state NOT IN ('pending','valued','unavailable','disputed')
     OR coalesce(p_payload->>'amount_atomic','') !~ '^[0-9]{1,78}$'
     OR coalesce(p_payload->>'amount_decimal','') !~ '^[0-9]+(\.[0-9]+)?$'
     OR (p_payload->>'decimals')::integer <> a.decimals THEN
    RAISE EXCEPTION 'Invalid observation' USING ERRCODE='22023';
  END IF;
  amount_atomic := (p_payload->>'amount_atomic')::numeric;
  amount_value := (p_payload->>'amount_decimal')::numeric;
  IF amount_atomic <= 0 OR amount_value <= 0 THEN RAISE EXCEPTION 'Invalid amount' USING ERRCODE='22023'; END IF;
  IF valuation_state='valued' THEN
    IF coalesce(p_payload->>'price_usd','') !~ '^[0-9]+(\.[0-9]+)?$'
       OR coalesce(p_payload->>'amount_usd','') !~ '^[0-9]+(\.[0-9]+)?$'
       OR jsonb_typeof(coalesce(p_payload->'valuation_sources','null'::jsonb)) <> 'array'
       OR jsonb_array_length(p_payload->'valuation_sources') < 2 THEN
      RAISE EXCEPTION 'Invalid valuation evidence' USING ERRCODE='22023';
    END IF;
    price_value := (p_payload->>'price_usd')::numeric;
    usd_value := (p_payload->>'amount_usd')::numeric;
    IF price_value<=0 OR usd_value<=0 THEN RAISE EXCEPTION 'Invalid valuation' USING ERRCODE='22023'; END IF;
    SELECT string_agg(value->>'operator','+' ORDER BY value->>'operator') INTO valuation_source_text
      FROM jsonb_array_elements(p_payload->'valuation_sources') value;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(a.asset_id||chr(31)||tx_hash,0));
  IF EXISTS(SELECT 1 FROM karma_internal.crypto_observations prior
    WHERE prior.asset_id=a.asset_id AND prior.transaction_hash=tx_hash AND prior.valuation_status='valued'
      AND (prior.amount_atomic IS DISTINCT FROM (p_payload->>'amount_atomic')::numeric
           OR prior.amount IS DISTINCT FROM (p_payload->>'amount_decimal')::numeric)) THEN
    RAISE EXCEPTION 'Valued transaction amount changed; manual review required' USING ERRCODE='22023';
  END IF;
  INSERT INTO karma_internal.crypto_observations AS existing(
    asset_id,network,transaction_hash,amount_atomic,amount,decimals,block_height,block_hash,
    observed_at,confirmations,status,canonical,provider_evidence,valuation_status,price_usd,
    amount_usd,valuation_sources,valued_at,revoked_at,revocation_reason
  ) VALUES(
    a.asset_id,a.network,tx_hash,amount_atomic,amount_value,a.decimals,
    nullif(p_payload->>'block_height','')::bigint,p_payload->>'block_hash',
    nullif(p_payload->>'observed_at','')::timestamptz,coalesce((p_payload->>'confirmations')::integer,0),
    state,state='confirmed',coalesce(p_payload->'provider_evidence','[]'::jsonb),valuation_state,
    price_value,usd_value,coalesce(p_payload->'valuation_sources','[]'::jsonb),
    CASE WHEN valuation_state='valued' THEN nullif(p_payload->>'valued_at','')::timestamptz END,
    CASE WHEN state='reorged' THEN clock_timestamp() END,
    CASE WHEN state='reorged' THEN left(coalesce(p_payload->>'revocation_reason','noncanonical_block'),120) END
  )
  ON CONFLICT(asset_id,transaction_hash) DO UPDATE SET
    amount_atomic=EXCLUDED.amount_atomic,amount=EXCLUDED.amount,block_height=EXCLUDED.block_height,
    block_hash=EXCLUDED.block_hash,observed_at=coalesce(existing.observed_at,EXCLUDED.observed_at),
    confirmations=EXCLUDED.confirmations,status=EXCLUDED.status,canonical=EXCLUDED.canonical,
    provider_evidence=EXCLUDED.provider_evidence,last_checked_at=clock_timestamp(),
    valuation_status=CASE WHEN existing.valuation_status='valued' THEN existing.valuation_status ELSE EXCLUDED.valuation_status END,
    price_usd=coalesce(existing.price_usd,EXCLUDED.price_usd),amount_usd=coalesce(existing.amount_usd,EXCLUDED.amount_usd),
    valuation_sources=CASE WHEN existing.valuation_status='valued' THEN existing.valuation_sources ELSE EXCLUDED.valuation_sources END,
    valued_at=coalesce(existing.valued_at,EXCLUDED.valued_at),revoked_at=EXCLUDED.revoked_at,
    revocation_reason=EXCLUDED.revocation_reason
  RETURNING id,contribution_id INTO observation_id,linked_contribution;
  -- Publication uses the authoritative persisted valuation, never a retry's quote.
  SELECT * INTO saved FROM karma_internal.crypto_observations WHERE id=observation_id;
  SELECT * INTO settings FROM karma_internal.crypto_settings WHERE singleton=true;
  SELECT string_agg(value->>'operator','+' ORDER BY value->>'operator') INTO valuation_source_text
    FROM jsonb_array_elements(saved.valuation_sources) value;
  IF saved.status='confirmed' AND saved.valuation_status='valued' AND settings.payments_enabled THEN
    INSERT INTO public.karma_contributions(participant_id,country_code,amount,currency,transaction_hash,network,verified,amount_usd,valuation_source,valued_at,is_test)
    VALUES(NULL,'ZZ',saved.amount,a.asset,tx_hash,a.network,true,saved.amount_usd,'crypto:'||valuation_source_text,
           saved.valued_at,false)
    ON CONFLICT(network,transaction_hash) DO UPDATE SET
      amount=EXCLUDED.amount,currency=EXCLUDED.currency,verified=true,amount_usd=EXCLUDED.amount_usd,
      valuation_source=EXCLUDED.valuation_source,valued_at=EXCLUDED.valued_at,is_test=false
    RETURNING id INTO linked_contribution;
    UPDATE karma_internal.crypto_observations SET contribution_id=linked_contribution WHERE id=observation_id;
  ELSIF state IN ('reorged','failed','needs_review') THEN
    UPDATE public.karma_contributions SET verified=false WHERE id=linked_contribution;
  END IF;
  RETURN jsonb_build_object('observation_id',observation_id,'contribution_id',linked_contribution,'published_financial_record',linked_contribution IS NOT NULL);
END;
$$;

-- The HTTP caller must wait for bounded multi-batch scans.
CREATE OR REPLACE FUNCTION karma_internal.trigger_crypto_scan(p_mode text DEFAULT 'scheduled',p_allow_disabled boolean DEFAULT false)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE settings karma_internal.crypto_settings%ROWTYPE;
DECLARE raw_token uuid := extensions.gen_random_uuid();
DECLARE invocation_id uuid;
DECLARE request_id bigint;
BEGIN
  IF p_mode NOT IN ('scheduled','manual','health_check') THEN RAISE EXCEPTION 'Invalid scan mode' USING ERRCODE='22023'; END IF;
  SELECT * INTO settings FROM karma_internal.crypto_settings WHERE singleton=true;
  IF settings.project_url IS NULL OR (NOT settings.scanner_enabled AND NOT p_allow_disabled) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM karma_internal.crypto_scan_runs WHERE status='running' AND started_at>clock_timestamp()-interval '10 minutes') THEN RETURN NULL; END IF;
  INSERT INTO karma_internal.crypto_scan_invocations(token_hash,mode,expires_at)
  VALUES(encode(extensions.digest(raw_token::text,'sha256'),'hex'),p_mode,clock_timestamp()+interval '5 minutes') RETURNING id INTO invocation_id;
  SELECT net.http_post(
    url:=settings.project_url||'/functions/v1/scan-crypto-contributions',
    headers:=jsonb_build_object('Content-Type','application/json'),
    body:=jsonb_build_object('token',raw_token::text,'mode',p_mode),
    timeout_milliseconds:=180000
  ) INTO request_id;
  RETURN request_id;
END;
$$;
