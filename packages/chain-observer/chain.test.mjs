import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeTransaction, createVirtualMachineBCH } from '@bitauth/libauth';
import { createChain, signWalletChallenge, verifyWalletProof, walletFromPrivateKey } from './index.mjs';
import { fromHex, hash256, hex, parseHeader, readTransaction, verifyInclusion } from './primitives.mjs';

const TREASURY_KEY = '01'.padStart(64, '0');
const PLAYER_KEY = '02'.padStart(64, '0');
const treasury = walletFromPrivateKey(TREASURY_KEY);
const player = walletFromPrivateKey(PLAYER_KEY);
const now = 1794761720000;

function fixture() {
  const observations = new Map();
  let failure = false;
  const client = {
    history: async () => [...observations.values()].map(({ txid, height }) => ({ txid, height: height ?? 0 })),
    lookup: async (txid) => observations.get(txid) ?? null,
    raw: async () => null,
  };
  const chain = createChain({
    treasuryPublicKey: treasury.publicKey, treasuryPrivateKey: TREASURY_KEY,
    transport: {
      withClient: async (work) => {
        if (failure) throw new Error('fixture unavailable');
        return work(client);
      },
    },
  });
  return {
    chain, observations, fail() { failure = true; },
    create: (action = 'premium') => chain.createIntent({ playerId: 'p1', action, payload: {}, satoshis: 1500, now }),
  };
}

function put(observations, outputs, confirmations = 0) {
  const raw = encodeTransaction({
    version: 2, locktime: 0,
    inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(2), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array(0) }],
    outputs: outputs.map(({ script, satoshis, token }) => ({ lockingBytecode: fromHex(script), valueSatoshis: BigInt(satoshis), token })),
  });
  const parsed = readTransaction(hex(raw));
  observations.set(parsed.txid, { ...parsed, confirmations, height: confirmations ? 400123 : null });
  return parsed.txid;
}

test('receivers are unique, public, exact BCH and reconstructible by treasury alone', () => {
  const { chain, create } = fixture();
  const first = create();
  const second = create();
  assert.notEqual(first.address, second.address);
  assert.match(first.address, /^bchtest:p/);
  assert.equal(first.network, 'chipnet');
  assert.equal(first.satoshis, 1500);
  assert.equal(chain.publicIntent(first).walletUri, first.address + '?amount=0.00001500');
  assert.equal(chain.publicIntent(first).redeemScript, undefined);
  assert.throws(() => createChain({ treasuryPublicKey: treasury.publicKey, treasuryPrivateKey: PLAYER_KEY }), /do not match/);
});

test('a TXID alone cannot fulfill an intent, and exact payment survives a restart', async () => {
  const { chain, observations, create } = fixture();
  const row = create();
  const fake = chain.submit(row, 'a'.repeat(64), now);
  assert.equal((await chain.observe(fake, now)).state, 'submitted');
  assert.equal(row.txid, undefined);
  const txid = put(observations, [row]);
  const attached = chain.submit(row, txid, now);
  const mempool = await chain.observe(attached, now);
  assert.equal(mempool.state, 'seen_in_mempool');
  assert.equal(mempool.receipt.confirmations, 0);
  observations.get(txid).confirmations = 1;
  observations.get(txid).height = 400123;
  assert.equal((await chain.observe(mempool, now)).state, 'confirming');
  observations.get(txid).confirmations = 2;
  const confirmed = await chain.observe(JSON.parse(JSON.stringify(mempool)), now);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.receipt.txid, txid);
  assert.equal(confirmed.receipt.vout, 0);
  assert.equal((await chain.observe({ ...confirmed, state: 'credited' }, now)).state, 'credited');
  assert.equal(chain.submit(confirmed, txid, now + 1000).state, 'confirmed');
  assert.throws(() => chain.submit(confirmed, 'b'.repeat(64)), /already attached/);
});

