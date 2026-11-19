import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVirtualMachineBCH, secp256k1 } from '@bitauth/libauth';
import { fromHex, hex, readTransaction, walletFromPrivateKey } from './primitives.mjs';
import { compileTreasuryCovenant, completeTreasurySpend, planTreasurySpend, treasurySigningHash } from './treasury-covenants.mjs';
import { chipnetTreasuryConfig } from '../../config/treasury.mjs';
import { planVerifiedBattleSettlement } from '../../apps/game-server/treasury-attestation.mjs';
import { digest, simulateBattle } from '../game-engine/combat.mjs';

const secrets = [147, 153, 191, 201, 219].map(value => value.toString(16).padStart(64, '0'));
const [owner, opponent, judge, auditor, outsider] = secrets.map(walletFromPrivateKey);
const base = { id:'1234'.repeat(8), principal:10_000, refundAt:1_800_000_000, ownerKey:owner.publicKey,
  opponent:opponent.address, attestors:[judge.publicKey, auditor.publicKey] };
const interpreter = createVirtualMachineBCH();
const funding = (contract, satoshis = contract.satoshis) => ({ txid:'a3'.repeat(32), vout:1, script:contract.script, satoshis });
function sign(plan, wallet, der = false) {
  const key = secrets.find(value => walletFromPrivateKey(value).publicKey === wallet.publicKey);
  const digest = treasurySigningHash(plan);
  return hex(der ? secp256k1.signMessageHashDER(fromHex(key), digest) : secp256k1.signMessageHashSchnorr(fromHex(key), digest));
}

function verifySpend(plan, signatures = []) {
  const result = completeTreasurySpend(plan, signatures);
  const transaction = readTransaction(result.rawHex).transaction;
  assert.equal(interpreter.verify({ transaction, sourceOutputs:plan.sourceOutputs }), true);
  const paid = transaction.outputs.reduce((sum, item) => sum + item.valueSatoshis, 0n);
  assert.equal(result.feeSatoshis, Number(plan.sourceOutputs[0].valueSatoshis - paid));
  return transaction;
}

test('battle, kingdom, and territory commitments enforce two attestations, exact outputs, and owner recovery', () => {
  const addresses = new Set();
  for (const kind of ['battle-escrow','kingdom-treasury','territory-escrow']) {
    const descriptor = { ...base, kind };
    const contract = compileTreasuryCovenant(descriptor);
    addresses.add(contract.address);
    const source = funding(contract);
    const victory = planTreasurySpend(descriptor, source, { lane:'opponent-wins' });
    const signatures = [sign(victory, judge), sign(victory, auditor)];
    const outcome = verifySpend(victory, signatures);
    assert.equal(hex(outcome.outputs[0].lockingBytecode), owner.script);
    assert.equal(hex(outcome.outputs[1].lockingBytecode), opponent.script);
    assert.equal(outcome.outputs[1].valueSatoshis, kind === 'kingdom-treasury' ? 2_000n : 5_000n);
    assert.throws(() => completeTreasurySpend(victory, [signatures[0], sign(victory, outsider)]), /covenant rejected/);
    assert.throws(() => completeTreasurySpend(victory, [signatures[0]]), /number of signatures/);
    const returnPlan = planTreasurySpend(descriptor, source, { lane:'return' });
    assert.throws(() => completeTreasurySpend(returnPlan, signatures), /covenant rejected/);
    verifySpend(returnPlan, [sign(returnPlan, judge), sign(returnPlan, auditor)]);
    const bad = structuredClone(victory);
    bad.transaction.outputs[1].lockingBytecode = fromHex(outsider.script);
    assert.throws(() => completeTreasurySpend(bad, [sign(bad, judge), sign(bad, auditor)]), /covenant rejected/);
    bad.transaction.outputs[1].lockingBytecode = fromHex(opponent.script);
    bad.transaction.outputs[1].valueSatoshis += 1n;
    bad.transaction.outputs[0].valueSatoshis -= 1n;
    assert.throws(() => completeTreasurySpend(bad, [sign(bad, judge), sign(bad, auditor)]), /covenant rejected/);
    const wrongSource = funding(contract, contract.satoshis + 120);
    assert.throws(() => planTreasurySpend(descriptor, wrongSource, { lane:'return' }), /timed recovery/);
    const refund = planTreasurySpend(descriptor, wrongSource, { lane:'refund' });
    assert.equal(verifySpend(refund, [sign(refund, owner)]).outputs[0].valueSatoshis, 10_120n);
    assert.throws(() => completeTreasurySpend(refund, [sign(refund, judge)]), /covenant rejected/);
    const early = planTreasurySpend(descriptor, source, { lane:'refund', locktime:base.refundAt-1 });
    assert.throws(() => completeTreasurySpend(early, [sign(early, owner)]), /covenant rejected/);
  }
  assert.equal(addresses.size, 3);
});

