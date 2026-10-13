-- Real database checks. All synthetic rows and moderation changes roll back.
BEGIN;
DO $$
DECLARE mid uuid; pid uuid; idx integer; key text := md5(random()::text)||md5(random()::text);
DECLARE countries text[] := ARRAY['DE','FR','ES','PT','RU','US','GB','CA','AU','JP','BR','IT','NL','CA'];
BEGIN
  IF EXISTS(SELECT 1 FROM public.karma_contributions) THEN RAISE EXCEPTION 'Run ranking fixtures in an isolated database when live contributions exist'; END IF;
  mid := public.submit_karma_message('KARMA_SQL_TEST_20261013','DE','Synthetic database test: <img src=x onerror=alert(1)>');
  IF NOT EXISTS(SELECT 1 FROM public.karma_messages WHERE id=mid AND approved=false AND consent_publication=true) THEN RAISE EXCEPTION 'Message defaults or consent failed'; END IF;
  IF EXISTS(SELECT 1 FROM public.get_karma_messages() WHERE nickname='KARMA_SQL_TEST_20261013') THEN RAISE EXCEPTION 'Pending message leaked'; END IF;
  BEGIN
    PERFORM public.submit_karma_message('KARMA_SQL_TEST_20261013','DE','Synthetic database test: <img src=x onerror=alert(1)>');
    RAISE EXCEPTION 'Duplicate accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM public.submit_karma_message('KARMA_SQL_TEST_20261013','DE','Different message too soon');
    RAISE EXCEPTION 'Cooldown bypassed';
  EXCEPTION WHEN SQLSTATE 'P0429' THEN NULL; END;
  BEGIN
    PERFORM public.submit_karma_message('KARMA_SQL_BAD_COUNTRY','ZZ','Invalid country test');
    RAISE EXCEPTION 'Invalid country accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  UPDATE public.karma_messages SET approved=true WHERE id=mid;
  IF NOT EXISTS(SELECT 1 FROM public.get_karma_messages() WHERE nickname='KARMA_SQL_TEST_20261013') THEN RAISE EXCEPTION 'Approved message not readable'; END IF;
  UPDATE public.karma_messages SET consent_publication=false WHERE id=mid;
  IF EXISTS(SELECT 1 FROM public.get_karma_messages() WHERE nickname='KARMA_SQL_TEST_20261013') THEN RAISE EXCEPTION 'Missing consent leaked'; END IF;
  FOR idx IN 1..5 LOOP IF NOT public.check_karma_message_rate_limit(key) THEN RAISE EXCEPTION 'Early rate rejection'; END IF; END LOOP;
  IF public.check_karma_message_rate_limit(key) THEN RAISE EXCEPTION 'Sixth attempt not rate limited'; END IF;
  IF has_function_privilege('anon','public.submit_karma_message(text,text,text)','EXECUTE') OR has_function_privilege('authenticated','public.submit_karma_message(text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'Write RPC exposed'; END IF;
  IF has_function_privilege('anon','public.check_karma_message_rate_limit(text)','EXECUTE') THEN RAISE EXCEPTION 'Rate RPC exposed'; END IF;
  IF has_table_privilege('anon','public.karma_contributions','SELECT') OR has_table_privilege('anon','public.karma_messages','INSERT') THEN RAISE EXCEPTION 'Raw data exposed'; END IF;
  FOR idx IN 1..14 LOOP
    INSERT INTO public.karma_participants(nickname,country_code,show_in_ranking) VALUES('KARMA_SQL_FIXTURE_'||idx,countries[idx],idx<>12) RETURNING id INTO pid;
    INSERT INTO public.karma_contributions(participant_id,country_code,amount,currency,transaction_hash,network,verified,amount_usd,valuation_source,valued_at,is_test)
    VALUES(pid,countries[idx],CASE WHEN idx=1 THEN 0.002 ELSE 200 END,CASE WHEN idx=1 THEN 'BTC' ELSE 'USDT' END,
      'SYNTHETIC_SQL_20261013_'||idx,'SYNTHETIC_TEST',idx<>13,CASE WHEN idx<=2 THEN 200 ELSE 100 END,
      CASE WHEN idx=14 THEN NULL ELSE 'synthetic-fixture' END,now(),true);
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.get_karma_leader_ranking()) THEN RAISE EXCEPTION 'Test transfers counted'; END IF;
  UPDATE public.karma_contributions SET is_test=false WHERE network='SYNTHETIC_TEST';
  IF (SELECT count(*) FROM public.get_karma_leader_ranking())<>11 OR (SELECT count(*) FROM public.get_karma_country_ranking())<>11 THEN RAISE EXCEPTION 'Consent/verification/valuation filter failed'; END IF;
  IF (SELECT rank FROM public.get_karma_leader_ranking() WHERE nickname='KARMA_SQL_FIXTURE_1')<>1 OR (SELECT rank FROM public.get_karma_leader_ranking() WHERE nickname='KARMA_SQL_FIXTURE_2')<>1 THEN RAISE EXCEPTION 'Cross-asset valuation or first-place tie failed'; END IF;
  IF (SELECT rank FROM public.get_karma_leader_ranking() WHERE nickname='KARMA_SQL_FIXTURE_3')<>3 THEN RAISE EXCEPTION 'Competition tie ranking failed'; END IF;
  IF (SELECT participants FROM public.get_karma_stats())<>11 THEN RAISE EXCEPTION 'Stats include excluded rows'; END IF;
  BEGIN
    INSERT INTO public.karma_contributions(country_code,amount,currency,transaction_hash,network) VALUES('DE',1,'BTC','SYNTHETIC_SQL_20261013_1','SYNTHETIC_TEST');
    RAISE EXCEPTION 'Duplicate transaction accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
ROLLBACK;
SELECT jsonb_build_object('result','passed','message_write_moderation_consent','passed','rate_limit','passed','ranking_ties_currency_consent_tests','passed','transaction_deduplication','passed','fixture_cleanup','rolled back') AS checks;
