// The wallet checkout of a paid service: the transaction the wallet is asked to sign pays every output of the payment
// (the price, and the network reserves that travel with it) and, on top of that, a fee the network relays.
// The chain is the in-memory fixture node of the covenant tests; nothing contacts a public network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeDataPush, encodeTransaction, generateSigningSerializationBCH, secp256k1 } from '@bitauth/libauth';
import { createWalletCheckout } from '../apps/game-server/wallet-checkout.mjs';
import { fromHex, hash256, hex, readTransaction } from '../packages/chain-observer/primitives.mjs';
import { covenantNode, keys, wallets } from './support/covenant-node.mjs';

// What a WizardConnect wallet does with a prepared transaction: sign every input (all inputs, all outputs), change nothing.
function walletSigns(plan, privateKey, wallet) {
  const { transaction } = readTransaction(plan.transaction);
  const sourceOutputs = plan.sourceOutputs.map(item => ({ lockingBytecode:fromHex(item.lockingBytecode), valueSatoshis:BigInt(item.valueSatoshis.match(/\d+/)[0]) }));
  const type = Uint8Array.of(0x61);
  transaction.inputs.forEach((input, inputIndex) => {
    const digest = hash256(generateSigningSerializationBCH({ inputIndex, sourceOutputs, transaction }, { coveredBytecode:fromHex(wallet.script), signingSerializationType:type }));
    input.unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([secp256k1.signMessageHashSchnorr(fromHex(privateKey), digest), type])), encodeDataPush(fromHex(wallet.publicKey))]));
  });
  return hex(encodeTransaction(transaction));
}

test('a paid service signed through the wallet checkout pays all of its outputs and a fee of at least one satoshi per byte', async t => {
  const node = await covenantNode();
  t.after(node.close);
  const { app, chain, seat, coin, settle, refused, time } = node;
  seat('p1');
  const held = [];
  const give = satoshis => held.push({ ...coin('p1', satoshis), height:node.height() - 1, script:wallets.p1.script, address:wallets.p1.address, publicKey:wallets.p1.publicKey, path:'receive', index:0 });
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  // The game server's own checkout, reading the wallet's coins from this test.
  const checkout = createWalletCheckout({ store:app.store, chain:{ ...chain, walletCoins:async () => held }, ledger:app.ledger, clock:time, notify() {}, fail });
  const walletKeys = { keys:[{ path:'receive', index:0, publicKey:wallets.p1.publicKey }] };

  const quote = app.ledger.create('p1', { type:'premium', building:'hall' });
  const outputs = app.store.payment(quote.id).outputs;
  const owed = outputs.reduce((sum, output) => sum + output.satoshis, 0);
  assert.equal(owed, quote.satoshis + 300, 'the reward share carries its 300-sat network reserve on top of the price');
  // A wallet that holds the price and the fee but not the reserve is told what is needed; nothing is built.
  give(quote.satoshis + 500);
  await assert.rejects(checkout.prepare('p1', quote.id, walletKeys), /22,500 sat available, 22,692 sat needed including the network fee/);
  held.length = 0;
  give(34_390);

  const plan = await checkout.prepare('p1', quote.id, walletKeys);
  assert.match(plan.userPrompt, /22000 sats plus 300 network reserve plus 392 fee$/, 'the wallet is told about the reserve as well');
  const raw = walletSigns(plan, keys.p1, wallets.p1);
  const { transaction } = readTransaction(raw);
  // The game's outputs, exactly, then the change back to the wallet.
  outputs.forEach((output, index) => assert.deepEqual([hex(transaction.outputs[index].lockingBytecode), Number(transaction.outputs[index].valueSatoshis)], [output.script, output.satoshis]));
  const sent = transaction.outputs.reduce((sum, output) => sum + Number(output.valueSatoshis), 0);
  const fee = 34_390 - sent;
  assert.equal(fee, plan.feeSatoshis, 'the fee the wallet shows is the fee the transaction pays');
  assert.ok(fee >= raw.length / 2, `the network relays one satoshi per byte and more: ${fee} sat for ${raw.length / 2} bytes`);
  assert.deepEqual([transaction.outputs.length, Number(transaction.outputs.at(-1).valueSatoshis)], [outputs.length + 1, 34_390 - owed - fee]);

  await checkout.broadcast('p1', quote.id, raw);
  assert.deepEqual(refused, []);
  await settle();
  assert.equal(app.store.payment(quote.id).state, 'credited');
  assert.equal(app.ledger.balances('p1').warChestSatoshis, quote.satoshis / 2);
});
