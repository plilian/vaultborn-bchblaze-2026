// The standalone attestor payout tool: a season's prizes are audited, proposed, signed and paid with the application
// server shut down. The chain is the enforcing fixture node (BCH VM on every broadcast).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { attestorKey, covenantNode, hash, initialTime, key, operatorKey, scriptOf, wallets, operator } from './support/covenant-node.mjs';
import { walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { hex } from '../packages/chain-observer/primitives.mjs';
import { auditBundle, complete, entitlements, exportBundle, fundsOf, paidRanks, prizeOutputs, propose, review, sign } from '../scripts/attestor-payout.mjs';

const attestorKeys = [key(661), key(662), key(663)];
// Plays one season with three paying players, closes it, saves the public evidence, and then SHUTS THE SERVER DOWN.
async function closedSeason(t, attestors) {
  const node = await covenantNode({ attestors:attestors.map(secret => walletFromPrivateKey(secret).publicKey), attestStakes:false });
  let open = true;
  t.after(async () => { if (open) await node.close(); });
  const { app, edit, buy, settle, mine, advance, time, transactions, accept } = node;
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  for (const id of ['p1', 'p2', 'p3']) {
    app.store.addSession(hash(hash('cookie-' + id)), id, initialTime + 3650 * 86_400_000);
    app.store.bindWallet(id, wallets[id].address, wallets[id].publicKey, time());
  }
  edit(world => { for (const id of ['p1', 'p2', 'p3']) Object.assign(world.cities[id], { optIn:true, tutorial:true, shieldUntil:0 }); });
  const command = (player, body) => fetch(origin + '/api/command', { method:'POST', headers:{ Cookie:'dominion=' + hash('cookie-' + player), 'Content-Type':'application/json', Origin:origin },
    body:JSON.stringify({ ...body, requestId:crypto.randomUUID() }) }).then(response => response.json());
  await command('p1', { type:'attack', target:'p2' });
  for (const player of ['p1', 'p2', 'p3']) await buy(player, { type:'premium', building:'hall' });
  await settle(3);
  advance(app.store.read().world.season.endsAt - time() + 60_000);
  await command('p1', { type:'configure' });
  mine(8);
  await settle(2);
  // No award has been signed: the server's own proposals are discarded, as if the server had died right after the season closed.
  const bundle = await exportBundle(origin);
  const config = { operatorKey:operator.publicKey, attestors:attestors.map(secret => walletFromPrivateKey(secret).publicKey), threshold:app.ledger ? node.chain.attestorThreshold : 1 };
  await node.close();
  open = false;
  // From here on nothing talks to the server. The chain adapter reads the node directly.
  const depth = item => item.height ? node.height() - item.height + 1 : 0;
  const outputs = item => item.transaction.outputs.map((output, vout) => ({ vout, script:scriptOf(output), satoshis:Number(output.valueSatoshis) }));
  const spent = () => new Set([...transactions.values()].flatMap(item => item.transaction.inputs.map(input => hex(input.outpointTransactionHash) + ':' + input.outpointIndex)));
  const chain = {
    unspent:async script => { const gone = spent(); return [...transactions.values()].flatMap(item => outputs(item).filter(output => output.script === script && !gone.has(item.txid + ':' + output.vout))
      .map(output => ({ txid:item.txid, vout:output.vout, satoshis:output.satoshis, height:item.height }))); },
    spends:async script => { const mine = new Set([...transactions.values()].flatMap(item => outputs(item).filter(output => output.script === script).map(output => item.txid + ':' + output.vout)));
      return [...transactions.values()].filter(item => item.transaction.inputs.some(input => mine.has(hex(input.outpointTransactionHash) + ':' + input.outpointIndex))).map(item => ({ txid:item.txid, outputs:outputs(item) })); },
    broadcast:async raw => accept(raw),
    confirmations:async txid => depth(transactions.get(txid) ?? {}),
  };
  return { node, bundle, config, chain, mine, advance, time, now:() => Math.floor(time() / 1000) };
}

test('with the server shut down, the game key and one attestor pay the winner from the saved evidence and the chain alone', async t => {
  const { bundle, config, chain, mine, node, now } = await closedSeason(t, [attestorKey]);
  await assert.rejects(fetch(bundle.origin + '/api/public/season-result'), 'the application server is really gone');
  // 1. The evidence passes its audit offline, and the prize contracts are rebuilt from their public terms.
  const audit = await auditBundle(bundle);
  assert.deepEqual(audit.problems, []);
  const funds = fundsOf(bundle, config);
  assert.ok(funds.length >= 1 && funds.every(item => item.contract.script === item.script));
  const sources = await prizeOutputs(bundle, config, chain);
  const due = entitlements(audit.result, sources);
  assert.equal(due.prizeBase, Math.floor(due.poolSatoshis * 85 / 100), '85% of the confirmed pool is distributable; 15% stays for the next season');
  assert.deepEqual(audit.result.rules.percentages, [40, 25, 15, 10, 10]);
  assert.deepEqual(due.awards.map(row => row.satoshis), audit.result.rankings.slice(0, 5).map((row, index) => Math.floor(due.prizeBase * [40, 25, 15, 10, 10][index] / 100)));
  // 2. A proposal for rank 1, built from nothing but the bundle and the chain.
  const proposal = await propose({ bundle, config, chain, rank:1, now:now() });
  assert.deepEqual([proposal.playerId, proposal.wallet, proposal.satoshis, proposal.attestorsNeeded, proposal.withoutGameKey],
    [audit.result.rankings[0].playerId, audit.result.rankings[0].wallet, due.awards[0].satoshis, 1, false]);
  // 3. The attestor checks it independently. Every one of these altered proposals is refused, and nothing is signed.
  const refused = async change => (await sign({ bundle, config, chain, proposal:{ ...proposal, ...change }, privateKey:attestorKey, now:now() })).problems.join(' | ');
  assert.match(await refused({ wallet:wallets.p3.address }), /does not give this rank to this player and wallet|outputs are not the award/);
  assert.match(await refused({ satoshis:proposal.satoshis + 1_000 }), /not what the fixed rule gives this rank/);
  assert.match(await refused({ outputs:[{ ...proposal.outputs[0], script:operator.script }, ...proposal.outputs.slice(1)] }), /outputs are not the award and the remainders/);
  assert.match(await refused({ sources:[{ ...proposal.sources[0], txid:'00'.repeat(32) }] }), /not an unspent prize fund output/);
  // A bundle whose standings were edited after the fact fails its own audit.
  const edited = structuredClone(bundle);
  const published = edited.pages['/api/public/season-result'].result;
  [published.rankings[0].playerId, published.rankings[1].playerId] = [published.rankings[1].playerId, published.rankings[0].playerId];
  assert.match((await sign({ bundle:edited, config, chain, proposal, privateKey:attestorKey, now:now() })).problems.join(' | '), /season evidence: the published ranking is not the ranking the journal produces/);
  await assert.rejects(sign({ bundle, config, chain, proposal, privateKey:key(999), now:now() }), /not an attestor of this configuration/);
  // 4. Signed honestly; the attestor alone cannot send it, and neither can the game key alone.
  const signed = await sign({ bundle, config, chain, proposal, privateKey:attestorKey, now:now() });
  assert.equal(signed.signed, true, signed.problems.join(' | '));
  await assert.rejects(complete({ bundle, config, chain, proposal:signed.proposal, now:now() }), /needs the game key as well/);
  await assert.rejects(complete({ bundle, config, chain, proposal, gamePrivateKey:operatorKey, now:now() }), /attestor signature is missing/);
  const sent = await complete({ bundle, config, chain, proposal:signed.proposal, gamePrivateKey:operatorKey, now:now() });
  mine();
  assert.ok(await chain.confirmations(sent.txid) >= 1);
  assert.equal(node.paidTo(wallets[proposal.playerId].script, sent.txid), proposal.satoshis, 'the winner received exactly the prize');
  // 5. The same rank cannot be claimed twice, even with fresh signatures.
  assert.ok((await paidRanks(audit.result, funds, chain)).has(1));
  mine(8);
  const again = { ...proposal, sources:(await prizeOutputs(bundle, config, chain)).slice(0, 1), signatures:{} };
  assert.match((await sign({ bundle, config, chain, proposal:again, privateKey:attestorKey, now:now() })).problems.join(' | '), /this rank was already paid on chain/);
});

test('if the game key is lost, all attestors together pay the season pool after the recovery date, and not a day earlier', async t => {
  const { bundle, config, chain, mine, advance, now, node } = await closedSeason(t, attestorKeys);
  // Before the recovery date the attestors cannot act without the game key.
  await assert.rejects(propose({ bundle, config, chain, rank:1, withoutGameKey:true, now:now() }), /cannot pay this fund without the game key yet/);
  advance(31 * 86_400_000);
  mine(8);
  let proposal = await propose({ bundle, config, chain, rank:1, withoutGameKey:true, now:now() });
  assert.deepEqual([proposal.attestorsNeeded, proposal.withoutGameKey], [3, true]);
  for (const secret of attestorKeys.slice(0, 2)) proposal = (await sign({ bundle, config, chain, proposal, privateKey:secret, now:now() })).proposal;
  await assert.rejects(complete({ bundle, config, chain, proposal, now:now() }), /attestor signature is missing/, 'two of three are not enough without the game key');
  proposal = (await sign({ bundle, config, chain, proposal, privateKey:attestorKeys[2], now:now() })).proposal;
  await assert.rejects(complete({ bundle, config, chain, proposal, gamePrivateKey:operatorKey, now:now() }), /built for the attestors alone/);
  const sent = await complete({ bundle, config, chain, proposal, now:now() });
  mine();
  assert.ok(await chain.confirmations(sent.txid) >= 1);
  assert.equal(node.paidTo(wallets[proposal.playerId].script, sent.txid), proposal.satoshis);
});

test('the tool\'s Electrum adapter finds a contract\'s unspent outputs and its spends from script history, broadcasts and reads confirmations', async () => {
  const { electrumChain } = await import('../scripts/attestor-payout.mjs');
  const { encodeTransaction, hashTransaction } = await import('@bitauth/libauth');
  const bytes = text => Uint8Array.from(Buffer.from(text, 'hex'));
  const contract = 'aa20' + '11'.repeat(32) + '87';
  const wallet = '76a914' + '22'.repeat(20) + '88ac';
  const make = (inputs, outputs) => { const raw = encodeTransaction({ version:2, locktime:0,
    inputs:inputs.map(([txid, vout]) => ({ outpointTransactionHash:bytes(txid), outpointIndex:vout, sequenceNumber:0xfffffffe, unlockingBytecode:new Uint8Array() })),
    outputs:outputs.map(([script, satoshis]) => ({ lockingBytecode:bytes(script), valueSatoshis:BigInt(satoshis) })) });
    return { txid:hashTransaction(raw), raw:Buffer.from(raw).toString('hex') }; };
  // Funding pays the contract twice; a later transaction spends the first of the two outputs to a wallet.
  const funding = make([['aa'.repeat(32), 0]], [[contract, 40_000], [contract, 25_000], [wallet, 1_000]]);
  const award = make([[funding.txid, 0]], [[wallet, 15_000], [contract, 24_000]]);
  const chainData = new Map([[funding.txid, { ...funding, height:100 }], [award.txid, { ...award, height:101 }]]);
  const sent = [];
  const client = {
    history: async script => script === contract ? [...chainData.values()].map(({ txid, height }) => ({ txid, height })) : [],
    raw: async txid => chainData.get(txid).raw,
    broadcast: async raw => { sent.push(raw); return 'ee'.repeat(32); },
    lookup: async txid => chainData.has(txid) ? { confirmations:103 - chainData.get(txid).height } : null,
  };
  const chain = electrumChain('unused', { transport:{ withClient:work => work(client) } });
  assert.deepEqual((await chain.unspent(contract)).map(item => [item.txid, item.vout, item.satoshis]).sort(), [[award.txid, 1, 24_000], [funding.txid, 1, 25_000]].sort());
  const spends = await chain.spends(contract);
  assert.deepEqual(spends.map(item => item.txid), [award.txid]);
  assert.deepEqual(spends[0].outputs[0], { vout:0, script:wallet, satoshis:15_000 });
  assert.equal(await chain.broadcast('00'), 'ee'.repeat(32));
  assert.deepEqual(sent, ['00']);
  assert.deepEqual([await chain.confirmations(funding.txid), await chain.confirmations('ff'.repeat(32))], [3, 0]);
});
