// Standalone prize payout and recovery for the independent attestors. It does not use the application server.
//
// What it needs: a season evidence bundle saved earlier from the server's public endpoints (`export`), the public keys
// of the game and of the attestors, a Bitcoin Cash node or Electrum server, and the attestors' own keys. With those it
//   1. audits the bundle: the score journal's hash chain, every entry against the scoring rules, every battle replayed,
//      the on-chain anchors, and the published ranking and prize amounts recomputed;
//   2. rebuilds every prize fund contract of the season from its public terms and finds its outputs on chain;
//   3. builds the award of one rank, exactly as the server would have (same rule, same transaction layout);
//   4. lets each attestor check that proposal independently and sign it on its own machine;
//   5. completes, broadcasts and confirms the payment.
// Who must sign is decided by the contracts, not by this tool: the game key and a majority of the attestors; from 30 days
// after the season closed the game key and any one attestor; or, if the game key is lost, ALL attestors together from
// that same date (season pool only, with two or more attestors). A sponsor's fund is not recovered here: after its
// refund date it returns to the sponsor's wallet by its own keyless lane.
//
//   node scripts/attestor-payout.mjs export  <server origin> <bundle.json>
//   node scripts/attestor-payout.mjs status  --bundle b.json --config c.json (--rpc http://user:pass@host:port | --electrum host)
//   node scripts/attestor-payout.mjs propose --bundle b.json --config c.json --rank 1 --out proposal.json (--rpc … | --electrum …) [--without-game-key]
//   node scripts/attestor-payout.mjs sign    proposal.json --bundle b.json --config c.json --key-file attestor.key (--rpc … | --electrum …)
//   node scripts/attestor-payout.mjs send    proposal.json --bundle b.json --config c.json [--game-key-file game.key] (--rpc … | --electrum …)
//   node scripts/attestor-payout.mjs confirm <txid> (--rpc … | --electrum …)
// config.json: { "operatorKey": "<game public key>", "attestors": ["<public key>", …], "threshold": 2 }
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { decodeAddress, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { hex, readTransaction } from '../packages/chain-observer/primitives.mjs';
import { awardQuorum, completePrizeAward, layoutPrizeAward, planPrizeAward, prizeFund, signPrizeAward, validAwardSignatures } from '../packages/chain-observer/prize-fund.mjs';
import { createElectrumTransport } from '../packages/chain-observer/transports.mjs';
import { entitlementsOf } from '../apps/game-server/season-evidence.mjs';
import { auditSeason } from './season-audit.mjs';
import { NETWORK_ID, NETWORK_PROFILE } from '../config/network.mjs';

// ---- Evidence bundle ----
// Everything the audit reads, saved while the server is up. An attestor should save one after every season closes.
export async function exportBundle(origin, fetcher = fetch) {
  const read = async path => { const response = await fetcher(origin + path); if (!response.ok) throw new Error(path + ' answered ' + response.status); return response.json(); };
  const pages = {};
  const result = await read('/api/public/season-result');
  pages['/api/public/season-result'] = result;
  const season = result.result?.seasonId;
  if (!Number.isSafeInteger(season)) throw new Error('The server publishes no closed season.');
  const entries = [];
  for (let from = 1; ; from += 2000) {
    const path = `/api/public/season-events?season=${season}&from=${from}`;
    const page = await read(path);
    pages[path] = page;
    entries.push(...page.entries);
    if (entries.length >= page.count || !page.entries.length) break;
  }
  for (const id of new Set(entries.flatMap(entry => entry.kind === 'battle-won' || entry.kind === 'battle-lost' ? [entry.ref] : String(entry.ref ?? '').startsWith('battle:') ? [String(entry.ref).slice(7)] : []))) {
    const path = '/api/public/battle/' + id;
    const record = await read(path).catch(() => null);
    if (record) pages[path] = record;
  }
  const anchors = '/api/public/season-anchors?season=' + season;
  pages[anchors] = await read(anchors).catch(() => ({ anchors: [] }));
  // The network the server said it runs on. A bundle is only ever used by a tool running for the same network.
  const network = (await read('/api/health').catch(() => ({}))).network ?? NETWORK_ID;
  if (network !== NETWORK_ID) throw new Error('The server runs on ' + network + ', but this tool is running for ' + NETWORK_ID + '. Set VAULTBORN_NETWORK.');
  return { version: 1, network, origin, savedAt: new Date().toISOString(), season, pages };
}
const sameNetwork = bundle => { if (bundle.network && bundle.network !== NETWORK_ID) throw new Error('This evidence bundle is from ' + bundle.network + ', but this tool is running for ' + NETWORK_ID + '. Set VAULTBORN_NETWORK.'); };
// A fetch that answers from the bundle, so the very same audit code runs with or without the server.
const bundleFetcher = bundle => async url => {
  const path = url.slice(bundle.origin.length);
  const body = bundle.pages[path];
  return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
};
export async function auditBundle(bundle, { pinFile } = {}) {
  sameNetwork(bundle);
  const audit = await auditSeason(bundle.origin, bundle.season, { pinFile, fetcher: bundleFetcher(bundle) });
  return { ...audit, result: bundle.pages['/api/public/season-result'].result };
}

// ---- Contracts and money ----
// Every prize fund of the season, rebuilt from its published terms. A term that does not name this game key and these
// attestors, or that does not hash to the script it is published under, is refused.
export function fundsOf(bundle, config) {
  const { result } = bundle.pages['/api/public/season-result'];
  const attestors = [...config.attestors].map(item => item.toLowerCase()).sort();
  return (result.funds ?? []).map(({ script, fund }) => {
    const contract = prizeFund(fund);
    if (contract.script !== script) throw new Error('A published prize fund does not match its terms.');
    if (fund.operatorKey !== config.operatorKey.toLowerCase() || JSON.stringify([...fund.attestors].sort()) !== JSON.stringify(attestors)) throw new Error('A published prize fund names other keys than this configuration.');
    return { script, fund, contract };
  });
}
export async function prizeOutputs(bundle, config, chain) {
  const sources = [];
  for (const { script, fund } of fundsOf(bundle, config)) for (const coin of await chain.unspent(script)) sources.push({ ...coin, script, fund });
  return sources.sort((a, b) => b.satoshis - a.satoshis || (a.txid + a.vout < b.txid + b.vout ? -1 : 1));
}
// The prize of every paid rank. The base is fixed by the first award of a season; before any award it is 85% of the pool
// that is on chain now, and never more than what one award transaction of the largest share can carry.
export function entitlements(result, sources) {
  const pool = sources.reduce((sum, item) => sum + item.satoshis, 0);
  const base = result.awardsCommitted > 0 ? result.prizeBase : Math.floor(pool * (100 - result.rules.reservePercent) / 100);
  return { poolSatoshis: pool, prizeBase: base, awards: entitlementsOf(result.rankings, base, result.rules.percentages) };
}
// Awards of this season that are already on chain: a transaction that spent a prize fund output and paid a winner's wallet.
export async function paidRanks(result, funds, chain) {
  const wallets = new Map(result.rankings.filter(row => row.wallet).map(row => [decodeAddress(row.wallet).script, row]));
  const paid = new Map();
  for (const { script } of funds) for (const spend of await chain.spends(script)) {
    for (const output of spend.outputs) { const row = wallets.get(output.script); if (row) paid.set(row.rank, { txid: spend.txid, satoshis: (paid.get(row.rank)?.satoshis ?? 0) + output.satoshis }); }
  }
  return paid;
}

// ---- Proposal, review, signature, completion ----
export async function propose({ bundle, config, chain, rank, withoutGameKey = false, now = Math.floor(Date.now() / 1000) }) {
  const audit = await auditBundle(bundle);
  if (audit.problems.length) throw new Error('The season evidence does not pass its audit: ' + audit.problems.join('; '));
  const { result } = audit;
  const place = result.rankings.find(row => row.rank === rank);
  if (!place?.wallet) throw new Error('This rank has no verified wallet in the published result.');
  let sources = await prizeOutputs(bundle, config, chain);
  // Without the game key only the season pool can be paid, by all attestors together, from its recovery time on.
  if (withoutGameKey) sources = sources.filter(source => prizeFund(source.fund).continuity);
  if (!sources.length) throw new Error('No prize fund output of this season is unspent on chain.');
  const { prizeBase, poolSatoshis, awards } = entitlements(result, await prizeOutputs(bundle, config, chain));
  const award = awards.find(row => row.rank === rank);
  if (!award || award.satoshis < result.rules.minimumPayout) throw new Error('This rank is not owed a payable prize.');
  const script = decodeAddress(place.wallet).script;
  const layout = layoutPrizeAward(sources, { script, satoshis: award.satoshis });
  const plan = planPrizeAward(layout.sources, layout.outputs, { now });
  const quorum = Math.max(...plan.contracts.map(item => awardQuorum(item, plan.locktime, withoutGameKey)));
  if (!Number.isFinite(quorum)) throw new Error('The attestors cannot pay this fund without the game key yet: its recovery time has not come, or it has no such lane.');
  return { version: 1, seasonId: result.seasonId, resultHash: result.resultHash, rank, playerId: place.playerId, wallet: place.wallet, satoshis: award.satoshis, prizeBase, poolSatoshis,
    withoutGameKey, attestorsNeeded: quorum, locktime: plan.locktime, feeSatoshis: layout.feeSatoshis,
    sources: layout.sources.map(({ txid, vout, satoshis, script: locking, fund }) => ({ txid, vout, satoshis, script: locking, fund })), outputs: layout.outputs, digests: plan.digests, signatures: {} };
}
// What an attestor checks on its own machine before it signs someone else's proposal. Nothing is taken on trust:
// the evidence is audited again, the money is looked up on chain again, and the transaction is rebuilt.
export async function review({ bundle, config, chain, proposal, pinFile, now = Math.floor(Date.now() / 1000) }) {
  const problems = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  const audit = await auditBundle(bundle, { pinFile });
  problems.push(...audit.problems.map(text => 'season evidence: ' + text));
  const { result } = audit;
  check(result.seasonId === proposal.seasonId && result.resultHash === proposal.resultHash, 'the proposal follows another season result than this evidence');
  const place = result.rankings.find(row => row.rank === proposal.rank);
  check(place && place.playerId === proposal.playerId && place.wallet === proposal.wallet, 'the evidence does not give this rank to this player and wallet');
  check(audit.ranking?.find(row => row.playerId === proposal.playerId)?.score === place?.score, 'the journal does not give this player this score');
  const funds = fundsOf(bundle, config);
  const onChain = await prizeOutputs(bundle, config, chain);
  const live = new Set(onChain.map(item => item.txid + ':' + item.vout + ':' + item.satoshis));
  check(proposal.sources.every(source => live.has(source.txid + ':' + source.vout + ':' + source.satoshis) && funds.some(item => item.script === source.script && prizeFund(source.fund).script === source.script)),
    'an input is not an unspent prize fund output of this season');
  const due = entitlements(result, onChain).awards.find(row => row.rank === proposal.rank);
  check(due && due.satoshis === proposal.satoshis, 'the amount is not what the fixed rule gives this rank');
  const already = await paidRanks(result, funds, chain);
  check(!already.has(proposal.rank), 'this rank was already paid on chain' + (already.has(proposal.rank) ? ' in ' + already.get(proposal.rank).txid : ''));
  let plan = null;
  try {
    const script = decodeAddress(proposal.wallet).script;
    const layout = layoutPrizeAward(proposal.sources, { script, satoshis: proposal.satoshis });
    check(JSON.stringify(layout.outputs) === JSON.stringify(proposal.outputs), 'the outputs are not the award and the remainders of its own funds');
    plan = planPrizeAward(proposal.sources, proposal.outputs, { now: proposal.locktime });
    check(JSON.stringify(plan.digests) === JSON.stringify(proposal.digests), 'the digests do not match the rebuilt transaction');
    check(plan.locktime <= now, 'the season of an input has not closed');
    check(Number.isFinite(Math.max(...plan.contracts.map(item => awardQuorum(item, plan.locktime, proposal.withoutGameKey)))), 'these funds cannot be paid without the game key yet');
  } catch (error) { problems.push('the award cannot be rebuilt: ' + error.message); }
  return { problems, plan, notes: audit.notes };
}
export async function sign({ bundle, config, chain, proposal, privateKey, pinFile, now }) {
  const me = walletFromPrivateKey(privateKey).publicKey;
  if (!config.attestors.map(item => item.toLowerCase()).includes(me)) throw new Error('This key is not an attestor of this configuration.');
  const checked = await review({ bundle, config, chain, proposal, pinFile, now });
  if (checked.problems.length) return { signed: false, problems: checked.problems, proposal };
  return { signed: true, problems: [], proposal: { ...proposal, signatures: { ...proposal.signatures, [me]: signPrizeAward(checked.plan, privateKey) } } };
}
export async function complete({ bundle, config, chain, proposal, gamePrivateKey, now }) {
  const checked = await review({ bundle, config, chain, proposal, now });
  if (checked.problems.length) throw new Error('The proposal does not pass review: ' + checked.problems.join('; '));
  const { plan } = checked;
  for (const [key, signatures] of Object.entries(proposal.signatures)) if (!validAwardSignatures(plan, key, signatures)) throw new Error('A stored signature is not valid for this transaction.');
  if (Boolean(gamePrivateKey) === Boolean(proposal.withoutGameKey)) throw new Error(proposal.withoutGameKey ? 'This proposal is built for the attestors alone; do not add the game key.' : 'This proposal needs the game key as well as the attestors.');
  if (gamePrivateKey && walletFromPrivateKey(gamePrivateKey).publicKey !== config.operatorKey.toLowerCase()) throw new Error('This is not the game key of the configuration.');
  const signed = completePrizeAward(plan, gamePrivateKey ? signPrizeAward(plan, gamePrivateKey) : null, proposal.signatures);
  const txid = await chain.broadcast(signed.rawHex);
  return { ...signed, txid: txid ?? signed.txid };
}

// ---- Chain access: a Bitcoin Cash node over JSON-RPC, or an Electrum server ----
// `checkpoint:false` is for a private Regtest node only. Otherwise the node must hold the block that identifies this
// tool's network, so a node of another network is refused before anything is read or broadcast.
export function rpcChain(url, { checkpoint = true } = {}) {
  const target = new URL(url);
  let verified = !checkpoint;
  const auth = target.username ? 'Basic ' + Buffer.from(decodeURIComponent(target.username) + ':' + decodeURIComponent(target.password)).toString('base64') : undefined;
  target.username = ''; target.password = '';
  const send = async (method, ...params) => {
    const response = await fetch(target, { method: 'POST', headers: { ...(auth && { Authorization: auth }) }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) });
    const body = await response.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  const raw = send;
  const call = async (method, ...params) => {
    if (!verified) {
      const found = await raw('getblockhash', NETWORK_PROFILE.checkpoint.height).catch(() => null);
      if (found !== NETWORK_PROFILE.checkpoint.hash) throw new Error('Wrong network: this node does not hold the ' + NETWORK_ID + ' checkpoint block.');
      verified = true;
    }
    return raw(method, ...params);
  };
  return {
    unspent: async script => (await call('scantxoutset', 'start', [`raw(${script})`])).unspents.map(item => ({ txid: item.txid, vout: item.vout, satoshis: Math.round(item.amount * 1e8), height: item.height })),
    // A node without an address index cannot list the history of a script. Paid ranks are then recognised from the bundle and from what is still unspent.
    spends: async () => [],
    broadcast: raw => call('sendrawtransaction', raw),
    confirmations: async txid => (await call('getrawtransaction', txid, true).catch(() => null))?.confirmations ?? 0,
  };
}
// The Electrum transport checks the network's checkpoint block on every session. `transport` can be supplied by a test.
export function electrumChain(host, { transport = createElectrumTransport(host) } = {}) {
  const transactions = script => transport.withClient(async client => {
    const history = await client.history(script);
    return Promise.all(history.map(async item => ({ ...readTransaction(await client.raw(item.txid), item.txid), height: item.height })));
  });
  const outputsOf = item => item.transaction.outputs.map((output, vout) => ({ vout, script: hex(output.lockingBytecode), satoshis: Number(output.valueSatoshis) }));
  return {
    unspent: async script => {
      const all = await transactions(script);
      const spent = new Set(all.flatMap(item => item.transaction.inputs.map(input => hex(input.outpointTransactionHash) + ':' + input.outpointIndex)));
      return all.flatMap(item => outputsOf(item).filter(output => output.script === script && !spent.has(item.txid + ':' + output.vout)).map(output => ({ txid: item.txid, vout: output.vout, satoshis: output.satoshis, height: item.height })));
    },
    spends: async script => {
      const all = await transactions(script);
      const mine = new Set(all.flatMap(item => outputsOf(item).filter(output => output.script === script).map(output => item.txid + ':' + output.vout)));
      return all.filter(item => item.transaction.inputs.some(input => mine.has(hex(input.outpointTransactionHash) + ':' + input.outpointIndex))).map(item => ({ txid: item.txid, outputs: outputsOf(item) }));
    },
    broadcast: raw => transport.withClient(client => client.broadcast(raw)),
    confirmations: txid => transport.withClient(async client => (await client.lookup(txid))?.confirmations ?? 0),
  };
}

// ---- Command line ----
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = name => { const index = rest.indexOf('--' + name); return index < 0 ? undefined : rest[index + 1]; };
  const has = name => rest.includes('--' + name);
  const positional = rest.filter((item, index) => !item.startsWith('--') && !(rest[index - 1]?.startsWith('--') && !['without-game-key'].includes(rest[index - 1].slice(2))));
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const chain = () => flag('rpc') ? rpcChain(flag('rpc')) : flag('electrum') ? electrumChain(flag('electrum')) : (() => { throw new Error('Name a node with --rpc or --electrum.'); })();
  const secret = async path => (await readFile(path, 'utf8')).trim();
  if (command === 'export') {
    const bundle = await exportBundle(positional[0]);
    await writeFile(positional[1], JSON.stringify(bundle, null, 2) + '\n');
    console.log(`Saved the evidence of season ${bundle.season}: ${Object.keys(bundle.pages).length} documents.`);
  } else if (command === 'status') {
    const [bundle, config] = [await json(flag('bundle')), await json(flag('config'))];
    const audit = await auditBundle(bundle, { pinFile: flag('pins') });
    const sources = await prizeOutputs(bundle, config, chain());
    const due = entitlements(audit.result, sources);
    const paid = await paidRanks(audit.result, fundsOf(bundle, config), chain());
    console.log(JSON.stringify({ season: bundle.season, auditProblems: audit.problems, auditNotes: audit.notes, poolSatoshis: due.poolSatoshis, prizeBase: due.prizeBase,
      outputs: sources.map(({ txid, vout, satoshis }) => ({ txid, vout, satoshis })), awards: due.awards.map(row => ({ ...row, paid: paid.get(row.rank) ?? null })) }, null, 2));
  } else if (command === 'propose') {
    const proposal = await propose({ bundle: await json(flag('bundle')), config: await json(flag('config')), chain: chain(), rank: Number(flag('rank')), withoutGameKey: has('without-game-key') });
    await writeFile(flag('out'), JSON.stringify(proposal, null, 2) + '\n');
    console.log(`Proposed ${proposal.satoshis} satoshis to rank ${proposal.rank} (${proposal.wallet}); ${proposal.attestorsNeeded} attestor signature(s) needed${proposal.withoutGameKey ? ', no game key' : ' and the game key'}.`);
  } else if (command === 'sign') {
    const outcome = await sign({ bundle: await json(flag('bundle')), config: await json(flag('config')), chain: chain(), proposal: await json(positional[0]), privateKey: await secret(flag('key-file')), pinFile: flag('pins') });
    if (!outcome.signed) { console.log(JSON.stringify({ signed: false, problems: outcome.problems }, null, 2)); process.exitCode = 1; }
    else { await writeFile(positional[0], JSON.stringify(outcome.proposal, null, 2) + '\n'); console.log(`Signed. ${Object.keys(outcome.proposal.signatures).length} of ${outcome.proposal.attestorsNeeded} attestor signature(s) collected.`); }
  } else if (command === 'send') {
    const sent = await complete({ bundle: await json(flag('bundle')), config: await json(flag('config')), chain: chain(), proposal: await json(positional[0]), gamePrivateKey: flag('game-key-file') ? await secret(flag('game-key-file')) : undefined });
    console.log(`Broadcast ${sent.txid} (${sent.rawHex.length / 2} bytes, fee ${sent.feeSatoshis} satoshis).`);
  } else if (command === 'confirm') {
    console.log(`${positional[0]}: ${await chain().confirmations(positional[0])} confirmation(s).`);
  } else {
    console.log('Commands: export, status, propose, sign, send, confirm. See the header of this file.');
    process.exitCode = 1;
  }
}