test('a split is credited only if every exact pool output and the value-bearing OP_RETURN are present', async () => {
  const { chain, observations } = fixture();
  const allocation = { development: 1200, burn: 900, prize: 900, battle: 3000 };
  const intent = chain.createIntent({ playerId:'p1', action:'attack-paid', payload:{target:'p2'}, satoshis:6000,
    allocation, event:{seasonId:1}, now });
  const publicIntent = chain.publicIntent(intent);
  assert.deepEqual(publicIntent.outputs.map(({ role, satoshis }) => [role, satoshis]),
    [['battle',3000],['development',1200],['prize',900],['burn',900]]);
  assert.equal(publicIntent.outputs.some(output => output.redeemScript), false);
  assert.equal(publicIntent.walletUri, undefined);
  assert.match(publicIntent.outputs.at(-1).script, /^6a045642524e220103[0-9a-f]{64}$/);
  for (const outputs of [
    intent.outputs.slice(0,-1),
    intent.outputs.map((output, index) => index === 2 ? { ...output, satoshis:899 } : output),
    intent.outputs.map((output, index) => index === 3 ? { ...output, satoshis:0 } : output),
  ]) {
    const txid = put(observations, outputs, 5);
    assert.equal((await chain.observe(chain.submit(intent, txid, now), now)).state, 'rejected');
  }
  const txid = put(observations, [{ script:player.script, satoshis:3000 }, ...intent.outputs], 2);
  const observed = await chain.observe(intent, now);
  assert.equal(observed.state, 'confirmed');
  assert.equal(observed.txid, txid);
  assert.equal(observed.receipt.eventVout, 4);
  assert.equal(observed.receipt.allocations[1].satoshis, 1200);
});

test('wrong amount, receiver, network, duplicate output and CashTokens do not satisfy an intent', async () => {
  const { chain, observations, create } = fixture();
  const intent = create();
  for (const outputs of [
    [{ ...intent, satoshis: 1501 }],
    [{ ...intent, script: player.script }],
    [intent, intent],
    [{ ...intent, token: { category: new Uint8Array(32).fill(7), amount: 1n } }],
  ]) {
    const txid = put(observations, outputs, 5);
    const observed = await chain.observe(chain.submit(intent, txid, now), now);
    assert.equal(observed.state, 'rejected');
    assert.equal(observed.receipt, null);
  }
  assert.equal((await chain.observe({ ...intent, network: 'testnet4' }, now)).state, 'rejected');
});

test('external chain downtime stays uncertain while an evicted credited payment gets flagged', async () => {
  const { chain, observations, create, fail } = fixture();
  const row = create();
  const txid = put(observations, [row], 3);
  const confirmed = await chain.observe(row, now);
  const credited = { ...confirmed, state: 'credited' };
  assert.equal(confirmed.state, 'confirmed');
  observations.delete(txid);
  assert.equal((await chain.observe(credited, now + 1)).state, 'reorg');
  fail();
  assert.equal((await chain.observe(credited, now + 2)).state, 'credited');
  assert.equal((await chain.observe(row, now + 2)).state, 'uncertain');
});

test('late transactions retain a receipt without automatically fulfilling', async () => {
  const { chain, observations, create } = fixture();
  const intent = create();
  assert.equal((await chain.observe(intent, intent.expiresAt + 1)).state, 'expired');
  const txid = put(observations, [intent], 4);
  const late = await chain.observe(chain.submit(intent, txid, intent.expiresAt + 1), intent.expiresAt + 1);
  assert.equal(late.state, 'expired');
  assert.equal(late.receipt.txid, txid);
});

test('payout preserves satoshis and spending requires the treasury key', async () => {
  const { chain, observations, create } = fixture();
  const funding = { ...create('vault-deposit'), satoshis: 4000 };
  put(observations, [funding], 4);
  const deposit = await chain.observe(funding, now);
  const payout = chain.preparePayout({
    playerId: 'p1', address: player.address, action: 'withdraw', satoshis: 2000, sources: [deposit.receipt], now,
  });
  assert.equal(payout.change.satoshis + payout.satoshis + payout.feeSatoshis, deposit.satoshis);
  const signed = chain.signPayout(payout);
  const parsed = readTransaction(signed.rawHex, signed.txid);
  const sourceOutputs = [{ lockingBytecode: fromHex(deposit.script), valueSatoshis: BigInt(deposit.satoshis) }];
  const vm = createVirtualMachineBCH();
  assert.equal(vm.verify({ transaction: parsed.transaction, sourceOutputs }), true);
  const invalid = structuredClone(parsed.transaction);
  invalid.outputs[0].valueSatoshis -= 1n;
  assert.notEqual(vm.verify({ transaction: invalid, sourceOutputs }), true);
  observations.set(signed.txid, { ...parsed, confirmations: 2, height: 400123 });
  const observed = await chain.observe(chain.submit(payout, signed.txid, now), now);
  assert.equal(observed.state, 'confirmed');
  assert.equal(observed.receipt.change.txid, signed.txid);
  assert.equal(observed.receipt.change.vout, 1);
  assert.equal(observed.receipt.change.redeemScript, payout.change.redeemScript);
  assert.equal(chain.publicIntent(observed).receipt.change.redeemScript, undefined);
  assert.throws(() => chain.preparePayout({ ...payout, sources: [deposit.receipt, deposit.receipt] }), /twice/);
  assert.throws(() => chain.preparePayout({ ...payout, address: player.address.replace('bchtest:', 'bitcoincash:') }), /Chipnet/);
});

