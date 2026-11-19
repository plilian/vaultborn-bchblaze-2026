import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { decodeAddress } from '../../packages/chain-observer/index.mjs';
import { LEGACY_SPONSOR_ALLOCATION, SPONSOR_ALLOCATION, sponsorshipAllocation, sponsorshipPolicy } from '../../config/payments.mjs';
import { summarizeSponsorship } from './sponsorship.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';

const day = 86_400_000;
const packages = Object.freeze([
  { id: 'standard', name: 'Season banner', satoshis: 50_000_000, placement: 'banner' },
  { id: 'champion', name: 'Title sponsor', satoshis: 200_000_000, placement: 'tournament' },
]);
const digest = value => createHash('sha256').update(value).digest();
const id = () => randomUUID();

export function createPortal({ store, clock, fail, adminToken, sponsorshipMinimumSatoshis = sponsorshipPolicy.minimumSatoshis }) {
  const adminSecret = typeof adminToken === 'string' && adminToken.length >= 32 ? digest(adminToken) : null;

  function administrator(req) {
    const token = req.headers.authorization?.match(/^Bearer (\S{32,256})$/)?.[1];
    return Boolean(adminSecret && token && timingSafeEqual(adminSecret, digest(token)));
  }

  function requireAdmin(req) {
    if (!administrator(req)) fail(403, 'Administrator authorization is required.');
  }

  function text(value, minimum, maximum) {
    const result = typeof value === 'string' ? value.trim().replace(/[\x00-\x1f\x7f]/g, ' ') : '';
    if (result.length < minimum || result.length > maximum) fail(400, 'Check the length of each text field.');
    return result;
  }

  function website(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 256) throw new Error();
      return url.href;
    } catch { fail(400, 'Use a public HTTPS sponsor website.'); }
  }

  function parseLogo(value) {
    if (!value) return null;
    const match = typeof value === 'string' && value.match(/^data:image\/(png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length > 10_000) fail(400, 'Use a PNG or WebP logo smaller than 7 KB.');
    const image = Buffer.from(match[2], 'base64');
    const png = image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const webp = image.subarray(0, 4).toString() === 'RIFF' && image.subarray(8, 12).toString() === 'WEBP';
    if (match[1] === 'png' ? !png : !webp) fail(400, 'Invalid logo contents.');
    return { type: 'image/' + match[1], data: match[2] };
  }

  function sponsorView(campaign, deposits, privateView = false) {
    const rows = deposits.filter(row => row.payload?.campaignId === campaign.id && row.action === 'sponsor-fund');
    const allocation = summarizeSponsorship(rows, clock());
    const received = allocation.confirmed.total;
    const funded = campaign.status === 'approved' && received >= campaign.amount;
    const active = funded && campaign.start <= clock() && clock() < campaign.end;
    const completed = funded && campaign.end <= clock();
    const logoUrl = campaign.logo ? '/api/public/sponsors/' + campaign.id + '/logo' : null;
    const { owner, logo, decision, ...publicData } = campaign;
    return { ...publicData, logoUrl, active, completed, received,
      allocation: { policy: campaign.policy ?? LEGACY_SPONSOR_ALLOCATION,
        quoted: sponsorshipAllocation(campaign.amount, undefined, campaign.policy ?? LEGACY_SPONSOR_ALLOCATION),
        confirmed: allocation.confirmed, ...(privateView && { pending: allocation.pending }) },
      ...((active || completed) && campaign.placement === 'tournament' && { standings:tournamentStandings(campaign) }),
      ...(privateView && { decision, analytics: store.sponsorAnalytics(campaign.id) }) };
  }

  function sponsors(player) {
    const rows = store.payments();
    const campaigns = store.portalRows('sponsor').map(item => [item, sponsorView(item, rows, item.owner === player)]);
    return { packages: packages.map(item => ({ ...item, allocation:sponsorshipAllocation(item.satoshis) })),
      allocationRules: { version: SPONSOR_ALLOCATION, ...sponsorshipPolicy, minimumSatoshis: sponsorshipMinimumSatoshis },
      publicCampaigns: campaigns.filter(([, view]) => view.active).map(([, view]) => view),
      completedTournaments: campaigns.filter(([, view]) => view.completed && view.placement === 'tournament').slice(0,8).map(([, view]) => view),
      own: player ? campaigns.filter(([item]) => item.owner === player).map(([, view]) => view) : [] };
  }

  function tournamentStandings(campaign) {
    const { world } = store.read();
    const scores = new Map();
    const encounters = new Set();
    // Score the earliest eligible result for each unordered pair on a UTC day.
    for (const battle of world.battles.slice().reverse()) {
      if (battle.kind !== 'raid' || battle.at < campaign.start || battle.at >= campaign.end) continue;
      const a = world.cities[battle.attacker];
      const d = world.cities[battle.defender];
      if (!a || !d || a.npc || d.npc) continue;
      const pair = [a.id,d.id].sort().join(':') + ':' + Math.floor(battle.at / day);
      if (encounters.has(pair)) continue;
      encounters.add(pair);
      const winner = battle.winner === 'attacker' ? a : d;
      const earned = battle.winner === 'attacker' ? 15 : 10;
      const entry = scores.get(winner.id) ?? { id:winner.id, city:winner.name, points:0, wins:0 };
      entry.points += earned;
      entry.wins += 1;
      scores.set(winner.id,entry);
    }
    return [...scores.values()].sort((a,b) => b.points - a.points || b.wins - a.wins || a.id.localeCompare(b.id,'en-US')).slice(0,10);
  }

  function proposeSponsor(player, body) {
    const slot = packages.find(item => item.id === body.package);
    if (!slot) fail(400, 'Choose an available sponsorship package.');
    const { world } = store.read();
    const start = body.start;
    const end = body.end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < clock() + 60_000 ||
        end - start < 3_600_000 || end > world.season.endsAt) fail(400, 'Schedule at least one hour within the current season, with a future start.');
    if (store.portalRows('sponsor').filter(c => c.owner === player && c.status !== 'denied' && c.end > clock()).length >= 4) {
      fail(409, 'You already have four open sponsorships.');
    }
    const campaign = { id: id(), owner: player, title: text(body.title, 2, 80), sponsor: text(body.sponsor, 2, 52),
      blurb: text(body.blurb, 0, 180), link: website(body.link), logo: parseLogo(body.logo),
      package: slot.id, placement: slot.placement, amount: slot.satoshis, start, end,
      policy: SPONSOR_ALLOCATION, seasonId: world.season.number, status: 'pending', createdAt: clock() };
    store.savePortal('sponsor', campaign.id, campaign);
    return sponsorView(campaign, [], true);
  }

  function reviewSponsor(body) {
    if (typeof body.id !== 'string') fail(400, 'Choose a sponsorship campaign.');
    const campaign = store.portal('sponsor', body.id);
    if (!campaign || campaign.status !== 'pending' || campaign.start <= clock()) fail(409, 'This campaign can no longer be approved.');
    if (!['approved', 'denied'].includes(body.decision)) fail(400, 'Choose approve or decline.');
    const decision = { status: body.decision, note: text(body.note, 0, 180), at: clock() };
    if (body.decision === 'approved' && campaign.placement === 'tournament' && store.portalRows('sponsor')
      .some(item => item.status === 'approved' && item.placement === 'tournament' && item.start < campaign.end && item.end > campaign.start)) {
      fail(409, 'A title sponsor already has this tournament slot.');
    }
    const updated = { ...campaign, status: decision.status, decision };
    store.savePortal('sponsor', campaign.id, updated);
    return sponsorView(updated, store.payments(), true);
  }

  function campaignFunding(player, givenId) {
    const campaign = store.portal('sponsor', givenId);
    if (!campaign || campaign.owner !== player || campaign.status !== 'approved' || campaign.start <= clock()) fail(409, 'This sponsorship is not awaiting funding.');
    const payments = store.payments(player).filter(row => row.payload?.campaignId === givenId);
    if (payments.some(row => row.state === 'credited')) fail(409, 'This sponsorship has been funded.');
    return campaign;
  }

  function activeSponsor(givenId) {
    const item = store.portal('sponsor', givenId);
    if (!item || !sponsorView(item, store.payments()).active) fail(404, 'Sponsorship unavailable.');
    return item;
  }

  function trackSponsor(player, givenId, kind) {
    const campaign = activeSponsor(givenId);
    if (!['impression', 'click'].includes(kind)) fail(400, 'Unknown sponsor event.');
    store.sponsorEvent(givenId, player, Math.floor(clock() / day), kind);
    return kind === 'click' ? { link: campaign.link } : {};
  }

  function members() {
    return Object.values(store.read().world.cities).flatMap(city => {
      if (city.npc || !city.tutorial || city.score < 10) return [];
      return store.wallet(city.id) ? [city.id] : [];
    });
  }

  function proposalView(proposal, player) {
    const { voters, votes, proposer, ...fields } = proposal;
    const totals = Object.values(votes).reduce((acc, vote) => ({ ...acc, [vote]: acc[vote] + 1 }), { yes: 0, no: 0, abstain: 0 });
    const participation = totals.yes + totals.no + totals.abstain;
    const passed = participation >= proposal.quorum && totals.yes > 0 && totals.yes * 5 >= (totals.yes + totals.no) * 3;
    const payout = store.payments().find(row => row.payload?.proposalId === proposal.id);
    const status = payout ? 'spending' : clock() < proposal.endsAt ? 'open' : passed ? 'passed' : 'rejected';
    return { ...fields, totals, status: payout?.state === 'credited' ? 'paid' : status,
      voterCount: voters.length, canVote: voters.includes(player) && status === 'open',
      vote: votes[player] ?? null, yours: proposer === player, txid: payout?.txid ?? null };
  }

  function proposals(player) {
    const eligible = members();
    return { eligible: eligible.includes(player), members: eligible.length, minimumMembers: 3, passingPercent: 60,
      proposals: store.portalRows('proposal').slice(0, 50).map(row => proposalView(row, player)) };
  }

  function propose(player, body) {
    const voters = members();
    if (voters.length < 3 || !voters.includes(player)) fail(403, 'Proposals require three active members with verified ' + NETWORK_LABEL + ' wallets.');
    const { satoshis } = body;
    if (!Number.isSafeInteger(satoshis) || satoshis < 600 || satoshis > 100_000) fail(400, 'Propose a transfer of 600 to 100,000 satoshis.');
    let address;
    try { address = decodeAddress(body.address).address; } catch { fail(400, 'Use a valid ' + NETWORK_LABEL + ' payout address.'); }
    const now = clock();
    if (store.portalRows('proposal').some(row => row.proposer === player && row.endsAt > now)) fail(409, 'You already have an active proposal.');
    const item = { id: id(), proposer: player, title: text(body.title, 4, 85), reason: text(body.reason, 10, 500),
      address, satoshis, voters, votes: {}, quorum: Math.max(3, Math.ceil(voters.length / 4)),
      createdAt: now, endsAt: now + 3 * day };
    store.savePortal('proposal', item.id, item);
    return proposalView(item, player);
  }

  function vote(player, body) {
    if (typeof body.id !== 'string') fail(400, 'Choose a spending proposal.');
    const item = store.portal('proposal', body.id);
    if (!item || !proposalView(item, player).canVote) fail(403, 'This vote is unavailable for your account.');
    if (!['yes', 'no', 'abstain'].includes(body.vote)) fail(400, 'Choose yes, no, or abstain.');
    const updated = { ...item, votes: { ...item.votes, [player]: body.vote } };
    store.savePortal('proposal', item.id, updated);
    return proposalView(updated, player);
  }

  function approvedSpend(givenId) {
    if (typeof givenId !== 'string') fail(400, 'Choose a spending proposal.');
    const item = store.portal('proposal', givenId);
    if (!item || proposalView(item, null).status !== 'passed') fail(409, 'Only an approved, unpaid spending proposal can be executed.');
    return item;
  }

  return { administrator, requireAdmin, sponsors, proposeSponsor, reviewSponsor, campaignFunding, trackSponsor,
    activeSponsor, proposals, propose, vote, approvedSpend,
    adminList: () => store.portalRows('sponsor').map(campaign => sponsorView(campaign, store.payments(), true)) };
}
