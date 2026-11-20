import { DAY, HOUR, MINUTE, resources } from '../../config/economy.mjs';
import { armyPower, digest, seeded, troopTotal } from './combat.mjs';
import { activeTreaty, activity, attackEligibility, credit, getCity, has, notify, requireRule, subtract } from './world.mjs';
import { diplomacyRelationship } from './diplomacy.mjs';
import { recordGovernmentEvent } from './government.mjs';

const rules=Object.freeze({routeHours:48,maxRoutes:4,maxSanctions:3,maxHours:24,maxCargo:200,smuggleCargo:50,
  routeCooldown:20*MINUTE,shipCooldown:6*MINUTE,smuggleCooldown:HOUR,breakCooldown:2*HOUR,maxTariff:25});
const measures=new Set(['tariff','embargo','blockade','restriction']);
const siteBy=(world,id)=>(world.territories ?? []).find(site=>site.id===id);
const office=world=>world.politicalTrade??={routes:[],sanctions:[],shipments:[],history:[],pairLimits:{}};
const owned=(world,player,site)=>site && !site.protected && site.owner===player;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const active=(row,now)=>row.status==='active' && row.endsAt>now;
const includes=(route,id)=>route.from===id || route.to===id;
const routeOf=(world,id)=>office(world).routes.find(route=>route.id===id);
const isResource=key=>resources.includes(key);
const allyTrade=(world,one,two,now)=>Boolean(one.alliance && one.alliance===two.alliance || activeTreaty(world,one,two,['trade']) ||
  diplomacyRelationship(world,one.id,two.id,now).trade);

function record(world,kind,actor,target,detail,now) {
  const row={id:'te'+(++world.seq),kind,actor,target,at:now,...detail};
  const book=office(world);
  book.history.unshift(row);
  book.history.length=Math.min(book.history.length,140);
  return row;
}

function routePath(world,actor,target,territory,now) {
  if (!territory) {
    requireRule(distance(actor,target)<=.48,'trade_range','Choose a closer partner or a controlled supply waypoint.');
    return [];
  }
  const site=siteBy(world,territory);
  const shared=site?.owner && diplomacyRelationship(world,actor.id,site.owner,now).territoryIds.includes(site.id);
  requireRule(owned(world,actor.id,site)||shared,'trade_territory','Use a controlled territory or an explicitly shared supply waypoint.');
  requireRule(distance(actor,site)<=.44 && distance(site,target)<=.52,'trade_range','The waypoint does not connect both markets.');
  return [site.id];
}

function pathStillValid(world,route,now) {
  const from=world.cities[route.from],to=world.cities[route.to];
  if (!allyTrade(world,from,to,now)) return false;
  return route.territories.every(id=>{
    const site=siteBy(world,id);
    return owned(world,route.from,site)||Boolean(site?.owner && diplomacyRelationship(world,route.from,site.owner,now).territoryIds.includes(id));
  });
}

function controlsRoute(world,sanction,route) {
  if (!includes(route,sanction.to)) return false;
  if (!sanction.territory) return includes(route,sanction.from);
  return owned(world,sanction.from,siteBy(world,sanction.territory)) && route.territories.includes(sanction.territory);
}

function routePressure(world,route,resource,now) {
  return office(world).sanctions.filter(sanction=>active(sanction,now) && controlsRoute(world,sanction,route) &&
    (!sanction.resource || sanction.resource===resource));
}

function routeSummary(world,route,now) {
  if (!active(route,now)) return {status:route.status};
  if (!pathStillValid(world,route,now)) return {status:'blocked',reason:'Treaty ended or a supply waypoint changed control.'};
  const pressure=routePressure(world,route,route.resource,now);
  const blocked=pressure.find(sanction=>['embargo','blockade'].includes(sanction.kind));
  const tariff=Math.min(rules.maxTariff,pressure.reduce((sum,item)=>sum+(item.kind==='tariff'?item.rate:0),0));
  const capacity=pressure.some(sanction=>sanction.kind==='restriction') ? Math.floor(route.capacity*.45) : route.capacity;
  return {status:blocked?'blocked':'active',capacity,tariff,blockadeId:blocked?.id,reason:blocked ?
    'Limited by '+world.cities[blocked.from].name+' · '+blocked.kind : tariff ? tariff+'% tariff on this route.' : ''};
}

