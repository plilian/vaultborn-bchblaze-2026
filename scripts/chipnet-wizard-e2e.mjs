import './support/chipnet-only.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deriveHdPath, deriveHdPathRelative, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeHdPublicKey } from '@bitauth/libauth';
import { WalletConnectionManager } from '@wizardconnect/wallet';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { hex, readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';

const fixture = process.env.CHIPNET_FIXTURE_FILE;
if (!fixture || process.env.CHIPNET_TEST_APPROVE !== 'true') throw new Error('Set CHIPNET_TEST_APPROVE=true with a funded disposable Chipnet fixture.');
const keys = JSON.parse(await readFile(fixture, 'utf8'));
const root = deriveHdPrivateNodeFromSeed(randomBytes(32));
const external = deriveHdPath(root, "m/44'/145'/0'");
const branch = path => deriveHdPathRelative(external, String(path));
const child = (path, index) => deriveHdPathRelative(branch(path), String(index));
const addressKey = hex(child(0,0).privateKey);
const wallet = walletFromPrivateKey(addressKey);
const dir = await mkdtemp(resolve('var', 'wizard-chipnet-'));
await writeFile(resolve(dir,'fixture.key'), addressKey, {mode:0o600});
const usePublicRelay = process.env.WIZARD_TEST_RELAY === 'public';
const pairOnly = process.argv.includes('--pair-only');
const evidence = { network:'chipnet', relay:usePublicRelay ? 'public' : 'loopback', fixtureAddress:wallet.address, startedAt:new Date().toISOString() };
const save = () => writeFile(resolve(dir,'receipts.json'), JSON.stringify(evidence,null,2) + '\n');
const chain = createChain({ treasuryPrivateKey:keys.treasury.priv });
let funding;
if (!pairOnly) {
  funding = await chain.sendWithLocalKey(keys.player.priv,wallet.address,8000);
  evidence.funding = { txid:funding.txid, feeSatoshis:funding.feeSatoshis };
  await save();
  console.log('Funded the official SDK fixture wallet:', funding.txid);
  const deadline = Date.now() + 10 * 60_000;
  let funded = false;
  while (Date.now() < deadline) {
    const result = await chain.verifyPublishedTransaction(funding.txid).catch(() => null);
    if (result?.confirmations > 0) { funded = true; break; }
    await delay(8_000);
  }
  assert.ok(funded, 'Fixture funding did not confirm.');
}

async function createLoopbackRelay() {
  const server = new WebSocketServer({ port:0, host:'127.0.0.1' });
  await once(server,'listening');
  const subscribers = new Map();
  const events = new Map();
  const qualifies = (event, filter) =>
    (!filter.kinds || filter.kinds.includes(event.kind)) && (!filter.since || event.created_at >= filter.since) &&
    (!filter['#p'] || event.tags.some(tag => tag[0] === 'p' && filter['#p'].includes(tag[1])));
  const send = (socket, data) => { if (socket.readyState === 1) socket.send(JSON.stringify(data)); };
  server.on('connection', socket => {
    const subscriptions = new Map();
    subscribers.set(socket,subscriptions);
    socket.on('close', () => subscribers.delete(socket));
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      const [type,value,...filters] = message;
      if (type === 'EVENT') {
        if (!value?.id || !Array.isArray(value.tags)) return;
        if (!events.has(value.id)) {
          events.set(value.id, value);
          for (const [recipient, lists] of subscribers) {
            for (const [id, active] of lists) if (active.some(filter => qualifies(value,filter))) send(recipient,['EVENT',id,value]);
          }
        }
        send(socket,['OK',value.id,true,'']);
      } else if (type === 'REQ') {
        subscriptions.set(value,filters);
        for (const event of events.values()) if (filters.some(filter => qualifies(event, filter))) send(socket,['EVENT',value,event]);
        send(socket,['EOSE',value]);
      } else if (type === 'CLOSE') subscriptions.delete(value);
    });
  });
  return server;
}

const localRelay = usePublicRelay ? null : await createLoopbackRelay();
const app = createApp({ database:':memory:', chain,
  testWizardRelay:localRelay ? 'ws://127.0.0.1:' + localRelay.address().port : undefined });
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const base = 'http://127.0.0.1:' + app.server.address().port;
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath:process.env.DOMINION_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined),
  env:{ ...process.env, TEMP:dir, TMP:dir, TMPDIR:dir }, args:['--disable-crash-reporter','--disable-breakpad','--disable-background-networking'] });
