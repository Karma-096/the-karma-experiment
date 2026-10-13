import {createHash} from 'node:crypto';
import {getAddress, id} from 'ethers';

export const ASSETS = Object.freeze({
  'usdt-tron': {asset:'USDT',network:'tron',decimals:6,contract:'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',genesis:'00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc',confirmations:20,kind:'tron-token'},
  'btc-bitcoin': {asset:'BTC',network:'bitcoin',decimals:8,confirmations:6,kind:'bitcoin'},
  'eth-ethereum': {asset:'ETH',network:'ethereum',chainId:1,decimals:18,confirmations:12,kind:'native'},
  'usdc-base': {asset:'USDC',network:'base',chainId:8453,decimals:6,contract:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',confirmations:20,kind:'evm-token'},
  'bnb-bsc': {asset:'BNB',network:'bsc',chainId:56,decimals:18,confirmations:15,kind:'native'}
});
const TRANSFER=id('Transfer(address,address,uint256)').toLowerCase();
const HEX32=/^0x[0-9a-fA-F]{64}$/;
const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha=data=>createHash('sha256').update(data).digest();
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
export function validateRecipient(assetId, recipient){
 const a=ASSETS[assetId];if(!a)throw new Error('Unsupported asset');
 if(a.kind==='tron-token')return tronHex(recipient);
 if(a.kind==='bitcoin') return bitcoinAddress(recipient);
 return getAddress(recipient).toLowerCase();
}
const integerHex=value=>{if(typeof value!=='string'||!/^0x[0-9a-f]+$/i.test(value))throw new Error('Invalid RPC integer');return BigInt(value);};
const topicAddress=value=>{if(!HEX32.test(value)||!/^0x0{24}/i.test(value))throw new Error('Invalid address topic');return '0x'+value.slice(-40).toLowerCase();};
async function transport(endpoint,path,body,fetcher){
 const url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Configured HTTPS provider required');
 const r=await fetcher(endpoint.replace(/\/$/,'')+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw new Error('Provider unavailable');
 return path.includes('block-height')||path.includes('tip/height')?await r.text():await r.json();
}
function rpc(endpoint,fetcher){let counter=0;return async(method,params=[])=>{
 // This list cannot sign, send, approve, withdraw, or broadcast a transaction.
 if(!['eth_chainId','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber'].includes(method))throw new Error('Read-only RPC method required');
 const response=await transport(endpoint,'',{jsonrpc:'2.0',id:++counter,method,params},fetcher);
 if(response.error||!('result'in response))throw new Error('RPC provider error');return response.result;
};}
export async function verifyOnProvider(assetId,hash,{endpoint,recipient,fetcher=fetch,tronGenesis=ASSETS['usdt-tron'].genesis}){
 const a=ASSETS[assetId];const target=validateRecipient(assetId,recipient);
 if(!a)throw new Error('Unsupported asset');
 if(a.kind==='bitcoin'){
  if(!/^[0-9a-f]{64}$/i.test(hash))throw new Error('Invalid transaction hash');
  const genesis=await transport(endpoint,'/block-height/0',null,fetcher);
  if(genesis.trim()!=='000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f')throw new Error('Wrong Bitcoin network');
  const tx=await transport(endpoint,'/tx/'+hash,null,fetcher);
  if(tx.txid!==hash.toLowerCase())throw new Error('Transaction mismatch');
  if(tx.vin?.some(input=>input.prevout?.scriptpubkey_address===recipient))throw new Error('Own-wallet input/change is not a contribution');
  const outputs=tx.vout?.filter(output=>output.scriptpubkey_address===recipient)||[];
  let amount=0n;for(const output of outputs){if(!Number.isSafeInteger(output.value)||output.value<=0)throw new Error('Invalid Bitcoin amount');amount+=BigInt(output.value);}
  if(!amount)throw new Error('No receiving output');
  if(tx.status?.confirmed!==true)return {confirmed:false,reason:'pending'};
  const height=tx.status.block_height;
  if(!Number.isSafeInteger(height)||height<0)throw new Error('Invalid block height');
  const canonical=await transport(endpoint,'/block-height/'+height,null,fetcher);
  if(canonical.trim()!==tx.status.block_hash)throw new Error('Noncanonical Bitcoin block');
  const tip=Number(await transport(endpoint,'/blocks/tip/height',null,fetcher));
  if(!Number.isSafeInteger(tip)||tip<height)throw new Error('Invalid chain tip');
  return evidence(a,hash,amount,height,canonical.trim(),tip-height+1,tip-height+1>=a.confirmations);
 }
 if(a.kind==='tron-token'){
  if(!/^[0-9a-f]{64}$/i.test(hash)||!tronGenesis)throw new Error('Transaction hash and verified mainnet genesis required');
  if(tronGenesis!==a.genesis)throw new Error('Wrong configured Tron mainnet genesis');
  const genesis=await transport(endpoint,'/walletsolidity/getblockbynum',{num:0},fetcher);
  if(genesis.blockID!==tronGenesis)throw new Error('Wrong Tron network');
  const tx=await transport(endpoint,'/walletsolidity/gettransactioninfobyid',{value:hash},fetcher);
  if(!tx.id)return {confirmed:false,reason:'pending'};
  if(tx.id.toLowerCase()!==hash.toLowerCase()||tx.receipt?.result!=='SUCCESS')throw new Error('Failed or mismatched Tron transaction');
  const contract=tronHex(a.contract).slice(2);
  let amount=0n;
  for(const log of tx.log||[]){
   if(log.address?.replace(/^41/,'').toLowerCase()!==contract)continue;
   if(log.topics?.length!==3||'0x'+log.topics[0].toLowerCase()!==TRANSFER)continue;
   if(topicAddress('0x'+log.topics[2]).slice(2)!==target.slice(2))continue;
   if(topicAddress('0x'+log.topics[1]).slice(2)===target.slice(2))continue;
   if(!/^[0-9a-f]{64}$/i.test(log.data))throw new Error('Malformed token transfer');
   amount+=BigInt('0x'+log.data);
  }
  if(!amount)throw new Error('No official USDT transfer to recipient');
  const head=await transport(endpoint,'/walletsolidity/getnowblock',{},fetcher);
  const block=await transport(endpoint,'/walletsolidity/getblockbynum',{num:tx.blockNumber},fetcher);
  const tip=head.block_header?.raw_data?.number;
  if(!Number.isSafeInteger(tx.blockNumber)||!Number.isSafeInteger(tip)||!block.blockID||tip<tx.blockNumber)throw new Error('Invalid solid block');
  return evidence(a,hash,amount,tx.blockNumber,block.blockID,tip-tx.blockNumber+1,tip-tx.blockNumber+1>=a.confirmations);
 }
 if(!HEX32.test(hash))throw new Error('Invalid transaction hash');
 const call=rpc(endpoint,fetcher);
 if(Number(integerHex(await call('eth_chainId')))!==a.chainId)throw new Error('Wrong chain ID');
 const tx=await call('eth_getTransactionByHash',[hash]);
 const receipt=await call('eth_getTransactionReceipt',[hash]);
 if(!tx||!receipt)return {confirmed:false,reason:'pending'};
 if(tx.hash?.toLowerCase()!==hash.toLowerCase()||receipt.transactionHash?.toLowerCase()!==hash.toLowerCase()||integerHex(receipt.status)!==1n)throw new Error('Failed or mismatched transaction');
 if(!HEX32.test(receipt.blockHash)||!HEX32.test(tx.blockHash))throw new Error('Invalid block hash');
 if(tx.chainId&&Number(integerHex(tx.chainId))!==a.chainId)throw new Error('Transaction chain mismatch');
 const height=integerHex(receipt.blockNumber);
 const canonical=await call('eth_getBlockByNumber',[receipt.blockNumber,false]);
 if(canonical?.hash?.toLowerCase()!==receipt.blockHash?.toLowerCase()||tx.blockHash?.toLowerCase()!==receipt.blockHash?.toLowerCase())throw new Error('Noncanonical transaction block');
 const latest=await call('eth_getBlockByNumber',['latest',false]);
 const finalized=await call('eth_getBlockByNumber',['finalized',false]);
 if(!finalized)throw new Error('Provider must support finalized blocks');
 const confirmations=integerHex(latest.number)-height+1n;
 let amount=0n;
 if(a.kind==='native'){
  if(tx.to?.toLowerCase()!==target||tx.from?.toLowerCase()===target)throw new Error('Wrong recipient or self transfer');
  amount=integerHex(tx.value);
 }else{
  const indexes=new Set();
  for(const log of receipt.logs||[]){
   if(log.address?.toLowerCase()!==a.contract.toLowerCase()||log.topics?.[0]?.toLowerCase()!==TRANSFER)continue;
   if(log.removed===true||log.transactionHash?.toLowerCase()!==hash.toLowerCase()||log.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase())throw new Error('Invalid token log block');
   if(log.topics.length!==3||topicAddress(log.topics[2])!==target)continue;
   if(topicAddress(log.topics[1])===target)continue;
   if(indexes.has(log.logIndex))throw new Error('Duplicate token log');
   indexes.add(log.logIndex);
   if(!HEX32.test(log.data))throw new Error('Malformed token amount');
   amount+=BigInt(log.data);
  }
 }
 if(amount<=0n)throw new Error('No supported incoming asset');
 return evidence(a,hash,amount,Number(height),receipt.blockHash,Number(confirmations),confirmations>=BigInt(a.confirmations)&&integerHex(finalized.number)>=height);
}
function evidence(a,hash,amount,height,blockHash,confirmations,confirmed){
 return {confirmed,reason:confirmed?'confirmed':'awaiting_confirmations_or_finality',asset:a.asset,network:a.network,transaction_hash:hash.toLowerCase(),amount_atomic:amount.toString(),decimals:a.decimals,block_height:height,block_hash:blockHash,confirmations};
}
export async function verifyWithTwoProviders(assetId,hash,{endpoints,recipient,fetcher=fetch,tronGenesis=ASSETS['usdt-tron'].genesis}){
 if(!Array.isArray(endpoints)||endpoints.length!==2||new URL(endpoints[0]).hostname===new URL(endpoints[1]).hostname)throw new Error('Two independently operated providers required');
 const results=await Promise.all(endpoints.map(endpoint=>verifyOnProvider(assetId,hash,{endpoint,recipient,fetcher,tronGenesis})));
 if(results.some(result=>!result.confirmed))return {confirmed:false,reason:'not_confirmed_by_both_providers'};
 const stable=result=>JSON.stringify([result.asset,result.network,result.transaction_hash,result.amount_atomic,result.block_height,result.block_hash.toLowerCase()]);
 if(stable(results[0])!==stable(results[1]))throw new Error('Independent provider evidence disagrees');
 // Observation proves arrival only. It does not prove participant identity or a USD valuation.
 return {...results[0],confirmations:Math.min(...results.map(r=>r.confirmations)),verified:false,publication_eligible:false,requires:['receipt-time USD valuation','voluntary participant attribution with sender proof','owner launch approval']};
}

