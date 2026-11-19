import { once } from 'node:events';
import { Agent, request } from 'node:http';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';

const clients = Number(process.argv.find(value=>value.startsWith('--clients='))?.slice(10) ?? 64);
const registrationsOnly = process.argv.includes('--registrations-only');
const verifyRestart = process.argv.includes('--verify-restart');
assert.ok(Number.isSafeInteger(clients) && clients>0 && clients<=1000,'Choose a client count from 1 to 1,000.');
const gameplaySample = registrationsOnly ? 0 : Math.min(clients,40);
const assets={enabled:false,list:()=>[],authority:()=>null,close:()=>{}};
const chain=createChain({enabled:false,transport:{withClient:async()=>{throw new Error('Load checks do not access BCH networks.');}}});
const scratchRoot = resolve('var');
if (verifyRestart) await mkdir(scratchRoot,{recursive:true});
const scratch = verifyRestart ? await mkdtemp(resolve(scratchRoot,'frontier-load-')) : null;
const options = {database:scratch ? resolve(scratch,'world.sqlite') : ':memory:', localDemo:false,
  chain,territoryAssets:assets,politicalAssets:assets,registrationRate:1500};
let app;
let base;
let transport;
async function startServer() {
  app = createApp(options);
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  base = `http://127.0.0.1:${app.server.address().port}/api/`;
  transport = new Agent({keepAlive:true,maxSockets:64});
}
async function close() {
  if (!app?.server.listening) return;
  transport.destroy();
  const closed = once(app.server,'close');
  app.close();
  await closed;
}
const results = [];
const players = new Set();
const start = performance.now();
async function measured(path, {body,...settings}) {
  const before = performance.now();
  const {response,data} = await new Promise((resolve,reject)=>{
    const outgoing = request(base+path,{...settings,agent:transport},res=>{
      const chunks = [];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('error',reject);
      res.on('end',()=>{
        try { resolve({response:res,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))}); }
        catch (error) { reject(error); }
      });
    });
    outgoing.on('error',reject);
    outgoing.end(body);
  });
  assert.equal(response.statusCode,200,JSON.stringify(data));
  results.push(performance.now() - before);
  return { response, data };
}
try {
  await startServer();
  const registrations = await Promise.all(Array.from({length:clients}, async (_, id) => {
    const profile = { name:`Commander ${id}`,cityName:`Province ${id}`,faction:'azure' };
    const { response, data } = await measured('session', { method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({ ...profile, entry:'new', includeState:!registrationsOnly }) });
    assert.equal(data.result.created,true);
    if (registrationsOnly) assert.equal(data.state,undefined);
    players.add(data.result.player);
    const Cookie = response.headers['set-cookie'][0].split(';')[0];
    return {profile,player:data.result.player,Cookie};
  }));
  await Promise.all(registrations.slice(0,gameplaySample).map(async ({profile,player,Cookie}) => {
    for (const body of [{type:'found',...profile},{type:'tutorial',action:'skip',step:'welcome'},
      {type:'collect'},{type:'upgrade',building:'hall'}]) {
      await measured('command',{ method:'POST',headers:{ Cookie,'content-type':'application/json'},body:JSON.stringify(body) });
      const { data:state } = await measured('state',{headers:{Cookie}});
      assert.equal(state.player.id,player);
    }
  }));
  assert.equal(players.size,clients);
  const {world} = app.store.read();
  const firstHoldings = world.territories.filter(site=>site.protected && players.has(site.owner));
  const newPermanentTerritories = world.territories.filter(site=>site.region && site.category==='unclaimed').length;
  if (registrationsOnly) assert.equal(newPermanentTerritories,0);
  assert.equal(firstHoldings.length,clients);
  assert.equal(new Set(firstHoldings.map(site=>site.owner)).size,clients);
  assert.equal(new Set(firstHoldings.map(site=>site.x+':'+site.y)).size,clients);
  for (const site of firstHoldings) {
    assert.equal(site.id,'starter-'+site.owner);
    assert.equal(site.nextUpkeep,null);
    assert.deepEqual([site.x,site.y],[world.cities[site.owner].x,world.cities[site.owner].y]);
  }
  if (verifyRestart) {
    await close();
    await startServer();
    const {world:reopened} = app.store.read();
    assert.deepEqual(reopened.atlas,world.atlas);
    const saved = new Map(reopened.territories.map(site=>[site.id,site]));
    for (const original of firstHoldings) assert.deepEqual(saved.get(original.id),original);
    const last = registrations.at(-1);
    const { data:state } = await measured('state',{headers:{Cookie:last.Cookie}});
    assert.equal(state.player.id,last.player);
    assert.equal(state.player.region,world.cities[last.player].region);
  }
  results.sort((a,b)=>a-b);
  const round = n => Math.round(n);
  console.log(JSON.stringify({ concurrentSessions:clients, transportSocketLimit:64, gameplaySample,
    protectedHomelands:firstHoldings.length, newPermanentTerritories, verifiedRestart:verifyRestart,
    regions:world.atlas.regions.length, requests:results.length, durationMs:round(performance.now()-start),
    p50Ms:round(results[Math.floor(results.length*.5)]), p95Ms:round(results[Math.floor(results.length*.95)]), maxMs:round(results.at(-1)), failures:0 },null,2));
} finally {
  await close();
  if (scratch && dirname(scratch)===scratchRoot) await rm(scratch,{recursive:true,force:true});
}
