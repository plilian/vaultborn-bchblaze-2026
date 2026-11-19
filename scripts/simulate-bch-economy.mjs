// Numerical model of the final BCH economy (50/20/20/10 services, one War Chest, 30/70 sponsorship). Transaction sizes are
// measured from the game's own transaction builders, not assumed; fees are 1 satoshi per byte, the rate the builders use.
//   node scripts/simulate-bch-economy.mjs [output.json]
import { writeFileSync } from 'node:fs';
import { paymentAllocation, PRIZE_FEED_RESERVE, SERVICE_ALLOCATION, bchPolicy, sponsorshipAllocation } from '../config/payments.mjs';
import { walletFromPrivateKey } from '../packages/chain-observer/primitives.mjs';
import { kingdomVault, planChestCapture, planKingdomWithdrawal } from '../packages/chain-observer/kingdom-vault.mjs';
import { buildFeedSweep, prizeFeeder } from '../packages/chain-observer/prize-carrier.mjs';
import { awardSize, prizeFund } from '../packages/chain-observer/prize-fund.mjs';
import { eventOutput, gameEvent } from '../packages/chain-observer/vaultborn.mjs';

const key = number => walletFromPrivateKey(number.toString(16).padStart(64, '0'));
const [operator, owner, attestor] = [key(1), key(2), key(3)];
const txid = number => number.toString(16).padStart(64, '0');
const chestTerms = id => ({ id: id.toString(16).padStart(32, '0'), operatorKey: operator.publicKey, ownerKey: owner.publicKey, recoverAt: 1_900_000_000, capturePercent: 20, captureAge: 144,
  attestors: [attestor.publicKey], revision: 2 });
const chest = (id, satoshis) => ({ txid: txid(id), vout: 0, satoshis, script: kingdomVault(chestTerms(id)).script, kv: chestTerms(id) });
const pool = prizeFund({ id: 'aa'.repeat(16), operatorKey: operator.publicKey, attestors: [attestor.publicKey], closesAt: 1_800_000_000, awardPercent: 40, awardAge: 6, maxFee: 2000 });
const feeder = share => ({ poolScript: pool.script, share });
const feed = (id, share) => ({ txid: txid(1000 + id), vout: 2, satoshis: share + PRIZE_FEED_RESERVE, script: prizeFeeder(feeder(share)).script, feeder: feeder(share) });
const poolCoin = satoshis => ({ txid: txid(9999), vout: 0, satoshis, script: pool.script, redeemScript: pool.redeemScript });
const burnBytes = 9 + eventOutput(gameEvent('premium', 'model', {})).script.length / 2;

// Measured sizes.
const sizes = {
  servicePaymentBytes: 10 + 148 + 44 + 34 + 44 + burnBytes + 34,              // one wallet input, War Chest, Development, feeder, burn, change
  feederMoveAlone: buildFeedSweep([feed(1, 800)]).feeSatoshis,
  feederMovePair: buildFeedSweep([feed(1, 800), feed(2, 800)]).rawHex.length / 2,
  feederTopUp2: buildFeedSweep([feed(1, 800), feed(2, 800)], { pool: poolCoin(50_000) }).rawHex.length / 2,
  feederTopUp10: buildFeedSweep(Array.from({ length: 10 }, (_, i) => feed(i, 800)), { pool: poolCoin(50_000) }).rawHex.length / 2,
  chestWithdraw1: planKingdomWithdrawal([chest(1, 2000)], {}).feeSatoshis,
  chestWithdraw5: planKingdomWithdrawal([1, 2, 3, 4, 5].map(id => chest(id, 2000)), {}).feeSatoshis,
  chestWithdrawLarge: planKingdomWithdrawal([chest(1, 50_000)], {}).feeSatoshis,
  captureFee: planChestCapture([chest(1, 50_000)], { satoshis: 3000, script: owner.script }).feeSatoshis,
  awardBytesOnePool: awardSize([{ satoshis: 100_000, fund: { id: 'aa'.repeat(16), operatorKey: operator.publicKey, attestors: [attestor.publicKey], closesAt: 1_800_000_000, awardPercent: 40, awardAge: 6, maxFee: 2000 } }],
    [{ script: owner.script }, { script: pool.script }]),
  raidReserve: bchPolicy.settlementReserve,
};

