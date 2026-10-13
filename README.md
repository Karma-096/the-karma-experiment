# THE KARMA EXPERIMENT

Give Good. Feel Good. Existing GitHub Pages project: https://karma-096.github.io/the-karma-experiment/

The public interface supports EN, RU, FR, DE, ES and PT. Messages require Turnstile, consent and moderation. Only confirmed contributions with a documented USD valuation and publication consent can enter the rankings. Test records are excluded. Public APIs never return individual amounts.

Payments remain disabled. The crypto preparation interface names five assets and exact networks without publishing a receiving address or a payment QR code. The server-side verification core in `scripts/verify-crypto.mjs` uses only read operations and requires agreement between two independently operated data providers. It never signs or broadcasts a transaction and cannot infer participant ownership from a public transaction hash.

Run local checks with `npm ci --ignore-scripts` and `npm test`. `tests/database_contract.sql` performs real database checks with rollback; its ranking fixtures require an empty contribution table or an isolated database. It must never be used to delete live records.

Supabase migrations preserve existing records, keep raw tables private, record publication consent, add request limits and an atomic Turnstile token claim, and use common-currency ranking values. `supabase/functions/submit-karma-message/index.ts` is the deployed version 4 source, with JWT verification kept off because the endpoint validates Turnstile and only calls private write RPCs. Configuration secrets belong only in Supabase, never in this repository.

One real Turnstile submission succeeded on version 3. Its repeated request reached the duplicate-message guard, so version 4 added a separate atomic token claim. A real replay test against version 4 remains required. Crypto activation separately requires receiving-address approval, sender attribution, receipt-time valuation, a scheduler with trusted providers, and jurisdiction-specific legal/tax review.
