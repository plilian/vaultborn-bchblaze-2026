import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {balance, formations, heroes, tactics, terrains} from '../../config/balance.mjs';
import {DAY, buildings, economy, levelMax, production, startingCapacity, starterResources} from '../../config/economy.mjs';
import {bchPolicy, GAMEPLAY_ALLOCATION, LEGACY_ALLOCATION, legacyFees, paymentAllocation, paymentPrice} from '../../config/payments.mjs';
import {commanderAcquisition, commanderRules, fieldDoctrine, masteryCost, rentalPriceFactor} from '../../config/progression.mjs';
import {battleCommander} from '../game-engine/progression.mjs';
import {armyPower, seeded, simulateBattle, troopTotal, unitIds} from '../game-engine/combat.mjs';
import {battleExperiment} from './index.mjs';

const sum=values=>values.reduce((total,value)=>total+value,0);
const entries=Object.keys;
const rounded=value=>Math.round(value*100)/100;
const share=(part,total)=>total ? rounded(100*part/total):0;
const cap=(n,low,high)=>Math.min(high,Math.max(low,n));
const roster=(m,scale=1)=>Object.fromEntries(unitIds.map((unit,i)=>[unit,Math.round(m[i]*scale)]));
const horizons=[1,7,30,90];
const seedsByPopulation={100:420,1000:72,10000:24};
const profiles=[
  {name:'free',attendance:.71,sessions:2,raid:.12,spend:0,bank:0, commitment:0,build:1.03},
  {name:'casual',attendance:.56,sessions:1,raid:.05,spend:.015,bank:18000,commitment:.05,build:.88},
  {name:'competitive',attendance:.92,sessions:5,raid:.37,spend:.09,bank:38000,commitment:.18,build:1.02},
  {name:'aggressive',attendance:.9,sessions:5,raid:.66,spend:.11,bank:44000,commitment:.24,build:.91},
  {name:'defensive',attendance:.87,sessions:3,raid:.08,spend:.035,bank:28000,commitment:.24,build:.97},
  {name:'economic',attendance:.87,sessions:4,raid:.12,spend:.08,bank:64000,commitment:.05,build:1.13},
  {name:'high-spending',attendance:.91,sessions:5,raid:.29,spend:.38,bank:350000,commitment:.34,build:1.02},
];
const heroByRole=['engineer','warden','commander','commander','warden','merchant','queen'];
const activity=['low','high','declining'];
const placements=[.40,.25,.15,.10,.10];
const competitiveBefore={'attack-paid':6000,'territory-claim':4000,'territory-attack':6000,'territory-raffle':7400};
const walletFee=350;
const allMarketTypes=['claim','raffle','raid'];
const policyList=[{id:LEGACY_ALLOCATION,protectorate:120000},{id:GAMEPLAY_ALLOCATION,protectorate:24000}];
const troopModels=[ [34,26,23,11,4,2], [19,29,34,8,6,4], [26,20,14,31,5,4], [23,22,19,11,15,10] ];
const effectNames=['balanced','assault','flank','siege'];
const giniSorted=(sorted)=>{
  const total=sum(sorted);
  if (!total) return 0;
  const weighted=sorted.reduce((acc,n,index)=>acc+(index+1)*n,0);
  return 2*weighted/(sorted.length*total)-(sorted.length+1)/sorted.length;
};
const quantiles=values=>{
  const sorted=Array.from(values).sort((a,b)=>a-b);
  return [ .1,.5,.9 ].map(f=>rounded(sorted[Math.floor((sorted.length-1)*f)]??0));
};
const cut=(sorted,p)=>sum(sorted.slice(-Math.max(1,Math.ceil(sorted.length*p))));

function bill(version,type,legacyPrice) {
  const price=paymentPrice(type,legacyPrice,version);
  return {price,...paymentAllocation(price,type,version)};
}

