import {
  DEFAULT_PRICE_PROVIDERS,
  discoverBatch,
  healthCheckAsset,
  probeHistoricalPrice,
  valueWithTwoProviders,
  verifyWithTwoProviders
} from './crypto-core.mjs';

const safeError = error => (error instanceof Error ? error.message : 'Unknown error')
  .replace(/https?:\/\/\S+/g, 'provider')
  .replace(/\b(?:0x)?[0-9a-f]{64}\b/gi, '[transaction]')
  .slice(0, 300);

const providerFor = (asset, purpose) => (asset.providers || [])
  .filter(item => item.purpose === purpose)
  .map(item => ({operator:item.operator, kind:item.kind, url:item.url, ...item.configuration}));

const priorPayload = (asset, previous, status, reason) => ({
  asset_id: asset.asset_id,
  transaction_hash: previous.transaction_hash,
  amount_atomic: previous.amount_atomic,
  amount_decimal: previous.amount_decimal,
  decimals: previous.decimals,
  block_height: previous.block_height,
  block_hash: previous.block_hash,
  confirmations: previous.confirmations || 0,
  observed_at: previous.observed_at,
  status,
  provider_evidence: [],
  valuation_status: previous.valuation_status || 'pending',
  price_usd: previous.price_usd,
  amount_usd: previous.amount_usd,
  valuation_sources: previous.valuation_sources || [],
  valued_at: previous.valued_at,
  revocation_reason: reason
});

function confirmedPayload(asset, evidence, valuation) {
  return {
    asset_id: asset.asset_id,
    transaction_hash: evidence.transaction_hash,
    amount_atomic: evidence.amount_atomic,
    amount_decimal: evidence.amount_decimal,
    decimals: evidence.decimals,
    block_height: evidence.block_height,
    block_hash: evidence.block_hash,
    confirmations: evidence.confirmations,
    observed_at: evidence.observed_at,
    status: 'confirmed',
    provider_evidence: evidence.provider_evidence,
    valuation_status: valuation?.status || 'unavailable',
    price_usd: valuation?.price_usd,
    amount_usd: valuation?.amount_usd,
    valuation_sources: valuation?.sources || [],
    valued_at: valuation?.valued_at
  };
}

