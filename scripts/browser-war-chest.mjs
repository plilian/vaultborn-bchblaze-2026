// Browser check of the War Chest economy screens against a real game server on the enforcing fixture node.
// It runs the real client in Chromium. Payments are signed by test keys in this process: no wallet app,
// no WizardConnect pairing and no Chipnet transaction is involved, and nothing here is Chipnet evidence.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { covenantNode, p1Wallet, wallets } from '../tests/support/covenant-node.mjs';
import { pairingEntry, seedPairing } from '../tests/support/paired-wallet.mjs';
import { NETWORK_ID } from '../config/network.mjs';

const output = resolve(process.env.DOMINION_BROWSER_OUTPUT ?? 'output/playwright');
await mkdir(output, { recursive:true });
const node = await covenantNode();
const { app, seat, edit, buy, mine, settle } = node;
const origin = 'http://127.0.0.1:' + app.server.address().port;
const browser = await chromium.launch({ executablePath:process.env.DOMINION_BROWSER_PATH || undefined });
const errors = [];
const passed = [];
const check = (name, run) => Promise.resolve(run()).then(() => { passed.push(name); console.log('ok   ' + name); });
const dialog = page => page.locator('dialog#dialog');
const text = async locator => (await locator.innerText()).replace(/\s+/g, ' ');

async function open(route) {
  const page = await browser.newPage({ viewport:{ width:1440, height:900 }, reducedMotion:'reduce' });
  await page.route('**/*', item => new URL(item.request().url()).hostname === '127.0.0.1' ? item.continue() : item.abort());
  await page.routeWebSocket('**/*', socket => { socket.close(); });
  // p1 paired its wallet on this browser earlier: the page opens with it connected, as a returning player's does.
  await seedPairing(page.context(), [pairingEntry('p1', NETWORK_ID, p1Wallet)]);
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  // The fixture node has no wallet balance reader, so the wallet asset and balance lookups answer 503 here. Every other server error fails the run.
  page.on('response', response => { if (response.status() >= 500 && !/\/api\/wallet\/(assets|balance)/.test(response.url())) errors.push(response.status() + ' ' + response.url()); });
  await page.goto(origin + route);
  await page.locator('#inspector h2').waitFor();
  return page;
}
async function raidDialog(page) {
  await page.getByRole('button', { name:/^Ironhaven level/ }).click({ force:true });
  await page.locator('#inspector').getByRole('button', { name:'Attack', exact:true }).click();
  await dialog(page).locator('[data-raid-stakes]').waitFor();
  return dialog(page);
}