test('wallet proof binds a specific key, CashAddr and exact challenge', () => {
  const proof = signWalletChallenge(PLAYER_KEY, 'intent=p1 nonce=random-unique-challenge');
  assert.equal(verifyWalletProof({ ...proof, challenge: 'intent=p1 nonce=random-unique-challenge' }), true);
  assert.equal(verifyWalletProof({ ...proof, challenge: 'intent=p2 nonce=modified' }), false);
  assert.equal(verifyWalletProof({ ...proof, address: treasury.address, challenge: 'intent=p1 nonce=random-unique-challenge' }), false);
});

test('confirmed transaction Merkle branch is bound to the provided header', () => {
  const leaf = Buffer.alloc(32, 0x07);
  const neighbor = Buffer.alloc(32, 0x23);
  const header = Buffer.alloc(80);
  hash256(Buffer.concat([leaf, neighbor])).copy(header, 36);
  const decoded = parseHeader(hex(header));
  const txid = hex(Buffer.from(leaf).reverse());
  assert.equal(verifyInclusion(txid, { pos: 0, merkle: [hex(Buffer.from(neighbor).reverse())] }, decoded), true);
  assert.equal(verifyInclusion(txid, { pos: 1, merkle: [hex(Buffer.from(neighbor).reverse())] }, decoded), false);
  assert.equal(verifyInclusion('0'.repeat(64), { pos: 0, merkle: [hex(Buffer.from(neighbor).reverse())] }, decoded), false);
});

test('CashTokens ownership reads only verified, unspent matching category outputs', async () => {
  const category = '22'.repeat(32);
  const observations = new Map();
  const token = { category:fromHex(category), amount:4n, nft:{ capability:'none', commitment:fromHex('f01d') } };
  const first = put(observations, [{ ...player, satoshis:1500, token }], 4);
  const otherScript = put(observations, [{ ...treasury, satoshis:1500, token }], 4);
  const unconfirmed = put(observations, [{ ...player, satoshis:1700, token }], 1);
  const transport = { withClient: async (work) => work({
    lookup: async (id) => observations.get(id),
    listUnspent: async (script, filter) => {
      assert.equal(script, player.script);
      assert.equal(filter, 'tokens_only');
      return [first, otherScript, unconfirmed].map((txid) => ({
        txid, vout:0, height:302200, satoshis: txid === unconfirmed ? 1700 : 1500,
      }));
    }
  }) };
  const entries = await createChain({ transport }).listCashTokens(player.tokenAddress);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].txid, first);
  assert.equal(entries[0].category, category);
  assert.equal(entries[0].capability, 'none');
  assert.equal(entries[0].commitment, 'f01d');
  assert.equal(entries[0].amount, '4');
});

test('CashTokens VM conserves fungible supply and immutable NFT capability', async () => {
  const { signSpend } = await import('./primitives.mjs');
  const token = { category:fromHex('33'.repeat(32)), amount:4n, nft:{ capability:'none', commitment:fromHex('f01d') } };
  const source = { txid:'55'.repeat(32), vout:1, script:player.script, satoshis:2000, token };
  const sourceOutputs = [{ lockingBytecode:fromHex(player.script), valueSatoshis:2000n, token }];
  const verify = (outputToken, privateKey=PLAYER_KEY) => {
    const signed = signSpend({ sources:[source], outputs:[{ script:treasury.script, satoshis:1650, token:outputToken }], privateKey });
    return createVirtualMachineBCH().verify({ transaction:readTransaction(signed.rawHex).transaction, sourceOutputs });
  };
  assert.equal(verify(token), true);
  assert.notEqual(verify({ ...token, amount:5n }), true);
  assert.notEqual(verify({ ...token, nft:{ capability:'minting', commitment:token.nft.commitment } }), true);
  assert.notEqual(verify({ ...token, nft:{ capability:'none', commitment:fromHex('9999') } }), true);
  assert.notEqual(verify(token, TREASURY_KEY), true);
});
