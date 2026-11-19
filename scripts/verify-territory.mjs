import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createChain } from '../packages/chain-observer/index.mjs';
import { eventOutput, expectedPaymentOutputs, protocolHash } from '../packages/chain-observer/vaultborn.mjs';
import { raffleSample } from '../apps/game-server/territory-raffles.mjs';
import { verifyBattle } from '../apps/game-server/battle-records.mjs';
import { paymentAllocation } from '../config/payments.mjs';

const input = process.argv[2];
if (!input) throw new Error('Supply the territory JSON file or its local verification URL.');
const envelope = input.startsWith('http') ?
  await fetch(input,{headers:{Accept:'application/json'}}).then(async response => {
    if (!response.ok) throw new Error('Territory server returned HTTP ' + response.status);
    return response.json();
  }) : JSON.parse(await readFile(input,'utf8'));
const checkChain = process.argv.includes('--chipnet');
const chain = checkChain ? createChain() : null;
const { territory, records, treasuryPublicKey } = envelope;
console.log('Verifying territory ' + territory.id);

const verified = new Map();
async function verifyLink(receipt, satoshis) {
  const expected = eventOutput(receipt.event,satoshis);
  if (!chain) return;
  const live = verified.get(receipt.txid) ?? await chain.verifyPublishedTransaction(receipt.txid);
  assert.ok(live?.confirmations >= 2, 'Receipt has insufficient confirmed Chipnet work.');
  assert.equal(live.outputs[receipt.eventVout]?.script,expected.script);
  assert.equal(live.outputs[receipt.eventVout]?.satoshis,satoshis);
  if (receipt.blockHash) assert.equal(live.blockHash,receipt.blockHash);
  if (receipt.height) assert.equal(live.height,receipt.height);
  verified.set(receipt.txid,live);
  return live;
}

function verifySplit(proof, entry, live) {
  const a = proof.event.data.allocation;
  const total = Object.values(a).reduce((sum,value)=>sum+value,0);
  assert.deepEqual(a,paymentAllocation(total,proof.event.kind,proof.event.data.allocationPolicy));
  assert.equal(entry.escrowSatoshis,a.battle);
  if (!live || !treasuryPublicKey) return [];
  const planned = expectedPaymentOutputs({id:proof.event.subject,publicKey:treasuryPublicKey,satoshis:total,allocation:a,event:proof.event});
  return planned.flatMap(output => {
    const matches = live.outputs.filter(item => item.asset === 'BCH' && item.script === output.script && item.satoshis === output.satoshis);
    assert.equal(matches.length,1,'The confirmed transaction must contain each exact payment allocation once.');
    return ['battle','development','settlement'].includes(output.role) ? [{txid:live.txid,vout:matches[0].vout}] : [];
  });
}

for (const {record,recordHash,proofs,settlement} of records) {
  assert.equal(record.territoryId,territory.id);
  assert.equal(protocolHash(record),recordHash,'Territory record was modified.');
  const receipts = new Map(proofs.map(item => [item.txid,item]));
  const sources = [];
  for (const entry of record.entries ?? []) {
    const proof = receipts.get(entry.txid);
    assert.ok(proof,'A settled entry is missing its announced transaction.');
    assert.equal(proof.event.data.territory,territory.id);
    if (record.round) {
      assert.deepEqual(proof.event.data.round,Object.fromEntries(Object.keys(proof.event.data.round).map(key => [key,record.round[key]])));
      assert.equal(proof.height,entry.included);
      assert.ok(proof.height >= record.round.startHeight && proof.height <= record.round.closeHeight);
    }
    const transaction = await verifyLink(proof,proof.event.data.allocation.burn??0);
    sources.push(...verifySplit(proof,entry,transaction));
  }
  for (const battle of record.battles ?? []) assert.ok(verifyBattle(battle),'A territory battle fails deterministic replay.');
  if (record.result && record.block) {
    assert.deepEqual(raffleSample(record.round,record.block),record.result);
    assert.equal(record.winner,record.result.winner);
    if (chain) {
      const block = await chain.blockAt(record.block.height);
      assert.ok(block?.confirmations >= record.round.confirmations);
      assert.equal(block.hash,record.block.hash);
    }
  }
  if (settlement) {
    assert.equal(settlement.event.data.recordHash,recordHash);
    assert.deepEqual(settlement.event.data.entryTxids,(record.entries ?? []).map(entry => entry.txid));
    const transaction = await verifyLink(settlement,0);
    if (transaction) {
      assert.equal(transaction.feeSatoshis,settlement.feeSatoshis);
      if (sources.length) assert.deepEqual(transaction.inputs,sources,'Settlement must spend the exact two escrow-related outputs of each entry.');
      if (record.kind === 'lease-expired') {
        const previous = records.find(item => item.record.id === record.preceding)?.settlement;
        assert.ok(previous,'The expiry is missing its earlier raffle settlement.');
        await verifyLink(previous,0);
        assert.deepEqual(transaction.inputs,[{txid:previous.txid,vout:previous.eventVout-1}]);
      }
    }
  }
  console.log(record.id + ' · ' + (settlement ? 'anchored' : 'awaiting anchor') + ' · ' + recordHash);
}