test('single claimant return and funded prize claims can be relayed without keys', () => {
  const territory = { ...base, kind:'territory-uncontested', closesAt:base.refundAt-3600 };
  const landFunds = funding(compileTreasuryCovenant(territory));
  const early = planTreasurySpend(territory, landFunds, { lane:'return', locktime:territory.closesAt-1 });
  assert.throws(() => completeTreasurySpend(early), /covenant rejected/);
  const landReturn = verifySpend(planTreasurySpend(territory, landFunds, { lane:'return' }));
  assert.equal(hex(landReturn.outputs[0].lockingBytecode), owner.script);
  const prize = { id:base.id, kind:'season-prize', principal:14_000, recipient:owner.address, rollover:opponent.address, refundAt:base.refundAt };
  const source = funding(compileTreasuryCovenant(prize));
  const claim = planTreasurySpend(prize, source, { lane:'claim' });
  assert.equal(hex(verifySpend(claim).outputs[0].lockingBytecode), owner.script);
  const invalid = structuredClone(claim);
  invalid.transaction.outputs.push({ lockingBytecode:fromHex(outsider.script), valueSatoshis:546n });
  assert.throws(() => completeTreasurySpend(invalid), /covenant rejected/);
  const rollover = planTreasurySpend(prize, source, { lane:'refund' });
  const rolloverTransaction = verifySpend(rollover);
  assert.equal(hex(rolloverTransaction.outputs[0].lockingBytecode), opponent.script);
  assert.equal(hex(claim.transaction.inputs[0].outpointTransactionHash), hex(rollover.transaction.inputs[0].outpointTransactionHash));
  assert.equal(claim.transaction.inputs[0].outpointIndex, rollover.transaction.inputs[0].outpointIndex);
  assert.throws(() => completeTreasurySpend(planTreasurySpend(prize, source, { lane:'refund', locktime:base.refundAt-1 })), /covenant rejected/);
  const coins = new Map([[source.txid + ':' + source.vout, claim.sourceOutputs[0]]]);
  const apply = transaction => {
    const key = hex(transaction.inputs[0].outpointTransactionHash) + ':' + transaction.inputs[0].outpointIndex;
    const coin = coins.get(key);
    if (!coin || interpreter.verify({ transaction, sourceOutputs:[coin] }) !== true) return false;
    return coins.delete(key);
  };
  assert.equal(apply(verifySpend(claim)), true);
  assert.equal(apply(rolloverTransaction), false);
});

test('Development spends require two of three independent keys', () => {
  const wallets = [owner, judge, auditor].sort((a,b) => a.publicKey.localeCompare(b.publicKey));
  const descriptor = { id:base.id, kind:'development', keys:wallets.map(wallet => wallet.publicKey) };
  const contract = compileTreasuryCovenant(descriptor);
  assert.equal(contract.address, compileTreasuryCovenant({ ...descriptor, keys:[...descriptor.keys].reverse() }).address);
  const plan = planTreasurySpend(descriptor, funding(contract, 100_000), { outputs:[{ address:opponent.address, satoshis:99_000 }] });
  verifySpend(plan, [sign(plan, wallets[0], true), sign(plan, wallets[2], true)]);
  assert.throws(() => completeTreasurySpend(plan, [sign(plan, wallets[0], true), sign(plan, outsider, true)]), /covenant rejected/);
  assert.throws(() => compileTreasuryCovenant({ ...descriptor, keys:Array(3).fill(owner.publicKey) }), /distinct/);
  assert.throws(() => compileTreasuryCovenant({ ...descriptor, network:'mainnet' }), /Chipnet/);
  assert.throws(() => planTreasurySpend(descriptor, funding(contract, 100_000), { outputs:[{ address:opponent.address, satoshis:1 }] }), /range/);
  assert.throws(() => compileTreasuryCovenant({ ...base, kind:'battle-escrow', principal:547 }), /range/);
  const env = { CHIPNET_DEVELOPMENT_COUNCIL_KEYS:descriptor.keys.join(','), CHIPNET_DEVELOPMENT_COVENANT_ID:descriptor.id };
  assert.equal(chipnetTreasuryConfig(env).developmentAddress, contract.address);
  assert.throws(() => chipnetTreasuryConfig({ ...env, CHIPNET_DEVELOPMENT_ADDRESS:owner.address }), /Choose/);
});

