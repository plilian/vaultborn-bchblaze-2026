// Connecting a wallet is the verification: the wallet signs a proof transaction that is never sent (wallet-proof.mjs),
// from the start page (enter or create a kingdom) and inside the game (link the wallet), with nothing to copy or paste.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { encodeDataPush, encodeTransaction, generateSigningSerializationBCH, secp256k1 } from '@bitauth/libauth';
import { createApp } from '../apps/game-server/index.mjs';
import { proofIsValid, proofPlan } from '../apps/game-server/wallet-proof.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { fromHex, hash256, hex, readTransaction } from '../packages/chain-observer/primitives.mjs';

const key = index => index.toString(16).padStart(64, '0');
// What a WizardConnect wallet does with a request: sign every listed input with SIGHASH_ALL | UTXOS | FORKID, change nothing.
function walletSigns(plan, privateKey, change = tx => tx) {
  const wallet = walletFromPrivateKey(privateKey);
  const { transaction } = readTransaction(plan.transaction);
  change(transaction);
  const sourceOutputs = plan.sourceOutputs.map(item => ({ lockingBytecode: fromHex(item.lockingBytecode), valueSatoshis: BigInt(item.valueSatoshis.match(/\d+/)[0]) }));
  const type = Uint8Array.of(0x61);
  const digest = hash256(generateSigningSerializationBCH({ inputIndex: 0, sourceOutputs, transaction }, { coveredBytecode: fromHex(wallet.script), signingSerializationType: type }));
  transaction.inputs[0].unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([secp256k1.signMessageHashSchnorr(fromHex(privateKey), digest), type])), encodeDataPush(fromHex(wallet.publicKey))]));
  return hex(encodeTransaction(transaction));
}

