import {DAY, buildings} from '../../config/economy.mjs';
import {heroes} from '../../config/balance.mjs';
import {commanderAcquisition, commanderEquipment, commanderRules, commanderTraits, masteryCost, rentalPriceFactor} from '../../config/progression.mjs';
import {has, notify, requireRule, roundCost, subtract} from './world.mjs';

export const commanderProgressionTypes=new Set(['commander-recruit','commander-rent','commander-upgrade','commander-equip','commander-forge']);
export const ruleClock=city=>city.warehouseAt ?? 0;
const rank=(progress,id)=>progress?.roster?.[id] ?? {level:1,xp:0,expiresAt:0};

function book(city) {
  // Saves predating the roster could select every commander; keep those permanent entitlements.
  return city.commanders ??= {legacy:true,roster:{},equipment:{},rentAfter:0};
}

export function newCommanderBook() {
  return {legacy:false,roster:{},equipment:{},rentAfter:0};
}

export function commanderOwnership(city,id,now=ruleClock(city)) {
  if (!has(heroes,id)) return 'unavailable';
  const progress=city.commanders;
  const row=rank(progress,id);
  return !progress || progress.legacy || row.permanent || commanderRules.baseline.includes(id) ? 'permanent' :
    row.expiresAt > now ? 'rented' : row.expiresAt > 0 ? 'expired' : 'locked';
}

export function usableCommander(city,id,now=ruleClock(city)) {
  return ['permanent','rented'].includes(commanderOwnership(city,id,now));
}

export function activeCommander(city, now=ruleClock(city), id=city.hero) {
  return usableCommander(city,id,now) ? id : 'warden';
}

function effectsAt(city,id,level) {
  if (!has(heroes,id)) return {};
  const effects=Object.fromEntries(Object.entries(commanderTraits[id]).map(([key,[base,increment]])=>[key,base+increment*(level-1)]));
  const fitting=commanderEquipment[rank(city.commanders,id).equipment];
  if (fitting) effects[fitting.field]=(effects[fitting.field]??0)+fitting.value;
  return Object.fromEntries(Object.entries(effects).map(([key,value])=>[key,Number(value.toFixed(4))]));
}

export function commanderEffects(city,id=city.hero,now=ruleClock(city)) {
  if (!id) return {};
  const selected=activeCommander(city,now,id);
  return effectsAt(city,selected,rank(city.commanders,selected).level??1);
}

export function battleCommander(city,hero,now) {
  if (!hero) return {hero:null};
  const effective=activeCommander(city,now,hero);
  const {openingAttack=0,defenseReduction=0}=commanderEffects(city,effective,now);
  if (openingAttack===(effective==='commander' ? .06 : 0) && defenseReduction===(effective==='warden' ? .08 : 0)) return {hero:effective};
  return {hero:effective,commanderTraits:{openingAttack,defenseReduction}};
}

function recruitment(city,id,now) {
  const profile=commanderAcquisition[id];
  const prerequisite=city.tutorial && city.buildings[profile.building]>=profile.level;
  return {prerequisite:{building:profile.building,label:buildings[profile.building].name,level:profile.level,tutorial:true},
    eligible:prerequisite,cost:roundCost(profile.cost.length?profile.cost:[0,0,0,0,0]),
    rentals:profile.rental.length ? Object.fromEntries(commanderRules.rentalDays.map(days=>[days,roundCost(profile.rental,rentalPriceFactor[days])])) : {},
    rentalEligible:city.tutorial && now>=(city.commanders?.rentAfter??0),rentAfter:city.commanders?.rentAfter??0};
}

export function commanderSnapshot(city,now,unavailableUntil=0) {
  const roster=Object.fromEntries(Object.entries(heroes).map(([id,profile])=>{
    const state=rank(city.commanders,id);
    const level=state.level??1;
    const xp=state.xp??0;
    const ownership=commanderOwnership(city,id,now);
    return [id,{id,name:profile.name,rarity:profile.rarity,role:profile.role,ability:profile.ability,ownership,level,xp,
      maxLevel:commanderRules.maxLevel,nextXp:commanderRules.levels[level]??null,expiresAt:ownership==='rented'?state.expiresAt:null,
      cooldownUntil:state.equipAfter??0,equipment:state.equipment??null,baseEffects:effectsAt({},id,1),effects:effectsAt(city,id,level),
      nextEffects:level<commanderRules.maxLevel?effectsAt(city,id,level+1):null,upgradeCost:roundCost(masteryCost,level),
      upgradeEligible:ownership==='permanent' && level<commanderRules.maxLevel && xp>=commanderRules.levels[level],
      recruitment:recruitment(city,id,now)}];
  }));
  const equipment=Object.fromEntries(Object.entries(commanderEquipment).map(([id,profile])=>[id,{...profile,id,cost:roundCost(profile.cost),
    owned:!!city.commanders?.equipment?.[id],eligible:city.tutorial && city.buildings[profile.building]>=profile.level}]));
  return {selected:city.hero,effective:unavailableUntil>now?null:activeCommander(city,now),unavailableUntil,roster,equipment};
}

