// Paid political operations, restored: the payer funds the fee of the operation's own proof record in an output that can
// be spent as that fee and as nothing else. Run on the enforcing fixture node.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVirtualMachineBCH, encodeTransaction } from '@bitauth/libauth';
import { covenantNode, developer, keys, operator, operatorKey, wallets } from './support/covenant-node.mjs';
import { command } from '../packages/game-engine/index.mjs';
import { hex, readTransaction } from '../packages/chain-observer/primitives.mjs';
import { RECORD_RECOVERY_BLOCKS, RECORD_RESERVE, RECORD_RESERVE_SATOSHIS, recordReserve, signRecord, signRecordRecovery } from '../packages/chain-observer/record-reserve.mjs';
import { PRICING, priceBook } from '../config/pricing.mjs';

const book = priceBook(PRICING);

test('a paid treaty charter is sold again: exact 50/20/20/10, its proof record published from the payer\'s own record reserve', async t => {
  const { app, seat, edit, pay, settle, transactions, accept, time, refused } = await covenantNode();
  t.after(() => app.close());
  for (const id of ['p1', 'p2']) seat(id);
  let treaty;
  edit(world => {
    for (const id of ['p1', 'p2']) Object.assign(world.cities[id], { optIn:true, tutorial:true, shieldUntil:0 });
    const offer = command(world, 'p1', { type:'diplomacy-treaty-propose', target:'p2', kind:'non-aggression', durationHours:48, terms:{} }, time());
    treaty = command(world, 'p2', { type:'diplomacy-treaty-respond', id:offer.id, accept:true, termsHash:offer.proposal.termsHash, version:offer.proposal.version }, time());
  });
  assert.equal(treaty.status, 'active');
  const order = { type:'political-operation', operation:'attest', treaty:treaty.id, consent:true };
  const quote = app.ledger.create('p1', order);
  const price = book.services['political-operation'];
  assert.equal(quote.satoshis, price);
  // The price is split exactly; the two network reserves are separate amounts on top and are disclosed as such.
  assert.deepEqual(quote.outputs.map(({ role, satoshis }) => [role, satoshis]),
    [['warChest', price / 2], ['development', price / 5], ['prize', price / 5 + 300], ['record', RECORD_RESERVE_SATOSHIS], ['burn', price / 10]]);
  const stored = app.store.payment(quote.id);
  assert.deepEqual([stored.reserveSatoshis, stored.event.data.recordReserve, stored.event.data.allocation], [300 + RECORD_RESERVE_SATOSHIS, RECORD_RESERVE_SATOSHIS,
    { warChest:price / 2, prize:price / 5, development:price / 5, burn:price / 10 }]);
  assert.equal(quote.outputs.find(output => output.role === 'development').address, developer.address);
  assert.match(quote.description, /pay only for this operation's public proof record; if no record is published, your own wallet key takes it back/);
  await app.ledger.submit('p1', quote.id, pay('p1', quote));
  const paid = app.store.payment(quote.id);
  assert.deepEqual([paid.state, paid.fulfillment.status], ['credited', 'applied'], JSON.stringify(paid.fulfillment));
  const reserve = paid.receipt.allocations.find(output => output.role === 'record');
  assert.equal(reserve.script, recordReserve(reserve.rr).script);
  // The operation is applied, and its proof record is published without anybody's approval.
  await settle(3);
  const anchor = app.store.payments().find(row => row.politicalAnchor === 'po-' + quote.id);
  assert.equal(anchor?.state, 'credited', refused.join(' | '));
  const { transaction } = transactions.get(anchor.txid);
  assert.equal(transaction.inputs.length, 1);
  assert.deepEqual(transaction.outputs.map(output => [output.lockingBytecode[0], output.valueSatoshis]), [[0x6a, 0n]], 'one unspendable record, no value to anyone');
  assert.equal(anchor.feeSatoshis, RECORD_RESERVE_SATOSHIS);
  assert.ok(readTransaction(anchor.rawHex) && anchor.rawHex.length / 2 < 300, 'the record transaction stays well inside its 576-satoshi reserve');
  const proof = app.store.read().world.politicalEvidence.find(record => record.id === 'po-' + quote.id);
  assert.deepEqual([proof.kind, proof.treaty, proof.holder], ['treaty-charter', treaty.id, 'p1']);
  // The payer's War Chest received its half like any other service.
  assert.equal(app.ledger.balances('p1').warChestSatoshis, price / 2);
  assert.equal(app.ledger.explorer().buckets.development, 0, 'no political money is held by the game');
});

test('the record reserve can be spent as the fee of one data record and as nothing else', () => {
  const contract = recordReserve({ id:'ab'.repeat(16), operatorKey:operator.publicKey });
  const source = { txid:'cd'.repeat(32), vout:3, satoshis:RECORD_RESERVE_SATOSHIS, script:contract.script, rr:{ id:contract.id, operatorKey:contract.operatorKey } };
  const record = '6a045642524e22' + '01' + '10' + '11'.repeat(32);
  const good = signRecord(source, record, operatorKey);
  assert.equal(good.feeSatoshis, RECORD_RESERVE_SATOSHIS);
  assert.ok(good.bytes < 240);
  const sourceOutputs = [{ lockingBytecode:Uint8Array.from(Buffer.from(contract.script, 'hex')), valueSatoshis:BigInt(RECORD_RESERVE_SATOSHIS) }];
  // Signed by the game key, but paying a wallet: refused by the script. So is any second output, and any value on the record.
  const rich = { ...source, satoshis:3_000 };
  assert.throws(() => signRecord(rich, record, operatorKey, { outputs:[{ script:wallets.p1.script, satoshis:2_000 }] }), /rejected the spend/);
  assert.throws(() => signRecord(rich, record, operatorKey, { outputs:[{ script:operator.script, satoshis:2_000 }] }), /rejected the spend/);
  assert.throws(() => signRecord(rich, record, operatorKey, { outputs:[{ script:record, satoshis:0 }, { script:operator.script, satoshis:2_000 }] }), /rejected the spend/);
  assert.throws(() => signRecord(rich, record, operatorKey, { outputs:[{ script:record, satoshis:1 }] }), /rejected the spend/);
  // Nobody but the game key can spend it at all.
  assert.throws(() => signRecord(source, record, '00'.repeat(31) + '07'), /rejected the spend/);
  // The correctly signed record with a second output that carries money: refused.
  const { transaction } = readTransaction(good.rawHex);
  transaction.outputs.push({ lockingBytecode:Uint8Array.from(Buffer.from(operator.script, 'hex')), valueSatoshis:300n });
  assert.notEqual(createVirtualMachineBCH().verify({ transaction, sourceOutputs }), true);
  assert.ok(hex(encodeTransaction(transaction)).length > 0);
});

test('the reserve of a new payment is version 2: the record lane as before, and the payer alone takes an unused reserve back after its age', () => {
  const terms = { id:'ab'.repeat(16), operatorKey:operator.publicKey, ownerKey:wallets.p1.publicKey };
  const contract = recordReserve(terms);
  assert.deepEqual([contract.version, contract.recoveryAge], [RECORD_RESERVE, RECORD_RECOVERY_BLOCKS]);
  const source = { txid:'cd'.repeat(32), vout:3, satoshis:RECORD_RESERVE_SATOSHIS, script:contract.script, rr:terms };
  const record = '6a045642524e22' + '01' + '10' + '11'.repeat(32);
  // Record lane: unchanged rules.
  assert.equal(signRecord(source, record, operatorKey).feeSatoshis, RECORD_RESERVE_SATOSHIS);
  assert.throws(() => signRecord({ ...source, satoshis:3_000 }, record, operatorKey, { outputs:[{ script:operator.script, satoshis:2_000 }] }), /rejected the spend/);
  assert.throws(() => signRecord(source, record, keys.p1), /rejected the spend/, 'the payer cannot use the record lane');
  // Owner lane: the payer's key, a fee coin of the same wallet, everything back to that wallet.
  const fee = { txid:'ef'.repeat(32), vout:0, satoshis:1_500 };
  const back = signRecordRecovery(source, keys.p1, { fee });
  assert.equal(back.returnedSatoshis, RECORD_RESERVE_SATOSHIS + 1_500 - back.feeSatoshis);
  assert.ok(back.returnedSatoshis > 1_500, 'the payer ends with more than the fee coin: the reserve really returns');
  const { transaction } = readTransaction(back.rawHex);
  assert.equal(transaction.inputs[0].sequenceNumber, RECORD_RECOVERY_BLOCKS, 'the spend is only valid once the reserve is that many blocks old');
  assert.equal(hex(transaction.outputs[0].lockingBytecode), wallets.p1.script);
  // Before its age the same correctly signed spend is refused by the script; so is every other key at any time.
  assert.throws(() => signRecordRecovery(source, keys.p1, { fee, early:true }), /rejected the recovery/);
  assert.throws(() => signRecordRecovery(source, operatorKey, { fee }), /not the payer/);
  assert.throws(() => signRecordRecovery(source, keys.p2, { fee }), /not the payer/);
  // The game key signing the owner lane by hand: the script checks the payer's key.
  const forged = readTransaction(signRecordRecovery({ ...source, rr:{ ...terms, ownerKey:operator.publicKey }, script:recordReserve({ ...terms, ownerKey:operator.publicKey }).script }, operatorKey, { fee:{ ...fee } , unchecked:true }).rawHex).transaction;
  const real = [{ lockingBytecode:Uint8Array.from(Buffer.from(contract.script, 'hex')), valueSatoshis:BigInt(RECORD_RESERVE_SATOSHIS) }, { lockingBytecode:Uint8Array.from(Buffer.from(operator.script, 'hex')), valueSatoshis:1_500n }];
  assert.notEqual(createVirtualMachineBCH().verify({ transaction:forged, sourceOutputs:real }), true);
});

test('a paid operation that cannot be applied any more is owed, not lost: the next operation of that kind is free and its proof uses the original reserve', async t => {
  const { app, seat, edit, pay, settle, time, advance } = await covenantNode();
  t.after(() => app.close());
  for (const id of ['p1', 'p2']) seat(id);
  const treaty = () => { let made; edit(world => {
    if (world.diplomacy) world.diplomacy.cooldowns = {};
    for (const id of ['p1', 'p2']) Object.assign(world.cities[id], { optIn:true, tutorial:true, shieldUntil:0 });
    const offer = command(world, 'p1', { type:'diplomacy-treaty-propose', target:'p2', kind:'non-aggression', durationHours:48, terms:{} }, time());
    made = command(world, 'p2', { type:'diplomacy-treaty-respond', id:offer.id, accept:true, termsHash:offer.proposal.termsHash, version:offer.proposal.version }, time());
  }); return made; };
  const first = treaty();
  const quote = app.ledger.create('p1', { type:'political-operation', operation:'attest', treaty:first.id, consent:true });
  // A stranger to the treaty, a missing consent and an unknown operation are refused before any checkout exists.
  assert.throws(() => app.ledger.create('p1', { type:'political-operation', operation:'attest', treaty:first.id }), /Approve this specific Chipnet political action/);
  assert.throws(() => app.ledger.create('p1', { type:'political-operation', operation:'bribe', treaty:first.id, consent:true }), /Choose political support or a treaty charter/);
  const reserve = quote.outputs.find(output => output.role === 'record');
  assert.deepEqual([recordReserve(reserve.rr).version, reserve.rr.ownerKey], [RECORD_RESERVE, wallets.p1.publicKey], 'the reserve names its payer');
  // The treaty ends while the payment is confirming.
  edit(world => { world.diplomacy.treaties[first.id].status = 'terminated'; });
  await app.ledger.submit('p1', quote.id, pay('p1', quote));
  const paid = app.store.payment(quote.id);
  assert.deepEqual([paid.state, paid.fulfillment.status, paid.fulfillment.credit.action], ['credited', 'credit', 'political-operation'], JSON.stringify(paid.fulfillment));
  await settle(2);
  assert.equal(app.store.payments().some(row => row.politicalAnchor), false, 'no proof record without an applied operation');
  assert.equal(app.ledger.balances('p1').warChestSatoshis, quote.satoshis / 2, 'the War Chest share is the payer\'s as always');
  assert.deepEqual(app.ledger.balances('p1').serviceCredits, { 'political-operation':1 });
  // The next charter costs nothing: no checkout, no new payment, the operation is applied at once.
  edit(world => { delete world.diplomacy.treaties[first.id]; });
  const second = treaty();
  const before = app.store.payments('p1').length;
  const redeemed = app.ledger.create('p1', { type:'political-operation', operation:'attest', treaty:second.id, consent:true });
  assert.equal(redeemed.id, quote.id, 'the original payment is the one that is fulfilled');
  assert.deepEqual([redeemed.fulfillment.status, redeemed.fulfillment.result.treaty], ['applied', second.id]);
  assert.equal(app.store.payments('p1').filter(row => row.direction !== 'outgoing').length, before, 'no second payment was prepared');
  assert.deepEqual(app.ledger.balances('p1').serviceCredits, {});
  // Its public proof is paid by the reserve of the ORIGINAL payment, which was never lost.
  await settle(2);
  const proof = app.store.payments().find(row => row.politicalAnchor);
  assert.ok(proof?.txid, 'the proof record was published');
  assert.deepEqual([proof.sources[0].txid, proof.feeSatoshis], [paid.txid, 576]);
  // A third request finds no credit and is an ordinary checkout again.
  edit(world => { delete world.diplomacy.treaties[second.id]; });
  const third = treaty();
  const fresh = app.ledger.create('p1', { type:'political-operation', operation:'attest', treaty:third.id, consent:true });
  assert.notEqual(fresh.id, quote.id);
  assert.equal(fresh.state, 'awaiting_signature');
});
