import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { encodeTransaction } from '@bitauth/libauth';
import { fromHex, hex, readTransaction, signSpend, walletFromPrivateKey } from './primitives.mjs';
import { createTerritoryAssets } from './territory-assets.mjs';
import {
  BATON_COMMITMENT, buildTerritoryGenesis, buildTerritoryIssue, knownTerritoryBaton, normalizeTerritoryEvent,
  territoryCommitment, traceTerritoryCollectible, validateTerritoryIssue,
} from './territory-token.mjs';

const operatorKey = 'a'.padStart(64,'0');
const holderKey = 'b'.padStart(64,'0');
const recipientKey = 'c'.padStart(64,'0');
const operator = walletFromPrivateKey(operatorKey);
const holder = walletFromPrivateKey(holderKey);
const recipient = walletFromPrivateKey(recipientKey);
const category = '12'.repeat(32);
const eventDescriptor = {
  eventId:'winner-1',territoryId:'test-frontier',kind:'deed',holderAddress:holder.address,
  controllerId:'p1',version:1,controlHash:'ab'.repeat(32),relatedTxid:'ff'.repeat(32),
};
const event = normalizeTerritoryEvent(eventDescriptor);
const setup = buildTerritoryGenesis({ txid:category, vout:0, satoshis:10_000, script:operator.script },operatorKey);

function observed(rawHex, confirmations = 2, height = 333345) {
  return { ...readTransaction(rawHex), confirmations, height, blockHash:'34'.repeat(32) };
}
const genesis = observed(setup.rawHex);
const baton = knownTerritoryBaton(genesis,category,operator.script,true);

test('the native category starts with a single segregated minting baton and each issue replaces it', () => {
  assert.equal(setup.category,category);
  assert.equal(genesis.transaction.outputs[0].token.nft.capability,'minting');
  assert.equal(hex(genesis.transaction.outputs[0].token.nft.commitment),BATON_COMMITMENT);
  assert.throws(() => knownTerritoryBaton(genesis,'98'.repeat(32),operator.script,true), /did not originate/);
  assert.throws(() => knownTerritoryBaton(genesis,category,recipient.script,true), /authority transaction/);
  assert.throws(() => buildTerritoryGenesis({txid:category,vout:1,satoshis:10000},operatorKey),/vout zero/);
  const plan = buildTerritoryIssue({baton,event,category,operatorPrivateKey:operatorKey});
  const actual = observed(plan.rawHex);
  const receipt = validateTerritoryIssue(actual,{event,plan},operator.script);
  assert.equal(receipt.assetVout,1);
  assert.equal(receipt.anchorVout,2);
  assert.equal(receipt.authorityVout,0);
  assert.equal(actual.transaction.outputs[1].token.nft.capability,'none');
  assert.equal(actual.transaction.outputs[2].valueSatoshis,0n);
  assert.equal(Buffer.from(receipt.commitment,'hex').length,40);
  assert.equal(baton.satoshis, plan.batonSatoshis + 1500 + plan.feeSatoshis);
  assert.throws(() => buildTerritoryIssue({baton,event,category,operatorPrivateKey:recipientKey}),/live minting baton/);
});

test('every lease phase commits its event and expiry independently of game access', () => {
  const expiresAt = 1795000000000;
  const lease = normalizeTerritoryEvent({...eventDescriptor,eventId:'lease-11',kind:'lease',expiresAt});
  const renewal = normalizeTerritoryEvent({...eventDescriptor,eventId:'renewal-12',kind:'lease-renewed',version:2,expiresAt:expiresAt+86400000});
  assert.notEqual(territoryCommitment(lease).commitment,territoryCommitment(renewal).commitment);
  assert.throws(() => normalizeTerritoryEvent({...eventDescriptor,kind:'lease'}), /expiration/);
  const expired = normalizeTerritoryEvent({...eventDescriptor,eventId:'expiry-13',kind:'lease-expired',version:3,holderAddress:null,expiresAt});
  const plan = buildTerritoryIssue({baton,event:expired,category,operatorPrivateKey:operatorKey});
  const issue = observed(plan.rawHex);
  const receipt = validateTerritoryIssue(issue,{event:expired,plan},operator.script);
  assert.equal(receipt.assetVout,null);
  assert.equal(receipt.anchorVout,1);
  assert.equal(receipt.commitment,null);
  assert.equal(issue.transaction.outputs.length,2);
  assert.throws(() => validateTerritoryIssue(issue,{event:expired,plan:{ ...plan, anchorScript:'6a' }},operator.script), /confirmed outputs/);
});

