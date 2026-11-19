import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { createApp } from '../apps/game-server/index.mjs';
import { awayThreshold } from '../apps/game-server/kingdom-chronicle.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';
import { DAY, dailyLevy, resources, resourceValues } from '../config/economy.mjs';
import { createWorld, snapshot } from '../packages/game-engine/index.mjs';
import { marketQuote } from '../packages/game-engine/economy.mjs';

async function start(clock, database=':memory:') {
  const disabledAssets={enabled:false,list:()=>[],close:()=>{}};
  const chain=createChain({enabled:false,transport:{withClient:async()=>{throw Error('Offline fixture accessed a blockchain transport.');}}});
  const app=createApp({database,clock,chain,localDemo:true,territoryAssets:disabledAssets,politicalAssets:disabledAssets});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  const base = `http://127.0.0.1:${app.server.address().port}/api/`;
  const client = (cookie = '') => ({
    get cookie() { return cookie; },
    async request(path,body) {
      const response = await fetch(base+path,{
        headers:{Cookie:cookie,...(body&&{'content-type':'application/json'})},
        ...(body&&{method:'POST',body:JSON.stringify(body)}),
      });
      cookie=response.headers.get('set-cookie')?.split(';')[0]??cookie;
      return {status:response.status,body:await response.json()};
    },
  });
  return {app,client,async close(){
    if (app.server.listening) {
      const finished=once(app.server,'close');
      app.close();
      await finished;
    }
  }};
}

test('daily receipts, market quotes and recruit forecasts match the committed action',async t=>{
  let now=Date.UTC(2026,10,18);
  const server=await start(()=>now);
  t.after(server.close);
  const player=server.client();
  const initial=(await player.request('session',{demo:'p1'})).body.state;
  assert.deepEqual(initial.player.dailyReward.reward,dailyLevy);
  assert.equal(initial.player.dailyReward.status,'available');

  const collect={type:'collect',requestId:'daily-check'};
  const claimed=await player.request('command',collect);
  assert.equal(claimed.status,200,JSON.stringify(claimed.body));
  assert.deepEqual(claimed.body.result.collected,initial.player.dailyReward.claimable);
  assert.equal(claimed.body.result.availableAt,now+DAY);
  assert.deepEqual((await player.request('command',collect)).body.result,claimed.body.result);
  assert.equal((await player.request('command',{...collect,requestId:'different-claim'})).body.code,'levy_recent');
  assert.equal((await player.request('state')).body.player.dailyReward.status,'claimed');
  assert.equal((await player.request('market-preview?give=wood&take=stone&amount=2')).status,400);
  const quote=(await player.request('market-preview?give=wood&take=stone&amount=50')).body;
  assert.equal(quote.eligible,true);
  const stock=claimed.body.state.player.resources;
  const trade={type:'trade',give:'wood',take:'stone',amount:50,requestId:'market-check'};
  const stale=await player.request('command',{...trade,quotedReceived:quote.received+1});
  assert.equal(stale.body.code,'market_quote_changed');
  assert.deepEqual((await player.request('state')).body.player.resources,stock);
  const cleared=await player.request('command',{...trade,quotedReceived:quote.received});
  assert.equal(cleared.body.result.received,quote.received);
  assert.equal(cleared.body.state.player.resources.wood,stock.wood-50);
  assert.equal(cleared.body.state.player.resources.stone,stock.stone+quote.received);
  assert.equal((await player.request('command',{...trade,quotedReceived:quote.received})).body.state.player.marketHistory.length,1);

  const forecast=(await player.request('training-preview?unit=infantry&count=2')).body;
  assert.equal(forecast.eligible,true);
  const order=await player.request('command',{type:'train',unit:'infantry',count:2,requestId:'train-check'});
  assert.equal(order.status,200,JSON.stringify(order.body));
  assert.equal(order.body.result.completesAt,forecast.completesAt);
  assert.deepEqual(order.body.result.cost,forecast.cost);
  assert.equal((await player.request('training-preview?unit=infantry&count=1')).body.code,'training_busy');
  assert.equal((await player.request('training-preview?unit=bad&count=2')).status,400);
  now+=DAY;
  assert.equal((await player.request('state')).body.player.dailyReward.status,'available');
});

