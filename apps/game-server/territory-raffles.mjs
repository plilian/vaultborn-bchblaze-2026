import { parseHeader } from '../../packages/chain-observer/primitives.mjs';
import { protocolHash } from '../../packages/chain-observer/vaultborn.mjs';
import { GAMEPLAY_ALLOCATION, LEGACY_PRICING, paymentPrice, stakePrice } from '../../config/payments.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';
import { ADDRESS_PATTERN, NETWORK_ID } from '../../config/network.mjs';

const hour = 3_600_000;
const hex64 = /^[a-f0-9]{64}$/;
export const rafflePolicy = Object.freeze({
  fee: 7_400, leaseHours: 72, roundBlocks: 36, lastEntryOffset: 19, drawOffset: 27,
  drawConfirmations: 6, maxEntrants: 8, timeoutHours: 48,
});

const fail = (status, text) => { throw Object.assign(new Error(text), { status }); };
const stateFor = (world, site) => (world.territoryRaffles ??= {})[site] ??= { round: null, lease: null, history: [] };
const linkedHash = value => protocolHash({ policy: 'vaultborn-rare-wallet-v1', address: value });
const byTxid = (a, b) => a.txid < b.txid ? -1 : Number(a.txid > b.txid);
const active = (lease, now) => lease && lease.startsAt <= now && lease.expiresAt > now;

export function raffleWindow(site, tip, policy = rafflePolicy) {
  if (!Number.isSafeInteger(tip) || tip < policy.roundBlocks) fail(503, '' + NETWORK_LABEL + ' has no current raffle schedule.');
  const offset = policy.offset ?? 0;
  const startHeight = tip - ((tip - offset) % policy.roundBlocks);
  return { id: 'rare-' + site + '-' + startHeight, site, startHeight,
    closeHeight: startHeight + policy.lastEntryOffset, drawHeight: startHeight + policy.drawOffset,
    confirmations: policy.drawConfirmations, fee: policy.fee, cutoff: 'block-height', protocol: 'vaultborn-raffle-v1' };
}

function eligibility(world, rounds, site, player, address, now, policy) {
  const city = world.cities[player];
  if (!city?.tutorial || city.npc || typeof address !== 'string' || !ADDRESS_PATTERN.test(address) || address !== address.toLowerCase()) {
    fail(403, 'Connect your wallet first. Entering needs a finished tutorial and a ' + NETWORK_LABEL + ' wallet of your own.');
  }
  const wallet = linkedHash(address);
  const alliance = city.alliance ?? null;
  for (const [otherSite, draw] of Object.entries(rounds)) {
    if (active(draw.lease, now) && (draw.lease.playerId === player || (alliance && draw.lease.alliance === alliance))) {
      fail(409, 'Your city or alliance already holds a rare lease.');
    }
    const open = draw.round;
    if (!open || open.status !== 'open') continue;
    if (otherSite === site && open.entries.length >= policy.maxEntrants) fail(409, 'This raffle has reached its entrant limit.');
    if (open.entries.some(entry => entry.player === player || entry.wallet === wallet || (alliance && entry.alliance === alliance))) {
      fail(409, 'Each wallet and alliance can enter one active rare raffle.');
    }
  }
  return { wallet, alliance };
}

export function quoteRaffle(world, player, site, address, head, now, policy = rafflePolicy) {
  if (head?.network !== NETWORK_ID) fail(503, 'Rare raffles require the ' + NETWORK_LABEL + ' observer.');
  const current = world.territoryRaffles?.[site];
  if (active(current?.lease, now)) fail(409, 'This site already has an exclusive lease.');
  const bounds = raffleWindow(site, head.height, policy);
  if (head.height >= bounds.closeHeight) fail(409, 'The entry window is closed. Follow the draw or wait for the next round.');
  if (current?.round?.status === 'open' && current.round.id !== bounds.id) fail(409, 'Wait for the previous draw to settle.');
  const voter = eligibility(world, world.territoryRaffles ?? {}, site, player, address, now, policy);
  return { action: { type: 'territory-raffle', territory: site, round: bounds, wallet: voter.wallet },
    title: 'Rare territory raffle entry',
    description: 'The winner holds this territory for 72 hours. Every entrant gets the escrow back after the draw.',
    satoshis: policy.fee };
}

