import {economy,tech} from '../../config/economy.mjs';
import {balance,counters,formations,terrains,units} from '../../config/balance.mjs';
import {fieldDoctrine} from '../../config/progression.mjs';
import {openingProfile,seeded,simulateBattle,terrainFortification,troopTotal,unitAttackFactors,unitIds,unitResilience} from './combat.mjs';
import {deployedTroops,researchQuote,trainingQuote} from './economy.mjs';
import {governmentProductionMultiplier} from './government.mjs';
import {selection} from './military.mjs';
import {commanderEffects,commanderSnapshot} from './progression.mjs';
import {aidAllowance,attackEligibility,constructionTimeFactor,currentTactic,getCity,marketRate,powerBreakdown,productionPerHour,
  selectTarget,stockCapacity,trainingSlots,trainingTimeFactor,troopCap} from './world.mjs';
import {territoryProduction} from './territories.mjs';

const round=value=>Math.round(value*100)/100;
export const totalDeployed=values=>values.claim+values.political+values.garrison;
const percent=value=>round((value-1)*100);

export function buildingEffects(world,city,id,now) {
  const deployed=totalDeployed(deployedTroops(world,city));
  const project=profile=>{
    const level=profile.buildings[id];
    switch (id) {
      case 'hall': return {buildingTier:level,infrastructurePower:level*25};
      case 'barracks': return {troopCapacity:troopCap(profile),trainingSlots:trainingSlots(profile),trainingTimePercent:round(trainingTimeFactor(profile)*100)};
      case 'walls': return {wallLevel:level+profile.tech.fortification,
        defensePressurePercent:percent(terrainFortification(profile.terrain,level+profile.tech.fortification))};
      case 'vault': return {storage:stockCapacity(profile,now)};
      case 'workshop': return {constructionTimePercent:round(constructionTimeFactor(profile,now)*100),siegeUnlocked:level>=2};
      case 'market': return {exchangeRatePercent:round(marketRate(profile,now)*100)};
      case 'library': return {availableTechnologyTiers:Object.fromEntries(Object.entries(tech).map(([id,profile])=>[id,Math.max(0,Math.min(4,level-profile.library+1))])),mageUnlocked:level>=2};
      case 'alliance': return {dailyAid:aidAllowance(profile),memberRallyPermission:level>=2};
      case 'scout': return {scoutSuccessPointsAgainstLevel1:round((level-1)*3.5),intelConfidencePointsAgainstLevel1:round((level-1)*2)};
      case 'farm': return {productionPerHour:productionPerHour(profile,now,governmentProductionMultiplier(world,city.id,now),deployed)};
      default: return {};
    }
  };
  const next={...city,buildings:{...city.buildings,[id]:city.buildings[id]+1}};
  return {current:project(city),next:city.buildings[id]<economy.levelMax?project(next):null};
}

export function kingdomStats(world,city,now) {
  const side=currentTactic(city,world,now);
  const opening=openingProfile(side,undefined,city.terrain);
  const reserved=deployedTroops(world,city);
  const queued=city.queue.filter(job=>job.kind==='troop').reduce((total,job)=>total+job.count,0);
  const available=troopTotal(city.troops), deployed=totalDeployed(reserved);
  return {
    military:{available,reserved,deployed,queued,capacity:troopCap(city),...powerBreakdown(city),
      doctrinePercent:city.tech.tactics*2,moralePercent:percent(side.politicalMorale),terrainDefensePercent:percent(terrainFortification(city.terrain)),
      cityDefensePercent:percent(terrainFortification(city.terrain,side.wall)),openingTerrain:city.terrain,openingPressure:round(opening.openingPressure)},
    economy:{production:productionPerHour(city,now,governmentProductionMultiplier(world,city.id,now),deployed),
      territoryProduction:territoryProduction(world,city.id,now),capacity:stockCapacity(city,now),
      foodUpkeepPerHour:round((available+deployed)*economy.maintenance),marketRate:marketRate(city,now)},
    commands:commanderSnapshot(city,now,world.government?.kingdoms?.[city.id]?.commanderUntil??0),
    units:Object.fromEntries(unitIds.map(id=>{
      const {attack,guard,life}=units[id];
      return [id,{base:{attack,guard,life},effective:{openingAttack:round(opening.attack[id]),resilience:round(unitResilience(id)),...unitAttackFactors(side,id,1,city.terrain)},
        count:city.troops[id],advantages:unitIds.flatMap((against,index)=>counters[id][index]>1?[{against,multiplier:counters[id][index]}]:[]),
        disadvantages:unitIds.flatMap((against,index)=>counters[id][index]<1?[{against,multiplier:counters[id][index]}]:[]),training:trainingQuote(world,city,id)}];
    })),
    research:Object.fromEntries(Object.keys(tech).map(id=>[id,researchQuote(city,id,now)])),
  };
}

