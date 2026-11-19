import {HOUR, MINUTE} from './economy.mjs';

export const commanderRules=Object.freeze({
  levels:[0,20,55,110], maxLevel:4, dailyMastery:24, rentalDays:[1,3,7],
  rentalCooldown:30*MINUTE, attunementCooldown:HOUR, baseline:['warden'],
  masteryReward:{raid:8,defense:4,scout:5,territory:8,political:4,construction:3,research:3,trade:3,rebellion:4},
  masteryCooldown:{trade:30*MINUTE},
});

// Rarity changes the acquisition path. Combat modifiers come from traits and fittings, not rarity.
export const commanderAcquisition=Object.freeze({
  warden:{building:'hall',level:1,cost:[],rental:[]},
  engineer:{building:'workshop',level:2,cost:[200,140,75,115,16],rental:[42,29,15,24,4]},
  keeper:{building:'vault',level:3,cost:[250,165,150,155,29],rental:[55,35,33,35,7]},
  commander:{building:'barracks',level:3,cost:[200,120,200,215,32],rental:[45,26,44,46,7]},
  ranger:{building:'scout',level:2,cost:[160,100,90,175,19],rental:[34,22,20,37,4]},
  queen:{building:'alliance',level:4,cost:[260,225,220,275,48],rental:[56,47,46,56,11]},
  merchant:{building:'market',level:2,cost:[190,105,105,140,18],rental:[40,24,22,29,4]},
  scholar:{building:'library',level:3,cost:[165,140,115,180,40],rental:[36,31,24,40,9]},
});

export const commanderTraits=Object.freeze({
  warden:{defenseReduction:[.08,.01]}, commander:{openingAttack:[.06,.01]}, engineer:{constructionReduction:[.08,.01]},
  keeper:{storageBonus:[.10,.02]}, ranger:{scoutSuccess:[.08,.01]}, queen:{rebellionMorale:[8,2]},
  merchant:{marketBonus:[.03,.005]}, scholar:{researchReduction:[.08,.01]},
});

export const commanderEquipment=Object.freeze({
  'field-standard':{name:'Field Standard',description:'Raises opening pressure by 1.5%.',field:'openingAttack',value:.015,
    building:'barracks',level:3,cost:[105,40,155,90,20]},
  'sentinel-plate':{name:'Sentinel Plate',description:'Reduces early defensive losses by 2%.',field:'defenseReduction',value:.02,
    building:'workshop',level:3,cost:[75,105,165,55,21]},
  'quartermaster-seal':{name:'Quartermaster Seal',description:'Increases earned resource storage by 3%.',field:'storageBonus',value:.03,
    building:'vault',level:3,cost:[160,100,90,125,15]},
});

export const rentalPriceFactor=Object.freeze({1:1,3:2.55,7:4.25});
export const masteryCost=[60,46,52,80,10];

export const fieldDoctrine=Object.freeze({version:2, cavalryMobility:{plains:1.02,hills:.83,forest:.76,river:.82,coast:.93,desert:.95},
  cavalrySustain:.94, openingExchanges:3});