function openRoute(world,actor,input,now) {
  const other=getCity(world,input.target);
  requireRule(actor.id!==other.id && !other.npc && allyTrade(world,actor,other,now),'trade_permission',
    'A trade agreement or shared alliance is required before opening this route.');
  requireRule(isResource(input.resource),'trade_resource','Choose the resource registered for this route.',400);
  const book=office(world);
  const routes=book.routes.filter(route=>route.from===actor.id && active(route,now));
  requireRule(routes.length<rules.maxRoutes && !routes.some(route=>route.to===other.id && route.resource===input.resource),
    'trade_routes','Your registry is full or already serves this resource and destination.');
  const territories=routePath(world,actor,other,input.territory,now);
  subtract(actor,{food:28,wood:25});
  const route={id:'tr'+(++world.seq),from:actor.id,to:other.id,resource:input.resource,territories,status:'active',createdAt:now,
    endsAt:now+rules.routeHours*HOUR,capacity:Math.min(rules.maxCargo,80+actor.buildings.market*20),shipAfter:now,rerouteAfter:now};
  book.routes.push(route);
  notify(world,other.id,actor.name+' opened an approved trade route.',now,'diplomacy');
  record(world,'trade-route',actor.id,other.id,{route:route.id,text:'A commissioned route is open.'},now);
  return route;
}

function launch(world,actor,input,now,smuggle) {
  const route=routeOf(world,input.id);
  requireRule(route && active(route,now) && (route.from===actor.id || smuggle && route.to===actor.id),
    'trade_route','Choose an active route you can supply.',403);
  requireRule(pathStillValid(world,route,now),'trade_permission','Restore a valid border route and agreement first.');
  requireRule(input.resource===route.resource,'trade_resource','Use the resource registered on this route.',400);
  requireRule(now>=route.shipAfter,'trade_cooldown','Wait for the prior shipping window.');
  const summary=routeSummary(world,route,now);
  const cap=smuggle ? rules.smuggleCargo : summary.capacity;
  requireRule(Number.isSafeInteger(input.amount) && input.amount>=10 && input.amount<=cap,'trade_capacity','Choose between 10 and '+cap+' units.',400);
  requireRule(smuggle ? Boolean(summary.blockadeId) : !summary.blockadeId,'trade_blocked',
    smuggle?'Only an active embargo or blockade permits smuggling.':'Negotiate, reroute or run the blockade.');
  const target=route.from===actor.id ? route.to : route.from;
  const cost={[input.resource]:input.amount};
  cost.food=(cost.food??0)+(smuggle?18:4);
  if (smuggle) cost.wood=(cost.wood??0)+12;
  subtract(actor,cost);
  const book=office(world);
  route.shipAfter=now+(smuggle?rules.smuggleCooldown:rules.shipCooldown);
  const shipment={id:'sh'+(++world.seq),route:route.id,from:actor.id,to:target,resource:route.resource,amount:input.amount,
    smuggle,status:'in-transit',path:[...route.territories],createdAt:now,arrivesAt:now+(smuggle?7:4)*MINUTE};
  book.shipments.push(shipment);
  return shipment;
}

function reroute(world,actor,input,now) {
  const route=routeOf(world,input.id);
  requireRule(route && route.from===actor.id && active(route,now),'trade_route','Only the route registrar can edit this route.',403);
  requireRule(now>=route.rerouteAfter,'trade_cooldown','Wait before reopening the route itinerary.');
  const alternatives=routePath(world,actor,getCity(world,route.to),input.territory,now);
  requireRule(alternatives.join('|')!==route.territories.join('|'),'trade_same_route','Choose a different viable waypoint.');
  subtract(actor,{wood:15,food:20});
  route.territories=alternatives;
  route.rerouteAfter=now+rules.routeCooldown;
  record(world,'trade-rerouted',actor.id,route.to,{route:route.id,text:'The registrar changed the next shipment itinerary.'},now);
  return route;
}