test('ownership follows a verified immutable token spend and reports a token burn as destroyed', async () => {
  const plan = buildTerritoryIssue({baton,event,category,operatorPrivateKey:operatorKey});
  const issue = observed(plan.rawHex,2,333350);
  const token = issue.transaction.outputs[1].token;
  const transfer = signSpend({
    sources:[{txid:issue.txid,vout:1,token,satoshis:1500,script:holder.script}],
    outputs:[{token,satoshis:1100,script:recipient.script}],privateKey:holderKey,
  });
  const moved = observed(transfer.rawHex,2,333351);
  const burned = signSpend({
    sources:[{txid:moved.txid,vout:0,token,satoshis:1100,script:recipient.script}],
    outputs:[{satoshis:750,script:recipient.script}],privateKey:recipientKey,
  });
  const destroyed = observed(burned.rawHex,2,333352);
  let isBurned = false;
  const client = {
    async listUnspent(script) {
      return script === recipient.script && !isBurned ? [{txid:moved.txid,vout:0,satoshis:1100,height:moved.height}] : [];
    },
    async history(script) { return script === holder.script ? [{txid:moved.txid,height:moved.height}] : [{txid:destroyed.txid,height:destroyed.height}]; },
    async raw(txid) { return txid === transfer.txid ? transfer.rawHex : burned.rawHex; },
    async lookup(txid) { return txid === transfer.txid ? moved : destroyed; },
  };
  const verified = await traceTerritoryCollectible(client,issue,1,category,plan.commitment,2);
  assert.equal(verified.current.address,recipient.tokenAddress);
  assert.deepEqual(verified.history.map(row=>row.type),['issued','transferred']);
  isBurned = true;
  const gone = await traceTerritoryCollectible(client,issue,1,category,plan.commitment,2);
  assert.equal(gone.status,'burned');
  assert.equal(gone.current,null);
  assert.deepEqual(gone.history.map(row=>row.type),['issued','transferred','burned']);
});

