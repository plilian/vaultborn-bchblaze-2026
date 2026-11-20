// "Connect wallet" from the start page and inside the game, with a real WizardConnect wallet: the pages run in Chromium,
// the wallet is the official wallet SDK (@wizardconnect/wallet) holding an HD account, and they meet on a relay started
// inside this script. The wallet applies the rule Selene applies to a signing request: it signs an input only when the
// stated coin is locked to the key at the stated path, and it signs with SIGHASH_ALL | UTXOS | FORKID.
// What this does NOT show: a phone wallet, a public relay, or any payment. No chain is contacted.
const assert = (await import('node:assert/strict')).default;
const { randomBytes } = await import('node:crypto');
const { once } = await import('node:events');
const { existsSync, writeFileSync } = await import('node:fs');
const { deriveHdPath, deriveHdPathRelative, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeDataPush, encodeHdPublicKey, encodeTransaction,
  generateSigningSerializationBCH, secp256k1 } = await import('@bitauth/libauth');
const { WalletConnectionManager } = await import('@wizardconnect/wallet');
const { chromium } = await import('playwright');
const { WebSocketServer } = await import('ws');
const { createApp } = await import('../apps/game-server/index.mjs');
const { createChain, walletFromPrivateKey } = await import('../packages/chain-observer/index.mjs');
const { fromHex, hash256, hex, readTransaction } = await import('../packages/chain-observer/primitives.mjs');

// ---- A relay that forwards events between its clients, as a Nostr relay does ----
const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(relay, 'listening');
const relayUrl = 'ws://127.0.0.1:' + relay.address().port;
const subscribers = new Map(), events = new Map();
const qualifies = (event, filter) => (!filter.kinds || filter.kinds.includes(event.kind)) && (!filter.since || event.created_at >= filter.since) &&
  (!filter['#p'] || event.tags.some(tag => tag[0] === 'p' && filter['#p'].includes(tag[1])));
const send = (socket, data) => { if (socket.readyState === 1) socket.send(JSON.stringify(data)); };
relay.on('connection', socket => {
  const own = new Map();
  subscribers.set(socket, own);
  socket.on('close', () => subscribers.delete(socket));
  socket.on('message', raw => {
    const [type, value, ...filters] = JSON.parse(String(raw));
    if (type === 'EVENT' && value?.id && Array.isArray(value.tags)) {
      if (!events.has(value.id)) { events.set(value.id, value);
        for (const [peer, lists] of subscribers) for (const [id, active] of lists) if (active.some(filter => qualifies(value, filter))) send(peer, ['EVENT', id, value]); }
      send(socket, ['OK', value.id, true, '']);
    } else if (type === 'REQ') { own.set(value, filters); for (const event of events.values()) if (filters.some(filter => qualifies(event, filter))) send(socket, ['EVENT', value, event]); send(socket, ['EOSE', value]); }
    else if (type === 'CLOSE') own.delete(value);
  });
});

