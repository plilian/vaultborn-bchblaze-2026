import { planTreasurySpend } from '../../packages/chain-observer/treasury-covenants.mjs';
import { walletFromPublicKey } from '../../packages/chain-observer/primitives.mjs';
import { verifyBattle } from './battle-records.mjs';

// Each attestor compares the admission independently with the saved checkout and chain history.
export function planVerifiedBattleSettlement({ covenant, funding, admission, battle }) {
  if (!['battle-escrow', 'kingdom-treasury'].includes(covenant.kind)) {
    throw new Error('An archived raid can authorize only a raid escrow or named kingdom exposure.');
  }
  if (admission?.covenantId !== covenant.id || admission.fundingTxid !== funding.txid ||
      admission.fundingVout !== funding.vout || admission.ownerAddress !== walletFromPublicKey(covenant.ownerKey).address ||
      admission.opponentAddress !== covenant.opponent) {
    throw new Error('The contest admission does not match the covenant and funding outpoint.');
  }
  if (battle?.id !== admission.battleId || battle.kind !== 'raid' || !battle.paid || battle.hash !== admission.battleHash ||
      admission.ownerCity === admission.opponentCity ||
      ![battle.attacker, battle.defender].includes(admission.ownerCity) ||
      ![battle.attacker, battle.defender].includes(admission.opponentCity) || !verifyBattle(battle)) {
    throw new Error('The archived raid fails verification against the admitted contest.');
  }
  const lane = battle[battle.winner] === admission.ownerCity ? 'return' : 'opponent-wins';
  return planTreasurySpend(covenant, funding, { lane });
}
