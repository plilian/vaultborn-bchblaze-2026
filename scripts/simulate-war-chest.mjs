// Numerical model of small War Chest balances before and after keyless consolidation. Sizes are measured from the game's
// own transaction builders; fees are 1 satoshi per byte. Nothing here is a blockchain transaction.
//   node scripts/simulate-war-chest.mjs [output.json]
import { writeFileSync } from 'node:fs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { planChestCapture, planKingdomWithdrawal, signChestExit, signKingdomRecovery, signKingdomWithdrawal } from '../packages/chain-observer/kingdom-vault.mjs';
import { CHEST_FEED_RESERVE, PRIZE_FEED_RESERVE } from '../config/payments.mjs';

const key = number => number.toString(16).padStart(64, '0');
const wallet = number => walletFromPrivateKey(key(number));
const owner = wallet(2), winner = wallet(3);
const PAYER_FEE = 364 + 0;           // measured service payment, one input and change (see economy-model.json)
const OLD = { reserve: 300, withdrawal: 544, capture: 610 };   // the previous design, from the previous report

function model(attestorCount) {
  const chain = createChain({ treasuryPrivateKey: key(1), developmentAddress: wallet(9).address, prizeAttestors: [11, 12, 13].slice(0, attestorCount).map(n => wallet(n).publicKey),
    transport: { withClient: () => { throw new Error('offline'); } } });
  const chest = chain.chestOf({ ownerKey: owner.publicKey });
  const floor = chain.captureFloor(chest);
  const output = (satoshis, n = 1) => ({ txid: key(100 + n), vout: 0, satoshis, script: chest.script, kv: chest.kv });
  const feedTerms = { chestScript: chest.script, threshold: floor, reserve: CHEST_FEED_RESERVE, wait: 13_104 };
  const move = count => chain.chestFeedBytes(feedTerms, count);
  const captureFee = count => planChestCapture(Array.from({ length: count }, (_, i) => output(50_000, i)), { satoshis: 10_000 * count, script: winner.script }).feeSatoshis;
  const withdrawal = signKingdomWithdrawal(planKingdomWithdrawal([output(20_000)], {}), key(1)).feeSatoshis;
  const exitOne = signChestExit([output(20_000)], key(2));
  const exitTwo = signKingdomRecovery([{ ...exitOne.exits[0], txid: exitOne.txid }], key(2), [{ script: owner.script, satoshis: exitOne.exits[0].satoshis - 700 }]);
  const ride = chain.captureCost(chest, 1, 1) - chain.captureCost(chest, 1);
  const sizes = { ridingShareInCapture: ride, chestFeederMove: { 1: move(1), 2: move(2), 3: move(3), 4: move(4) }, captureFee: { 1: captureFee(1), 2: captureFee(2) }, withdrawal,
    ownerExit: { stepOne: exitOne.feeSatoshis, stepTwo: exitTwo.rawHex.length / 2 }, captureFloor: floor };
  // What a capture can take from a set of War Chest outputs, exactly as the ledger decides it.
  const quote = (outputs, limit = 3_000, shares = []) => {
    const sorted = outputs.toSorted((a, b) => b - a).slice(0, 4);
    const step = sizes.captureFee[2] - sizes.captureFee[1];
    const used = []; const riding = []; let total = 0;
    for (const value of sorted) { if (Math.floor(total / 5) >= limit) break; if (used.length && Math.floor(value / 5) <= step) break; used.push(value); total += value; }
    // Waiting shares join the capture of an output already in the War Chest.
    if (used.length) for (const value of shares.toSorted((a, b) => b - a)) { if (used.length + riding.length >= 4 || Math.floor(total / 5) >= limit) break; if (Math.floor(value / 5) <= ride) break; riding.push(value); total += value; }
    const gross = Math.min(Math.floor(total / 5), limit);
    const fee = sizes.captureFee[1] + (used.length - 1) * step + riding.length * ride;
    return gross - fee < 546 ? null : { gross, fee, net: gross - fee, inputs: used.length, used, riding };
  };
  const perPrice = [4_000, 4_500, 24_000].map(price => {
    const share = price / 2;
    // A share that already reaches the floor is paid straight into the War Chest: no feeder, no reserve, no move.
    const direct = share >= floor;
    const batch = direct ? 1 : [1, 2, 3, 4].find(count => count * (share + CHEST_FEED_RESERVE) - move(count) >= floor) ?? null;
    const joined = direct ? share : batch && batch * (share + CHEST_FEED_RESERVE) - move(batch);
    const capture = joined && quote([joined]);
    return { price, warChestShare: share,
      before: { reserve: OLD.reserve, payerOverhead: OLD.reserve + PAYER_FEE, overheadPercent: +((OLD.reserve + PAYER_FEE) * 100 / price).toFixed(1),
        capturableAlone: Math.floor(share / 5) - OLD.capture >= 546, withdrawalFeePerShare: OLD.withdrawal, withdrawalPercent: +(OLD.withdrawal * 100 / share).toFixed(1),
        endToEndCostPerShare: Math.round((OLD.reserve + PAYER_FEE) / 2 + OLD.withdrawal) },
      after: { direct, reserve: PRIZE_FEED_RESERVE + (direct ? 0 : CHEST_FEED_RESERVE), payerOverhead: PRIZE_FEED_RESERVE + (direct ? 0 : CHEST_FEED_RESERVE) + PAYER_FEE,
        overheadPercent: +((PRIZE_FEED_RESERVE + (direct ? 0 : CHEST_FEED_RESERVE) + PAYER_FEE) * 100 / price).toFixed(1), sharesToJoin: batch, joinedOutput: joined,
        reserveReturnedToChest: direct ? 0 : batch && batch * CHEST_FEED_RESERVE - move(batch), capture, withdrawalFeePerShare: batch && Math.round(withdrawal / batch),
        withdrawalPercent: batch && +(withdrawal * 100 / joined).toFixed(1),
        endToEndCostPerShare: batch && Math.round((PRIZE_FEED_RESERVE + PAYER_FEE) / 2 + (direct ? 0 : move(batch) / batch) + withdrawal / batch) } };
  });
  // A player who never deposits and buys `perWeek` premium upgrades (4,500 sat) a week for 12 weeks, raided once a day
  // by a different winning attacker whenever a capture is executable.
  const life = perWeek => {
    let waiting = [], chestOutputs = [], firstCapturableDay = null, captured = 0, captureFees = 0, captures = 0, capturableDays = 0;
    const waits = [];
    for (let day = 0; day < 84; day += 1) {
      const buys = Math.floor((day + 1) * perWeek / 7) - Math.floor(day * perWeek / 7);
      for (let i = 0; i < buys; i += 1) waiting.push({ value: 2_250 + CHEST_FEED_RESERVE, day });
      while (waiting.length) {
        const batch = waiting.slice(0, 4);
        const total = batch.reduce((sum, item) => sum + item.value, 0) - move(batch.length);
        // Below the threshold the game moves shares only when every waiting share has waited out its period (91 days).
        const aged = batch.every(item => day - item.day >= 91);
        if (total < floor && !aged) break;
        const take = batch;
        chestOutputs.push(take.reduce((sum, item) => sum + item.value, 0) - move(take.length));
        for (const item of take) waits.push(day - item.day);
        waiting = waiting.slice(take.length);
      }
      const offer = quote(chestOutputs, 3_000, waiting.map(item => item.value));
      if (offer) {
        capturableDays += 1; firstCapturableDay ??= day; captures += 1; captured += offer.gross; captureFees += offer.fee;
        // The capture spends the outputs it used and returns one remainder to the War Chest.
        const rest = chestOutputs.toSorted((a, b) => b - a);
        chestOutputs = [offer.used.reduce((sum, value) => sum + value, 0) + offer.riding.reduce((sum, value) => sum + value, 0) - offer.gross, ...rest.slice(offer.used.length)];
        // Shares that rode along are in the War Chest now.
        for (const value of offer.riding) { const index = waiting.findIndex(item => item.value === value); waits.push(day - waiting[index].day); waiting.splice(index, 1); }
      }
    }
    const total = chestOutputs.reduce((sum, value) => sum + value, 0);
    return { servicesPerWeek: perWeek, paid: Math.floor(84 * perWeek / 7) * 4_500, firstCapturableDay, daysCapturable: capturableDays, captures, capturedGross: captured, captureFees, winnersReceived: captured - captureFees,
      averageWaitDays: waits.length ? +(waits.reduce((a, b) => a + b, 0) / waits.length).toFixed(1) : null, chestOutputsAtEnd: chestOutputs.length, chestAtEnd: total,
      belowFloorAtEnd: chestOutputs.filter(value => value < floor).reduce((sum, value) => sum + value, 0), stillWaitingAtEnd: waiting.reduce((sum, item) => sum + item.value - CHEST_FEED_RESERVE, 0) };
  };
  return { attestors: attestorCount, threshold: chain.attestorThreshold, sizes, perPrice, neverDeposits: [0.25, 1, 3, 7].map(life) };
}
const report = { generatedBy: 'scripts/simulate-war-chest.mjs', feeRate: '1 satoshi per byte', configurations: [model(1), model(3)] };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
for (const item of report.configurations) {
  console.log(`\n${item.threshold} of ${item.attestors} attestors · sizes ${JSON.stringify(item.sizes)}`);
  for (const row of item.perPrice) console.log(' price', row.price, 'before', JSON.stringify(row.before), '\n            after ', JSON.stringify(row.after));
  for (const row of item.neverDeposits) console.log(' never deposits', JSON.stringify(row));
}
