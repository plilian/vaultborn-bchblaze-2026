import { randomBytes } from 'node:crypto';
import { gameEvent, protocolHash } from '../../packages/chain-observer/vaultborn.mjs';
import { registerNewBattles } from './battle-records.mjs';
import { liveFees } from './kingdom.mjs';
import { territoryPayments } from './territory-protocol.mjs';
import { economy, seasonLength } from '../../config/economy.mjs';
import { GAMEPLAY_ALLOCATION, LEGACY_ALLOCATION, LEGACY_PRICING, PRICING, PRIZE_CARRIER, PRIZE_DUST_MODES, PRIZE_FEED_RESERVE, CHEST_FEED_RESERVE, CHEST_FEED_WAIT_BLOCKS, CHEST_EXIT_BLOCKS, SERVICE_ALLOCATION, SPONSOR_ALLOCATION, bchPolicy, paymentPrice, priceBook, prizeNeedsCarrier, validStake,
  sponsorshipAllocation, sponsorshipPolicy } from '../../config/payments.mjs';
import { LEGACY_SPONSOR_ALLOCATION } from '../../config/payments.mjs';
import { walletFromPublicKey } from '../../packages/chain-observer/primitives.mjs';
import { notify as tellPlayer } from '../../packages/game-engine/world.mjs';
import { PRIZE_CARRIER_V2, SWEEP_RESERVE } from '../../packages/chain-observer/prize-carrier.mjs';
import { summarizeSponsorship } from './sponsorship.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';
import { ADDRESS_PATTERN, NETWORK_ID } from '../../config/network.mjs';
import { ATTESTOR_ADJECTIVE, ATTESTOR_NOTE, ATTESTOR_OPERATION } from '../../config/network.mjs';

const fundingActions = new Map([['vault-deposit', 'personal'], ['sponsor-fund', 'sponsor'], ['war-chest', 'kingdom']]);
const payableActions = new Set(['rush', 'premium', 'attack-paid', 'protectorate', 'espionage-paid', 'political-operation', ...territoryPayments]);
// Services: a price is paid and split at once, and the game owes one action in return. If that action can no longer be
// applied when the payment is final, the player keeps the service as a credit and receives it on the next request of
// the same kind, at no cost. (Stakes are different: a raid that cannot be fought is void and its escrow returns the money.)
const serviceActions = new Set(['rush', 'premium', 'protectorate', 'espionage-paid', 'political-operation']);
// A rush is applied after 1 confirmation when its construction has little time left (see economy.rushOneConfirmationBelow),
// otherwise after the usual 2. The number is fixed at checkout and shown to the player. Its War Chest share is booked when
// the payment is final, like every other. A premium upgrade waits for the usual confirmations.
const earlyServices = new Set(['rush']);
const creditOf = (rows, type) => rows.find(item => item.action === type && item.state === 'credited' && item.fulfillment?.status === 'credit');
const politicalPayments = new Set(['political-operation','political-escrow']);
const openStates = new Set(['created', 'awaiting_signature', 'submitted', 'seen_in_mempool', 'confirming', 'confirmed', 'uncertain']);
const outpoint = ({ txid, vout }) => `${txid}:${vout}`;
const sum = (items) => items.reduce((total, item) => total + Number(item.satoshis), 0);
const payoutInputLimit = 32;
const maxUnpaidIntents = 12;
const reconcileBudget = 64;
const voidableActions = new Set(['withdraw','claim','kingdom-withdraw','dao-spend']);
const payoutOverhead = event => 140 + (event ? 56 : 0);
// A prize fund input carries its script and every co-signature, so it costs more bytes than an operator-key input.
const inputCost = source => source.fund ? 190 + 68 * (source.fund.attestors.length + 1) + 170 : 160;
const largestPayoutSources = available => available.toSorted((a,b) => b.satoshis - a.satoshis).slice(0,payoutInputLimit);
const prizeRules = Object.freeze({ percentages: Object.freeze([40,25,15,10,10]), reservePercent: 15,
  minimumPayout: 600, minimumParticipants: 2, claimWindowMs: seasonLength, rollover: true });

function sourcesFor(records, pool, player, throughSeason) {
  const known = new Map();
  const reserved = new Set();
  const includedSeason = origin => throughSeason === undefined || origin === undefined || origin <= throughSeason;
  const add = (source, originSeason) => {
    const item = pool === 'sponsor' ? { ...source, originSeason } : source;
    known.set(outpoint(source), item);
  };
  for (const row of records) {
    if (row.direction === 'outgoing') {
      if (row.rawHex || row.state === 'credited' || openStates.has(row.state) || row.state === 'reorg') {
        for (const source of row.sources ?? []) reserved.add(outpoint(source));
      }
      const ownPool = row.pool === pool && (pool !== 'personal' || row.playerId === player);
      const originSeason = row.payload?.seasonId;
      if (ownPool && includedSeason(originSeason) && row.state === 'credited') {
        if (row.receipt?.change && (!row.territoryLeaseReserve || pool==='settlement')) add(row.receipt.change, originSeason);
      }
      if (row.retainedPool === pool && row.state === 'credited' && row.receipt && (pool !== 'personal' || row.playerId === player)) add(row.receipt, originSeason);
      // A confirmed capture returns the uncaptured part of each war chest output to the same script.
      if (pool === 'kingdom' && row.state === 'credited' && row.changes && !row.fundSource) for (const change of row.changes) add({ ...change, txid: row.txid });
      // A confirmed prize award returns the unawarded part of each prize fund output to the same fund script.
      if (pool === 'sponsor' && row.state === 'credited' && row.fundSource && row.changes && includedSeason(row.payload?.seasonId)) {
        for (const change of row.changes) add({ ...change, txid: row.txid }, row.payload?.seasonId);
      }
      // A confirmed sweep turns carried shares into ordinary prize and kingdom outputs.
      if (row.state === 'credited' && row.sweepOutputs) {
        for (const output of row.sweepOutputs) {
          if ((pool === 'sponsor' && output.role === 'prize' && includedSeason(output.seasonId)) || (pool === 'kingdom' && output.role === 'kingdom')) {
            add({ ...output, txid: row.txid }, output.seasonId);
          }
        }
      }
      continue;
    }
    if (row.state !== 'credited' || !row.receipt) continue;
    const originSeason = row.seasonId ?? row.receipt.event?.data?.seasonId;
    const ownSeason = includedSeason(originSeason);
    const allocations = row.receipt.allocations ?? [];
    if (row.pool === pool && ownSeason && (pool !== 'personal' || row.playerId === player) &&
      (pool !== 'sponsor' || !allocations.some(output => output.role === 'prize'))) {
      add(allocations.find(output => output.role === 'funding') ?? row.receipt, originSeason);
    }
    for (const allocation of allocations) {
      if ((pool === 'sponsor' && ownSeason && allocation.role === 'prize' && !allocation.feeder) ||
          (pool === 'settlement' && allocation.role === 'settlement') ||
          (pool === 'development' && allocation.role === 'development' && allocation.custody !== 'external' && !row.territoryEscrow && !row.politicalProofFunding) ||
          (pool === 'kingdom' && ['kingdom','battle','warChest'].includes(allocation.role) && !allocation.cf && !row.territoryEscrow)) add(allocation, originSeason);
    }
  }
  return [...known].flatMap(([key, source]) => reserved.has(key) ? [] : [source]);
}

function payoutSources(available, satoshis, event) {
  const overhead = payoutOverhead(event);
  const sources = [];
  let balance = 0;
  for (const source of largestPayoutSources(available)) {
    sources.push(source);
    balance += source.satoshis;
    if (balance >= satoshis + overhead + sources.reduce((total, item) => total + inputCost(item), 0)) return sources;
  }
  return [];
}

