// Live Chipnet lifecycle for the remediation contracts. It spends real Chipnet test coins and broadcasts real transactions.
// This script was written with the remediation and validated on Regtest only. Until its owner runs it, no Chipnet result
// exists for these contracts. It needs a funded disposable fixture (about 60,000 test satoshis on the player key):
//   node scripts/chipnet-wallet.mjs new var/remediation-keys.json     (then fund the printed address from a Chipnet faucet)
//   CHIPNET_FIXTURE_FILE=var/remediation-keys.json CHIPNET_TEST_APPROVE=true node scripts/chipnet-remediation-e2e.mjs
import './support/chipnet-only.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, signWalletChallenge, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { politicalEscrow, signPoliticalEscrow } from '../packages/chain-observer/political-escrow.mjs';
import { compileTreasuryCovenant, completeTreasurySpend, planTreasurySpend, sponsorSigningHash, treasurySigningHash } from '../packages/chain-observer/treasury-covenants.mjs';
import { eventOutput, gameEvent } from '../packages/chain-observer/vaultborn.mjs';
import { fromHex, hex } from '../packages/chain-observer/primitives.mjs';
import { secp256k1 } from '@bitauth/libauth';
import { randomBytes } from 'node:crypto';

const path = process.env.CHIPNET_FIXTURE_FILE;
if (!path || process.env.CHIPNET_TEST_APPROVE !== 'true') throw new Error('A funded disposable Chipnet fixture and CHIPNET_TEST_APPROVE=true are required.');
const keys = JSON.parse(await readFile(path, 'utf8'));
const wallet = walletFromPrivateKey(keys.player.priv);
// Optional sponsorship lifecycle: add { "developer": { "address": "bchtest:..." }, "attestor": { "priv": "<hex>" } } to the fixture
// and fund the player key with at least 0.2502 test BCH. The attestor key stands in for an independent party in this rehearsal.
const sponsorship = keys.attestor?.priv && keys.developer?.address;
const chain = createChain({ treasuryPrivateKey: keys.treasury.priv, minConfirmations: 2, electrumHost: process.env.CHIPNET_ELECTRUM_HOST,
  ...(sponsorship && { developmentAddress: keys.developer.address, prizeAttestors: [walletFromPrivateKey(keys.attestor.priv).publicKey] }) });
const dir = await mkdtemp(resolve('var', 'remediation-chipnet-'));
const receiptsPath = resolve(dir, 'receipts.json');
const receipt = { network: 'chipnet', started: new Date().toISOString(), fixtureWallet: wallet.address, rows: [] };
const save = () => writeFile(receiptsPath, JSON.stringify(receipt, null, 2) + '\n');
const explorer = txid => 'https://chipnet.imaginary.cash/tx/' + txid;
// Lone prize carriers sweep after one minute here so the run does not wait for a second payer.
const app = createApp({ database: resolve(dir, 'world.sqlite'), chain, localDemo: true, carrierWait: 60_000, vaultRecoveryDays: 1 });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const base = 'http://127.0.0.1:' + app.server.address().port;
let cookie = null;
async function player(route, body, expected = 200) {
  const response = await fetch(base + '/api/' + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
  const result = await response.json();
  assert.equal(response.status, expected, route + ' ' + JSON.stringify(result.error ?? result));
  return result;
}
async function settle(id, label) {
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    await app.ledger.reconcile();
    const row = app.store.payment(id);
    if (row?.state === 'credited') {
      receipt.rows.push({ step: label, action: row.action, txid: row.txid, satoshis: row.satoshis, feeSatoshis: row.feeSatoshis ?? row.receipt?.feeSatoshis ?? null,
        confirmations: row.receipt.confirmations, height: row.receipt.height, blockHash: row.receipt.blockHash, explorer: explorer(row.txid),
        outputs: row.receipt.allocations?.map(({ role, satoshis, vout, address }) => ({ role, satoshis, vout, address })) });
      await save();
      console.log('CONFIRMED', label, row.txid);
      return row;
    }
    assert.ok(!['expired', 'rejected', 'reorg', 'voided'].includes(row?.state), label + ': ' + JSON.stringify(row?.lastError));
    await delay(8000);
  }
  throw new Error('Confirmation timeout for ' + label);
}
async function pay(body, label) {
  const { result: intent } = await player('payments', body, 201);
  const signed = await chain.sendOutputsWithLocalKey(keys.player.priv, intent.outputs);
  console.log('BROADCAST', label, signed.txid);
  return settle(intent.id, label);
}
// Waits until a transaction built outside the game has two confirmations.
async function mined(txid, label, detail = {}) {
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    const seen = await chain.verifyPublishedTransaction(txid).catch(() => null);
    if (seen?.confirmations >= 2) {
      receipt.rows.push({ step: label, txid, confirmations: seen.confirmations, height: seen.height, feeSatoshis: seen.feeSatoshis, explorer: explorer(txid), ...detail });
      await save();
      console.log('CONFIRMED', label, txid);
      return seen;
    }
    await delay(8000);
  }
  throw new Error('Confirmation timeout for ' + label);
}
const fundScript = async (script, satoshis, label) => {
  const signed = await chain.sendOutputsWithLocalKey(keys.player.priv, [{ script, satoshis }]);
  await mined(signed.txid, label + ' (funding)', { satoshis });
  return { txid: signed.txid, vout: 0, script, satoshis };
};

