import { MINUTE, buildings, resources, tech } from '../../config/economy.mjs';
import { heroes, units } from '../../config/balance.mjs';
import { troopTotal } from '../../packages/game-engine/combat.mjs';

export const awayThreshold=10*MINUTE;
const eventLimit=50;
const treasuryKeys=['kingdomSatoshis','depositedSatoshis','atRiskSatoshis','lockedSatoshis','claimableSatoshis'];
const achievementNames={
  'first-banner':'First banner raised',
  'the-builder':'The builder',
  'eyes-in-mist':'Eyes in the mist',
  'frontier-defender':'Frontier defender',
  'landmark-keeper':'Landmark keeper',
};
const delta=(current,previous,keys=Object.keys(current))=>Object.fromEntries(
  keys.map(key=>[key,(current[key]??0)-(previous[key]??0)]).filter(([,change])=>change!==0));

function checkpoint({world,player,vault,now}) {
  const city=world.cities[player];
  return {at:now,seq:world.seq,resources:city.resources,troops:city.troops,
    treasury:Object.fromEntries(treasuryKeys.map(key=>[key,vault[key]??0]))};
}

function completedOrder(job) {
  const {kind,key,count,level}=job;
  if (kind==='troop') return {title:'Training complete',detail:`${count} ${units[key]?.name??key} joined the available army.`};
  if (kind==='research') return {title:'Research complete',detail:`${tech[key]?.name??key} reached level ${level}.`};
  return {title:'Construction complete',detail:`${buildings[key]?.name??key} reached level ${level}.`};
}

function recordedEvents({world,view,player,now},previous) {
  const city=world.cities[player];
  const from=previous.at;
  const within=at=>Number.isSafeInteger(at)&&at>from&&at<=now;
  const events=[];
  const notices=(world.notifications[player]??[]).filter(item=>
    within(item.at) || item.at===from&&Number(item.id.slice(1))>previous.seq);
  const battles=new Set();
  for (const battle of view.battles) {
    // Mirrored claim bouts are evidence of one bracket decision. Their simulated losses must not be added.
    if (!within(battle.at)||battle.kind==='territory-contest'||battle.kind==='political-front') continue;
    const side=battle.attacker===player?'attacker':'defender';
    const won=battle.winner===side;
    const rival=side==='attacker'?battle.defenderName:battle.attackerName;
    const loss=troopTotal(battle.losses?.[side]??{});
    const name=battle.conquest?.name;
    const place=name?' at '+name:' against '+rival;
    events.push({id:battle.id,kind:'battle',at:battle.at,title:won?'Victory':'Defeat',
      detail:`${won?'Victory':'Defeat'}${place}. ${loss} ${loss===1?'troop':'troops'} lost.`,battleId:battle.id,
      ...(battle.territoryId&&{territoryId:battle.territoryId}), ...(battle.kind==='raid'&&battle.loot&&{resources:side==='attacker'?battle.loot:
        Object.fromEntries(resources.map(resource=>[resource,-battle.loot[resource]]))})});
    battles.add(battle.id);
  }
  for (const entry of notices) {
    if (entry.battleId&&battles.has(entry.battleId)) continue;
    const {text,...record}=entry;
    events.push({...record,title:entry.title??text,detail:entry.title?text:null});
  }
  for (const job of city.history) {
    if (!within(job.completedAt)||notices.some(entry=>entry.job?.id===job.id)) continue;
    events.push({id:'job-'+job.id,kind:job.kind==='troop'?'army':'city',at:job.completedAt,job,
      ...completedOrder(job)});
  }
  for (const [achievement,at] of Object.entries(city.achievements??{})) {
    if (!within(at)||notices.some(entry=>entry.achievement===achievement&&!battles.has(entry.battleId))) continue;
    events.push({id:'achievement-'+achievement,kind:'achievement',at,title:achievementNames[achievement]??'Achievement earned',achievement});
  }
  for (const site of world.territories??[]) {
    for (const entry of site.history??[]) {
      if (!within(entry.at)||!Object.hasOwn(entry,'previousOwner')||entry.playerId===entry.previousOwner) continue;
      const gain=entry.playerId===player;
      if (!gain&&entry.previousOwner!==player) continue;
      if (notices.some(notice=>notice.territoryId===site.id&&notice.at===entry.at&&
        notice.title===(gain?'Territory gained':'Territory lost'))) continue;
      events.push({id:`site-${site.id}-${entry.version}`,kind:'territory',at:entry.at,
        title:gain?'Territory gained':'Territory lost',detail:site.name,territoryId:site.id});
    }
  }
  for (const record of world.territorySettlements??[]) {
    if (!within(record.at)||record.lease?.playerId!==player||!['raffle','lease-expired'].includes(record.kind)) continue;
    const site=world.territories?.find(site=>site.id===record.territoryId);
    events.push({id:record.id,kind:'territory',at:record.at,title:record.kind==='raffle'?'Extraction lease won':'Extraction lease expired',
      detail:site?.name,territoryId:record.territoryId});
  }
  const royal=world.government?.kingdoms?.[player];
  const readiness=[
    ['counterspy',city.counterspyCooldown,'Counterintelligence cooldown ended'],
    ['shield',city.shieldUntil,'City shield ended'],
    ['immunity',city.immunityUntil,'Rebellion immunity ended'],
    ['rental',city.commanders?.rentAfter,'Commander rental cooldown ended'],
    ['injury',royal?.commanderUntil,'Commander recovery ended'],
    ['political',royal?.recoveryUntil,'Political recovery period ended'],
  ];
  for (const [commander,row] of Object.entries(city.commanders?.roster??{})) {
    readiness.push(['gear-'+commander,row.equipAfter,`${heroes[commander]?.name??'Commander'} can change equipment`]);
  }
  for (const [id,at,title] of readiness) {
    if (within(at)) events.push({id:`ready-${id}-${at}`,kind:'cooldown',at,title});
  }
  return events.sort((a,b)=>b.at-a.at || a.id.localeCompare(b.id));
}

export function readKingdomChronicle(store,context,{visit=false}={}) {
  const {player,now}=context;
  const saved=store.kingdomChronicle(player);
  if (!visit) return saved?.report??null;
  const current=checkpoint(context);
  if (!saved?.checkpoint || now-saved.checkpoint.at<awayThreshold) {
    if (!saved || current.at-saved.checkpoint.at>=30_000 || current.seq!==saved.checkpoint.seq) {
      store.saveKingdomChronicle(player,{checkpoint:current,report:saved?.report??null});
    }
    return saved?.report??null;
  }
  const previous=saved.checkpoint;
  const resourceChanges=delta(current.resources,previous.resources,resources);
  const troopChanges=delta(current.troops,previous.troops);
  const treasuryChanges=delta(current.treasury,previous.treasury,treasuryKeys);
  const events=recordedEvents(context,previous);
  const changed=events.length||[resourceChanges,troopChanges,treasuryChanges].some(values=>Object.keys(values).length);
  const report=changed?{id:`away-${previous.at}-${now}`,from:previous.at,to:now,unread:true,
    resourceChanges,troopChanges,treasuryChanges,events:events.slice(0,eventLimit),
    ...(events.length>eventLimit&&{olderEvents:events.length-eventLimit})}:saved.report;
  store.saveKingdomChronicle(player,{checkpoint:current,report});
  return report;
}

export function dismissKingdomChronicle(store,player,id) {
  const saved=store.kingdomChronicle(player);
  if (!saved?.report||saved.report.id!==id) return null;
  if (saved.report.unread) {
    saved.report.unread=false;
    store.saveKingdomChronicle(player,saved);
  }
  return saved.report;
}
