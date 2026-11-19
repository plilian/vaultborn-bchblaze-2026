import { createHash } from 'node:crypto';
import { DAY, HOUR } from '../../config/economy.mjs';
import { bchPolicy, GAMEPLAY_ALLOCATION, legacyFees, paymentAllocation, PRIZE_CARRIER } from '../../config/payments.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';
import { ADDRESS_PATTERN, NETWORK_ID } from '../../config/network.mjs';

export const liveFees = legacyFees;
const releaseDelay = 12 * HOUR;
const riskLimit = 250_000;
export const STAKE_ESCROW = 'stake-escrow-v2';
// A matched raid: both sides are exposed to the same stake, and the escrow and the defender's War Chest settle together.
export const MATCHED_ESCROW = 'stake-escrow-v4';
const empty = () => ({ total: 0, committed: 0, release: null });
const fault = (status, message) => { throw Object.assign(new Error(message), { status }); };
const owned = (object, key) => object && Object.hasOwn(object, key);
const ledger = world => world.bchTreasury ??= { version: 1, accounts: {}, records: [], settled: {} };
const get = (world, player) => ledger(world).accounts[player] ??= empty();

function requirePlayer(world, player) {
  if (typeof player !== 'string' || !owned(world.cities, player) || world.cities[player].npc) {
    fault(403, 'This player does not control a kingdom treasury.');
  }
}

function settledRisk(account, now) {
  return account.release && account.release.at <= now ? account.release.amount : account.committed;
}

function unlock(account, now) {
  if (account.release && account.release.at <= now) {
    account.committed = account.release.amount;
    account.release = null;
  }
}

function balance(world, player, now = Date.now()) {
  const accounts = world.bchTreasury?.accounts;
  const account = owned(accounts, player) ? accounts[player] : empty();
  const atRiskSatoshis = settledRisk(account, now);
  return { kingdomSatoshis: account.total, atRiskSatoshis, lockedSatoshis: 0,
    availableKingdomSatoshis: account.total - atRiskSatoshis,
    riskRelease: account.release && account.release.at > now ? { ...account.release } : null };
}

const walletIdentity = value => typeof value === 'string' && ADDRESS_PATTERN.test(value) ? value.toLowerCase() : null;
const identityCommitment = identity => createHash('sha256').update('vaultborn:wallet-identity:' + identity).digest('hex');

function commit(world, player, satoshis, now, verifiedAddress) {
  requirePlayer(world, player);
  if (!Number.isSafeInteger(satoshis) || satoshis < 0 || satoshis > riskLimit) fault(400, 'Commit between 0 and 250,000 sats.');
  if (satoshis > 0 && !world.cities[player].optIn) fault(409, 'Join seasonal PvP before committing kingdom funds.');
  const identity = walletIdentity(verifiedAddress);
  if (!identity) fault(403, 'Verify a ' + NETWORK_LABEL + ' wallet before changing this commitment.');
  const account = get(world, player);
  unlock(account, now);
  if (satoshis > account.total) fault(409, 'Only confirmed kingdom funds can be committed.');
  account.riskWallet = identityCommitment(identity);
  if (satoshis < account.committed) account.release = { amount: satoshis, at: now + releaseDelay };
  else {
    account.committed = satoshis;
    account.release = null;
  }
  ledger(world).records.push({ kind: 'risk', player, satoshis, now, release: account.release && { ...account.release },
    walletCommitment: account.riskWallet });
  return balance(world, player, now);
}

function split(satoshis, action, version, options) {
  try { return paymentAllocation(satoshis,action,version,options); }
  catch (error) { fault(400,error.message); }
}