export function awardCommanderMastery(city,id,activity,now) {
  if (!has(heroes,id)) return;
  const gain=commanderRules.masteryReward[activity];
  if (!gain) return;
  const progress=book(city);
  const state=progress.roster[id]??={level:1,xp:0};
  const cooldown=commanderRules.masteryCooldown[activity]??0;
  if ((state.activityAfter?.[activity]??0)>now) return;
  const day=Math.floor(now/DAY);
  if (state.masteryDay!==day) { state.masteryDay=day; state.earnedToday=0; }
  const count=Math.min(gain,commanderRules.dailyMastery-state.earnedToday,commanderRules.levels.at(-1)-(state.xp??0));
  if (count<=0) return;
  state.xp=(state.xp??0)+count;
  state.earnedToday+=count;
  if (cooldown) (state.activityAfter??={})[activity]=now+cooldown;
  return count;
}

export function commanderCommand(world,city,input,now) {
  const progress=book(city);
  if (input.type==='commander-forge') {
    const profile=has(commanderEquipment,input.equipment)?commanderEquipment[input.equipment]:null;
    requireRule(profile,'commander_equipment','Choose a known fitting.',400);
    requireRule(!progress.equipment[input.equipment] && city.buildings[profile.building]>=profile.level,
      'equipment_locked','This fitting is already owned or needs higher infrastructure.');
    subtract(city,roundCost(profile.cost));
    progress.equipment[input.equipment]={forgedAt:now};
    notify(world,city.id,profile.name+' forged. Assign it at the Commander Hall.',now,'army',
      {title:'Equipment forged',equipment:input.equipment,status:'completed'});
    return {equipment:input.equipment,forged:true,cost:roundCost(profile.cost)};
  }
  const id=input.hero;
  requireRule(has(heroes,id),'commander_missing','Choose a known commander.',400);
  const state=progress.roster[id]??={level:1,xp:0};
  const ownership=commanderOwnership(city,id,now);
  const options=recruitment(city,id,now);
  let cost;
  if (input.type==='commander-recruit') {
    requireRule(ownership!=='permanent' && options.eligible,'commander_recruitment','The commander is already permanent or the listed building tier is needed.');
    cost=options.cost;
    subtract(city,cost);
    state.permanent=true;
    state.recruitedAt=now;
    notify(world,city.id,heroes[id].name+' joined your permanent roster.',now,'army',{title:'Commander recruited',commander:id,status:'completed'});
  } else if (input.type==='commander-rent') {
    const days=input.days;
    requireRule(Number.isInteger(days) && commanderRules.rentalDays.includes(days),'commander_duration','Choose a 1, 3, or 7-day contract.',400);
    requireRule(ownership!=='permanent' && options.rentalEligible,'commander_rental','Rental is on cooldown or the commander is already permanent.');
    const expiresAt=Math.max(now,state.expiresAt??0)+days*DAY;
    requireRule(expiresAt<=now+7*DAY,'commander_rental_limit','The contract cannot extend more than seven days from now.');
    cost=options.rentals[days];
    subtract(city,cost);
    state.expiresAt=expiresAt;
    progress.rentAfter=now+commanderRules.rentalCooldown;
    notify(world,city.id,heroes[id].name+' signed a '+days+'-day contract.',now,'army',{title:'Commander hired',commander:id,status:'completed',until:expiresAt});
  } else if (input.type==='commander-upgrade') {
    requireRule(ownership==='permanent' && state.level<commanderRules.maxLevel && state.xp>=commanderRules.levels[state.level],
      'commander_mastery','Permanent ownership and the next mastery milestone are required.');
    cost=roundCost(masteryCost,state.level);
    subtract(city,cost);
    state.level++;
    notify(world,city.id,heroes[id].name+' advanced to mastery '+state.level+'.',now,'army',
      {title:'Mastery advanced',commander:id,status:'completed',level:state.level});
  } else if (input.type==='commander-equip') {
    const item=input.equipment;
    requireRule(ownership==='permanent' && now>=(state.equipAfter??0),'equipment_cooldown','Permanent ownership and a free attunement window are required.');
    requireRule(item===null || has(progress.equipment,item) && !Object.entries(progress.roster).some(([hero,row])=>hero!==id && row.equipment===item),
      'equipment_unavailable','Forge the fitting or remove it from its current commander first.');
    requireRule((state.equipment??null)!==item,'equipment_equipped','Choose a different fitting.');
    state.equipment=item;
    state.equipAfter=now+commanderRules.attunementCooldown;
  }
  return {hero:id,...commanderSnapshot(city,now).roster[id],...(cost&&{cost})};
}