function impose(world,actor,input,now,budget) {
  const target=getCity(world,input.target);
  requireRule(measures.has(input.kind) && !target.npc && actor.id!==target.id && actor.optIn && target.optIn,
    'sanction_target','Choose an eligible kingdom and economic measure.',400);
  requireRule(input.resource==null || isResource(input.resource),'trade_resource','Choose a valid resource restriction.',400);
  const hours=input.hours ?? 6;
  requireRule(Number.isSafeInteger(hours) && hours>=1 && hours<=rules.maxHours,'sanction_duration','Set a duration from 1 to 24 hours.',400);
  const site=input.territory && siteBy(world,input.territory);
  requireRule(!input.territory || owned(world,actor.id,site),'sanction_territory','You must control the named waypoint.');
  requireRule(input.kind!=='blockade' || site?.category==='strategic','sanction_blockade','A border blockade requires a strategic holding you control.');
  const book=office(world);
  const pending={from:actor.id,to:target.id,territory:site?.id??null};
  const affected=book.routes.filter(route=>active(route,now) && controlsRoute(world,pending,route) &&
    (!input.resource || input.resource===route.resource));
  requireRule(affected.length>0,'sanction_jurisdiction','No active trade in the selected resource crosses a route you control.');
  requireRule(book.sanctions.filter(item=>item.from===actor.id && active(item,now)).length<rules.maxSanctions &&
    !book.sanctions.some(item=>item.from===actor.id && item.to===target.id && item.kind===input.kind && item.createdAt>now-6*HOUR),
  'sanction_cooldown','Your diplomatic office cannot repeat this measure yet.');
  subtract(budget??actor,input.kind==='blockade'?{food:55,iron:34,wood:30}:{food:27,wood:22});
  const rate=input.kind==='tariff'?15:0;
  const sanction={...pending,id:'sa'+(++world.seq),kind:input.kind,resource:input.resource??null,rate,createdAt:now,
    endsAt:now+hours*HOUR,status:'active',routeIds:affected.map(route=>route.id),impact:affected.length+' route'+(affected.length===1?'':'s')+' at issuance'};
  book.sanctions.push(sanction);
  recordGovernmentEvent(world,'sanction',{actor:actor.id,target:target.id,id:sanction.id},now);
  record(world,input.kind,actor.id,target.id,{sanction:sanction.id,text:sanction.impact},now);
  notify(world,target.id,actor.name+' imposed a '+input.kind+' on '+sanction.impact+'.',now,'diplomacy',{title:'Sanction imposed',threat:true});
  activity(world,'diplomacy',actor.name+' imposed a '+input.kind+' on controlled trade.',now);
  return sanction;
}

function lift(world,sanction,now,status) {
  if (sanction.status!=='active') return sanction;
  sanction.status=status;
  sanction.endedAt=now;
  recordGovernmentEvent(world,'sanction-lifted',{actor:sanction.from,target:sanction.to,id:sanction.id},now);
  record(world,'trade-measure-ended',sanction.from,sanction.to,{sanction:sanction.id,text:status},now);
  return sanction;
}

function breakBlockade(world,actor,input,now) {
  const book=office(world);
  const sanction=book.sanctions.find(item=>item.id===input.id);
  requireRule(sanction && sanction.to===actor.id && sanction.kind==='blockade' && active(sanction,now),
    'sanction_break','Only the affected kingdom can contest an active border blockade.',403);
  requireRule(now>=(book.pairLimits[`${actor.id}:${sanction.from}`]??0),'sanction_cooldown','Allow two hours before repeating an escort attempt.');
  const issuer=getCity(world,sanction.from);
  const eligibility=attackEligibility(world,actor,issuer,now);
  requireRule(eligibility.ok,eligibility.code,eligibility.reason);
  requireRule(book.routes.some(route=>active(route,now) && controlsRoute(world,sanction,route)),'sanction_break','No live route requires an escort.');
  subtract(actor,{iron:35,food:60,wood:26});
  book.pairLimits[`${actor.id}:${issuer.id}`]=now+rules.breakCooldown;
  const power=armyPower(actor.troops),defense=armyPower(issuer.troops);
  const drift=seeded(digest([world.secret,sanction.id,actor.id,Math.floor(now/HOUR)]))();
  const won=power*(.94+drift*.16)>(defense*(1.03+siteBy(world,sanction.territory).defenses.level*.018));
  const casualties=Math.min(actor.troops.infantry,won?1:3,Math.floor(troopTotal(actor.troops)*.07));
  actor.troops.infantry-=casualties;
  world.marches.unshift({id:'tb'+(++world.seq),attacker:actor.id,defender:issuer.id,alliance:actor.alliance,
    territory:sanction.territory,at:now,endsAt:now+54_000,kind:'raid'});
  if (won) lift(world,sanction,now,'broken');
  record(world,'blockade-escort',actor.id,issuer.id,{sanction:sanction.id,won,casualties,text:won?'Escort opened the border.':'Escort withdrew.'},now);
  return {won,casualties,sanction:sanction.id};
}