export function contestNet({policy,won,committed,eligibleWallets=true,action='attack-paid'}) {
  const {price,battle}=bill(policy,action,competitiveBefore[action]);
  const updated=policy===GAMEPLAY_ALLOCATION;
  const valid=eligibleWallets && (updated || committed>0 || action==='territory-attack' && !won);
  const capture=won && valid ? Math.min(Math.floor(committed*bchPolicy.capturePercent/100),updated?battle:Infinity):0;
  const forfeit=!won && valid ? Math.floor(battle*(updated?bchPolicy.defenderForfeitPercent:100)/100):0;
  return {attacker:battle+capture-forfeit-price-walletFee,defender:forfeit-capture,capture,forfeit};
}

function compareCheckout() {
  return Object.fromEntries(policyList.map(({id,protectorate})=>[id,Object.fromEntries([
    ['rush',legacyFees.rush],['premium',legacyFees.premium],['espionage-paid',legacyFees.espionage],['protectorate',protectorate],
    ['political-operation',4000],...Object.entries(competitiveBefore),
  ].map(([key,amount])=>[key,bill(id,key,amount)]))]));
}

function fundedExpectation() {
  return [0,3000,15000,30000,60000,90000,250000].map(committed=>({committed,
    odds:[.25,.353,.5,.6].map(odds=>({odds,policies:Object.fromEntries(policyList.map(({id})=>{
      const win=contestNet({policy:id,won:true,committed});
      const loss=contestNet({policy:id,won:false,committed});
      return [id,{expectedAttacker:rounded(odds*win.attacker+(1-odds)*loss.attacker),
        expectedDefender:rounded(odds*win.defender+(1-odds)*loss.defender),
        guaranteedCollusivePairNet:win.attacker+win.defender,
        maximumCapture:win.capture,maximumForfeit:loss.forfeit}];
    }))}))}));
}

function liquidityStress() {
  return [546,900,2454].flatMap(satsPerInput=>[1,5,24,48].flatMap(available=>[1,2,5].map(satsPerByte=>{
    const included=Math.min(32,available);
    // Conservative planning overhead from the payout signer. One retained output avoids change dust.
    const size=196+160*included;
    const fee=size*satsPerByte;
    const principal=included*satsPerInput;
    const net=Math.max(0,principal-fee);
    return {satsPerInput,available,included,deferredInputs:available-included,satsPerByte,estimatedFee:fee,principal,
      spendable:net>=bchPolicy.minSpendable,net:net>=bchPolicy.minSpendable?net:0,feeSharePercent:share(fee,principal)};
  })));
}