export function createLedger({ store, chain, clock, quote, command, advance, notify, fail, portal, war, territory, politics,
  allocationPolicy=GAMEPLAY_ALLOCATION, prizeDust='carrier', carrierWait=10*60_000, vaultCustody='covenant', vaultRecoveryDays=7,
  kingdomCustody='covenant', kingdomRecoveryDays=7, chestRecoveryDays=3, captureAge=144, pricing=PRICING, personalVault='closed' }) {
  if (!['covenant','operator'].includes(kingdomCustody)) throw new Error('Unknown kingdom custody mode.');
  if (!['covenant','operator'].includes(vaultCustody)) throw new Error('Unknown vault custody mode.');
  if (!Number.isInteger(vaultRecoveryDays) || vaultRecoveryDays < 1 || vaultRecoveryDays > 365) throw new Error('Invalid vault recovery period.');
  if (![LEGACY_ALLOCATION,GAMEPLAY_ALLOCATION].includes(allocationPolicy)) throw new Error('Unknown gameplay allocation policy.');
  if (!PRIZE_DUST_MODES.includes(prizeDust)) throw new Error('Unknown prize dust policy.');
  let busy = false;
  const covenantVault = vaultCustody === 'covenant' && Boolean(chain.createVaultIntent);
  // New kingdom shares, stakes and at-risk funds are locked to covenants. Operator-key outputs from before stay spendable as they were.
  const covenantKingdom = kingdomCustody === 'covenant' && Boolean(chain.createStakeIntent);
  // The price book of every new checkout. Operator custody and the classic split exist only to verify old payments; they keep the earlier book.
  const pricingVersion = covenantKingdom && allocationPolicy === GAMEPLAY_ALLOCATION && chain.createRaidIntent ? pricing : LEGACY_PRICING;
  const book = priceBook(pricingVersion);
  const matchedRaids = Boolean(book.raid.matched);
  const chestTerms = ownerKey => ({ ownerKey, capturePercent: bchPolicy.capturePercent, captureAge, exitDelay: CHEST_EXIT_BLOCKS, revision: book.warChest.revision });
  const ownerKeyOf = player => store.walletKey(player)?.publicKey;
  const kingdomOf = (records, player) => { const key = ownerKeyOf(player); return key ? sourcesFor(records, 'kingdom').filter(source => source.kv?.ownerKey === key) : []; };
  const chestSum = (records, player) => sum(kingdomOf(records, player).filter(source => source.kv.capturePercent));
  // What a capture from a player's War Chest can really deliver. A capture takes at most 20% of each output it spends and
  // pays its own network fee, so an output joins only if its 20% exceeds what its input adds to the fee, and the whole
  // capture must leave a spendable payment. Outputs in their owner's exit script are left out unless `exiting` is set.
  const noCapture = { basis: 0, gross: 0, fee: 0, net: 0, sources: [], feeders: [] };
  function captureQuote(records, player, limit = Infinity, { exiting = false } = {}) {
    if (!chain.captureCost) return noCapture;
    // The earlier capture rule applies to earlier War Chest revisions only; a matched-stakes chest is captured by a matched raid and nothing else.
    const owned = kingdomOf(records, player).filter(source => source.kv.capturePercent && source.kv.revision !== 4 && (exiting || !source.kv.exiting)).toSorted((a, b) => b.satoshis - a.satoshis);
    // A capture spends up to four outputs of one War Chest script and leaves one remainder, so it also consolidates the chest.
    if (!owned.length || !(limit > 0)) return noCapture;
    const set = owned.filter(source => source.script === owned[0].script).slice(0, owned[0].kv.revision === 3 ? 4 : 12);
    const percent = set[0].kv.capturePercent;
    const one = chain.captureCost(set[0], 1);
    const step = chain.captureCost(set[0], 2) - one;
    const sources = [];
    let total = 0;
    for (const source of set) {
      if (Math.floor(total * percent / 100) >= limit) break;
      if (sources.length && Math.floor(source.satoshis * percent / 100) <= step) break;
      sources.push(source);
      total += source.satoshis;
    }
    // Shares still waiting in their feeders join the capture of a live War Chest output: 20% of them is captured too,
    // and the rest lands in the chest. Each adds only a small keyless input to the fee.
    const feeders = [];
    const ride = chain.captureCost(set[0], 1, 1) - one;
    if (!sources[0].kv.exiting && sources[0].kv.revision === 3) {
      for (const feeder of waitingChestFeeders(records, player).filter(item => item.cf.chestScript === sources[0].script).toSorted((a, b) => b.satoshis - a.satoshis)) {
        if (sources.length + feeders.length >= 4 || Math.floor(total * percent / 100) >= limit) break;
        if (Math.floor(feeder.satoshis * percent / 100) <= ride) break;
        feeders.push(feeder);
        total += feeder.satoshis;
      }
    }
    const gross = Math.min(Math.floor(total * percent / 100), limit);
    const fee = one + (sources.length - 1) * step + feeders.length * ride;
    return gross - fee < 546 ? noCapture : { basis: Math.ceil(gross * 100 / percent), gross, fee, net: gross - fee, sources, feeders };
  }
  // The accounting applies its 20% rule to this amount, so it never records a capture the chain cannot pay.
  const capturableOf = (records, player, limit, committed = Infinity) =>
    captureQuote(records, player, Math.min(limit ?? Infinity, Math.floor(committed * bchPolicy.capturePercent / 100))).basis;
  // War Chest shares still waiting in their feeders: this player's money, not yet capturable or withdrawable.
  const waitingChestFeeders = (records, player) => {
    const taken = new Set(records.filter(row => row.payload?.chestFeeders && !['rejected', 'voided', 'expired'].includes(row.state)).flatMap(row => row.payload.chestFeeders));
    return records.filter(row => row.state === 'credited' && row.direction !== 'outgoing' && (player === undefined || row.playerId === player)).flatMap(row =>
      (row.receipt?.allocations ?? []).filter(output => output.cf && !taken.has(output.txid + ':' + output.vout))
        .map(output => ({ ...output, playerId: row.playerId, height: row.receipt.height ?? 0 })));
  };
  // ---- Matched stakes ----
  // A defender's exposure is counted in confirmed outputs of the matched-stakes War Chest. One settlement can spend at most
  // three of them, so the capacity is the sum of the three largest. Every spend of a chest leaves at most one output where
  // it took several, and an owner's exit can neither shrink nor split an output, so an amount that fits this capacity when a
  // raid is funded still fits it when the raid is settled.
  const matchedChests = (records, player, { exiting = false } = {}) => kingdomOf(records, player)
    .filter(source => source.kv.revision === 4 && (exiting || !source.kv.exiting)).toSorted((a, b) => b.satoshis - a.satoshis || (outpoint(a) < outpoint(b) ? -1 : 1));
  // A settlement that is proposed but not yet signed has moved nothing: for balances and for exposure its War Chest inputs
  // are still in the chest (the raid it settles is counted as an obligation instead). Only the choice of inputs for a new
  // proposal treats them as taken, so that two proposals never name the same output.
  const unsigned = row => Boolean(row.attestation) && !row.rawHex && row.state === 'created';
  const onChain = records => records.filter(row => !unsigned(row));
  const capacityOf = (records, player, options) => sum(matchedChests(onChain(records), player, options).slice(0, chain.matchedOutputs ?? 3));
  const dead = new Set(['rejected', 'voided', 'expired']);
  const raidEntry = (world, id) => world.bchTreasury?.records.find(record => record.payment === id && ['battle', 'payment'].includes(record.kind));
  // Everything already promised from a defender's War Chest: raids quoted and not yet expired, raids paid and not yet fought,
  // and victories whose capture has not been signed yet. The same satoshi is never offered to two raids.
  // `funded` counts only raids whose stake payment exists. A checkout that was merely prepared holds its amount against
  // other attackers' quotes, but it cannot stop the defender from withdrawing: otherwise anyone could freeze a War Chest
  // by preparing raids and never paying for them.
  function raidObligations(records, world, defender, except, now = clock(), { funded = false } = {}) {
    let total = 0;
    for (const row of records) {
      if (row.action !== 'attack-paid' || row.escrow?.version !== 4 || row.id === except || row.payload?.target !== defender || row.direction === 'outgoing') continue;
      const stake = row.escrow.principal;
      if (!row.txid) { if (!funded && openStates.has(row.state) && row.expiresAt > now) total += stake; continue; }
      if (dead.has(row.state) || row.state === 'reorg') continue;
      if (row.state !== 'credited' || !row.fulfillment) { total += stake; continue; }
      const entry = raidEntry(world, row.id);
      if (entry?.stakeLane !== 'attacker-wins') continue;
      // Once the capture is signed its War Chest inputs are already set aside; once it is confirmed the chest shows what is left.
      const settlement = records.find(item => item.settles === row.id && !dead.has(item.state));
      if (!settlement?.rawHex && settlement?.state !== 'credited') total += stake;
    }
    return total;
  }
  const exposureOf = (records, world, player, except, now) => Math.max(0, capacityOf(records, player) - raidObligations(records, world, player, except, now));
  // When a paid raid is fought, what counts is what a settlement can still reach: outputs their owner has since moved into
  // the exit script included, and only the claims of raids that were really funded.
  const coverOf = (records, world, player, except, now) => Math.max(0, capacityOf(records, player, { exiting: true }) - raidObligations(records, world, player, except, now, { funded: true }));
  // The War Chest outputs one settlement spends for `stake`: largest first, live or already in their owner's exit script.
  // The output that is only partly needed comes last, because the remainder returns to its script.
  function matchedSelection(records, player, stake) {
    const picked = [];
    let held = 0;
    for (const source of matchedChests(records, player, { exiting: true })) {
      if (held >= stake || picked.length >= (chain.matchedOutputs ?? 3)) break;
      picked.push(source);
      held += source.satoshis;
    }
    return held >= stake ? picked : null;
  }
  const payoutsEnabled = chain.payoutsEnabled ?? false;
  const sponsorRules = { ...sponsorshipPolicy, minimumSatoshis: chain.sponsorshipMinimumSatoshis ?? sponsorshipPolicy.minimumSatoshis };
  const isFinancial = (row) => Boolean(row.pool || row.outputs);
  const rolePools = { development:'development', prize:'sponsor', kingdom:'kingdom', warChest:'kingdom', battle:'kingdom', settlement:'settlement' };
  const poolsOf = row => new Set([row.pool, row.retainedPool, ...(row.outputs ?? []).flatMap(output =>
    output.role === 'carrier' ? ['sponsor','kingdom'] : [rolePools[output.role]])].filter(Boolean));
  const sharedPools = ['development','settlement','kingdom'];
  // A reorganized payment pauses its payer and the pooled outputs it funded. Unrelated players keep their checkout and vault.
  function quarantine(player, records = store.payments(), pools = []) {
    const scope = player === 'council' ? [...sharedPools, ...pools] : pools;
    return records.some(row => row.state === 'reorg' && (row.playerId === player ||
      (isFinancial(row) && scope.some(pool => poolsOf(row).has(pool)))));
  }
  const toPublic = (row) => ({ ...chain.publicIntent(row), title: row.title, description: row.description, ...(row.preview && { preview: row.preview }),
    fulfillment: row.fulfillment, pool: row.pool, direction: row.direction ?? 'incoming', ...(row.appliesAfter && { appliesAfter: row.appliesAfter }),
    ...(row.politicalStatus && {politicalStatus:row.politicalStatus,politicalSettlement:row.politicalSettlement}) });

  function seasonPrize(world, records) {
    const latest = world.archive?.[0];
    const seasonId = latest?.number ?? latest?.id;
    if (!Number.isSafeInteger(seasonId)) return { status: 'awaiting-season' };
    const claimDeadline = (latest.finalizedAt ?? latest.endsAt) + prizeRules.claimWindowMs;
    const committed = records.filter(row => row.pool === 'sponsor' && row.direction === 'outgoing' && row.payload?.seasonId === seasonId &&
      // Keyless moves of reward shares into the pool, and refunds others made, are not prize payouts.
      !row.keyless && !row.external && row.action !== 'allocation-sweep' &&
      row.state !== 'voided' && row.action !== 'payout-void' && (row.rawHex || openStates.has(row.state) || row.state === 'credited'));
    const oldWindow = committed.some(row => row.payload?.policy === undefined);
    const entries = (latest.rankings ?? []).filter(entry => {
      const id = entry.playerId ?? entry.id;
      return !entry.npc && entry.score > 0 && typeof id === 'string' && (oldWindow || store.hasSeat(id));
    });
    const available = sourcesFor(records, 'sponsor', undefined, seasonId);
    const poolSatoshis = sum(available);
    const rolledSatoshis = sum(available.filter(source => source.originSeason < seasonId));
    const largest = largestPayoutSources(available);
    const spendableInOnePayout = Math.max(0, sum(largest) - payoutOverhead(chain.supportsVaultborn) - largest.reduce((total, item) => total + inputCost(item), 0));
    const fundedBase = Math.floor(poolSatoshis * (100 - prizeRules.reservePercent) / 100);
    const fundableBase = Math.floor(spendableInOnePayout * 100 / prizeRules.percentages[0]);
    const awardBase = committed.at(-1)?.payload?.prizeBase ?? Math.min(fundedBase, fundableBase);
    const status = !Number.isSafeInteger(claimDeadline) || claimDeadline <= clock() ? 'expired' :
      !oldWindow && entries.length < prizeRules.minimumParticipants ? 'rollover' : 'open';
    return { status, seasonId, claimDeadline, eligibleCount: entries.length, poolSatoshis, rolledSatoshis,
      deferredSatoshis: committed.length ? undefined : Math.max(0, fundedBase - awardBase),
      awardBase, entries, available, committed };
  }

  function guarantees(player, world, records) {
    const season = seasonPrize(world, records);
    const { status, seasonId, claimDeadline, awardBase: prizeBase } = season;
    const common = { seasonId, claimDeadline, policy: 'season-rollover-v1' };
    if (status !== 'open' || season.committed.some(row => row.playerId === player)) return { ...common, claimable: 0 };
    const position = season.entries.findIndex(entry => (entry.playerId ?? entry.id) === player);
    const percentage = prizeRules.percentages[position];
    if (!percentage) return { ...common, claimable: 0 };
    const award = Math.floor(prizeBase * percentage / 100);
    const claimable = award >= prizeRules.minimumPayout && payoutSources(season.available, award, chain.supportsVaultborn).length ? award : 0;
    return { ...common, prizeBase, claimable, rank: position + 1, resultHash: seasonResult(world, records)?.resultHash };
  }

  // The published result of the last closed season: who ranked where, with which score and wallet, what the confirmed pool
  // holds and what each rank is owed under the fixed rule. Its hash does not depend on when it is read; an attestor pins it.
  function seasonResult(world = store.read().world, records = store.payments()) {
    const season = seasonPrize(world, records);
    if (!Number.isSafeInteger(season.seasonId) || !season.entries) return null;
    const archived = world.archive?.[0];
    const rankings = season.entries.map((entry, index) => { const id = entry.playerId ?? entry.id;
      return { rank: index + 1, playerId: id, score: entry.score, wallet: store.wallet(id)?.address ?? null }; });
    // The result commits to the season's score journal, so every award signed against it is bound to that exact evidence.
    const journal = world.scoreChain?.[season.seasonId];
    const body = { version: 2, seasonId: season.seasonId, endedAt: archived?.finalizedAt ?? archived?.endsAt ?? null, rules: { percentages: prizeRules.percentages,
      reservePercent: prizeRules.reservePercent, minimumPayout: prizeRules.minimumPayout, minimumParticipants: prizeRules.minimumParticipants }, rankings,
      evidence: journal ? { journalEntries: journal.count, journalHead: journal.head } : null };
    // The terms of every prize fund output of this season are public. With them an attestor can find the money on chain,
    // rebuild the contracts and pay the winners without this server (scripts/attestor-payout.mjs).
    // (A proposal that is not signed yet has moved nothing, so the outputs it names are still listed.)
    const funds = [...new Map(sourcesFor(onChain(records), 'sponsor', undefined, season.seasonId).filter(source => source.fund).map(source => [source.script, { script: source.script, fund: source.fund }])).values()];
    return { ...body, resultHash: protocolHash(body), status: season.status, claimDeadline: season.claimDeadline, poolSatoshis: season.poolSatoshis, prizeBase: season.awardBase, awardsCommitted: season.committed.length, funds,
      entitlements: rankings.slice(0, prizeRules.percentages.length).map(item => ({ ...item, satoshis: Math.floor(season.awardBase * prizeRules.percentages[item.rank - 1] / 100) })) };
  }

  // Season prizes are paid without anyone asking. After a season closes, each ranked winner with a verified wallet gets an
  // award proposal, in rank order, one at a time. The attestors sign; the developer does nothing.
  async function autoAward() {
    if (!payoutsEnabled || !covenantKingdom) return;
    const records = store.payments();
    if (records.some(row => row.direction === 'outgoing' && row.action === 'claim' && openStates.has(row.state))) return;
    const { world } = store.read();
    const season = seasonPrize(world, records);
    if (season.status !== 'open') return;
    for (const entry of season.entries.slice(0, prizeRules.percentages.length)) {
      const id = entry.playerId ?? entry.id;
      const address = store.wallet(id)?.address;
      if (!address || !(guarantees(id, world, records).claimable > 0)) continue;
      try { await payout(id, { kind: 'claim', address, consent: true }); return; } catch { /* this winner cannot be paid yet; try the next */ }
    }
  }

  // What a paid raid can really win and lose, read from confirmed War Chest outputs. Shown before the player pays.
  // Everything a player is shown before paying for a raid, and everything the checkout then enforces. `stake` is the
  // attacker's chosen S; without it the smallest stake is quoted.
  function raidTerms(world, player, target, stake, now = clock()) {
    if (!matchedRaids) return legacyRaidTerms(world, player, target, stake, now);
    const { raid } = book;
    const chosen = stake ?? raid.minimumStake;
    const records = store.payments();
    const attacker = store.walletKey(player);
    const defender = store.walletKey(target);
    const exposure = defender && world.cities[target]?.optIn ? exposureOf(records, world, target, undefined, now) : 0;
    const pair = [player, target].sort().join(':');
    const fought = world.bchTreasury?.records.find(record => record.kind === 'battle-limit' && record.pair === pair && record.now > now - 24 * 3_600_000);
    const open = records.some(row => row.action === 'attack-paid' && row.escrow?.version === 4 && row.direction !== 'outgoing' && !dead.has(row.state) &&
      [row.playerId, row.payload?.target].sort().join(':') === pair && (row.txid ? !row.fulfillment : openStates.has(row.state) && row.expiresAt > now));
    const reason = !attacker ? 'Connect your wallet first: your stake is locked to it.' :
      !world.cities[player]?.optIn ? 'Join seasonal PvP before staking BCH on a raid.' :
      !defender || !world.cities[target] || world.cities[target].npc ? 'This opponent has not connected a wallet, so there is no War Chest to match your stake.' :
      !world.cities[target].optIn ? 'This opponent has not joined seasonal PvP.' :
      attacker.address === defender.address ? 'Both kingdoms use the same wallet.' :
      world.cities[player].alliance && world.cities[player].alliance === world.cities[target].alliance ? 'Allies cannot stake BCH against each other.' :
      !chain.prizeAttestors?.length ? 'Paid raids are closed for now.' :
      !validStake(chosen, pricingVersion) ? `Choose a stake from ${raid.minimumStake} to ${raid.maximumStake} satoshis in steps of ${raid.step}.` :
      fought ? 'These two kingdoms already fought a paid raid in the last 24 hours.' :
      open ? 'A paid raid between these two kingdoms is still being prepared or settled.' :
      exposure < chosen ? (exposure >= raid.minimumStake ? `This opponent can cover at most ${exposure} satoshis.` : 'This opponent\'s War Chest cannot cover the smallest stake. A paid raid needs a defender with the same amount at risk.') : null;
    const terms = attacker && defender && attacker.address !== defender.address && chain.prizeAttestors?.length && validStake(chosen, pricingVersion) ?
      chain.raidQuote({ stake: chosen, ownerKey: attacker.publicKey, opponent: defender.address, defenderKey: defender.publicKey }) : null;
    const outputs = terms ? Math.max(1, matchedSelection(records, target, chosen)?.length ?? 1) : 1;
    const winFee = terms ? terms.winBase + outputs * terms.winPerInput : null;
    const back = terms && terms.reserve - terms.settleFee >= 546 ? terms.reserve - terms.settleFee : 0;
    const ceiling = Math.min(raid.maximumStake, Math.floor(exposure / raid.step) * raid.step);
    return { matched: true, eligible: !reason, reason, stakeSatoshis: chosen, defenderExposureSatoshis: chosen, defenderCapturableSatoshis: exposure,
      minimumStakeSatoshis: raid.minimumStake, maximumStakeSatoshis: ceiling >= raid.minimumStake ? ceiling : 0, stakeStepSatoshis: raid.step,
      suggestedStakes: raid.suggested.filter(value => value <= ceiling),
      networkReserveSatoshis: terms?.reserve ?? null, totalPaymentSatoshis: terms ? chosen + terms.reserve : null,
      // What each outcome costs in network fees and what reaches the attacker's wallet from the settlement transaction.
      win: terms && { feeSatoshis: winFee, receiveSatoshis: 2 * chosen + terms.reserve - winFee, netSatoshis: chosen - winFee, warChestOutputs: outputs },
      loss: terms && { feeSatoshis: terms.reserve - back, receiveSatoshis: back, netSatoshis: -chosen - (terms.reserve - back), defenderReceivesSatoshis: chosen },
      void: terms && { feeSatoshis: terms.settleFee, receiveSatoshis: chosen + terms.reserve - terms.settleFee, netSatoshis: -terms.settleFee },
      maxWinSatoshis: chosen, maxLossSatoshis: chosen, opponentWarChestSatoshis: exposure, pairCooldownHours: 24, exitBlocks: CHEST_EXIT_BLOCKS,
      attestors: chain.prizeAttestors?.length ?? 0, attestorThreshold: chain.attestorThreshold ?? null, contested: !reason, pricing: pricingVersion };
  }
  function legacyRaidTerms(world, player, target, price = paymentPrice('attack-paid', liveFees.attack, allocationPolicy), now = clock()) {
    const stake = price - bchPolicy.settlementReserve;
    const rivalWallet = store.wallet(target)?.address;
    const contested = Boolean(rivalWallet && rivalWallet !== store.wallet(player)?.address && world.cities[player]?.optIn && world.cities[target]?.optIn);
    const records = store.payments();
    const atRisk = war.balance(world, target, now).atRiskSatoshis;
    const quote = contested ? captureQuote(records, target, Math.min(stake, Math.floor(atRisk * bchPolicy.capturePercent / 100))) : noCapture;
    // The opponent's capturable War Chest is shown whole; the capture itself is capped at the stake.
    const chest = contested ? Math.min(captureQuote(records, target).basis, atRisk) : 0;
    const share = quote.net;
    return { stakeSatoshis: stake, networkReserveSatoshis: bchPolicy.settlementReserve, opponentWarChestSatoshis: chest,
      captureSatoshis: quote.gross, captureFeeSatoshis: quote.fee,
      maxWinSatoshis: share, maxLossSatoshis: contested ? Math.floor(stake * bchPolicy.defenderForfeitPercent / 100) : 0,
      capturePercent: bchPolicy.capturePercent, pairCooldownHours: 24, contested };
  }
  const raidOutlook = (world, player, target, price, now) => covenantKingdom && war && store.hasSeat(target) && target !== player ?
    raidTerms(world, player, target, price, now) : null;
  function balances(player) {
    const all = store.payments();
    const { world } = store.read();
    const eligible = guarantees(player, world, all);
    const treasury = war?.balance(world, player, clock()) ?? {};
    const released = new Set(all.filter(row => row.territoryAnchor && row.state === 'credited').flatMap(row =>
      row.sources?.map(source => source.txid) ?? []));
    const lockedSatoshis = all.filter(row => row.playerId === player &&
      (((row.action === 'attack-paid' || territoryPayments.has(row.action)) && row.txid && openStates.has(row.state)) ||
      (row.territoryEscrow && row.state === 'credited' && !released.has(row.txid))))
      .reduce((total, row) => total + (row.outputs?.find(output => output.role === 'battle')?.satoshis ?? 0), 0);
    const waiting = covenantKingdom ? waitingChestFeeders(all, player) : [];
    const chests = covenantKingdom ? kingdomOf(onChain(all), player).filter(source => source.kv.capturePercent) : [];
    return { warChestSatoshis: covenantKingdom ? sum(chests) : null,
      // Shares still in their feeders, the size at which they join the War Chest, and what a capture could take from today.
      pendingChestSatoshis: covenantKingdom ? waiting.reduce((total, item) => total + item.chestSatoshis, 0) : null,
      chestThresholdSatoshis: waiting[0]?.cf.threshold ?? null,
      exitingChestSatoshis: covenantKingdom ? sum(chests.filter(source => source.kv.exiting)) : null,
      // A player's own view counts only raids that were really funded. A raid that is merely being prepared against this
      // player is not shown here: seeing it would let the defender withdraw before the attacker's payment arrives.
      capturableSatoshis: !covenantKingdom ? null : matchedRaids ? Math.max(0, capacityOf(all, player) - raidObligations(all, world, player, undefined, clock(), { funded: true })) : Math.min(captureQuote(all, player).basis, treasury.atRiskSatoshis ?? 0),
      // Matched stakes: what open raids have already claimed, and what an earlier War Chest revision still holds (withdrawable, not raidable).
      ...(matchedRaids && { reservedSatoshis: raidObligations(all, world, player, undefined, clock(), { funded: true }), earlierChestSatoshis: sum(chests.filter(source => source.kv.revision !== 4)),
        minimumStakeSatoshis: book.raid.minimumStake, minimumDepositSatoshis: book.warChest.minimumDeposit, depositStepSatoshis: book.warChest.step }),
      depositedSatoshis: sum(sourcesFor(all, 'personal', player)), sponsoredSatoshis: sum(sourcesFor(all, 'sponsor', player)),
      claimableSatoshis: eligible.claimable, claimDeadline: eligible.claimDeadline, sponsorshipPolicy: sponsorRules,
      atRiskSatoshis: 0, walletSatoshis: null, ...treasury, lockedSatoshis,
      // Services paid for and not yet received (the action they were bought for ended while the payment confirmed).
      serviceCredits: Object.fromEntries([...serviceActions].map(type => [type, all.filter(item => item.playerId === player && item.action === type && item.state === 'credited' && item.fulfillment?.status === 'credit').length]).filter(([, count]) => count)),
      quarantined: quarantine(player, all), payoutsEnabled };
  }

  function create(player, body, territoryContext) {
    if (!chain.enabled) fail(503, '' + NETWORK_LABEL + ' payment creation needs a configured treasury and observer. Free actions are available.');
    if (quarantine(player)) fail(409, '' + NETWORK_LABEL + ' actions are paused for settlement reconciliation.');
    const row = store.transaction(() => {
      const { world } = store.read();
      const now = clock();
      advance(world, now);
      const type = body.type ?? body.action;
      const funding = fundingActions.get(type);
      let campaign;
      let payment;
      let vaultOwner;
      let sponsorWallet;
      let chestOwner;
      if (funding && typeof funding === 'string') {
        if (type === 'sponsor-fund' && body.campaignId !== undefined) {
          if (typeof body.campaignId !== 'string') fail(400, 'Choose a sponsorship campaign.');
          campaign = portal.campaignFunding(player, body.campaignId);
        }
        const satoshis = campaign?.amount ?? body.satoshis;
        if (!Number.isSafeInteger(satoshis) || satoshis < 1_000 || satoshis > (funding === 'personal' ? 250_000 : sponsorRules.maximumSatoshis)) fail(400, 'Choose a valid ' + NETWORK_LABEL + ' amount.');
        if (body.consent !== true) fail(400, 'Confirm the ' + NETWORK_LABEL + ' payment terms first.');
        // One player treasury: the War Chest. A separate protected vault is no longer opened; an existing one can be withdrawn or recovered as before.
        if (funding === 'personal' && personalVault !== 'open') fail(410, 'The separate personal vault is closed to new deposits. There is one player treasury, the War Chest, and all of it is at risk in PvP. An existing vault deposit can still be withdrawn.');
        if (funding === 'personal' && balances(player).depositedSatoshis + satoshis > 1_000_000) fail(409, 'Personal ' + NETWORK_LABEL + ' vault limit reached.');
        if (funding === 'personal' && covenantVault) {
          vaultOwner = store.walletKey(player);
          if (!vaultOwner) fail(403, 'Connect your wallet first. A vault deposit can only be paid back to that wallet.');
        }
        if (type === 'war-chest') {
          if (!covenantKingdom) fail(409, 'War chests are available with covenant custody only.');
          chestOwner = store.walletKey(player);
          if (!chestOwner) fail(403, 'Connect your wallet first. A War Chest can only pay back to that wallet.');
          if (!chain.prizeAttestors?.length) fail(503, 'War Chests are closed for now.');
          if (!world.cities[player]?.optIn) fail(409, 'Join seasonal PvP before putting funds at risk.');
          if (matchedRaids) {
            // One deposit is one War Chest output. It must cover the smallest stake on its own, and it sits on the 1,000-satoshi grid of stakes.
            const { minimumDeposit, step } = book.warChest;
            if (satoshis < minimumDeposit || satoshis % step) fail(400, `Deposit at least ${minimumDeposit} satoshis, in multiples of ${step}: the smallest raid stake is ${book.raid.minimumStake}, and a War Chest that cannot cover a stake is never at risk.`);
          } else {
            // A deposit must be large enough to be captured, or it would sit in the War Chest without ever being at risk.
            const floor = chain.captureFloor?.(chain.chestOf(chestTerms(chestOwner.publicKey)));
            if (floor && satoshis < floor) fail(400, `Deposit at least ${floor} satoshis: a smaller War Chest output could not be captured or withdrawn economically.`);
          }
          if ((war?.balance(world, player, now).atRiskSatoshis ?? 0) + satoshis > war.riskLimit) fail(409, 'At most 250,000 satoshis can be at risk.');
        }
        if (type === 'sponsor-fund') {
          if (campaign && (campaign.policy ?? LEGACY_SPONSOR_ALLOCATION) !== SPONSOR_ALLOCATION) {
            fail(409, 'This sponsorship was quoted under the previous prices. Propose it again to fund it under the current 30/70 terms.');
          }
          if (!chain.createSponsorIntent || !chain.sponsorDevelopmentAddress || !chain.prizeAttestors?.length) {
            fail(503, 'Sponsorship is closed until the developer address and a prize attestor are configured.');
          }
          sponsorWallet = store.walletKey(player);
          if (!sponsorWallet) fail(403, 'Connect your wallet first. An unawarded prize contribution can only return to that wallet.');
        }
        payment = { satoshis, title: funding === 'personal' ? 'Vault deposit' : type === 'war-chest' ? 'War chest funding' : 'Sponsor funding',
          description: type === 'war-chest' ? (matchedRaids ?
            'All of it is at risk in PvP. Lose a raid and the attacker takes their stake; win and you take theirs. You can always take it out with your wallet (about 2 days).' :
            `At risk in PvP: a lost battle can cost up to ${bchPolicy.capturePercent}% of a War Chest output. The rest stays yours.`) :
            funding === 'personal' ? (vaultOwner ? 'Locked to your vault. Only your wallet can get it back. Not at risk in PvP.' : 'Not at risk in PvP.') :
            '30% to Development, 70% to the season prize pool. Any part not awarded returns to your wallet.',
          action: { type, ...(campaign && { campaignId: campaign.id }) } };
      } else if (politicalPayments.has(type)) {
        if (!politics || !payoutsEnabled || !chain.supportsVaultborn) fail(503,'Political checkout requires the ' + NETWORK_LABEL + ' settlement operator.');
        payment=politics.quote(world,player,{...body,type},now);
      } else if (territoryPayments.has(type)) {
        if (!territory || !chain.supportsVaultborn || !payoutsEnabled) fail(503,'Territory checkout needs a ready ' + NETWORK_LABEL + ' escrow operator.');
        payment = territory.quote(world,player,{...body,type},now,territoryContext);
      } else {
        if (!payableActions.has(type)) fail(400, 'This action has no ' + NETWORK_LABEL + ' payment route.');
        if (type === 'espionage-paid') {
          const action = { type, mission: body.mission, target: body.target };
          command(structuredClone(world), player, { ...action, type: 'scout' }, now);
          payment = { action, title: 'Paid intelligence dispatch',
            description: 'Sends one intelligence mission.' };
        } else {
          payment = quote(world, player, { ...body, type }, now);
        }
        if (chain.supportsVaultborn) {
          const price = type === 'attack-paid' ? 'attack' : type === 'espionage-paid' ? 'espionage' : type;
          payment.satoshis = liveFees[price];
          if (matchedRaids && type === 'attack-paid') payment.action = { ...payment.action, stake: body.stake ?? book.raid.minimumStake };
          if (type === 'attack-paid') payment.description = 'One raid with a BCH stake.';
        }
      }
      const sameSubject = item => (!territoryPayments.has(type) || item.payload?.territory === payment.action.territory) &&
        (!politicalPayments.has(type) || (item.payload?.treaty ?? item.payload?.conflict) === (payment.action.treaty ?? payment.action.conflict)) &&
        (type !== 'sponsor-fund' || item.payload?.campaignId === payment.action.campaignId);
      if (chain.supportsVaultborn && !funding && type!=='political-escrow') payment.satoshis=paymentPrice(type,payment.satoshis,allocationPolicy,pricingVersion);
      const existing = store.payments(player).find(item => item.action === type && sameSubject(item) &&
        (openStates.has(item.state) || type==='political-escrow' && item.state==='credited' && item.politicalStatus==='funded') &&
        (item.txid || item.expiresAt > now));
      if (existing && !existing.txid && !funding && type !== 'political-escrow' && (existing.event?.data.pricing ?? LEGACY_PRICING) !== pricingVersion) {
        // Quoted under an earlier price book and never paid: it lapses, and the checkout is prepared again at today's terms.
        store.savePayment({ ...existing, state: 'expired', lastError: 'Prices changed after this checkout was prepared. Prepare it again.' });
      } else if (existing && type === 'attack-paid' && matchedRaids && !existing.txid && existing.payload?.stake !== payment.action.stake) {
        store.savePayment({ ...existing, state: 'expired', lastError: 'Replaced by a checkout with a different stake.' });
      } else if (existing) {
        const originalPolicy=existing.event?.data.allocationPolicy??LEGACY_ALLOCATION;
        if (JSON.stringify(existing.payload) !== JSON.stringify(payment.action) ||
            ((funding || type==='political-escrow' || originalPolicy===allocationPolicy) && existing.satoshis!==payment.satoshis)) {
          fail(409, 'Resolve the existing payment for this action in the ' + NETWORK_LABEL + ' journal before preparing a different one.');
        }
        return existing;
      }
      // A service this player already paid for and did not receive is delivered now, without a new payment. The credit
      // and the game action change in this one database transaction, so a repeated request cannot use it twice.
      const owed = serviceActions.has(type) ? creditOf(store.payments(player), type) : null;
      if (owed) {
        const redeemed = { ...owed, payload: payment.action };
        const outcome = type === 'political-operation' ? politics.acceptOperation(world, redeemed, now) :
          command(world, player, type === 'espionage-paid' ? { ...payment.action, type: 'scout' } : payment.action, now, { paid: true });
        // A political operation publishes its proof from the record reserve its own payment locked; that output is still unspent.
        if (type === 'political-operation') redeemed.politicalProofFunding = true;
        store.write(world);
        redeemed.fulfillment = { status: 'applied', result: outcome ?? null, redeemedCredit: { at: now, reason: owed.fulfillment.reason } };
        store.savePayment(redeemed);
        return redeemed;
      }
      const unpaid = store.payments(player).filter(item => item.direction !== 'outgoing' && !item.txid &&
        openStates.has(item.state) && item.expiresAt > now).length;
      if (unpaid >= maxUnpaidIntents) fail(429, 'Finish or let your open ' + NETWORK_LABEL + ' checkouts expire before preparing another.');
      const payerKey = covenantKingdom && chain.supportsVaultborn && !funding && type !== 'political-escrow' ? store.walletKey(player) : null;
      if (covenantKingdom && chain.supportsVaultborn && !funding && type !== 'political-escrow' && !payerKey) {
        fail(403, 'Connect your wallet first. Your kingdom share and stakes are locked to that wallet, not to the game.');
      }
      if (type === 'attack-paid' && !store.hasSeat(payment.action.target)) {
        fail(409, 'A paid raid requires a registered opponent. Choose a free expedition for NPC combat.');
      }
      let raidPreview;
      if (type === 'attack-paid' && payerKey && war && matchedRaids) {
        // Matched stakes. The raid is sold only when the defender's confirmed, unclaimed War Chest covers the attacker's whole stake.
        raidPreview = raidTerms(world, player, payment.action.target, payment.action.stake, now);
        if (!raidPreview.eligible) {
          throw Object.assign(new Error(raidPreview.reason + ' A free raid is available without a BCH stake.'), { status: 409, preview: raidPreview });
        }
        payment.satoshis = raidPreview.totalPaymentSatoshis;
        const { stakeSatoshis: stake, win, loss } = raidPreview;
        payment.description = `You stake ${stake} sats and their War Chest matches it. Win: ${win.receiveSatoshis} sats come to your wallet. ` +
          `Lose: they get your stake and ${loss.receiveSatoshis} sats come back to you. ` +
          `If their War Chest no longer covers your stake when your payment confirms, the raid has no BCH outcome: your stake and reserve return, less a ${raidPreview.void.feeSatoshis}-sat fee.`;
      } else if (type === 'attack-paid' && payerKey && war) {
        // The earlier rules, kept for the earlier price book only.
        raidPreview = raidTerms(world, player, payment.action.target, payment.satoshis, now);
        const { stakeSatoshis: stake, opponentWarChestSatoshis: chest, maxWinSatoshis: maxWin, contested: contest } = raidPreview;
        if (maxWin === 0) {
          throw Object.assign(new Error('This opponent has no capturable War Chest BCH, so a paid raid cannot win any. Choose a free raid.'),
            { status: 409, preview: raidPreview });
        }
        payment.description = `You stake ${stake} sats. Win: about ${maxWin} sats come to your wallet. ` +
          (contest ? `Lose: ${raidPreview.maxLossSatoshis} sats of your stake go to the defender.` : 'Lose: your stake comes back.');
      }
      const recordReserve = type === 'political-operation' && book.reserves.record && chain.recordReserve ? book.reserves.record : 0;
      if (chain.developmentAddress && (type === 'political-operation' && !recordReserve ||
          allocationPolicy === LEGACY_ALLOCATION && (type === 'attack-paid' || territoryPayments.has(type)))) {
        fail(503, 'This checkout needs an operator-accessible network reserve under its current rules. Choose a free operation or a supported escrow policy.');
      }
      const seasonId = campaign?.seasonId ?? world.season.number;
      if (type==='political-escrow') {
        const intent={...chain.createPoliticalEscrowIntent({...payment,playerId:player,payload:payment.action,now}),
          title:payment.title,description:payment.description,politicalStatus:'awaiting-funding',seasonId};
        store.savePayment(intent);
        return intent;
      }
      let allocation;
      let carried = false;
      let final = false;
      let directChest = false;
      let intentPolicy = allocationPolicy;
      if (type === 'sponsor-fund') {
        if (!chain.supportsVaultborn) fail(503, 'Sponsorship checkout requires confirmed split outputs.');
        try { allocation = sponsorshipAllocation(payment.satoshis, sponsorRules.minimumSatoshis); }
        catch (error) { fail(400, error.message); }
        intentPolicy = SPONSOR_ALLOCATION;
      } else if (chain.supportsVaultborn && !funding) {
        // A sweep needs the signer and a treasury-held fee output. Without them the payment keeps the disclosed dust floor.
        // With an external developer address the sweep fee can only come from the settlement reserve, so one must exist.
        carried = prizeDust === 'carrier' && payoutsEnabled && Boolean(chain.signCarrierSweep) && prizeNeedsCarrier(payment.satoshis,type,allocationPolicy) &&
          (!chain.developmentAddress || sourcesFor(store.payments(), 'settlement').length > 0);
        // Final service economy: 50% War Chest, 20% season pool, 20% Development, 10% burned, each paid by the payer's own transaction.
        final = Boolean(payerKey && war && !territoryPayments.has(type) && type !== 'attack-paid');
        if (final) {
          if (!chain.developmentAddress || !chain.prizeAttestors?.length || !chain.feedSweep || !chain.chestFeed) {
            fail(503, 'Paid services are closed for now. Free play is not affected.');
          }
          intentPolicy = SERVICE_ALLOCATION;
          carried = false;
          // Under the current price book every War Chest share is a whole stake unit and goes straight into the War Chest: no feeder, no reserve, no later move.
          const floor = matchedRaids ? 0 : chain.captureFloor(chain.chestOf(chestTerms(payerKey.publicKey)));
          directChest = payment.satoshis / 2 >= floor;
          // The split itself is listed with the outputs, in the details of the checkout.
          payment.description = (payment.description ? payment.description + ' ' : '') + 'Half goes into your War Chest.' +
            (recordReserve ? ` ${recordReserve} sats pay only for this operation's public proof record; if no record is published, your own wallet key takes it back.` : '');
        }
        try { allocation = type === 'attack-paid' && matchedRaids ? { battle: raidPreview.stakeSatoshis, settlement: raidPreview.networkReserveSatoshis } :
          war?.split(payment.satoshis,type,final ? SERVICE_ALLOCATION : allocationPolicy,{carrier:carried,pricing:pricingVersion}); }
        catch (error) { fail(error.status ?? 400, error.message); }
      }
      // How many confirmations a rush waits for: 1 when its construction has less than an hour left, otherwise the usual.
      let appliesAfter;
      if (type === 'rush') {
        const job = world.cities[player]?.queue?.find(item => item.kind === 'building' && item.key === payment.action.building);
        appliesAfter = job && job.completesAt - now < economy.rushOneConfirmationBelow ? 1 : chain.minConfirmations ?? 2;
        payment.description = (payment.description ? payment.description + ' ' : '') + 'Applied after ' + appliesAfter + ' confirmation' +
          (appliesAfter === 1 ? '' : 's') + ', about ' + appliesAfter * 10 + ' minutes.';
      }
      const nonce=type==='political-operation' ? randomBytes(24).toString('hex') : undefined;
      const event = chain.supportsVaultborn ? { seasonId, actionHash: protocolHash({ player, action: payment.action, ...(nonce && {nonce}) }),
        allocation: allocation ?? null, ...(allocation && intentPolicy!==LEGACY_ALLOCATION && {allocationPolicy:intentPolicy}),
        // The price book this checkout was quoted under. It is part of the on-chain record, so the payment is always verified and settled by its own terms.
        ...(pricingVersion !== LEGACY_PRICING && type !== 'sponsor-fund' && { pricing: pricingVersion }), ...(recordReserve && { recordReserve }),
        // Every payment anchors the season's score journal: its record output commits to the journal's length and head.
        ...(world.scoreChain?.[seasonId] && { journal: { n: world.scoreChain[seasonId].count, head: world.scoreChain[seasonId].head } }),
        ...(carried && {dust:PRIZE_CARRIER}), ...(final && {feedReserve:PRIZE_FEED_RESERVE,...(!directChest && {chestReserve:CHEST_FEED_RESERVE})}),
        ...(territoryPayments.has(type) && { territory:payment.action.territory,
          ...(payment.action.round && {round:payment.action.round}) }) } : undefined;
      const closesAt = Math.floor(world.season.endsAt / 1000);
      const seconds = Math.floor(now / 1000);
      const staked = payerKey && (type === 'attack-paid' || territoryPayments.has(type)) && Object.hasOwn(allocation ?? {}, 'settlement');
      // A raid or territory attack stake is paid into an escrow that can only pay the attacker or the defender it names.
      // A raffle entry can only return to its entrant. An open claim keeps at least half for its claimant.
      const defender = type === 'attack-paid' ? payment.action.target : type === 'territory-attack' ? payment.action.expectedOwner : null;
      const rival = staked && defender && !world.cities[defender]?.npc ? store.wallet(defender)?.address : null;
      const raffle = type === 'territory-raffle';
      // A contested stake is settled by the independent outcome panel. Without an attestor the game key would decide alone, so it is not sold.
      if (staked && (rival || type === 'territory-claim') && !chain.prizeAttestors?.length) {
        fail(503, 'Paid raids and territory contests are closed for now. Free play is not affected.');
      }
      const intent = { ...(staked && type === 'attack-paid' && matchedRaids ? chain.createRaidIntent({ playerId: player, payload: payment.action, stake: raidPreview.stakeSatoshis,
        ownerKey: payerKey.publicKey, opponent: rival, defenderKey: store.walletKey(defender).publicKey, event, refundAt: seconds + book.raid.refundDays * 86_400, now }) :
        staked ? chain.createStakeIntent({ playerId: player, action: type, payload: payment.action, satoshis: payment.satoshis, allocation, event,
        ownerKey: payerKey.publicKey, opponent: rival && rival !== store.wallet(player)?.address ? rival : undefined, claim: type === 'territory-claim',
        closesAt: seconds + (raffle ? 8 : 1) * 3600, refundAt: seconds + (territoryPayments.has(type) ? 7 : 3) * 86_400, now }) :
        chestOwner ? chain.createChestIntent({ playerId: player, payload: payment.action, satoshis: payment.satoshis, ...chestTerms(chestOwner.publicKey),
          ...(matchedRaids && { minimum: book.warChest.minimumDeposit }), event, now }) :
        sponsorWallet ? chain.createSponsorIntent({ playerId: player, payload: payment.action, satoshis: payment.satoshis, allocation, event,
        sponsorKey: sponsorWallet.publicKey, closesAt, refundAt: closesAt + Math.floor(2 * seasonLength / 1000) + 86_400, now }) :
        vaultOwner ? chain.createVaultIntent({ playerId: player, payload: payment.action, satoshis: payment.satoshis,
        ownerKey: vaultOwner.publicKey, recoverAt: Math.floor(now / 1000) + vaultRecoveryDays * 86_400, event, now }) :
        chain.createIntent({ playerId: player, action: type, payload: payment.action,
        satoshis: payment.satoshis, now, allocation, event,
        ...(final && { chestOwner: chestTerms(payerKey.publicKey),
          chestFeed: { reserve: CHEST_FEED_RESERVE, wait: CHEST_FEED_WAIT_BLOCKS },
          prizeFeed: { seasonId, closesAt, reserve: PRIZE_FEED_RESERVE }, ...(recordReserve && { recordReserve }) }) })),
        ...(final && { reserveSatoshis: PRIZE_FEED_RESERVE + (directChest ? 0 : CHEST_FEED_RESERVE) + recordReserve }), ...(raidPreview && { preview: raidPreview }), title: payment.title, description: payment.description,
        pool: funding, seasonId, ...(nonce && {politicalNonce:nonce}), ...(appliesAfter && { appliesAfter }) };
      store.savePayment(intent);
      return intent;
    });
    notify();
    return toPublic(row);
  }

  // A player hears about their own payment in the notification centre: once when the network has it, and once when it
  // is final. Inside the observation's database transaction, so a notice and its state change are saved together.
  const SEEN = new Set(['seen_in_mempool', 'confirming', 'confirmed']);
  function paymentNotice(before, row) {
    // A stake settlement (returned, split or won) is told to the player who paid the stake, once, when it is final.
    if (row.settles && row.payload?.payer && row.txid && row.state === 'credited' && before.state !== 'credited' && !row.doneNoticed) {
      const { world } = store.read();
      if (!world.cities?.[row.payload.payer]) return;
      tellPlayer(world, row.payload.payer, row.title + '.', clock(), 'receipt', { title: row.title, payment: row.id });
      row.doneNoticed = true;
      store.write(world);
      return;
    }
    if (row.direction === 'outgoing' || !row.txid || !row.playerId) return;
    const sent = SEEN.has(row.state) && !SEEN.has(before.state) && before.state !== 'credited' && !row.sentNoticed;
    const done = row.state === 'credited' && before.state !== 'credited' && !row.doneNoticed;
    if (!sent && !done) return;
    const { world } = store.read();
    if (!world.cities?.[row.playerId]) return;
    const now = clock();
    const needed = row.appliesAfter ?? chain.minConfirmations ?? 2;
    const name = row.title ?? String(row.action).replaceAll('-', ' ');
    const amount = Number(row.satoshis ?? 0).toLocaleString('en-US') + ' sats';
    if (sent) {
      const wait = ' after ' + needed + ' confirmation' + (needed === 1 ? '' : 's') + ', usually about ' + needed * 10 + ' minutes.';
      tellPlayer(world, row.playerId, row.action === 'war-chest' ? 'War Chest deposit of ' + amount + ' sent. It joins your War Chest' + wait :
        row.fulfillment?.early ? name + ': ' + amount + ' sent. Applied.' :
        row.action === 'territory-raffle' ? 'Raffle entry of ' + amount + ' sent. It counts' + wait :
        name + ': ' + amount + ' sent. It is applied' + wait, now, 'receipt', { title: row.action === 'territory-raffle' ? 'Raffle entry sent' : 'Payment sent', payment: row.id });
      row.sentNoticed = true;
    }
    if (done) {
      // What happens to the money when the action could not be applied: a service is kept as a credit, a stake comes back.
      const reason = row.fulfillment?.reason ?? '';
      const outcome = row.fulfillment?.status === 'credit' ? ' ' + reason + (/free/.test(reason) ? '' : ' You keep it as a credit: your next one is free.') :
        row.fulfillment?.status === 'review' ? ' ' + reason + (row.escrow ? ' It could not be applied, so your stake is returned to your wallet.' : '') : '';
      tellPlayer(world, row.playerId, (row.action === 'war-chest' ? 'War Chest funded: +' + amount + '. All of it is at risk in PvP.' : 'Payment confirmed: ' + name + ' (' + amount + ').') + outcome,
        now, 'receipt', { title: row.action === 'war-chest' ? 'War Chest funded' : 'Payment confirmed', payment: row.id });
      row.doneNoticed = true;
    }
    store.write(world);
  }

  function applyObservation(old, observed, options = {}) {
    const result = store.transaction(() => {
      const current = store.payment(old.id);
      if (!current || current.txid !== old.txid || current.state !== old.state) return current;
      const row = { ...current, ...observed };
      // A concurrent observation of the deposit cannot undo its confirmed settlement.
      if (current.action === 'political-escrow') {
        row.politicalStatus = current.politicalStatus;
        row.politicalLane = current.politicalLane;
        row.politicalSettlement = current.politicalSettlement;
      }
      if (row.txid && row.txid !== current.txid) {
        const otherIntent = store.byTxid(row.txid);
        if (otherIntent && otherIntent !== row.id) {
          const rejected = { ...current, state: 'rejected', lastError: 'This ' + NETWORK_LABEL + ' transaction already belongs to another intent.' };
          store.savePayment(rejected);
          return rejected;
        }
      }
      if (territory && row.action === 'territory-attack' && !row.attackAnnounced && !row.late && row.receipt &&
          ['seen_in_mempool','confirming'].includes(row.state)) {
        const { world } = store.read();
        if (territory.announceAttack(world,row,clock())) store.write(world);
        row.attackAnnounced = true;
      }
      if (earlyServices.has(row.action) && row.appliesAfter && !row.fulfillment && !row.late && row.receipt && row.state === 'confirming' &&
          (row.receipt.confirmations ?? 0) >= row.appliesAfter) {
        const now = clock();
        const { world } = store.read();
        try {
          advance(world, now);
          const outcome = command(world, row.playerId, row.payload, now, { paid:true });
          store.write(world);
          row.fulfillment = { status:'applied', result:outcome ?? null, early:true };
        } catch (error) {
          // Left to the final settlement, which owes the service as a credit if it still cannot be applied then.
          if (!(error.status || error.statusCode || error.code)) throw error;
        }
      }
      if (row.state === 'confirmed') {
        if (row.fulfillment?.early) {
          // Applied when it was seen; now that the payment is final, its War Chest share is booked.
          const { early, ...fulfillment } = row.fulfillment;
          if (row.receipt?.allocations && war) {
            try {
              const { world } = store.read();
              war.apply(world, row, fulfillment.result, clock(), id => store.wallet(id)?.address);
              store.write(world);
            } catch (fault) {
              if (!options.finalizeUnexpected) throw fault;
              fulfillment.bookingFault = 'The War Chest share of this payment must be reviewed by the operator.';
            }
          }
          row.fulfillment = fulfillment;
        }
        if (row.action === 'sponsor-fund' && [SPONSOR_ALLOCATION, LEGACY_SPONSOR_ALLOCATION].includes(row.event?.data?.allocationPolicy)) {
          const outputs = row.receipt?.allocations;
          const matches = outputs?.length === current.outputs.length && current.outputs.every(expected =>
            outputs.some(actual => actual.role === expected.role && actual.script === expected.script && actual.satoshis === expected.satoshis));
          if (!matches) {
            const rejected = { ...row, state: 'rejected', receipt: null, lastError: 'The sponsorship allocation was not verified.' };
            store.savePayment(rejected);
            return rejected;
          }
        }
        if (row.voidFor && !row.fulfillment) {
          const original = store.payment(row.voidFor);
          if (original && original.state !== 'credited') {
            store.savePayment({ ...original, state:'voided', voidedBy:row.txid,
              lastError:'Cancelled by a confirmed replacement that returned its inputs to the treasury.' });
            if (original.action === 'kingdom-withdraw' && war?.restore) {
              const { world } = store.read();
              war.restore(world, original.playerId, original.id, row.feeSatoshis ?? 0, clock());
              store.write(world);
            }
          }
          row.fulfillment = { status:'applied', result:{ voided:row.voidFor } };
        }
        if (politics && row.action==='political-escrow' && !row.fulfillment) {
          const {world}=store.read();
          const funded=politics.fund(world,row,clock());
          row.politicalStatus='funded';
          row.politicalLane=funded.lane;
          row.fulfillment={status:'applied',result:{treaty:row.payload.treaty,message:funded.lane==='release' ?
            'Principal confirmed. Release awaits its on-chain receipt.' : 'Terms changed or funding arrived late. The principal has been queued for refund.'}};
          store.write(world);
        }
        if (politics && row.politicalFunding && !row.fulfillment) {
          const {world}=store.read();
          const outcome=politics.credit(world,row,clock());
          store.write(world);
          row.fulfillment={status:'applied',result:outcome};
        }
        if (politics && row.politicalAnchor && !row.fulfillment) {
          row.fulfillment={status:'applied',result:{record:row.politicalAnchor,txid:row.txid}};
        }
        if (row.territoryAnchor && territory && !row.fulfillment) {
          const { world } = store.read();
          const credit = territory.credit(world,row,clock());
          if (credit) store.write(world);
          row.fulfillment = { status:'applied', result:credit };
        }
        if (row.action === 'chest-capture' && row.payload?.ridingReserveSatoshis > 0 && !row.reserveBooked && war?.fundChest && store.wallet(row.payload.defender)?.address) {
          // Waiting shares that joined this capture brought their reserves into the defender's War Chest. The account follows the chain.
          const { world } = store.read();
          war.fundChest(world, row.payload.defender, row.payload.ridingReserveSatoshis, row.id + ':reserve', clock(), store.wallet(row.payload.defender).address);
          store.write(world);
          row.reserveBooked = true;
        }
        if (row.action === 'chest-consolidation' && !row.fulfillment && war?.fundChest) {
          // The unused part of the payers' own reserves arrived in the War Chest with the shares. The account follows the chain.
          const extra = row.satoshis - (row.shareSatoshis ?? row.satoshis);
          if (extra > 0 && store.wallet(row.playerId)?.address) {
            const { world } = store.read();
            war.fundChest(world, row.playerId, extra, row.id, clock(), store.wallet(row.playerId).address);
            store.write(world);
          }
          row.fulfillment = { status: 'applied', result: { warChestSatoshis: row.satoshis, reserveKeptSatoshis: Math.max(0, extra) } };
        }
        if (row.action === 'war-chest' && !row.fulfillment && war?.fundChest) {
          const { world } = store.read();
          const entry = war.fundChest(world, row.playerId, row.satoshis, row.id, clock(), store.wallet(row.playerId)?.address);
          store.write(world);
          row.fulfillment = { status: 'applied', result: { atRiskSatoshis: entry.committed } };
        }
        if (!row.fulfillment && payableActions.has(row.action)) {
          const now = clock();
          let { world } = store.read();
          const previousBattle = world.battles[0]?.id;
          const split = row.receipt?.allocations;
          try {
            if (row.late) fail(409, serviceActions.has(row.action) ? 'This checkout expired before the payment was seen. The service is owed to you: your next request of this kind is free.' : 'This checkout expired before the payment was seen.');
            advance(world, now);
            const action = row.action === 'espionage-paid' ? { ...row.payload, type: 'scout' } : row.payload;
            const expanded = territoryPayments.has(row.action);
            const outcome = expanded ? territory.accept(world,row,now) : row.action==='political-operation' ?
              politics.acceptOperation(world,row,now) : command(world,row.playerId,action,now,{paid:true,payment:split ? row : undefined});
            if (expanded) {
              if (row.action === 'territory-attack') territory.registerAttack(world,row,outcome,previousBattle,now,covenantKingdom ? (id, limit, committed) => capturableOf(store.payments(), id, limit, committed) : undefined);
              row.territoryEscrow = true;
            } else if (split) war?.apply(world, row, outcome, now, id => store.wallet(id)?.address, !covenantKingdom ? undefined :
              // A matched raid asks one thing: does the defender's War Chest still cover the stake, apart from what other raids have claimed?
              row.escrow?.version === 4 ? id => coverOf(store.payments(), world, id, row.id, now) :
              (id, limit, committed) => capturableOf(store.payments(), id, limit, committed));
            if (row.action==='political-operation') row.politicalProofFunding=true;
            const paidBattle = expanded ? outcome?.battle?.id ?? outcome?.battleId ?? (outcome?.events ? outcome.id : undefined) : outcome?.id;
            registerNewBattles(store, world, previousBattle, paidBattle, row, now);
            store.write(world);
            row.fulfillment = { status: 'applied', result: outcome ?? null };
          } catch (error) {
            const expected = Boolean(error.status || error.statusCode || error.code);
            // An unexpected fault is retried. After repeated faults the reconciler finalizes it for operator review.
            if (!expected && !options.finalizeUnexpected) throw error;
            let recovery;
            if (split && war) {
              // Discard partially applied commands. The unburned owner share stays withdrawable.
              try {
                world = store.read().world;
                const restored = war.apply(world, row, null, now);
                if (restored?.escrowSatoshis > 0) recovery = { pool:'kingdom', satoshis:restored.escrowSatoshis,
                  reserveSatoshis:split.find(output => output.role==='settlement')?.satoshis ?? 0 };
                store.write(world);
              } catch (fault) {
                // A receipt that cannot be accounted for stays out of the kingdom ledger and waits for the operator.
                if (!options.finalizeUnexpected) throw fault;
              }
            }
            const reason = expected ? error.message : 'An internal fault stopped this action. The operator must review it.';
            // A paid service is never lost: what could not be applied is owed, and is delivered by the next request of the same kind.
            row.fulfillment = serviceActions.has(row.action) ?
              { status: 'credit', reason, credit: { action: row.action, grantedAt: now }, ...(!expected && { fault: true }), ...(recovery && { recovery }) } :
              { status: 'review', reason, ...(recovery && { recovery }) };
          }
        }
        row.state = 'credited';
      }
      paymentNotice(current, row);
      if (JSON.stringify(row) !== JSON.stringify(current)) store.savePayment(row);
      return row;
    });
    if (result && JSON.stringify(result) !== JSON.stringify(old)) notify();
    return result;
  }

  async function submit(player, id, given) {
    if (typeof given !== 'string' || !/^[a-f0-9]{64}$/i.test(given.trim())) fail(400, 'This wallet returned an invalid ' + NETWORK_LABEL + ' transaction ID.');
    const txid = given.trim().toLowerCase();
    const row = store.transaction(() => {
      const intent = store.payment(id);
      if (!intent || intent.playerId !== player || intent.direction === 'outgoing') fail(404, 'Payment intent unavailable.');
      if (intent.txid === txid) return intent;
      if (intent.txid && !['rejected', 'expired'].includes(intent.state)) fail(409, 'A transaction is already attached to this intent.');
      const previous = store.byTxid(txid);
      if (previous && previous !== intent.id) fail(409, 'This transaction already belongs to another intent.');
      const updated = { ...intent, ...chain.submit(intent, txid, clock()) };
      store.savePayment(updated);
      return updated;
    });
    return toPublic(applyObservation(row, await chain.observe(row, clock())) ?? row);
  }

  function planPayout(player, body) {
    if (!payoutsEnabled) fail(503, 'The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    const { kind, address } = body;
    if (quarantine(player, undefined, kind === 'claim' ? ['sponsor'] : kind === 'kingdom-withdraw' ? ['kingdom'] : [])) {
      fail(409, '' + NETWORK_LABEL + ' payouts are paused for settlement reconciliation.');
    }
    if (!['withdraw', 'claim', 'kingdom-withdraw'].includes(kind) || typeof address !== 'string') fail(400, 'Supply a valid ' + NETWORK_LABEL + ' payout address.');
    const records = store.payments();
    if (records.some(item => item.direction === 'outgoing' && item.playerId === player && openStates.has(item.state))) fail(409, 'You already have a pending payout.');
    const pool = kind === 'withdraw' ? 'personal' : kind === 'claim' ? 'sponsor' : 'kingdom';
    const eligible = kind === 'claim' ? guarantees(player, store.read().world, records) : {};
    const satoshis = kind === 'claim' ? eligible.claimable : body.satoshis;
    if (!Number.isSafeInteger(satoshis) || satoshis < 600) fail(400, 'There is no eligible payout of 600 satoshis or more.');
    if (['kingdom-withdraw','claim'].includes(kind) && store.wallet(player)?.address !== address) {
      fail(403, 'Use the verified ' + NETWORK_LABEL + ' wallet for this kingdom.');
    }
    const pending = pool === 'kingdom' ? pendingAnchorTxids(records) : new Set();
    const available = sourcesFor(records, pool, player, eligible.seasonId).filter(source => !pending.has(source.txid));
    const event = chain.supportsVaultborn ? gameEvent(kind, player, { satoshis, address, seasonId: eligible.seasonId ?? null,
      // The award record commits to the season, the rank and the published result it follows, so every signature on the award covers them.
      ...(kind === 'claim' && { policy: eligible.policy, prizeBase: eligible.prizeBase, rank: eligible.rank, resultHash: eligible.resultHash }) }) : undefined;
    // Operator-held deposits from before the covenant are paid first. A covenant deposit pays its owner's wallet only.
    const legacy = available.filter(source => !source.vault && !source.fund && !source.kv);
    // A kingdom's own covenant outputs: plain vault outputs first, war chest outputs only for what is no longer at risk.
    const kingdomKey = kind === 'kingdom-withdraw' ? ownerKeyOf(player) : null;
    // Outputs of one revision are spent together: earlier revisions first, so old balances drain into the wallet before the matched-stakes chest is touched.
    const owned = kingdomKey ? available.filter(source => source.kv?.ownerKey === kingdomKey)
      .toSorted((a, b) => ((a.kv.revision ?? 2) - (b.kv.revision ?? 2)) || (a.kv.capturePercent - b.kv.capturePercent) || b.satoshis - a.satoshis) : [];
    const mine = owned.filter(source => (source.kv.revision ?? 2) >= 4 === ((owned[0].kv.revision ?? 2) >= 4) && (source.kv.revision !== 4 || source.script === owned.find(item => item.kv.revision === 4).script));
    const funds = kind === 'claim' ? available.filter(source => source.fund && source.fund.closesAt * 1000 <= clock()).toSorted((a, b) => b.satoshis - a.satoshis) : [];
    const vaults = available.filter(source => source.vault).toSorted((a, b) => b.satoshis - a.satoshis);
    let payment;
    if (kind === 'withdraw' && vaults.length && !payoutSources(legacy, satoshis, event).length) {
      const mine = vaults.filter(source => source.vault.ownerAddress === address);
      if (!mine.length) fail(403, 'A vault deposit can only return to the wallet verified when it was made: ' + vaults[0].vault.ownerAddress);
      const source = mine.find(item => item.satoshis >= satoshis + item.vault.maxFee) ?? mine[0];
      try { payment = { ...chain.prepareVaultPayout({ playerId: player, action: kind, payload: eligible, source, satoshis, event, now: clock() }), pool }; }
      catch (error) { fail(409, error.message + ' Each withdrawal spends one deposit; the largest holds ' + mine[0].satoshis + ' satoshis.'); }
    } else if (mine.length && !payoutSources(legacy, satoshis, event).length) {
      let failure;
      // The matched-stakes War Chest: the amount asked for is exactly what leaves the chest; the wallet receives it less the network fee.
      const matched = mine[0].kv.revision === 4;
      const step = book.warChest.step;
      if (matched && satoshis % step) fail(400, `Withdraw a multiple of ${step} satoshis: the War Chest keeps whole thousands so that a raid can always be matched to the satoshi.`);
      const limit = matched ? chain.matchedOutputs ?? 3 : 24;
      for (let count = 1; count <= Math.min(limit, mine.length) && !payment; count += 1) {
        try { payment = { ...chain.prepareKingdomPayout({ playerId: player, action: kind, payload: eligible, sources: mine.slice(0, count), ...(matched ? { leaving: satoshis } : { satoshis }), event, now: clock() }), pool }; }
        catch (error) { failure = error; }
      }
      if (!payment) fail(409, failure.message + ' Your War Chest is held in ' + mine.length + ' output(s); one withdrawal spends at most ' + limit + ' of them (' + sum(mine.slice(0, limit)) + ' satoshis). Withdraw in parts.');
    } else if (funds.length && !payoutSources(legacy, satoshis, event).length) {
      // One award spends prize fund outputs that share one attestor set, so every signer covers every input.
      // Every fund output gives the same proportion of the award, so no contribution is drained ahead of the others.
      const sources = funds.filter(source => source.fund.attestors.join() === funds[0].fund.attestors.join());
      try { payment = { ...chain.preparePrizeAward({ playerId: player, action: kind, payload: eligible, sources, satoshis, address, event, now: clock() }), pool }; }
      catch (error) { fail(409, error.message); }
    } else payment = buildPayout({ playerId: player, action: kind, payload: eligible, satoshis, address, pool, event, available: legacy });
    if (kind === 'kingdom-withdraw' && payment.kvSource) {
      if (payment.sources.some(source => source.kv.revision === 4)) {
        // Matched stakes: what open raids have claimed from this War Chest stays in it. Only the rest can be withdrawn.
        const owed = raidObligations(records, store.read().world, player, undefined, clock(), { funded: true });
        const spent = new Set(payment.sources.map(outpoint));
        const after = [...matchedChests(onChain(records), player).filter(source => !spent.has(outpoint(source))), ...(payment.change ? [payment.change] : [])]
          .toSorted((a, b) => b.satoshis - a.satoshis).slice(0, chain.matchedOutputs ?? 3);
        if (owed > sum(after)) fail(409, `${owed} satoshis of your War Chest are matched against paid raids that are not settled yet. Withdraw less, or wait for them to be settled.`);
      } else {
        // An earlier War Chest revision cannot be emptied while a paid raid against it is still being settled.
        const contested = records.some(row => row.action === 'attack-paid' && row.escrow?.version !== 4 && row.payload?.target === player && row.escrow && row.state === 'credited' &&
          !records.some(item => item.settles === row.id && item.state === 'credited')) ||
          records.some(row => row.capturesFor && row.payload?.defender === player && openStates.has(row.state));
        if (contested) fail(409, 'A paid raid against you is still being settled. Your War Chest can be withdrawn once it is.');
      }
    }
    if (kind === 'kingdom-withdraw') war?.canWithdraw(store.read().world, player, payment.satoshis + payment.feeSatoshis, clock(), { chest: Boolean(payment.kvSource) });
    return { ...payment,
      title: kind === 'withdraw' ? 'Withdrawal of an earlier vault deposit' : kind === 'claim' ? 'Season reward' : 'War Chest withdrawal',
      description: payment.kvSource ? 'The game key signs. The War Chest contract only lets this money reach your verified wallet; what is not withdrawn stays in your War Chest. Exactly the amount you asked for leaves the chest, and your wallet receives it less the network fee.' :
        payment.fundSource ? 'Paid from the Seasonal Prize Fund covenant. It is sent once every ' + ATTESTOR_ADJECTIVE + ' prize attestor has co-signed it.' :
        payment.vaultSource ? 'The game key co-signs. The vault contract only lets this transfer reach your verified wallet.' :
        'The game key signs the confirmed outputs for this ' + NETWORK_LABEL + ' transfer.' };
  }

  function buildPayout({ available, pool, ...params }) {
    const { satoshis, event } = params;
    const sources = payoutSources(available, satoshis, event);
    if (!sources.length) fail(409, 'Confirmed treasury funds do not cover the amount and network fee.');
    try {
      return { ...chain.preparePayout({ ...params, sources, now:clock() }), pool };
    } catch (error) { fail(400, error.message); }
  }

  function quotePayout(player, body) {
    const {address,satoshis,feeSatoshis} = planPayout(player, body);
    return {address,satoshis,feeSatoshis,kind:body.kind};
  }

  async function payout(player, body) {
    if (body.consent !== true) fail(400, 'Confirm the payout.');
    const row = store.transaction(() => {
      const payment = planPayout(player, body);
      if ((body.expectedFee !== undefined && body.expectedFee !== payment.feeSatoshis) ||
          (body.expectedSatoshis !== undefined && body.expectedSatoshis !== payment.satoshis)) fail(409, 'The payout or network fee changed. Review a new quote.');
      // A prize fund award is stored unsigned. It becomes a transaction only through attestAward.
      const signed = payment.fundSource ? {} : payment.kvSource ? chain.signKingdomPayout(payment) : payment.vaultSource ? chain.signVaultPayout(payment) : chain.signPayout(payment);
      const intent = { ...payment, ...signed, state: payment.fundSource ? 'created' : 'submitted' };
      if (payment.action === 'kingdom-withdraw') {
        const { world } = store.read();
        war.debit(world, player, payment.satoshis + payment.feeSatoshis, payment.id, clock(), { chest: Boolean(payment.kvSource) });
        store.write(world);
      }
      store.savePayment(intent);
      return intent;
    });
    if (row.rawHex) await chain.broadcast(row.rawHex).catch(() => undefined);
    notify();
    return toPublic(row);
  }

  // Everything an attestor needs to check an award independently before signing it. Nothing here is secret.
  function pendingAwards() {
    const { world } = store.read();
    return store.payments().filter(row => row.attestation && !row.rawHex && row.state === 'created').map(row => {
      if (row.attestation.version === 'matched-raid-v1') {
        // A matched raid settlement: the escrow alone (void or defender victory), or the escrow together with the defender's War Chest.
        return { id: row.id, kind: 'raid', payment: row.settles, ...row.payload, lane: row.lane, stakeSatoshis: row.payload.stakeSatoshis,
          payerWallet: store.wallet(row.payload.payer)?.address ?? null, defenderWallet: store.wallet(row.payload.defender)?.address ?? null,
          sources: row.sources, outputs: row.layout, feeSatoshis: row.feeSatoshis, eventScript: row.eventOutput?.script ?? null, digests: row.attestation.digests,
          attestors: row.attestation.attestors, threshold: row.attestation.threshold, signed: Object.keys(row.attestation.signatures), expiresAt: row.expiresAt };
      }
      if (row.settles) {
        // A stake settlement waiting for its outcome panel.
        return { id: row.id, kind: 'stake', payment: row.settles, ...row.payload, lane: row.lane, payeeScript: row.payeeScript ?? null,
          payerWallet: store.wallet(row.payload.payer)?.address ?? null, defenderWallet: row.payload.defender ? store.wallet(row.payload.defender)?.address ?? null : null,
          victorWallet: row.payload.victor ? store.wallet(row.payload.victor)?.address ?? null : null,
          sources: row.sources, outputs: row.layout, eventScript: row.eventOutput?.script ?? null, digests: row.attestation.digests,
          attestors: row.attestation.attestors, threshold: row.attestation.threshold, signed: Object.keys(row.attestation.signatures), expiresAt: row.expiresAt };
      }
      if (row.capturesFor) {
        return { id: row.id, kind: 'capture', payment: row.capturesFor, ...row.payload, satoshis: row.captureSatoshis, address: row.captureAddress, script: row.captureScript,
          verifiedWallet: store.wallet(row.payload.attacker)?.address ?? null, feeSatoshis: row.feeSatoshis, capturePercent: bchPolicy.capturePercent,
          sources: row.sources, feeders: row.feeders ?? [], outputs: row.layout, eventScript: row.eventOutput?.script ?? null, digests: row.attestation.digests,
          attestors: row.attestation.attestors, threshold: row.attestation.threshold ?? row.attestation.attestors.length, signed: Object.keys(row.attestation.signatures), expiresAt: row.expiresAt };
      }
      const season = world.archive?.find(item => (item.number ?? item.id) === row.payload?.seasonId);
      const ranked = (season?.rankings ?? []).filter(entry => !entry.npc && entry.score > 0);
      const rank = ranked.findIndex(entry => (entry.playerId ?? entry.id) === row.playerId);
      return { id: row.id, playerId: row.playerId, seasonId: row.payload?.seasonId, rank: rank + 1, score: ranked[rank]?.score ?? null,
        prizeBase: row.payload?.prizeBase, resultHash: row.payload?.resultHash ?? null, percentages: prizeRules.percentages, satoshis: row.satoshis, address: row.address, script: row.script,
        verifiedWallet: store.wallet(row.playerId)?.address ?? null, feeSatoshis: row.feeSatoshis,
        sources: row.sources.map(({ txid, vout, satoshis, script, fund }) => ({ txid, vout, satoshis, script, fund })),
        outputs: row.layout, eventScript: row.eventOutput?.script ?? null,
        locktime: row.attestation.locktime, digests: row.attestation.digests, attestors: row.attestation.attestors,
        threshold: row.attestation.threshold ?? row.attestation.attestors.length, signed: Object.keys(row.attestation.signatures), expiresAt: row.expiresAt };
    });
  }

  // What an attestor needs to check a proposal itself: the recorded battles and, for territory, the contest record.
  // A battle record is public only a day after the battle, so the caller proves it holds an attestor key of this proposal.
  function evidence(id, body) {
    const row = store.payment(id);
    if (!row?.attestation) fail(404, 'No proposal under this ID.');
    if (!row.attestation.attestors.includes(String(body?.publicKey).toLowerCase()) || !chain.attestorRequest?.(id, body?.publicKey, body?.signature)) fail(403, 'Evidence is given to the attestors of this proposal.');
    const { world } = store.read();
    const origin = store.payment(row.settles ?? row.capturesFor ?? '') ?? null;
    const records = store.portalRows('battle');
    const started = origin ? records.filter(({ record }) => record.initiation?.txid === origin.txid) : [];
    const contest = origin && territoryPayments.has(origin.action) ? territory?.settlementOf(world, origin.id) : null;
    // A claim the game could not enter: the payment is final, yet no contest entry exists for it.
    const notEntered = Boolean(origin && origin.action === 'territory-claim' && origin.state === 'credited' && origin.fulfillment &&
      !contest && !world.territoryPayments?.[origin.id]);
    const linked = (contest?.record.battles ?? []).map(item => store.portal('battle', item.id ?? item)).filter(Boolean);
    const named = row.payload?.battle ? [store.portal('battle', row.payload.battle)].filter(Boolean) : [];
    const battles = [...new Map([...started, ...named, ...linked].map(item => [item.record.battle.id, { record: item.record, recordHash: item.recordHash }])).values()];
    const accounting = origin ? (world.bchTreasury?.records ?? []).find(entry => entry.payment === origin.id && ['battle', 'payment'].includes(entry.kind)) ?? null : null;
    return { proposal: id, payment: origin && { id: origin.id, txid: origin.txid, action: origin.action, playerId: origin.playerId, target: origin.payload?.target ?? null }, battles,
      contest: contest ? { record: contest.record, victor: contest.victor } : null,
      ...(notEntered && { notEntered: { reason: origin.fulfillment.reason ?? null } }),
      accounting: accounting && { winner: accounting.winner, effect: accounting.effect, stakeLane: accounting.stakeLane ?? null, contest: accounting.contest ?? null, capturedSatoshis: accounting.capturedSatoshis ?? 0 } };
  }

  // Confirmed payments whose on-chain record commits to the score journal of `season`.
  const anchors = season => store.payments().filter(row => row.direction !== 'outgoing' && row.state === 'credited' && row.event?.data?.journal && row.event.data.seasonId === season)
    .map(row => ({ txid: row.txid, action: row.action, eventDigest: row.event.digest, n: row.event.data.journal.n, head: row.event.data.journal.head, confirmations: row.receipt?.confirmations ?? 0 }));

  async function attestAward(id, body) {
    const row = store.transaction(() => {
      const current = store.payment(id);
      if (!current?.attestation || current.rawHex || current.state !== 'created') fail(404, 'No award is waiting for attestation under this ID.');
      if (current.expiresAt <= clock()) fail(409, 'This award proposal has expired. The player can claim again.');
      if (!current.capturesFor && !current.settles && quarantine(current.playerId, undefined, ['sponsor'])) fail(409, 'Prize payouts are paused for settlement reconciliation.');
      let next;
      try { next = chain.attestPrizeAward(current, body?.publicKey, body?.signatures); }
      catch (error) { fail(400, error.message); }
      store.savePayment(next);
      return next;
    });
    if (row.rawHex) await chain.broadcast(row.rawHex).catch(() => undefined);
    notify();
    return toPublic(row);
  }

  function daoPlan(proposalId) {
    if (!payoutsEnabled || !chain.supportsVaultborn || quarantine('council')) fail(409, 'Treasury signing is currently unavailable.');
    const proposal = portal.approvedSpend(proposalId);
    const event = gameEvent('dao-spend', proposal.id, { title: proposal.title, satoshis: proposal.satoshis, address: proposal.address });
    const records = store.payments();
    const pendingAnchors = pendingAnchorTxids(records);
    const available = sourcesFor(records, 'development').filter(source => !pendingAnchors.has(source.txid));
    return buildPayout({ playerId: 'council', action: 'dao-spend', payload: { proposalId }, satoshis: proposal.satoshis,
      address: proposal.address, pool: 'development', event, available });
  }

  function daoQuote(proposalId) {
    const { address, satoshis, feeSatoshis } = daoPlan(proposalId);
    return { address, satoshis, feeSatoshis };
  }

  async function daoSpend(body) {
    if (body.consent !== true) fail(400, 'Confirm the quoted council transfer.');
    const row = store.transaction(() => {
      const payment = daoPlan(body.id);
      if (body.expectedFee !== payment.feeSatoshis || body.expectedSatoshis !== payment.satoshis) {
        fail(409, 'The network fee or amount changed. Review a new quote.');
      }
      const intent = { ...payment, ...chain.signPayout(payment), title: 'Council-approved treasury transfer', state: 'submitted' };
      store.savePayment(intent);
      return intent;
    });
    await chain.broadcast(row.rawHex).catch(() => undefined);
    notify();
    return toPublic(row);
  }

  async function anchorBattle() {
    if (!chain.supportsVaultborn || !payoutsEnabled || quarantine('council')) return;
    const signed = store.transaction(() => {
      const records = store.payments();
      const pending = store.portalRows('battle').reverse().find(({ record, event }) =>
        record.initiation && record.initiation.event?.kind !== 'territory-attack' && !records.some(row => row.anchorFor === event.subject) &&
        !records.some(row => row.txid === record.initiation.txid && row.escrow));
      if (!pending) return;
      const originatingTxid = pending.record.initiation.txid;
      const originating=records.find(item=>item.txid===originatingTxid);
      const separate=originating?.event?.data.allocationPolicy===GAMEPLAY_ALLOCATION;
      const feeInput=separate ? originating.receipt?.allocations.find(item=>item.role==='settlement') :
        sourcesFor(records,'development').find(item=>item.txid===originatingTxid);
      const escrow = sourcesFor(records, 'kingdom').find(item => item.txid === originatingTxid && item.role === 'battle');
      // Settle the exact raid stake. Old intents fund the fee from their committed development output.
      if (!escrow || !feeInput || feeInput.satoshis < (separate?516:1062)) return;
      const intent = chain.preparePayout({ playerId: 'council', action: 'battle-settlement', payload: {},
        sources: [escrow,feeInput], satoshis: escrow.satoshis, event: pending.event, retain: true, now: clock() });
      const row = { ...intent, ...chain.signPayout(intent), anchorFor: pending.event.subject,
        retainedPool: 'kingdom', title: 'Battle escrow settlement', pool:separate?'settlement':'development', state: 'submitted' };
      store.savePayment(row);
      return row;
    });
    if (signed) {
      await chain.broadcast(signed.rawHex).catch(() => undefined);
      notify();
    }
  }

  // Stake escrows settle themselves: the lane follows the recorded battle, and the script fixes where each lane can pay.
  async function settleStakes() {
    if (!payoutsEnabled || !chain.signStakeSettlement) return;
    const signed = store.transaction(() => {
      const records = store.payments();
      const settled = new Set(records.filter(row => row.settles && !['rejected', 'voided', 'expired'].includes(row.state)).map(row => row.settles));
      const now = clock();
      const { world } = store.read();
      // A matched victory names the defender's War Chest outputs. If their owner moved them into the exit script first, the
      // proposal can never confirm: it lapses here and is proposed again against the outputs where they are now.
      for (const row of records) {
        if (row.attestation?.version !== 'matched-raid-v1' || row.lane !== 'attacker-wins' || dead.has(row.state) || row.state === 'credited') continue;
        const live = new Set(sourcesFor(records.filter(other => other.id !== row.id), 'kingdom').map(outpoint));
        if (row.sources.slice(0, -1).every(source => live.has(outpoint(source)))) continue;
        store.savePayment({ ...row, state: row.rawHex ? 'rejected' : 'expired', lastError: 'The War Chest outputs of this settlement moved before it confirmed. It is proposed again against their new place.' });
        settled.delete(row.settles);
      }
      for (const row of records) {
        if (!row.escrow || row.state !== 'credited' || settled.has(row.id) || quarantine(row.playerId, records)) continue;
        const source = row.receipt?.allocations?.find(output => output.role === 'escrow');
        if (!source) continue;
        let lane;
        let payee;
        let chests;
        const contest = territoryPayments.has(row.action) ? territory?.settlementOf(world, row.id) : null;
        if (row.escrow.kind === 'territory-claim') {
          // The contest record decides: a claimant who lost to another claimant forfeits half to that winner's wallet.
          // A final payment whose claim the game could not enter (no contest entry exists for it) returns whole to the claimant.
          if (!contest && (!row.fulfillment || world.territoryPayments?.[row.id])) continue;
          payee = contest?.victor && contest.victor !== row.playerId ? store.wallet(contest.victor)?.address : null;
          lane = payee ? 'forfeit' : 'return';
        } else if (row.escrow.version === 4) {
          // Matched raid. The accounting recorded who won and whether the defender's exposure was there; the lane follows it.
          const entry = raidEntry(world, row.id);
          if (!entry && !['review', 'failed', 'credit'].includes(row.fulfillment?.status)) continue;
          lane = entry?.stakeLane ?? 'void';
          if (lane === 'attacker-wins') {
            chests = matchedSelection(store.payments(), row.payload.target, row.escrow.principal);
            if (!chests) {
              // The defender's outputs are in flight (a withdrawal or another capture is confirming): wait for what returns.
              const moving = store.payments().some(item => item.direction === 'outgoing' && openStates.has(item.state) && (item.sources ?? []).some(input => input.kv?.ownerKey === ownerKeyOf(row.payload.target)));
              if (moving) continue;
              // Nothing left to capture: the defender's exit completed before the attestors signed. The stake returns instead.
              war.voidCapture?.(world, row.id, now);
              store.write(world);
              lane = 'void';
            }
          }
        } else if (row.escrow.kind === 'territory-uncontested') {
          // The return lane needs no key. It opens one hour after funding; two more hours cover the network's median time.
          if (row.escrow.closesAt + 7200 > now / 1000) continue;
          lane = 'return';
        } else {
          const entry = world.bchTreasury?.records.find(record => record.payment === row.id && ['battle', 'payment'].includes(record.kind));
          if (!entry && !['review', 'failed', 'credit'].includes(row.fulfillment?.status)) continue;
          lane = entry?.stakeLane ?? 'return';
        }
        const battle = contest ? null : store.portalRows('battle').find(({ record }) => record.initiation?.txid === row.txid);
        const event = contest?.event ?? battle?.event ?? gameEvent('stake-settlement', row.id, { lane, txid: row.txid });
        let settlement;
        try {
          settlement = chain.signStakeSettlement({ source, lane, event, payee, ...(chests && { chests }), ...(contest && { action: contest.eventKind }),
            payload: { payment: row.id, lane, payer: row.playerId, escrowKind: row.escrow.kind, ...(battle && { battle: battle.event.subject }),
            ...(row.escrow.version === 4 && { stakeSatoshis: row.escrow.principal, ...(chests && { attacker: row.playerId, chestOutputs: chests.length }) }),
            ...(row.action === 'attack-paid' && { defender: row.payload?.target }),
            ...(contest && { territory: contest.record.territoryId, record: contest.record.id, victor: contest.victor, battles: contest.record.battles?.map(item => item.id ?? item) ?? [] }) }, now });
        }
        catch (error) { console.error('Stake settlement:', error.message); continue; }
        const result = { ...settlement, settles: row.id, pool: 'escrow', ...(battle && { anchorFor: battle.event.subject }),
          ...(contest && { territoryAnchor: contest.record.id, territoryBattles: contest.record.battles?.map(item => item.id ?? item) ?? [] }),
          title: lane === 'attacker-wins' ? 'Raid won: both stakes paid to the attacker' : lane === 'defender-wins' ? 'Raid lost: the stake paid to the defender' :
            lane === 'opponent-wins' ? 'Stake split with the defender' : lane === 'forfeit' ? 'Claim stake split with the contest winner' : 'Stake returned to its owner',
          description: lane === 'attacker-wins' ? 'One transaction spent the attacker\'s escrow and the defender\'s War Chest: the attacker received both stakes and the unused reserve, and the rest of the War Chest returned to it.' :
            'The stake escrow paid the only destinations its script allows for this outcome.' };
        store.savePayment(result);
        return result;
      }
    });
    // A version 3 settlement is a proposal: it is sent once the outcome panel has signed it.
    if (signed?.rawHex) await chain.broadcast(signed.rawHex).catch(() => undefined);
    if (signed) notify();
  }

  // A capture moves the amount the battle rules awarded from the loser's war chest to the winner's wallet.
  async function settleCaptures() {
    if (!payoutsEnabled || !chain.prepareCapture) return;
    const signed = store.transaction(() => {
      const records = store.payments();
      // A proposal whose War Chest outputs have since moved (its owner began an exit) can never confirm. It lapses and is proposed again.
      for (const row of records) {
        if (!row.capturesFor || row.state !== 'created' || row.rawHex) continue;
        const live = new Set(sourcesFor(records.filter(other => other.id !== row.id), 'kingdom').map(outpoint));
        if (row.sources.some(source => !live.has(outpoint(source)))) {
          store.savePayment({ ...row, state: 'expired', lastError: 'The War Chest outputs of this capture moved before it was signed. It is proposed again against their new place.' });
        }
      }
      const done = new Set(store.payments().filter(row => row.capturesFor && !['rejected', 'voided', 'expired'].includes(row.state)).map(row => row.capturesFor));
      const { world } = store.read();
      for (const entry of world.bchTreasury?.records ?? []) {
        if (entry.custody !== 'stake-escrow-v2' || !(entry.capturedSatoshis > 0) || done.has(entry.payment)) continue;
        const address = store.wallet(entry.attacker)?.address;
        // A capture owed before its defender began an exit follows the money into the exit script.
        const planned = captureQuote(records, entry.defender, entry.capturedSatoshis, { exiting: true });
        const chests = planned.sources;
        if (!address || !chests.length) continue;
        let capture;
        try {
          const raid = records.find(row => row.id === entry.payment);
          const battle = store.portalRows('battle').find(({ record }) => record.initiation?.txid === raid?.txid);
          capture = chain.prepareCapture({ sources: chests, feeders: planned.feeders, satoshis: entry.capturedSatoshis, address,
            payload: { payment: entry.payment, defender: entry.defender, attacker: entry.attacker, battle: battle?.event.subject ?? null, stakeSatoshis: entry.escrowSatoshis ?? null,
              ...(planned.feeders.length && { chestFeeders: planned.feeders.map(item => item.txid + ':' + item.vout), ridingReserveSatoshis: planned.feeders.reduce((sum, item) => sum + item.satoshis - item.chestSatoshis, 0) }) },
            event: gameEvent('chest-capture', entry.payment, { satoshis: entry.capturedSatoshis, attacker: entry.attacker, defender: entry.defender }), now: clock() });
        } catch (error) { console.error('War chest capture:', error.message); continue; }
        const result = { ...capture, capturesFor: entry.payment, pool: 'kingdom', title: 'War chest capture',
          description: 'A lost battle awards part of a war chest to the winner. It is sent once every ' + ATTESTOR_ADJECTIVE + ' attestor has replayed the battle and signed; the chest script limits the amount and returns the rest to the same chest.' };
        store.savePayment(result);
        return result;
      }
    });
    if (signed) notify();
  }

  const sweptCarriers = records => new Set(records.filter(row => ['allocation-sweep', 'carrier-refund'].includes(row.action) && !['rejected','voided'].includes(row.state))
    .flatMap(row => row.payload.carriers));
  const waitingCarriers = records => {
    const taken = sweptCarriers(records);
    return records.filter(row => row.state === 'credited' && row.direction !== 'outgoing').flatMap(row =>
      (row.receipt?.allocations ?? []).filter(output => output.role === 'carrier' && !taken.has(output.txid + ':' + output.vout))
        .map(output => ({ ...output, id: row.id, acceptedAt: row.acceptedAt ?? row.createdAt }))).reverse();
  };

  // Two or more carriers of one season sweep at once. A lone carrier waits, then sweeps with a top-up to the dust limit.
  async function sweepCarriers() {
    if (!payoutsEnabled || !chain.signCarrierSweep || quarantine('council', undefined, ['sponsor'])) return;
    const signed = store.transaction(() => {
      const records = store.payments();
      const waiting = waitingCarriers(records).filter(carrier => !carrier.carrier2);
      if (!waiting.length) return;
      const groups = new Map();
      for (const carrier of waiting) {
        const key = carrier.seasonId + ':' + carrier.prizeSatoshis;
        groups.set(key, [...(groups.get(key) ?? []), carrier]);
      }
      const now = clock();
      const group = [...groups.values()].find(items => items.length >= 2) ??
        [...groups.values()].find(items => now - items[0].acceptedAt >= carrierWait);
      if (!group) return;
      const batch = group.slice(0, 24);
      const feePool = ['development','settlement'].find(pool => sourcesFor(records, pool).length);
      if (!feePool) return;
      const feeSource = largestPayoutSources(sourcesFor(records, feePool))[0];
      const seasonId = batch[0].seasonId;
      const event = gameEvent('allocation-sweep', batch[0].txid + ':' + batch[0].vout, { seasonId,
        carriers: batch.map(item => item.txid + ':' + item.vout), prize: batch.reduce((total, item) => total + item.prizeSatoshis, 0),
        kingdom: batch.reduce((total, item) => total + item.kingdomSatoshis, 0) });
      let sweep;
      try { sweep = chain.signCarrierSweep({ carriers: batch, feeSource, seasonId, event, now }); }
      catch (error) { console.error('Prize carrier sweep:', error.message); return; }
      const row = { ...sweep, pool: feePool, title: 'Prize and kingdom share sweep',
        description: 'Moves carried prize shares into the season prize output and each kingdom share to its kingdom output.' };
      store.savePayment(row);
      return row;
    });
    if (signed) {
      await chain.broadcast(signed.rawHex).catch(() => undefined);
      notify();
    }
  }

  // Prize feeders join their season pool without any key, as soon as two wait (or one, once the pool exists and the reserves cover it).
  const waitingFeeders = records => {
    const taken = new Set(records.filter(row => row.payload?.feeders && !['rejected', 'voided'].includes(row.state)).flatMap(row => row.payload.feeders));
    return records.filter(row => row.state === 'credited' && row.direction !== 'outgoing').flatMap(row =>
      (row.receipt?.allocations ?? []).filter(output => output.feeder && !taken.has(output.txid + ':' + output.vout))
        .map(output => ({ ...output, waitingSince: row.creditedAt ?? row.acceptedAt ?? row.createdAt }))).reverse();
  };
  // War Chest shares join their owner's War Chest without any key. A move is sent as soon as an owner's waiting shares
  // reach the size a capture can take from, or when the oldest of them has waited out its period.
  async function sweepChestFeeders() {
    if (!chain.chestFeed) return;
    const tip = await chain.height?.().catch(() => null);
    const signed = store.transaction(() => {
      const records = store.payments();
      const groups = new Map();
      for (const feeder of waitingChestFeeders(records)) groups.set(feeder.chest.script, [...(groups.get(feeder.chest.script) ?? []), feeder]);
      for (const group of groups.values()) {
        const batch = group.toSorted((a, b) => b.satoshis - a.satoshis).slice(0, 4);
        const aged = Boolean(tip && batch.every(item => item.height > 0 && tip - item.height + 1 >= item.cf.wait));
        for (const feeders of [batch, ...(aged ? [batch.slice(0, 1)] : [])]) {
          try {
            const sweep = chain.chestFeed({ feeders, aged, playerId: feeders[0].playerId, now: clock() });
            const row = { ...sweep, pool: 'kingdom', title: 'War Chest shares joined your War Chest',
              description: 'A keyless move paid by your own network reserves. Your War Chest covenant is the only place these shares can go. From now on this money can be captured in a lost paid raid and withdrawn to your verified wallet.' };
            store.savePayment(row);
            return row;
          } catch { /* these shares are still below the threshold */ }
        }
      }
    });
    if (signed) {
      await chain.broadcast(signed.rawHex).catch(() => undefined);
      notify();
    }
  }

  async function sweepFeeders() {
    if (!chain.feedSweep) return;
    const signed = store.transaction(() => {
      const records = store.payments();
      const groups = new Map();
      for (const feeder of waitingFeeders(records)) groups.set(feeder.script, [...(groups.get(feeder.script) ?? []), feeder]);
      for (const group of groups.values()) {
        const pool = sourcesFor(records, 'sponsor').filter(source => source.script === group[0].pool.script).toSorted((a, b) => b.satoshis - a.satoshis)[0];
        // Larger batches first: the more feeders share one move, the more of their reserves stays in the pool.
        for (const size of [Math.min(group.length, 40), 2, 1]) {
          if (size > group.length || size < 1) continue;
          try {
            const sweep = chain.feedSweep({ feeders: group.slice(0, size), pool: pool && { ...pool, redeemScript: group[0].pool.redeemScript }, seasonId: group[0].seasonId, now: clock() });
            const row = { ...sweep, pool: 'sponsor', title: 'Season reward shares joined the pool',
              description: 'A keyless move paid by the payers\' own network reserves. The season pool covenant is the only place these shares can go.' };
            store.savePayment(row);
            return row;
          } catch { /* these feeders cannot pay for a move yet */ }
        }
        // A lone share that cannot afford to top up the existing pool output waits for the next payment while its season
        // runs: a separate small pool output would be too small to pay a prize from. Once its season has closed it
        // becomes a pool output of its own, so that it is in the pool the awards and the rollover read.
        const closed = store.read().world.season.number > (group[0].seasonId ?? Infinity);
        const stale = closed && group.find(feeder => clock() - (feeder.waitingSince ?? clock()) > 6 * 3_600_000);
        if (stale) {
          try {
            const sweep = chain.feedSweep({ feeders: [stale], seasonId: stale.seasonId, now: clock() });
            const row = { ...sweep, pool: 'sponsor', title: 'Season reward share joined the pool',
              description: 'A keyless move paid by the payer\'s own network reserve. The season pool covenant is the only place this share can go.' };
            store.savePayment(row);
            return row;
          } catch { /* not even a pool output of its own is affordable */ }
        }
      }
    });
    if (signed) {
      await chain.broadcast(signed.rawHex).catch(() => undefined);
      notify();
    }
  }

  // Reserve-funded carriers sweep without any key. A sweep is sent as soon as the reserves of the waiting carriers cover its
  // fee: two carriers start a season pool, three or more top up an existing one. A carrier past its refund date goes back to its payer.
  async function sweepPools() {
    if (!chain.poolSweep) return;
    const signed = store.transaction(() => {
      const records = store.payments();
      const waiting = waitingCarriers(records).filter(carrier => carrier.carrier2);
      if (!waiting.length) return;
      const now = clock();
      const late = waiting.filter(carrier => carrier.carrier2.refundAt + 7200 <= now / 1000).slice(0, 8);
      if (late.length) return { refund: late };
      const groups = new Map();
      for (const carrier of waiting) {
        const key = carrier.prize.script + ':' + carrier.prizeSatoshis;
        groups.set(key, [...(groups.get(key) ?? []), carrier]);
      }
      for (const group of groups.values()) {
        const batch = group.slice(0, 20);
        const pool = sourcesFor(records, 'sponsor').filter(source => source.script === batch[0].prize.script).toSorted((a, b) => b.satoshis - a.satoshis)[0];
        const seasonId = batch[0].seasonId;
        const event = gameEvent('allocation-sweep', batch[0].txid + ':' + batch[0].vout, { seasonId, carriers: batch.map(item => item.txid + ':' + item.vout),
          prize: batch.reduce((total, item) => total + item.prizeSatoshis, 0), kingdom: batch.reduce((total, item) => total + item.kingdomSatoshis, 0) });
        let sweep;
        try { sweep = chain.poolSweep({ carriers: batch, pool: pool && { ...pool, redeemScript: batch[0].prize.redeemScript }, seasonId, event, now }); }
        catch { continue; }
        const row = { ...sweep, pool: 'sponsor', title: 'Prize and kingdom share sweep',
          description: 'A keyless sweep paid by the carriers\' own reserves: prize shares join the season pool, each kingdom share goes to its payer\'s vault.' };
        store.savePayment(row);
        return { row };
      }
    });
    if (signed?.row) {
      await chain.broadcast(signed.row.rawHex).catch(() => undefined);
      notify();
    }
    for (const carrier of signed?.refund ?? []) {
      const spend = await chain.findSpend?.(carrier).catch(() => null);
      if (!spend) {
        try { await chain.broadcast(chain.carrierRefund([carrier]).rawHex); } catch { /* relayed already, or not final yet */ }
        continue;
      }
      if (store.byTxid(spend.txid)) continue;
      store.transaction(() => {
        // The kingdom share was credited when the payment confirmed. It has now returned to the payer's wallet instead.
        const { world } = store.read();
        war?.recovered(world, store.payment(carrier.id)?.playerId, carrier.kingdomSatoshis, carrier.txid + ':' + carrier.vout, clock());
        store.write(world);
        store.savePayment({ id: 'cr' + spend.txid.slice(0, 30), playerId: 'council', action: 'carrier-refund', direction: 'outgoing', network: NETWORK_ID, pool: 'escrow',
          state: 'credited', satoshis: carrier.satoshis, txid: spend.txid, external: true, payload: { carriers: [carrier.txid + ':' + carrier.vout] },
          sources: [{ txid: carrier.txid, vout: carrier.vout, satoshis: carrier.satoshis }], createdAt: clock(), expiresAt: null,
          receipt: { txid: spend.txid, confirmations: spend.confirmations, height: spend.height, explorerUrl: spend.explorerUrl },
          title: 'Carrier returned to its payer', description: 'This payment was never swept. Its carrier returned the kingdom share, the prize share and the reserve to the payer wallet.' });
      });
      notify();
    }
  }

  // After its recovery date a vault owner may spend the deposit without the game. The ledger follows the chain.
  let vaultCursor = 0;
  async function watchVaults() {
    if (!chain.findSpend) return;
    const records = store.payments();
    const now = clock() / 1000;
    const spentByUs = new Set(records.filter(row => row.direction === 'outgoing' && (row.rawHex || row.state === 'credited'))
      .flatMap(row => (row.sources ?? []).map(outpoint)));
    const open = records.flatMap(row => {
      if (row.state !== 'credited' || row.pool !== 'personal') return [];
      const output = row.direction === 'outgoing' ? row.receipt?.change : row.receipt?.allocations?.find(item => item.role === 'funding');
      return output?.vault && output.vault.recoverAt <= now && !spentByUs.has(outpoint(output)) ? [{ ...output, playerId: row.playerId }] : [];
    });
    // Kingdom vault and war chest outputs can be recovered by their owner in the same way.
    // Outputs named by an unsigned capture proposal are watched too: their owner may move them before the proposal is signed.
    // A matched settlement that is signed but not confirmed is treated the same way: an exit may still win the race.
    const unsettled = row => row.attestation && row.state !== 'credited' && (!row.rawHex || row.attestation.version === 'matched-raid-v1');
    for (const source of sourcesFor(records.filter(row => !unsettled(row)), 'kingdom')) {
      // A War Chest output of revision 3 or 4 can start its owner's exit at any time, so it is always watched.
      if (!source.kv || (!(source.kv.revision >= 3) && source.kv.recoverAt > now)) continue;
      const owner = store.walletOwner(walletFromPublicKey(source.kv.ownerKey).address);
      if (owner) open.push({ ...source, playerId: owner, kingdom: true });
    }
    if (!open.length) return;
    const first = vaultCursor % open.length;
    const batch = Array.from({ length: Math.min(8, open.length) }, (_, offset) => open[(first + offset) % open.length]);
    vaultCursor = (first + batch.length) % open.length;
    for (const source of batch) {
      const spend = await chain.findSpend(source).catch(() => null);
      if (!spend || store.byTxid(spend.txid)) continue;
      // Step one of an owner's exit: the money is now in the exit script. It is still this player's War Chest, and a
      // capture that was owed before the exit can still take its share there. It is no longer offered to new raids.
      const exit = source.kv?.revision >= 3 && !source.kv.exiting && chain.chestContract ? chain.chestContract({ ...source.kv, exiting: true }) : null;
      if (exit && source.kv.revision === 4 && spend.outputs?.[0]?.script === exit.script) {
        // Revision 4: every War Chest output this transaction spent arrived, whole, in output 0 of the exit script.
        const spentHere = new Set((spend.inputs ?? []).map(outpoint));
        const moved = sourcesFor(records.filter(row => !unsettled(row)), 'kingdom').filter(item => item.script === source.script && spentHere.has(outpoint(item)));
        const inputs = moved.length ? moved : [source];
        store.savePayment({ id: 'ce' + spend.txid.slice(0, 26) + '0000', playerId: source.playerId, action: 'chest-exit', direction: 'outgoing',
          network: NETWORK_ID, pool: 'kingdom', state: 'credited', satoshis: spend.outputs[0].satoshis, txid: spend.txid, external: true, createdAt: clock(), expiresAt: null,
          sources: inputs.map(item => ({ txid: item.txid, vout: item.vout, satoshis: item.satoshis })),
          changes: [{ script: exit.script, address: exit.address, redeemScript: exit.redeemScript, vout: 0, satoshis: spend.outputs[0].satoshis, kv: { ...source.kv, exiting: true } }],
          receipt: { txid: spend.txid, confirmations: spend.confirmations, height: spend.height, explorerUrl: spend.explorerUrl },
          title: 'War Chest exit started by its owner', description: `The owner moved this War Chest money, whole, into its exit script with the wallet key. It can leave after ${source.kv.exitDelay} blocks. Until then a raid that was already funded can still be settled from it; new raids cannot claim it.` });
        notify();
        continue;
      }
      const moved = exit && source.kv.revision === 3 && spend.outputs?.[spend.inputIndex];
      if (moved && moved.script === exit.script) {
        store.savePayment({ id: 'ce' + spend.txid.slice(0, 26) + String(spend.inputIndex).padStart(4, '0'), playerId: source.playerId, action: 'chest-exit', direction: 'outgoing',
          network: NETWORK_ID, pool: 'kingdom', state: 'credited', satoshis: moved.satoshis, txid: spend.txid, external: true, createdAt: clock(), expiresAt: null,
          sources: [{ txid: source.txid, vout: source.vout, satoshis: source.satoshis }],
          changes: [{ script: exit.script, address: exit.address, redeemScript: exit.redeemScript, vout: moved.vout, satoshis: moved.satoshis, kv: { ...source.kv, exiting: true } }],
          receipt: { txid: spend.txid, confirmations: spend.confirmations, height: spend.height, explorerUrl: spend.explorerUrl },
          title: 'War Chest exit started by its owner', description: `The owner moved this War Chest money into its exit script with the wallet key. It can leave after ${source.kv.exitDelay} blocks. Until then a capture that was already owed can still be taken from it.` });
        // The exit's network fee left the War Chest.
        if (war?.recovered && source.satoshis > moved.satoshis) {
          const { world } = store.read();
          war.recovered(world, source.playerId, source.satoshis - moved.satoshis, source.txid + ':' + source.vout + ':exit-fee', clock());
          store.write(world);
        }
        notify();
        continue;
      }
      if (source.kingdom && war?.recovered) {
        const { world } = store.read();
        war.recovered(world, source.playerId, source.satoshis, source.txid + ':' + source.vout, clock());
        store.write(world);
      }
      store.savePayment({ id: 'vr' + spend.txid.slice(0, 30), playerId: source.playerId, action: 'vault-recovery', direction: 'outgoing',
        network: NETWORK_ID, pool: source.kingdom ? 'kingdom' : 'personal', state: 'credited', satoshis: source.satoshis, txid: spend.txid, external: true,
        sources: [{ txid: source.txid, vout: source.vout, satoshis: source.satoshis }], createdAt: clock(), expiresAt: null,
        receipt: { txid: spend.txid, confirmations: spend.confirmations, height: spend.height, explorerUrl: spend.explorerUrl },
        title: 'Vault recovered by its owner', description: 'The owner spent this deposit directly with the wallet key after its recovery date.' });
      notify();
    }
  }

  // Prize fund upkeep: stale award proposals lapse, and a contribution past its refund date goes back to its sponsor.
  let fundCursor = 0;
  async function watchFunds() {
    const now = clock();
    for (const row of store.payments()) {
      if (row.attestation && !row.rawHex && row.state === 'created' && row.expiresAt <= now) {
        store.savePayment({ ...row, state: 'expired', lastError: row.capturesFor ? 'The battle attestors did not sign this capture in time. It will be proposed again.' :
          'The prize attestors did not sign this award in time. The player can claim again.' });
      }
    }
    if (!chain.findSpend || !chain.prizeRefund) return;
    // Two hours of margin: the network compares the refund date with the median time of recent blocks.
    const due = sourcesFor(store.payments(), 'sponsor').filter(source => source.fund && source.fund.refundAt + 7200 <= now / 1000);
    if (!due.length) return;
    const first = fundCursor % due.length;
    const batch = Array.from({ length: Math.min(4, due.length) }, (_, offset) => due[(first + offset) % due.length]);
    fundCursor = (first + batch.length) % due.length;
    for (const source of batch) {
      const spend = await chain.findSpend(source).catch(() => null);
      if (!spend) {
        // The refund lane needs no key. Anyone may send this; the server does it so the sponsor does not have to.
        try { await chain.broadcast(chain.prizeRefund([source]).rawHex); } catch { /* relayed already, or not final yet */ }
        continue;
      }
      if (store.byTxid(spend.txid)) continue;
      store.savePayment({ id: 'sr' + spend.txid.slice(0, 30), playerId: 'council', action: 'sponsor-refund', direction: 'outgoing',
        network: NETWORK_ID, pool: 'sponsor', state: 'credited', satoshis: source.satoshis, txid: spend.txid, external: true,
        sources: [{ txid: source.txid, vout: source.vout, satoshis: source.satoshis }], createdAt: now, expiresAt: null,
        receipt: { txid: spend.txid, confirmations: spend.confirmations, height: spend.height, explorerUrl: spend.explorerUrl },
        title: 'Prize contribution returned to its sponsor',
        description: 'This part of a sponsorship was not awarded before its refund date. The prize fund covenant returned it to the sponsor wallet.' });
      notify();
    }
  }

  function pendingAnchorTxids(records) {
    return new Set(store.portalRows('battle').flatMap(({ record, event }) =>
      record.initiation && record.initiation.event?.kind !== 'territory-attack' &&
      !records.some(row => row.anchorFor === event.subject) ? [record.initiation.txid] : []));
  }

  function explorer() {
    const records = store.payments();
    const observed = records.filter(row => row.receipt?.txid);
    const final = observed.filter(row => row.state === 'credited');
    const splits = final.flatMap(row => row.receipt.allocations ?? []);
    const balanceOf = (pool) => sum(sourcesFor(records, pool));
    const buckets = { development: balanceOf('development'), prize: balanceOf('sponsor'), kingdomReserve: balanceOf('kingdom'),
      settlementFees:balanceOf('settlement'),
      externalDevelopment: sum(splits.filter(output => output.role === 'development' && output.custody === 'external')),
      burned: sum(splits.filter(output => output.role === 'burn')) };
    buckets.allocationCarriers = sum(waitingCarriers(records));
    buckets.politicalEscrow=final.filter(row=>row.action==='political-escrow' && row.politicalStatus==='funded')
      .reduce((total,row)=>total+row.contract.principal,0);
    const settledTerritoryInputs = new Set(final.filter(row => row.territoryAnchor).flatMap(row => row.sources.map(source => source.txid)));
    // A stake in a stake escrow contract (claim, attack on a territory, raffle entry) is one output that holds the stake and
    // its settlement reserve. It counts for as long as no confirmed settlement has spent it.
    const settledStakes = new Set(final.filter(row => row.settles).map(row => row.settles));
    buckets.territoryEscrow = sum(final.filter(row => row.territoryEscrow && !settledTerritoryInputs.has(row.txid))
      .flatMap(row => row.receipt.allocations.filter(output => output.role === 'battle'))) +
      sum(final.filter(row => territoryPayments.has(row.action) && row.escrow && !settledStakes.has(row.id))
        .flatMap(row => row.receipt.allocations.filter(output => output.role === 'escrow')));
    const transactions = observed.slice(0, 100).map(row => {
      const view = toPublic(row);
      return {
        txid: row.txid, action: row.action, title: row.title, direction: row.direction,
        state: row.state, confirmations: view.receipt.confirmations, height: view.receipt.height,
        explorerUrl: view.receipt.explorerUrl, satoshis: row.satoshis, feeSatoshis: view.receipt.feeSatoshis ?? null,
        allocations: view.receipt.allocations, event: view.receipt.event,
        territory:row.payload?.territory, territoryRecord:row.territoryAnchor,
        ...(politicalPayments.has(row.action) || row.politicalFunding || row.politicalAnchor ? {politics:true,politicalRecord:row.politicalAnchor} : {}),
      };
    });
    const { status, seasonId, claimDeadline, eligibleCount, poolSatoshis, rolledSatoshis, deferredSatoshis } = seasonPrize(store.read().world, records);
    const sponsorship = { policy: { version: SPONSOR_ALLOCATION, ...sponsorRules }, ...summarizeSponsorship(records, clock()) };
    // Who can move each kind of money today. Published so that nobody has to take custody claims on trust.
    const PANEL = (chain.prizeAttestors?.length === 1 ? 'the game key and the attestor together' : chain.attestorThreshold + ' of ' + (chain.prizeAttestors?.length ?? 0) + ' attestors, without the game key');
    const custody = {
      // Stated plainly, once: who runs the attestors. Owner-run attestors are never described as independent.
      attestors: ATTESTOR_OPERATION === 'owner' ? 'Run by the VaultBorn team (not by independent parties). ' + ATTESTOR_NOTE :
        'run by parties independent of the game operator, as declared by the operator',
      development: chain.developmentAddress ? 'developer address ' + chain.developmentAddress + ' (never held by the game)' : 'operator key (no developer address configured)',
      sponsorshipPrizes: chain.prizeAttestors?.length ? 'prize-fund-v1 covenant: automation key plus ' + chain.attestorThreshold + ' of ' + chain.prizeAttestors.length + ' ' + ATTESTOR_ADJECTIVE + ' attestor(s) after season close; keyless refund to the sponsor' : 'closed (no prize attestor configured)',
      personalVault: personalVault === 'open' ? (covenantVault ? 'vault-covenant-v1: pays the owner wallet only; owner-only recovery after the recovery date' : 'operator key') :
        'closed to new deposits (one player treasury); an earlier vault-covenant-v1 deposit pays its owner wallet only and is recoverable by its owner alone',
      treatyEscrow: 'political-escrow v2 covenant: payee on release, payer on refund or timeout',
      politicalProofRecords: matchedRaids ? 'record-reserve-v2: the payer locks ' + book.reserves.record + ' satoshis that the game key can spend only as the network fee of one zero-value data record; it cannot be paid to anyone, and if no record is published the payer\'s key alone takes it back once the output is 2,016 blocks old' : 'closed',
      carriedServiceShares: 'prize-carrier-v1 covenant: keyless sweep to the exact prize and kingdom outputs (payments from before the War Chest economy)',
      servicePrizePool: covenantKingdom && chain.prizeAttestors?.length ? 'prize feeders (no key) move each 20% share into the season pool covenant; awards need the game key and ' + chain.attestorThreshold + ' of ' + chain.prizeAttestors.length + ' attestor(s), at most 40% of a pool output per award; from 30 days after the season closes the game key and any one attestor, or all attestors together without the game key' : 'closed (no prize attestor configured)',
      warChestModel: covenantKingdom ? 'one player treasury: 50% of every service payment and every direct deposit go into the payer\'s War Chest covenant; all of it is always at risk; there is no kingdom treasury and no risk setting' : 'previous model (operator custody)',
      kingdomTreasury: covenantKingdom ? 'none: there is no kingdom treasury; the War Chest is the only player treasury' : 'operator key',
      warChest: !covenantKingdom ? 'not used' : matchedRaids ?
        'war-chest-v4 (matched stakes), one script per owner: release by the game key pays the owner wallet only (remainder back to the chest, output 144 blocks old); capture needs the game key and ' + (chain.attestorThreshold ?? 'a majority') + ' of ' + (chain.prizeAttestors?.length ?? 0) + ' attestor(s), and the script lets value leave only when output 0 of the same transaction pays at least twice that value, so exactly the attacker\'s own stake is matched; the owner key alone moves an output, whole, into the exit script at any time and takes it out 288 blocks later' :
        'war-chest-v3, one script per owner: release pays the owner wallet (change back to the chest, output 144 blocks old); capture needs the game key and ' + (chain.attestorThreshold ?? 'a majority') + ' of ' + (chain.prizeAttestors?.length ?? 0) + ' attestor(s), takes at most 20% of the outputs it spends and returns one remainder; the owner key alone moves an output into the exit script at any time and takes it out 288 blocks later',
      warChestShares: !covenantKingdom ? 'not used' : matchedRaids ? 'paid straight into the payer\'s War Chest as its own output; no feeder (shares of earlier payments still waiting in chest-feeder-v2 outputs can only become outputs of their payer\'s earlier War Chest)' :
        'chest-feeder-v2 (no key): a service payment\'s 50% share can only become an output of the payer\'s own War Chest, once the waiting shares reach the capture floor or after ' + CHEST_FEED_WAIT_BLOCKS + ' blocks',
      raidStakes: !covenantKingdom ? 'operator key' : matchedRaids ?
        'stake-escrow-v4 (matched raid): the attacker\'s stake S and a network reserve; void returns it, a defender victory pays S to the defender\'s wallet fixed at funding, an attacker victory pays the attacker exactly 2 x S in one transaction with the defender\'s War Chest; every lane is opened by the outcome panel (' + PANEL + '), never by the game key alone; the unused reserve returns to the attacker in every lane; attacker\'s own refund after 3 days' :
        'stake-escrow-v3: attacker or attacker/defender split fixed at funding; the lane is opened by the outcome panel (' + PANEL + '), never by the game key alone; owner refund after timeout',
      territoryStakes: covenantKingdom ? 'stake-escrow-v3 for attacks and open claims (lanes opened by the outcome panel only; an open claim keeps at least half for its claimant); raffle entries return to the entrant only, without any key; a territory attack never touches a War Chest' : 'operator key', settlementReserve: covenantKingdom ? 'inside each stake escrow; it pays that escrow\'s own settlement' : 'operator key',
    };
    // Outputs made before covenant custody are still spendable by the game key. They are counted here so nobody mistakes them for covenant money.
    // War Chest shares still in their feeders: their owners' money, in keyless covenants, not yet capturable.
    buckets.warChestWaiting = covenantKingdom ? waitingChestFeeders(records).reduce((total, item) => total + item.chestSatoshis, 0) : 0;
    buckets.legacyOperatorHeld = sum(sourcesFor(records, 'kingdom').filter(source => !source.kv)) + sum(sourcesFor(records, 'sponsor').filter(source => !source.fund)) +
      balanceOf('settlement') + balanceOf('development');
    return { network: NETWORK_ID, buckets, custody, transactions, sponsorship, prizes: { status, seasonId, claimDeadline, eligibleCount, poolSatoshis, rolledSatoshis, deferredSatoshis }, stats: {
      observed: observed.length, credited: final.length, fees: final.reduce((total, row) => total + (row.receipt.feeSatoshis ?? 0), 0),
    }, prizeRules };
  }

  async function rebroadcast(row) {
    try { await chain.broadcast(row.rawHex); return null; }
    catch (error) { return String(error?.message ?? error).slice(0, 160); }
  }

  // Signed and funded operations go first, oldest first. Every class rotates, so new unpaid rows cannot starve older ones.
  const cursors = [0, 0, 0, 0, 0];
  const faults = new Map();
  function reconcileBatch(records, now) {
    const classes = [[], [], [], [], []];
    for (const row of records) {
      // A record of a spend somebody else made (an owner's recovery, a keyless refund) is not an intent to re-observe.
      if (row.external) continue;
      if (row.state === 'reorg') classes[0].push(row);
      // An unsigned proposal has no transaction to look for, whatever its state.
      else if (row.attestation && !row.rawHex) continue;
      else if (openStates.has(row.state)) classes[row.direction === 'outgoing' ? 1 : row.txid ? 2 : 4].push(row);
      else if (row.state === 'credited' && (row.receipt?.confirmations ?? 0) < 144) classes[3].push(row);
      else if (row.event && row.state === 'expired' && row.expiresAt + 6 * 60 * 60_000 > now) classes[4].push(row);
    }
    for (const rows of classes) rows.reverse();
    const share = [8, 16, 24, 8, 8].map((minimum, index) => Math.min(minimum, classes[index].length));
    let spare = reconcileBudget - share.reduce((total, count) => total + count, 0);
    for (let index = 0; index < classes.length && spare > 0; index += 1) {
      const extra = Math.min(spare, classes[index].length - share[index]);
      share[index] += extra;
      spare -= extra;
    }
    return classes.flatMap((rows, index) => {
      if (!rows.length) return [];
      const first = cursors[index] % rows.length;
      cursors[index] = (first + share[index]) % rows.length;
      return Array.from({ length: share[index] }, (_, offset) => rows[(first + offset) % rows.length]);
    });
  }

  async function reconcile() {
    if (busy || !chain.enabled) return;
    busy = true;
    try {
      const now = clock();
      const records = store.payments();
      for (const row of records) {
        // A cancellation loses its purpose once the original payout confirms.
        if (row.voidFor && openStates.has(row.state) && store.payment(row.voidFor)?.state === 'credited') {
          store.savePayment({ ...row, state:'rejected', lastError:'The original payout confirmed before this cancellation.' });
        }
      }
      await Promise.all(reconcileBatch(store.payments(), now).map(async row => {
        try {
          const failure = row.rawHex && ['submitted', 'uncertain'].includes(row.state) ? await rebroadcast(row) : null;
          const observed = await chain.observe(row, clock());
          if (row.direction === 'outgoing' && !observed.receipt && failure && observed.broadcastError !== failure) {
            observed.broadcastError = failure;
            observed.broadcastErrorSince = row.broadcastErrorSince ?? now;
          }
          try {
            applyObservation(row, observed);
            faults.delete(row.id);
          } catch (error) {
            const count = (faults.get(row.id) ?? 0) + 1;
            faults.set(row.id, count);
            console.error('Payment ' + row.id + ' could not be applied:', error.message);
            if (count >= 3) {
              faults.delete(row.id);
              applyObservation(row, observed, { finalizeUnexpected:true });
            }
          }
        } catch (error) { console.error('Payment ' + row.id + ' reconciliation failed:', error.message); }
      }));
      // One failing settlement lane must not stop the others.
      const lanes = [sweepCarriers, sweepPools, sweepFeeders, sweepChestFeeders, autoAward, settleStakes, settleCaptures, watchVaults, watchFunds, anchorBattle,
        async () => { if (politics) await politics.reconcile({ settle: !quarantine('council') }); },
        async () => { if (territory) await territory.processRaffles(); },
        async () => { if (territory && !quarantine('council')) await territory.anchorNext(); }];
      for (const lane of lanes) {
        try { await lane(); }
        catch (error) { console.error('Settlement lane failed:', error.message); }
      }
    } finally { busy = false; }
  }

  async function voidPayout(body) {
    if (body?.consent !== true || typeof body.id !== 'string') fail(400, 'Confirm the payout cancellation.');
    if (!payoutsEnabled) fail(503, 'The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    if (store.payment(body.id)?.kvSource) fail(409, 'A kingdom vault payout can only reach its owner. It stays valid until it confirms and needs no cancellation.');
    if (store.payment(body.id)?.fundSource) fail(409, 'A prize fund award is not signed by the operator alone, so the operator cannot cancel it. It stays valid until it confirms.');
    const target = store.payment(body.id);
    const stuck = row => row && row.direction === 'outgoing' && voidableActions.has(row.action) && row.rawHex &&
      ['submitted', 'uncertain'].includes(row.state) && !row.voiding;
    if (!stuck(target)) fail(409, 'Only a signed payout that the network has not accepted can be cancelled.');
    const seen = await chain.observe(target, clock());
    if (seen.receipt || seen.state !== 'submitted' || seen.lastError) {
      fail(409, 'The network may already know this payout, or the observer is unavailable. It cannot be cancelled now.');
    }
    const row = store.transaction(() => {
      const current = store.payment(target.id);
      if (!stuck(current) || current.txid !== target.txid) fail(409, 'This payout changed. Review it again.');
      const event = chain.supportsVaultborn ? gameEvent('payout-void', current.id, { txid: current.txid, action: current.action }) : undefined;
      const payload = { voids: current.id, ...(current.payload?.seasonId !== undefined && { seasonId: current.payload.seasonId }) };
      // A vault covenant has one destination, so its replacement pays the whole deposit to the owner's wallet.
      const plan = current.vaultSource ?
        chain.prepareVaultPayout({ playerId: current.playerId, action: 'payout-void', payload, source: current.sources[0], event, now: clock() }) :
        chain.preparePayout({ playerId: current.playerId, action: 'payout-void', payload, sources: current.sources, event, retain: true, now: clock() });
      const signed = { ...plan, ...(current.vaultSource ? chain.signVaultPayout(plan) : chain.signPayout(plan)), voidFor: current.id, pool: current.pool,
        ...(!current.vaultSource && { retainedPool: current.pool }),
        title: current.vaultSource ? 'Vault payout replacement' : 'Payout cancellation',
        description: current.vaultSource ? 'Replaces an unaccepted withdrawal by paying the whole vault deposit to its owner.' :
          'Returns the reserved inputs of an unaccepted payout to the treasury.', state: 'submitted' };
      store.savePayment(signed);
      store.savePayment({ ...current, voiding: signed.id });
      return signed;
    });
    await chain.broadcast(row.rawHex).catch(() => undefined);
    notify();
    return toPublic(row);
  }

  // A payment that left the active chain for good is written off here. Its pooled outputs stop counting and its kingdom credit is reversed.
  function resolveReorg(body) {
    if (body?.consent !== true || typeof body.id !== 'string') fail(400, 'Confirm the write-off.');
    const result = store.transaction(() => {
      const row = store.payment(body.id);
      if (!row || row.state !== 'reorg') fail(409, 'Only a payment in the reorganized state can be written off.');
      let reversal = null;
      if (war?.reverse) {
        const { world } = store.read();
        reversal = war.reverse(world, row, clock());
        if (reversal) store.write(world);
      }
      const updated = { ...row, state:'reversed', reversal, lastError:'Written off by the operator after leaving the active chain.' };
      store.savePayment(updated);
      return updated;
    });
    notify();
    return toPublic(result);
  }

  // A treaty escrow paid with the wrong amount is never credited. The operator lane can only return it to its payer.
  async function refundMisfundedEscrow(body) {
    if (body?.consent !== true || typeof body.id !== 'string' || !/^[a-f0-9]{64}$/.test(body.txid ?? '') ||
        !Number.isSafeInteger(body.vout) || body.vout < 0) fail(400, 'Supply the escrow, its funding transaction and output, and confirm.');
    if (!payoutsEnabled) fail(503, 'The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    const escrow = store.payment(body.id);
    if (!escrow || escrow.action !== 'political-escrow' || escrow.contract?.version !== 2) fail(404, 'Version 2 political escrow unavailable.');
    if (escrow.txid === body.txid && ['confirmed', 'credited'].includes(escrow.state)) fail(409, 'This output funded the escrow correctly. It settles through the treaty.');
    const observed = await chain.verifyPublishedTransaction(body.txid);
    const output = observed?.outputs[body.vout];
    if (!output || output.script !== escrow.contract.script || output.asset !== 'BCH' || observed.confirmations < (chain.minConfirmations ?? 2)) {
      fail(409, 'A confirmed BCH output at this escrow address was not found.');
    }
    const point = body.txid + ':' + body.vout;
    const row = store.transaction(() => {
      if (store.payments().some(item => item.misfundSource === point && item.state !== 'rejected')) fail(409, 'A return for this output already exists.');
      const event = gameEvent('political-refund', 'pe-' + escrow.id + '-' + body.vout, { entryTxid: body.txid, satoshis: output.satoshis, misfunded: true });
      let signed;
      try {
        signed = chain.signPoliticalMisfundRefund({ row: escrow, event, now: clock(),
          source: { txid: body.txid, vout: body.vout, script: output.script, satoshis: output.satoshis } });
      } catch (error) { fail(409, error.message); }
      const refund = { ...signed, misfundSource: point, title: 'Return of a wrongly funded treaty payment',
        description: 'The escrow covenant only allows this output to return to its payer.' };
      store.savePayment(refund);
      return refund;
    });
    await chain.broadcast(row.rawHex).catch(() => undefined);
    notify();
    return toPublic(row);
  }

  function attention() {
    const now = clock();
    return store.payments().filter(row => row.state === 'reorg' || row.fulfillment?.status === 'review' || row.fulfillment?.fault ||
      (['rejected', 'expired'].includes(row.state) && row.txid && row.direction !== 'outgoing') ||
      (row.direction === 'outgoing' && openStates.has(row.state) && now - (row.createdAt ?? now) > 30 * 60_000))
      .slice(0, 200).map(row => ({ ...toPublic(row), broadcastError: row.broadcastError ?? null,
        broadcastErrorSince: row.broadcastErrorSince ?? null, voiding: row.voiding ?? null, voidFor: row.voidFor ?? null }));
  }

  return { create, submit, reconcile, payout, quotePayout, daoQuote, daoSpend, explorer, payoutsEnabled, balances, voidPayout, resolveReorg, refundMisfundedEscrow, attention, pendingAwards, attestAward, evidence, anchors, seasonResult, raidPreview: raidOutlook, unified: covenantKingdom, riskCeiling: player => covenantKingdom ? chestSum(store.payments(), player) : null,
    list: player => store.payments(player).map(toPublic) };
}