test('the attestor plan selects the reproducible raid outcome for the exact admitted funding outpoint', () => {
  const covenant = { ...base, kind:'battle-escrow' };
  const source = funding(compileTreasuryCovenant(covenant));
  const seed = '0123'.repeat(16);
  const side = troops => ({ troops, hero:'warden', tactic:'balanced', formation:'line', tech:{ tactics:0 }, wall:0 });
  const input = { terrain:'plains', attacker:side({infantry:34,archer:20}), defender:side({infantry:30,archer:18}) };
  const battle = { id:'b42', kind:'raid', paid:true, attacker:'p1', defender:'p2', input, seed,
    commitment:digest({ input, seed }), ...simulateBattle(input, seed) };
  const admission = { covenantId:covenant.id, fundingTxid:source.txid, fundingVout:source.vout,
    ownerAddress:owner.address, opponentAddress:opponent.address, ownerCity:'p1', opponentCity:'p2',
    battleId:battle.id, battleHash:battle.hash };
  const plan = planVerifiedBattleSettlement({ covenant, funding:source, admission, battle });
  assert.equal(plan.lane, battle.winner === 'attacker' ? 'return' : 'opponent-wins');
  verifySpend(plan, [sign(plan, judge), sign(plan, auditor)]);
  assert.throws(() => planVerifiedBattleSettlement({ covenant, funding:source, admission,
    battle:{ ...battle, winner:battle.winner === 'attacker' ? 'defender' : 'attacker' } }), /fails verification/);
  assert.throws(() => planVerifiedBattleSettlement({ covenant, funding:{ ...source, vout:2 }, admission, battle }), /funding outpoint/);
});

// Version 2 templates: every amount that can be paid in can also be recovered.
import { sponsorSigningHash } from './treasury-covenants.mjs';
const sponsorSecret = (233).toString(16).padStart(64, '0');
const sponsorWallet = walletFromPrivateKey(sponsorSecret);
const schnorr = (secret, digest) => hex(secp256k1.signMessageHashSchnorr(fromHex(secret), digest));
const runPlan = (plan, signatures, sponsorSignature) => {
  const result = completeTreasurySpend(plan, signatures, sponsorSignature);
  const transaction = readTransaction(result.rawHex).transaction;
  assert.equal(interpreter.verify({ transaction, sourceOutputs:plan.sourceOutputs }), true);
  return { ...result, transaction };
};

test('version 2 keeps exact settlements and recovers under- and overfunded outputs', () => {
  for (const kind of ['battle-escrow','kingdom-treasury','territory-escrow']) {
    const descriptor = { ...base, kind, version:2, reserve:800 };
    const contract = compileTreasuryCovenant(descriptor);
    assert.notEqual(contract.address, compileTreasuryCovenant({ ...base, kind, reserve:800 }).address);
    const victory = planTreasurySpend(descriptor, funding(contract), { lane:'opponent-wins' });
    runPlan(victory, [sign(victory, judge), sign(victory, auditor)]);
    assert.throws(() => planTreasurySpend(descriptor, funding(contract, contract.satoshis + 1), { lane:'opponent-wins' }), /timed recovery/);
    for (const paid of [contract.satoshis - 1, contract.satoshis + 700, contract.recoveryFloor, 250_000]) {
      const refund = planTreasurySpend(descriptor, funding(contract, paid), { lane:'refund' });
      const { transaction, feeSatoshis } = runPlan(refund, [sign(refund, owner)]);
      assert.deepEqual(transaction.outputs[0].lockingBytecode, fromHex(owner.script));
      assert.equal(transaction.outputs[0].valueSatoshis, BigInt(paid - 800));
      assert.equal(feeSatoshis, 800);
    }
  }
});

test('the 576-satoshi underpayment that version 1 strands is recovered in full with a fee sponsor', () => {
  const legacy = { ...base, kind:'battle-escrow', principal:20_000, reserve:800 };
  const stranded = compileTreasuryCovenant(legacy);
  assert.throws(() => planTreasurySpend(legacy, funding(stranded, 576), { lane:'refund' }));
  const descriptor = { ...legacy, version:2 };
  const contract = compileTreasuryCovenant(descriptor);
  for (const paid of [546, 576, 1_000, contract.recoveryFloor - 1]) {
    assert.throws(() => planTreasurySpend(descriptor, funding(contract, paid), { lane:'refund' }), /fee sponsor/);
    const sponsor = { publicKey:sponsorWallet.publicKey, source:{ txid:'b4'.repeat(32), vout:0, script:sponsorWallet.script, satoshis:5_000 } };
    const plan = planTreasurySpend(descriptor, funding(contract, paid), { lane:'refund', sponsor });
    const { transaction } = runPlan(plan, [sign(plan, owner)], schnorr(sponsorSecret, sponsorSigningHash(plan)));
    assert.deepEqual(transaction.outputs[0].lockingBytecode, fromHex(owner.script));
    assert.ok(transaction.outputs[0].valueSatoshis >= BigInt(paid), 'the owner receives at least the stranded value');
    assert.deepEqual(transaction.outputs[1].lockingBytecode, fromHex(sponsorWallet.script));
    // A validly signed variant that pays the owner one satoshi less than was funded is refused by the covenant.
    const short = { ...plan, transaction:structuredClone(plan.transaction) };
    short.transaction.outputs[0].valueSatoshis = BigInt(Math.max(paid - 1, 546) - (paid <= 546 ? 1 : 0));
    if (short.transaction.outputs[0].valueSatoshis < BigInt(paid)) {
      assert.throws(() => completeTreasurySpend(short, [sign(short, owner)], schnorr(sponsorSecret, sponsorSigningHash(short))), /rejected/);
    }
  }
});