// ---- A wallet: an HD account with no coins at all. Connecting must not need any. ----
function makeWallet(name) {
  const account = deriveHdPath(deriveHdPrivateNodeFromSeed(randomBytes(32)), "m/44'/145'/0'");
  const branch = path => deriveHdPathRelative(account, String(path));
  const child = (path, index) => deriveHdPathRelative(branch(path), String(index));
  const keyAt = (pathName, index) => hex(child(pathName === 'change' ? 1 : 0, index).privateKey);
  const seen = { requests: [], errors: [] };
  const manager = new WalletConnectionManager({ walletName: name, walletIcon: '', getRelayPrivateKey: () => randomBytes(32),
    getXpub: path => encodeHdPublicKey({ network: 'testnet', node: deriveHdPublicNode(branch(path)) }).hdPublicKey,
    getPublicKey: (path, index) => deriveHdPublicNode(child(path, index)).publicKey,
    signTransaction: async () => { throw new Error('Sign requests go through the approval handler.'); } });
  manager.on('pendingSignRequest', ({ connectionId, request }) => { void (async () => {
    try {
      const details = request.transaction;
      const { transaction } = readTransaction(details.transaction);
      const sourceOutputs = details.sourceOutputs.map(item => ({ lockingBytecode: fromHex(item.lockingBytecode), valueSatoshis: BigInt(String(item.valueSatoshis).match(/\d+/)[0]) }));
      seen.requests.push({ prompt: details.userPrompt, broadcast: details.broadcast, inputPaths: request.inputPaths, inputs: transaction.inputs.length,
        outputs: transaction.outputs.map(output => [hex(output.lockingBytecode), Number(output.valueSatoshis)]), sourceValue: Number(sourceOutputs[0].valueSatoshis) });
      if (transaction.inputs.length !== sourceOutputs.length) throw new Error('Transaction input and source output counts do not match');
      const type = Uint8Array.of(0x61);
      for (const [inputIndex, pathName, index] of request.inputPaths) {
        const key = keyAt(pathName, index); const owner = walletFromPrivateKey(key);
        // Selene's rule: the stated coin must be locked to the key at the stated path.
        if (hex(sourceOutputs[inputIndex].lockingBytecode) !== owner.script) throw new Error('Cannot sign unowned input at index ' + inputIndex);
        const digest = hash256(generateSigningSerializationBCH({ inputIndex, sourceOutputs, transaction }, { coveredBytecode: fromHex(owner.script), signingSerializationType: type }));
        transaction.inputs[inputIndex].unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([secp256k1.signMessageHashSchnorr(fromHex(key), digest), type])), encodeDataPush(fromHex(owner.publicKey))]));
      }
      await manager.sendSignResponse(connectionId, request.sequence, hex(encodeTransaction(transaction)));
    } catch (error) { seen.errors.push(error.message); await manager.sendSignError(connectionId, request.sequence, error.message); }
  })(); });
  return { manager, seen, first: walletFromPrivateKey(keyAt('receive', 0)) };
}

const app = createApp({ database: ':memory:', chain: createChain({ enabled: false }), localDemo: false, testWizardRelay: relayUrl });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const origin = 'http://127.0.0.1:' + app.server.address().port;
// A second game whose checkout is open (a stub chain that answers but has no coins): used to check what a pay button does.
const stubKey = () => randomBytes(32).toString('hex');
const paidChain = createChain({ treasuryPrivateKey: stubKey(), developmentAddress: walletFromPrivateKey(stubKey()).address,
  prizeAttestors: [walletFromPrivateKey(stubKey()).publicKey], transport: {
    withClient: work => work({ tip: 36008, block: async () => '01' + '00'.repeat(79), history: async () => [], listUnspent: async () => [] }) } });
const noAssets = { enabled: false, list: () => [], authority: () => null, close: () => {} };
const paidApp = createApp({ database: ':memory:', chain: paidChain, localDemo: false, testWizardRelay: relayUrl, territoryAssets: noAssets, politicalAssets: noAssets });
paidApp.server.listen(0, '127.0.0.1');
await once(paidApp.server, 'listening');
const paidOrigin = 'http://127.0.0.1:' + paidApp.server.address().port;

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath: process.env.DOMINION_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined) });
const passed = [];
const check = async (name, work) => { await work(); passed.push(name); console.log('ok   ' + name); };
const pageErrors = [];
const balanceRequests = [];
const visitor = async () => { const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await context.newPage();
  page.on('request', request => { if (request.url().endsWith('/api/wallet/balance')) balanceRequests.push(request.postDataJSON()); });
  page.on('pageerror', error => pageErrors.push(error.message)); return page; };
