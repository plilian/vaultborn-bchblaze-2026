import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVirtualMachineBCH, encodeTransaction } from '@bitauth/libauth';
import { walletFromPrivateKey } from './index.mjs';
import { hex, readTransaction } from './primitives.mjs';
import { kingdomVault, planChestCapture, signCaptureDigests, signChestCapture, vaultTerms } from './kingdom-vault.mjs';
import { buildChestFeed, chestFeeder, feederTerms } from './chest-feeder.mjs';
import { awardQuorum, completePrizeAward, layoutPrizeAward, planPrizeAward, prizeFund, signPrizeAward } from './prize-fund.mjs';

const key = number => number.toString(16).padStart(64, '0');
const wallet = number => walletFromPrivateKey(key(number));
const operator = wallet(600), owner = wallet(601), winner = wallet(602);
const attestorKeys = [key(701), key(702), key(703)];
const attestors = attestorKeys.map(item => walletFromPrivateKey(item));
const secretOf = publicKey => attestorKeys[attestors.findIndex(item => item.publicKey === publicKey)];
const vm = createVirtualMachineBCH();
const txid = 'ab'.repeat(32);

test('a war chest capture needs the game key and a strict majority of the attestors, and no more', () => {
  assert.throws(() => kingdomVault({ id:'00'.repeat(16), operatorKey:operator.publicKey, ownerKey:owner.publicKey, capturePercent:20, attestors:attestors.map(item => item.publicKey), threshold:1, revision:3 }),
    /strict majority/, 'a minority threshold is refused when the script is built');
  const chest = kingdomVault({ id:'00'.repeat(16), operatorKey:operator.publicKey, ownerKey:owner.publicKey, capturePercent:20, attestors:attestors.map(item => item.publicKey), revision:3 });
  assert.equal(chest.threshold, 2);
  const source = { txid, vout:0, satoshis:20_000, script:chest.script, kv:vaultTerms(chest) };
  const plan = planChestCapture([source], { satoshis:3_000, script:winner.script });
  const sign = publicKey => signCaptureDigests(plan, secretOf(publicKey));
  const [a, b, c] = chest.attestors;
  // Any two of the three, in any combination; the third may be offline.
  for (const pair of [[a, b], [a, c], [b, c]]) assert.ok(signChestCapture(plan, key(600), Object.fromEntries(pair.map(item => [item, sign(item)]))).txid);
  assert.throws(() => signChestCapture(plan, key(600), { [a]:sign(a) }), /attestor signature is missing/);
  // One attestor twice, a stranger's signature, or the attestors without the game key: all refused by the script.
  const refused = attestations => {
    const { rawHex } = signChestCapture(plan, key(600), attestations, { unchecked:true });
    return vm.verify({ transaction:readTransaction(rawHex).transaction, sourceOutputs:plan.sourceOutputs }) !== true;
  };
  assert.ok(refused({ [a]:sign(a), [b]:sign(a) }), 'one attestor cannot stand in for another');
  assert.ok(refused({ [a]:sign(a), [b]:signCaptureDigests(plan, key(999)) }), 'a signature by a key outside the set does not count');
  const noGame = signChestCapture(plan, key(999), { [a]:sign(a), [b]:sign(b) }, { unchecked:true });
  assert.notEqual(vm.verify({ transaction:readTransaction(noGame.rawHex).transaction, sourceOutputs:plan.sourceOutputs }), true, 'the attestors cannot capture without the game key');
  // More than 20% is refused whoever signs.
  const greedy = readTransaction(signChestCapture(plan, key(600), { [a]:sign(a), [b]:sign(b) }, { unchecked:true }).rawHex).transaction;
  greedy.outputs[0].valueSatoshis = 15_000n;
  assert.notEqual(vm.verify({ transaction:greedy, sourceOutputs:plan.sourceOutputs }), true);
});

test('a capture spends several outputs of one War Chest and returns one remainder of at least 80% of all of them', () => {
  const chest = kingdomVault({ id:'00'.repeat(16), operatorKey:operator.publicKey, ownerKey:owner.publicKey, capturePercent:20, attestors:[attestors[0].publicKey], revision:3 });
  const outputs = [8_000, 5_000, 3_000].map((satoshis, vout) => ({ txid, vout, satoshis, script:chest.script, kv:vaultTerms(chest) }));
  const plan = planChestCapture(outputs, { satoshis:3_200, script:winner.script });
  assert.deepEqual(plan.outputs.map(item => [item.script, item.satoshis]), [[chest.script, 12_800], [winner.script, 3_200 - plan.feeSatoshis]], 'three outputs become one');
  const sign = target => ({ [chest.attestors[0]]:signCaptureDigests(target, attestorKeys[0]) });
  assert.ok(signChestCapture(plan, key(600), sign(plan)).txid);
  assert.throws(() => planChestCapture(outputs, { satoshis:3_201, script:winner.script }), /exceeds what these war chest outputs permit/);
  // Signed by everyone, but returning less than 80% of what the transaction spends: refused by the script.
  const short = signChestCapture(plan, key(600), sign(plan), { unchecked:true });
  const { transaction } = readTransaction(short.rawHex);
  transaction.outputs[0].valueSatoshis = 12_799n;
  assert.notEqual(vm.verify({ transaction, sourceOutputs:plan.sourceOutputs }), true);
  assert.throws(() => planChestCapture([...outputs, ...outputs].map((item, vout) => ({ ...item, vout })), { satoshis:1_000, script:winner.script }), /spends 1 to 4/);
});