const manager = new WalletConnectionManager({
  walletName:'VAULTBORN disposable Chipnet fixture', walletIcon:'',
  getRelayPrivateKey:() => randomBytes(32),
  getXpub:path => encodeHdPublicKey({ network:'mainnet', node:deriveHdPublicNode(branch(path)) }).hdPublicKey,
  getPublicKey:(path,index) => deriveHdPublicNode(child(path,index)).publicKey,
  signTransaction:async () => { throw new Error('Sign requests require the test approval handler.'); },
});
let walletError;
manager.on('pendingSignRequest', ({connectionId,request}) => {
  void (async () => {
    try {
      const details = request.transaction;
      assert.equal(details.broadcast,false);
      assert.match(details.userPrompt,/VAULTBORN Chipnet/);
      assert.deepEqual(request.inputPaths,[[0,'receive',0]]);
      const source = details.sourceOutputs[0];
      assert.equal(source.outpointTransactionHash,funding.txid);
      assert.equal(source.lockingBytecode,wallet.script);
      const unsigned = readTransaction(details.transaction).transaction;
      const outputs = unsigned.outputs.map(output => ({script:hex(output.lockingBytecode),satoshis:Number(output.valueSatoshis)}));
      assert.equal(outputs[0].satoshis,2250);
      assert.equal(outputs[1].satoshis,900);
      assert.equal(outputs[2].satoshis,675);
      assert.equal(outputs[3].satoshis,675);
      assert.match(outputs[3].script,/^6a045642524e/);
      const signed = signSpend({ sources:[{ script:wallet.script, satoshis:8000, txid:funding.txid, vout:source.outpointIndex }],
        outputs, privateKey:addressKey, requireUtxos:true });
      evidence.approval = { txid:signed.txid, signedInputCount:1, protocol:'hdwalletv1', feeSatoshis:signed.feeSatoshis };
      await save();
      await manager.sendSignResponse(connectionId, request.sequence, signed.rawHex);
    } catch (error) {
      walletError = error;
      await manager.sendSignError(connectionId,request.sequence,error.message);
    }
  })();
});

let page;
try {
  page = await browser.newPage();
  await page.goto(base);
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'My City',exact:true}).click();
  await page.getByRole('button',{name:/City Hall Level/}).click();
  const dialog = page.locator('dialog');
  await dialog.getByRole('button',{name:'Upgrade with BCH · 0.00004500 BCH',exact:true}).click();
  await dialog.getByRole('button',{name:'Other WizardConnect wallet',exact:true}).click();
  const uri = await dialog.getByRole('link',{name:'Open in wallet'}).getAttribute('href');
  assert.match(uri,/^wiz:\/\//);
  manager.connect(uri);
  await dialog.getByText('VAULTBORN disposable Chipnet fixture',{exact:true}).waitFor({timeout:60_000});
  evidence.paired = true;
  await save();
  if (pairOnly) {
    console.log('The browser and official WizardConnect wallet paired.');
  } else {
    await dialog.getByRole('button',{name:'Approve with wallet',exact:true}).click();
    await page.waitForResponse(response => response.url().endsWith('/wallet/broadcast') && response.ok(), { timeout:100_000 });
    const txid = evidence.approval.txid;
    assert.ifError(walletError);
    console.log('Official WizardConnect wallet approved',txid);
    const settle = Date.now() + 10 * 60_000;
    while (Date.now() < settle) {
      await app.ledger.reconcile();
      const paid = app.store.payments().find(row => row.txid === txid);
      if (paid?.state === 'credited') {
        assert.equal(paid.fulfillment.status,'applied');
        evidence.confirmed = { txid, confirmations:paid.receipt.confirmations, blockHash:paid.receipt.blockHash,
          height:paid.receipt.height, eventVout:paid.receipt.eventVout };
        break;
      }
      await delay(8_000);
    }
    assert.ok(evidence.confirmed,'The wallet-approved transaction did not reach the game threshold.');
    await save();
    console.log('WizardConnect Chipnet checkout confirmed and fulfilled.');
  }
} finally {
  if (page && !page.isClosed()) {
    await page.evaluate(async () => { await (await import('/ritual-wallet.js')).closeWizard(); }).catch(() => undefined);
  }
  manager.disconnectAll();
  await delay(1200);
  for (const socket of localRelay?.clients ?? []) socket.terminate();
  localRelay?.close();
  await browser.close();
  const closed = once(app.server,'close');
  app.close();
  await closed;
}