const state = page => page.evaluate(async () => (await fetch('/api/state', { cache: 'no-store' })).json());
let failure;
try {
  const alice = makeWallet('Test wallet A (SDK)');
  const page = await visitor();
  let kingdom;
  await check('the start page offers "Connect wallet" beside "Play now"', async () => {
    await page.goto(origin + '/');
    await page.getByRole('button', { name: /^Connect wallet/ }).waitFor({ timeout: 20_000 });
  });
  await check('connecting from the start page pairs, verifies and enters the game, with one approval that sends nothing', async () => {
    await page.getByRole('button', { name: /^Connect wallet/ }).click();
    await page.getByRole('button', { name: 'Selene Wallet', exact: true }).click();
    const uri = await page.getByRole('link', { name: 'Open in wallet' }).getAttribute('href');
    assert.match(uri, /^wiz:\/\//);
    alice.manager.connect(uri);
    await page.waitForURL(origin + '/play', { timeout: 90_000 });
    assert.deepEqual(alice.seen.errors, []);
    assert.equal(alice.seen.requests.length, 1);
    const request = alice.seen.requests[0];
    assert.match(request.prompt, /prove this wallet is yours · sends nothing, spends nothing, never broadcast/);
    assert.equal(request.broadcast, false);
    assert.deepEqual(request.inputPaths, [[0, 'receive', 0]]);
    // One input; its whole value returns to the wallet's own first address; the second output is a data record.
    assert.equal(request.inputs, 1);
    assert.deepEqual(request.outputs[0], [alice.first.script, request.sourceValue]);
    assert.match(request.outputs[1][0], /^6a/);
    assert.equal(request.outputs[1][1], 0);
  });
  await check('the new kingdom holds that wallet, and the wallet is still connected inside the game without a second approval', async () => {
    await page.locator('.wallet-shortcut').first().waitFor({ timeout: 60_000 });
    const current = await state(page);
    kingdom = current.player.id;
    assert.equal(current.wallet.address, alice.first.address);
    assert.equal(current.signIn.bch, alice.first.address);
    await page.locator('.wallet-shortcut').first().dispatchEvent('click');   // the founding dialog of a new kingdom is open
    await page.getByText('Wallet connected and verified').first().waitFor({ timeout: 60_000 });
    await page.getByText('Test wallet A (SDK)').first().waitFor({ timeout: 60_000 });
    assert.equal(alice.seen.requests.length, 1);
  });
  await check('the balance shown is the whole wallet: the game asks for its receiving and change addresses, public keys only', async () => {
    // Asked as soon as the connected wallet is known; this offline fixture has no indexer, so no amount is asserted here
    // (the server side is covered by tests/wallet-balance.test.mjs).
    for (let waited = 0; !balanceRequests.length && waited < 30_000; waited += 250) await new Promise(done => setTimeout(done, 250));
    const sent = balanceRequests;
    assert.ok(sent.length > 0, 'the whole-wallet balance was requested');
    const keys = sent[0].keys;
    assert.ok(keys.some(key => key.path === 'receive') && keys.some(key => key.path === 'change'));
    assert.ok(keys.length <= 48 && keys.every(key => /^0[23][0-9a-f]{64}$/.test(key.publicKey)));
    assert.ok(!JSON.stringify(sent).match(/xprv|tprv|private/i));
  });
  await check('the same wallet in another browser opens the same kingdom instead of a new one', async () => {
    const again = await visitor();
    await again.goto(origin + '/');
    await again.getByRole('button', { name: /^Connect wallet/ }).click();
    await again.getByRole('button', { name: 'Other WizardConnect wallet', exact: true }).click();
    alice.manager.connect(await again.getByRole('link', { name: 'Open in wallet' }).getAttribute('href'));
    await again.waitForURL(origin + '/play', { timeout: 90_000 });
    await again.locator('.wallet-shortcut').first().waitFor({ timeout: 60_000 });
    assert.equal((await state(again)).player.id, kingdom);
    await again.context().close();
  });
  await check('inside the game, pairing a wallet verifies it at once: nothing to copy, paste or find', async () => {
    const bob = makeWallet('Test wallet B (SDK)');
    const game = await visitor();
    await game.goto(origin + '/play');
    await game.locator('.wallet-shortcut').first().waitFor({ timeout: 60_000 });
    assert.equal((await state(game)).wallet, null);
    // The first-visit guide may cover the page; the wallet button is pressed directly.
    await game.locator('.wallet-shortcut').first().dispatchEvent('click');
    await game.getByRole('button', { name: 'Selene Wallet', exact: true }).click();
    bob.manager.connect(await game.getByRole('link', { name: 'Open in wallet' }).getAttribute('href'));
    await game.getByText('Wallet connected and verified').first().waitFor({ timeout: 90_000 });
    assert.deepEqual(bob.seen.errors, []);
    assert.equal(bob.seen.requests.length, 1);
    const current = await state(game);
    assert.equal(current.wallet.address, bob.first.address);
    assert.notEqual(current.player.id, kingdom);
    await game.context().close();
  });
  await check('a wallet that refuses the check is told so, with one button to try again', async () => {
    const carol = makeWallet('Test wallet C (SDK)');
    carol.manager.removeAllListeners('pendingSignRequest');
    carol.manager.on('pendingSignRequest', ({ connectionId, request }) => void carol.manager.sendSignError(connectionId, request.sequence, 'Rejected in the wallet.'));
    const game = await visitor();
    await game.goto(origin + '/play');
    await game.locator('.wallet-shortcut').first().waitFor({ timeout: 60_000 });
    await game.locator('.wallet-shortcut').first().dispatchEvent('click');
    await game.getByRole('button', { name: 'Selene Wallet', exact: true }).click();
    carol.manager.connect(await game.getByRole('link', { name: 'Open in wallet' }).getAttribute('href'));
    await game.getByRole('button', { name: 'Verify wallet now' }).waitFor({ timeout: 90_000 });
    await game.getByText('Not verified yet').first().waitFor();
    assert.equal((await state(game)).wallet, null);
    await game.context().close();
  });
  await check('a pay button without a connected wallet opens the wallet dialog, and once the wallet connects the checkout follows by itself', async () => {
    const dave = makeWallet('Test wallet D (SDK)');
    const game = await visitor();
    const box = game.locator('dialog#dialog');
    await game.goto(paidOrigin + '/play');
    await box.getByRole('heading', { name: 'Found a city', exact: true }).waitFor({ timeout: 60_000 });
    await box.getByLabel('Commander name', { exact: true }).fill('Warden Dave');
    await box.getByLabel('Settlement name', { exact: true }).fill('Davenport');
    await box.getByRole('button', { name: 'Found city', exact: true }).click();
    await box.getByRole('heading', { name: 'Welcome to VaultBorn', exact: true }).waitFor();
    await box.getByRole('button', { name: 'Skip', exact: true }).click();
    await box.getByRole('heading', { name: 'Connect your wallet', exact: true }).waitFor();
    await box.getByRole('button', { name: 'Not now', exact: true }).click();
    const fund = async () => {
      await game.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Vault', exact: true }).click();
      await game.locator('#campaign').getByRole('button', { name: 'Fund War Chest', exact: true }).click();
      await box.getByRole('checkbox').check();
      await box.getByRole('button', { name: 'Create payment intent', exact: true }).click();
    };
    await fund();
    await box.getByRole('heading', { name: 'Chipnet wallet', exact: true }).waitFor();
    assert.match(await box.innerText(), /Connect your wallet first/);
    assert.equal(((await state(game)).payments ?? []).length, 0, 'no checkout without a connected wallet');
    await box.getByRole('button', { name: 'Selene Wallet', exact: true }).click();
    dave.manager.connect(await box.getByRole('link', { name: 'Open in wallet' }).getAttribute('href'));
    // Connected and verified in the wallet dialog: the War Chest checkout that asked for the wallet opens by itself.
    await box.getByRole('heading', { name: 'War chest funding', exact: true }).waitFor({ timeout: 90_000 });
    const after = await state(game);
    assert.equal(after.wallet.address, dave.first.address);
    assert.deepEqual(after.payments.map(item => item.action), ['war-chest']);
    // Connected now: the same button goes straight to the checkout.
    await box.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await fund();
    await box.getByRole('heading', { name: 'War chest funding', exact: true }).waitFor();
    assert.equal(await box.getByRole('button', { name: 'Approve with wallet', exact: true }).count(), 1);
    assert.deepEqual(dave.seen.errors, []);
    await game.context().close();
  });
  await check('no page raised a script error', async () => { assert.deepEqual(pageErrors, []); });
} catch (error) { failure = error; }
await browser.close();
app.close(); paidApp.close(); relay.close();
const evidence = process.argv[2];
if (evidence) writeFileSync(evidence, JSON.stringify({ suite: 'connect wallet (start page and game) with the WizardConnect wallet SDK', at: new Date().toISOString(),
  note: 'The official WizardConnect wallet SDK applying Selene\'s signing rule, over a relay inside the test. Payments made with Selene itself on Mainnet are in docs/MAINNET_TRANSACTIONS.md.', passed, failed: failure ? String(failure.message).slice(0, 400) : null }, null, 2) + '\n');
if (failure) { console.error('FAILED after ' + passed.length + ' checks:\n' + (failure.stack ?? failure)); process.exit(1); }
console.log(passed.length + ' of ' + passed.length + ' checks passed.');
process.exit(0);