test('waiting shares join an attested capture of their own War Chest, and nothing else can take them along', () => {
  const chest = kingdomVault({ id:'00'.repeat(16), operatorKey:operator.publicKey, ownerKey:owner.publicKey, capturePercent:20, attestors:[attestors[0].publicKey], revision:3 });
  const other = kingdomVault({ id:'00'.repeat(16), operatorKey:operator.publicKey, ownerKey:winner.publicKey, capturePercent:20, attestors:[attestors[0].publicKey], revision:3 });
  const small = { txid, vout:0, satoshis:5_000, script:chest.script, kv:vaultTerms(chest) };
  const share = (vout, chestScript = chest.script) => { const contract = chestFeeder({ id:String(vout).repeat(32), chestScript, threshold:6_350, reserve:220, wait:13_104 });
    return { txid, vout, satoshis:2_470, script:contract.script, cf:feederTerms(contract), contract }; };
  // Alone, 20% of this chest output cannot pay a capture. With two waiting shares it can, and all three become one output.
  assert.throws(() => planChestCapture([small], { satoshis:1_000, script:winner.script }), /too small to pay its network fee/);
  const feeders = [share(1), share(2)];
  const plan = planChestCapture([small], { satoshis:1_988, script:winner.script, feeders });
  assert.deepEqual(plan.outputs.map(item => [item.script, item.satoshis]), [[chest.script, 9_940 - 1_988], [winner.script, 1_988 - plan.feeSatoshis]]);
  assert.ok(plan.paid >= 546 && plan.feeSatoshis < 1_000);
  const sign = target => ({ [chest.attestors[0]]:signCaptureDigests(target, attestorKeys[0]) });
  assert.ok(signChestCapture(plan, key(600), sign(plan)).txid, 'the shares need no signature of their own');
  assert.throws(() => planChestCapture([small], { satoshis:1_989, script:winner.script, feeders }), /exceeds what these war chest outputs permit/, '20% of everything spent, shares included');
  // Without the attestor the shares cannot be taken along; and a share of one owner cannot ride with another owner's chest.
  const unsigned = signChestCapture(plan, key(600), { [chest.attestors[0]]:signCaptureDigests(plan, key(600)) }, { unchecked:true });
  assert.notEqual(vm.verify({ transaction:readTransaction(unsigned.rawHex).transaction, sourceOutputs:plan.sourceOutputs }), true);
  assert.throws(() => planChestCapture([{ ...small, script:other.script, kv:vaultTerms(other) }], { satoshis:1_988, script:owner.script, feeders }), /its own live War Chest only/);
});

test('a chest feeder can only become its owner\'s War Chest output, with a bounded fee and not below the threshold', () => {
  const chest = kingdomVault({ id:'00'.repeat(16), operatorKey:operator.publicKey, ownerKey:owner.publicKey, capturePercent:20, attestors:[attestors[0].publicKey], revision:3 });
  const terms = id => feederTerms(chestFeeder({ id, chestScript:chest.script, threshold:6_000, reserve:220, wait:2_016 }));
  const feeders = [1, 2, 3, 4, 5].map(index => { const cf = terms(String(index).repeat(32)); return { txid, vout:index, satoshis:2_470, script:chestFeeder(cf).script, cf }; });
  const verify = (rawHex, sources) => vm.verify({ transaction:readTransaction(rawHex).transaction,
    sourceOutputs:sources.map(item => ({ lockingBytecode:Uint8Array.from(Buffer.from(item.script, 'hex')), valueSatoshis:BigInt(item.satoshis) })) });
  const three = buildChestFeed(feeders.slice(0, 3));
  assert.equal(three.chestSatoshis, 3 * 2_470 - three.feeSatoshis);
  assert.ok(three.feeSatoshis <= 3 * 220 && three.chestSatoshis >= 6_000);
  assert.throws(() => buildChestFeed(feeders.slice(0, 2)), /do not reach the War Chest threshold/);
  assert.throws(() => buildChestFeed(feeders), /moves 1 to 4 feeders/);
  const tamper = change => { const { transaction } = readTransaction(buildChestFeed(feeders.slice(0, 3), { unchecked:true }).rawHex); change(transaction); return hex(encodeTransaction(transaction)); };
  assert.notEqual(verify(tamper(tx => { tx.outputs[0].lockingBytecode = Uint8Array.from(Buffer.from(owner.script, 'hex')); }), feeders.slice(0, 3)), true, 'not even to the owner\'s wallet');
  assert.notEqual(verify(tamper(tx => { tx.outputs[0].valueSatoshis -= 200n; }), feeders.slice(0, 3)), true, 'the fee cannot exceed the reserves');
  assert.notEqual(verify(tamper(tx => { tx.outputs.push({ lockingBytecode:Uint8Array.from(Buffer.from(winner.script, 'hex')), valueSatoshis:600n }); tx.outputs[0].valueSatoshis -= 600n; }), feeders.slice(0, 3)), true, 'no second output');
  // Below the threshold the move is valid only with the waiting period set on the input, which a node enforces as block age.
  const aged = buildChestFeed(feeders.slice(0, 1), { aged:true });
  assert.equal(readTransaction(aged.rawHex).transaction.inputs[0].sequenceNumber, 2_016);
  assert.notEqual(verify(tamper(tx => { tx.inputs.splice(1); tx.outputs[0].valueSatoshis = 2_260n; }), feeders.slice(0, 1)), true, 'a lone share cannot skip the wait');
});