function verifyAllocation(row) {
  if (row.state !== 'confirmed' || !/^[a-f0-9]{64}$/.test(row.txid ?? '') || row.receipt?.txid !== row.txid ||
      !Array.isArray(row.receipt.allocations)) throw new Error('A verified, confirmed gameplay receipt is required.');
  const carried = row.event?.data.dust === PRIZE_CARRIER;
  // The price book the payment was quoted under decides its reserve; a matched raid carries its own measured reserve.
  const allocation = split(row.satoshis, row.action, row.event?.data.allocationPolicy, { carrier:carried, pricing:row.event?.data.pricing,
    ...(row.event?.data.custody === MATCHED_ESCROW && { reserve:row.event.data.allocation?.settlement }) });
  if (row.event?.data.allocationPolicy===GAMEPLAY_ALLOCATION &&
    Object.entries(allocation).some(([role,value])=>row.event.data.allocation?.[role]!==value)) {
    throw new Error('Gameplay allocation differs from the committed policy.');
  }
  const outputs = row.receipt.allocations;
  const vouts = new Set(outputs.map(output => output.vout));
  // A stake escrow holds the stake and its settlement reserve in one covenant output.
  const escrowed = [STAKE_ESCROW, MATCHED_ESCROW].includes(row.event?.data.custody);
  // A carrier output holds the exact prize and kingdom shares together until its sweep.
  // Under the final service policy the prize output is a feeder that also holds its payer-funded network reserve.
  // A political operation also carries the fee of its proof record in an output of its own.
  const onChain=allocation.warChest!==undefined ? {...allocation,prize:allocation.prize+(row.event.data.feedReserve??0),warChest:allocation.warChest+(row.event.data.chestReserve??0),
      ...(row.event.data.recordReserve && {record:row.event.data.recordReserve})} :
    escrowed ? {escrow:allocation.battle+allocation.settlement} :
    carried ? {development:allocation.development,burn:allocation.burn,carrier:allocation.prize+allocation.kingdom+(row.event.data.sweepReserve??0)} : allocation;
  const roles=Object.keys(onChain);
  const expected=Object.hasOwn(allocation,'settlement')?{...onChain,event:0}:onChain;
  if (outputs.length !== Object.keys(expected).length || vouts.size !== outputs.length || outputs.some(output =>
    output.txid !== row.txid || !Number.isSafeInteger(output.vout) || output.vout < 0 ||
    !owned(expected, output.role) || expected[output.role] !== output.satoshis) ||
    [...roles,...(expected.event===0?['event']:[])].some(role => outputs.filter(output => output.role === role).length !== 1)) {
    throw new Error('The confirmed gameplay transaction does not match its exact allocations.');
  }
  const carrier = carried && outputs.find(output => output.role === 'carrier');
  const escrow = escrowed && outputs.find(output => output.role === 'escrow');
  if (escrow) return { allocation, owner: { ...escrow, role:'battle', satoshis:allocation.battle } };
  const own = outputs.find(output => ['kingdom','battle','warChest'].includes(output.role));
  // The account is credited with the exact War Chest share. The network reserve that travels with it is not the player's balance until it arrives.
  return { allocation, owner: carrier ? { ...carrier, role:'kingdom', satoshis:allocation.kingdom } :
    own?.role === 'warChest' ? { ...own, satoshis:allocation.warChest } : own };
}

function checkedTotal(current, delta) {
  const result = current + delta;
  if (!Number.isSafeInteger(result) || result < 0) fault(409, 'Kingdom balance exceeds its safe accounting limit.');
  return result;
}

function battleEligible(world, outcome, attacker, defender) {
  if (!outcome || !['raid','territory-attack','conquest'].includes(outcome.kind) || outcome.paid !== true || outcome.attacker !== attacker || attacker === defender ||
      !['attacker', 'defender'].includes(outcome.winner)) return false;
  const left = world.cities[attacker];
  const right = world.cities[defender];
  return Boolean(left?.optIn && right?.optIn && !left.npc && !right.npc &&
    !(left.alliance && left.alliance === right.alliance));
}

