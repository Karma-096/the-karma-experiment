import assert from 'node:assert/strict';
import {discoverBatch, valueWithTwoProviders, ASSETS} from '../scripts/crypto-core.mjs';
import {runCryptoScan} from '../scripts/crypto-scan-engine.mjs';
const recipient='0x'+'1'.repeat(40), hash='0x'+'a'.repeat(64);
const blockHash=n=>'0x'+n.toString(16).padStart(64,'0');
const hex=n=>'0x'+n.toString(16);
const provider={operator:'A',url:'https://a.invalid'};
let tip=1000, incoming=null, failHeight=null, pending=false;
const read=[];
const fetcher=async(url,options)=>{
 const q=JSON.parse(options.body);let result;
 if(q.method==='eth_chainId')result='0x1';
 else if(q.method==='eth_getBlockByNumber'){
   const n=['finalized','latest'].includes(q.params[0])?tip:Number(BigInt(q.params[0]));
   if(n===failHeight)throw new Error('synthetic transport failure');
   result={number:hex(n),hash:blockHash(n),timestamp:hex(1700000000+n*12)};
   if(q.params[1]){read.push(n);result.transactions=n===incoming?[{hash,to:recipient,from:'0x'+'2'.repeat(40),value:'0x1'}]:[];}
 }else if(q.method==='eth_getTransactionByHash')result={hash,to:recipient,from:'0x'+'2'.repeat(40),value:'0x1',blockHash:blockHash(incoming),chainId:'0x1'};
 else if(q.method==='eth_getTransactionReceipt')result=pending?null:{transactionHash:hash,status:'0x1',blockNumber:hex(incoming),blockHash:blockHash(incoming),logs:[]};
 else throw new Error('Unexpected method '+q.method);
 return Response.json({id:q.id,jsonrpc:'2.0',result});
};
const options={provider,recipient,fetcher,retry:{attempts:1}};
await assert.rejects(discoverBatch('eth-ethereum',options),/Explicit historical scan start/);
let b=await discoverBatch('eth-ethereum',{...options,fromBlock:976});
assert.equal(b.toBlock,1000);assert.equal(b.hashes.length,0);
tip=1075;incoming=1030;
b=await discoverBatch('eth-ethereum',{...options,fromBlock:b.toBlock+1,previousHash:b.blockHash});
assert.deepEqual(b.hashes,[hash]);assert.equal(b.toBlock,1075);
// Large gaps make bounded forward progress instead of failing permanently.
tip=1500;incoming=null;
b=await discoverBatch('eth-ethereum',{...options,fromBlock:1001});
assert.equal(b.toBlock,1120);assert.equal(b.lag,380);assert.equal(b.complete,false);
let cursor=1001;const covered=[];
while(cursor<=tip){const chunk=await discoverBatch('eth-ethereum',{...options,fromBlock:cursor,maxBlocks:17});covered.push(...Array.from({length:chunk.toBlock-cursor+1},(_,i)=>cursor+i));cursor=chunk.toBlock+1;}
assert.equal(new Set(covered).size,500);assert.equal(covered[0],1001);assert.equal(covered.at(-1),1500);
await assert.rejects(discoverBatch('eth-ethereum',{...options,fromBlock:1001,previousHash:blockHash(999)}),/Checkpoint block changed/);
b=await discoverBatch('eth-ethereum',{...options,fromBlock:1501,previousHash:blockHash(1500)});assert.equal(b.toBlock,null);assert.equal(b.complete,true);
b=await discoverBatch('eth-ethereum',{...options,fromTime:new Date((1700000000+1001*12)*1000).toISOString()});assert.equal(b.fromBlock,1001);
const calls=[];const rpc=async(name,args)=>{calls.push({name,args});return true;};
const asset={asset_id:'eth-ethereum',enabled:true,recipient_address:recipient,checkpoint:{last_finalized_height:1000,last_scanned_height:1000,last_scanned_hash:blockHash(1000)},providers:[{...provider,purpose:'discovery'},{...provider,purpose:'verification'},{operator:'B',url:'https://b.invalid',purpose:'verification'}]};
const claim={authorized:true,run_id:'synthetic',mode:'scheduled',scanner_enabled:true,payments_enabled:false,assets:[asset]};
let r=await runCryptoScan(claim,{rpc,fetcher,retry:{attempts:1},maxBatches:1});
assert.equal(r.status,'partial');assert.equal(calls.find(c=>c.name==='save_karma_crypto_checkpoint').args.p_last_finalized_height,1120);
calls.length=0;failHeight=1050;
r=await runCryptoScan(claim,{rpc,fetcher,retry:{attempts:1},maxBatches:1});assert.equal(r.status,'failed');
assert.equal(calls.filter(c=>c.name==='save_karma_crypto_checkpoint'&&c.args.p_success).length,0);
failHeight=null;incoming=1030;pending=true;calls.length=0;
r=await runCryptoScan(claim,{rpc,fetcher,retry:{attempts:1},maxBatches:1});assert.equal(r.status,'failed');
assert.equal(calls.filter(c=>c.name==='save_karma_crypto_checkpoint'&&c.args.p_success).length,0);
pending=false;
// Multiple chunks complete a gap and preserve each successful boundary.
incoming=null;calls.length=0;
r=await runCryptoScan(claim,{rpc,fetcher,retry:{attempts:1},maxBatches:8});
assert.equal(r.status,'succeeded');assert.equal(r.details.assets[0].batches,5);
assert.deepEqual(calls.filter(c=>c.name==='save_karma_crypto_checkpoint').map(c=>c.args.p_last_finalized_height),[1120,1240,1360,1480,1500]);
calls.length=0;failHeight=1200;
r=await runCryptoScan(claim,{rpc,fetcher,retry:{attempts:1},maxBatches:8});
assert.equal(r.status,'failed');assert.deepEqual(calls.filter(c=>c.name==='save_karma_crypto_checkpoint'&&c.args.p_success).map(c=>c.args.p_last_finalized_height),[1120]);
failHeight=null;
// BTC pagination must find a deposit beyond the first 25 confirmed transactions.
const btc='bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';let pages=0;
const btcFetcher=async url=>{pages++;return Response.json(url.includes('/chain/')?[{txid:'f'.repeat(64),status:{confirmed:true},vout:[{scriptpubkey_address:btc}]}]:Array.from({length:25},(_,i)=>({txid:(i+1).toString(16).padStart(64,'0'),status:{confirmed:true},vout:[]})));};
b=await discoverBatch('btc-bitcoin',{provider,recipient:btc,fetcher:btcFetcher});assert.deepEqual(b.hashes,['f'.repeat(64)]);assert.equal(pages,2);
await assert.rejects(discoverBatch('btc-bitcoin',{provider,recipient:btc,fetcher:btcFetcher,maxPages:1}),/page budget/);
let tronPages=0;const tron=ASSETS['usdt-tron'].contract;
b=await discoverBatch('usdt-tron',{provider,recipient:tron,fetcher:async url=>{tronPages++;return Response.json(url.includes('fingerprint=')?{data:[{transaction_id:'e'.repeat(64),to:tron,from:'other',token_info:{address:tron}}],meta:{}}:{data:[],meta:{fingerprint:'next/encoded+'}});}});
assert.equal(tronPages,2);assert.deepEqual(b.hashes,['e'.repeat(64)]);
const at='2026-10-30T00:00:00.000Z',ts=Date.parse(at)/1000;
const prices=[{operator:'A',kind:'coingecko',url:'https://coingecko.invalid'},{operator:'B',kind:'cryptocompare',url:'https://cc.invalid'}];
const quotes=offset=>async url=>Response.json(url.includes('coingecko')?{prices:[[(ts+offset)*1000,2000]]}:{Data:{Data:[{time:ts+offset,close:2000}]}});
await assert.rejects(valueWithTwoProviders('eth-ethereum','1000000000000000000',at,{providers:prices,fetcher:quotes(-7*86400)}),/timestamp outside/);
await assert.rejects(valueWithTwoProviders('eth-ethereum','1000000000000000000',at,{providers:prices,fetcher:quotes(601)}),/timestamp outside/);
assert.equal((await valueWithTwoProviders('eth-ethereum','1000000000000000000',at,{providers:prices,fetcher:quotes(60)})).amount_usd,'2000.00');
const kraken=[prices[0],{operator:'Kraken',kind:'kraken',url:'https://kraken.invalid'}];
await assert.rejects(valueWithTwoProviders('eth-ethereum','1000000000000000000',at,{providers:kraken,fetcher:async url=>Response.json(url.includes('coingecko')?{prices:[[ts*1000,2000]]}:{error:[],result:{XETHZUSD:[[ts,1,1,1,2000]],last:ts}})}),/Price unavailable/);
console.log('PASS: gap recovery, bounded contiguous coverage, explicit bootstrap, reorg checkpoint, failed/pending batch retention, BTC/TRON pagination, stale/future quotes, open Kraken candle.');
