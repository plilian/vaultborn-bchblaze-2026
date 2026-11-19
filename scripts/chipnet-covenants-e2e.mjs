// Live Chipnet rehearsal of the final economy: the 50/20/20/10 service payment straight into the War Chest, the season pool,
// a direct deposit, a MATCHED-STAKES paid raid settled by the attestor, the owner's exit, a territory claim, a paid
// political operation with its proof record, and (optionally) a sponsorship. It spends Chipnet test coins and broadcasts
// real transactions.
//
// THIS SCRIPT HAS NOT BEEN EXECUTED. It was written with the contracts and validated on Regtest only. Until its owner
// runs it there is no Chipnet evidence for these workflows.
//
// Fixture (JSON, disposable test keys only):
//   { "treasury": { "priv": "<hex>" }, "attestor": { "priv": "<hex>" }, "developer": { "address": "bchtest:..." },
//     "player": { "priv": "<hex>" }, "rival": { "priv": "<hex>" } }
// Fund the player key with about 90,000 test satoshis and the rival key with about 60,000 (25,100,000 more on the
// player key adds the sponsorship step). The attestor key stands in for an independent party in this rehearsal; it runs
// the same checks as scripts/prize-attest.mjs before it signs.
//   CHIPNET_FIXTURE_FILE=var/covenant-keys.json CHIPNET_TEST_APPROVE=true node scripts/chipnet-covenants-e2e.mjs
import './support/chipnet-only.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, signWalletChallenge, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { signAttestorRequest } from '../packages/chain-observer/index.mjs';
import { signChestExit } from '../packages/chain-observer/kingdom-vault.mjs';
import { planStakeSpend, signStakeDigest } from '../packages/chain-observer/stake-escrow.mjs';
import { signRaidDigest } from '../packages/chain-observer/matched-raid.mjs';
import { checkRaid } from './attestor-review.mjs';

const path = process.env.CHIPNET_FIXTURE_FILE;
if (!path || process.env.CHIPNET_TEST_APPROVE !== 'true') throw new Error('A funded disposable Chipnet fixture and CHIPNET_TEST_APPROVE=true are required.');
const keys = JSON.parse(await readFile(path, 'utf8'));
for (const role of ['treasury', 'attestor', 'player', 'rival']) if (!/^[0-9a-f]{64}$/.test(keys[role]?.priv ?? '')) throw new Error('The fixture needs a hex key for ' + role + '.');
if (!keys.developer?.address?.startsWith('bchtest:')) throw new Error('The fixture needs a Chipnet developer address.');
const wallets = { p1: walletFromPrivateKey(keys.player.priv), p2: walletFromPrivateKey(keys.rival.priv) };
const secrets = { p1: keys.player.priv, p2: keys.rival.priv };
const attestor = walletFromPrivateKey(keys.attestor.priv);
const chain = createChain({ treasuryPrivateKey: keys.treasury.priv, minConfirmations: 2, electrumHost: process.env.CHIPNET_ELECTRUM_HOST,
  developmentAddress: keys.developer.address, prizeAttestors: [attestor.publicKey] });
