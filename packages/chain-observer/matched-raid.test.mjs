import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as libauth from '@bitauth/libauth';
import { createVirtualMachineBCH } from '@bitauth/libauth';
import { walletFromPrivateKey } from './index.mjs';
import { hash256, readTransaction } from './primitives.mjs';
import { kingdomVault, planKingdomWithdrawal, signChestExit, signKingdomRecovery, signKingdomWithdrawal, vaultTerms } from './kingdom-vault.mjs';
import { chestInputBytes, completeMatchedCapture, completeRaidSpend, planMatchedCapture, planRaidSpend, raidEscrow, raidTermsFor, redigest, signMatchedDigests, signRaidDigest, signRaidRefund } from './matched-raid.mjs';

const key = number => number.toString(16).padStart(64, '0');
const wallet = number => walletFromPrivateKey(key(number));
const operator = wallet(800), defender = wallet(801), attacker = wallet(802), stranger = wallet(803);
const attestorKeys = [key(811), key(812), key(813)];
const attestors = attestorKeys.map(item => walletFromPrivateKey(item));
const secretOf = publicKey => publicKey === operator.publicKey ? key(800) : attestorKeys[attestors.findIndex(item => item.publicKey === publicKey)];
const vm = createVirtualMachineBCH();
const txid = 'cd'.repeat(32);
const refused = (rawHex, sourceOutputs) => vm.verify({ transaction: readTransaction(rawHex).transaction, sourceOutputs }) !== true;

function setup(count, { stake = 10_000, chest: values = [25_000] } = {}) {
  const keys = attestors.slice(0, count).map(item => item.publicKey);
  const chest = kingdomVault({ operatorKey: operator.publicKey, ownerKey: defender.publicKey, attestors: keys, revision: 4 });
  const panel = count === 1 ? { keys: [operator.publicKey, keys[0]], threshold: 2 } : { keys, threshold: 2 };
  const terms = raidTermsFor({ id: '11'.repeat(16), ownerKey: attacker.publicKey, opponent: defender.script, principal: stake, refundAt: 1_800_000_000, panel, chest });
  const escrow = raidEscrow(terms);
  const chests = values.map((satoshis, vout) => ({ txid, vout, satoshis, script: chest.script, kv: vaultTerms(chest) }));
  const funding = { txid: 'ef'.repeat(32), vout: 0, satoshis: escrow.satoshis, script: escrow.script, escrow: terms };
  return { chest, escrow, chests, funding, keys, panel };
}
const attest = (plan, publicKeys) => Object.fromEntries(publicKeys.map(item => [item, signMatchedDigests(plan, secretOf(item))]));

for (const count of [1, 3]) {
  test(`matched raid with ${count} attestor${count > 1 ? 's' : ''}: an attacker victory is one atomic transaction that pays 2 x S and takes exactly S from the War Chest`, t => {
    const { chest, escrow, chests, funding, keys } = setup(count);
    const plan = planMatchedCapture(chests, funding, { eventScript: '6a' + '28' + '00'.repeat(40) });
    const fee = escrow.winBase + escrow.winPerInput;
    assert.deepEqual(plan.outputs.slice(0, 3).map(item => [item.script, item.satoshis]), [[attacker.script, 20_000], [attacker.script, escrow.reserve - fee], [chest.script, 15_000]],
      'the attacker receives exactly both stakes, and separately the reserve this settlement did not need; the chest keeps the rest');
    const signers = keys.slice(0, count === 1 ? 1 : 2);
    const signed = completeMatchedCapture(plan, key(800), attest(plan, signers));
    assert.equal(signed.feeSatoshis, fee, 'the network fee is the measured size of this settlement');
    assert.ok(signed.bytes <= fee && fee - signed.bytes < 16, `the fee (${fee}) is the size of the transaction (${signed.bytes} bytes)`);
    t.diagnostic(`${count} attestor(s): atomic settlement ${signed.bytes} bytes; reserve ${escrow.reserve} (three chest outputs and a spendable refund), ${escrow.winPerInput} per chest output, settle fee ${escrow.settleFee}; chest script ${chest.redeemScript.length / 2} bytes, escrow script ${escrow.redeemScript.length / 2} bytes`);
    // Without the attestors, or with too few of them, nothing moves.
    assert.throws(() => completeMatchedCapture(plan, key(800), {}), /attestor signature is missing/);
    if (count === 3) assert.throws(() => completeMatchedCapture(plan, key(800), attest(plan, keys.slice(0, 1))), /attestor signature is missing/);
    // The attestors without the game key cannot capture either.
    assert.ok(refused(completeMatchedCapture(plan, key(999), attest(plan, signers), { unchecked: true }).rawHex, plan.sourceOutputs));
    // The same transaction with one satoshi more taken from the chest, signed correctly by everyone: the chest script refuses it.
    const greedy = redigest(planMatchedCapture(chests, funding));
    greedy.transaction.outputs[2].valueSatoshis -= 1n;
    redigest(greedy);
    assert.ok(refused(completeMatchedCapture(greedy, key(800), attest(greedy, signers), { unchecked: true }).rawHex, greedy.sourceOutputs), 'one satoshi beyond the stake');
  });
}