export function acceptRaffle(world, row, address, now, policy = rafflePolicy) {
  const { payload, txid, receipt, id, playerId } = row;
  const site = payload.territory;
  const bounds = payload.round;
  const included = receipt?.height;
  const expected = raffleWindow(site, bounds.startHeight, policy);
  if (protocolHash(bounds) !== protocolHash(expected) || !Number.isSafeInteger(included) ||
      included < bounds.startHeight || included > bounds.closeHeight || !hex64.test(txid ?? '')) {
    fail(409, 'This entry was not included in its announced ' + NETWORK_LABEL + ' window.');
  }
  const draw = stateFor(world, site);
  if (active(draw.lease, now)) fail(409, 'The territory has an active lease.');
  if (!draw.round || draw.round.id !== bounds.id) {
    if (draw.round?.status === 'open' || draw.history.some(item => item.round.id === bounds.id)) fail(409, 'This raffle can no longer accept entries.');
    draw.round = { ...bounds, openedAt: now, timeoutAt: now + policy.timeoutHours * hour, status: 'open', entries: [] };
  }
  if (draw.round.status !== 'open') fail(409, 'The draw has already been recorded.');
  const voter = eligibility(world, world.territoryRaffles, site, playerId, address, now, policy);
  if (payload.wallet !== voter.wallet) fail(409, 'The verified wallet changed after this raffle was quoted.');
  const stake = receipt.allocations?.find(output => output.role === 'battle' || output.role === 'escrow');
  const escrow = stake?.battleSatoshis ?? stake?.satoshis;
  const pricing = row.event?.data.pricing ?? LEGACY_PRICING;
  const principal = pricing === LEGACY_PRICING ? policy.fee / 2 : stakePrice('territory-raffle', pricing).principal;
  if (escrow !== principal || (row.event?.data.allocationPolicy===GAMEPLAY_ALLOCATION &&
    row.satoshis!==paymentPrice('territory-raffle',policy.fee,GAMEPLAY_ALLOCATION,pricing))) throw new Error('The confirmed rare entry does not contain its escrow.');
  const entry = { id, txid, player: playerId, included, wallet: voter.wallet, alliance: voter.alliance,
    escrowSatoshis: escrow, at: now };
  draw.round.entries.push(entry);
  return { territory: site, round: bounds.id, entry };
}

export function raffleSample(round, block) {
  const header = parseHeader(block.raw);
  if (block.network !== NETWORK_ID || block.height !== round.drawHeight || header.hash !== block.hash ||
      block.confirmations < round.confirmations) throw new Error('The draw block does not match the announced raffle.');
  const entries = [...round.entries].sort(byTxid);
  if (!entries.length || new Set(entries.map(entry => entry.txid)).size !== entries.length ||
      entries.some(entry => !hex64.test(entry.txid))) throw new Error('Invalid raffle entry set.');
  const roster = entries.map(({ txid, player, included, wallet, alliance, escrowSatoshis }) => ({ txid, player, included, wallet, alliance, escrowSatoshis }));
  const rosterHash = protocolHash(roster);
  const count = BigInt(roster.length);
  const span = 1n << 256n;
  const threshold = span - span % count;
  for (let nonce = 0; nonce < 1000; nonce++) {
    const sample = protocolHash({ version: 1, round: round.id, rosterHash, blockHash: header.hash, nonce });
    const value = BigInt('0x' + sample);
    if (value < threshold) return { roster, rosterHash, sample, nonce, index: Number(value % count), winner: roster[Number(value % count)].player };
  }
  throw new Error('No unbiased draw could be produced.');
}

function finish(world, draw, block, now, policy) {
  const round = draw.round;
  if (!round || round.status !== 'open' || !round.entries.length) return;
  const payout = round.entries.map(entry => ({ player: entry.player, satoshis: entry.escrowSatoshis }));
  const result = block ? raffleSample(round, block) : null;
  const previous = draw.history.find(record => record.lease)?.lease;
  const lease = result ? {
    id: round.id + '-lease', playerId: result.winner, alliance: round.entries.find(entry => entry.player === result.winner).alliance,
    startsAt: now, expiresAt: now + policy.leaseHours * hour,
    ...(previous?.playerId === result.winner && { renewalOf:previous.id }),
  } : null;
  round.status = result ? 'drawn' : 'refunded';
  draw.lease = lease;
  const record = { id: round.id + '-settlement', territoryId: round.site, kind: 'raffle',
    round: structuredClone(round), entries: round.entries, winner: result?.winner ?? null, payout,
    block, result, lease: lease && { ...lease }, at: now,
    ...(result ? {} : { reason: '' + NETWORK_LABEL + ' draw timeout. The escrow was returned to each entrant.' }) };
  draw.history.unshift(record);
  (world.territorySettlements ??= []).push(record);
  return record;
}

export function advanceRaffles(world, { now, blocks = new Map(), ready = () => true, policy = rafflePolicy }) {
  const changes = [];
  for (const [site, raffle] of Object.entries(world.territoryRaffles ?? {})) {
    const round = raffle.round;
    if (round?.status === 'open') {
      const block = blocks.get(round.drawHeight);
      if (block?.confirmations >= round.confirmations && ready(round)) changes.push(finish(world, raffle, block, now, policy));
      else if (now >= round.timeoutAt) changes.push(finish(world, raffle, null, now, policy));
    }
    if (raffle.lease && raffle.lease.expiresAt <= now) {
      const expired = { ...raffle.lease };
      raffle.lease = null;
      const record = { id: expired.id + '-expired', territoryId:site, kind:'lease-expired', lease:expired,
        preceding: raffle.history[0]?.id, at:expired.expiresAt, entries:[], payout:[] };
      (world.territorySettlements ??= []).push(record);
      changes.push(record);
    }
  }
  return changes.filter(Boolean);
}

export function publicRaffle(world, site, head, now, policy = rafflePolicy) {
  const draw = world.territoryRaffles?.[site];
  const upcoming = head?.height ? raffleWindow(site, head.height, policy) : null;
  const announced = draw?.round?.status === 'open' ? draw.round : upcoming ?? draw?.round;
  const open = announced && head?.height >= announced.startHeight && head?.height < announced.closeHeight && upcoming?.id === announced.id;
  return { fee: policy.fee, leaseHours: policy.leaseHours, round: announced ?? null,
    height: head?.height ?? null, open: Boolean(open && !active(draw?.lease, now)), lease: active(draw?.lease, now) ? draw.lease : null,
    history: (draw?.history ?? []).slice(0, 12) };
}