test('the territory journal reserves one deed, and resumes exactly the same signing plan after restart', async () => {
  await mkdir('var',{recursive:true});   // a fresh copy of the repository has no var/ folder yet
  const dir = await mkdtemp(resolve('var','territory-token-test-'));
  const transactions = new Map([[genesis.txid,genesis]]);
  const broadcasts = [];
  let drop = true;
  const client = {
    async lookup(txid) { return transactions.get(txid) ?? null; },
    async listUnspent(script) { return script===operator.script ? [{txid:genesis.txid,vout:0,satoshis:9500,height:genesis.height}] : []; },
    async broadcast(raw) {
      const tx = observed(raw,0,333351);
      broadcasts.push(tx.txid);
      if (drop) throw Error('fixture transport failure before acknowledgement');
      transactions.set(tx.txid,tx);
      return tx.txid;
    }
  };
  const config = {database:resolve(dir,'journal.sqlite'),operatorPrivateKey:operatorKey,category,genesisTxid:setup.txid,
    transport:{ withClient:fn=>fn(client) } };
  let issuer = createTerritoryAssets(config);
  try {
    const waiting = issuer.enqueue({...eventDescriptor,holderAddress:null});
    assert.equal(waiting.state,'waiting-wallet');
    assert.equal(issuer.enqueue(eventDescriptor).state,'queued');
    assert.throws(()=>issuer.enqueue({...eventDescriptor,version:2}),/same|already/);
    assert.equal(issuer.enqueue({...eventDescriptor,eventId:'recapture',version:2}).id,waiting.id);
    await issuer.reconcile();
    const signed = issuer.list(event.territoryId)[0];
    assert.equal(signed.state,'signed');
    assert.equal(signed.txid,broadcasts[0]);
    await issuer.close();
    issuer = createTerritoryAssets(config);
    drop = false;
    await issuer.reconcile();
    assert.equal(broadcasts[0],broadcasts[1]);
    assert.equal(issuer.list()[0].state,'submitted');
    transactions.get(signed.txid).confirmations=1;
    await issuer.reconcile();
    assert.equal(issuer.list()[0].state,'confirming');
    transactions.get(signed.txid).confirmations=2;
    await issuer.reconcile();
    assert.equal(issuer.list()[0].state,'confirmed');
    assert.equal(issuer.authority().headTxid,signed.txid);
    assert.equal(issuer.list()[0].rawHex,undefined);
  } finally {
    await issuer.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('ownership resolves through 40 transfers and a busy holding address by resuming from verified checkpoints', async () => {
  const plan = buildTerritoryIssue({baton,event,category,operatorPrivateKey:operatorKey});
  const issue = observed(plan.rawHex,2,400000);
  const token = issue.transaction.outputs[1].token;
  // The collectible ping-pongs between two wallets 40 times. Each wallet also has 300 unrelated history entries.
  const wallets = [[holder,holderKey],[recipient,recipientKey]];
  const chain = new Map();
  const spends = [];
  let source = {txid:issue.txid,vout:1,satoshis:1500,script:holder.script};
  for (let hop = 0; hop < 40; hop++) {
    const [, key] = wallets[hop % 2];
    const [next] = wallets[(hop + 1) % 2];
    // Tracing reads inputs and outputs only, so these fixture transfers are encoded without signatures.
    const spend = {rawHex:hex(encodeTransaction({version:2,locktime:0,inputs:[{outpointTransactionHash:fromHex(source.txid),
      outpointIndex:source.vout,sequenceNumber:0xffffffff,unlockingBytecode:Uint8Array.of(hop)}],
      outputs:[{lockingBytecode:fromHex(next.script),valueSatoshis:1500n,token}]}))};
    assert.ok(key);
    const seen = observed(spend.rawHex,2,400001 + hop);
    chain.set(seen.txid,{seen,raw:spend.rawHex,from:source.script});
    spends.push(seen);
    source = {txid:seen.txid,vout:0,satoshis:1500,script:next.script};
  }
  const noise = new Map();
  for (let index = 0; index < 300; index++) {
    const rawHex = hex(encodeTransaction({version:2,locktime:index,inputs:[{outpointTransactionHash:fromHex('9a'.repeat(32)),outpointIndex:index,
      sequenceNumber:0xfffffffe,unlockingBytecode:new Uint8Array()}],outputs:[{lockingBytecode:fromHex(operator.script),valueSatoshis:4000n}]}));
    noise.set(readTransaction(rawHex).txid,rawHex);
  }
  const unrelated = [...noise.keys()].map(txid=>({txid,height:400000}));
  let lookups = 0;
  const client = {
    async listUnspent(script) { return script === source.script ? [{txid:source.txid,vout:source.vout,satoshis:1500,height:400040}] : []; },
    async history(script) {
      const own = [...chain.values()].filter(item=>item.from === script).map(item=>({txid:item.seen.txid,height:item.seen.height}));
      return [...unrelated,...own];
    },
    async raw(txid) { return chain.get(txid)?.raw ?? noise.get(txid) ?? null; },
    async lookup(txid) { lookups++; return txid === issue.txid ? issue : chain.get(txid)?.seen ?? null; },
  };
  let checkpoint;
  let result;
  let passes = 0;
  do {
    result = await traceTerritoryCollectible(client,issue,1,category,plan.commitment,2,checkpoint);
    checkpoint = result.checkpoint;
    passes++;
    assert.ok(passes < 200, 'the trace must terminate');
  } while (result.status === 'continuing');
  assert.equal(result.status,'unspent');
  assert.equal(result.current.txid,spends.at(-1).txid);
  assert.equal(result.checkpoint.hops,40);
  assert.ok(passes > 1, 'the long chain needed more than one bounded pass');
  // A later check starts at the verified head instead of walking all 40 transfers again.
  lookups = 0;
  const again = await traceTerritoryCollectible(client,issue,1,category,plan.commitment,2,checkpoint);
  assert.equal(again.status,'unspent');
  assert.ok(lookups <= 2);
  // A forged checkpoint that points at a transaction without the collectible is ignored, not trusted.
  const forged = await traceTerritoryCollectible(client,issue,1,category,plan.commitment,2,{txid:'77'.repeat(32),vout:0,hops:99,scanned:0});
  assert.equal(forged.history[0].type,'issued');
  assert.notEqual(forged.status,'unspent');
});