const service = price => { const split = paymentAllocation(price, 'premium', SERVICE_ALLOCATION);
  return { price, ...split, networkReserve: PRIZE_FEED_RESERVE, payerNetworkFee: sizes.servicePaymentBytes,
    totalPaid: price + PRIZE_FEED_RESERVE + sizes.servicePaymentBytes, overheadPercent: +((PRIZE_FEED_RESERVE + sizes.servicePaymentBytes) * 100 / price).toFixed(1),
    withdrawOneSharePercent: +(sizes.chestWithdraw1 * 100 / split.warChest).toFixed(1), capturableAlone: split.warChest * 0.2 > sizes.captureFee + 546 }; };
const perPayment = [4000, 4500, 24_000, 40_000].map(service);

// Season model: `players` active accounts, `paying` of them buy `services` premium upgrades a week, `depositors` hold a direct deposit, `raids` paid raids a week.
function season({ players, paying, services, depositors, deposit, raids, sponsors = 0 }) {
  const payments = Math.round(players * paying * services);
  const split = paymentAllocation(4500, 'premium', SERVICE_ALLOCATION);
  const moves = Math.ceil(payments / 2);
  const moveFees = payments < 2 ? 0 : moves * (sizes.feederTopUp2);
  const poolFromServices = payments * split.prize + Math.max(0, payments * PRIZE_FEED_RESERVE - moveFees);
  const sponsor = sponsors * sponsorshipAllocation(25_000_000).prize;
  const prizePool = poolFromServices + sponsor;
  const awardFees = prizePool > 4000 ? 5 * (sizes.awardBytesOnePool + 2) * (sponsors ? 1 + sponsors : 1) : 0;
  const capturable = Math.round(players * depositors) * deposit;
  const stake = 3000;
  const winPerRaid = Math.min(Math.floor(deposit * 0.2), stake);
  return { players, payments, raids, paidBySponsors: sponsors * 25_000_000,
    servicesPaid: payments * 4500, warChestFromServices: payments * split.warChest, burned: payments * split.burn,
    development: payments * split.development + sponsors * sponsorshipAllocation(25_000_000).development,
    prizePool, distributableThisSeason: Math.floor(prizePool * 0.85), prizeDistributionFees: awardFees,
    prizeDistributionFeePercent: prizePool ? +(awardFees * 100 / (prizePool * 0.85)).toFixed(2) : null,
    payerNetworkFees: payments * sizes.servicePaymentBytes, feederMoveFees: moveFees,
    capturableWarChest: capturable, serviceSharesCapturable: 0,
    expectedRaidWin: capturable ? winPerRaid - sizes.captureFee : 0, raidCostIfLost: Math.floor(stake / 2) + sizes.raidReserve, raidCostIfWonNothing: sizes.raidReserve,
    maxDailyLossOfOneChest: Math.floor(deposit * 0.2), daysToHalveAChestUnderDailyCaptures: Math.ceil(Math.log(0.5) / Math.log(0.8)) };
}
const scenarios = {
  smallNoDeposits: season({ players: 20, paying: 0.3, services: 1, depositors: 0, deposit: 0, raids: 5 }),
  smallWithDeposits: season({ players: 20, paying: 0.3, services: 1, depositors: 0.2, deposit: 20_000, raids: 10 }),
  medium: season({ players: 200, paying: 0.3, services: 2, depositors: 0.15, deposit: 20_000, raids: 150 }),
  large: season({ players: 2000, paying: 0.25, services: 2, depositors: 0.1, deposit: 20_000, raids: 2000 }),
  mediumOneSponsor: season({ players: 200, paying: 0.3, services: 2, depositors: 0.15, deposit: 20_000, raids: 150, sponsors: 1 }),
  inactive: season({ players: 200, paying: 0.02, services: 1, depositors: 0.01, deposit: 20_000, raids: 2 }),
};
const report = { generatedBy: 'scripts/simulate-bch-economy.mjs', feeRate: '1 satoshi per byte', sizes, perPayment, scenarios };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 1));
