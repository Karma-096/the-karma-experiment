# Verification

Run npm test for the isolated Edge, frontend and crypto-provider contract checks. database_contract.sql executes real database checks with transaction rollback. Ranking fixtures require an empty contribution table or an isolated database; never delete live records to run them. Mock checks do not replace a real production Turnstile submission and replay test.

## Privacy analytics

`npm test` also runs `analytics_collector.mjs`, `analytics_frontend.mjs` and `analytics_sql.mjs` with Node 24. These verify default-off switches, DNT/GPC, fixed event-only payloads, form behavior during telemetry failures, all six privacy translations, HTTP input limits, no outbound HTTP/identity forwarding, actual SQLite schema and atomic cap/retention/report queries. The HTTP-to-database integration uses a transactional local D1 adapter. No production writes or paid resources are needed. Hosted Cloudflare configuration and a real-browser network audit remain approval-time launch checks.
