import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kingdom, liveFees } from '../packages/game-engine/treasury.mjs';

const now = 1_794_845_600_000;
const wallets = {
  p1:'bchtest:qp3w6c2x3syvjpfn3tf5muffvlnggpfzuy7s6zr6z6',
  p2:'bchtest:qzygq4xr0d0hq0lcku5xwj2dc6w9vvxqjqfla9ra3n',
};
const linked = (id) => wallets[id];
const outcome = (attacker, defender, winner = 'attacker') => ({ kind:'raid', paid:true, attacker, defender, winner });

function payment(id, playerId, action, satoshis) {
  const txid = createHash('sha256').update(id).digest('hex');
  const allocation = kingdom.split(satoshis,action);
  return { id, playerId, action, satoshis, state:'confirmed', txid, receipt:{txid,
    allocations:Object.entries(allocation).map(([role, sats], vout) => ({role,satoshis:sats,vout,txid}))
  }};
}

function setup() {
  const world = { cities:{ p1:{optIn:true},p2:{optIn:true},p3:{npc:true}, p4:{optIn:true} } };
  kingdom.apply(world,payment('fund','p2','premium',20000),null,now);
  return world;
}

test('live gameplay allocations sum exact satoshis with 20/15/15/50 shares', () => {
  assert.equal(liveFees.protectorate,20*liveFees.attack);
  assert.deepEqual(kingdom.split(liveFees.attack,'attack-paid'),{development:1200,burn:900,prize:900,battle:3000});
  assert.deepEqual(kingdom.split(liveFees.premium,'premium'),{development:900,burn:675,prize:675,kingdom:2250});
  for (const amount of [0,15,3999,4001,NaN,'4000',Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => kingdom.split(amount,'premium'),/exact satoshi allocation/);
  }
  assert.throws(() => kingdom.split(4000,'vault-deposit'),/outside the gameplay/);
});

test('a paid attack captures at most 20% once per pair in either direction and preserves escrow and principal', () => {
  const world = setup();
  kingdom.commit(world,'p2',5000,now,wallets.p2);
  const raid = payment('raid','p1','attack-paid',liveFees.attack);
  const winner = outcome('p1','p2');
  const settlement = kingdom.apply(world,raid,winner,now,linked);
  assert.equal(winner.treasury,settlement);
  assert.equal(settlement.capturedSatoshis,1000);
  assert.deepEqual(settlement.balances,{attacker:{before:0, after:4000},
    defender:{before:10000, after:9000, committedBefore:5000, committedAfter:4000}});
  assert.equal(kingdom.balance(world,'p1',now).kingdomSatoshis,4000);
  assert.equal(kingdom.balance(world,'p2',now).kingdomSatoshis,9000);
  kingdom.apply(world,raid,winner,now,linked);
  assert.equal(kingdom.balance(world,'p1',now).kingdomSatoshis,4000);
  assert.throws(() => kingdom.apply(world,{...raid,id:'forged-intent'},winner,now,linked),/already accounted/);
  kingdom.commit(world,'p1',4000,now,wallets.p1);
  const rematch = outcome('p2','p1');
  kingdom.apply(world,payment('reciprocal','p2','attack-paid',liveFees.attack),rematch,now+1000,linked);
  assert.equal(rematch.treasury.capturedSatoshis,0);
});

test('defender escrow requires explicit wallet-bound commitment, distinct wallet ownership and fair participation', () => {
  const world = setup();
  assert.throws(() => kingdom.commit(world,'p2',9000,now),/Verify a Chipnet wallet/);
  kingdom.commit(world,'p2',9000,now,wallets.p2);
  kingdom.apply(world,payment('rebound','p1','attack-paid',liveFees.attack),outcome('p1','p2','defender'),now,
    id => id === 'p2' ? wallets.p1 : wallets.p2);
  kingdom.apply(world,payment('shared','p1','attack-paid',liveFees.attack),outcome('p1','p2','defender'),now,() => wallets.p2);
  kingdom.apply(world,payment('unverified','p4','attack-paid',liveFees.attack),outcome('p4','p2','defender'),now,linked);
  assert.equal(kingdom.balance(world,'p2',now).kingdomSatoshis,10000);
  const loss = outcome('p1','p2','defender');
  kingdom.apply(world,payment('raid','p1','attack-paid',liveFees.attack),loss,now,linked);
  assert.equal(loss.treasury.recipient,'p2');
  assert.equal(kingdom.balance(world,'p2',now).kingdomSatoshis,13000);
  assert.equal(kingdom.balance(world,'p2',now).atRiskSatoshis,9000);
  assert.throws(() => kingdom.debit(world,'p2',4001,'withdrawal',now),/uncommitted/);
  const debit = kingdom.debit(world,'p2',4000,'withdrawal',now);
  assert.deepEqual(kingdom.debit(world,'p2',4000,'withdrawal',now),debit);
  assert.throws(() => kingdom.debit(world,'p2',4001,'withdrawal',now),/other debit/);
  kingdom.commit(world,'p2',0,now,wallets.p2);
  assert.equal(kingdom.balance(world,'p2',now + 3600000).atRiskSatoshis,9000);
  assert.equal(kingdom.balance(world,'p2',now + 12 * 3600000).atRiskSatoshis,0);
});

test('verified failed fulfillment recovers the exact owner share and invalid receipts never credit', () => {
  const world = setup();
  const row = payment('late','p1','attack-paid',liveFees.attack);
  row.late = true;
  for (const invalid of [{...row,state:'seen_in_mempool'},{...row,txid:'bad'}, {...row,receipt:{...row.receipt,allocations:row.receipt.allocations.slice(0,1)}}]) {
    assert.throws(() => kingdom.apply(world,invalid,null,now),/confirmed gameplay/);
  }
  assert.equal(kingdom.balance(world,'p1',now).kingdomSatoshis,0);
  const recovery = kingdom.apply(world,row,null,now);
  assert.equal(recovery.effect,'payment-recovered');
  assert.equal(recovery.recipient,'p1');
  assert.equal(recovery.capturedSatoshis,0);
  assert.equal(kingdom.balance(world,'p1',now).kingdomSatoshis,3000);
});
