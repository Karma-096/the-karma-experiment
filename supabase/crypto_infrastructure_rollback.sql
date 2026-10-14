-- Manual rollback for migration 20261014043027.
-- Run only after exporting any real observations and unlinking contribution rows.
DO $$
DECLARE job_id bigint;
BEGIN
  SELECT jobid INTO job_id FROM cron.job WHERE jobname='karma-crypto-scan-15m';
  IF job_id IS NOT NULL THEN PERFORM cron.unschedule(job_id); END IF;
END;
$$;

DROP FUNCTION IF EXISTS karma_internal.trigger_crypto_scan(text,boolean);
DROP FUNCTION IF EXISTS public.approve_karma_crypto_attribution(uuid,text);
DROP FUNCTION IF EXISTS public.submit_karma_crypto_attribution_claim(uuid,text,text,boolean,boolean,text,text);
DROP FUNCTION IF EXISTS public.finish_karma_crypto_scan_run(uuid,text,jsonb,integer,integer,integer,text);
DROP FUNCTION IF EXISTS public.record_karma_crypto_observation(uuid,jsonb);
DROP FUNCTION IF EXISTS public.save_karma_crypto_checkpoint(uuid,text,bigint,text,bigint,boolean,text);
DROP FUNCTION IF EXISTS public.claim_karma_crypto_scan_invocation(text);
DROP TABLE IF EXISTS karma_internal.crypto_attribution_claims;
DROP TABLE IF EXISTS karma_internal.crypto_observations;
DROP TABLE IF EXISTS karma_internal.crypto_scan_runs;
DROP TABLE IF EXISTS karma_internal.crypto_scan_invocations;
DROP TABLE IF EXISTS karma_internal.crypto_checkpoints;
DROP TABLE IF EXISTS karma_internal.crypto_providers;
DROP TABLE IF EXISTS karma_internal.crypto_assets;
DROP TABLE IF EXISTS karma_internal.crypto_settings;
-- pg_cron and pg_net are shared extensions and are intentionally retained.
