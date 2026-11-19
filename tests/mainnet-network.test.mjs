// Network isolation and the Mainnet start conditions. A process works on one network for its whole life, so every case
// here runs a child process with its own VAULTBORN_NETWORK. Nothing contacts a public network: the chain is the
// in-memory fixture.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(VAULTBORN_|CHIPNET_|MAINNET_|DOMINION_)/.test(name)));
const run = (code, env = {}) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: { ...clean, NODE_NO_WARNINGS: '1', ...env }, encoding: 'utf8' });
  return { ...result, json: () => JSON.parse(result.stdout.trim().split('\n').at(-1)) };
};
const MAINNET = { VAULTBORN_NETWORK: 'mainnet' };
const READY = { ...MAINNET, VAULTBORN_MAINNET_ACK: 'real-bch', DOMINION_HTTPS: 'true', MAINNET_ATTESTOR_OPERATION: 'independent' };
const fixture = `import { covenantNode, key } from './tests/support/covenant-node.mjs';
import { walletFromPrivateKey } from './packages/chain-observer/index.mjs';
const three = [651, 652, 653].map(n => walletFromPrivateKey(key(n)).publicKey);`;

test('addresses, the identifying block and contract addresses follow the network; contract scripts do not', () => {
  const probe = `import { walletFromPrivateKey, decodeAddress } from './packages/chain-observer/index.mjs';
    import { NETWORK_CHECKPOINT } from './packages/chain-observer/transports.mjs';
    import { kingdomVault } from './packages/chain-observer/kingdom-vault.mjs';
    import { NETWORK_ID } from './config/network.mjs';
    const k = n => n.toString(16).padStart(64, '0');
    const wallet = walletFromPrivateKey(k(7));
    const chest = kingdomVault({ id:'ab'.repeat(16), operatorKey:walletFromPrivateKey(k(8)).publicKey, ownerKey:wallet.publicKey, attestors:[walletFromPrivateKey(k(9)).publicKey], revision:4, capturePercent:100, exitDelay:288 });
    const refuse = address => { try { decodeAddress(address); return false; } catch { return true; } };
    console.log(JSON.stringify({ id:NETWORK_ID, address:wallet.address, script:wallet.script, chestScript:chest.script, chestAddress:chest.address, checkpoint:NETWORK_CHECKPOINT,
      other:refuse(process.env.OTHER), own:refuse(wallet.address), bare:refuse(wallet.address.split(':')[1]) }));`;
  const chipnet = run(probe, { OTHER: 'bitcoincash:qp0n87ssed2xdcurhc4w9y3u6eaj0k53lvaa66phfm' }).json();
  const mainnet = run(probe, { ...MAINNET, OTHER: chipnet.address }).json();
  assert.deepEqual([chipnet.id, mainnet.id], ['chipnet', 'mainnet']);
  assert.match(chipnet.address, /^bchtest:/);
  assert.match(mainnet.address, /^bitcoincash:/);
  assert.match(mainnet.chestAddress, /^bitcoincash:p/);
  // The same keys give the same scripts on both networks: what was tested on one is the contract of the other.
  assert.deepEqual([mainnet.script, mainnet.chestScript], [chipnet.script, chipnet.chestScript]);
  // An address of the other network, and an address without its prefix, are refused; the own one is accepted.
  assert.deepEqual([chipnet.other, chipnet.own, chipnet.bare, mainnet.other, mainnet.own, mainnet.bare], [true, false, true, true, false, true]);
  assert.deepEqual(mainnet.checkpoint, { height: 661648, hash: '0000000000000000029e471c41818d24b8b74c911071c4ef0b4a0509f9b5a8ce' });
  assert.equal(chipnet.checkpoint.height, 302144);
  assert.match(run('import "./config/network.mjs";', { VAULTBORN_NETWORK: 'testnet' }).stderr, /must be "chipnet" or "mainnet"/);
});

