-- Keep only a keyed digest of successfully verified Turnstile tokens.
CREATE TABLE karma_internal.turnstile_token_claims (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE karma_internal.turnstile_token_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON karma_internal.turnstile_token_claims FROM PUBLIC, anon, authenticated;
CREATE INDEX turnstile_token_claims_time_idx ON karma_internal.turnstile_token_claims(claimed_at);

CREATE OR REPLACE FUNCTION public.claim_karma_turnstile_token(p_token_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE claimed boolean;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid token digest' USING ERRCODE = '22023';
  END IF;
  DELETE FROM karma_internal.turnstile_token_claims WHERE claimed_at < clock_timestamp() - interval '24 hours';
  INSERT INTO karma_internal.turnstile_token_claims(token_hash)
    VALUES (p_token_hash) ON CONFLICT (token_hash) DO NOTHING
    RETURNING true INTO claimed;
  RETURN coalesce(claimed, false);
END; $$;
REVOKE ALL ON FUNCTION public.claim_karma_turnstile_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_karma_turnstile_token(text) TO service_role;
