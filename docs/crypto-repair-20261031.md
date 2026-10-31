# Crypto integrity repair — 2026-10-31

The owner authorized repair of the existing payment infrastructure. Production inspection found both flags enabled, five NULL scan checkpoints, and no stored observations or contributions. The public payment flag was temporarily disabled at 03:09:39 UTC; the scanner remained enabled. The payment RPC returned zero rows afterwards. This does not revoke previously copied blockchain addresses or prove there were no historical transfers.

## Changes

- Discovery returns actual scanned coverage independently of transactions found. EVM history starts at the configured asset's creation time when no checkpoint exists, using a timestamp-to-block search. It never silently starts at the moving chain tip.
- A scan advances through bounded contiguous chunks, saves each fully processed chunk, checks the previous checkpoint hash, and reports `partial` while behind. Failed saves, unconfirmed new candidates, or changed checkpoint blocks cannot advance coverage. A previous successful chunk survives a later failure.
- BTC and TRON discovery follow pagination. Repeated, missing, or excessive cursors fail explicitly instead of treating truncated history as complete. Native EVM internal transfers remain unsupported.
- Historical prices must carry timestamps within ten minutes of the receipt time; Kraken's open last candle is excluded. Missing/old prices stay unvalued. This does **not** create archive coverage where the source has none.
- Persisted USD valuation is authoritative for both observations and contributions. Retries cannot overwrite the public amount with a fresh quote. Changed amounts require review.
- The retry queue includes `needs_review` and `reorged`, rotates by last checked time, and invocation claims serialize overlapping runs.
- Redeploy configuration preserves the scanner's existing single-use token authentication. Provider health checks include latest/finalized blocks and the receipt method. Cron HTTP timeout is extended for multi-batch scans.
- Payment options refresh in open updated pages; failures hide cached addresses, stale requests cannot restore disabled payments, and copying an address refreshes the server gate first.
- CI runs the same six local test suites, including an isolated PGlite PostgreSQL reproduction of the old valuation mismatch before testing the repair.

## Deployment and recovery

Apply only the new forward migration `20261031030643_crypto_scan_integrity.sql`. Do not reset the database or replay old migrations: historical Supabase migration versions differ from filenames in Git. The migration replaces three functions and does not reset tables, receiving addresses, approvals, flags, or cron frequency.

Deploy `scan-crypto-contributions` with `index.ts`, `deno.json`, and the two shared modules from `scripts/`, preserving the `ethers` import mapping. Local compatibility modules reference these shared modules. Check deployed file contents against the reviewed tree.

For a rollback, restore the previous function definitions and the prior Edge artifact; do not run `crypto_infrastructure_rollback.sql`, which deletes data. Keep payments disabled during recovery. The prior code does not provide reliable historical coverage.

## Conditions before reopening payments

1. Every enabled network has working, independently operated verification providers from the actual Edge runtime, not just a successful network-ID response.
2. All EVM checkpoints have caught up from the historical starting boundary. Inspect `details.assets[].coverage.remaining_blocks`; `partial` is not launch readiness. The existing 15-minute schedule and public RPC throughput may be insufficient, particularly for BSC. Use an adequately provisioned history source or measured catch-up plan rather than jumping the cursor forward.
3. Independently reconcile historical address activity. A zero database count is not proof of zero on-chain receipts.
4. Old receipts need two timestamped historical price sources. Kraken's recent OHLC window alone cannot value older receipts. Leave them unvalued until suitable evidence is available.
5. Confirm wallet control and the supporting launch-review evidence; stored approval flags are not substitutes for documents or ownership verification.
6. Complete a separately authorized real incoming-transfer test and attribution/consent flow for each offered network. No outgoing financial operation is part of this repair.

## Verification limits

`npm test` runs synthetic network fixtures, frontend DOM checks, and a local WASM PostgreSQL instance. PGlite tests use minimal parent-table fixtures and exclude pg_cron/pg_net execution. These tests do not prove production provider availability, full historical coverage, wallet ownership, legal suitability, or real receipt-to-ranking completion.
