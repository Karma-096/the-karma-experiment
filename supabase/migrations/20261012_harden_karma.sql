-- THE KARMA EXPERIMENT: apply after reviewing the live function definitions.
-- This migration preserves existing rows and public RPC result shapes.
-- It does not grant anonymous access to tables or privileged message submission.

CREATE OR REPLACE FUNCTION public.get_karma_country_ranking()
RETURNS TABLE (country_code text, rank bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  WITH totals AS (
    SELECT p.country_code, SUM(c.amount) AS total
    FROM public.karma_contributions AS c
    JOIN public.karma_participants AS p ON p.id = c.participant_id
    WHERE c.verified IS TRUE AND p.show_in_ranking IS TRUE
    GROUP BY p.country_code
  )
  SELECT totals.country_code, RANK() OVER (ORDER BY totals.total DESC) AS rank
  FROM totals
  ORDER BY rank, totals.country_code;
$$;

REVOKE ALL ON FUNCTION public.get_karma_country_ranking() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_karma_country_ranking() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_karma_message(
  p_nickname text, p_country_code text, p_message text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  clean_nickname text := btrim(p_nickname);
  clean_message text := btrim(p_message);
  new_id uuid;
BEGIN
  IF clean_nickname IS NULL OR length(clean_nickname) NOT BETWEEN 2 AND 40
     OR p_country_code IS NULL OR p_country_code !~ '^[A-Z]{2}$'
     OR clean_message IS NULL OR length(clean_message) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Invalid form data' USING ERRCODE = '22023';
  END IF;

  -- Serialize identical submissions so concurrent requests cannot evade the check.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      lower(clean_nickname) || chr(31) || p_country_code || chr(31) || clean_message, 0
    )
  );
  IF EXISTS (
    SELECT 1 FROM public.karma_messages AS m
    WHERE lower(m.nickname) = lower(clean_nickname)
      AND m.country_code = p_country_code
      AND m.message = clean_message
      AND m.created_at >= now() - interval '24 hours'
  ) THEN
    RAISE EXCEPTION 'Duplicate submission' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.karma_messages (nickname, country_code, message, approved)
  VALUES (clean_nickname, p_country_code, clean_message, FALSE)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_karma_message(text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_karma_message(text, text, text)
  TO service_role;
