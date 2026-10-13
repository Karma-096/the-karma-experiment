-- No anonymous table access is added. Rate bookkeeping is private and expires.
CREATE SCHEMA IF NOT EXISTS karma_internal;
REVOKE ALL ON SCHEMA karma_internal FROM PUBLIC, anon, authenticated;
CREATE TABLE karma_internal.message_rate_limits (
  client_hash text PRIMARY KEY CHECK (client_hash ~ '^[0-9a-f]{64}$'),
  minute_started timestamptz NOT NULL,
  minute_count integer NOT NULL,
  hour_started timestamptz NOT NULL,
  hour_count integer NOT NULL,
  updated_at timestamptz NOT NULL
);
ALTER TABLE karma_internal.message_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON karma_internal.message_rate_limits FROM PUBLIC, anon, authenticated;
CREATE INDEX message_rate_limits_updated_idx ON karma_internal.message_rate_limits(updated_at);

CREATE OR REPLACE FUNCTION public.check_karma_message_rate_limit(p_client_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE state karma_internal.message_rate_limits%ROWTYPE;
DECLARE now_at timestamptz := clock_timestamp();
BEGIN
  IF p_client_hash IS NULL OR p_client_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid rate key' USING ERRCODE = '22023';
  END IF;
  DELETE FROM karma_internal.message_rate_limits WHERE updated_at < now_at - interval '24 hours';
  INSERT INTO karma_internal.message_rate_limits AS limits
    (client_hash, minute_started, minute_count, hour_started, hour_count, updated_at)
  VALUES (p_client_hash, now_at, 1, now_at, 1, now_at)
  ON CONFLICT (client_hash) DO UPDATE SET
    minute_count = CASE WHEN limits.minute_started <= now_at - interval '1 minute' THEN 1 ELSE limits.minute_count + 1 END,
    minute_started = CASE WHEN limits.minute_started <= now_at - interval '1 minute' THEN now_at ELSE limits.minute_started END,
    hour_count = CASE WHEN limits.hour_started <= now_at - interval '1 hour' THEN 1 ELSE limits.hour_count + 1 END,
    hour_started = CASE WHEN limits.hour_started <= now_at - interval '1 hour' THEN now_at ELSE limits.hour_started END,
    updated_at = now_at
  RETURNING * INTO state;
  RETURN state.minute_count <= 5 AND state.hour_count <= 20;
END; $$;
REVOKE ALL ON FUNCTION public.check_karma_message_rate_limit(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_karma_message_rate_limit(text) TO service_role;

ALTER TABLE public.karma_messages ADD COLUMN consent_publication boolean NOT NULL DEFAULT false;
CREATE INDEX karma_messages_sender_time_idx ON public.karma_messages(lower(nickname), country_code, created_at DESC);
CREATE INDEX karma_messages_approved_time_idx ON public.karma_messages(created_at DESC) WHERE approved AND consent_publication;
CREATE INDEX karma_messages_participant_idx ON public.karma_messages(participant_id);

CREATE OR REPLACE FUNCTION public.submit_karma_message(p_nickname text, p_country_code text, p_message text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE clean_nickname text := btrim(p_nickname);
DECLARE clean_message text := btrim(p_message);
DECLARE new_id uuid;
BEGIN
  IF clean_nickname IS NULL OR length(clean_nickname) NOT BETWEEN 2 AND 40
    OR p_country_code IS NULL OR NOT (p_country_code = ANY(string_to_array(
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW', ' ')))
    OR clean_message IS NULL OR length(clean_message) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Invalid form data' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(clean_nickname) || chr(31) || p_country_code, 0));
  IF EXISTS (SELECT 1 FROM public.karma_messages m WHERE lower(m.nickname) = lower(clean_nickname)
    AND m.country_code = p_country_code AND m.message = clean_message AND m.created_at >= now() - interval '24 hours') THEN
    RAISE EXCEPTION 'Duplicate submission' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.karma_messages m WHERE lower(m.nickname) = lower(clean_nickname)
    AND m.country_code = p_country_code AND m.created_at >= now() - interval '1 minute')
    OR (SELECT count(*) FROM public.karma_messages m WHERE lower(m.nickname) = lower(clean_nickname)
      AND m.country_code = p_country_code AND m.created_at >= now() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION 'Submission rate limited' USING ERRCODE = 'P0429';
  END IF;
  INSERT INTO public.karma_messages(nickname, country_code, message, approved, consent_publication)
    VALUES(clean_nickname, p_country_code, clean_message, false, true) RETURNING id INTO new_id;
  RETURN new_id;
END; $$;
REVOKE ALL ON FUNCTION public.submit_karma_message(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_karma_message(text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_karma_messages()
RETURNS TABLE(nickname text, country_code text, message text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT m.nickname, m.country_code, m.message, m.created_at FROM public.karma_messages m
  WHERE m.approved IS TRUE AND m.consent_publication IS TRUE ORDER BY m.created_at DESC, m.id LIMIT 100;
$$;
REVOKE ALL ON FUNCTION public.get_karma_messages() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_karma_messages() TO anon, authenticated, service_role;
