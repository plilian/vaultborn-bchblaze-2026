import { writeFile } from 'node:fs/promises';
import { kingdom, liveFees } from '../apps/game-server/kingdom.mjs';
import { seeded } from '../packages/game-engine/combat.mjs';

const now = 1_794_845_600_000;
const random = seeded(719_228);
const fee = 366;
const feeSplit = kingdom.split(liveFees.attack, 'attack-paid');
const txids = { fund: '1'.repeat(64), raid: '2'.repeat(64) };
const wallets = {
  attacker:'bchtest:qp3w6c2x3syvjpfn3tf5muffvlnggpfzuy7s6zr6z6',
  defender:'bchtest:qzygq4xr0d0hq0lcku5xwj2dc6w9vvxqjqfla9ra3n',
};
function row(id, playerId, action, satoshis) {
  const txid = txids[id];
  const allocations = Object.entries(kingdom.split(satoshis,action))
    .map(([role, value], vout) => ({role,satoshis:value,vout,txid}));
  return {id, playerId, action, satoshis, state:'confirmed', txid, receipt:{txid,allocations}};
}
const results = [];
for (const probability of [.25,.353,.5,.6]) {
  for (const exposure of [0,3000,15000,30000,60000,90000]) {
    let wins = 0;
    let sumAttacker = 0;
    let sumDefender = 0;
    for (let round = 0; round < 1000; round++) {
      const world = { cities: { attacker:{optIn:true}, defender:{optIn:true} } };
      if (exposure) kingdom.apply(world,row('fund','defender','premium',exposure*2),null,now);
      kingdom.commit(world,'defender',exposure,now,wallets.defender);
      const won = random() < probability;
      const battle = { kind:'raid', paid:true, attacker:'attacker', defender:'defender', winner:won ? 'attacker' : 'defender' };
      kingdom.apply(world,row('raid','attacker','attack-paid',liveFees.attack),battle,now,id => wallets[id]);
      const attacker = kingdom.balance(world,'attacker',now).kingdomSatoshis;
      const defender = kingdom.balance(world,'defender',now).kingdomSatoshis;
      if (attacker + defender !== exposure + feeSplit.battle) throw new Error('The simulation did not conserve escrow funds.');
      wins += Number(won);
      sumAttacker += attacker - liveFees.attack - fee;
      sumDefender += defender - exposure;
    }
    results.push({ winProbability:probability, exposure, trials:1000, wins, attackerMeanNetSatoshis:sumAttacker/1000,
      defenderMeanNetSatoshis:sumDefender/1000 });
  }
}
const report = { modeledTrials:24_000, raid:liveFees.attack, estimatedWalletFee:fee, captureLimit:.2, feeSplit, results };
await writeFile(new URL('../docs/vaultborn-kingdom-simulation.json',import.meta.url), JSON.stringify(report,null,2) + '\n');
console.table(results.filter(item => item.winProbability === .353));
console.log('24,000 escrow simulations conserved every satoshi.');
