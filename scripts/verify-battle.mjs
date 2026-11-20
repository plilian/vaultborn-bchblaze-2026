import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyBattle } from '../apps/game-server/battle-records.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';
import { eventOutput, protocolHash } from '../packages/chain-observer/vaultborn.mjs';
import { NETWORK_LABEL } from '../config/network.mjs';

const source = process.argv[2];
if (!source) throw new Error('Supply a battle JSON file, or its local /verify/battle/<id>?format=json URL.');
const payload = /^https?:\/\//i.test(source)
  ? await fetch(source).then(async response => {
    if (!response.ok) throw new Error('Battle archive returned HTTP ' + response.status);
    return response.json();
  })
  : JSON.parse(await readFile(source, 'utf8'));
const { rules, record, recordHash, event, settlement } = payload;
assert.equal(record.rulesHash, protocolHash(rules), 'Rule fingerprint mismatch');
assert.ok(verifyBattle(record.battle), 'The recorded result does not match the deterministic battle rules');
if (recordHash) {
  assert.equal(recordHash, protocolHash(record), 'Archive hash mismatch');
  assert.equal(event.data.recordHash, recordHash, 'Settlement commitment does not match the archive');
  assert.equal(event.data.initiationTxid, record.initiation?.txid ?? null, 'Recorded initiation and settlement disagree');
  eventOutput(event);
}
console.log('Local combat replay verified for ' + record.battle.id + ' with result ' + record.battle.hash);
// --chain checks the recorded transactions on the network chosen by VAULTBORN_NETWORK; --chipnet is its earlier name.
if (process.argv.includes('--chain') || process.argv.includes('--chipnet')) {
  const chain = createChain();
  for (const [label, receipt] of [['initiation', record.initiation], ['settlement', settlement]]) {
    if (!receipt) {
      console.log('No confirmed ' + NETWORK_LABEL + ' ' + label + ' recorded.');
      continue;
    }
    const live = await chain.verifyPublishedTransaction(receipt.txid);
    const output = live?.outputs[receipt.vout];
    assert.ok(live?.confirmations >= 2, 'The ' + label + ' has insufficient active-chain confirmations');
    assert.equal(output?.asset, 'BCH');
    const expected = eventOutput(receipt.event, label === 'initiation' ? receipt.event.data.allocation?.burn ?? 0 : 0);
    assert.equal(output?.script, expected.script);
    assert.equal(output?.satoshis, expected.satoshis);
    if (label === 'settlement') assert.equal(receipt.event.digest, event.digest);
    console.log(NETWORK_LABEL + ' ' + label + ' verified at output ' + receipt.vout + ' of ' + receipt.txid);
  }
}
