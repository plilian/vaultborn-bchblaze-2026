// A game server on an enforcing fixture node, shared by the covenant tests and the browser check.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createVirtualMachineBCH } from '@bitauth/libauth';
import { createApp } from '../../apps/game-server/index.mjs';
import { createChain, walletFromPrivateKey } from '../../packages/chain-observer/index.mjs';
import { hex, readTransaction, signSpend } from '../../packages/chain-observer/primitives.mjs';
import { signCaptureDigests } from '../../packages/chain-observer/kingdom-vault.mjs';
import { planStakeSpend, signStakeDigest } from '../../packages/chain-observer/stake-escrow.mjs';
import { planMatchedCapture, planRaidSpend, signMatchedDigests, signRaidDigest } from '../../packages/chain-observer/matched-raid.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NETWORK_ID } from '../../config/network.mjs';

export const initialTime = Date.UTC(2026, 10, 18);
export const key = number => number.toString(16).padStart(64, '0');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const operatorKey = key(600);
export const operator = walletFromPrivateKey(operatorKey);
export const keys = { p1:key(601), p2:key(602), p3:key(603) };
export const wallets = Object.fromEntries(Object.entries(keys).map(([id, secret]) => [id, walletFromPrivateKey(secret)]));
export const stranger = walletFromPrivateKey(key(699));
export const developer = walletFromPrivateKey(key(698));
export const attestorKey = key(650);
export const attestor = walletFromPrivateKey(attestorKey);
export const attested = plan => ({ [attestor.publicKey]:signCaptureDigests(plan, attestorKey) });
export const vm = createVirtualMachineBCH();
export const scriptOf = output => hex(output.lockingBytecode);