try {
  let page = await open('/play?seat=p1');
  // The browser already holds p1's session. Its wallet is bound here with a test key, in place of a wallet-signed challenge.
  app.store.bindWallet('p1', wallets.p1.address, wallets.p1.publicKey, node.time());
  seat('p2');
  edit(world => { for (const id of ['p1', 'p2']) Object.assign(world.cities[id], { optIn:true, tutorial:true, shieldUntil:0 }); });
  await page.reload();
  await page.locator('#inspector h2').waitFor();
  const state = async () => page.evaluate(async () => (await fetch('/api/state')).json());

  await check('the server announces the 50/20/20/10 economy to the client', async () => {
    const { config, vault } = await state();
    assert.deepEqual(config.economy.serviceSplit, { warChest:50, prize:20, development:20, burn:10 });
    assert.equal(vault.warChestSatoshis, 0);
  });

  await check('a raid on an empty War Chest: the paid raid is not offered and there is nothing to tick to force it', async () => {
    const box = await raidDialog(page);
    const stakes = await text(box.locator('[data-raid-stakes]'));
    assert.match(stakes, /Paid raid: matched stakes/);
    assert.match(stakes, /Defender’s verified capturable War Chest 0 sats/);
    assert.match(stakes, /cannot cover the smallest stake/);
    assert.match(stakes, /A free raid uses the same combat rules and never moves BCH/);
    assert.equal(await box.getByRole('button', { name:/^Prepare paid raid/ }).isDisabled(), true);
    assert.equal(await box.locator('[name=acceptNoReward]').count(), 0, 'there is no override');
    assert.equal(await box.locator('select[name=stake]').count(), 0, 'no stake can be chosen against an empty War Chest');
    assert.equal(await box.getByRole('button', { name:'Launch free raid' }).isDisabled(), false, 'free play is unaffected');
    await page.screenshot({ path:resolve(output, 'war-chest-raid-empty.png') });
    await box.getByRole('button', { name:'Close dialog', exact:true }).click();
  });

  let terms;
  await check('against a funded War Chest the raid screen shows the stake, the matched exposure, the fees and what reaches the wallet', async () => {
    await buy('p2', { type:'war-chest', satoshis:60_000, consent:true });
    await settle();
    const box = await raidDialog(page);
    await box.locator('select[name=stake]').waitFor();
    assert.deepEqual(await box.locator('select[name=stake] option').evaluateAll(options => options.map(option => Number(option.value))), [10_000, 25_000, 50_000, 60_000]);
    // The attacker chooses S = 25,000.
    await box.locator('select[name=stake]').selectOption('25000');
    await page.waitForFunction(() => /Your stake \(S\)\s*25,000 sats/.test(document.querySelector('[data-raid-stakes]')?.innerText.replace(/\s+/g, ' ') ?? ''));
    edit(world => { terms = app.ledger.raidPreview(world, 'p1', 'p2', 25_000); });
    const stakes = await text(box.locator('[data-raid-stakes]'));
    const n = value => value.toLocaleString('en-US');
    assert.match(stakes, /Your stake \(S\) 25,000 sats/);
    assert.match(stakes, /Defender’s matched exposure \(S\) 25,000 sats/);
    assert.match(stakes, /Defender’s verified capturable War Chest 60,000 sats/);
    assert.match(stakes, new RegExp('Network reserve \\(the unused part returns\\) ' + n(terms.networkReserveSatoshis) + ' sats'));
    assert.match(stakes, new RegExp('Total wallet payment ' + n(25_000 + terms.networkReserveSatoshis) + ' sats'));
    assert.match(stakes, new RegExp('If you win · reaches your wallet ' + n(terms.win.receiveSatoshis) + ' sats'));
    assert.match(stakes, new RegExp('If you win · network fee ' + n(terms.win.feeSatoshis) + ' sats'));
    assert.match(stakes, /If you lose · defender receives 25,000 sats/);
    assert.match(stakes, new RegExp('If you lose · returns to your wallet ' + n(terms.loss.receiveSatoshis) + ' sats'));
    assert.match(stakes, /Most BCH you can win 25,000 sats/);
    assert.match(stakes, /Most BCH you can lose 25,000 sats and the network fee/);
    assert.match(stakes, /A higher stake never changes the battle/);
    assert.match(stakes, /every 24 hours/);
    assert.equal(await box.locator('select[name=stake]').inputValue(), '25000', 'the choice survives the preview refresh');
    assert.equal(await box.getByRole('button', { name:/^Prepare paid raid/ }).isDisabled(), false);
    await page.screenshot({ path:resolve(output, 'war-chest-raid-funded.png') });
  });

  await check('preparing the paid raid shows the escrow and the same figures in the payment dialog', async () => {
    await dialog(page).getByRole('button', { name:/^Prepare paid raid/ }).click();
    await dialog(page).getByText('Payment details', { exact:true }).click();
    await dialog(page).getByRole('heading', { name:'Outputs', exact:true }).waitFor();
    const body = await text(dialog(page));
    const total = 25_000 + terms.networkReserveSatoshis;
    assert.match(body, new RegExp(total.toLocaleString('en-US') + ' sat'));
    assert.match(body, /You stake 25000 sats and their War Chest matches it/);
    assert.match(body, new RegExp('Win: ' + terms.win.receiveSatoshis + ' sats come to your wallet'));
    assert.match(body, new RegExp('Lose: they get your stake and ' + terms.loss.receiveSatoshis + ' sats come back to you'));
    const { payments } = await state();
    const raid = payments.find(item => item.action === 'attack-paid');
    assert.deepEqual(raid.outputs.map(item => [item.role, item.satoshis]), [['escrow', total], ['event', 0]]);
    assert.deepEqual([raid.preview.stakeSatoshis, raid.preview.totalPaymentSatoshis, raid.preview.win.receiveSatoshis], [25_000, total, terms.win.receiveSatoshis], 'the checkout carries the previewed terms');
    await page.screenshot({ path:resolve(output, 'war-chest-raid-payment.png') });
    await dialog(page).getByRole('button', { name:'Close dialog', exact:true }).click();
  });

  let service;
  await check('a service payment dialog lists the four exact outputs and the one reserve before the wallet signs', async () => {
    service = app.ledger.create('p1', { type:'premium', building:'hall' });
    const price = service.satoshis;
    assert.equal(price, 22_000);
    await page.goto(origin + '/play?seat=p1&payment=' + service.id);
    await dialog(page).getByText('Payment details', { exact:true }).click();
    await dialog(page).getByRole('heading', { name:'Outputs', exact:true }).waitFor();
    const body = await text(dialog(page));
    const n = value => value.toLocaleString('en-US');
    assert.match(body, new RegExp('Your War Chest · always at risk ' + n(price / 2) + ' sat'));
    assert.match(body, new RegExp('Season reward share ' + price / 5 + ' \\+ network reserve 300 ' + n(price / 5 + 300) + ' sat'));
    assert.match(body, new RegExp(n(price / 10) + ' sat'));
    assert.match(body, new RegExp('Your wallet sends ' + n(price + 300) + ' sats \\(incl\\. 300 sat network reserve\\)'));
    assert.deepEqual(service.outputs.map(item => [item.role, item.satoshis]), [['warChest', price / 2], ['development', price / 5], ['prize', price / 5 + 300], ['burn', price / 10]]);
    await page.screenshot({ path:resolve(output, 'war-chest-service-payment.png') });
  });

  await check('after one payment the War Chest screen shows the share in the chest and open to a raid at once, with no risk control and no second vault', async () => {
    await app.ledger.submit('p1', service.id, node.pay('p1', service));
    mine();
    await settle();
    await page.goto(origin + '/play?seat=p1');
    await page.locator('#inspector h2').waitFor();
    const { vault, config } = await state();
    assert.deepEqual([vault.warChestSatoshis, vault.pendingChestSatoshis, vault.capturableSatoshis], [service.satoshis / 2, 0, service.satoshis / 2], 'one purchase, one usable War Chest');
    assert.equal(config.personalVault, 'closed');
    await page.getByRole('navigation', { name:'Main navigation' }).getByRole('button', { name:'Vault', exact:true }).click();
    await page.locator('#campaign').getByRole('heading', { name:'War Chest', exact:true }).waitFor();
    const screen = await text(page.locator('#campaign'));
    assert.match(screen, /War Chest · always at risk/);
    assert.match(screen, /Open to a matched raid now/);
    assert.match(screen, /Your War Chest is at risk in PvP raids\. Half of each payment goes into it/);
    assert.doesNotMatch(screen, /Kingdom treasury|Battle exposure|operator-managed|Waiting shares|Personal vault deposits have no PvP exposure/);
    assert.equal(await page.locator('#campaign').getByRole('button', { name:'Deposit BCH', exact:true }).count(), 0, 'no separate protected deposit is offered');
    assert.equal(await page.locator('#campaign').getByRole('button', { name:'Fund War Chest', exact:true }).count(), 1);
    await page.screenshot({ path:resolve(output, 'war-chest-vault-screen.png') });
  });

  await check('the council treasury panel has no risk setting and explains matched stakes', async () => {
    await page.goto(origin + '/council.html?seat=p1');
    await page.getByText('War Chest · always at risk').first().waitFor();
    const body = await text(page.locator('body'));
    assert.match(body, /Your War Chest is at risk in PvP raids/);
    assert.match(body, /Open to a matched raid now/);
    assert.match(body, /Part of every service payment and all sponsorship go into the season reward pool/);
    assert.doesNotMatch(body, /Commit treasury to battles|Committed to battle|Set commitment|at most 20%/);
    assert.equal(await page.getByLabel('Amount to take out of your War Chest (satoshis, in whole thousands)').count(), 1);
    assert.match(body, /Exactly this amount leaves your War Chest\. Your wallet receives it less the network fee/);
    await page.screenshot({ path:resolve(output, 'war-chest-council.png'), fullPage:true });
  });

  await check('prices shown in the client come from the price book', async () => {
    const { config } = await state();
    assert.deepEqual([config.pricing, config.fees.rush, config.fees.premium, config.fees.espionage, config.fees.protectorate, config.fees.attack, config.raid.minimumStake],
      ['prices-v2', 20_000, 22_000, 20_000, 24_000, 10_000, 10_000]);
    assert.deepEqual(config.stakes['territory-claim'], { principal:6_000, reserve:600 });
  });

  await check('the old risk endpoint is closed', async () => {
    const response = await page.request.post(origin + '/api/kingdom/risk', { data:{ satoshis:1_000, consent:true } });
    assert.equal(response.status(), 410);
  });

  assert.deepEqual(errors, []);
  const report = { ranAt:new Date().toISOString(), browser:'Chromium ' + browser.version(), network:'in-process fixture node (BCH VM), not Chipnet',
    wallet:'test keys in the test process; no wallet app or WizardConnect pairing', passed, pageErrors:errors };
  await writeFile(resolve(process.argv[2] ?? resolve(output, 'war-chest-browser.json')), JSON.stringify(report, null, 2) + '\n');
  console.log(passed.length + ' browser checks passed');
} finally {
  await browser.close();
  await node.close();
}
