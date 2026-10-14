import assert from 'node:assert/strict';
import {runCryptoScan} from '../scripts/crypto-scan-engine.mjs';

const calls=[];
const rpc=async(name,args)=>{calls.push({name,args});return true;};

const disabled=await runCryptoScan({
  authorized:true,run_id:'00000000-0000-4000-8000-000000000001',mode:'scheduled',
  scanner_enabled:false,payments_enabled:false,assets:[]
},{rpc});
assert.equal(disabled.status,'skipped');
assert.equal(calls.at(-1).name,'finish_karma_crypto_scan_run');
assert.equal(calls.at(-1).args.p_status,'skipped');

calls.length=0;
const closedQa=await runCryptoScan({
  authorized:true,run_id:'00000000-0000-4000-8000-000000000003',mode:'manual',
  scanner_enabled:false,payments_enabled:false,
  assets:[{asset_id:'btc-bitcoin',enabled:false,recipient_address:null,providers:[]}]
},{rpc});
assert.equal(closedQa.status,'succeeded');
assert.equal(calls.at(-1).args.p_status,'succeeded');

calls.length=0;
const empty=await runCryptoScan({
  authorized:true,run_id:'00000000-0000-4000-8000-000000000002',mode:'scheduled',
  scanner_enabled:true,payments_enabled:false,
  assets:[{asset_id:'btc-bitcoin',enabled:false,recipient_address:null,providers:[]}]
},{rpc});
assert.equal(empty.status,'succeeded');
assert.equal(empty.details.assets[0].reason,'asset_disabled');
assert.equal(calls.at(-1).args.p_status,'succeeded');

await assert.rejects(
  runCryptoScan({authorized:false,run_id:null,assets:[]},{rpc}),
  /Invalid scan claim/
);

calls.length=0;
const healthFailure=await runCryptoScan({
  authorized:true,run_id:'00000000-0000-4000-8000-000000000004',mode:'health_check',
  scanner_enabled:false,payments_enabled:false,
  assets:[{asset_id:'btc-bitcoin',enabled:true,recipient_address:'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',providers:[]}]
},{rpc});
assert.equal(healthFailure.status,'failed');
assert.equal(calls.some(call=>call.name==='save_karma_crypto_checkpoint'),false);

console.log('PASS: scheduler disabled-by-default guard, inactive asset handling, completion accounting, and invalid-claim rejection.');