function progressionExperiments() {
  const cases=12000;
  const random=seeded('vaultborn/progression-board/v1');
  const grouped={};
  let rarityLabelChanges=0,paidChanges=0;
  const fit=['field-standard','sentinel-plate','quartermaster-seal'];
  for (let i=0;i<cases;i++) {
    const hero=entries(heroes)[i%entries(heroes).length];
    const defense=entries(heroes)[Math.floor(random()*entries(heroes).length)];
    const mA=troopModels[Math.floor(random()*troopModels.length)];
    const mD=troopModels[Math.floor(random()*troopModels.length)];
    const ratio=[.9,1,1.1][Math.floor(i/entries(heroes).length)%3];
    const trA=roster(mA,ratio*armyPower(roster(mD))/armyPower(roster(mA)));
    const trD=roster(mD);
    const dockTerrain=entries(terrains)[Math.floor(random()*entries(terrains).length)];
    const atk={troops:trA,tactic:effectNames[Math.floor(random()*4)],formation:entries(formations)[Math.floor(random()*3)],politicalMorale:[.95,1,1.05][Math.floor(random()*3)],fieldRules:fieldDoctrine.version};
    const def={troops:trD,tactic:effectNames[Math.floor(random()*4)],formation:entries(formations)[Math.floor(random()*3)],wall:1+Math.floor(random()*5),fieldRules:fieldDoctrine.version};
    const commander=(id,level,equipment)=>battleCommander({hero:id,commanders:{legacy:false,roster:{[id]:{permanent:true,level,equipment}}}},id,DAY);
    const seed=Math.floor(random()*2**32);
    const baseInput={attacker:{...atk,...commander(hero,1,null)},defender:{...def,...commander(defense,1,null)},terrain:dockTerrain};
    const base=simulateBattle(baseInput,seed);
    const master=simulateBattle({...baseInput,attacker:{...atk,...commander(hero,4,null)}},seed);
    const fitted=simulateBattle({...baseInput,attacker:{...atk,...commander(hero,4,fit[Math.floor(random()*3)])}},seed);
    const paid=simulateBattle({...baseInput,attacker:{...baseInput.attacker,paid:true}},seed);
    const reclassified=simulateBattle({...baseInput,attacker:{...baseInput.attacker,rarity:'Common'}},seed);
    paidChanges+=Number(paid.winner!==base.winner);
    rarityLabelChanges+=Number(reclassified.winner!==base.winner);
    const key=hero+':'+ratio;
    const row=grouped[key]??={hero,ratio,count:0,wins:0,master:0,fitted:0,baseLoss:0,fittedLoss:0};
    row.count++; row.wins+=base.winner==='attacker';row.master+=master.winner==='attacker';row.fitted+=fitted.winner==='attacker';
    row.baseLoss+=troopTotal(base.losses.attacker);row.fittedLoss+=troopTotal(fitted.losses.attacker);
  }
  return {scenarios:cases,resolutions:cases*5,paidChanges,rarityLabelChanges,
    groups:Object.values(grouped).map(row=>({hero:row.hero,ratio:row.ratio,count:row.count,baseWin:share(row.wins,row.count),
      upgradedWin:share(row.master,row.count),fittedWin:share(row.fitted,row.count),meanBaseLoss:rounded(row.baseLoss/row.count),meanFittedLoss:rounded(row.fittedLoss/row.count)})),
    recruitment:Object.entries(commanderAcquisition).filter(([,row])=>row.cost.length).map(([hero,row])=>{
      const permanent=sum(row.cost);
      const contract=Object.fromEntries(commanderRules.rentalDays.map(days=>[days,sum(row.rental.map(x=>Math.ceil(x*rentalPriceFactor[days])))]));
      return {hero,permanent,contract,permanentCheaperByDays:7*Math.ceil(permanent/contract[7]),weeklyContractPerDay:rounded(contract[7]/7),
        upgradeTotal:sum(masteryCost)*6,minimumMasteryDays:Math.ceil(commanderRules.levels.at(-1)/commanderRules.dailyMastery)};
    })};
}

const prices=Array.from({length:levelMax+1},(_,n)=>sum(buildings.hall.cost.map(nut=>Math.ceil(nut*economy.upgradeCurve**Math.max(0,n-1)))));
const stockAtStart=sum(Object.values(starterResources));
const resourceProduction=sum(Object.values(production));
const capacity=sum(Object.values(startingCapacity));
const models=tacticOdds();

function tacticOdds() {
  const out={};
  for (const profile of effectNames) {
    out[profile]=[];
    for (const ratio of [.8,.9,1,1.1,1.2]) {
      let win=0;
      for (let i=0;i<120;i++) {
        const a=troopModels[i%troopModels.length],d=troopModels[Math.floor(i/4)%troopModels.length];
        const attacker={troops:roster(a,ratio*armyPower(roster(d))/armyPower(roster(a))),hero:'commander',formation:entries(formations)[i%3],tactic:profile,fieldRules:fieldDoctrine.version};
        const defender={troops:roster(d),hero:'warden',formation:entries(formations)[Math.floor(i/3)%3],tactic:effectNames[Math.floor(i/6)%4],wall:i%4,fieldRules:fieldDoctrine.version};
        win+=simulateBattle({attacker,defender,terrain:entries(terrains)[i%6]},'realm-odd/'+i).winner==='attacker';
      }
      out[profile].push(win/120);
    }
  }
  return out;
}

