// Local WASM PostgreSQL; no connection or credentials for production.
// pg_cron/pg_net are excluded, and only the unrelated parent tables are fixtures.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';
CREATE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS 'SELECT sha256(convert_to($1,''UTF8''))';
CREATE TABLE public.karma_participants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),nickname text NOT NULL,country_code text NOT NULL,show_in_ranking boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now());
CREATE TABLE public.karma_contributions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),participant_id uuid REFERENCES karma_participants(id),country_code text NOT NULL,amount numeric NOT NULL,currency text NOT NULL,transaction_hash text NOT NULL,network text NOT NULL,verified boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now(),amount_usd numeric,valuation_source text,valued_at timestamptz,is_test boolean NOT NULL DEFAULT false,UNIQUE(network,transaction_hash));
ALTER TABLE public.karma_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.karma_contributions ENABLE ROW LEVEL SECURITY;
`);
let infrastructure=readFileSync('supabase/migrations/20261014043027_crypto_infrastructure.sql','utf8');
infrastructure=infrastructure.replace(/^CREATE EXTENSION IF NOT EXISTS pg_(cron|net);$/gm,'');
infrastructure=infrastructure.slice(0,infrastructure.lastIndexOf('DO $$'));
await db.exec(infrastructure);
for(const name of ['20261014045120_crypto_explicit_deny_policies.sql','20261014045600_crypto_checkpoint_error.sql','20261014102028_public_crypto_payment_options.sql','20261014111909_crypto_launch_compliance_controls.sql'])await db.exec(readFileSync('supabase/migrations/'+name,'utf8'));
await db.exec(`UPDATE karma_internal.crypto_assets SET enabled=true,recipient_address='bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' WHERE asset_id='btc-bitcoin';`);
const run=(await db.query("INSERT INTO karma_internal.crypto_scan_runs(mode) VALUES('manual') RETURNING id")).rows[0].id;
await db.exec("UPDATE karma_internal.crypto_settings SET scanner_enabled=true,payments_enabled=true,legal_review_status='approved',wallet_addresses_verified_at=now(),public_launch_approved_at=now();");
const payload={asset_id:'btc-bitcoin',transaction_hash:'a'.repeat(64),amount_atomic:'100000',amount_decimal:'0.001',decimals:8,block_height:900000,block_hash:'b'.repeat(64),confirmations:6,observed_at:'2026-10-14T00:00:00Z',status:'confirmed',provider_evidence:[{operator:'A'},{operator:'B'}],valuation_status:'valued',price_usd:'65000.00',amount_usd:'65.00',valuation_sources:[{operator:'A'},{operator:'B'}],valued_at:'2026-10-14T00:00:00Z'};
const record=p=>db.query('select public.record_karma_crypto_observation($1,$2::jsonb)',[run,JSON.stringify(p)]);
await record(payload);await record({...payload,price_usd:'70000',amount_usd:'70'});
const values=async()=> (await db.query('select o.amount_usd::text observed,c.amount_usd::text published from karma_internal.crypto_observations o join public.karma_contributions c on c.id=o.contribution_id')).rows[0];
assert.deepEqual(await values(),{observed:'65.00',published:'70'}); // Prove the old bug first.
await db.exec(readFileSync('supabase/migrations/20261031030643_crypto_scan_integrity.sql','utf8'));
await record({...payload,price_usd:'80000',amount_usd:'80'});
assert.deepEqual(await values(),{observed:'65.00',published:'65.00'});
await record({...payload,valuation_status:'unavailable',price_usd:null,amount_usd:null,valuation_sources:[],valued_at:null});
assert.deepEqual(await values(),{observed:'65.00',published:'65.00'});
await assert.rejects(record({...payload,amount_atomic:'200000',amount_decimal:'0.002'}),/Valued transaction amount changed/);
await record({...payload,status:'needs_review'});
assert.equal((await db.query('select verified from public.karma_contributions')).rows[0].verified,false);
await record(payload);assert.equal((await db.query('select verified from public.karma_contributions')).rows[0].verified,true);
await db.exec("UPDATE karma_internal.crypto_scan_runs SET status='succeeded';");
const token='00000000-0000-4000-8000-000000000001',token2='00000000-0000-4000-8000-000000000002';
for(const t of [token,token2])await db.query("insert into karma_internal.crypto_scan_invocations(token_hash,mode,expires_at) values(encode(extensions.digest($1,'sha256'),'hex'),'manual',now()+interval '5 minutes')",[t]);
const claim=(await db.query('select public.claim_karma_crypto_scan_invocation($1) as c',[token])).rows[0].c;
assert.equal(claim.authorized,true);assert.ok(claim.assets[0].scan_start_at);
assert.equal((await db.query('select public.claim_karma_crypto_scan_invocation($1) as c',[token2])).rows[0].c.reason,'scan_already_running');
assert.equal((await db.query("select has_function_privilege('anon','public.record_karma_crypto_observation(uuid,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
// Existing database contract is run against a fresh transaction baseline.
await db.exec("DELETE FROM public.karma_contributions; DELETE FROM karma_internal.crypto_observations; DELETE FROM karma_internal.crypto_scan_runs; UPDATE karma_internal.crypto_settings SET payments_enabled=false,scanner_enabled=false;");
await db.exec(readFileSync('tests/crypto_database_contract.sql','utf8'));
await db.close();
console.log('PASS: reproduced original valuation drift; repaired immutable USD publication, recovery, changed-amount rejection, claim serialization, retained private privileges, existing SQL contract.');
