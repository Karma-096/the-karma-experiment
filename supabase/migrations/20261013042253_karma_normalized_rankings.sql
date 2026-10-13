-- A BTC amount must never be added directly to a USDT amount.
-- Only a trusted observer can supply a documented common-currency valuation.
ALTER TABLE public.karma_contributions
  ADD COLUMN amount_usd numeric CHECK (amount_usd IS NULL OR (amount_usd > 0 AND amount_usd < 'Infinity'::numeric)),
  ADD COLUMN valuation_source text,
  ADD COLUMN valued_at timestamptz,
  ADD COLUMN is_test boolean NOT NULL DEFAULT false;
CREATE INDEX karma_contributions_participant_idx ON public.karma_contributions(participant_id);

CREATE OR REPLACE FUNCTION public.get_karma_country_ranking()
RETURNS TABLE(country_code text, rank bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  WITH totals AS (
    SELECT c.country_code, sum(c.amount_usd) AS total FROM public.karma_contributions c
    JOIN public.karma_participants p ON p.id = c.participant_id
    WHERE c.verified IS TRUE AND p.show_in_ranking IS TRUE AND c.is_test IS FALSE
      AND c.amount_usd > 0 AND nullif(btrim(c.valuation_source), '') IS NOT NULL AND c.valued_at IS NOT NULL
    GROUP BY c.country_code
  )
  SELECT totals.country_code, rank() OVER(ORDER BY totals.total DESC) FROM totals ORDER BY rank, country_code;
$$;
CREATE OR REPLACE FUNCTION public.get_karma_leader_ranking()
RETURNS TABLE(nickname text, country_code text, rank bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT p.nickname, p.country_code, rank() OVER(ORDER BY sum(c.amount_usd) DESC)
  FROM public.karma_participants p JOIN public.karma_contributions c ON c.participant_id = p.id
  WHERE c.verified IS TRUE AND p.show_in_ranking IS TRUE AND c.is_test IS FALSE
    AND c.amount_usd > 0 AND nullif(btrim(c.valuation_source), '') IS NOT NULL AND c.valued_at IS NOT NULL
  GROUP BY p.id, p.nickname, p.country_code ORDER BY rank, p.nickname, p.id;
$$;
CREATE OR REPLACE FUNCTION public.get_karma_stats()
RETURNS TABLE(participants bigint, countries bigint, transfers bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT count(DISTINCT p.id), count(DISTINCT c.country_code), count(*)
  FROM public.karma_contributions c JOIN public.karma_participants p ON p.id = c.participant_id
  WHERE c.verified IS TRUE AND p.show_in_ranking IS TRUE AND c.is_test IS FALSE
    AND c.amount_usd > 0 AND nullif(btrim(c.valuation_source), '') IS NOT NULL AND c.valued_at IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.get_karma_country_ranking(), public.get_karma_leader_ranking(), public.get_karma_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_karma_country_ranking(), public.get_karma_leader_ranking(), public.get_karma_stats() TO anon, authenticated, service_role;