function apply(world, row, outcome, now, linked = () => null, capturable = () => null) {
  const treasury = ledger(world);
  if (owned(treasury.settled, row.id)) return treasury.settled[row.id];
  requirePlayer(world, row.playerId);
  const { allocation, owner } = verifyAllocation(row);
  const outpoint = row.txid + ':' + owner.vout;
  const sameFunding = treasury.records.find(record => record.outpoint === outpoint || record.txid === row.txid);
  if (sameFunding) throw new Error('This gameplay funding outpoint was already accounted for.');

  const attacker = row.playerId;
  const defender = owner.role === 'battle' ? outcome?.defender : null;
  const escrow = owner.satoshis;
  const updatedPolicy=row.event?.data.allocationPolicy===GAMEPLAY_ALLOCATION;
  // With a stake escrow the stake never enters a kingdom account: the covenant pays the wallets of the two sides directly.
  const matched = row.event?.data.custody === MATCHED_ESCROW;
  const direct = matched || row.event?.data.custody === STAKE_ESCROW;
  let lane = null;
  let forfeitedSatoshis = 0;
  let recipient = attacker;
  let captured = 0;
  const chest = owner.role === 'warChest';
  let effect = chest ? 'war-chest-funded' : owner.role === 'kingdom' ? 'kingdom-funded' : outcome ? 'escrow-recovered' : 'payment-recovered';
  const source = get(world, attacker);
  const attackerBefore = source.total;
  let defenderBefore = null;
  let defenderAfter = null;
  let committedBefore = null;
  let committedAfter = null;
  let contest = null;

  if (battleEligible(world, outcome, attacker, defender)) {
    const pool = get(world, defender);
    const pair = [attacker, defender].sort().join(':');
    const repeated = treasury.records.some(record => record.pair === pair && record.now > now - DAY);
    const attackerWallet = walletIdentity(linked(attacker));
    const defenderWallet = walletIdentity(linked(defender));
    const distinctWallets = attackerWallet && defenderWallet && attackerWallet !== defenderWallet;
    const defenderCommitment = defenderWallet && identityCommitment(defenderWallet);
    unlock(pool, now);
    defenderBefore = pool.total;
    defenderAfter = pool.total;
    committedBefore = pool.committed;
    committedAfter = pool.committed;
    // Matched raid: the defender's War Chest must still cover the whole stake in confirmed, capturable outputs that no other
    // raid has claimed. If it does not, the raid has no BCH outcome for either side and the stake returns.
    const covered = matched && (capturable(defender, escrow, pool.committed) ?? 0) >= escrow && pool.committed >= escrow;
    if (matched) {
      if (distinctWallets && covered && !repeated && pool.riskWallet === defenderCommitment) {
        if (outcome.winner === 'attacker') {
          captured = escrow;
          defenderAfter = checkedTotal(pool.total, -captured);
          committedAfter = pool.committed - captured;
          effect = 'matched-stake-won';
          lane = 'attacker-wins';
        } else {
          forfeitedSatoshis = escrow;
          recipient = defender;
          effect = 'matched-stake-lost';
          lane = 'defender-wins';
        }
        pool.total = defenderAfter;
        pool.committed = committedAfter;
        if (pool.release) pool.release.amount = Math.min(pool.release.amount, pool.committed);
        treasury.records.push({ kind: 'battle-limit', pair, now });
        contest = { distinctVerifiedWallets: true, defenderCommitment, pairCooldownHours: DAY / HOUR, matched: true, stakeSatoshis: escrow };
      } else lane = 'void';
    }
    const opted = !matched && pool.riskWallet === defenderCommitment && pool.committed > 0;
    const controlledDefense = row.action === 'territory-attack' && outcome.winner === 'defender';
    const eligibleDefense=outcome.winner==='defender' && (updatedPolicy || controlledDefense);
    if (!matched && distinctWallets && (opted || eligibleDefense) && !repeated) {
      if (outcome.winner === 'attacker') {
        // With covenant custody a capture can only come from War Chest outputs that are confirmed and large enough to be captured
        // at all, so the rule is applied to that amount and never promises more than the chain can deliver.
        const basis = direct ? Math.min(pool.committed, capturable(defender, updatedPolicy ? escrow : Infinity, pool.committed) ?? pool.committed) : pool.committed;
        captured = Math.min(Math.floor(basis*bchPolicy.capturePercent/100),updatedPolicy?escrow:Infinity);
        if (direct && captured < 600) captured = 0;
        checkedTotal(source.total, escrow + captured);
        defenderAfter = checkedTotal(pool.total, -captured);
        committedAfter = pool.committed - captured;
        effect = 'escrow-returned-and-captured';
      } else {
        const forfeited=updatedPolicy?Math.floor(escrow*bchPolicy.defenderForfeitPercent/100):escrow;
        forfeitedSatoshis = forfeited;
        if (!direct) source.total=checkedTotal(source.total,escrow-forfeited);
        recipient = defender;
        defenderAfter = direct ? pool.total : checkedTotal(pool.total, forfeited);
        effect = 'escrow-awarded-to-defender';
      }
      pool.total = defenderAfter;
      pool.committed = committedAfter;
      if (pool.release) pool.release.amount = Math.min(pool.release.amount, pool.committed);
      treasury.records.push({ kind: 'battle-limit', pair, now });
      contest = { distinctVerifiedWallets: true, defenderCommitment, pairCooldownHours: DAY / HOUR, captureLimitPercent:bchPolicy.capturePercent,
        ...(updatedPolicy && {captureLimitSatoshis:escrow,defenderForfeitPercent:bchPolicy.defenderForfeitPercent}) };
    }
  }
  if (recipient === attacker && !direct) source.total = checkedTotal(source.total, escrow + captured);
  if (chest) {
    // The War Chest share is at risk from the moment it is credited. There is no safe balance and no separate commitment.
    unlock(source, now);
    source.committed += escrow;
    const identity = walletIdentity(linked(attacker));
    if (identity) source.riskWallet = identityCommitment(identity);
  }
  const settlement = { kind: owner.role === 'battle' && outcome ? 'battle' : 'payment', effect, payment: row.id, txid: row.txid,
    outpoint, allocation, attacker, defender: defender ?? null, winner: outcome?.winner ?? null, recipient,
    escrowSatoshis: escrow, capturedSatoshis: captured, now, contest, ...(updatedPolicy && {allocationPolicy:GAMEPLAY_ALLOCATION,
      ...(owner.role==='battle' && {stakePayouts:{attacker:recipient===attacker?escrow:escrow-forfeitedSatoshis,
        defender:recipient===attacker?0:forfeitedSatoshis}}),
      ...(direct && !matched && {custody:STAKE_ESCROW,stakeLane:recipient===attacker?'return':'opponent-wins'})}),
    ...(matched && { custody:MATCHED_ESCROW, stakeLane:lane ?? 'void', matched:true,
      stakePayouts:{ attacker:lane==='attacker-wins' ? 2 * escrow : lane==='defender-wins' ? 0 : escrow, defender:lane==='defender-wins' ? escrow : 0 } }), balances: {
      attacker: { before: attackerBefore, after: source.total },
      defender: defenderBefore === null ? null : { before: defenderBefore, after: defenderAfter, committedBefore, committedAfter }
    } };
  treasury.settled[row.id] = true;
  treasury.records.push(settlement);
  if (outcome?.winner) outcome.treasury = settlement;
  return settlement;
}

