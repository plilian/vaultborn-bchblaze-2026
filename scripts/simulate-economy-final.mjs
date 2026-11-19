// Economic model of the final VaultBorn BCH economy, with the prices that are implemented (config/pricing.mjs) and the
// fees that the contracts really cost (every size below is measured from the game's own transaction builders at one
// satoshi per byte). It is a model: no transaction is broadcast. Random choices use a fixed seed, so a run is repeatable.
//   node scripts/simulate-economy-final.mjs [output.json]
import { writeFileSync } from 'node:fs';
import { walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { kingdomVault, planKingdomWithdrawal, signKingdomWithdrawal, vaultTerms } from '../packages/chain-observer/kingdom-vault.mjs';
import { raidEscrow, raidTermsFor } from '../packages/chain-observer/matched-raid.mjs';
import { PRICING, priceBook } from '../config/pricing.mjs';
import { serviceSplit, sponsorshipPolicy, PRIZE_FEED_RESERVE } from '../config/payments.mjs';

const key = number => number.toString(16).padStart(64, '0');
const wallet = number => walletFromPrivateKey(key(number));
const book = priceBook(PRICING);

// ---- Measured sizes ----
function measured(attestorCount) {
  const attestors = [11, 12, 13].slice(0, attestorCount).map(n => wallet(n).publicKey);
  const chest = kingdomVault({ operatorKey: wallet(1).publicKey, ownerKey: wallet(2).publicKey, attestors, revision: 4 });
  const panel = attestorCount === 1 ? { keys: [wallet(1).publicKey, attestors[0]], threshold: 2 } : { keys: attestors, threshold: 2 };
  const terms = raidTermsFor({ id: '11'.repeat(16), ownerKey: wallet(3).publicKey, opponent: wallet(2).script, principal: 10_000, refundAt: 1_900_000_000, panel, chest });
  const escrow = raidEscrow(terms);
  const output = (satoshis, n) => ({ txid: key(100 + n), vout: 0, satoshis, script: chest.script, kv: vaultTerms(chest) });
  const release = count => signKingdomWithdrawal(planKingdomWithdrawal(Array.from({ length: count }, (_, n) => output(20_000, n)), {}), key(1)).feeSatoshis;
  return { attestors: attestorCount, threshold: chest.threshold, raidReserve: terms.reserve, settleFee: terms.settleFee, winBase: terms.winBase, winPerOutput: terms.winPerInput,
    winFee: count => terms.winBase + count * terms.winPerInput, releaseFee: release, escrowScriptBytes: escrow.redeemScript.length / 2, chestScriptBytes: chest.redeemScript.length / 2,
    // The payer's own transactions: one wallet input, the listed outputs, change. Their fee is the wallet's, shown for completeness.
    servicePaymentFee: 10 + 148 + 44 + 44 + 34 + 43 + 34, raidPaymentFee: 10 + 148 + 44 + 50 + 34, depositFee: 10 + 148 + 44 + 50 + 34, politicalExtraFee: 44,
    feederMove: count => 54 + 160 * count, awardFee: 688 };
}

// ---- Deterministic random numbers ----
function random(seed) { let a = seed >>> 0; return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const kinds = {
  // servicesPerWeek, chance of a paid raid attempt per day, stake wished for, opening deposit, weekly chance to withdraw half
  casual: { share: .6, services: 1, raid: .02, stake: 10_000, deposit: 0, withdraw: .05 },
  regular: { share: .3, services: 3, raid: .25, stake: 25_000, deposit: 20_000, withdraw: .1 },
  heavy: { share: .1, services: 7, raid: .6, stake: 50_000, deposit: 100_000, withdraw: .05 },
};
const serviceMix = [['rush', .35], ['espionage-paid', .25], ['premium', .2], ['protectorate', .1], ['political-operation', .1]];

function simulate({ players, seasons = 4, attestors = 1, sponsorship = 'none', dodgers = .05, attestorOutage = .01, seed = 7 }) {
  const m = measured(attestors);
  const rng = random(seed + players + attestors * 13 + (sponsorship === 'none' ? 0 : 101));
  const pick = table => { let roll = rng(); for (const [name, weight] of table) { if ((roll -= weight) < 0) return name; } return table.at(-1)[0]; };
  const roster = Array.from({ length: players }, (_, index) => {
    const kind = index < players * kinds.casual.share ? 'casual' : index < players * (kinds.casual.share + kinds.regular.share) ? 'regular' : 'heavy';
    return { id: index, kind, chest: [], score: 0, spent: 0, raidNet: 0, fees: 0, dodger: rng() < dodgers };
  });
  const totals = { services: 0, serviceSpend: 0, warChest: 0, prize: 0, development: 0, burn: 0, sponsorship: 0, deposits: 0, depositSatoshis: 0,
    networkFees: 0, payerReserves: 0, reserveReturnedToPools: 0, reserveBackToAttackers: 0,
    raidsAttempted: 0, raidsBlockedNoExposure: 0, raidsBlockedCooldown: 0, raidsFought: 0, attackerWins: 0, defenderWins: 0, raidsVoided: 0, stakeVolume: 0, capturedSatoshis: 0, forfeitedSatoshis: 0,
    winFees: 0, lossFees: 0, exitsAfterFunding: 0, exitsThatEscaped: 0, withdrawals: 0, withdrawnSatoshis: 0, withdrawalFees: 0, chestOutputsSpentPerWin: 0 };
  const seasonReports = [];
  const lastFought = new Map();
  let pool = 0; let rolled = 0;
  const exposure = player => player.chest.toSorted((a, b) => b - a).slice(0, 3).reduce((sum, value) => sum + value, 0);
  const capture = (player, stake) => {
    const sorted = player.chest.toSorted((a, b) => b - a);
    let held = 0; let used = 0;
    while (held < stake) held += sorted[used++];
    player.chest = [...sorted.slice(used), ...(held > stake ? [held - stake] : [])];
    return used;
  };
  for (let season = 1; season <= seasons; season += 1) {
    const start = { ...totals };
    let feeders = 0;
    for (const player of roster) player.score = 0;
    if (sponsorship !== 'none') {
      const amount = sponsorshipPolicy.minimumSatoshis * (sponsorship === 'banner' ? 2 : 1);
      totals.sponsorship += amount; totals.development += amount * .3; pool += amount * .7;
    }
    for (let day = 0; day < 7; day += 1) {
      const claimed = new Map();
      for (const player of roster) {
        const profile = kinds[player.kind];
        // Opening deposit, once.
        if (season === 1 && day === 0 && profile.deposit) { player.chest.push(profile.deposit); totals.deposits += 1; totals.depositSatoshis += profile.deposit; totals.networkFees += m.depositFee; player.fees += m.depositFee; }
        // Services.
        const buys = Math.floor(profile.services / 7) + (rng() < (profile.services % 7) / 7 ? 1 : 0);
        for (let n = 0; n < Math.min(buys, 2); n += 1) {
          const service = pick(serviceMix);
          const price = book.services[service];
          const record = service === 'political-operation' ? book.reserves.record : 0;
          totals.services += 1; totals.serviceSpend += price; player.spent += price; player.score += 3;
          totals.warChest += price * serviceSplit.warChest / 100; totals.prize += price * serviceSplit.prize / 100; pool += price * serviceSplit.prize / 100;
          totals.development += price * serviceSplit.development / 100; totals.burn += price * serviceSplit.burn / 100;
          player.chest.push(price * serviceSplit.warChest / 100);
          totals.payerReserves += PRIZE_FEED_RESERVE + record; feeders += 1;
          const fee = m.servicePaymentFee + (record ? m.politicalExtraFee : 0);
          totals.networkFees += fee + record; player.fees += fee + PRIZE_FEED_RESERVE + record;
        }
        // A paid raid, if the player wants one and finds a defender whose War Chest covers a stake.
        if (rng() < profile.raid) {
          totals.raidsAttempted += 1;
          const target = roster[Math.floor(rng() * players)];
          const pair = Math.min(player.id, target.id) + ':' + Math.max(player.id, target.id);
          const free = target.id === player.id ? 0 : exposure(target) - (claimed.get(target.id) ?? 0);
          const stake = Math.min(profile.stake, Math.floor(free / book.raid.step) * book.raid.step);
          if (stake < book.raid.minimumStake) totals.raidsBlockedNoExposure += 1;
          else if (lastFought.get(pair) === season * 10 + day) totals.raidsBlockedCooldown += 1;
          else {
            lastFought.set(pair, season * 10 + day);
            claimed.set(target.id, (claimed.get(target.id) ?? 0) + stake);
            totals.raidsFought += 1; totals.stakeVolume += stake; totals.payerReserves += m.raidReserve;
            totals.networkFees += m.raidPaymentFee; player.fees += m.raidPaymentFee;
            const won = rng() < .5;
            // A defender who starts an exit after the raid was funded gains nothing: the settlement follows into the exit
            // script. Only an attestor outage longer than the two-day exit delay lets the money leave first.
            if (won && target.dodger) { totals.exitsAfterFunding += 1; if (rng() < attestorOutage) { totals.exitsThatEscaped += 1; totals.raidsVoided += 1; totals.networkFees += m.settleFee; player.fees += m.settleFee; player.raidNet -= m.settleFee; target.chest = []; continue; } }
            if (won) {
              const used = capture(target, stake);
              const fee = m.winFee(used);
              totals.attackerWins += 1; totals.capturedSatoshis += stake; totals.winFees += fee; totals.networkFees += fee; totals.reserveBackToAttackers += m.raidReserve - fee; totals.chestOutputsSpentPerWin += used;
              player.raidNet += stake - fee; target.raidNet -= stake; player.fees += fee; player.score += 15; target.score += 2;
            } else {
              totals.defenderWins += 1; totals.forfeitedSatoshis += stake; totals.lossFees += m.settleFee; totals.networkFees += m.settleFee; totals.reserveBackToAttackers += m.raidReserve - m.settleFee;
              player.raidNet -= stake + m.settleFee; target.raidNet += stake; player.fees += m.settleFee; target.score += 10; player.score += 2;
            }
          }
        }
        // A withdrawal of half the War Chest, through the game key, paid from the chest.
        if (rng() < profile.withdraw / 7 && exposure(player) - (claimed.get(player.id) ?? 0) >= 20_000) {
          const sorted = player.chest.toSorted((a, b) => b - a);
          const used = sorted.slice(0, Math.min(3, sorted.length));
          const held = used.reduce((sum, value) => sum + value, 0);
          const fee = m.releaseFee(used.length);
          const kept = Math.floor((held / 2 - fee) / 1000) * 1000;
          player.chest = [...sorted.slice(used.length), ...(kept >= 1000 ? [kept] : [])];
          totals.withdrawals += 1; totals.withdrawnSatoshis += held - kept - fee; totals.withdrawalFees += fee; totals.networkFees += fee;
        }
      }
    }
    // Reward shares move into the pool in batches of four; what their reserves do not need stays in the pool.
    const moves = Math.ceil(feeders / 4);
    const moveFees = moves ? (moves - 1) * m.feederMove(4) + m.feederMove(feeders - (moves - 1) * 4 || 4) : 0;
    totals.networkFees += moveFees; pool += feeders * PRIZE_FEED_RESERVE - moveFees; totals.reserveReturnedToPools += feeders * PRIZE_FEED_RESERVE - moveFees;
    // Season close: 85% of the pool is distributable to the top five at 40/25/15/10/10; 15% and anything unpaid roll over.
    const ranked = roster.filter(player => player.score > 0).toSorted((a, b) => b.score - a.score || a.id - b.id);
    const base = ranked.length >= 2 ? Math.floor(pool * .85) : 0;
    const awards = [40, 25, 15, 10, 10].map((percent, index) => ranked[index] ? Math.floor(base * percent / 100) : 0).map(value => value >= 600 ? value : 0);
    const paid = awards.reduce((sum, value) => sum + value, 0);
    const awardFees = awards.filter(Boolean).length * m.awardFee;
    totals.networkFees += awardFees;
    const before = pool;
    pool = Math.max(0, pool - paid - awardFees);
    rolled = pool;
    const diff = name => totals[name] - start[name];
    seasonReports.push({ season, prizePoolAtClose: Math.round(before), distributable: base, awards, awardNetworkFees: awardFees, rolledToNextSeason: Math.round(pool), eligiblePlayers: ranked.length,
      services: diff('services'), raidsFought: diff('raidsFought'), developmentRevenue: Math.round(diff('development')), burned: Math.round(diff('burn')) });
  }
  const exposures = roster.map(exposure).sort((a, b) => a - b);
  const quantile = q => exposures[Math.min(exposures.length - 1, Math.floor(q * exposures.length))];
  const byKind = Object.fromEntries(Object.keys(kinds).map(kind => { const group = roster.filter(player => player.kind === kind);
    const mean = pickValue => Math.round(group.reduce((sum, player) => sum + pickValue(player), 0) / Math.max(1, group.length));
    return [kind, { players: group.length, servicesBought: mean(player => player.spent), networkFeesPaid: mean(player => player.fees), raidNetResult: mean(player => player.raidNet), warChestAtEnd: mean(player => player.chest.reduce((sum, value) => sum + value, 0)) }]; }));
  const round = value => Math.round(value);
  return { scenario: { players, seasons, attestors: attestors === 1 ? '1 of 1' : '2 of 3', sponsorship, adversaries: `${Math.round(dodgers * 100)}% of players start an exit whenever they lose a raid; attestors are unreachable for more than two days in ${attestorOutage * 100}% of settlements` },
    measuredFees: { raidReserveLocked: m.raidReserve, raidWinOneOutput: m.winFee(1), raidWinThreeOutputs: m.winFee(3), raidLossOrVoid: m.settleFee, withdrawalOneOutput: m.releaseFee(1), withdrawalThreeOutputs: m.releaseFee(3), servicePaymentWalletFee: m.servicePaymentFee, rewardShareReserve: PRIZE_FEED_RESERVE },
    totals: Object.fromEntries(Object.entries(totals).map(([name, value]) => [name, round(value)])),
    ratios: { serviceSplitCheck: { warChest: +(totals.warChest * 100 / totals.serviceSpend).toFixed(2), prize: +(totals.prize * 100 / totals.serviceSpend).toFixed(2), development: +((totals.development - totals.sponsorship * .3) * 100 / totals.serviceSpend).toFixed(2), burn: +(totals.burn * 100 / totals.serviceSpend).toFixed(2) },
      networkFeesPerServiceSpendPercent: +(totals.networkFees * 100 / totals.serviceSpend).toFixed(2),
      averageWinFee: totals.attackerWins ? round(totals.winFees / totals.attackerWins) : null, averageStake: totals.raidsFought ? round(totals.stakeVolume / totals.raidsFought) : null,
      winFeePercentOfStake: totals.attackerWins ? +(totals.winFees * 100 / totals.capturedSatoshis).toFixed(2) : null, averageChestOutputsPerWin: totals.attackerWins ? +(totals.chestOutputsSpentPerWin / totals.attackerWins).toFixed(2) : null,
      raidsBlockedForLackOfExposurePercent: totals.raidsAttempted ? +(totals.raidsBlockedNoExposure * 100 / totals.raidsAttempted).toFixed(1) : null,
      withdrawalFeePercent: totals.withdrawals ? +(totals.withdrawalFees * 100 / totals.withdrawnSatoshis).toFixed(2) : null,
      zeroSum: 'every satoshi a raid moves comes from one player and reaches another; the only loss is the network fee' },
    warChest: { playersWhoCanBeRaidedAtTheSmallestStake: exposures.filter(value => value >= book.raid.minimumStake).length, median: quantile(.5), ninetiethPercentile: quantile(.9), largest: exposures.at(-1) },
    byPlayerKind: byKind, seasons: seasonReports };
}

const scenarios = [];
for (const players of [20, 200, 2000]) for (const attestors of [1, 3]) for (const sponsorship of ['none', 'minimum']) scenarios.push(simulate({ players, attestors, sponsorship }));
// Sensitivity: frequent raids, and a realm in which nobody deposits (War Chests come from service shares only).
kinds.regular.raid = .6; kinds.casual.raid = .2;
scenarios.push({ label: 'frequent raids', ...simulate({ players: 200, attestors: 3, seed: 11 }) });
kinds.regular.raid = .25; kinds.casual.raid = .02; kinds.regular.deposit = 0; kinds.heavy.deposit = 0;
scenarios.push({ label: 'no direct deposits at all', ...simulate({ players: 200, attestors: 3, seed: 12 }) });
kinds.regular.services = 1; kinds.heavy.services = 2; kinds.casual.services = .3;
scenarios.push({ label: 'low activity, no deposits, no sponsor', ...simulate({ players: 20, attestors: 1, seed: 13 }) });

const report = { generatedAt: new Date().toISOString(), note: 'A model with fixed random seeds. Fees are measured contract sizes at 1 satoshi per byte; nothing here was broadcast.',
  prices: book, split: serviceSplit, playerMix: 'casual 60% (1 service a week), regular 30% (3 a week, 20,000 deposited), heavy 10% (7 a week, 100,000 deposited); attacker and defender each win half of the raids', scenarios };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
for (const item of scenarios) {
  const { scenario, totals, ratios, warChest, seasons } = item;
  console.log(`${item.label ?? ''} ${scenario.players} players, ${scenario.attestors}, sponsor ${scenario.sponsorship}: ${totals.services} services, ${totals.raidsFought} raids (${ratios.raidsBlockedForLackOfExposurePercent}% blocked), avg stake ${ratios.averageStake}, win fee ${ratios.averageWinFee} (${ratios.winFeePercentOfStake}%), ` +
    `fees/spend ${ratios.networkFeesPerServiceSpendPercent}%, dev ${totals.development}, burn ${totals.burn}, raidable ${warChest.playersWhoCanBeRaidedAtTheSmallestStake}/${scenario.players}, top prize s1 ${seasons[0].awards[0]} s4 ${seasons.at(-1).awards[0]}, escaped ${totals.exitsThatEscaped}/${totals.exitsAfterFunding}`);
}