test('the War Chest refuses any capture that is not matched by the same amount in the same transaction', () => {
  const { chest, chests, keys, funding } = setup(1);
  // Each wrong transaction below is signed correctly by the game key and the attestor. What refuses it is the script.
  const wrong = change => {
    const plan = planMatchedCapture(chests, funding);
    change(plan.transaction);
    redigest(plan);
    return refused(completeMatchedCapture(plan, key(800), attest(plan, keys), { unchecked: true }).rawHex, plan.sourceOutputs);
  };
  assert.equal(wrong(() => {}), false, 'the unchanged settlement is accepted');
  assert.ok(wrong(transaction => { transaction.outputs[2].valueSatoshis -= 1n; }), 'one satoshi more leaves the chest than the stake that matches it');
  // The remainder paid to another script counts as leaving the chest.
  assert.ok(wrong(transaction => { transaction.outputs[2].lockingBytecode = Uint8Array.from(Buffer.from(stranger.script, 'hex')); }), 'a remainder that does not return to the chest');
  // The chest alone, with no escrow in the transaction: the panel cannot simply pay a third party out of it.
  const lone = planMatchedCapture(chests, funding);
  lone.transaction.inputs.pop();
  lone.sourceOutputs.pop();
  lone.transaction.outputs = [{ lockingBytecode: Uint8Array.from(Buffer.from(stranger.script, 'hex')), valueSatoshis: 8_500n }, { lockingBytecode: Uint8Array.from(Buffer.from(stranger.script, 'hex')), valueSatoshis: 546n }, lone.transaction.outputs[2]];
  lone.digests = [];
  const { generateSigningSerializationBCH, secp256k1, encodeDataPush } = libauth;
  const digest = hash256(generateSigningSerializationBCH({ inputIndex: 0, sourceOutputs: lone.sourceOutputs, transaction: lone.transaction }, { coveredBytecode: Buffer.from(chest.redeemScript, 'hex'), signingSerializationType: Uint8Array.of(0x61) }));
  const sign = secret => Buffer.concat([secp256k1.signMessageHashSchnorr(Buffer.from(secret, 'hex'), digest), Uint8Array.of(0x61)]);
  lone.transaction.inputs[0].unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(sign(key(800))), encodeDataPush(sign(attestorKeys[0])), Uint8Array.of(0x52), encodeDataPush(Buffer.from(chest.redeemScript, 'hex'))]));
  assert.notEqual(vm.verify({ transaction: lone.transaction, sourceOutputs: lone.sourceOutputs }), true, 'an unmatched capture is refused even with every signature');
  assert.equal(vaultTerms(chest).revision, 4);
});

test('a chest that holds exactly the stake is captured whole, and a remainder below the dust limit is never planned', () => {
  const exact = setup(1, { chest: [10_000] });
  const plan = planMatchedCapture(exact.chests, exact.funding);
  assert.equal(plan.remainder, 0);
  assert.deepEqual(plan.outputs.map(item => item.satoshis), [20_000, exact.escrow.reserve - plan.feeSatoshis]);
  assert.ok(completeMatchedCapture(plan, key(800), attest(plan, exact.keys)).txid);
  const dusty = setup(1, { chest: [10_300] });
  assert.throws(() => planMatchedCapture(dusty.chests, dusty.funding), /unspendable remainder/);
  const short = setup(1, { chest: [9_999] });
  assert.throws(() => planMatchedCapture(short.chests, short.funding), /do not cover the stake/);
  // Two outputs of one chest are spent together and leave one remainder.
  const two = setup(3, { chest: [7_000, 6_000] });
  const joined = planMatchedCapture(two.chests, two.funding);
  assert.deepEqual(joined.outputs.map(item => item.satoshis), [20_000, two.escrow.reserve - joined.feeSatoshis, 3_000]);
  const signed = completeMatchedCapture(joined, key(800), attest(joined, two.keys.slice(1)));
  assert.equal(signed.feeSatoshis, two.escrow.winBase + 2 * two.escrow.winPerInput);
  // The escrow script itself refuses a correctly signed victory that keeps one satoshi more of the reserve than its measured fee.
  const skim = planMatchedCapture(two.chests, two.funding);
  skim.transaction.outputs[1].valueSatoshis -= 1n;
  redigest(skim);
  assert.ok(refused(completeMatchedCapture(skim, key(800), attest(skim, two.keys.slice(1)), { unchecked: true }).rawHex, skim.sourceOutputs), 'the unused reserve must return to the attacker');
  assert.ok(chestInputBytes(two.chest) > 500);
});

