// The measurements behind config/pricing.mjs. Every size is taken from a transaction built and signed by the game's own
// contract code (and accepted by the BCH VM); one byte costs one satoshi. No transaction is broadcast.
//   node scripts/measure-pricing.mjs [output.json]
import { writeFileSync } from 'node:fs';
import { walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { kingdomVault, planKingdomWithdrawal, signChestExit, signKingdomRecovery, signKingdomWithdrawal, vaultTerms } from '../packages/chain-observer/kingdom-vault.mjs';
import { completeMatchedCapture, completeRaidSpend, planMatchedCapture, planRaidSpend, raidEscrow, raidTermsFor, signMatchedDigests, signRaidDigest, signRaidRefund } from '../packages/chain-observer/matched-raid.mjs';
import { recordReserve, signRecord, RECORD_RESERVE_SATOSHIS } from '../packages/chain-observer/record-reserve.mjs';
import { completeStakeSpend, planStakeSpend, signStakeDigest, stakeEscrow, stakeTerms } from '../packages/chain-observer/stake-escrow.mjs';
import { LEGACY_PRICING, PRICING, priceBook } from '../config/pricing.mjs';
import { PRIZE_FEED_RESERVE, serviceSplit } from '../config/payments.mjs';

const key = number => number.toString(16).padStart(64, '0');
const wallet = number => walletFromPrivateKey(key(number));
const record = '6a045642524e22' + '01' + '10' + '11'.repeat(32);
const [game, defender, attacker] = [wallet(1), wallet(2), wallet(3)];
const secrets = { [game.publicKey]: key(1), [wallet(11).publicKey]: key(11), [wallet(12).publicKey]: key(12), [wallet(13).publicKey]: key(13) };

function contracts(count) {
  const attestors = [11, 12, 13].slice(0, count).map(n => wallet(n).publicKey);
  const chest = kingdomVault({ operatorKey: game.publicKey, ownerKey: defender.publicKey, attestors, revision: 4 });
  const panel = count === 1 ? { keys: [game.publicKey, attestors[0]], threshold: 2 } : { keys: attestors, threshold: 2 };
  const terms = raidTermsFor({ id: '11'.repeat(16), ownerKey: attacker.publicKey, opponent: defender.script, principal: 10_000, refundAt: 1_700_000_000, panel, chest });
  const escrow = raidEscrow(terms);
  const chestOutput = (satoshis, n) => ({ txid: key(100 + n), vout: 0, satoshis, script: chest.script, kv: vaultTerms(chest) });
  const funding = { txid: key(200), vout: 0, satoshis: escrow.satoshis, script: escrow.script, escrow: terms };
  const signers = chest.attestors.slice(0, chest.threshold);
  const win = outputs => { const plan = planMatchedCapture(Array.from({ length: outputs }, (_, n) => chestOutput(outputs === 1 ? 30_000 : outputs === 2 ? 6_000 : 4_000, n)), funding, { eventScript: record });
    const signed = completeMatchedCapture(plan, key(1), Object.fromEntries(signers.map(item => [item, signMatchedDigests(plan, secrets[item])])));
    return { bytes: signed.bytes, fee: signed.feeSatoshis, attackerReceives: plan.paid }; };
  const lane = name => { const plan = planRaidSpend(funding, { lane: name, eventScript: record });
    const signed = completeRaidSpend(plan, Object.fromEntries(panel.keys.slice(0, 2).map(item => [item, signRaidDigest(plan.digest, secrets[item])])));
    return { bytes: signed.bytes, fee: signed.feeSatoshis, outputs: plan.outputs.filter(item => item.satoshis).map(item => item.satoshis) }; };
  const release = outputs => signKingdomWithdrawal(planKingdomWithdrawal(Array.from({ length: outputs }, (_, n) => chestOutput(20_000, n)), { satoshis: 5_000, eventScript: record }), key(1));
  const exit = signChestExit([chestOutput(20_000, 1)], key(2), { fee: { txid: key(300), vout: 0, satoshis: 2_000 } });
  const leave = signKingdomRecovery([{ ...exit.exits[0], txid: exit.txid }], key(2), [{ script: defender.script, satoshis: 20_000 - 700 }]);
  // The territory stake escrow (version 3), unchanged: its settlement must fit the 600-satoshi reserve.
  const stake = stakeEscrow({ id: '22'.repeat(16), kind: 'territory-escrow', ownerKey: attacker.publicKey, opponent: defender.script, principal: 10_000, reserve: 600, refundAt: 1_700_000_000, panel });
  const stakeFunding = { txid: key(400), vout: 0, satoshis: stake.satoshis, script: stake.script, escrow: stakeTerms(stake) };
  const split = planStakeSpend(stakeFunding, { lane: 'opponent-wins', eventScript: record });
  const splitSigned = completeStakeSpend(split, Object.fromEntries(panel.keys.slice(0, 2).map(item => [item, signStakeDigest(split, secrets[item])])));
  return { attestors: count === 1 ? '1 of 1' : '2 of 3', scripts: { warChestBytes: chest.redeemScript.length / 2, raidEscrowBytes: escrow.redeemScript.length / 2 },
    matchedRaid: { reserveLockedWithTheStake: terms.reserve, settleFee: terms.settleFee, winBase: terms.winBase, winPerWarChestOutput: terms.winPerInput,
      attackerWins: { oneWarChestOutput: win(1), twoWarChestOutputs: win(2), threeWarChestOutputs: win(3) }, defenderWins: lane('defender-wins'), voidRaid: lane('void'),
      attackerOwnRefund: { bytes: signRaidRefund(funding, key(3), { unchecked: true }).rawHex.length / 2, feeAllowed: terms.settleFee } },
    warChest: { withdrawal: { oneOutput: release(1).feeSatoshis, twoOutputs: release(2).feeSatoshis, threeOutputs: release(3).feeSatoshis, feeCap: chest.maxFee },
      ownerExit: { stepOneBytes: exit.rawHex.length / 2, stepOnePaidFromTheOwnersWallet: exit.feeSatoshis, stepTwoBytes: leave.rawHex.length / 2 } },
    territoryStake: { reserve: 600, splitSettlementBytes: splitSigned.rawHex.length / 2 } };
}
const reserveTerms = { id: '33'.repeat(16), operatorKey: game.publicKey, ownerKey: attacker.publicKey };
const proof = signRecord({ txid: key(500), vout: 0, satoshis: RECORD_RESERVE_SATOSHIS, script: recordReserve(reserveTerms).script, rr: reserveTerms }, record, key(1));
const [before, after] = [priceBook(LEGACY_PRICING), priceBook(PRICING)];
// A service payment by the payer's wallet: one input, the War Chest, reward and Development outputs, the funded burn and
// record, and change. (The wallet chooses its inputs; this is the one-input case.)
const servicePayment = 10 + 148 + 44 + 44 + 34 + 43 + 34;
const one = contracts(1), three = contracts(3);
const service = (name, label, was, now, extraReserve = 0, note = '') => ({ action: label, was, now, warChestShare: now / 2, seasonPrizes: now / 5, development: now / 5, burned: now / 10,
  networkReserve: PRIZE_FEED_RESERVE + extraReserve, walletFee: servicePayment + (extraReserve ? 44 : 0), fixedNetworkCostPercentOfPrice: { was: +((servicePayment + 300) * 100 / was).toFixed(1), now: +((servicePayment + (extraReserve ? 44 : 0) + PRIZE_FEED_RESERVE + extraReserve) * 100 / now).toFixed(1) }, note });
const table = {
  services: [
    service('rush', 'Rush an upgrade', before.services.rush, after.services.rush, 0, 'single use; the War Chest share equals the smallest raid stake'),
    service('espionage-paid', 'Paid intelligence mission', before.services['espionage-paid'], after.services['espionage-paid'], 0, 'single use; same floor'),
    service('premium', 'Premium building improvement', before.services.premium, after.services.premium, 0, 'permanent; a tenth above the single-use price, as before'),
    service('protectorate', 'Protectorate proposal', before.services.protectorate, after.services.protectorate, 0, 'unchanged: its share already exceeds the smallest stake'),
    service('political-operation', 'Treaty charter (was closed)', before.services['political-operation'], after.services['political-operation'], after.reserves.record, 'restored; the extra reserve can only pay the fee of its proof record'),
    service('political-operation', 'Political support (was closed)', before.services['political-support'], after.services['political-operation'], after.reserves.record, 'restored at the single-use price'),
  ],
  stakes: [
    { action: 'Paid raid', was: 'stake 3,000 + reserve 600; win: 20% of the chest capped at the stake, less a capture fee of 663 to 804; loss: half the stake', now: `stake S chosen from ${after.raid.minimumStake} to ${after.raid.maximumStake} in steps of ${after.raid.step}; both sides exposed to S`,
      reserveLocked: { oneAttestor: one.matchedRaid.reserveLockedWithTheStake, twoOfThree: three.matchedRaid.reserveLockedWithTheStake },
      networkFeeWin: { oneAttestor: one.matchedRaid.attackerWins.oneWarChestOutput.fee, twoOfThree: three.matchedRaid.attackerWins.oneWarChestOutput.fee },
      networkFeeLossOrVoid: { oneAttestor: one.matchedRaid.settleFee, twoOfThree: three.matchedRaid.settleFee },
      winFeePercentOfSmallestStake: { oneAttestor: +(one.matchedRaid.attackerWins.oneWarChestOutput.fee * 100 / after.raid.minimumStake).toFixed(1), twoOfThree: +(three.matchedRaid.attackerWins.oneWarChestOutput.fee * 100 / after.raid.minimumStake).toFixed(1) } },
    ...['territory-claim', 'territory-attack', 'territory-raffle'].map(name => ({ action: name, was: before.stakes[name], now: after.stakes[name],
      reservePercentOfPrincipal: { was: +(before.stakes[name].reserve * 100 / before.stakes[name].principal).toFixed(1), now: +(after.stakes[name].reserve * 100 / after.stakes[name].principal).toFixed(1) } })),
  ],
  deposits: { warChestMinimum: { was: '6,350 (one attestor) or 7,050 (two of three)', now: after.warChest.minimumDeposit, step: after.warChest.step }, personalVault: { was: '1,000 to 250,000 into a separate protected vault', now: 'closed to new deposits: one treasury' },
    treatyCompensationEscrow: 'unchanged: the principal the treaty names plus 650 for its settlement', sponsorship: 'unchanged: 0.25 BCH minimum, 0.5 BCH season banner, 2 BCH title sponsor, 25 BCH maximum; 30% Development, 70% prizes' },
};
const report = { generatedAt: new Date().toISOString(), note: 'Sizes of transactions built, signed and verified in the BCH VM by the game\'s own contract code. One byte costs one satoshi. Nothing here was broadcast.',
  split: serviceSplit, priceBook: PRICING, table, measured: { oneAttestor: one, twoOfThree: three, politicalProofRecord: { bytes: proof.bytes, reserve: RECORD_RESERVE_SATOSHIS, why: 'the smallest contract output the network relays' },
    servicePaymentBytes: servicePayment, rewardShareReserve: PRIZE_FEED_RESERVE } };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.measured, null, 1));