// `chest` marks a withdrawal paid from War Chest covenant outputs: that money is at risk until the moment it leaves.
function canWithdraw(world, player, value, now = Date.now(), { chest = false } = {}) {
  requirePlayer(world, player);
  if (chest) {
    if (!Number.isSafeInteger(value) || value <= 0 || balance(world, player, now).atRiskSatoshis < value) fault(409, 'Your War Chest does not cover the amount and fee.');
    return true;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || balance(world, player, now).availableKingdomSatoshis < value) {
    fault(409, 'Your uncommitted kingdom funds do not cover the amount and fee.');
  }
  return true;
}

function debit(world, player, value, payment, now, { chest = false } = {}) {
  const book = ledger(world);
  const prior = book.records.find(record => record.kind === 'withdrawal' && record.payment === payment);
  if (prior) {
    if (prior.player !== player || prior.satoshis !== value) fault(409, 'This withdrawal ID already belongs to another debit.');
    return prior;
  }
  canWithdraw(world, player, value, now, { chest });
  const account = get(world, player);
  unlock(account, now);
  const before = account.total;
  account.total = checkedTotal(account.total, -value);
  if (chest) account.committed = Math.max(0, account.committed - value);
  const entry = { kind: 'withdrawal', payment, player, satoshis: value, before, after: account.total, now, ...(chest && { chest: true }) };
  book.records.push(entry);
  return entry;
}

// A cancelled withdrawal returns to its kingdom, less the network fee spent by the cancellation.
function restore(world, player, payment, feeSatoshis, now) {
  const book = ledger(world);
  const debit = book.records.find(record => record.kind === 'withdrawal' && record.payment === payment && record.player === player);
  if (!debit || book.records.some(record => record.kind === 'withdrawal-restored' && record.payment === payment)) return null;
  const account = get(world, player);
  const satoshis = Math.max(0, debit.satoshis - (Number.isSafeInteger(feeSatoshis) && feeSatoshis > 0 ? feeSatoshis : 0));
  const before = account.total;
  account.total = checkedTotal(account.total, satoshis);
  if (debit.chest) account.committed += satoshis;
  const entry = { kind:'withdrawal-restored', payment, player, satoshis, before, after:account.total, now };
  book.records.push(entry);
  return entry;
}