export async function runCryptoScan(claim, {rpc, fetcher=fetch, priceProviders=DEFAULT_PRICE_PROVIDERS, retry={attempts:3,baseDelayMs:250},maxBatches=24,assetBudgetMs=30000}) {
  if (!claim?.authorized || !claim.run_id || !Array.isArray(claim.assets)) throw new Error('Invalid scan claim');
  if(!Number.isInteger(maxBatches)||maxBatches<1||maxBatches>32||!Number.isFinite(assetBudgetMs)||assetBudgetMs<1||assetBudgetMs>60000)throw new Error('Invalid scan budget');
  const totals = {discovered:0, verified:0, valued:0};
  const details = {mode:claim.mode, payments_enabled:Boolean(claim.payments_enabled), assets:[]};

  if (claim.mode === 'scheduled' && !claim.scanner_enabled) {
    await rpc('finish_karma_crypto_scan_run', {p_run_id:claim.run_id,p_status:'skipped',p_details:{reason:'scanner_disabled'},p_discovered:0,p_verified:0,p_valued:0,p_safe_error:null});
    return {status:'skipped', ...totals, details:{reason:'scanner_disabled'}};
  }

  for (const asset of claim.assets) {
    const result = {asset_id:asset.asset_id, status:'skipped', discovered:0, verified:0, valued:0};
    details.assets.push(result);
    if (!asset.enabled || !asset.recipient_address) { result.reason='asset_disabled'; continue; }
    const verification = providerFor(asset, 'verification');
    const discovery = providerFor(asset, 'discovery')[0] || verification[0];

    try {
      if (claim.mode === 'health_check') {
        const health = await healthCheckAsset(asset.asset_id,{providers:verification,recipient:asset.recipient_address,fetcher,retry});
        let priceHealth=null;
        try {
          const unit=(10n**BigInt(asset.decimals)).toString();
          const valuation=await valueWithTwoProviders(asset.asset_id,unit,new Date(Date.now()-15*60*1000).toISOString(),{providers:priceProviders,fetcher,retry});
          priceHealth={ok:true,sources:valuation.sources.map(source=>source.operator)};
        } catch (error) {
          const at=new Date(Date.now()-15*60*1000).toISOString();
          const probes=await Promise.allSettled(priceProviders.map(provider=>probeHistoricalPrice(provider,asset.asset,at,{fetcher,retry})));
          priceHealth={ok:false,error:safeError(error),sources:probes.map((probe,index)=>({operator:priceProviders[index].operator,ok:probe.status==='fulfilled',error:probe.status==='rejected'?safeError(probe.reason):undefined}))};
        }
        Object.assign(result,{status:health.ok&&priceHealth.ok?'healthy':'failed',checks:health.checks,price_check:priceHealth});
        if (!health.ok) throw new Error('One or more independent verification providers failed');
        if (!priceHealth.ok) throw new Error('Independent USD price providers failed');
        continue;
      }
      if (asset.checkpoint?.next_retry_at && Date.parse(asset.checkpoint.next_retry_at) > Date.now()) {
        result.reason='retry_backoff';
        continue;
      }

      let start = asset.checkpoint?.last_finalized_height == null ? null : Number(asset.checkpoint.last_finalized_height) + 1;
      let previousHash=asset.checkpoint?.last_scanned_hash;
      const deadline=Date.now()+assetBudgetMs;
      for(let batchIndex=0;batchIndex<maxBatches;batchIndex++){
      const batch = await discoverBatch(asset.asset_id,{provider:discovery,recipient:asset.recipient_address,fromBlock:start,fromTime:asset.scan_start_at,previousHash,fetcher,retry,maxBlocks:asset.kind==='evm-token'?2048:120});
      const discovered=batch.hashes;
      result.coverage={from:batch.fromBlock,to:batch.toBlock,finalized:batch.finalizedHeight,remaining_blocks:batch.lag};
      const known = new Map((asset.known_observations || []).map(item => [String(item.transaction_hash).toLowerCase(),item]));
      const hashes = [...new Set([...discovered,...(batchIndex===0?known.keys():[])])];
      if(hashes.length>1000)throw new Error('Observation budget exceeded; checkpoint not advanced');
      let unresolved=false,unresolvedBatch=false;
      result.discovered+=discovered.length; totals.discovered+=discovered.length;
      let maxHeight = asset.checkpoint?.last_scanned_height == null ? null : Number(asset.checkpoint.last_scanned_height);
      let maxHash = asset.checkpoint?.last_scanned_hash || null;

      for (const transactionHash of hashes) {
        const previous = known.get(transactionHash);
        let evidence;
        try {
          evidence = await verifyWithTwoProviders(asset.asset_id,transactionHash,{providers:verification,recipient:asset.recipient_address,fetcher,retry});
        } catch (error) {
          if (previous) {
            await rpc('record_karma_crypto_observation',{p_run_id:claim.run_id,p_payload:priorPayload(asset,previous,'needs_review','provider_verification_error')});
            unresolved=true;
            if(!discovered.includes(transactionHash))continue;
          }
          throw error;
        }
        if (!evidence.confirmed) {
          if (previous) {
            await rpc('record_karma_crypto_observation',{p_run_id:claim.run_id,p_payload:priorPayload(asset,previous,'reorged','not_confirmed_by_both_providers')});
          }
          unresolved=true;
          if(discovered.includes(transactionHash))unresolvedBatch=true;
          continue;
        }
        if(previous?.valuation_status==='valued'&&String(previous.amount_atomic)!==evidence.amount_atomic){
          await rpc('record_karma_crypto_observation',{p_run_id:claim.run_id,p_payload:priorPayload(asset,previous,'needs_review','transaction_amount_changed')});
          throw new Error('Valued transaction amount changed; manual review required');
        }
        result.verified++; totals.verified++;
        let valuation = null;
        try {
          valuation = previous?.valuation_status==='valued' ? {status:'valued',price_usd:previous.price_usd,amount_usd:previous.amount_usd,sources:previous.valuation_sources,valued_at:previous.valued_at} : await valueWithTwoProviders(asset.asset_id,evidence.amount_atomic,evidence.observed_at,{providers:priceProviders,fetcher,retry});
          result.valued++; totals.valued++;
        } catch (error) {
          result.valuation_error=safeError(error);
        }
        await rpc('record_karma_crypto_observation',{p_run_id:claim.run_id,p_payload:confirmedPayload(asset,evidence,valuation)});
      }
      if(unresolvedBatch&&batch.toBlock!=null)throw new Error('Unconfirmed batch candidate; checkpoint not advanced');
      // Coverage advances only after every candidate has been saved successfully.
      if(batch.toBlock!=null){maxHeight=batch.toBlock;maxHash=batch.blockHash;}
      await rpc('save_karma_crypto_checkpoint',{p_run_id:claim.run_id,p_asset_id:asset.asset_id,p_last_scanned_height:maxHeight,p_last_scanned_hash:maxHash,p_last_finalized_height:maxHeight,p_success:true,p_safe_error:null});
      result.status=batch.complete&&!result.valuation_error&&!unresolved?'succeeded':'partial';
      result.batches=batchIndex+1;
      if(batch.complete||Date.now()>=deadline)break;
      start=batch.toBlock+1;previousHash=batch.blockHash;
      }
    } catch (error) {
      result.status='failed'; result.error=safeError(error);
      if (claim.mode !== 'health_check') {
        await rpc('save_karma_crypto_checkpoint',{p_run_id:claim.run_id,p_asset_id:asset.asset_id,p_last_scanned_height:null,p_last_scanned_hash:null,p_last_finalized_height:null,p_success:false,p_safe_error:result.error});
      }
    }
  }

  const active=details.assets.filter(item=>item.status!=='skipped');
  const failures=active.filter(item=>item.status==='failed').length;
  const status=failures===0?(active.some(item=>item.status==='partial')?'partial':'succeeded'):failures===active.length?'failed':'partial';
  await rpc('finish_karma_crypto_scan_run',{p_run_id:claim.run_id,p_status:status,p_details:details,p_discovered:totals.discovered,p_verified:totals.verified,p_valued:totals.valued,p_safe_error:failures?safeError(new Error(`${failures} asset checks failed`)):null});
  return {status,...totals,details};
}