test('version 2 recovery still needs the timeout and the owner, and cannot be redirected by a sponsor or an attestor', () => {
  const descriptor = { ...base, kind:'battle-escrow', version:2, reserve:800 };
  const contract = compileTreasuryCovenant(descriptor);
  const source = funding(contract, 9_000);
  const early = planTreasurySpend(descriptor, source, { lane:'refund', locktime:descriptor.refundAt - 1 });
  assert.throws(() => completeTreasurySpend(early, [sign(early, owner)]), /rejected/);
  const refund = planTreasurySpend(descriptor, source, { lane:'refund' });
  for (const impostor of [judge, auditor, outsider, opponent]) {
    assert.throws(() => completeTreasurySpend(refund, [sign(refund, impostor)]), /rejected/);
  }
  const diverted = { ...refund, transaction:structuredClone(refund.transaction) };
  diverted.transaction.outputs[0].lockingBytecode = fromHex(outsider.script);
  assert.throws(() => completeTreasurySpend(diverted, [sign(diverted, owner)]), /rejected/);
  const skimmed = { ...refund, transaction:structuredClone(refund.transaction) };
  skimmed.transaction.outputs[0].valueSatoshis -= 1n;
  assert.throws(() => completeTreasurySpend(skimmed, [sign(skimmed, owner)]), /rejected/);
  // Settlement lanes stay single-input, so a second input cannot pad a wrongly funded tranche into a settlement.
  const victory = planTreasurySpend(descriptor, funding(contract), { lane:'opponent-wins' });
  const padded = { ...victory, transaction:structuredClone(victory.transaction), sourceOutputs:[...victory.sourceOutputs,
    { lockingBytecode:fromHex(sponsorWallet.script), valueSatoshis:5_000n }] };
  padded.transaction.inputs.push({ outpointTransactionHash:fromHex('c5'.repeat(32)), outpointIndex:0, sequenceNumber:0xffffffff, unlockingBytecode:new Uint8Array() });
  assert.throws(() => completeTreasurySpend(padded, [sign(padded, judge), sign(padded, auditor)]), /rejected/);
});

test('version 2 prize vouchers roll over by anyone after the deadline, including a small misfunded voucher', () => {
  const descriptor = { id:'5678'.repeat(8), kind:'season-prize', version:2, principal:6_000, reserve:800, refundAt:1_800_000_000,
    recipient:owner.address, rollover:opponent.address };
  const contract = compileTreasuryCovenant(descriptor);
  const claim = planTreasurySpend(descriptor, funding(contract), { lane:'claim' });
  assert.deepEqual(runPlan(claim, []).transaction.outputs[0].lockingBytecode, fromHex(owner.script));
  const rollover = planTreasurySpend(descriptor, funding(contract, 6_500), { lane:'refund' });
  const rolled = runPlan(rollover, []).transaction;
  assert.deepEqual(rolled.outputs[0].lockingBytecode, fromHex(opponent.script));
  assert.equal(rolled.outputs[0].valueSatoshis, 5_700n);
  const sponsor = { publicKey:sponsorWallet.publicKey, source:{ txid:'d6'.repeat(32), vout:0, script:sponsorWallet.script, satoshis:3_000 } };
  const small = planTreasurySpend(descriptor, funding(contract, 600), { lane:'refund', sponsor });
  const rescued = runPlan(small, [], schnorr(sponsorSecret, sponsorSigningHash(small))).transaction;
  assert.deepEqual(rescued.outputs[0].lockingBytecode, fromHex(opponent.script));
  assert.ok(rescued.outputs[0].valueSatoshis >= 600n);
  // Nobody can redirect a keyless rollover: the destination is fixed in the script.
  const stolen = { ...rollover, transaction:structuredClone(rollover.transaction) };
  stolen.transaction.outputs[0].lockingBytecode = fromHex(outsider.script);
  assert.throws(() => completeTreasurySpend(stolen, []), /rejected/);
});