function resolveShipment(world,shipment,now) {
  const route=routeOf(world,shipment.route);
  const path={...route,territories:shipment.path};
  const from=getCity(world,shipment.from),to=getCity(world,shipment.to);
  let cargo=shipment.amount;
  const pressure=routePressure(world,path,shipment.resource,now);
  const blocked=pressure.some(item=>['embargo','blockade'].includes(item.kind));
  shipment.tariffs=[];
  if (!pathStillValid(world,path,now) || !shipment.smuggle && blocked) {
    shipment.refunded=credit(from,{[shipment.resource]:shipment.amount})[shipment.resource];
    shipment.status='returned';
    cargo=0;
  } else if (shipment.smuggle && blocked) {
    const roll=seeded(digest([world.secret,shipment.id,shipment.path,shipment.createdAt]))();
    const fraction=roll<.30 ? .5 : roll<.65 ? .22 : .09;
    shipment.smugglingLoss=Math.ceil(cargo*fraction);
    cargo-=shipment.smugglingLoss;
  } else {
    let budget=rules.maxTariff;
    for (const sanction of pressure.filter(item=>item.kind==='tariff')) {
      const total=Math.floor(shipment.amount*Math.min(budget,sanction.rate)/100);
      budget-=Math.min(budget,sanction.rate);
      if (!total) continue;
      const received=credit(getCity(world,sanction.from),{[shipment.resource]:total})[shipment.resource];
      shipment.tariffs.push({to:sanction.from,amount:received});
      cargo-=received;
    }
  }
  if (shipment.status==='in-transit') {
    shipment.delivered=credit(to,{[shipment.resource]:cargo})[shipment.resource];
    shipment.refunded=credit(from,{[shipment.resource]:cargo-shipment.delivered})[shipment.resource];
    shipment.status='delivered';
  }
  shipment.lost=shipment.amount-(shipment.delivered??0)-(shipment.refunded??0)-shipment.tariffs.reduce((sum,item)=>sum+item.amount,0);
  shipment.settledAt=now;
  notify(world,from.id,'Trade cargo '+shipment.status+'. '+(shipment.delivered??0)+' '+shipment.resource+' delivered.',now,'diplomacy');
  if (shipment.delivered) notify(world,to.id,'Trade cargo arrived from '+from.name+'.',now,'diplomacy');
  return shipment;
}

export function nextPoliticalTradeEvents(world,now) {
  const book=world.politicalTrade;
  if (!book) return [];
  return [
    ...book.shipments.filter(row=>row.status==='in-transit' && row.arrivesAt<=now).map(row=>({at:row.arrivesAt,apply:()=>resolveShipment(world,row,row.arrivesAt)})),
    ...book.sanctions.filter(row=>row.status==='active' && row.endsAt<=now).map(row=>({at:row.endsAt,apply:()=>lift(world,row,row.endsAt,'expired')})),
    ...book.routes.filter(row=>row.status==='active' && row.endsAt<=now).map(row=>({at:row.endsAt,apply:()=>{row.status='expired';}})),
  ];
}

export function politicalTradeCommand(world,player,input,now=world.now,{budget}={}) {
  const actor=getCity(world,player);
  switch (input.type) {
    case 'diplomacy-trade-open':return openRoute(world,actor,input,now);
    case 'diplomacy-trade-ship':return launch(world,actor,input,now,false);
    case 'diplomacy-trade-smuggle':return launch(world,actor,input,now,true);
    case 'diplomacy-trade-reroute':return reroute(world,actor,input,now);
    case 'diplomacy-sanction-impose':return impose(world,actor,input,now,budget);
    case 'diplomacy-sanction-break':return breakBlockade(world,actor,input,now);
    case 'diplomacy-sanction-lift': {
      const item=office(world).sanctions.find(row=>row.id===input.id);
      requireRule(item?.from===player && active(item,now),'sanction_control','Only the issuing kingdom can lift this live measure.',403);
      return lift(world,item,now,'lifted');
    }
    default:return undefined;
  }
}

export function politicalTradeSnapshot(world,player,now=world.now) {
  const book=world.politicalTrade;
  if (!book) return {routes:[],sanctions:[],shipments:[],history:[],tradeRules:rules};
  const routes=book.routes.filter(item=>includes(item,player)).slice(-35).reverse().map(item=>({...item,...routeSummary(world,item,now)}));
  const sanctions=book.sanctions.slice(-50).reverse().map(item=>({...item,canBreak:player===item.to && item.kind==='blockade' && active(item,now),
    jurisdiction:item.territory ? owned(world,item.from,siteBy(world,item.territory)) : true}));
  return {routes,sanctions,shipments:book.shipments.filter(item=>[item.from,item.to].includes(player)).slice(-40).reverse(),history:book.history,tradeRules:rules};
}