test('a defender victory pays the whole stake to the defender; a void raid returns it; neither works without the panel', () => {
  for (const count of [1, 3]) {
    const { escrow, funding, keys } = setup(count);
    const panel = escrow.panel.keys;
    const sign = (plan, list) => Object.fromEntries(list.map(item => [item, signRaidDigest(plan.digest, secretOf(item))]));
    const two = count === 1 ? panel : keys.slice(0, 2);
    const lost = planRaidSpend(funding, { lane: 'defender-wins', eventScript: '6a' + '28' + '00'.repeat(40) });
    assert.deepEqual(lost.outputs.slice(0, 2).map(item => [item.script, item.satoshis]), [[defender.script, 10_000], [attacker.script, escrow.reserve - escrow.settleFee]]);
    const paid = completeRaidSpend(lost, sign(lost, two));
    assert.equal(paid.feeSatoshis, escrow.settleFee);
    assert.ok(paid.bytes <= escrow.settleFee);
    const back = planRaidSpend(funding, { lane: 'void' });
    assert.deepEqual(back.outputs.map(item => [item.script, item.satoshis]), [[attacker.script, 10_000 + escrow.reserve - escrow.settleFee]]);
    assert.ok(completeRaidSpend(back, sign(back, two)).txid);
    assert.throws(() => completeRaidSpend(lost, sign(lost, two.slice(0, 1))), /attestor signature is missing/);
    // A signature for the void lane does not open the defender lane, and the defender's payment cannot be redirected.
    assert.ok(refused(completeRaidSpend(lost, sign(back, two), { unchecked: true }).rawHex, lost.sourceOutputs));
    const redirected = planRaidSpend(funding, { lane: 'defender-wins' });
    redirected.transaction.outputs[0].lockingBytecode = Uint8Array.from(Buffer.from(stranger.script, 'hex'));
    redigest(redirected);
    assert.ok(refused(completeRaidSpend(redirected, sign(redirected, two), { unchecked: true }).rawHex, redirected.sourceOutputs), 'signed by the whole panel, and still only the defender can be paid');
    const short = planRaidSpend(funding, { lane: 'defender-wins' });
    short.transaction.outputs[0].valueSatoshis -= 1n;
    redigest(short);
    assert.ok(refused(completeRaidSpend(short, sign(short, two), { unchecked: true }).rawHex, short.sourceOutputs), 'the defender receives the whole stake or nothing moves');
    // The attacker's own refund works only from the refund time on.
    const refund = signRaidRefund(funding, key(802), { unchecked: true });
    const { transaction } = readTransaction(refund.rawHex);
    assert.equal(vm.verify({ transaction, sourceOutputs: lost.sourceOutputs }), true);
    transaction.locktime = 1_700_000_000;
    assert.notEqual(vm.verify({ transaction, sourceOutputs: lost.sourceOutputs }), true);
  }
});

test('the attacker cannot take the escrow back by matching it with the attacker\'s own money', () => {
  const { escrow, funding } = setup(3);
  // Lane 3 with no panel signature at all: output 0 pays the attacker 2 x S from a second, attacker-owned input.
  const plan = planRaidSpend(funding, { lane: 'void' });
  const transaction = structuredClone(plan.transaction);
  transaction.inputs.push({ ...transaction.inputs[0], outpointIndex: 5 });
  transaction.outputs = [{ lockingBytecode: Uint8Array.from(Buffer.from(attacker.script, 'hex')), valueSatoshis: 20_000n }];
  const unlocking = Buffer.concat([Buffer.from([0, 0, 0, 0x53]), Buffer.from([0x4d, escrow.redeemScript.length / 2 & 255, escrow.redeemScript.length / 2 >> 8]), Buffer.from(escrow.redeemScript, 'hex')]);
  transaction.inputs[0].unlockingBytecode = Uint8Array.from(unlocking);
  const sourceOutputs = [...plan.sourceOutputs, { lockingBytecode: Uint8Array.from(Buffer.from(attacker.script, 'hex')), valueSatoshis: 10_000n }];
  assert.notEqual(vm.verify({ transaction, sourceOutputs }), true);
});

