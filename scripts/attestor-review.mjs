// What an independent attestor checks before it signs the settlement of a matched raid. Pure: it reads nothing and
// signs nothing, so the attestor tool, the live lifecycle test and the unit tests all run the very same checks.
import { decodeAddress } from '../packages/chain-observer/index.mjs';
import { kingdomVault } from '../packages/chain-observer/kingdom-vault.mjs';
import { planMatchedCapture, planRaidSpend, raidEscrow } from '../packages/chain-observer/matched-raid.mjs';
import { verifyBattle } from '../apps/game-server/battle-records.mjs';

const scriptOf = address => { try { return decodeAddress(address).script; } catch { return null; } };

// `item` is the proposal as the server lists it, `evidence` what the server returned for it, `pins` this attestor's own
// log of what it signed before, `me` its public key. Returns the problems found, the rebuilt transaction plan, the
// digests to sign and the entries to add to the log once it has signed.
export function checkRaid({ item, evidence, pins = {}, me }) {
  const problems = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  check(item.attestors.includes(me), 'this key is not an attestor of this raid');
  const escrow = item.sources.at(-1);
  const chests = item.sources.slice(0, -1);
  let contract;
  try { contract = raidEscrow(escrow.escrow); } catch (error) { return { problems: ['the escrow terms are invalid: ' + error.message] }; }
  check(contract.script === escrow.script && escrow.satoshis === contract.satoshis, 'the input is not the raid escrow its terms describe');
  check(item.payerWallet === contract.ownerAddress, 'the stake owner is not the verified wallet of the attacking player');
  check(scriptOf(item.defenderWallet) === contract.opponent, 'the defender fixed in the escrow is not the verified wallet of the defending player');
  check(item.stakeSatoshis === contract.principal, 'the proposal states a different stake than the escrow holds');
  check(evidence, 'the server gave no evidence for this proposal');
  check(!evidence || evidence.payment?.txid === escrow.txid, 'the evidence belongs to another payment');
  // The battle this very payment started, replayed here from its recorded inputs.
  const records = (evidence?.battles ?? []).map(entry => ({ ...entry.record.battle, initiation: entry.record.initiation }));
  const fought = records.find(battle => battle.initiation?.txid === escrow.txid) ?? null;
  if (fought) {
    check(verifyBattle(fought) === true, 'replaying the recorded battle does not reproduce its result');
    check(fought.attacker === item.payer && fought.defender === item.defender, 'the recorded battle is not this attacker against this defender');
  }
  const pair = 'pair:' + [contract.ownerScript, contract.opponent].sort().join('>');
  const outpoint = escrow.txid + ':' + escrow.vout;
  check(!pins['raid:' + outpoint] || pins['raid:' + outpoint] === item.lane, 'this attestor already signed a different outcome for this stake');
  let plan = null;
  if (item.lane === 'void') {
    // The stake returns only when there was no contest to decide: the raid never ran, or these two already settled a paid raid within a day.
    const again = fought && pins[pair] && pins[pair] !== fought.id && fought.at - pins[pair + ':at'] < 86_400_000 && fought.at > pins[pair + ':at'];
    check(!fought || again, `the replayed battle was won by the ${fought?.winner}; returning the stake does not follow from it`);
  } else {
    check(fought, 'no recorded battle was started by this stake payment');
    const expected = fought?.winner === 'attacker' ? 'attacker-wins' : 'defender-wins';
    check(!fought || item.lane === expected, `the replayed battle was won by the ${fought?.winner}; the proposed lane "${item.lane}" does not follow from it`);
  }
  try {
    if (item.lane === 'attacker-wins') {
      check(chests.length >= 1 && chests.length <= 3, 'an attacker victory spends one to three War Chest outputs');
      for (const source of chests) {
        const chest = kingdomVault(source.kv);
        check(chest.revision === 4 && chest.script === source.script, 'an input is not the War Chest its terms describe');
        check(chest.ownerScript === contract.opponent, 'a War Chest input does not belong to the defender');
        check(chest.attestors.includes(me), 'this key is not an attestor of a War Chest input');
      }
      plan = planMatchedCapture(chests, escrow, { eventScript: item.eventScript ?? undefined });
      // The rebuilt transaction: the attacker's own stake, exactly the same amount from the defender, and the unused reserve.
      check(plan.outputs[0].script === contract.ownerScript && plan.outputs[0].satoshis === 2 * contract.principal, 'output 0 does not pay the attacker exactly both stakes');
      check(plan.outputs[1].script === contract.ownerScript && plan.outputs[1].satoshis === contract.reserve - plan.feeSatoshis, 'output 1 does not return the unused reserve to the attacker');
      check(chests.reduce((sum, source) => sum + source.satoshis, 0) - (plan.outputs[2]?.script === plan.contracts.at(-1).script ? plan.outputs[2].satoshis : 0) === contract.principal, 'the War Chest does not lose exactly the stake');
      check(JSON.stringify(plan.digests) === JSON.stringify(item.digests), 'the server digests do not match the rebuilt transaction');
    } else {
      check(chests.length === 0, 'only an attacker victory spends the War Chest');
      plan = planRaidSpend(escrow, { lane: item.lane, eventScript: item.eventScript ?? undefined });
      if (item.lane === 'defender-wins') check(plan.outputs[0].script === contract.opponent && plan.outputs[0].satoshis === contract.principal, 'the defender is not paid the whole stake');
      check(item.digests.length === 1 && plan.digest === item.digests[0], 'the server digest does not match the rebuilt transaction');
    }
  } catch (error) { problems.push('the settlement cannot be rebuilt: ' + error.message); }
  const log = { ['raid:' + outpoint]: item.lane, ...(fought && item.lane !== 'void' && { [pair]: fought.id, [pair + ':at']: fought.at }) };
  return { problems, plan, lane: item.lane, battle: fought && { id: fought.id, winner: fought.winner }, digests: plan ? (item.lane === 'attacker-wins' ? plan.digests : [plan.digest]) : [], log };
}