export function enemyObservation(city,viewer,now) {
  if (city.id===viewer.id || city.alliance&&city.alliance===viewer.alliance) {
    return {source:'allied',confidence:1,observedAt:now,expiresAt:null,army:troopTotal(city.troops),power:powerBreakdown(city).rosterPower,wall:city.buildings.walls,
      defense:(city.buildings.walls+city.tech.fortification)*50,formation:city.formation,troops:{...city.troops}};
  }
  const intel=viewer.intel[city.id];
  if (!intel || intel.expiresAt<=now) return {source:'unknown',confidence:null,observedAt:null,expiresAt:null,army:null,wall:null,
    defense:null,formation:null,troops:null};
  return {source:'scouting',confidence:intel.confidence,observedAt:intel.at,expiresAt:intel.expiresAt,army:intel.army,power:intel.power??null,
    wall:intel.wall??null,defense:intel.defense??null,formation:intel.formation??null,troops:intel.troops??null};
}

// Estimate against variations of the intelligence actually shown to the player. Never simulate the unpublished defender inputs.
function estimateRisk(side,enemy,terrain,seed) {
  if (enemy.source!=='scouting'||!enemy.troops||!Object.values(enemy.troops).some(value=>value>0)) return null;
  const rng=seeded(seed);
  const compositions=['line','wedge','screen'];
  const postures=['balanced','assault','flank','siege'];
  const samples=48, widen=1-enemy.confidence;
  const losses=[];
  let wins=0;
  for (let run=0;run<samples;run++) {
    const troops=Object.fromEntries(unitIds.map(id=>[id,Math.max(0,Math.round((enemy.troops[id]??0)*(1+(rng()*2-1)*widen)))]));
    const defender={troops,hero:run%3===0?'warden':null,tactic:postures[run%postures.length],
      formation:Object.hasOwn(formations,enemy.formation)?enemy.formation:compositions[run%compositions.length],
      tech:{tactics:run%3},wall:Math.max(0,Math.round((enemy.wall??(enemy.defense??0)/50)*(1+(rng()*2-1)*widen))),fieldRules:side.fieldRules};
    const result=simulateBattle({attacker:side,defender,terrain},[seed,run]);
    if (result.winner==='attacker') wins++;
    losses.push(troopTotal(result.losses.attacker));
  }
  losses.sort((a,b)=>a-b);
  return {basis:'fresh-scouting-scenarios',range:[losses[Math.floor(samples*.1)],losses[Math.floor(samples*.9)]],samples,
    sampleWins:wins,assumptions:'Varied the reported troop counts, walls, tactics and doctrine. Enemy commander, fortification research and morale are unknown.'};
}

export function attackPreview(world,actorId,input,now=world.now) {
  const actor=getCity(world,actorId), target=selectTarget(world,actor,input.target);
  const orders=selection(actor,input,now);
  const side={...currentTactic(actor,world,now,orders.hero),tactic:orders.tactic,formation:orders.formation,
    intel:actor.intel[target.id]?.expiresAt>now?actor.intel[target.id].confidence:0};
  const enemy=enemyObservation(target,actor,now);
  const opening=openingProfile(side,undefined,target.terrain);
  const {allowed,reason,code}=attackEligibility(world,actor,target,now);
  return {own:{troops:side.troops,tactic:side.tactic,formation:side.formation,hero:side.hero,selectedHero:orders.hero,
    openingPressure:round(opening.openingPressure),rosterPower:round(powerBreakdown(actor).rosterPower),
    effects:commanderEffects(actor,side.hero,now),moralePercent:percent(side.politicalMorale),doctrinePercent:actor.tech.tactics*2,
    intelOpeningPercent:round((side.intel||0)*6),fortificationAssault:side.tactic==='siege'},enemy,
    terrain:{id:target.terrain,name:terrains[target.terrain].name,defensePercent:percent(terrainFortification(target.terrain)),
      cavalryOpeningPercent:percent(fieldDoctrine.cavalryMobility[target.terrain]??1),cavalryLatePercent:percent((fieldDoctrine.cavalryMobility[target.terrain]??1)*fieldDoctrine.cavalrySustain)},
    risk:estimateRisk(side,enemy,target.terrain,[actorId,target.id,enemy.observedAt,orders]),eligibility:{allowed,reason,code},
    limits:{maxLossPercent:48,maxLootPerResourcePercent:economy.lootFraction*100,lootCapacityPerSurvivingTroop:economy.lootCapacityPerTroop,
      powerWindowPercent:balance.attackWindow*100}};
}