test('revision 4 War Chest: the game key pays only the owner, the owner exits in two steps, and a capture follows into the exit', () => {
  const { chest, chests, funding, keys, escrow } = setup(1, { chest: [18_000, 7_000] });
  // Withdrawal: output 0 is the owner's wallet, output 1 the remainder in the same chest.
  const plan = planKingdomWithdrawal(chests, { satoshis: 5_000 });
  // The remainder stays on the 1,000-satoshi grid of War Chest outputs; the odd satoshis are paid out with the withdrawal.
  assert.deepEqual(plan.outputs.map(item => [item.script, item.satoshis]), [[defender.script, 25_000 - 18_000 - plan.feeSatoshis], [chest.script, 18_000]]);
  assert.ok(plan.paid >= 5_000 && plan.paid < 6_000);
  const paid = signKingdomWithdrawal(plan, key(800));
  assert.ok(paid.txid && paid.feeSatoshis <= chest.maxFee);
  // The game key cannot send the withdrawal anywhere else, nor keep more than the fee cap.
  const elsewhere = readTransaction(signKingdomWithdrawal(plan, key(800), { unchecked: true }).rawHex).transaction;
  elsewhere.outputs[0].lockingBytecode = Uint8Array.from(Buffer.from(stranger.script, 'hex'));
  assert.notEqual(vm.verify({ transaction: elsewhere, sourceOutputs: plan.sourceOutputs }), true);
  const skim = readTransaction(signKingdomWithdrawal(plan, key(800), { unchecked: true }).rawHex).transaction;
  skim.outputs[1].valueSatoshis -= BigInt(chest.maxFee);
  assert.notEqual(vm.verify({ transaction: skim, sourceOutputs: plan.sourceOutputs }), true);
  // A young output cannot be released: the input must be `releaseAge` blocks old.
  const young = readTransaction(signKingdomWithdrawal(plan, key(800), { unchecked: true }).rawHex).transaction;
  young.inputs.forEach(item => { item.sequenceNumber = 10; });
  assert.notEqual(vm.verify({ transaction: young, sourceOutputs: plan.sourceOutputs }), true);
  // Exit: the owner's key alone moves both outputs, at their full value, into one output of the exit script. The fee comes from the owner's wallet.
  const purse = { txid: '99'.repeat(32), vout: 3, satoshis: 2_000 };
  assert.throws(() => signChestExit(chests, key(801)), /pay its network fee/);
  const exit = signChestExit(chests, key(801), { fee: purse });
  assert.equal(exit.exits.length, 1);
  assert.deepEqual([exit.exits[0].script, exit.exits[0].satoshis], [chest.exitScript, 25_000], 'an exit can neither shrink nor split the chest');
  const exitSources = [...plan.sourceOutputs, { lockingBytecode: Uint8Array.from(Buffer.from(defender.script, 'hex')), valueSatoshis: 2_000n }];
  for (const outputs of [[{ script: defender.script, satoshis: 24_000 }], [{ script: chest.exitScript, satoshis: 24_999 }],
    [{ script: chest.exitScript, satoshis: 13_000 }, { script: chest.script, satoshis: 12_000 }]]) {
    assert.throws(() => signChestExit(chests, key(801), { fee: purse, outputs }), /rejected/, 'any other destination, a smaller amount or a split is refused');
  }
  assert.ok(refused(signChestExit(chests, key(800), { fee: purse, unchecked: true }).rawHex, exitSources), 'the game key cannot start an exit');
  // The exit output can still be captured for a raid that was owed, and its owner can spend it only after the delay.
  const exiting = [{ txid: exit.txid, vout: 0, satoshis: exit.exits[0].satoshis, script: exit.exits[0].script, kv: exit.exits[0].kv }];
  const capture = planMatchedCapture(exiting, funding);
  assert.equal(capture.outputs[2].script, chest.exitScript, 'the remainder stays in the exit script');
  assert.equal(completeMatchedCapture(capture, key(800), attest(capture, keys)).feeSatoshis, escrow.winBase + escrow.winPerInput);
  // An output still in the live chest and one already in the exit script are captured together; the remainder stays where the last one was.
  const mixed = planMatchedCapture([{ ...exiting[0], satoshis: 6_000 }, chests[0]], funding);
  assert.deepEqual(mixed.outputs.slice(2).map(item => [item.script, item.satoshis]), [[chest.script, 14_000]]);
  assert.ok(completeMatchedCapture(mixed, key(800), attest(mixed, keys)).txid);
  const out = [{ script: defender.script, satoshis: exiting[0].satoshis - 700 }];
  const recovered = signKingdomRecovery(exiting, key(801), out);
  const early = readTransaction(recovered.rawHex).transaction;
  assert.equal(early.inputs[0].sequenceNumber, chest.exitDelay);
  early.inputs[0].sequenceNumber = chest.exitDelay - 1;
  assert.notEqual(vm.verify({ transaction: early, sourceOutputs: [{ lockingBytecode: Uint8Array.from(Buffer.from(chest.exitScript, 'hex')), valueSatoshis: BigInt(exiting[0].satoshis) }] }), true);
  assert.throws(() => signKingdomRecovery(chests, key(801), out), /Start the exit first/);
});