// A funding transaction that left the chain for good takes its ledger credit with it.
function reverse(world, row, now) {
  const book = ledger(world);
  const settlement = book.records.find(record => record.payment === row.id && ['battle','payment'].includes(record.kind));
  if (!settlement || book.records.some(record => record.kind === 'reversal' && record.payment === row.id)) return null;
  const changes = [];
  for (const side of ['attacker','defender']) {
    const player = settlement[side];
    const delta = settlement.balances?.[side] ? settlement.balances[side].after - settlement.balances[side].before : 0;
    if (!player || !delta) continue;
    const account = get(world, player);
    const before = account.total;
    const after = Math.max(0, before - delta);
    account.total = after;
    account.committed = Math.min(account.committed, after);
    if (account.release) account.release.amount = Math.min(account.release.amount, after);
    changes.push({ player, before, after, shortfall: Math.max(0, delta - before) });
  }
  const entry = { kind:'reversal', payment:row.id, txid:row.txid, changes, now };
  book.records.push(entry);
  return entry;
}

// A war chest deposit confirmed on chain. It is at risk from the moment it is credited: its owner's wallet signed for that.
function fundChest(world, player, satoshis, payment, now, verifiedAddress) {
  requirePlayer(world, player);
  const book = ledger(world);
  const prior = book.records.find(record => record.kind === 'chest-funded' && record.payment === payment);
  if (prior) return prior;
  const identity = walletIdentity(verifiedAddress);
  if (!identity) fault(403, 'Verify a ' + NETWORK_LABEL + ' wallet before funding a war chest.');
  const account = get(world, player);
  unlock(account, now);
  const before = account.total;
  account.total = checkedTotal(account.total, satoshis);
  account.committed += satoshis;
  if (account.release) account.release.amount += satoshis;
  account.riskWallet = identityCommitment(identity);
  const entry = { kind:'chest-funded', payment, player, satoshis, before, after:account.total, committed:account.committed, now };
  book.records.push(entry);
  return entry;
}

// Money that left a kingdom vault or war chest on chain without the game: the owner's own recovery, or a correction after one.
function recovered(world, player, satoshis, payment, now) {
  const book = ledger(world);
  const prior = book.records.find(record => record.kind === 'owner-recovery' && record.payment === payment);
  if (prior) return prior;
  const account = get(world, player);
  const before = account.total;
  account.total = Math.max(0, before - satoshis);
  account.committed = Math.min(account.committed, account.total);
  if (account.release) account.release.amount = Math.min(account.release.amount, account.total);
  const entry = { kind:'owner-recovery', payment, player, satoshis, before, after:account.total, now };
  book.records.push(entry);
  return entry;
}

function releaseTerritory(world, payment, payouts, total, now) {
  const book = ledger(world);
  const prior = book.records.find(record => record.kind === 'territory-release' && record.payment === payment);
  if (prior) return prior;
  if (!Number.isSafeInteger(total) || total <= 0 || !Array.isArray(payouts) ||
      new Set(payouts.map(item => item.player)).size !== payouts.length ||
      payouts.some(item => !Number.isSafeInteger(item.satoshis) || item.satoshis < 0) ||
      payouts.reduce((sum,item) => sum + item.satoshis, 0) !== total) throw new Error('Territory escrow does not conserve its confirmed principal.');
  const balances = payouts.map(({player,satoshis}) => {
    requirePlayer(world,player);
    const account = get(world,player);
    return { player, account, before:account.total, after:checkedTotal(account.total,satoshis), satoshis };
  });
  for (const entry of balances) entry.account.total = entry.after;
  const record = { kind:'territory-release', payment, now, satoshis:total,
    payouts:balances.map(({account,...entry}) => entry) };
  book.records.push(record);
  return record;
}

// A matched capture that can no longer be paid on chain (the defender's exit completed before the attestors signed). The
// stake returns to the attacker instead, and the defender's account takes back what was never captured.
function voidCapture(world, payment, now) {
  const book = ledger(world);
  const entry = book.records.find(record => record.payment === payment && record.kind === 'battle' && record.matched && record.stakeLane === 'attacker-wins');
  if (!entry || book.records.some(record => record.kind === 'capture-voided' && record.payment === payment)) return null;
  const account = get(world, entry.defender);
  const before = account.total;
  account.total = checkedTotal(account.total, entry.capturedSatoshis);
  const record = { kind: 'capture-voided', payment, defender: entry.defender, attacker: entry.attacker, satoshis: entry.capturedSatoshis, before, after: account.total, now };
  entry.stakeLane = 'void';
  entry.voided = true;
  book.records.push(record);
  return record;
}

export const kingdom = { balance, commit, split, apply, canWithdraw, debit, restore, reverse, releaseTerritory, fundChest, recovered, voidCapture, riskLimit };