try {
  await player('session', { demo: 'p1' });
  const { result: challenge } = await player('wallet/challenge', { address: wallet.address });
  const proof = signWalletChallenge(keys.player.priv, challenge.challenge);
  await player('wallet/verify', { address: wallet.address, publicKey: proof.publicKey, signature: proof.signature });
  await player('command', { type: 'tutorial' });
  assert.ok(await chain.localWalletBalance(wallet.address) >= 45_000, 'Fund the disposable Chipnet fixture with at least 45,000 test satoshis.');
  console.log('Writing receipts to', receiptsPath);

  // 1. Exact 20/10/5/65 service payment through a prize carrier, then its sweep. (Carrier mode needs an operator-held fee output;
  //    with a developer address configured the first run falls back to the disclosed dust floor and this step is skipped.)
  if (!sponsorship) {
  const premium = await pay({ type: 'premium', building: 'hall' }, 'premium with prize carrier');
  assert.deepEqual(premium.receipt.allocations.map(item => [item.role, item.satoshis]), [['carrier', 3375], ['development', 900], ['burn', 225]]);
  let sweep;
  for (let attempt = 0; attempt < 30 && !sweep; attempt++) {
    await delay(8000);
    await app.ledger.reconcile();
    sweep = app.store.payments().find(row => row.action === 'allocation-sweep');
  }
  assert.ok(sweep, 'The carrier sweep was not created.');
  const swept = await settle(sweep.id, 'prize carrier sweep');
  receipt.rows.at(-1).sweepOutputs = swept.sweepOutputs.map(({ role, satoshis, vout, address }) => ({ role, satoshis, vout, address }));
  receipt.rows.at(-1).topUpSatoshis = swept.topUpSatoshis;
  const buckets = app.ledger.explorer().buckets;
  assert.equal(buckets.kingdomReserve, 2925);
  assert.equal(buckets.prize, 546);
  } else console.log('Carrier lifecycle skipped in this run: run once without fixture.developer to exercise it.');

  // 2. Vault covenant: deposit, assisted withdrawal to the verified wallet, then a refused foreign address.
  const deposit = await pay({ type: 'vault-deposit', satoshis: 12_000, consent: true }, 'vault covenant deposit');
  assert.ok(deposit.vault?.recoverAt, 'The deposit is not covenant-locked.');
  receipt.rows.at(-1).vault = { address: deposit.address, ownerAddress: deposit.vault.ownerAddress, recoverAt: deposit.vault.recoverAt };
  await writeFile(resolve(dir, 'vault-deposit.json'), JSON.stringify(app.ledger.list('p1').find(row => row.id === deposit.id), null, 2) + '\n');
  const other = walletFromPrivateKey(keys.treasury.priv).address;
  await assert.rejects(app.ledger.payout('p1', { kind: 'withdraw', satoshis: 4000, address: other, consent: true }), /can only return to the wallet/);
  const { result: withdrawal } = await player('vault/payout', { kind: 'withdraw', satoshis: 4000, address: wallet.address, consent: true }, 201);
  await settle(withdrawal.id, 'vault assisted withdrawal');
  console.log('Owner-only vault recovery opens at', new Date(deposit.vault.recoverAt * 1000).toISOString(),
    '\n  VAULT_OWNER_KEY_FILE=<player key file> node scripts/vault-recover.mjs', resolve(dir, 'vault-deposit.json'), '<change txid>', wallet.address, '--broadcast');

  // 3. Political escrow version 2 used directly: an overfunded payment returned by the operator lane.
  const escrow = politicalEscrow({ id: randomBytes(16).toString('hex'), operatorKey: walletFromPrivateKey(keys.treasury.priv).publicKey,
    payerKey: wallet.publicKey, payeeKey: walletFromPrivateKey(randomBytes(32).toString('hex')).publicKey, principal: 1500,
    refundAt: Math.floor(Date.now() / 1000) + 3600, version: 2 });
  const overpaid = await fundScript(escrow.script, escrow.satoshis + 300, 'political escrow v2 overfunded');
  const eventScript = eventOutput(gameEvent('political-refund', 'pe-' + escrow.id, { misfunded: true, satoshis: overpaid.satoshis })).script;
  const returned = signPoliticalEscrow({ contract: escrow, source: overpaid, privateKey: keys.treasury.priv, lane: 'operator-refund', eventScript });
  await chain.broadcast(returned.rawHex);
  await mined(returned.txid, 'political escrow v2 overfunding returned to payer', { address: escrow.address, returnedSatoshis: returned.satoshis });

  // 4. Treasury covenant version 2: the 576-satoshi underpayment that version 1 strands, recovered with a fee sponsor.
  const tranche = { id: randomBytes(16).toString('hex'), kind: 'battle-escrow', version: 2, principal: 3000, reserve: 800,
    refundAt: Math.floor(Date.now() / 1000) - 6 * 3600, ownerKey: wallet.publicKey, opponent: other,
    attestors: [walletFromPrivateKey(randomBytes(32).toString('hex')).publicKey, walletFromPrivateKey(randomBytes(32).toString('hex')).publicKey] };
  const contract = compileTreasuryCovenant(tranche);
  const stranded = await fundScript(contract.script, 576, 'treasury covenant v2 underfunded');
  const sponsorCoin = await fundScript(wallet.script, 3000, 'recovery fee sponsor');
  const plan = planTreasurySpend(tranche, stranded, { lane: 'refund', sponsor: { publicKey: wallet.publicKey, source: sponsorCoin } });
  const schnorr = digest => hex(secp256k1.signMessageHashSchnorr(fromHex(keys.player.priv), digest));
  const recovery = completeTreasurySpend(plan, [schnorr(treasurySigningHash(plan))], schnorr(sponsorSigningHash(plan)));
  await chain.broadcast(recovery.rawHex);
  await mined(recovery.txid, 'treasury covenant v2 underpayment recovered', { address: contract.address });

  // 5. Sponsorship: 30% to the developer address, 70% into the prize fund covenant.
  if (sponsorship && await chain.localWalletBalance(wallet.address) >= 25_020_000) {
    const funded = await pay({ type: 'sponsor-fund', satoshis: 25_000_000, consent: true }, 'sponsorship 30/70 into the prize fund covenant');
    assert.deepEqual(funded.receipt.allocations.map(item => [item.role, item.satoshis]), [['prize', 17_500_000], ['development', 7_500_000], ['event', 0]]);
    assert.equal(funded.receipt.allocations[1].address, keys.developer.address);
    receipt.rows.at(-1).fund = { address: funded.address, ...funded.fund };
    await save();
    console.log('Prize fund covenant:', funded.address, '\n  awards open at', new Date(funded.fund.closesAt * 1000).toISOString(),
      'with: PRIZE_ATTESTOR_KEY_FILE=<attestor key file> node scripts/prize-attest.mjs', base, '--approve',
      '\n  keyless sponsor refund opens at', new Date(funded.fund.refundAt * 1000).toISOString());
  } else console.log('Sponsorship lifecycle skipped: it needs fixture.developer.address, fixture.attestor.priv and 0.2502 test BCH on the player key.');

  receipt.finished = new Date().toISOString();
  receipt.result = 'PASS';
  await save();
  console.log('All remediation lifecycles confirmed on Chipnet. Receipts:', receiptsPath);
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