test('a prize award needs a majority of attestors, and one attestor only after the fund\'s recovery time', () => {
  const closesAt = 1_800_000_000, recoverAt = closesAt + 30 * 86_400;
  const fund = { id:'cd'.repeat(16), operatorKey:operator.publicKey, attestors:attestors.map(item => item.publicKey).sort(), closesAt, awardPercent:40, awardAge:6, maxFee:2000, threshold:2, recoverAt };
  const contract = prizeFund(fund);
  assert.deepEqual([awardQuorum(contract, closesAt), awardQuorum(contract, recoverAt)], [2, 1]);
  assert.throws(() => prizeFund({ ...fund, threshold:1 }), /strict majority/);
  const offered = [{ txid, vout:0, satoshis:100_000, script:contract.script, fund }];
  const build = now => { const { sources, outputs } = layoutPrizeAward(offered, { script:winner.script, satoshis:30_000 }); return planPrizeAward(sources, outputs, { now }); };
  const [a, b] = contract.attestors;
  const normal = build(closesAt + 10);
  assert.equal(normal.locktime, closesAt);
  const signed = (plan, keys) => Object.fromEntries(keys.map(item => [item, signPrizeAward(plan, secretOf(item))]));
  assert.ok(completePrizeAward(normal, signPrizeAward(normal, key(600)), signed(normal, [a, b])).txid, 'two of three, the third offline');
  assert.throws(() => completePrizeAward(normal, signPrizeAward(normal, key(600)), signed(normal, [a])), /attestor signature is missing/);
  // One signature on a transaction dated before the recovery time is refused by the script itself.
  const early = structuredClone(normal);
  const forged = completePrizeAward({ ...early, locktime:recoverAt }, signPrizeAward(normal, key(600)), signed(normal, [a]), { unchecked:true });
  assert.notEqual(vm.verify({ transaction:readTransaction(forged.rawHex).transaction, sourceOutputs:normal.sourceOutputs }), true);
  // After the recovery time the award is dated at it, and the game key with any one attestor is enough. The game key alone never is.
  const late = build(recoverAt + 10);
  assert.equal(late.locktime, recoverAt);
  assert.ok(completePrizeAward(late, signPrizeAward(late, key(600)), signed(late, [b])).txid);
  assert.throws(() => completePrizeAward(late, signPrizeAward(late, key(600)), {}), /attestor signature is missing/);
  // The game key is gone: after the recovery time ALL attestors together can still pay. Two of three cannot, and before that time nobody can.
  const [, , c] = contract.attestors;
  assert.ok(completePrizeAward(late, null, signed(late, [a, b, c])).txid, 'every attestor, without the game key');
  assert.throws(() => completePrizeAward(late, null, signed(late, [a, b])), /attestor signature is missing/);
  const twoOnly = completePrizeAward({ ...late, contracts:late.contracts.map(item => ({ ...item, attestors:[a, b], continuity:true })) }, null, signed(late, [a, b]), { unchecked:true });
  assert.notEqual(vm.verify({ transaction:readTransaction(twoOnly.rawHex).transaction, sourceOutputs:late.sourceOutputs }), true);
  assert.throws(() => completePrizeAward(normal, null, signed(normal, [a, b, c])), /attestor signature is missing/, 'not before the recovery time');
  const tooEarly = completePrizeAward({ ...normal, locktime:recoverAt }, null, signed(normal, [a, b, c]), { unchecked:true });
  assert.notEqual(vm.verify({ transaction:readTransaction(tooEarly.rawHex).transaction, sourceOutputs:normal.sourceOutputs }), true);
  // A single attestor can never be the whole panel of this lane.
  assert.equal(prizeFund({ ...fund, attestors:[a], threshold:1 }).continuity, false);
});