const dir = await mkdtemp(resolve('var', 'covenants-chipnet-'));
const receiptsPath = resolve(dir, 'receipts.json');
const receipt = { network: 'chipnet', started: new Date().toISOString(), wallets: { player: wallets.p1.address, rival: wallets.p2.address }, steps: [] };
const save = () => writeFile(receiptsPath, JSON.stringify(receipt, null, 2) + '\n');
let offset = 0;
const app = createApp({ database: resolve(dir, 'world.sqlite'), chain, clock: () => Date.now() + offset, localDemo: true });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const base = 'http://127.0.0.1:' + app.server.address().port;
function client() {
  let cookie = null;
  return async (route, body, expected = 200) => {
    const response = await fetch(base + '/api/' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    const result = await response.json();
    assert.equal(response.status, expected, route + ' ' + JSON.stringify(result.error ?? result));
    return result;
  };
}
const api = { p1: client(), p2: client() };
const note = (step, row, extra = {}) => {
  receipt.steps.push({ step, action: row.action, txid: row.txid, satoshis: row.satoshis, feeSatoshis: row.feeSatoshis ?? null, state: row.state,
    explorer: 'https://chipnet.imaginary.cash/tx/' + row.txid, ...extra });
  console.log('CONFIRMED', step, row.txid);
  return save();
};
// Reconciles until `find` returns a credited row, or fails after 40 minutes.
async function until(step, find, extra) {
  const deadline = Date.now() + 40 * 60_000;
  while (Date.now() < deadline) {
    await app.ledger.reconcile();
    const row = find(app.store.payments());
    if (row?.state === 'credited') { await note(step, row, extra?.(row)); return row; }
    assert.ok(!['rejected', 'reorg', 'voided'].includes(row?.state), step + ': ' + JSON.stringify(row?.lastError));
    await delay(8000);
  }
  throw new Error('Confirmation timeout: ' + step);
}
async function pay(who, body, step) {
  const { result: intent } = await api[who]('payments', body, 201);
  const signed = await chain.sendOutputsWithLocalKey(secrets[who], intent.outputs);
  console.log('BROADCAST', step, signed.txid);
  return until(step, rows => rows.find(row => row.id === intent.id), row => ({ outputs: row.receipt.allocations?.map(({ role, satoshis, vout, address }) => ({ role, satoshis, vout, address })) }));
}

try {
  for (const who of ['p1', 'p2']) {
    await api[who]('session', { demo: who });
    const { result: challenge } = await api[who]('wallet/challenge', { address: wallets[who].address });
    const proof = signWalletChallenge(secrets[who], challenge.challenge);
    await api[who]('wallet/verify', { address: wallets[who].address, publicKey: proof.publicKey, signature: proof.signature });
    await api[who]('command', { type: 'tutorial' });
  }
  console.log('Writing receipts to', receiptsPath);
  // Stake settlements are proposals: the outcome panel signs them. With one attestor the panel is the game key and that
  // attestor. This rehearsal signs as the attestor every few seconds; a real attestor runs scripts/prize-attest.mjs instead,
  // which replays the battle first.
  const pins = {};
  const attestStakes = async () => {
    for (const item of app.ledger.pendingAwards().filter(entry => entry.kind === 'stake' && !entry.signed.includes(attestor.publicKey))) {
      const plan = planStakeSpend(item.sources[0], { lane: item.lane, payee: item.payeeScript ?? undefined, eventScript: item.eventScript ?? undefined });
      await app.ledger.attestAward(item.id, { publicKey: attestor.publicKey, signatures: [signStakeDigest(plan, keys.attestor.priv)] });
      receipt.steps.push({ name: 'territory stake outcome signed by the attestor', proposal: item.id, lane: item.lane });
    }
    // A matched raid: the attestor replays the battle and rebuilds the settlement exactly as the attestor tool does.
    for (const item of app.ledger.pendingAwards().filter(entry => entry.kind === 'raid' && !entry.signed.includes(attestor.publicKey))) {
      const evidence = app.ledger.evidence(item.id, { publicKey: attestor.publicKey, signature: signAttestorRequest(item.id, keys.attestor.priv) });
      const review = checkRaid({ item, evidence, pins, me: attestor.publicKey });
      receipt.steps.push({ name: 'matched raid reviewed by the attestor', proposal: item.id, lane: item.lane, battle: review.battle ?? null, problems: review.problems });
      if (review.problems.length) continue;
      Object.assign(pins, review.log);
      await app.ledger.attestAward(item.id, { publicKey: attestor.publicKey, signatures: review.digests.map(digest => signRaidDigest(digest, keys.attestor.priv)) });
    }
  };
  const attesting = setInterval(() => attestStakes().catch(error => console.error('attest:', error.message)), 5_000);
  attesting.unref();

  // 1. Service payments: 50% straight into the payer's War Chest, 20% developer address, 20% season pool feeder (+300
  //    reserve), 10% burned. One purchase is a War Chest that covers the smallest stake.
  const services = [await pay('p1', { type: 'premium', building: 'hall' }, 'service payment (player)'), await pay('p2', { type: 'premium', building: 'hall' }, 'service payment (rival)')];
  for (const row of services) {
    assert.deepEqual(row.receipt.allocations.map(item => [item.role, item.satoshis]), [['warChest', 11_000], ['development', 4_400], ['prize', 4_700], ['burn', 2_200]]);
    assert.equal(row.receipt.allocations[1].address, keys.developer.address);
    assert.equal(row.receipt.allocations[0].kv.revision, 4, 'the War Chest share is an output of the payer\'s own matched-stakes chest');
  }
  // 2. The keyless move: both reward shares join the season pool. The fee comes from the payers' reserves.
  await until('keyless feeder move into the season pool', rows => rows.find(row => row.action === 'allocation-sweep'),
    row => ({ sweepOutputs: row.sweepOutputs.map(({ role, satoshis, vout, address }) => ({ role, satoshis, vout, address })) }));
  assert.ok(app.ledger.explorer().buckets.prize >= 8_800);
  const mine = await api.p1('vault');
  assert.deepEqual([mine.warChestSatoshis, mine.pendingChestSatoshis, mine.capturableSatoshis], [11_000, 0, 11_000]);

  // 3. Direct deposit: the rival's wallet adds 20,000 satoshis to the War Chest. No split, at risk at once.
  const chest = await pay('p2', { type: 'war-chest', satoshis: 20_000, consent: true }, 'war chest funding');
  assert.equal((await api.p2('vault')).warChestSatoshis, 31_000);
  receipt.steps.at(-1).chest = chest.receipt.allocations[0].kv;

  // 4. Matched raid: the player stakes 10,000 against the rival, whose War Chest covers it. The preview is recorded and
  //    compared with what the settlement really pays.
  const { raid: preview } = await api.p1('attack-preview?target=p2&stake=10000');
  assert.equal(preview.eligible, true, preview.reason);
  const raid = await pay('p1', { type: 'attack-paid', target: 'p2', stake: 10_000 }, 'matched raid stake escrow');
  assert.deepEqual(raid.receipt.allocations.map(item => [item.role, item.satoshis]), [['escrow', preview.totalPaymentSatoshis], ['event', 0]]);
  const settled = await until('matched raid settlement', rows => rows.find(row => row.settles === raid.id && !['expired', 'rejected'].includes(row.state)),
    row => ({ lane: row.lane, feeSatoshis: row.feeSatoshis, inputs: row.sources.length, outputs: row.layout }));
  const expected = settled.lane === 'attacker-wins' ? preview.win : settled.lane === 'defender-wins' ? preview.loss : preview.void;
  const received = settled.layout.filter(item => item.script === wallets.p1.script).reduce((sum, item) => sum + item.satoshis, 0);
  assert.equal(received, expected.receiveSatoshis, 'the attacker receives exactly what was previewed for this outcome');
  receipt.steps.at(-1).previewed = expected;
  console.log('Raid outcome lane:', settled.lane, '· attacker received', received);

  // 5. Independent exit, step one: the rival moves the largest War Chest output, whole, into its exit script with the wallet
  //    key alone; the fee comes from the rival's own wallet. Step two needs 288 blocks (about two days) and is covered on Regtest.
  const spent = new Set(app.store.payments().filter(row => row.direction === 'outgoing').flatMap(row => (row.sources ?? []).map(source => source.txid + ':' + source.vout)));
  const outputs = app.store.payments().flatMap(row => row.state === 'credited' ? [...(row.changes ?? []).map(item => ({ ...item, txid: row.txid })), ...(row.receipt?.allocations ?? [])] : [])
    .filter(item => item.kv?.revision === 4 && !item.kv.exiting && item.kv.ownerKey === wallets.p2.publicKey && !spent.has(item.txid + ':' + item.vout)).sort((a, b) => b.satoshis - a.satoshis);
  const coins = (await chain.walletCoins([{ script: wallets.p2.script }])).filter(Boolean).filter(coin => coin.satoshis >= 1_500);
  if (outputs.length && coins.length) {
    const exit = signChestExit([outputs[0]], secrets.p2, { fee: coins[0] });
    await chain.broadcast(exit.rawHex);
    receipt.steps.push({ name: 'owner exit, step one (wallet key only, whole output)', txid: exit.txid, exitOutput: exit.exits[0] });
    await until('the ledger follows the owner\'s exit', rows => rows.find(row => row.action === 'chest-exit'), row => ({ exiting: row.satoshis }));
  } else console.log('No live War Chest output or no wallet coin for the exit fee was left for the exit step.');

  // 6. Territory: an open claim in an escrow that always keeps at least half for the claimant. The game clock is moved
  //    past the contest window.
  const { territories } = await api.p1('state');
  const site = territories.find(item => item.category !== 'rare' && !item.owner);
  if (site) {
    const claim = await pay('p1', { type: 'territory-claim', territory: site.id }, 'territory claim escrow');
    assert.equal(claim.satoshis, 6_600);
    offset += Math.max(0, (claim.fulfillment?.result?.endsAt ?? Date.now()) - Date.now() - offset) + 1_000;
    await until('territory claim settlement', rows => rows.find(row => row.settles === claim.id), row => ({ lane: row.lane }));
  } else console.log('No open territory was found for a claim.');

  // 7. Paid political operation: a treaty charter. Its proof record is published from the record reserve the payer locked.
  const { result: offer } = await api.p1('command', { type: 'diplomacy-treaty-propose', target: 'p2', kind: 'non-aggression', durationHours: 48, terms: {} });
  const { result: treaty } = await api.p2('command', { type: 'diplomacy-treaty-respond', id: offer.id, accept: true, termsHash: offer.proposal.termsHash, version: offer.proposal.version });
  const charter = await pay('p1', { type: 'political-operation', operation: 'attest', treaty: treaty.id, consent: true }, 'treaty charter (paid political operation)');
  assert.deepEqual(charter.receipt.allocations.map(item => [item.role, item.satoshis]), [['warChest', 10_000], ['development', 4_000], ['prize', 4_300], ['record', 576], ['burn', 2_000]]);
  await until('political proof record paid from its record reserve', rows => rows.find(row => row.politicalAnchor === 'po-' + charter.id), row => ({ feeSatoshis: row.feeSatoshis }));

  // 8. Optional sponsorship: 30% to the developer address, 70% into the prize fund covenant.
  if (await chain.localWalletBalance(wallets.p1.address) >= 25_020_000) {
    const funded = await pay('p1', { type: 'sponsor-fund', satoshis: 25_000_000, consent: true }, 'sponsorship 30/70 into the prize fund covenant');
    assert.deepEqual(funded.receipt.allocations.map(item => [item.role, item.satoshis]), [['prize', 17_500_000], ['development', 7_500_000], ['event', 0]]);
    assert.equal(funded.receipt.allocations[1].address, keys.developer.address);
  } else console.log('Sponsorship skipped: it needs 0.2502 test BCH on the player key.');

  console.log('Not exercised live by this script (time locks or season end): prize awards, sponsor refund, raffle return, a game-key withdrawal (the output must be 144 blocks old), the second step of the owner exit, and whichever raid outcome this battle did not produce. See the Regtest evidence.');
  receipt.custody = app.ledger.explorer().custody;
  receipt.buckets = app.ledger.explorer().buckets;
  receipt.finished = new Date().toISOString();
  receipt.result = 'PASS';
  await save();
  console.log('All covenant workflows in this script confirmed on Chipnet. Receipts:', receiptsPath);
} catch (error) {
  receipt.result = 'FAIL';
  receipt.error = error.message;
  await save();
  console.error('Stopped:', error.message, '\nPartial receipts:', receiptsPath);
  process.exitCode = 1;
} finally {
  const closed = once(app.server, 'close');
  app.close();
  await closed;
}