function realm({population,seed,policy,protectorateFee,weather}) {
  const random=seeded('vaultborn/realm/v1/'+population+'/'+seed);
  const bank=new Uint32Array(population), kingdom=new Uint32Array(population), locked=new Uint32Array(population);
  const policyCode=new Uint8Array(population), hall=new Uint8Array(population), power=new Float64Array(population);
  const xp=new Uint16Array(population), experienceCap=new Uint8Array(population), mastery=new Uint8Array(population);
  const stock=new Float64Array(population), troops=new Float64Array(population), score=new Float64Array(population);
  const lands=new Uint8Array(population), rentalEnd=new Uint8Array(population), permanent=new Uint8Array(population), lease=new Uint8Array(population);
  const unlock=new Uint8Array(population), incoming=new Uint8Array(population), pairing=new Int32Array(population), recovery=new Uint8Array(population);
  const recoveryGoal=new Float32Array(population), lastDefeat=new Uint8Array(population);
  const allGuilds=Math.ceil(population/7);
  const controlled=new Uint8Array(allGuilds), protectorCount=new Uint8Array(allGuilds), protectorUntil=new Uint8Array(population);
  const protectorOf=new Int32Array(population).fill(-1), protectedBy=new Int32Array(population).fill(-1);
  const recoveries=[];
  const pools={development:0,seasonal:0,prizesPaid:0,burn:0,network:0,settlement:0,sponsorships:0,settlementFees:0};
  const counts={visits:0,paidServices:0,paidRaid:0,ordinaryRaid:0,fought:0,wins:0,rejectedRaid:0,withoutRival:0,protectedRaid:0,identityFarmBlocked:0,
    claimed:0,contested:0,conquered:0,rareEntries:0,rareLeases:0,leaseExpiry:0,railQueued:0,tokenDuplicatesRejected:0,tokenTransfers:0,
    protectorates:0,rebellions:0,spyAttempts:0,spySuccess:0,sabotage:0,diplomacy:0,sanctions:0,permanent:0,rentals:0,rentExpired:0,
    mastery:0,withdrawals:0,dustDeferred:0,prizeClaims:0,modeledSettlements:0,transactions:0,trade:0,tradeDisruption:0};
  const y1=Math.floor(population/8);
  let initial=0,shop=0;
  for (let i=0;i<population;i++) {
    const r=random();
    const code=i%profiles.length;
    policyCode[i]=code;
    bank[i]=Math.floor(profiles[code].bank*(.5+r));
    initial+=bank[i];
    stock[i]=stockAtStart;
    troops[i]=50+r*35;
    power[i]=troops[i]*13+55;
    hall[i]=1;
    mastery[i]=1;
  }
  const snapshots={};
  const aliases=policy===GAMEPLAY_ALLOCATION;
  const serviceBills={premium:bill(policy,'premium',legacyFees.premium),rush:bill(policy,'rush',legacyFees.rush),protectorate:bill(policy,'protectorate',protectorateFee)};
  const claim=bill(policy,'territory-claim',competitiveBefore['territory-claim']);
  const raffle=bill(policy,'territory-raffle',competitiveBefore['territory-raffle']);
  const attack=bill(policy,'attack-paid',competitiveBefore['attack-paid']);
  function playBill(id,item) {
    if (bank[id]<item.price+walletFee) return false;
    bank[id]-=item.price+walletFee;
    pools.network+=walletFee;
    counts.transactions++;
    pools.development+=item.development??0;
    pools.seasonal+=item.prize??0;
    pools.burn+=item.burn??0;
    pools.settlement+=item.settlement??0;
    kingdom[id]+=item.kingdom??0;
    return true;
  }
  function settle(estimatedFee) {
    const pool=aliases?'settlement':'development';
    const fee=Math.min(pools[pool],estimatedFee);
    pools[pool]-=fee;pools.network+=fee;pools.settlementFees+=fee;
    counts.modeledSettlements++;counts.transactions++;
  }
  for (let day=1;day<=90;day++) {
    incoming.fill(0); experienceCap.fill(0);
    pairing.fill(-1);
    const effect=weather==='low'?.75:weather==='declining'?1-(day-1)*.0061:1;
    // The ring changes daily, with close-power protection independent of ranking.
    const shift=1+Math.floor(random()*(population-1));
    const phase=Math.floor(random()*population);
    const uncommon=day%3===0 ? []:null;
    for (let i=0;i<population;i++) if (protectorUntil[i]===day) {
      protectedBy[protectorOf[i]]=-1;protectorOf[i]=-1;protectorCount[Math.floor(i/7)]--;
    }
    for (let j=0;j<population;j++) {
      const i=(j+phase)%population;
      const attendance=random(), choice=random(), selecting=random(), strategy=random();
      const targetRoll=random(), combatRoll=random(), sideRoll=random(), policyRoll=random();
      const code=policyCode[i], p=profiles[code], hero=heroByRole[code], hiring=commanderAcquisition[hero];
      if (rentalEnd[i]===day && !permanent[i]) counts.rentExpired++;
      if (lease[i] && lease[i]===day) {lease[i]=0;counts.leaseExpiry++;settle(350);}
      if (attendance>p.attendance*effect) continue;
      counts.visits++;
      const work=Math.min(economy.offlineCap/(DAY/24),p.sessions*4);
      const upkeep=troops[i]*economy.maintenance+(mastery[i]-(permanent[i]?1:0))*.5;
      stock[i]=Math.min(capacity*(1+.18*(hall[i]-1)),stock[i]+work*(resourceProduction*(1+Math.max(0,hall[i]-2)*.075)+lands[i]*12+(lease[i]?30:0)-upkeep));
      if (protectorUntil[i]>day&&protectorOf[i]>=0) {
        const ward=protectorOf[i];
        const tribute=Math.min(Math.floor(resourceProduction*work*economy.protectorateTribute),stock[ward]);
        stock[ward]-=tribute;stock[i]+=tribute;
      }
      const shortage=Math.max(0,Math.min(100+(hall[i]-1)*26,250)-troops[i]);
      if (shortage>1 && stock[i]>500) {
        const trained=Math.min(shortage,p.sessions*3.4,Math.floor(stock[i]/13));
        troops[i]+=trained;stock[i]-=trained*13;
        if (recovery[i] && troops[i]>=recoveryGoal[i]-0.01) {recoveries.push((day-recovery[i])*24);recovery[i]=0;}
      }
      if (hall[i]<levelMax && stock[i]>=prices[hall[i]]+255 && strategy<p.build*.19*p.sessions) {
        stock[i]-=prices[hall[i]];hall[i]++; experienceCap[i]+=3; score[i]+=hall[i]*4;
      }
      if (hero!=='warden' && !permanent[i]) {
        const buy=sum(hiring.cost);
        if (hall[i]>=hiring.level && stock[i]>=buy+450 && policyRoll<.45) {
          stock[i]-=buy;permanent[i]=1;counts.permanent++;unlock[i]=day;
        } else if (rentalEnd[i]<=day && hall[i]>=2 && selecting<.055 && stock[i]>=550) {
          const days=sideRoll<.5?1:sideRoll<.8?3:7;
          const cost=sum(hiring.rental.map(n=>Math.ceil(n*rentalPriceFactor[days])));
          if (stock[i]>=cost+450) {stock[i]-=cost;rentalEnd[i]=day+days;counts.rentals++;if(!unlock[i])unlock[i]=day;}
        }
      }
      if ((permanent[i]||hero==='warden') && mastery[i]<commanderRules.maxLevel && xp[i]>=commanderRules.levels[mastery[i]] && stock[i]>550+sum(masteryCost)*mastery[i]) {
        stock[i]-=sum(masteryCost)*mastery[i];mastery[i]++;counts.mastery++;
      }
      // A paid service changes money and sometimes timing; never modifies battle strength.
      if (choice<p.spend) {
        const service=selecting<.44?'rush':selecting<.955?'premium':'protectorate';
        const guild=Math.floor(i/7);
        const ward=(i+shift)%population;
        const filter=service!=='protectorate'||day>3&&p.sessions>=3&&policyRoll<.6&&protectorUntil[i]<=day&&protectedBy[ward]<0&&
          protectorCount[guild]<economy.protectorateSlots&&power[i]/power[ward]>=economy.protectorateMinPower;
        if (filter && playBill(i,serviceBills[service])) {
          counts.paidServices++;
          if (service==='protectorate') {
            counts.protectorates++;
            if (sideRoll<.42) {counts.rebellions++;stock[i]=Math.max(0,stock[i]-325);}
            else {score[i]+=Math.min(18,stock[i]*.0015);protectorCount[guild]++;protectorOf[i]=ward;protectedBy[ward]=i;protectorUntil[i]=day+2;}
          }
        }
      }
      if (policyRoll<.09) {
        counts.spyAttempts++;
        if (combatRoll<.63) {counts.spySuccess++;experienceCap[i]+=5;}
        if (strategy<.2) counts.sabotage++;
      } else if (policyRoll<.145) {
        counts.diplomacy++;
        counts.sanctions+=sideRoll<.18;
        if (sideRoll>=.18) {
          const ally=(i+shift)%population;
          const cargo=Math.min(100,Math.max(0,Math.floor(stock[i]-400)));
          if (cargo) {stock[i]-=cargo;stock[ally]+=cargo;counts.trade++;}
        } else counts.tradeDisruption++;
      }
      power[i]=troops[i]*13+55*hall[i]+Math.min(35,(mastery[i]-1)*4);
      // With an ordinary claim no competitive reward exists outside escrow; no fabricated prizes.
      const holdingGroup=Math.floor(i/7);
      if (day%4===0 && lands[i]<balance.cityTerritoryCap && controlled[holdingGroup]<balance.allianceTerritoryCap && strategy<.031 && playBill(i,claim)) {
        counts.claimed++;
        const multi=sideRoll<.28;
        counts.contested+=multi;
        const resolved=policyRoll<(multi?.40:.74);
        if (resolved) {lands[i]++;controlled[holdingGroup]++;score[i]+=16;experienceCap[i]+=8;}
        const forfeited=multi&&!resolved?Math.floor(claim.battle/2):0;
        kingdom[i]+=claim.battle-forfeited;
        if (forfeited) kingdom[(i+shift)%population]+=forfeited;
        settle(400);
      }
      if (uncommon && selecting>.988 && playBill(i,raffle)) {
        counts.rareEntries++;kingdom[i]+=raffle.battle;uncommon.push(i);
      }
      // Retain an explicit committed portion, never debit payment wallet for defending.
      if (day%7===1) locked[i]=Math.floor(kingdom[i]*p.commitment);
      if (choice<p.raid) {
        let rival=-1;
        const offset=1+Math.floor(targetRoll*41);
        for (let k=0;k<5;k++) {
          const test=(i+shift+offset+13*k)%population;
          const ratio=power[i]/power[test];
          if (i!==test && Math.floor(i/7)!==Math.floor(test/7) && ratio>=1-balance.attackWindow && ratio<=1+balance.attackWindow) {rival=test;break;}
        }
        if (rival<0) counts.withoutRival++;
        else if (incoming[rival]>=balance.targetIncomingDaily || pairing[rival]===i) counts.rejectedRaid++;
        else if (lastDefeat[rival]===day) counts.protectedRaid++;
        else {
          const tactic=effectNames[(code+Math.floor(strategy*4))%4];
          const gap=cap(Math.round((power[i]/power[rival]-.8)*10),0,4);
          const won=combatRoll<cap(models[tactic][gap]+(policyRoll<.09?.045:0),0,1);
          counts.fought++;counts.wins+=won;incoming[rival]++;pairing[i]=rival;
          if (sideRoll<.021) counts.identityFarmBlocked++; // same identity simulated as a rejected economic attempt
          else if (sideRoll<.26&&playBill(i,attack)) {
            counts.paidRaid++;
            const values=contestNet({policy,won,committed:locked[rival]});
            assert.ok(values.capture<=locked[rival]&&values.capture<=kingdom[rival]);
            kingdom[i]+=attack.battle+values.capture-values.forfeit;
            kingdom[rival]+=values.forfeit-values.capture;
            locked[rival]-=values.capture;
            settle(400);
          } else counts.ordinaryRaid++;
          const loser=won?rival:i;
          if (!recovery[loser]) {recovery[loser]=day;recoveryGoal[loser]=troops[loser];}
          lastDefeat[loser]=day;
          troops[loser]=Math.max(12,troops[loser]-3-Math.floor(strategy*6));
          if (won) {
            score[i]+=7;experienceCap[i]+=8;
            const take=Math.min(75,Math.floor(stock[rival]*economy.lootFraction));
            stock[i]+=take;stock[rival]-=take;
            if (sideRoll>.89 && lands[rival] && lands[i]<balance.cityTerritoryCap && controlled[holdingGroup]<balance.allianceTerritoryCap) {
              lands[rival]--;lands[i]++;controlled[Math.floor(rival/7)]--;controlled[holdingGroup]++;counts.conquered++;
            }
          }
        }
      }
      xp[i]=Math.min(commanderRules.levels.at(-1),xp[i]+Math.min(experienceCap[i],commanderRules.dailyMastery));
      if (day%7===0&&code===6&&i%29===0&&bank[i]>5500) {bank[i]-=5350;pools.seasonal+=5000;pools.sponsorships+=5000;pools.network+=350;counts.transactions++;}
      if (day%11===0 && kingdom[i]-locked[i]>800) {
        const pull=Math.floor((kingdom[i]-locked[i])*.4);
        if (pull>=bchPolicy.minSpendable+walletFee) {bank[i]+=pull-walletFee;kingdom[i]-=pull;pools.network+=walletFee;counts.withdrawals++;counts.transactions++;}
        else counts.dustDeferred++;
      }
      if (sideRoll<.011 && i<y1 && lands[i]) {
        counts.tokenDuplicatesRejected++;
        counts.tokenTransfers+=policyRoll<.2; // collectible evidence only, no territory control transfer
      }
    }
    if (uncommon?.length) {
      const holder=uncommon[Math.floor(phase%uncommon.length)];
      if (!lease[holder]) {lease[holder]=Math.min(254,day+3);counts.rareLeases++;}
      settle(260+uncommon.length*160);
    }
    if (day%7===0 && pools.seasonal) {
      const top=[];
      for (let i=0;i<population;i++) if (score[i]>0) {
        const index=top.findIndex(id=>score[i]>score[id]);
        if (index>=0) top.splice(index,0,i);else if (top.length<5) top.push(i);
        if (top.length>5) top.pop();
      }
      const budget=Math.floor(pools.seasonal*.85);
      for (let rank=0;rank<top.length;rank++) {
        const payout=Math.floor(budget*placements[rank]);
        if (payout>=bchPolicy.minSpendable+walletFee) {pools.seasonal-=payout;bank[top[rank]]+=payout-walletFee;pools.network+=walletFee;pools.prizesPaid+=payout-walletFee;counts.prizeClaims++;counts.transactions++;}
        else if (payout) counts.dustDeferred++;
      }
      score.fill(0);
    }
    if (horizons.includes(day)) {
      const wealth=Array.from(bank,(value,i)=>value+kingdom[i]).sort((a,b)=>a-b);
      const allLands=Array.from({length:Math.ceil(population/7)},(_,id)=>sum(lands.slice(id*7,id*7+7))).sort((a,b)=>a-b);
      const gdp=sum(wealth);
      const occupied=sum(allLands);
      shop=pools.development+pools.seasonal+pools.burn+pools.network+pools.settlement;
      assert.equal(gdp+shop,initial,'Modeled circulating plus reserved funds changed supply');
      const y0={};
      for (const code of [0,6]) {
        const group=Array.from(power).filter((_,i)=>policyCode[i]===code);
        y0[profiles[code].name]={power:quantiles(group),hall:quantiles(Array.from(hall).filter((_,i)=>policyCode[i]===code))};
      }
      snapshots[day]={gini:rounded(giniSorted(wealth)),top1:share(cut(wealth,.01),gdp),top10:share(cut(wealth,.10),gdp),
        landTop10:share(cut(allLands,.10),occupied),allianceLandHHI:rounded(sum(allLands.map(n=>(n/Math.max(1,occupied))**2))*100),
        wealth:quantiles(wealth),power:quantiles(power),hall:quantiles(hall),stock:quantiles(stock),unlockHours:quantiles(Array.from(unlock).filter(Boolean).map(days=>days*24)),
        recoveryHours:quantiles(recoveries),observedRecoveries:recoveries.length,paidByProfile:y0,pools:{...pools},counts:{...counts},circulating:gdp,conserved:true};
    }
  }
  return snapshots;
}

