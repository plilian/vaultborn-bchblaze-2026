import { readFile } from 'node:fs/promises';
import { encodeTransaction } from '@bitauth/libauth';
import { chipnetTreasuryConfig } from '../config/treasury.mjs';
import { hex } from '../packages/chain-observer/primitives.mjs';
import { compileTreasuryCovenant, completeTreasurySpend, planTreasurySpend, treasurySigningHash } from '../packages/chain-observer/treasury-covenants.mjs';
import { planVerifiedBattleSettlement } from '../apps/game-server/treasury-attestation.mjs';

const [operation, file] = process.argv.slice(2);
function print(value) { console.log(JSON.stringify(value, null, 2)); }
try {
  if (operation === 'config' && !file) {
    print(chipnetTreasuryConfig());
  } else if (file && ['compile', 'prepare', 'assemble'].includes(operation)) {
    const { covenant, funding, spend, signatures, admission, battle } = JSON.parse(await readFile(file, 'utf8'));
    if (operation === 'compile') {
      print(compileTreasuryCovenant(covenant));
    } else {
      if (Boolean(admission) !== Boolean(battle)) throw new Error('Attach both the contest admission and archived raid.');
      const plan = admission ? planVerifiedBattleSettlement({ covenant, funding, admission, battle }) :
        planTreasurySpend(covenant, funding, spend);
      if (operation === 'prepare') print({ covenant:plan.contract, lane:plan.lane,
        signingHash:hex(treasurySigningHash(plan)), unsignedTransaction:hex(encodeTransaction(plan.transaction)) });
      else print(completeTreasurySpend(plan, signatures));
    }
  } else {
    throw new Error('Usage: treasury-covenant.mjs config | compile FILE | prepare FILE | assemble FILE');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