async function serve(t, options = {}) {
  let time = 1_795_000_000_000;
  const app = createApp({ database: ':memory:', clock: () => time, chain: createChain({ enabled: false }), localDemo: false, ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { const closed = once(app.server, 'close'); app.close(); await closed; });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  // A browser: keeps every cookie the game sets.
  const browser = () => { const jar = new Map();
    return async (path, data) => {
      const response = await fetch(origin + '/api/' + path, { headers: { Cookie: [...jar].map(([name, value]) => name + '=' + value).join('; '), ...(data && { 'Content-Type': 'application/json' }) }, ...(data && { method: 'POST', body: JSON.stringify(data) }) });
      for (const line of response.headers.getSetCookie()) { const [name, value] = line.split(';')[0].split('='); if (value) jar.set(name, value); else jar.delete(name); }
      return { status: response.status, body: await response.json() };
    }; };
  return { app, origin, browser, pass: milliseconds => { time += milliseconds; } };
}
const connect = async (browser, privateKey, change) => {
  const prepared = await browser('identity/wizard/prepare', { publicKey: walletFromPrivateKey(privateKey).publicKey });
  if (prepared.status !== 200) return prepared;
  return browser('identity/wizard/verify', { nonce: prepared.body.result.nonce, signedTransaction: walletSigns(prepared.body.result, change?.key ?? privateKey, change?.edit) });
};

test('the proof transaction can never move a coin and is only valid for its own statement and key', () => {
  const wallet = walletFromPrivateKey(key(7));
  const fields = { publicKey: wallet.publicKey, origin: 'https://play.example.org', nonce: 'ab'.repeat(32), expiresAt: 1_800_000_000 };
  const plan = proofPlan(fields);
  const { transaction } = readTransaction(plan.transaction);
  // One made-up input worth 1,000 sat; the same 1,000 sat back to the same address; a data record. Nothing leaves the wallet.
  assert.equal(transaction.inputs.length, 1);
  assert.deepEqual(transaction.outputs.map(output => Number(output.valueSatoshis)), [1000, 0]);
  assert.equal(hex(transaction.outputs[0].lockingBytecode), wallet.script);
  assert.equal(transaction.outputs[1].lockingBytecode[0], 0x6a);
  assert.match(plan.statement, /Site: https:\/\/play\.example\.org\n/);
  assert.match(plan.userPrompt, /sends nothing, spends nothing, never broadcast/);
  // The coin it names is derived from the statement, so another statement names another coin.
  assert.notEqual(plan.sourceOutputs[0].outpointTransactionHash, proofPlan({ ...fields, nonce: 'cd'.repeat(32) }).sourceOutputs[0].outpointTransactionHash);
  const signed = walletSigns(plan, key(7));
  assert.equal(proofIsValid(fields, signed), true);
  assert.equal(proofIsValid({ ...fields, nonce: 'cd'.repeat(32) }, signed), false, 'another one-time number');
  assert.equal(proofIsValid({ ...fields, origin: 'https://evil.example' }, signed), false, 'another site');
  assert.equal(proofIsValid({ ...fields, publicKey: walletFromPrivateKey(key(8)).publicKey }, signed), false, 'another wallet');
  assert.equal(proofIsValid(fields, walletSigns(plan, key(8))), false, 'signed by a key that is not the address');
  assert.equal(proofIsValid(fields, plan.transaction), false, 'unsigned');
  assert.equal(proofIsValid(fields, 'zz'), false);
});

test('from the start page a wallet creates a kingdom, and later opens the same kingdom from any browser', async t => {
  const { browser } = await serve(t);
  const first = browser();
  const entered = await connect(first, key(21));
  assert.equal(entered.status, 200, entered.body.error);
  assert.deepEqual([entered.body.result.created, entered.body.result.linked], [true, true]);
  const address = walletFromPrivateKey(key(21)).address;
  assert.equal(entered.body.state.wallet.address, address);
  assert.equal(entered.body.state.signIn.bch, address);
  assert.equal((await first('session')).body.authenticated, true);
  // Another browser, the same wallet: the same kingdom, no second one.
  const second = browser();
  const returned = await connect(second, key(21));
  assert.deepEqual([returned.status, returned.body.result.created, returned.body.result.player], [200, false, entered.body.result.player]);
  // Another wallet starts another kingdom.
  const other = await connect(browser(), key(22));
  assert.equal(other.body.result.created, true);
  assert.notEqual(other.body.result.player, entered.body.result.player);
});

test('inside the game connecting the wallet links it at once; a city not founded yet opens the wallet\'s kingdom; a founded one opens it only when the player chooses to', async t => {
  const { browser } = await serve(t);
  const player = browser();
  const session = await player('session', { entry: 'new' });
  assert.equal(session.body.state.wallet, null);
  // Without a wallet, a refusal says "connect your wallet first" and is marked so that the game can open the connection.
  const refused = await player('identity/challenge', { operation: 'link', nostrKey: 'ab'.repeat(32), consent: true });
  assert.deepEqual([refused.status, refused.body.code], [403, 'wallet-required']);
  assert.match(refused.body.error, /^Connect your wallet first/);
  const linked = await connect(player, key(31));
  assert.equal(linked.status, 200, linked.body.error);
  assert.deepEqual([linked.body.result.created, linked.body.result.linked, linked.body.result.player], [false, true, session.body.result.player]);
  assert.equal(linked.body.state.wallet.address, walletFromPrivateKey(key(31)).address);
  // Connecting the same wallet again changes nothing and is not an error.
  assert.equal((await connect(player, key(31))).status, 200);
  // "Sign in to an existing kingdom" from a city not founded yet: the wallet's own kingdom opens.
  const visitor = browser();
  await visitor('session', { entry: 'new' });
  const opened = await connect(visitor, key(31));
  assert.equal(opened.status, 200, opened.body.error);
  assert.deepEqual([opened.body.result.player, opened.body.result.switched], [session.body.result.player, true]);
  // A founded kingdom cannot take that wallet.
  const rival = browser();
  await rival('session', { entry: 'new' });
  await rival('command', { type: 'found', name: 'Rival Lord', cityName: 'Rivalry', faction: 'emerald' });
  const taken = await connect(rival, key(31));
  assert.equal(taken.status, 409);
  assert.deepEqual([taken.body.code, taken.body.error], ['wallet-other-kingdom', 'This wallet already belongs to another kingdom.']);
  // When the player chooses to, the same wallet proof opens the wallet's kingdom instead.
  const prepared = await rival('identity/wizard/prepare', { publicKey: walletFromPrivateKey(key(31)).publicKey });
  const proof = { nonce: prepared.body.result.nonce, signedTransaction: walletSigns(prepared.body.result, key(31)) };
  assert.equal((await rival('identity/wizard/verify', proof)).status, 409);
  const switched = await rival('identity/wizard/verify', { ...proof, switchKingdom: true });
  assert.deepEqual([switched.status, switched.body.result.player], [200, session.body.result.player]);
});

test('a proof that is not this wallet\'s, not this browser\'s, altered, used or expired is refused', async t => {
  const { browser, pass } = await serve(t);
  const visitor = browser();
  // Signed by another key than the one that was presented.
  assert.equal((await connect(visitor, key(41), { key: key(42) })).status, 400);
  // The wallet changed the transaction.
  assert.equal((await connect(visitor, key(41), { edit: tx => { tx.outputs[0].valueSatoshis = 999n; } })).status, 400);
  // A proof prepared in one browser cannot be completed in another.
  const prepared = (await visitor('identity/wizard/prepare', { publicKey: walletFromPrivateKey(key(41)).publicKey })).body.result;
  const signed = walletSigns(prepared, key(41));
  const thief = await browser()('identity/wizard/verify', { nonce: prepared.nonce, signedTransaction: signed });
  assert.equal(thief.status, 409);
  // It works once in its own browser, and never again.
  assert.equal((await visitor('identity/wizard/verify', { nonce: prepared.nonce, signedTransaction: signed })).status, 200);
  assert.equal((await visitor('identity/wizard/verify', { nonce: prepared.nonce, signedTransaction: signed })).status, 409);
  // A proof that waited too long.
  const late = browser();
  const stale = (await late('identity/wizard/prepare', { publicKey: walletFromPrivateKey(key(43)).publicKey })).body.result;
  pass(6 * 60_000);
  assert.equal((await late('identity/wizard/verify', { nonce: stale.nonce, signedTransaction: walletSigns(stale, key(43)) })).status, 409);
  // Not a public key.
  assert.equal((await late('identity/wizard/prepare', { publicKey: 'nonsense' })).status, 400);
});