const averageTree=(rows)=>{
  const first=rows[0];
  if (typeof first==='number') return rounded(sum(rows)/rows.length);
  if (Array.isArray(first)) return first.map((_,i)=>averageTree(rows.map(row=>row[i])));
  if (typeof first==='boolean') return rows.every(Boolean);
  return Object.fromEntries(entries(first).map(key=>[key,averageTree(rows.map(row=>row[key]))]));
};

export function runAudit({grid=seedsByPopulation,short=false}={}) {
  const results={};
  const byPolicy=policyList.map(({id,protectorate})=>{
    results[id]={};
    return {id,protectorate};
  });
  let executions=0;
  for (const [size,times] of Object.entries(grid)) {
    const population=Number(size);
    for (const {id,protectorate} of byPolicy) {
      const rounds=Array.from({length:times},(_,seed)=>({weather:activity[seed%3],result:realm({population,seed,policy:id,protectorateFee:protectorate,weather:activity[seed%3]})}));
      executions+=rounds.length;
      results[id][size]={runs:times,overall:averageTree(rounds.map(row=>row.result)),byActivity:Object.fromEntries(activity.map(mode=>{
        const observations=rounds.filter(row=>row.weather===mode);
        return [mode,observations.length?{runs:observations.length,days:averageTree(observations.map(row=>row.result))}:null];
      }))};
    }
  }
  return {model:'vaultborn-local-audit-2',seedsByPopulation:grid,marketActions:allMarketTypes,horizons,profiles,executions,
    realmObservations:executions*horizons.length,realmFieldRules:fieldDoctrine.version,rentalPriceFactor,
    classicCombat:short?null:battleExperiment(),gameCombat:short?null:battleExperiment(2400,undefined,fieldDoctrine.version),
    progressionCombat:short?null:progressionExperiments(),
    checkout:compareCheckout(),expectedRaid:fundedExpectation(),liquidityStress:liquidityStress(),results};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  const short=process.argv.includes('--quick');
  const report=runAudit(short?{grid:{100:3,1000:3,10000:3},short}:{});
  if (!short) writeFileSync(new URL('../../docs/AUDIT_SIMULATION_RESULTS.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  const compact=Object.fromEntries(Object.entries(report.results).map(([policy,realms])=>[policy,Object.fromEntries(Object.entries(realms).map(([size,row])=>{
    const last=row.overall[90];
    return [size,{runs:row.runs,gini:last.gini,top10:last.top10,wealth:last.wealth,prizesPaid:last.pools.prizesPaid,
      paidRaid:last.counts.paidRaid,paidServices:last.counts.paidServices,protectorates:last.counts.protectorates,
      withdrawals:last.counts.withdrawals,dustDeferred:last.counts.dustDeferred,development:last.pools.development,burn:last.pools.burn}];
  }))]));
  console.log(JSON.stringify({executions:report.executions,realmObservations:report.realmObservations,combat:report.gameCombat?.runs,
    statScenarios:report.progressionCombat?.scenarios,compact},null,2));
}