test('on Mainnet the server refuses to start until every condition holds and the owner has authorised it', () => {
  const start = options => `${fixture}
    try { const node = await covenantNode(${options}); const config = await (await fetch('http://127.0.0.1:' + node.app.server.address().port + '/api/health')).json();
      const browser = await (await fetch('http://127.0.0.1:' + node.app.server.address().port + '/network.js')).text();
      console.log(JSON.stringify({ started:true, network:config.network, browser })); node.app.close(); process.exit(0); }
    catch (error) { console.log(JSON.stringify({ started:false, message:error.message })); }`;
  // No authorisation, one attestor, nobody named as running the attestors, reachable from outside without TLS: refused, with every reason listed at once.
  const bare = run(start('{}'), { ...MAINNET, HOST: '0.0.0.0' }).json();
  assert.equal(bare.started, false);
  for (const reason of [/has not authorised Mainnet/, /DOMINION_HTTPS must be true/, /at least two independent attestor/, /must say who runs the attestors/]) assert.match(bare.message, reason);
  // Everything in place except the owner's word: still refused, for that one reason.
  const waiting = run(start('{ attestors:three }'), { ...MAINNET, DOMINION_HTTPS: 'true', MAINNET_ATTESTOR_OPERATION: 'independent' }).json();
  assert.equal(waiting.started, false);
  assert.match(waiting.message, /^Mainnet start refused:\n - The owner has not authorised Mainnet[^\n]*$/);
  // An attestor that is the game key itself is not independent.
  const same = run(start(`{ attestors:[three[0], walletFromPrivateKey(key(600)).publicKey] }`), READY).json();
  assert.match(same.message, /attestor must not be the game automation key|An attestor key equals the game automation key/);
  // Authorised and complete: it starts, reports Mainnet and tells the browser so.
  const ready = run(start('{ attestors:three }'), READY).json();
  assert.deepEqual([ready.started, ready.network], [true, 'mainnet']);
  assert.match(ready.browser, /"id":"mainnet","label":"Mainnet","prefix":"bitcoincash"/);
  assert.match(ready.browser, /"realValue":true/);
  assert.match(ready.browser, /"attestorOperation":"independent"/);
  // Owner-operated attestors are a declared mode: it starts, and every description says they are not independent.
  const owner = run(start('{ attestors:three }'), { ...READY, MAINNET_ATTESTOR_OPERATION: 'owner', DOMINION_HTTPS: '', HOST: '127.0.0.1' }).json();
  assert.equal(owner.started, true);
  assert.match(owner.browser, /"attestorAdjective":"owner-operated"/);
  assert.match(owner.browser, /run by the game's operator, not by independent parties/);
});

test('test keys, test tools and test data cannot reach Mainnet', () => {
  // Any Chipnet setting next to VAULTBORN_NETWORK=mainnet is a refusal, not a warning.
  const mixed = run(`import { assertNetworkEnvironment } from './config/network.mjs'; try { assertNetworkEnvironment(); console.log('"accepted"'); } catch (error) { console.log(JSON.stringify(error.message)); }`,
    { ...READY, CHIPNET_TREASURY_PRIVATE_KEY: '11'.repeat(32), CHIPNET_ELECTRUM_HOST: 'chipnet.imaginary.cash:50002' }).json();
  assert.match(mixed, /Chipnet settings are present: CHIPNET_ELECTRUM_HOST, CHIPNET_TREASURY_PRIVATE_KEY/);
  // Mainnet keys are read from MAINNET_ variables only; a Chipnet process never sees them.
  const names = run(`import { networkEnv } from './config/network.mjs'; console.log(JSON.stringify([networkEnv('DEVELOPMENT_ADDRESS') ?? null]));`,
    { MAINNET_DEVELOPMENT_ADDRESS: 'bitcoincash:x', CHIPNET_DEVELOPMENT_ADDRESS: 'bchtest:y' }).json();
  assert.deepEqual(names, ['bchtest:y']);
  // Every Chipnet test tool stops before it does anything.
  for (const tool of ['scripts/chipnet-covenants-e2e.mjs', 'scripts/chipnet-wallet.mjs', 'scripts/chipnet-covenant-fixture.mjs', 'scripts/configure-territory-chipnet.mjs']) {
    const result = spawnSync(process.execPath, [tool], { cwd: new URL('..', import.meta.url), env: { ...clean, ...READY, NODE_NO_WARNINGS: '1', CHIPNET_TEST_APPROVE: 'true' }, encoding: 'utf8' });
    assert.notEqual(result.status, 0, tool);
    assert.match(result.stderr, /Chipnet test tool with disposable keys/, tool);
  }
  // A database that holds Chipnet payments is refused by a Mainnet server, and the reverse.
  const database = join(mkdtempSync(join(tmpdir(), 'vb-net-')), 'game.sqlite');
  const seed = `${fixture}
    const node = await covenantNode({ attestors:three, database:${JSON.stringify(database)} }); node.seat('p1');
    node.edit(world => { world.cities.p1.tutorial = true; });
    const quote = node.app.ledger.create('p1', { type:'war-chest', satoshis:10_000, consent:true });
    console.log(JSON.stringify({ network:quote.network, address:quote.outputs?.[0]?.address ?? quote.address })); node.app.close(); process.exit(0);`;
  const made = run(seed).json();
  assert.equal(made.network, 'chipnet');
  assert.match(made.address, /^bchtest:/);
  const reuse = run(`${fixture}
    try { await covenantNode({ attestors:three, database:${JSON.stringify(database)} }); console.log('"started"'); } catch (error) { console.log(JSON.stringify(error.message)); }`, READY).json();
  assert.match(reuse, /holds payments of another network \(chipnet\)/);
});

test('a Mainnet checkout pays Mainnet addresses with the exact final split', () => {
  const result = run(`${fixture}
    const node = await covenantNode({ attestors:three }); node.seat('p1');
    node.edit(world => { world.cities.p1.tutorial = true; });
    const quote = node.app.ledger.create('p1', { type:'premium', building:'hall' });
    console.log(JSON.stringify({ network:quote.network, price:quote.satoshis, outputs:quote.outputs.map(output => [output.role, output.satoshis, output.address ?? null]) }));
    node.app.close(); process.exit(0);`, READY).json();
  assert.equal(result.network, 'mainnet');
  const paid = Object.fromEntries(result.outputs.map(([role, satoshis]) => [role, satoshis]));
  assert.deepEqual([result.price, paid.warChest, paid.development, paid.burn], [22_000, 11_000, 4_400, 2_200]);
  assert.equal(paid.prize, 4_400 + 300, 'the prize share travels with its 300-satoshi network reserve');
  for (const [role, , address] of result.outputs) if (address) assert.match(address, /^bitcoincash:/, role);
});
