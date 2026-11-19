import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createVirtualMachineBCH } from '@bitauth/libauth';
import { createApp } from '../apps/game-server/index.mjs';
import { GAMEPLAY_ALLOCATION, paymentAllocation, prizeNeedsCarrier, PRIZE_CARRIER } from '../config/payments.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { fromHex, hex, incomingDestination, readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';
import { prizeCarrier } from '../packages/chain-observer/prize-carrier.mjs';
import { prizeAggregate } from '../packages/chain-observer/vaultborn.mjs';

// These tests cover outputs and balances created before covenant custody of kingdom funds. Those must stay verifiable and spendable.
process.env.VAULTBORN_KINGDOM_CUSTODY = 'operator';

const initialTime = Date.UTC(2026,10,19);
const key = number => number.toString(16).padStart(64, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const operatorKey = key(800);
const operator = walletFromPrivateKey(operatorKey);
const vm = createVirtualMachineBCH();

test('every service price splits exactly 20/10/5/65, and only sub-dust prize shares use a carrier', () => {
  for (let total = 3_000; total <= 30_000; total += 20) {
    const carrier = prizeNeedsCarrier(total, 'rush', GAMEPLAY_ALLOCATION);
    const split = paymentAllocation(total, 'rush', GAMEPLAY_ALLOCATION, { carrier });
    assert.equal(split.development + split.prize + split.burn + split.kingdom, total);
    assert.equal(split.development, total * 20 / 100);
    assert.equal(split.prize, total * 10 / 100);
    assert.equal(split.burn, total * 5 / 100);
    assert.equal(split.kingdom, total * 65 / 100);
    assert.equal(carrier, split.prize < 546);
    if (carrier) assert.ok(split.prize + split.kingdom >= 576 && split.kingdom >= 546 && split.development >= 546);
  }
  assert.deepEqual(paymentAllocation(4_000, 'rush', GAMEPLAY_ALLOCATION, { carrier:true }), { development:800, burn:200, prize:400, kingdom:2_600 });
  assert.deepEqual(paymentAllocation(4_500, 'premium', GAMEPLAY_ALLOCATION, { carrier:true }), { development:900, burn:225, prize:450, kingdom:2_925 });
  assert.equal(prizeNeedsCarrier(6_000, 'political-operation', GAMEPLAY_ALLOCATION), false);
  assert.equal(prizeNeedsCarrier(3_600, 'attack-paid', GAMEPLAY_ALLOCATION), false);
});

async function fixture(t, options = {}) {
  let now = initialTime;
  let sequence = 0;
  const transactions = new Map();
  const spent = new Set();
  const buyerKey = key(801);
  const buyer = walletFromPrivateKey(buyerKey);
  const assets = { enabled:false, list:() => [], authority:() => null, close:() => {} };
  const chain = createChain({ treasuryPrivateKey:operatorKey, transport:{ withClient:run => run({
    history:async () => [], lookup:async txid => transactions.get(txid),
    broadcast:async raw => {
      const decoded = readTransaction(raw);
      const points = decoded.transaction.inputs.map(input => hex(input.outpointTransactionHash) + ':' + input.outpointIndex);
      if (!transactions.has(decoded.txid) && points.some(point => spent.has(point))) throw new Error('txn-mempool-conflict');
      // The fixture node runs the BCH VM over every input it knows, like a real node validating scripts.
      const sourceOutputs = decoded.transaction.inputs.map(input => transactions.get(hex(input.outpointTransactionHash))?.transaction.outputs[input.outpointIndex]);
      if (sourceOutputs.every(Boolean)) {
        const verdict = vm.verify({ transaction:decoded.transaction, sourceOutputs });
        if (verdict !== true) throw new Error('mandatory-script-verify-flag-failed: ' + verdict);
      }
      for (const point of points) spent.add(point);
      transactions.set(decoded.txid, transactions.get(decoded.txid) ?? { ...decoded, confirmations:0, height:0 });
      return decoded.txid;
    } }) } });
  const app = createApp({ database:':memory:', localDemo:true, clock:() => now, chain, territoryAssets:assets, politicalAssets:assets, ...options });
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  t.after(async () => { const closed=once(app.server,'close'); app.close(); await closed; });
  function pay(quote) {
    const outputs = app.store.payment(quote.id).outputs.map(({ script, satoshis }) => ({ script, satoshis }));
    const signed = signSpend({ privateKey:buyerKey, sources:[{ txid:hash('carrier-' + (++sequence)), vout:0, script:buyer.script, satoshis:300_000 }],
      outputs:[...outputs, { script:buyer.script, satoshis:300_000 - quote.satoshis - 400 }] });
    const observed = { ...readTransaction(signed.rawHex), confirmations:2, height:391_000, blockHash:hash('block'), blockTime:now };
    transactions.set(observed.txid, observed);
    return observed.txid;
  }
  const confirmAll = () => { for (const item of transactions.values()) if (!item.confirmations) { item.confirmations = 2; item.height = 391_001; } };
  const seat = (id, wallet) => {
    app.store.addSession(hash('seat-' + id), id, initialTime + 365 * 86_400_000);
    app.store.bindWallet(id, wallet.address, wallet.publicKey, now);
  };
  return { app, chain, transactions, pay, confirmAll, seat, advance:ms => { now += ms; } };
}

test('two premium payments are carried, credited at once, and swept into exact prize and kingdom outputs', async t => {
  const { app, transactions, pay, confirmAll, seat } = await fixture(t);
  const owner = walletFromPrivateKey(key(802));
  seat('p1', owner);
  const quotes = ['p1','p2'].map(player => app.ledger.create(player, { type:'premium', building:'hall' }));
  for (const quote of quotes) {
    assert.equal(quote.satoshis, 4_500);
    assert.deepEqual(quote.outputs.map(({ role, satoshis }) => [role, satoshis]), [['carrier', 3_375], ['development', 900], ['burn', 225]]);
    assert.equal(quote.outputs[0].prizeSatoshis, 450);
    assert.equal(quote.outputs[0].kingdomSatoshis, 2_925);
    assert.match(quote.outputs[0].label, /Kingdom 2925 \+ Prize 450/);
    const saved = app.store.payment(quote.id);
    assert.equal(saved.event.data.dust, PRIZE_CARRIER);
    assert.deepEqual(saved.event.data.allocation, { development:900, burn:225, prize:450, kingdom:2_925 });
    // Anyone can rebuild the carrier address from the payment ID, the season, the shares and the operator public key.
    const rebuilt = prizeCarrier({ id:saved.id, operatorKey:operator.publicKey, prize:450, kingdom:2_925,
      prizeScript:prizeAggregate(saved.event.data.seasonId, operator.publicKey).script, kingdomScript:incomingDestination(saved.id, operator.publicKey).script });
    assert.equal(rebuilt.script, quote.outputs[0].script);
  }
  for (const [index, quote] of quotes.entries()) await app.ledger.submit(index ? 'p2' : 'p1', quote.id, pay(quote));
  assert.equal(app.ledger.balances('p1').kingdomSatoshis, 2_925);
  assert.equal(app.ledger.balances('p2').kingdomSatoshis, 2_925);
  let buckets = app.ledger.explorer().buckets;
  assert.equal(buckets.allocationCarriers, 6_750);
  assert.equal(buckets.kingdomReserve, 0);
  assert.equal(buckets.prize, 0);
  assert.equal(buckets.development, 1_800);
  await app.ledger.reconcile();
  const sweep = app.store.payments().find(row => row.action === 'allocation-sweep');
  assert.ok(sweep, 'a sweep was signed');
  assert.equal(sweep.payload.carriers.length, 2);
  assert.equal(sweep.topUpSatoshis, 0);
  const sent = transactions.get(sweep.txid);
  assert.ok(sent, 'the sweep passed the BCH VM in the fixture node');
  assert.equal(sent.transaction.outputs[0].valueSatoshis, 900n);
  assert.deepEqual(sent.transaction.outputs.slice(1, 3).map(output => output.valueSatoshis), [2_925n, 2_925n]);
  await app.ledger.reconcile();
  assert.equal(app.store.payments().filter(row => row.action === 'allocation-sweep').length, 1, 'a carrier is swept once');
  confirmAll();
  await app.ledger.reconcile();
  await app.ledger.reconcile();
  assert.equal(app.store.payment(sweep.id).state, 'credited');
  buckets = app.ledger.explorer().buckets;
  assert.equal(buckets.allocationCarriers, 0);
  assert.equal(buckets.prize, 900);
  assert.equal(buckets.kingdomReserve, 5_850);
  assert.equal(buckets.development, 1_800 - sweep.feeSatoshis);
  assert.equal(buckets.burned, 450);
  // Conservation: every satoshi paid is in a pool, burned, or spent as the disclosed sweep fee.
  assert.equal(buckets.prize + buckets.kingdomReserve + buckets.development + buckets.burned + sweep.feeSatoshis, 9_000);
  const withdrawal = app.ledger.quotePayout('p1', { kind:'kingdom-withdraw', satoshis:2_000, address:owner.address });
  assert.equal(withdrawal.satoshis, 2_000);
});

test('a lone carrier waits, then sweeps with a disclosed top-up to the dust limit', async t => {
  const { app, chain, transactions, pay, confirmAll, advance } = await fixture(t, { carrierWait:600_000 });
  // An operator-held Development output from a sponsorship quoted under the previous 20/80 policy pays the sweep fee.
  const share = { development:2_000, prize:8_000 };
  const funder = { ...chain.createIntent({ playerId:'p3', action:'sponsor-fund', payload:{ type:'sponsor-fund' }, satoshis:10_000, now:initialTime,
    allocation:share, event:{ seasonId:1, actionHash:hash('legacy sponsor'), allocation:share, allocationPolicy:'sponsor-split-v1' } }), pool:'sponsor', seasonId:1 };
  app.store.savePayment(funder);
  await app.ledger.submit('p3', funder.id, pay(funder));
  const quote = app.ledger.create('p1', { type:'premium', building:'hall' });
  await app.ledger.submit('p1', quote.id, pay(quote));
  await app.ledger.reconcile();
  assert.equal(app.store.payments().some(row => row.action === 'allocation-sweep'), false);
  advance(600_001);
  await app.ledger.reconcile();
  const sweep = app.store.payments().find(row => row.action === 'allocation-sweep');
  assert.ok(sweep);
  assert.equal(sweep.topUpSatoshis, 96);
  assert.equal(transactions.get(sweep.txid).transaction.outputs[0].valueSatoshis, 546n);
  confirmAll();
  await app.ledger.reconcile();
  await app.ledger.reconcile();
  const { buckets } = app.ledger.explorer();
  assert.equal(buckets.kingdomReserve, 2_925);
  assert.equal(buckets.allocationCarriers, 0);
});

// Hand-built sweeps. The carrier lane needs no signature, so each variant below is a complete, valid-looking transaction.
function carrierSet(prizes) {
  const prize = prizeAggregate(7, operator.publicKey);
  return prizes.map((share, index) => {
    const id = hash('carrier-set-' + index).slice(0, 32);
    const kingdom = incomingDestination(id, operator.publicKey);
    const contract = prizeCarrier({ id, operatorKey:operator.publicKey, prize:share, kingdom:2_600, prizeScript:prize.script, kingdomScript:kingdom.script });
    return { contract, kingdom, prize, source:{ txid:hash('funding-' + index), vout:0, satoshis:contract.satoshis, script:contract.script,
      redeemScript:contract.redeemScript, unlocking:'00' } };
  });
}
function sweep(sources, outputs, feeSatoshis = 4_000) {
  const all = [...sources, { txid:hash('fee'), vout:1, satoshis:feeSatoshis, script:operator.script }];
  const signed = signSpend({ privateKey:operatorKey, sources:all, outputs, requireUtxos:true });
  const { transaction } = readTransaction(signed.rawHex);
  return vm.verify({ transaction, sourceOutputs:all.map(source => ({ lockingBytecode:fromHex(source.script), valueSatoshis:BigInt(source.satoshis) })) });
}

test('the carrier covenant accepts only sweeps that pay every committed share', () => {
  const [a, b] = carrierSet([400, 400]);
  const good = [{ script:a.prize.script, satoshis:800 }, { script:a.kingdom.script, satoshis:2_600 }, { script:b.kingdom.script, satoshis:2_600 }];
  assert.equal(sweep([a.source, b.source], good), true);
  const vary = change => good.map((output, index) => ({ ...output, ...change(index) }));
  // Short prize, short kingdom share, wrong destinations.
  assert.notEqual(sweep([a.source, b.source], vary(index => index === 0 ? { satoshis:799 } : {})), true);
  assert.notEqual(sweep([a.source, b.source], vary(index => index === 2 ? { satoshis:2_599 } : {})), true);
  assert.notEqual(sweep([a.source, b.source], vary(index => index === 0 ? { script:operator.script } : {})), true);
  assert.notEqual(sweep([a.source, b.source], vary(index => index === 1 ? { script:operator.script } : {})), true);
  // Kingdom outputs in the wrong order send each share to the other kingdom, so they are refused.
  assert.notEqual(sweep([a.source, b.source], [good[0], good[2], good[1]]), true);
  // More than owed is fine: the fee input may top up either pool.
  assert.equal(sweep([a.source, b.source], vary(index => index === 0 ? { satoshis:1_000 } : {})), true);
});

test('a carrier cannot be the final input, and mixed shares never underpay the prize output', () => {
  const [a, b] = carrierSet([400, 450]);
  const outputs = prizeValue => [{ script:a.prize.script, satoshis:prizeValue }, { script:a.kingdom.script, satoshis:2_600 }, { script:b.kingdom.script, satoshis:2_600 }];
  // 850 is owed, but each carrier asks its own share per carrier input, so 900 is required. The pools can only gain.
  assert.notEqual(sweep([a.source, b.source], outputs(850)), true);
  assert.equal(sweep([a.source, b.source], outputs(900)), true);
  // Without a trailing fee input the last carrier refuses, so a sweep can never pay its fee out of a share.
  const [c] = carrierSet([600]);
  const alone = { privateKey:operatorKey, sources:[c.source], outputs:[{ script:c.prize.script, satoshis:600 }, { script:c.kingdom.script, satoshis:2_050 }] };
  const transaction = readTransaction(signSpend(alone).rawHex).transaction;
  assert.notEqual(vm.verify({ transaction, sourceOutputs:[{ lockingBytecode:fromHex(c.source.script), valueSatoshis:BigInt(c.source.satoshis) }] }), true);
});

test('the operator key cannot move an exactly funded carrier, but can recover a wrongly funded one', () => {
  const [a] = carrierSet([400]);
  const attempt = satoshis => {
    // The operator lane: signature, selector 1, redeem script.
    const source = { txid:hash('operator-lane'), vout:0, satoshis, script:a.contract.script, redeemScript:a.contract.redeemScript };
    const signed = signSpend({ privateKey:operatorKey, sources:[source], outputs:[{ script:operator.script, satoshis:satoshis - 400 }], requireUtxos:true });
    const { transaction } = readTransaction(signed.rawHex);
    const unlocking = transaction.inputs[0].unlockingBytecode;
    const signatureLength = unlocking[0] + 1;
    transaction.inputs[0].unlockingBytecode = Uint8Array.from([...unlocking.slice(0, signatureLength), 0x51, ...unlocking.slice(signatureLength)]);
    return vm.verify({ transaction, sourceOutputs:[{ lockingBytecode:fromHex(source.script), valueSatoshis:BigInt(satoshis) }] });
  };
  assert.notEqual(attempt(a.contract.satoshis), true);
  assert.equal(attempt(a.contract.satoshis + 1), true);
  assert.equal(attempt(a.contract.satoshis - 1), true);
  assert.equal(attempt(9_000), true);
});
