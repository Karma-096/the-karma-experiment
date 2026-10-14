import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {getAddress, id} from 'ethers';

export const ASSETS = Object.freeze({
  'usdt-tron': {asset:'USDT',network:'tron',decimals:6,contract:'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',genesis:'00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc',confirmations:20,kind:'tron-token'},
  'btc-bitcoin': {asset:'BTC',network:'bitcoin',decimals:8,confirmations:6,kind:'bitcoin'},
  'eth-ethereum': {asset:'ETH',network:'ethereum',chainId:1,decimals:18,confirmations:12,kind:'native'},
  'usdc-base': {asset:'USDC',network:'base',chainId:8453,decimals:6,contract:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',confirmations:20,kind:'evm-token'},
  'bnb-bsc': {asset:'BNB',network:'bsc',chainId:56,decimals:18,confirmations:15,kind:'native'}
});

export const DEFAULT_PRICE_PROVIDERS = Object.freeze([
  {operator:'DefiLlama',kind:'defillama',url:'https://coins.llama.fi'},
  {operator:'Kraken','kind':'kraken',url:'https://api.kraken.com/0'}
]);

const PRICE_IDS = Object.freeze({BTC:'bitcoin',ETH:'ethereum',USDT:'tether',USDC:'usd-coin',BNB:'binancecoin'});
const PAPRIKA_IDS = Object.freeze({BTC:'btc-bitcoin',ETH:'eth-ethereum',USDT:'usdt-tether',USDC:'usdc-usd-coin',BNB:'bnb-binance-coin'});
const KRAKEN_PAIRS = Object.freeze({BTC:'XBTUSD',ETH:'ETHUSD',USDT:'USDTUSD',USDC:'USDCUSD',BNB:'BNBUSD'});
const TRANSFER=id('Transfer(address,address,uint256)').toLowerCase();
const HEX32=/^0x[0-9a-fA-F]{64}$/;
const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha=data=>createHash('sha256').update(data).digest();
const safeError=error=>error instanceof Error ? error.message.replace(/https?:\/\/\S+/g,'provider').slice(0,180) : 'Unknown provider error';

export async function withRetry(operation,{attempts=3,baseDelayMs=150,sleeper=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  let last;
  for(let attempt=1;attempt<=attempts;attempt++){
    try{return await operation(attempt);}catch(error){last=error;if(attempt<attempts)await sleeper(baseDelayMs*2**(attempt-1));}
  }
  throw last;
}

export function providerDefinition(provider){
  if(!provider||typeof provider!=='object'||typeof provider.url!=='string'||typeof provider.operator!=='string'||!provider.operator.trim())throw new Error('Provider operator metadata required');
  const url=new URL(provider.url);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Configured HTTPS provider required');
  return {...provider,url:url.toString().replace(/\/$/,'')};
}

export function assertIndependentProviders(providers){
  if(!Array.isArray(providers)||providers.length!==2)throw new Error('Exactly two providers required');
  const normalized=providers.map(providerDefinition);
  if(normalized[0].operator.trim().toLowerCase()===normalized[1].operator.trim().toLowerCase())throw new Error('Independently operated providers required');
  if(new URL(normalized[0].url).hostname===new URL(normalized[1].url).hostname)throw new Error('Distinct provider hosts required');
  return normalized;
}

export function bitcoinAddress(address){
  const alphabet='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  if(address!==address.toLowerCase()||address.length>90||!address.startsWith('bc1'))throw new Error('Bitcoin mainnet address required');
  const values=Array.from(address.slice(3),c=>alphabet.indexOf(c));
  if(values.some(v=>v<0)||values.length<7)throw new Error('Invalid Bitcoin address');
  const hrp=Array.from('bc',c=>c.charCodeAt(0));
  const expanded=[...hrp.map(v=>v>>5),0,...hrp.map(v=>v&31),...values];
  const generators=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];
  let checksum=1;
  for(const value of expanded){const top=checksum>>>25;checksum=((checksum&0x1ffffff)<<5)^value;for(let i=0;i<5;i++)if((top>>>i)&1)checksum^=generators[i];}
  const version=values[0];if(version>16||checksum!==(version===0?1:0x2bc830a3))throw new Error('Invalid Bitcoin checksum');
  let accumulator=0,bits=0;const decoded=[];
  for(const value of values.slice(1,-6)){accumulator=(accumulator<<5)|value;bits+=5;while(bits>=8){bits-=8;decoded.push((accumulator>>>bits)&255);}}
  if(bits>=5||((accumulator<<(8-bits))&255)!==0||decoded.length<2||decoded.length>40||(version===0&&![20,32].includes(decoded.length)))throw new Error('Invalid Bitcoin witness program');
  return address;
}

export function tronHex(address){
  let n=0n;for(const c of address){const i=BASE58.indexOf(c);if(i<0)throw new Error('Invalid Tron address');n=n*58n+BigInt(i);}
  let h=n.toString(16);if(h.length%2)h='0'+h;const all=Buffer.from(h,'hex'),body=all.subarray(0,-4);
  if(all.length!==25||body[0]!==0x41||!sha(sha(body)).subarray(0,4).equals(all.subarray(-4)))throw new Error('Invalid Tron checksum');
  return body.toString('hex');
}

export function validateRecipient(assetId,recipient){
  const a=ASSETS[assetId];if(!a)throw new Error('Unsupported asset');
  if(a.kind==='tron-token')return tronHex(recipient);
  if(a.kind==='bitcoin')return bitcoinAddress(recipient);
  return getAddress(recipient).toLowerCase();
}

const integerHex=value=>{if(typeof value!=='string'||!/^0x[0-9a-f]+$/i.test(value))throw new Error('Invalid RPC integer');return BigInt(value);};
const topicAddress=value=>{if(!HEX32.test(value)||!/^0x0{24}/i.test(value))throw new Error('Invalid address topic');return '0x'+value.slice(-40).toLowerCase();};

async function transport(endpoint,path,body,fetcher,{attempts=3,sleeper}={}){
  const base=providerDefinition({url:endpoint,operator:'transport'}).url;
  return withRetry(async()=>{
    const response=await fetcher(base+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error('Provider unavailable');
    return path.includes('block-height')||path.includes('tip/height')?await response.text():await response.json();
  },{attempts,sleeper});
}

function rpc(endpoint,fetcher,retry){let counter=0;return async(method,params=[])=>{
  if(!['eth_chainId','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber','eth_getLogs','eth_getCode','eth_call'].includes(method))throw new Error('Read-only RPC method required');
  const response=await transport(endpoint,'',{jsonrpc:'2.0',id:++counter,method,params},fetcher,retry);
  if(response.error||!('result'in response))throw new Error('RPC provider error');return response.result;
};}

function evidence(a,hash,amount,height,blockHash,confirmations,confirmed,observedAt=null){
  return {confirmed,reason:confirmed?'confirmed':'awaiting_confirmations_or_finality',asset:a.asset,network:a.network,transaction_hash:hash.toLowerCase(),amount_atomic:amount.toString(),amount_decimal:atomicToDecimal(amount,a.decimals),decimals:a.decimals,block_height:height,block_hash:blockHash,confirmations,observed_at:observedAt};
}

export function atomicToDecimal(value,decimals){
  const amount=typeof value==='bigint'?value:BigInt(value);const negative=amount<0n;const raw=(negative?-amount:amount).toString().padStart(decimals+1,'0');
  const whole=raw.slice(0,-decimals)||'0';const fraction=decimals?raw.slice(-decimals).replace(/0+$/,''):'';
  return `${negative?'-':''}${whole}${fraction?'.'+fraction:''}`;
}

export async function verifyOnProvider(assetId,hash,{endpoint,recipient,fetcher=fetch,tronGenesis=ASSETS['usdt-tron'].genesis,retry={}}){
  const a=ASSETS[assetId];const target=validateRecipient(assetId,recipient);if(!a)throw new Error('Unsupported asset');
  if(a.kind==='bitcoin'){
    if(!/^[0-9a-f]{64}$/i.test(hash))throw new Error('Invalid transaction hash');
    const genesis=await transport(endpoint,'/block-height/0',null,fetcher,retry);
    if(genesis.trim()!=='000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f')throw new Error('Wrong Bitcoin network');
    const tx=await transport(endpoint,'/tx/'+hash,null,fetcher,retry);if(tx.txid!==hash.toLowerCase())throw new Error('Transaction mismatch');
    if(tx.vin?.some(input=>input.prevout?.scriptpubkey_address===recipient))throw new Error('Own-wallet input/change is not a contribution');
    const outputs=tx.vout?.filter(output=>output.scriptpubkey_address===recipient)||[];let amount=0n;
    for(const output of outputs){if(!Number.isSafeInteger(output.value)||output.value<=0)throw new Error('Invalid Bitcoin amount');amount+=BigInt(output.value);}
    if(!amount)throw new Error('No receiving output');if(tx.status?.confirmed!==true)return {confirmed:false,reason:'pending'};
    const height=tx.status.block_height;if(!Number.isSafeInteger(height)||height<0)throw new Error('Invalid block height');
    const canonical=await transport(endpoint,'/block-height/'+height,null,fetcher,retry);if(canonical.trim()!==tx.status.block_hash)throw new Error('Noncanonical Bitcoin block');
    const tip=Number(await transport(endpoint,'/blocks/tip/height',null,fetcher,retry));if(!Number.isSafeInteger(tip)||tip<height)throw new Error('Invalid chain tip');
    return evidence(a,hash,amount,height,canonical.trim(),tip-height+1,tip-height+1>=a.confirmations,tx.status.block_time?new Date(tx.status.block_time*1000).toISOString():null);
  }
  if(a.kind==='tron-token'){
    if(!/^[0-9a-f]{64}$/i.test(hash)||!tronGenesis)throw new Error('Transaction hash and verified mainnet genesis required');
    if(tronGenesis!==a.genesis)throw new Error('Wrong configured Tron mainnet genesis');
    const genesis=await transport(endpoint,'/walletsolidity/getblockbynum',{num:0},fetcher,retry);if(genesis.blockID!==tronGenesis)throw new Error('Wrong Tron network');
    const tx=await transport(endpoint,'/walletsolidity/gettransactioninfobyid',{value:hash},fetcher,retry);if(!tx.id)return {confirmed:false,reason:'pending'};
    if(tx.id.toLowerCase()!==hash.toLowerCase()||tx.receipt?.result!=='SUCCESS')throw new Error('Failed or mismatched Tron transaction');
    const contract=tronHex(a.contract).slice(2);let amount=0n;
    for(const log of tx.log||[]){if(log.address?.replace(/^41/,'').toLowerCase()!==contract)continue;if(log.topics?.length!==3||'0x'+log.topics[0].toLowerCase()!==TRANSFER)continue;if(topicAddress('0x'+log.topics[2]).slice(2)!==target.slice(2))continue;if(topicAddress('0x'+log.topics[1]).slice(2)===target.slice(2))continue;if(!/^[0-9a-f]{64}$/i.test(log.data))throw new Error('Malformed token transfer');amount+=BigInt('0x'+log.data);}
    if(!amount)throw new Error('No official USDT transfer to recipient');
    const head=await transport(endpoint,'/walletsolidity/getnowblock',{},fetcher,retry);const block=await transport(endpoint,'/walletsolidity/getblockbynum',{num:tx.blockNumber},fetcher,retry);const tip=head.block_header?.raw_data?.number;
    if(!Number.isSafeInteger(tx.blockNumber)||!Number.isSafeInteger(tip)||!block.blockID||tip<tx.blockNumber)throw new Error('Invalid solid block');
    return evidence(a,hash,amount,tx.blockNumber,block.blockID,tip-tx.blockNumber+1,tip-tx.blockNumber+1>=a.confirmations,tx.blockTimeStamp?new Date(tx.blockTimeStamp).toISOString():null);
  }
  if(!HEX32.test(hash))throw new Error('Invalid transaction hash');const call=rpc(endpoint,fetcher,retry);
  if(Number(integerHex(await call('eth_chainId')))!==a.chainId)throw new Error('Wrong chain ID');
  const tx=await call('eth_getTransactionByHash',[hash]);const receipt=await call('eth_getTransactionReceipt',[hash]);if(!tx||!receipt)return {confirmed:false,reason:'pending'};
  if(tx.hash?.toLowerCase()!==hash.toLowerCase()||receipt.transactionHash?.toLowerCase()!==hash.toLowerCase()||integerHex(receipt.status)!==1n)throw new Error('Failed or mismatched transaction');
  if(!HEX32.test(receipt.blockHash)||!HEX32.test(tx.blockHash))throw new Error('Invalid block hash');if(tx.chainId&&Number(integerHex(tx.chainId))!==a.chainId)throw new Error('Transaction chain mismatch');
  const height=integerHex(receipt.blockNumber);const canonical=await call('eth_getBlockByNumber',[receipt.blockNumber,false]);if(canonical?.hash?.toLowerCase()!==receipt.blockHash?.toLowerCase()||tx.blockHash?.toLowerCase()!==receipt.blockHash?.toLowerCase())throw new Error('Noncanonical transaction block');
  const latest=await call('eth_getBlockByNumber',['latest',false]);const finalized=await call('eth_getBlockByNumber',['finalized',false]);if(!finalized)throw new Error('Provider must support finalized blocks');
  const confirmations=integerHex(latest.number)-height+1n;let amount=0n;
  if(a.kind==='native'){if(tx.to?.toLowerCase()!==target||tx.from?.toLowerCase()===target)throw new Error('Wrong recipient or self transfer');amount=integerHex(tx.value);}else{
    const indexes=new Set();for(const log of receipt.logs||[]){if(log.address?.toLowerCase()!==a.contract.toLowerCase()||log.topics?.[0]?.toLowerCase()!==TRANSFER)continue;if(log.removed===true||log.transactionHash?.toLowerCase()!==hash.toLowerCase()||log.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase())throw new Error('Invalid token log block');if(log.topics.length!==3||topicAddress(log.topics[2])!==target)continue;if(topicAddress(log.topics[1])===target)continue;if(indexes.has(log.logIndex))throw new Error('Duplicate token log');indexes.add(log.logIndex);if(!HEX32.test(log.data))throw new Error('Malformed token amount');amount+=BigInt(log.data);}
  }
  if(amount<=0n)throw new Error('No supported incoming asset');
  return evidence(a,hash,amount,Number(height),receipt.blockHash,Number(confirmations),confirmations>=BigInt(a.confirmations)&&integerHex(finalized.number)>=height,canonical.timestamp?new Date(Number(integerHex(canonical.timestamp))*1000).toISOString():null);
}

export async function verifyWithTwoProviders(assetId,hash,{providers,recipient,fetcher=fetch,tronGenesis=ASSETS['usdt-tron'].genesis,retry={}}){
  const normalized=assertIndependentProviders(providers);
  const results=await Promise.all(normalized.map(provider=>verifyOnProvider(assetId,hash,{endpoint:provider.url,recipient,fetcher,tronGenesis,retry})));
  if(results.some(result=>!result.confirmed))return {confirmed:false,reason:'not_confirmed_by_both_providers'};
  const stable=result=>JSON.stringify([result.asset,result.network,result.transaction_hash,result.amount_atomic,result.block_height,result.block_hash.toLowerCase()]);
  if(stable(results[0])!==stable(results[1]))throw new Error('Independent provider evidence disagrees');
  return {...results[0],confirmations:Math.min(...results.map(r=>r.confirmations)),provider_evidence:normalized.map((provider,index)=>({operator:provider.operator,block_hash:results[index].block_hash,confirmations:results[index].confirmations})),verified:false,publication_eligible:false,requires:['receipt-time USD valuation','voluntary participant attribution with verified proof','owner launch approval']};
}

export async function discoverCandidates(assetId,{provider,recipient,fromBlock=null,toBlock=null,fetcher=fetch,retry={},maxBlocks=120}){
  const a=ASSETS[assetId];if(!a)throw new Error('Unsupported asset');const p=providerDefinition(provider);validateRecipient(assetId,recipient);
  if(a.kind==='bitcoin'){
    const txs=await transport(p.url,'/address/'+encodeURIComponent(recipient)+'/txs',null,fetcher,retry);if(!Array.isArray(txs))throw new Error('Invalid Bitcoin discovery response');
    return [...new Set(txs.filter(tx=>tx?.txid&&tx.vout?.some(output=>output.scriptpubkey_address===recipient)).map(tx=>tx.txid.toLowerCase()))];
  }
  if(a.kind==='tron-token'){
    const path=`/v1/accounts/${encodeURIComponent(recipient)}/transactions/trc20?only_confirmed=true&limit=100&contract_address=${encodeURIComponent(a.contract)}`;
    const result=await transport(p.url,path,null,fetcher,retry);if(!Array.isArray(result.data))throw new Error('Invalid Tron discovery response');
    return [...new Set(result.data.filter(tx=>tx?.to===recipient&&tx?.token_info?.address===a.contract&&tx.transaction_id).map(tx=>tx.transaction_id.toLowerCase()))];
  }
  const call=rpc(p.url,fetcher,retry);if(Number(integerHex(await call('eth_chainId')))!==a.chainId)throw new Error('Wrong chain ID');
  const finalized=await call('eth_getBlockByNumber',['finalized',false]);if(!finalized)throw new Error('Provider must support finalized blocks');
  const safeTo=toBlock===null?Number(integerHex(finalized.number)):Math.min(toBlock,Number(integerHex(finalized.number)));const start=fromBlock===null?Math.max(0,safeTo-24):fromBlock;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(safeTo)||safeTo<start||safeTo-start+1>maxBlocks)throw new Error('Unsafe EVM scan range');
  if(a.kind==='evm-token'){
    const target='0x'+'0'.repeat(24)+validateRecipient(assetId,recipient).slice(2);const logs=await call('eth_getLogs',[{address:a.contract,fromBlock:'0x'+start.toString(16),toBlock:'0x'+safeTo.toString(16),topics:[TRANSFER,null,target]}]);
    if(!Array.isArray(logs))throw new Error('Invalid token discovery response');return [...new Set(logs.filter(log=>!log.removed&&HEX32.test(log.transactionHash)).map(log=>log.transactionHash.toLowerCase()))];
  }
  const target=validateRecipient(assetId,recipient);const found=[];
  for(let height=start;height<=safeTo;height++){const block=await call('eth_getBlockByNumber',['0x'+height.toString(16),true]);if(!Array.isArray(block?.transactions))throw new Error('Invalid block transaction list');for(const tx of block.transactions)if(tx.to?.toLowerCase()===target&&tx.from?.toLowerCase()!==target&&integerHex(tx.value)>0n)found.push(tx.hash.toLowerCase());}
  return [...new Set(found)];
}

async function historicalPrice(provider,asset,at,fetcher,retry){
  const p=providerDefinition(provider);const timestamp=Math.floor(new Date(at).getTime()/1000);if(!Number.isSafeInteger(timestamp)||timestamp<=0)throw new Error('Invalid valuation time');
  if(p.kind==='coingecko'){
    const idValue=PRICE_IDS[asset];const data=await transport(p.url,`/coins/${idValue}/market_chart/range?vs_currency=usd&from=${timestamp-600}&to=${timestamp+600}`,null,fetcher,retry);const rows=data.prices;
    if(!Array.isArray(rows)||!rows.length)throw new Error('Price unavailable');const closest=rows.reduce((best,row)=>Math.abs(row[0]/1000-timestamp)<Math.abs(best[0]/1000-timestamp)?row:best);return {operator:p.operator,price:Number(closest[1]),timestamp:new Date(closest[0]).toISOString()};
  }
  if(p.kind==='cryptocompare'){
    const data=await transport(p.url,`/histominute?fsym=${asset}&tsym=USD&limit=2&toTs=${timestamp}`,null,fetcher,retry);const rows=data?.Data?.Data;if(!Array.isArray(rows)||!rows.length)throw new Error('Price unavailable');const row=rows.reduce((best,item)=>Math.abs(item.time-timestamp)<Math.abs(best.time-timestamp)?item:best);return {operator:p.operator,price:Number(row.close),timestamp:new Date(row.time*1000).toISOString()};
  }
  if(p.kind==='defillama'){
    const key=`coingecko:${PRICE_IDS[asset]}`;const data=await transport(p.url,`/prices/historical/${timestamp}/${encodeURIComponent(key)}`,null,fetcher,retry);const row=data?.coins?.[key];
    if(!row||!Number.isFinite(Number(row.price))||Number(row.price)<=0)throw new Error('Price unavailable');return {operator:p.operator,price:Number(row.price),timestamp:new Date(Number(row.timestamp||timestamp)*1000).toISOString()};
  }
  if(p.kind==='coinpaprika'){
    const start=timestamp-600,end=timestamp+600;const rows=await transport(p.url,`/tickers/${PAPRIKA_IDS[asset]}/historical?start=${start}&end=${end}&interval=5m&quote=usd`,null,fetcher,retry);
    if(!Array.isArray(rows)||!rows.length)throw new Error('Price unavailable');const row=rows.reduce((best,item)=>Math.abs(Date.parse(item.timestamp)/1000-timestamp)<Math.abs(Date.parse(best.timestamp)/1000-timestamp)?item:best);
    if(!Number.isFinite(Number(row.price))||Number(row.price)<=0)throw new Error('Price unavailable');return {operator:p.operator,price:Number(row.price),timestamp:new Date(row.timestamp).toISOString()};
  }
  if(p.kind==='pyth'){
    const feeds=await transport(p.url,`/v2/price_feeds?query=${encodeURIComponent(asset+'/USD')}&asset_type=crypto`,null,fetcher,retry);
    if(!Array.isArray(feeds)||!feeds.length)throw new Error('Price feed unavailable');
    const wanted=`${asset}/USD`;const feed=feeds.find(item=>String(item?.attributes?.symbol||'').toUpperCase().endsWith(wanted))||feeds[0];const feedId=String(feed?.id||'').replace(/^0x/,'');
    if(!/^[0-9a-f]{64}$/i.test(feedId))throw new Error('Invalid price feed');
    const data=await transport(p.url,`/v1/updates/price/${timestamp}?ids%5B%5D=${feedId}&parsed=true`,null,fetcher,retry);const row=data?.parsed?.[0]?.price;
    const raw=Number(row?.price),expo=Number(row?.expo),published=Number(row?.publish_time);
    const price=raw*10**expo;if(!Number.isFinite(price)||price<=0||!Number.isSafeInteger(published))throw new Error('Price unavailable');
    return {operator:p.operator,price,timestamp:new Date(published*1000).toISOString()};
  }
  if(p.kind==='kraken'){
    const pair=KRAKEN_PAIRS[asset];const data=await transport(p.url,`/public/OHLC?pair=${pair}&interval=1&since=${timestamp-120}`,null,fetcher,retry);
    if(!data||!Array.isArray(data.error)||data.error.length)throw new Error('Price unavailable');const key=Object.keys(data.result||{}).find(item=>item!=='last');const rows=key?data.result[key]:null;
    if(!Array.isArray(rows)||!rows.length)throw new Error('Price unavailable');const row=rows.reduce((best,item)=>Math.abs(Number(item[0])-timestamp)<Math.abs(Number(best[0])-timestamp)?item:best);const price=Number(row[4]),published=Number(row[0]);
    if(!Number.isFinite(price)||price<=0||!Number.isSafeInteger(published))throw new Error('Price unavailable');return {operator:p.operator,price,timestamp:new Date(published*1000).toISOString()};
  }
  throw new Error('Unsupported price provider');
}

export async function probeHistoricalPrice(provider,asset,at,{fetcher=fetch,retry={}}={}){
  return historicalPrice(provider,asset,at,fetcher,retry);
}

function scaledDecimal(number,scale=12){if(!Number.isFinite(number)||number<=0)throw new Error('Invalid price');return BigInt(number.toFixed(scale).replace('.',''));}
function formatScaled(value,scale){const raw=value.toString().padStart(scale+1,'0');return raw.slice(0,-scale)+'.'+raw.slice(-scale).replace(/0+$/,'').padEnd(2,'0');}

export async function valueWithTwoProviders(assetId,amountAtomic,observedAt,{providers=DEFAULT_PRICE_PROVIDERS,fetcher=fetch,retry={},maxDeviation=0.05}={}){
  const a=ASSETS[assetId];if(!a)throw new Error('Unsupported asset');const normalized=assertIndependentProviders(providers);const amount=BigInt(amountAtomic);if(amount<=0n)throw new Error('Invalid amount');
  const prices=await Promise.all(normalized.map(provider=>historicalPrice(provider,a.asset,observedAt,fetcher,retry)));
  if(prices.some(item=>!Number.isFinite(item.price)||item.price<=0))throw new Error('Price unavailable');const low=Math.min(...prices.map(x=>x.price)),high=Math.max(...prices.map(x=>x.price));if((high-low)/low>maxDeviation)throw new Error('Independent price evidence disagrees');
  const price=(prices[0].price+prices[1].price)/2;const priceScaled=scaledDecimal(price,12);const usdScaled=amount*priceScaled*100000000n/(10n**BigInt(a.decimals)*1000000000000n);
  return {status:'valued',asset:a.asset,amount_atomic:amount.toString(),amount_decimal:atomicToDecimal(amount,a.decimals),price_usd:formatScaled(priceScaled,12),amount_usd:formatScaled(usdScaled,8),valued_at:new Date(observedAt).toISOString(),sources:prices.map(item=>({operator:item.operator,price_usd:String(item.price),timestamp:item.timestamp}))};
}

export function classifyReorg(previous,current){
  if(!previous?.confirmed)return 'new';if(!current?.confirmed)return 'reorged';
  return previous.block_height===current.block_height&&String(previous.block_hash).toLowerCase()===String(current.block_hash).toLowerCase()?'unchanged':'reorged';
}

export async function healthCheckAsset(assetId,{providers,recipient,fetcher=fetch,retry={}}){
  const a=ASSETS[assetId];if(!a)throw new Error('Unsupported asset');const normalized=assertIndependentProviders(providers);validateRecipient(assetId,recipient);const checks=[];
  for(const provider of normalized){
    try{
      if(a.kind==='bitcoin'){const genesis=await transport(provider.url,'/block-height/0',null,fetcher,retry);if(genesis.trim()!=='000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f')throw new Error('Wrong Bitcoin network');}
      else if(a.kind==='tron-token'){const genesis=await transport(provider.url,'/walletsolidity/getblockbynum',{num:0},fetcher,retry);if(genesis.blockID!==a.genesis)throw new Error('Wrong Tron network');}
      else {const call=rpc(provider.url,fetcher,retry);if(Number(integerHex(await call('eth_chainId')))!==a.chainId)throw new Error('Wrong chain ID');if(a.kind==='evm-token'){const code=await call('eth_getCode',[a.contract,'latest']);if(typeof code!=='string'||code==='0x')throw new Error('Token contract missing');}}
      checks.push({operator:provider.operator,ok:true});
    }catch(error){checks.push({operator:provider.operator,ok:false,error:safeError(error)});}
  }
  return {asset_id:assetId,ok:checks.every(check=>check.ok),checks};
}
