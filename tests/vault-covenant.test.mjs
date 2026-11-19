import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createVirtualMachineBCH, encodeDataPush, encodeTransaction, generateSigningSerializationBCH, secp256k1 } from '@bitauth/libauth';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { fromHex, hash256, hex, readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';
import { planVaultWithdrawal, signVaultRecovery, signVaultWithdrawal, VAULT_COVENANT, vaultCovenant } from '../packages/chain-observer/vault-covenant.mjs';

const initialTime = Date.UTC(2026,10,19);
const DAY = 86_400_000;
const key = number => number.toString(16).padStart(64, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const operatorKey = key(600);
const ownerKey = key(601);
const operator = walletFromPrivateKey(operatorKey);
const owner = walletFromPrivateKey(ownerKey);
const stranger = walletFromPrivateKey(key(602));
const vm = createVirtualMachineBCH();
const descriptor = { id:'5a'.repeat(16), operatorKey:operator.publicKey, ownerKey:owner.publicKey, recoverAt:1_800_000_000 };
const vault = vaultCovenant(descriptor);
const funded = (satoshis = 20_000) => ({ txid:'e1'.repeat(32), vout:0, script:vault.script, satoshis });

// Signs any outputs on either lane, so a rule can be broken by a transaction whose signature is still valid.
function spend({ signer, operatorLane, outputs, satoshis = 20_000, locktime = 0, extraInput = false }) {
  const transaction = { version:2, locktime, inputs:[{ outpointTransactionHash:fromHex('e1'.repeat(32)), outpointIndex:0,
    sequenceNumber:locktime ? 0xfffffffe : 0xffffffff, unlockingBytecode:new Uint8Array() },
    ...(extraInput ? [{ outpointTransactionHash:fromHex('e2'.repeat(32)), outpointIndex:0, sequenceNumber:0xffffffff, unlockingBytecode:new Uint8Array() }] : [])],
    outputs:outputs.map(([script, value]) => ({ lockingBytecode:fromHex(script), valueSatoshis:BigInt(value) })) };
  const sourceOutputs = [{ lockingBytecode:fromHex(vault.script), valueSatoshis:BigInt(satoshis) },
    ...(extraInput ? [{ lockingBytecode:fromHex(stranger.script), valueSatoshis:5_000n }] : [])];
  const type = Uint8Array.of(0x61);
  const digest = hash256(generateSigningSerializationBCH({ inputIndex:0, transaction, sourceOutputs }, { coveredBytecode:fromHex(vault.redeemScript), signingSerializationType:type }));
  transaction.inputs[0].unlockingBytecode = Buffer.concat([encodeDataPush(Buffer.concat([secp256k1.signMessageHashSchnorr(fromHex(signer), digest), type])),
    Uint8Array.of(operatorLane ? 0x51 : 0x00), encodeDataPush(fromHex(vault.redeemScript))]);
  if (extraInput) {
    const second = hash256(generateSigningSerializationBCH({ inputIndex:1, transaction, sourceOutputs }, { coveredBytecode:fromHex(stranger.script), signingSerializationType:type }));
    transaction.inputs[1].unlockingBytecode = Buffer.concat([encodeDataPush(Buffer.concat([secp256k1.signMessageHashSchnorr(fromHex(key(602)), second), type])),
      encodeDataPush(fromHex(stranger.publicKey))]);
  }
  return vm.verify({ transaction:readTransaction(hex(encodeTransaction(transaction))).transaction, sourceOutputs });
}

test('the operator lane of a vault can pay only its owner, with change back to the same vault', () => {
  assert.match(vault.script, /^aa20[0-9a-f]{64}87$/);
  const partial = planVaultWithdrawal(descriptor, funded(), { satoshis:5_000, eventScript:'6a0456425254' });
  const signed = signVaultWithdrawal(partial, operatorKey);
  const { transaction } = readTransaction(signed.rawHex);
  assert.deepEqual(transaction.outputs[0].lockingBytecode, fromHex(owner.script));
  assert.equal(transaction.outputs[0].valueSatoshis, 5_000n);
  assert.deepEqual(transaction.outputs[1].lockingBytecode, fromHex(vault.script));
  assert.equal(Number(transaction.outputs[1].valueSatoshis), 20_000 - 5_000 - signed.feeSatoshis);
  assert.ok(signed.feeSatoshis <= vault.maxFee);
  assert.throws(() => signVaultWithdrawal(partial, ownerKey), /not the vault operator/);
  // Controls built with the free-form signer.
  assert.equal(spend({ signer:operatorKey, operatorLane:true, outputs:[[owner.script, 5_000], [vault.script, 14_500]] }), true);
  assert.equal(spend({ signer:operatorKey, operatorLane:true, outputs:[[owner.script, 19_500]] }), true);
  // The operator cannot pay itself or a stranger, in the first output or as "change".
  assert.notEqual(spend({ signer:operatorKey, operatorLane:true, outputs:[[operator.script, 19_500]] }), true);
  assert.notEqual(spend({ signer:operatorKey, operatorLane:true, outputs:[[owner.script, 546], [operator.script, 18_900]] }), true);
  assert.notEqual(spend({ signer:operatorKey, operatorLane:true, outputs:[[owner.script, 546], [vault.script, 10_000], [operator.script, 8_900]] }), true);
  assert.notEqual(spend({ signer:operatorKey, operatorLane:true, outputs:[[owner.script, 546], [vault.script, 10_000], ['6a00', 0], [operator.script, 8_900]] }), true);
  // It cannot burn the deposit as a miner fee beyond the cap.
  assert.notEqual(spend({ signer:operatorKey, operatorLane:true, outputs:[[owner.script, 20_000 - vault.maxFee - 1]] }), true);
  assert.equal(spend({ signer:operatorKey, operatorLane:true, outputs:[[owner.script, 20_000 - vault.maxFee]] }), true);
  // It cannot add an input to dress up a short payment.
  assert.notEqual(spend({ signer:operatorKey, operatorLane:true, extraInput:true, outputs:[[owner.script, 19_500], [stranger.script, 4_000]] }), true);
  // The owner and a stranger cannot use the operator lane.
  assert.notEqual(spend({ signer:ownerKey, operatorLane:true, outputs:[[owner.script, 19_500]] }), true);
  assert.notEqual(spend({ signer:key(602), operatorLane:true, outputs:[[stranger.script, 19_500]] }), true);
});

test('after the recovery time the owner key alone spends the vault anywhere, and nobody else can', () => {
  const recovery = signVaultRecovery(descriptor, funded(), ownerKey, [{ script:stranger.script, satoshis:19_400 }]);
  const { transaction } = readTransaction(recovery.rawHex);
  assert.equal(transaction.locktime, descriptor.recoverAt);
  assert.equal(vm.verify({ transaction, sourceOutputs:[{ lockingBytecode:fromHex(vault.script), valueSatoshis:20_000n }] }), true);
  assert.throws(() => signVaultRecovery(descriptor, funded(), operatorKey, [{ script:operator.script, satoshis:19_400 }]), /not the vault owner/);
  assert.equal(spend({ signer:ownerKey, operatorLane:false, locktime:descriptor.recoverAt, outputs:[[stranger.script, 19_400]] }), true);
  assert.notEqual(spend({ signer:ownerKey, operatorLane:false, locktime:descriptor.recoverAt - 1, outputs:[[owner.script, 19_400]] }), true);
  assert.notEqual(spend({ signer:ownerKey, operatorLane:false, locktime:0, outputs:[[owner.script, 19_400]] }), true);
  assert.notEqual(spend({ signer:operatorKey, operatorLane:false, locktime:descriptor.recoverAt, outputs:[[operator.script, 19_400]] }), true);
  assert.notEqual(spend({ signer:key(602), operatorLane:false, locktime:descriptor.recoverAt, outputs:[[stranger.script, 19_400]] }), true);
  assert.throws(() => vaultCovenant({ ...descriptor, ownerKey:operator.publicKey }), /different keys/);
});

async function fixture(t) {
  let now = initialTime;
  let sequence = 0;
  const transactions = new Map();
  const spent = new Set();
  const network = { reject:false };
  const buyerKey = key(603);
  const buyer = walletFromPrivateKey(buyerKey);
  const assets = { enabled:false, list:() => [], authority:() => null, close:() => {} };
  const touches = (item, script) => item.transaction.outputs.some(output => hex(output.lockingBytecode) === script) ||
    item.transaction.inputs.some(input => {
      const output = transactions.get(hex(input.outpointTransactionHash))?.transaction.outputs[input.outpointIndex];
      return output && hex(output.lockingBytecode) === script;
    });
  function accept(raw) {
    const decoded = readTransaction(raw);
    const points = decoded.transaction.inputs.map(input => hex(input.outpointTransactionHash) + ':' + input.outpointIndex);
    if (!transactions.has(decoded.txid) && points.some(point => spent.has(point))) throw new Error('txn-mempool-conflict');
    const sourceOutputs = decoded.transaction.inputs.map(input => transactions.get(hex(input.outpointTransactionHash))?.transaction.outputs[input.outpointIndex]);
    if (sourceOutputs.every(Boolean)) {
      const verdict = vm.verify({ transaction:decoded.transaction, sourceOutputs });
      if (verdict !== true) throw new Error('mandatory-script-verify-flag-failed: ' + verdict);
    }
    for (const point of points) spent.add(point);
    transactions.set(decoded.txid, transactions.get(decoded.txid) ?? { ...decoded, rawHex:raw, confirmations:0, height:0 });
    return decoded.txid;
  }
  const chain = createChain({ treasuryPrivateKey:operatorKey, transport:{ withClient:run => run({
    history:async script => [...transactions.values()].filter(item => touches(item, script)).map(item => ({ txid:item.txid, height:item.height })),
    raw:async txid => transactions.get(txid)?.rawHex ?? null,
    lookup:async txid => transactions.get(txid),
    broadcast:async raw => { if (network.reject) throw new Error('min relay fee not met'); return accept(raw); } }) } });
  const app = createApp({ database:':memory:', localDemo:true, clock:() => now, chain, territoryAssets:assets, politicalAssets:assets, personalVault:'open' });
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  t.after(async () => { const closed=once(app.server,'close'); app.close(); await closed; });
  function pay(quote) {
    const outputs = app.store.payment(quote.id).outputs.map(({ script, satoshis }) => ({ script, satoshis }));
    const signed = signSpend({ privateKey:buyerKey, sources:[{ txid:hash('vault-' + (++sequence)), vout:0, script:buyer.script, satoshis:300_000 }],
      outputs:[...outputs, { script:buyer.script, satoshis:300_000 - quote.satoshis - 400 }] });
    const observed = { ...readTransaction(signed.rawHex), rawHex:signed.rawHex, confirmations:2, height:392_000, blockHash:hash('block'), blockTime:now };
    transactions.set(observed.txid, observed);
    return observed.txid;
  }
  const confirmAll = () => { for (const item of transactions.values()) if (!item.confirmations) { item.confirmations = 2; item.height = 392_001; } };
  app.store.addSession(hash('seat-p1'), 'p1', initialTime + 365 * DAY);
  return { app, network, transactions, pay, confirmAll, accept, advance:ms => { now += ms; },
    bind:() => app.store.bindWallet('p1', owner.address, owner.publicKey, now) };
}
const deposit = satoshis => ({ type:'vault-deposit', satoshis, consent:true });

test('a deposit needs a verified wallet, is locked to its covenant, and withdraws only to that wallet', async t => {
  const { app, transactions, pay, confirmAll, bind } = await fixture(t);
  assert.throws(() => app.ledger.create('p1', deposit(20_000)), /Connect your wallet first/);
  bind();
  const quote = app.ledger.create('p1', deposit(20_000));
  const saved = app.store.payment(quote.id);
  assert.equal(quote.vault.version, VAULT_COVENANT);
  assert.equal(quote.vault.ownerAddress, owner.address);
  assert.equal(quote.vault.recoverAt, Math.floor(initialTime / 1000) + 7 * 86_400);
  assert.equal(saved.script, vaultCovenant({ id:saved.id, operatorKey:operator.publicKey, ownerKey:owner.publicKey, recoverAt:quote.vault.recoverAt }).script);
  assert.deepEqual(saved.event.data.vault, { version:VAULT_COVENANT, script:saved.script, owner:owner.address, recoverAt:quote.vault.recoverAt });
  await app.ledger.submit('p1', quote.id, pay(quote));
  assert.equal(app.ledger.balances('p1').depositedSatoshis, 20_000);
  await assert.rejects(app.ledger.payout('p1', { kind:'withdraw', satoshis:5_000, address:stranger.address, consent:true }), /can only return to the wallet/);
  const payout = await app.ledger.payout('p1', { kind:'withdraw', satoshis:5_000, address:owner.address, consent:true });
  const sent = transactions.get(payout.txid);
  assert.ok(sent, 'the withdrawal passed the BCH VM in the fixture node');
  assert.deepEqual(sent.transaction.outputs[0].lockingBytecode, fromHex(owner.script));
  assert.equal(sent.transaction.outputs[0].valueSatoshis, 5_000n);
  assert.deepEqual(sent.transaction.outputs[1].lockingBytecode, fromHex(saved.script));
  confirmAll();
  await app.ledger.reconcile();
  const left = 20_000 - 5_000 - payout.feeSatoshis;
  assert.equal(app.ledger.balances('p1').depositedSatoshis, left);
  // The change is a vault output again and withdraws the same way.
  const second = await app.ledger.payout('p1', { kind:'withdraw', satoshis:3_000, address:owner.address, consent:true });
  assert.deepEqual(transactions.get(second.txid).transaction.outputs[1].lockingBytecode, fromHex(saved.script));
  confirmAll();
  await app.ledger.reconcile();
  assert.equal(app.ledger.balances('p1').depositedSatoshis, left - 3_000 - second.feeSatoshis);
});

test('an owner who recovers a deposit alone is followed on chain and the balance drops', async t => {
  const { app, pay, accept, confirmAll, advance, bind } = await fixture(t);
  bind();
  const quote = app.ledger.create('p1', deposit(12_000));
  const txid = pay(quote);
  await app.ledger.submit('p1', quote.id, txid);
  const { vault: terms } = app.store.payment(quote.id);
  await app.ledger.reconcile();
  assert.equal(app.ledger.balances('p1').depositedSatoshis, 12_000);
  advance(8 * DAY);
  const recovery = signVaultRecovery(terms, { txid, vout:0, script:terms.script, satoshis:12_000 }, ownerKey, [{ script:stranger.script, satoshis:11_500 }]);
  accept(recovery.rawHex);
  await app.ledger.reconcile();
  assert.equal(app.ledger.balances('p1').depositedSatoshis, 12_000, 'an unconfirmed recovery changes nothing');
  confirmAll();
  await app.ledger.reconcile();
  assert.equal(app.ledger.balances('p1').depositedSatoshis, 0);
  const row = app.store.payments('p1').find(item => item.action === 'vault-recovery');
  assert.equal(row.txid, recovery.txid);
  await assert.rejects(app.ledger.payout('p1', { kind:'withdraw', satoshis:5_000, address:owner.address, consent:true }), /do not cover|no eligible/i);
});

test('a rejected vault withdrawal is replaced by a full payout to the owner', async t => {
  const { app, network, transactions, pay, confirmAll, bind } = await fixture(t);
  bind();
  const quote = app.ledger.create('p1', deposit(15_000));
  await app.ledger.submit('p1', quote.id, pay(quote));
  network.reject = true;
  const payout = await app.ledger.payout('p1', { kind:'withdraw', satoshis:4_000, address:owner.address, consent:true });
  await app.ledger.reconcile();
  assert.match(app.store.payment(payout.id).broadcastError, /relay fee/);
  network.reject = false;
  const replacement = await app.ledger.voidPayout({ id:payout.id, consent:true });
  const sent = transactions.get(replacement.txid);
  assert.equal(sent.transaction.outputs.filter(output => output.valueSatoshis > 0n).length, 1);
  assert.deepEqual(sent.transaction.outputs[0].lockingBytecode, fromHex(owner.script));
  assert.equal(Number(sent.transaction.outputs[0].valueSatoshis), 15_000 - replacement.feeSatoshis);
  confirmAll();
  await app.ledger.reconcile();
  await app.ledger.reconcile();
  assert.equal(app.store.payment(payout.id).state, 'voided');
  assert.equal(app.ledger.balances('p1').depositedSatoshis, 0);
});
