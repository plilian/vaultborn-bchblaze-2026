import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { getDustThreshold } from '@bitauth/libauth';
import { createApp } from '../apps/game-server/index.mjs';
import { LEGACY_SPONSOR_ALLOCATION, legacySponsorshipPolicy, sponsorshipAllocation, sponsorshipPolicy } from '../config/payments.mjs';
import { chipnetTreasuryConfig } from '../config/treasury.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { fromHex, readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';
import { gameEvent } from '../packages/chain-observer/vaultborn.mjs';
import { advance, command } from '../packages/game-engine/index.mjs';

// These tests cover outputs and balances created before covenant custody of kingdom funds. Those must stay verifiable and spendable.
process.env.VAULTBORN_KINGDOM_CUSTODY = 'operator';

const initialTime = Date.UTC(2026,10,18);
const key = number => number.toString(16).padStart(64, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const roles = outputs => outputs.map(({role,satoshis}) => [role,satoshis]);
const fund = satoshis => ({ type:'sponsor-fund', satoshis, consent:true });

async function fixture(t, { external = false, general = false, developmentAddress } = {}) {
  let now = initialTime;
  let sequence = 0;
  let broadcasts = 0;
  const transactions = new Map();
  const watchedScripts = [];
  const buyerKey = key(901);
  const buyer = walletFromPrivateKey(buyerKey);
  const externalDestination = walletFromPrivateKey(key(902));
  const assets = { enabled:false, list:() => [], authority:() => null, close:() => {} };
  const chain = createChain({ treasuryPrivateKey:key(900),
    ...(external && { sponsorshipDevelopmentAddress:externalDestination.address }),
    developmentAddress: developmentAddress ?? (general ? externalDestination.address : undefined),
    transport:{ withClient:run => run({ history:async script => { watchedScripts.push(script); return []; }, lookup:async txid => transactions.get(txid),
      broadcast:async () => { broadcasts++; throw new Error('Sponsorship verification must stay offline.'); } }) } });
  const app = createApp({ database:':memory:', localDemo:true, clock:() => now, chain, territoryAssets:assets, politicalAssets:assets });
  app.testNow = () => now;
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  t.after(async () => { const closed=once(app.server,'close'); app.close(); await closed; assert.equal(broadcasts,0); });
  function observe(outputs, confirmations = 2) {
    const inputAmount = 275_000;
    const outputAmount = outputs.reduce((total, output) => total + output.satoshis, 0);
    const outputList = [...outputs, { script:buyer.script, satoshis:inputAmount - outputAmount - 350 }];
    // Synthetic inputs never touched a chain. The observer independently decodes and verifies the exact outputs.
    const signed = signSpend({ privateKey:buyerKey, sources:[{ txid:hash('fixture-output-' + (++sequence)), vout:0,
      script:buyer.script, satoshis:inputAmount }], outputs:outputList });
    const observed = { ...readTransaction(signed.rawHex), confirmations, height:390_020, blockHash:hash('fixture block'), blockTime:now };
    transactions.set(observed.txid, observed);
    return observed.txid;
  }
  const confirm = (player, quote) => app.ledger.submit(player, quote.id, observe(quote.outputs));
  const confirmTransaction = txid => { transactions.get(txid).confirmations = 2; };
  function endSeason(scores) {
    app.store.transaction(() => {
      const {world} = app.store.read();
      now = world.season.endsAt;
      for (const [id, score] of Object.entries(scores)) world.cities[id].score = score;
      advance(world, now);
      app.store.write(world);
    });
  }
  function seat(id, wallet) {
    app.store.addSession(hash('seat-'+id),id,initialTime + 365 * 86_400_000);
    app.store.bindWallet(id,wallet.address,wallet.publicKey,now);
  }
  return { app, chain, externalDestination, observe, confirm, confirmTransaction, watchedScripts,
    endSeason, seat, setTime:value => { now=value; } };
}

// Sponsorships quoted before the prize fund covenant used 20/80 and an operator-key prize output. They stay verifiable.
function legacy(app, chain, player, satoshis) {
  const allocation = sponsorshipAllocation(satoshis, undefined, LEGACY_SPONSOR_ALLOCATION);
  const seasonId = app.store.read().world.season.number;
  const intent = { ...chain.createIntent({ playerId:player, action:'sponsor-fund', payload:{ type:'sponsor-fund' }, satoshis, now:app.testNow(),
    allocation, event:{ seasonId, actionHash:hash(player + satoshis + app.testNow()), allocation, allocationPolicy:LEGACY_SPONSOR_ALLOCATION } }),
    title:'Sponsor funding', description:'Quoted before the prize fund covenant.', pool:'sponsor', seasonId };
  app.store.savePayment(intent);
  return intent;
}

test('the previous 20/80 policy still conserves every historical amount', () => {
  const split = total => sponsorshipAllocation(total, undefined, LEGACY_SPONSOR_ALLOCATION);
  assert.deepEqual(split(100_000),{ development:20_000, prize:80_000 });
  assert.deepEqual(split(2_730),{ development:546, prize:2_184 });
  assert.throws(() => split(2_725), /spendable/);
  assert.throws(() => split(5_001), /multiples of 5/);
  assert.throws(() => split(250_005), /spendable/);
  for (let total=legacySponsorshipPolicy.minimumSatoshis; total<=legacySponsorshipPolicy.maximumSatoshis; total+=legacySponsorshipPolicy.satoshiStep) {
    const {development,prize}=split(total);
    assert.equal(development * 5, total);
    assert.equal(development + prize, total);
    assert.ok(prize >= 546 && development >= 546);
  }
});

test('a new sponsorship cannot be quoted without the developer address and an independent prize attestor', async t => {
  const { app } = await fixture(t);
  assert.throws(() => app.ledger.create('p1',fund(sponsorshipPolicy.minimumSatoshis)), /closed until the developer address and a prize attestor/);
});
test('empty and one-player seasons carry credits forward and claims keep a fixed base', async t => {
  const { app, chain, confirm, endSeason, seat, setTime } = await fixture(t);
  const first = walletFromPrivateKey(key(910));
  const second = walletFromPrivateKey(key(911));
  const quote = legacy(app, chain, 'p1', 100_000);
  await confirm('p1',quote);
  assert.equal(app.ledger.explorer().buckets.development,20_000);
  endSeason({p1:50,p2:45,p6:100}); // Seeded cities without a session and NPCs are not entrants.
  assert.equal(app.ledger.explorer().prizes.status,'rollover');
  assert.equal(app.ledger.explorer().prizes.eligibleCount,0);
  assert.equal(app.ledger.balances('p1').claimableSatoshis,0);
  seat('p1',first);
  endSeason({p1:70,p2:50,p6:100});
  assert.equal(app.ledger.explorer().prizes.eligibleCount,1);
  assert.equal(app.ledger.balances('p1').claimableSatoshis,0);

  seat('p2',second);
  endSeason({p1:80,p2:60,p6:100});
  const next = legacy(app, chain, 'p1', 10_000);
  await confirm('p1',next);
  const current = app.ledger.explorer();
  assert.equal(current.prizes.status,'open');
  assert.equal(current.prizes.eligibleCount,2);
  assert.equal(current.prizes.rolledSatoshis,80_000);
  assert.equal(current.prizes.poolSatoshis,80_000); // Confirmed new-season sponsorships wait for their own season.
  assert.equal(current.buckets.prize,88_000);
  const expectedBase = 68_000;
  const firstClaim = current.prizes.seasonId;
  const body = { kind:'claim', address:first.address };
  assert.equal(app.ledger.quotePayout('p1',body).satoshis,27_200);
  assert.throws(() => app.ledger.quotePayout('p1',{...body,address:second.address}), /verified/);

  const source = app.store.payment(quote.id).receipt.allocations.find(output => output.role==='prize');
  const payload = { seasonId:firstClaim, prizeBase:expectedBase, policy:'season-rollover-v1' };
  const event = gameEvent('claim','p1',{...payload,satoshis:27_200,address:first.address});
  const payout = chain.preparePayout({ playerId:'p1', action:'claim', payload, satoshis:27_200, address:first.address, sources:[source], event });
  const payoutHash = hash('previously settled fixture');
  app.store.savePayment({ ...payout, pool:'sponsor', state:'credited', txid:payoutHash,
    receipt:{ txid:payoutHash, change:{ ...payout.change, txid:payoutHash } } });
  assert.equal(app.ledger.balances('p1').claimableSatoshis,0);
  assert.equal(app.ledger.quotePayout('p2',{kind:'claim',address:second.address}).satoshis,17_000);
  assert.equal(app.ledger.explorer().buckets.development,22_000); // Season withdrawals never reallocate sponsor funds.
  setTime(current.prizes.claimDeadline);
  assert.equal(app.ledger.explorer().prizes.status,'expired');
  assert.equal(app.ledger.balances('p2').claimableSatoshis,0);
});

test('one thousand small funding outputs can still support an exact claim, with excess carried forward', async t => {
  const { app, chain, endSeason, seat } = await fixture(t);
  const first = walletFromPrivateKey(key(914));
  seat('p1',first);
  seat('p2',walletFromPrivateKey(key(915)));
  const total = 2_730;
  const allocation = sponsorshipAllocation(total, undefined, LEGACY_SPONSOR_ALLOCATION);
  app.store.transaction(() => {
    for (let index=0; index<1000; index++) {
      const intent = chain.createIntent({ playerId:'p1', action:'sponsor-fund', payload:{ type:'sponsor-fund' }, now:initialTime,
        satoshis:total, allocation, event:{ seasonId:1, allocation, allocationPolicy:LEGACY_SPONSOR_ALLOCATION } });
      const txid = hash('fragmented funding fixture ' + index);
      app.store.savePayment({ ...intent, pool:'sponsor', seasonId:1, txid, state:'credited',
        receipt:{ txid, allocations:intent.outputs.map((output,vout) => ({ ...output, vout, txid })) } });
    }
  });
  endSeason({p1:80,p2:60});
  const { prizes } = app.ledger.explorer();
  assert.equal(prizes.poolSatoshis,2_184_000);
  assert.ok(prizes.deferredSatoshis > 0);
  const quote = app.ledger.quotePayout('p1',{kind:'claim',address:first.address});
  assert.equal(quote.satoshis,64_572);
  assert.equal(quote.feeSatoshis,5_316);
  assert.equal(quote.satoshis + quote.feeSatoshis, 32 * allocation.prize);
});

test('a configured developer address receives the service share and never becomes a watched or game-held script', async t => {
  const { app, externalDestination, confirm, watchedScripts } = await fixture(t,{general:true});
  // A rush is sold only for a construction in progress.
  app.store.transaction(() => { const { world } = app.store.read(); command(world,'p1',{type:'upgrade',building:'hall'},world.now); app.store.write(world); });
  const rush = app.ledger.create('p1',{type:'rush',building:'hall'});
  const development = rush.outputs.find(output => output.role === 'development');
  assert.equal(development.satoshis,800);
  assert.equal(development.address,externalDestination.address);
  assert.equal(rush.event.data.developmentAddress,externalDestination.address);
  assert.equal((await confirm('p1',rush)).state,'credited');
  assert.deepEqual(watchedScripts,[rush.outputs[0].script]);
  assert.ok(!watchedScripts.includes(externalDestination.script));
  const { buckets } = app.ledger.explorer();
  assert.equal(buckets.development,0);
  assert.equal(buckets.externalDevelopment,800);
});


test('paid raids require a registered opponent and stale funding leaves recoverable kingdom principal', async t => {
  const { app, confirm, seat } = await fixture(t);
  const attacker = walletFromPrivateKey(key(912));
  const defender = walletFromPrivateKey(key(913));
  const order = { type:'attack-paid', target:'p2' };
  seat('p1',attacker);
  assert.throws(() => app.ledger.create('p1',order), /registered opponent/);
  seat('p2',defender);
  const quote = app.ledger.create('p1',order);
  assert.equal(quote.satoshis,3_600);
  const {world} = app.store.read();
  world.cities.p2.shieldUntil = initialTime + 3_600_000;
  app.store.write(world);

  const recovery = await confirm('p1',quote);
  assert.equal(recovery.state,'credited');
  assert.equal(recovery.fulfillment.status,'review');
  assert.deepEqual(recovery.fulfillment.recovery,{ pool:'kingdom', satoshis:3_000, reserveSatoshis:600 });
  assert.equal(app.store.read().world.battles.length,0);
  const vault = app.ledger.balances('p1');
  assert.equal(vault.kingdomSatoshis,3_000);
  assert.equal(vault.lockedSatoshis,0);
  assert.equal(app.ledger.explorer().buckets.settlementFees,600);
  const withdrawal = app.ledger.quotePayout('p1',{kind:'kingdom-withdraw',satoshis:2_644,address:attacker.address});
  assert.equal(withdrawal.feeSatoshis,356);
});

test('previously committed single-output sponsorship retains its original terms', async t => {
  const { app, chain, confirm }=await fixture(t);
  const original=chain.createIntent({ playerId:'p1', action:'sponsor-fund', payload:{ type:'sponsor-fund' },
    satoshis:1_000, now:initialTime, event:{ seasonId:1, allocation:null } });
  app.store.savePayment({ ...original, pool:'sponsor', seasonId:1 });
  const resumed=app.store.payment(original.id);
  assert.equal(resumed.id,original.id);
  assert.deepEqual(roles(resumed.outputs),[['funding',1_000],['event',0]]);
  const payment=await confirm('p1',resumed);
  assert.equal(payment.state,'credited');
  const { sponsorship,buckets }=app.ledger.explorer();
  assert.equal(sponsorship.confirmed.legacyPrize,1_000);
  assert.equal(buckets.development,0);
  assert.equal(buckets.prize,1_000);
});
