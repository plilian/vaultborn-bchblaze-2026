import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHeader } from '../packages/chain-observer/primitives.mjs';
import { walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { acceptRaffle, advanceRaffles, publicRaffle, quoteRaffle, rafflePolicy, raffleSample } from '../apps/game-server/territory-raffles.mjs';

const hour = 3_600_000;
const now = 1_795_000_000_000;
const site = 'amber-grove';
const other = 'moonwell';
const addresses = ['1','2','3'].map(number => walletFromPrivateKey(number.padStart(64,'0')).address);
const head = {network:'chipnet',height:36008};
const world = () => ({
  cities:{one:{tutorial:true,alliance:'sun'},two:{tutorial:true,alliance:'moon'},three:{tutorial:true,alliance:'sun'}},
});
function payment(game, player, address, i, target = site) {
  const { action,satoshis } = quoteRaffle(game,player,target,address,head,now);
  const txid = i.toString(16).padStart(64,'0');
  return { id:'entry'+i, playerId:player, payload:action, txid, receipt:{height:head.height,satoshis,
    allocations:[{role:'battle',satoshis:satoshis/2}]} };
}
function block(round, i = 1) {
  const raw = i.toString(16).padStart(8,'0') + '0'.repeat(152);
  return {raw, hash:parseHeader(raw).hash, network:'chipnet',height:round.drawHeight,confirmations:round.confirmations};
}

test('a paid rare entry must be included in its fixed announced window and pass the unique wallet/alliance lock', () => {
  const game = world();
  const first = payment(game,'one',addresses[0],1);
  assert.equal(first.payload.round.startHeight,36000);
  assert.equal(first.payload.round.closeHeight,36019);
  assert.equal(first.payload.round.drawHeight,36027);
  assert.equal(first.receipt.satoshis,7400);
  assert.throws(() => acceptRaffle(game,{...first,receipt:{...first.receipt,height:36020}},addresses[0],now),/announced Chipnet window/);
  acceptRaffle(game,first,addresses[0],now);
  assert.throws(() => quoteRaffle(game,'one',site,addresses[0],head,now),/one active rare raffle/);
  assert.throws(() => quoteRaffle(game,'three',other,addresses[2],head,now),/one active rare raffle/);
  assert.throws(() => quoteRaffle(game,'two',other,addresses[0],head,now),/one active rare raffle/);
  assert.throws(() => quoteRaffle(game,'two',other,addresses[1],{...head,height:36019},now),/entry window is closed/);
});

test('the witnessed block decides a reproducible draw and each entrant gets back exactly their escrow', () => {
  const game = world();
  acceptRaffle(game,payment(game,'one',addresses[0],34),addresses[0],now);
  acceptRaffle(game,payment(game,'two',addresses[1],22),addresses[1],now+1);
  const round = game.territoryRaffles[site].round;
  const entropy = block(round);
  const mirrored = raffleSample({...round,entries:[...round.entries].reverse()},entropy);
  assert.deepEqual(raffleSample(round,entropy),mirrored);
  assert.throws(() => raffleSample(round,{...entropy,height:entropy.height-1}),/draw block/);
  const earlier = new Map([[round.drawHeight,{...entropy,confirmations:5}]]);
  assert.equal(advanceRaffles(game,{now:now+1000,blocks:earlier}).length,0);
  const mature = new Map([[round.drawHeight,entropy]]);
  assert.equal(advanceRaffles(game,{now:now+1000,blocks:mature,ready:() => false}).length,0);
  const [drawn] = advanceRaffles(game,{now:now+1000,blocks:mature});
  assert.equal(drawn.winner,mirrored.winner);
  assert.equal(drawn.lease.expiresAt - drawn.lease.startsAt,72*hour);
  assert.deepEqual(drawn.payout,[{player:'one',satoshis:3700},{player:'two',satoshis:3700}]);
  assert.equal(publicRaffle(game,site,head,drawn.lease.expiresAt-1).lease.playerId,drawn.winner);
  const [expired] = advanceRaffles(game,{now:drawn.lease.expiresAt,blocks:mature});
  assert.equal(expired.kind,'lease-expired');
  assert.equal(expired.preceding,drawn.id);
  assert.equal(publicRaffle(game,site,head,drawn.lease.expiresAt).lease,null);
  assert.equal(advanceRaffles(game,{now:drawn.lease.expiresAt+1}).length,0);
});

test('a missing final block expires without granting any extraction and releases principal once', () => {
  const game = world();
  acceptRaffle(game,payment(game,'one',addresses[0],39),addresses[0],now);
  const [refund] = advanceRaffles(game,{now:now+rafflePolicy.timeoutHours*hour});
  assert.equal(refund.round.status,'refunded');
  assert.equal(refund.winner,null);
  assert.equal(refund.lease,null);
  assert.deepEqual(refund.payout,[{player:'one',satoshis:3700}]);
  assert.equal(advanceRaffles(game,{now:now+3*24*hour}).length,0);
});

test('two entrants are selected at similar rates and reversing arrival order changes no draw', () => {
  const game = world();
  acceptRaffle(game,payment(game,'one',addresses[0],99),addresses[0],now);
  acceptRaffle(game,payment(game,'two',addresses[1],17),addresses[1],now+1);
  const round = game.territoryRaffles[site].round;
  let first = 0;
  for (let i=1;i<=2000;i++) {
    const entropy = block(round,i);
    const sampled = raffleSample(round,entropy);
    if (sampled.winner === 'one') first++;
    assert.equal(sampled.winner,raffleSample({...round,entries:[...round.entries].reverse()},entropy).winner);
  }
  assert.ok(first >= 910 && first <= 1090, 'Distribution sample selected the first entrant ' + first + ' times.');
});
