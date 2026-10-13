# Verification

Run npm test for the isolated Edge, frontend and crypto-provider contract checks. database_contract.sql executes real database checks with transaction rollback. Ranking fixtures require an empty contribution table or an isolated database; never delete live records to run them. Mock checks do not replace a real production Turnstile submission and replay test.
