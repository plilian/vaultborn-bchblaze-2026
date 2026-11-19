import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createChain } from '../packages/chain-observer/index.mjs';
import { decodeAddress } from '../packages/chain-observer/primitives.mjs';
import { politicalEscrow } from '../packages/chain-observer/political-escrow.mjs';
import { eventOutput, expectedPaymentOutputs, gameEvent, protocolHash } from '../packages/chain-observer/vaultborn.mjs';
import { digest } from '../packages/game-engine/combat.mjs';
import { paymentAllocation } from '../config/payments.mjs';

const input=process.argv[2];
if (!input) throw new Error('Supply a Political Archive JSON file or /api/public/politics URL. Add --chipnet to check confirmed transactions.');
const archive=/^https?:\/\//i.test(input) ? await fetch(input,{headers:{Accept:'application/json'}}).then(response=>{
  if (!response.ok) throw new Error('Political Archive returned HTTP '+response.status);
  return response.json();
}) : JSON.parse(await readFile(input,'utf8'));
assert.equal(archive.network,'chipnet');
assert.ok(Array.isArray(archive.records),'Missing political records.');
const chain=process.argv.includes('--chipnet') ? createChain() : null;
const transactionCache=new Map();

function checkConflict(conflict) {
  if (conflict?.seedScheme!=='political-front-v2') return;
  assert.equal(digest(conflict.seed),conflict.seedCommitment);
  for (const round of conflict.rounds) assert.equal(round.seed,digest([conflict.seed,round.stage-1]));
}

for (const conflict of archive.government?.conflicts ?? []) checkConflict(conflict);

async function confirmed(receipt) {
  assert.match(receipt.txid,/^[0-9a-f]{64}$/);
  if (!chain) return null;
  const live=transactionCache.get(receipt.txid) ?? await chain.verifyPublishedTransaction(receipt.txid);
  assert.ok(live?.confirmations>=2,'Receipt needs two confirmed Chipnet blocks.');
  if (receipt.blockHash) assert.equal(live.blockHash,receipt.blockHash);
  if (receipt.height) assert.equal(live.height,receipt.height);
  transactionCache.set(receipt.txid,live);
  return live;
}

function exactOutput(transaction,expected) {
  const hits=transaction.outputs.filter(item=>item.asset==='BCH' && item.script===expected.script && item.satoshis===expected.satoshis);
  assert.equal(hits.length,1,'Missing or duplicated exact BCH output.');
  return hits[0];
}

function checkCommitment(transaction,receipt,expected,satoshis=0) {
  assert.deepEqual(receipt.event,expected);
  const output=eventOutput(expected,satoshis);
  if (transaction) assert.equal(exactOutput(transaction,output).vout,receipt.eventVout);
}

for (const {record,recordHash,anchored,payment,opening,chainReview} of archive.records) {
  assert.ok(!chainReview,'This archive flags a chain reorganization for '+record.id+'.');
  assert.equal(protocolHash(record),recordHash,'Political record was modified.');
  if (record.kind==='conflict-support') checkConflict(record.result);
  assert.match(record.termsHash ?? recordHash,/^[0-9a-f]{64}$/);
  if (record.contract) {
    const plan=politicalEscrow(record.contract);
    assert.deepEqual(plan,record.contract);
    assert.equal(plan.principal,record.principal);
    const funding=await confirmed(record.funding);
    checkCommitment(funding,record.funding,gameEvent('political-escrow',plan.id,{
      treaty:record.treaty,termsHash:record.termsHash,principal:record.principal,refundAt:plan.refundAt,script:plan.script,
    }));
    const spend=await confirmed(record.settlement);
    const released=record.kind==='treaty-compensation';
    if (record.settlement.event) checkCommitment(spend,record.settlement,gameEvent(released?'political-release':'political-refund',record.id,{
      treaty:record.treaty,termsHash:record.termsHash,entryTxid:record.funding.txid,principal:record.principal,
    }));
    if (spend) {
      const funded=exactOutput(funding,plan);
      assert.deepEqual(spend.inputs,[{txid:funding.txid,vout:funded.vout}]);
      assert.deepEqual(spend.outputs[0],{vout:0,script:decodeAddress(released?plan.payee:plan.payer).script,satoshis:plan.principal,asset:'BCH'});
      assert.equal(spend.outputs.length,2);
      assert.equal(spend.outputs[1].satoshis,0);
      assert.equal(spend.feeSatoshis,plan.satoshis-plan.principal);
    }
  } else if (payment) {
    assert.equal(payment.event.kind,'political-operation');
    assert.equal(payment.event.data.actionHash,protocolHash(opening));
    const allocation=payment.event.data.allocation;
    const total=allocation.development+allocation.burn+allocation.prize+allocation.kingdom;
    assert.deepEqual(allocation,paymentAllocation(total,payment.event.kind,payment.event.data.allocationPolicy));
    const incoming=await confirmed(payment);
    checkCommitment(incoming,payment,payment.event,allocation.burn);
    const outputs=incoming && expectedPaymentOutputs({id:payment.event.subject,publicKey:archive.treasuryPublicKey,
      satoshis:total,allocation,event:payment.event}).map(plan=>({role:plan.role,...exactOutput(incoming,plan)}));
    if (anchored) {
      const outcome=await confirmed(anchored);
      checkCommitment(outcome,anchored,gameEvent('political-outcome',record.id,{recordHash,entryTxid:payment.txid}));
      if (outcome) assert.deepEqual(outcome.inputs,[{txid:incoming.txid,vout:outputs.find(output=>output.role==='development').vout}]);
    }
  }
  console.log(record.id+' · '+(record.settlement || anchored ? 'settled' : 'awaiting anchor')+' · '+recordHash);
}
console.log(`${archive.records.length} political records checked${chain?' against Chipnet':''}.`);