// The fixture node keeps real transactions, runs the BCH VM on every broadcast and refuses double spends, non-final
// transactions and inputs younger than their relative lock.
export async function covenantNode(options = {}) {
  let now = options.startAt ?? initialTime;
  let sequence = 0;
  let height = 392_000;
  const transactions = new Map();
  const spent = new Set();
  const refused = [];
  const assets = { enabled:false, list:() => [], authority:() => null, close:() => {} };
  const touches = (item, script) => item.transaction.outputs.some(output => scriptOf(output) === script) ||
    item.transaction.inputs.some(input => {
      const output = transactions.get(hex(input.outpointTransactionHash))?.transaction.outputs[input.outpointIndex];
      return output && scriptOf(output) === script;
    });
  const depth = item => item.height ? height - item.height + 1 : 0;
  function accept(raw) {
    const decoded = readTransaction(raw);
    if (transactions.has(decoded.txid)) return decoded.txid;
    const points = decoded.transaction.inputs.map(input => hex(input.outpointTransactionHash) + ':' + input.outpointIndex);
    if (points.some(point => spent.has(point))) throw new Error('txn-mempool-conflict');
    if (decoded.transaction.locktime >= 500_000_000 && decoded.transaction.locktime > now / 1000) throw new Error('non-final');
    const sources = decoded.transaction.inputs.map(input => transactions.get(hex(input.outpointTransactionHash)));
    const sourceOutputs = sources.map((item, index) => item?.transaction.outputs[decoded.transaction.inputs[index].outpointIndex]);
    if (!sourceOutputs.every(Boolean)) throw new Error('missing-inputs');
    decoded.transaction.inputs.forEach((input, index) => {
      if (input.sequenceNumber < 0x80000000 && depth(sources[index]) < (input.sequenceNumber & 0xffff)) throw new Error('non-BIP68-final');
    });
    const verdict = vm.verify({ transaction:decoded.transaction, sourceOutputs });
    if (verdict !== true) throw new Error('mandatory-script-verify-flag-failed: ' + verdict);
    for (const point of points) spent.add(point);
    transactions.set(decoded.txid, { ...decoded, rawHex:raw, confirmations:0, height:0 });
    return decoded.txid;
  }
  const chain = createChain({ treasuryPrivateKey:operatorKey, developmentAddress:developer.address, prizeAttestors:options.attestors ?? [attestor.publicKey], transport:{ withClient:run => run({
    get tip() { return height; },
    history:async script => [...transactions.values()].filter(item => touches(item, script)).map(item => ({ txid:item.txid, height:item.height })),
    raw:async txid => transactions.get(txid)?.rawHex ?? null,
    lookup:async txid => { const item = transactions.get(txid); return item && { ...item, confirmations:depth(item) }; },
    broadcast:async raw => { try { return accept(raw); } catch (error) { refused.push(error.message); throw error; } } }) } });
  const { attestors: _attestors, attestStakes: _attestStakes, startAt: _startAt, ...appOptions } = options;
  // On Mainnet the server only starts as a real deployment would: a database file, no demo seats. The chain is still this in-memory fixture.
  const real = NETWORK_ID === 'mainnet';
  const app = createApp({ database:real ? join(mkdtempSync(join(tmpdir(), 'vb-mainnet-fixture-')), 'game.sqlite') : ':memory:', localDemo:!real, clock:() => now, chain, territoryAssets:assets, politicalAssets:assets, ...appOptions });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const close = async () => { const closed = once(app.server, 'close'); app.close(); await closed; };
  function pay(player, quote) {
    const outputs = app.store.payment(quote.id).outputs.map(({ script, satoshis }) => ({ script, satoshis }));
    const signed = signSpend({ privateKey:keys[player], sources:[{ txid:hash('coin-' + (++sequence)), vout:0, script:wallets[player].script, satoshis:400_000 }],
      outputs:[...outputs, { script:wallets[player].script, satoshis:400_000 - outputs.reduce((sum, output) => sum + output.satoshis, 0) - 600 }] });
    const observed = { ...readTransaction(signed.rawHex), rawHex:signed.rawHex, height:height - 1, blockHash:hash('block'), blockTime:now };
    transactions.set(observed.txid, observed);
    return observed.txid;
  }
  // Mines every waiting transaction and then `blocks` more blocks on top.
  const mine = (blocks = 2) => { height += 1; for (const item of transactions.values()) if (!item.height) item.height = height; height += blocks - 1; };
  const seat = id => {
    app.store.addSession(hash('seat-' + id), id, initialTime + 3650 * 86_400_000);
    app.store.bindWallet(id, wallets[id].address, wallets[id].publicKey, now);
  };
  const edit = change => app.store.transaction(() => { const { world } = app.store.read(); change(world); app.store.write(world); });
  async function buy(player, order) {
    const quote = app.ledger.create(player, order);
    const result = await app.ledger.submit(player, quote.id, pay(player, quote));
    return { quote, result, row:app.store.payment(quote.id) };
  }
  // The fixture's attestor signs stake settlements as an honest outcome attestor would, unless a test turns that off.
  let attesting = options.attestStakes !== false;
  async function attestStakes(secret = attestorKey) {
    let signed = 0;
    for (const item of app.ledger.pendingAwards().filter(entry => entry.kind === 'stake')) {
      const plan = planStakeSpend(item.sources[0], { lane:item.lane, payee:item.payeeScript ?? undefined, eventScript:item.eventScript ?? undefined });
      const publicKey = walletFromPrivateKey(secret).publicKey;
      if (item.signed.includes(publicKey)) continue;
      await app.ledger.attestAward(item.id, { publicKey, signatures:[signStakeDigest(plan, secret)] });
      signed += 1;
    }
    // A matched raid settlement: the attestor rebuilds the transaction from the proposal and signs every input it must sign.
    for (const item of app.ledger.pendingAwards().filter(entry => entry.kind === 'raid')) {
      const publicKey = walletFromPrivateKey(secret).publicKey;
      if (item.signed.includes(publicKey)) continue;
      const escrow = item.sources.at(-1);
      const signatures = item.lane === 'attacker-wins' ? signMatchedDigests(planMatchedCapture(item.sources.slice(0, -1), escrow, { eventScript:item.eventScript ?? undefined }), secret) :
        [signRaidDigest(planRaidSpend(escrow, { lane:item.lane, eventScript:item.eventScript ?? undefined }).digest, secret)];
      await app.ledger.attestAward(item.id, { publicKey, signatures });
      signed += 1;
    }
    return signed;
  }
  // An ordinary confirmed output in a player's wallet, for the fee of an owner's exit.
  function coin(player, satoshis = 3_000) {
    const signed = signSpend({ privateKey:keys[player], sources:[{ txid:hash('mint-' + (++sequence)), vout:0, script:wallets[player].script, satoshis:satoshis + 300 }],
      outputs:[{ script:wallets[player].script, satoshis }] });
    const observed = { ...readTransaction(signed.rawHex), rawHex:signed.rawHex, height:height - 1, blockHash:hash('block'), blockTime:now };
    transactions.set(observed.txid, observed);
    return { txid:observed.txid, vout:0, satoshis };
  }
  const settle = async (rounds = 3) => { for (let round = 0; round < rounds; round += 1) { await app.ledger.reconcile(); if (attesting) await attestStakes(); mine(); } await app.ledger.reconcile();
    // A settlement proposed by the last pass is signed, mined and booked as well.
    while (attesting && await attestStakes()) { mine(); await app.ledger.reconcile(); } };
  const paidTo = (script, txid) => transactions.get(txid).transaction.outputs.filter(output => scriptOf(output) === script).reduce((sum, output) => sum + Number(output.valueSatoshis), 0);
  return { app, chain, transactions, refused, accept, pay, mine, seat, edit, buy, settle, attestStakes, coin, height:() => height, setAttesting:value => { attesting = value; }, paidTo, close, advance:ms => { now += ms; }, time:() => now };
}