test('returning after an idle interval reports each real completion once across a restart',async t=>{
  const workspace=resolve('var');
  await mkdir(workspace,{recursive:true});
  const fixture=await mkdtemp(resolve(workspace,'chronicle-'));
  const db=resolve(fixture,'game.sqlite');
  let now=Date.UTC(2026,10,18);
  let server=await start(()=>now,db);
  t.after(async()=>{
    await server.close();
    if (dirname(resolve(fixture))===workspace) await rm(fixture,{recursive:true,force:true});
  });
  let player=server.client();
  const earlier=(await player.request('session',{demo:'p1'})).body.state;
  const training=await player.request('command',{type:'train',unit:'infantry',count:2,requestId:'overnight-train'});
  const order=await player.request('command',{type:'upgrade',building:'hall',requestId:'overnight-build'});
  assert.equal(order.status,200,JSON.stringify(order.body));
  assert.equal(training.status,200,JSON.stringify(training.body));
  const departure=(await player.request('state')).body;
  assert.equal(departure.offlineReport,null);
  const session=player.cookie;
  now+=awayThreshold+1;
  assert.equal((await player.request('state?background=1')).body.offlineReport,null);
  await server.close();
  server=await start(()=>now,db);
  player=server.client(session);
  const returned=(await player.request('state')).body;
  const report=returned.offlineReport;
  assert.equal(report.unread,true);
  assert.equal(report.troopChanges.infantry,returned.player.troops.infantry-departure.player.troops.infantry);
  assert.equal(report.resourceChanges.wood,returned.player.resources.wood-departure.player.resources.wood);
  assert.equal(report.events.filter(event=>event.job?.id===order.body.result.id).length,1);
  assert.equal(report.events.filter(event=>event.job?.id===training.body.result.id).length,1);
  assert.equal(returned.player.buildings.hall,earlier.player.buildings.hall+1);
  assert.equal((await player.request('state')).body.offlineReport.id,report.id);
  const other=server.client();
  await other.request('session',{demo:'p2'});
  assert.equal((await other.request('offline-report/dismiss',{id:report.id})).status,404);
  assert.equal((await player.request('offline-report/dismiss',{id:report.id})).body.unread,false);
  await server.close();
  server=await start(()=>now,db);
  assert.equal((await server.client(session).request('state')).body.offlineReport.unread,false);
});

test('the current market cannot grow normalized inventory through repeated exchanges',()=>{
  const now=Date.UTC(2026,10,18);
  const world=createWorld(now);
  const city=world.cities.p1;
  const capacity=snapshot(world,'p1',now).player.stats.economy.capacity;
  let completed=0;
  for (const level of [1,3,6,9]) {
    city.buildings.market=level;
    for (const hero of ['warden','merchant']) {
      city.hero=hero;
      for (const give of resources) for (const take of resources) {
        if (give===take) continue;
        for (const amount of [10,25,50,100,250,500]) {
          city.resources=Object.fromEntries(resources.map(id=>[id,0]));
          city.resources[give]=amount;
          const quote=marketQuote(city,{give,take,amount},now);
          assert.ok(quote.received*resourceValues[take]<=amount*resourceValues[give]);
          assert.ok(quote.rate<=.86);
          if (!quote.eligible || quote.received>500 || quote.received<10 || quote.received>capacity[take]) continue;
          city.resources[take]=quote.received;
          const back=marketQuote(city,{give:take,take:give,amount:quote.received},now);
          if (back.eligible) {
            assert.ok(back.received<amount);
            completed++;
          }
        }
      }
    }
  }
  assert.ok(completed>=100);
});
