// Independent attestor for prize awards and war chest captures. Run it on a schedule (cron, Task Scheduler) with --approve so that no person has to act.
// Independent prize attestor. Run it on a machine the game operator does not control, with a key the game server never sees.
//   PRIZE_ATTESTOR_KEY_FILE=<hex key file> node scripts/prize-attest.mjs <game origin, e.g. http://127.0.0.1:8787> [award id] [--approve]
// Without --approve it only prints what it checked. It signs nothing it could not rebuild and verify itself.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { walletFromPrivateKey } from '../packages/chain-observer/primitives.mjs';
import { decodeAddress, signAttestorRequest } from '../packages/chain-observer/index.mjs';
import { planStakeSpend, signStakeDigest, stakeEscrow } from '../packages/chain-observer/stake-escrow.mjs';
import { chestFeeder } from '../packages/chain-observer/chest-feeder.mjs';
import { planPrizeAward, prizeFund, signPrizeAward } from '../packages/chain-observer/prize-fund.mjs';
import { captureDigests, kingdomVault, planChestCapture, signCaptureDigests } from '../packages/chain-observer/kingdom-vault.mjs';
import { verifyBattle } from '../apps/game-server/battle-records.mjs';
import { auditSeason } from './season-audit.mjs';
import { checkRaid } from './attestor-review.mjs';
import { signRaidDigest } from '../packages/chain-observer/matched-raid.mjs';
import { NETWORK_ID } from '../config/network.mjs';

const args = process.argv.slice(2);
const approve = args.includes('--approve');
const [origin, only] = args.filter(item => item !== '--approve');
if (!origin || !process.env.PRIZE_ATTESTOR_KEY_FILE) throw new Error('Supply the game origin and PRIZE_ATTESTOR_KEY_FILE.');
const privateKey = (await readFile(process.env.PRIZE_ATTESTOR_KEY_FILE, 'utf8')).trim();
const me = walletFromPrivateKey(privateKey).publicKey;
const read = async path => {
  const response = await fetch(origin + path);
  if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status);
  return response.json();
};
// An attestor signs for one network only: its own (VAULTBORN_NETWORK). A server of another network is refused outright.
const served = (await read('/api/health')).network;
if (served !== NETWORK_ID) throw new Error('This server runs on ' + served + ', but this attestor is configured for ' + NETWORK_ID + '. Set VAULTBORN_NETWORK.');
const { pending } = await read('/api/public/prize-awards');
// This attestor's own record of what it has seen and signed. It is what makes a second, different request for the same
// stake, or a rewritten season, visible to it.
const pinFile = process.env.PRIZE_ATTESTOR_PINS ?? 'prize-attestor-pins.json';
const loadPins = () => readFile(pinFile, 'utf8').then(JSON.parse).catch(() => ({}));
const savePin = async (name, value) => { const pins = await loadPins(); pins[name] = value; await writeFile(pinFile, JSON.stringify(pins, null, 2) + '\n'); };
// The evidence behind a proposal, asked for with a signature of this attestor's key. Battle records are not public for a day.
const evidenceOf = async id => {
  const response = await fetch(origin + '/api/public/prize-awards/' + id + '/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: me, signature: signAttestorRequest(id, privateKey) }) });
  return response.ok ? (await response.json()).result : null;
};
const scriptOf = address => { try { return decodeAddress(address).script; } catch { return null; } };
const submit = async (id, signatures) => {
  const response = await fetch(origin + '/api/public/prize-awards/' + id + '/attest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey: me, signatures }) });
  console.log('attested', id, response.status, (await response.json()).result?.state ?? 'refused');
};

// A stake settlement: the outcome of a paid raid or a territory contest. The server proposes a lane; this attestor replays
// the battles that decided it and signs only the lane that follows from them.
async function reviewStake(item) {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  check(item.attestors.includes(me), 'this key is not on the outcome panel of this stake');
  const source = item.sources[0];
  const contract = stakeEscrow(source.escrow);
  check(contract.script === source.script && source.satoshis === contract.satoshis, 'the input is not the stake escrow its terms describe');
  const plan = planStakeSpend(source, { lane: item.lane, payee: item.payeeScript ?? undefined, eventScript: item.eventScript ?? undefined });
  check(plan.digest === item.digests[0], 'the server digest does not match the rebuilt transaction');
  const evidence = await evidenceOf(item.id);
  check(evidence, 'the server gave no evidence for this proposal');
  const replayed = (evidence?.battles ?? []).map(entry => ({ ...entry.record.battle, initiation: entry.record.initiation, sound: verifyBattle(entry.record.battle) === true }));
  check(replayed.every(battle => battle.sound), 'replaying a recorded battle does not reproduce its result');
  check(evidence?.payment?.txid === source.txid, 'the evidence belongs to another payment');
  check(item.payerWallet === contract.ownerAddress, 'the stake owner is not the verified wallet of the paying player');
  const pins = await loadPins();
  const outpoint = source.txid + ':' + source.vout;
  check(!pins['stake:' + outpoint] || pins['stake:' + outpoint] === plan.digest, 'this attestor already signed a different outcome for this stake');
  if (contract.kind === 'territory-claim' && evidence?.notEntered && !evidence?.contest) {
    // The game could not enter this claim when its payment became final: the whole stake returns to the claimant's own wallet.
    check(item.lane === 'return', 'a claim that was never entered can only return to its claimant');
    notes.push('the claim was never entered' + (evidence.notEntered.reason ? ': ' + evidence.notEntered.reason : '') + '; the stake returns to its claimant');
  } else if (contract.kind === 'territory-claim') {
    // An open claim: the claimant keeps everything unless another claimant won the contest; then half goes to that winner's wallet.
    check(evidence?.contest, 'there is no contest record for this claim');
    const victor = evidence?.contest?.victor ?? null;
    const lost = Boolean(victor && victor !== item.payer);
    check(item.lane === (lost ? 'forfeit' : 'return'), 'the lane does not follow the contest record');
    if (lost) check(item.victor === victor && item.payeeScript === scriptOf(item.victorWallet), 'the forfeited half does not pay the verified wallet of the contest winner');
    notes.push(replayed.length ? `${replayed.length} battle(s) of the contest replayed` : 'the contest record names its winner; it holds no battle to replay');
  } else {
    // A raid or a territory attack: one battle, started by this very payment, decides between the two fixed wallets.
    const fought = replayed.find(battle => battle.initiation?.txid === source.txid) ?? (contract.kind === 'territory-escrow' ? replayed.at(-1) : null);
    check(fought, 'no recorded battle was started by this stake payment');
    if (fought) {
      check(fought.attacker === item.payer, 'the recorded attacker is not the player who paid this stake');
      if (item.defenderWallet) check(scriptOf(item.defenderWallet) === contract.opponent && fought.defender === item.defender, 'the opponent fixed in the escrow is not the recorded defender');
      const expected = fought.winner === 'attacker' ? 'return' : 'opponent-wins';
      if (item.lane !== expected) {
        // A lost raid still returns the stake when the pair already had a settled raid within 24 hours. That is checked against this attestor's own log.
        const last = pins['pair:' + contract.ownerScript + '>' + contract.opponent];
        check(item.lane === 'return' && last && fought.at - last < 86_400_000 && fought.at > last, `the replayed battle was won by the ${fought.winner}; the proposed lane "${item.lane}" does not follow from it`);
      }
    }
  }
  console.log(JSON.stringify({ stake: item.id, kind: contract.kind, payment: item.payment, lane: item.lane, panel: contract.panel, battles: replayed.map(battle => ({ id: battle.id, winner: battle.winner })), alreadySigned: item.signed, problems, notes }, null, 2));
  if (problems.length || !approve || item.signed.includes(me)) return;
  await savePin('stake:' + outpoint, plan.digest);
  if (contract.opponent && replayed[0]) await savePin('pair:' + contract.ownerScript + '>' + contract.opponent, replayed[0].at);
  await submit(item.id, [signStakeDigest(plan, privateKey)]);
}
// A matched raid: the attacker's escrow alone (the raid was void, or the defender won), or the escrow together with the
// defender's War Chest (the attacker won). This attestor replays the battle the stake payment started and signs only the
// lane that follows from it, for exactly the stake, to exactly the two wallets the escrow names.
async function reviewRaid(item) {
  const evidence = await evidenceOf(item.id);
  const review = checkRaid({ item, evidence, pins: await loadPins(), me });
  console.log(JSON.stringify({ raid: item.id, payment: item.payment, lane: item.lane, stakeSatoshis: item.stakeSatoshis, battle: review.battle ?? null,
    warChestOutputs: item.sources.length - 1, feeSatoshis: item.feeSatoshis, alreadySigned: item.signed, problems: review.problems }, null, 2));
  if (review.problems.length || !approve || item.signed.includes(me)) return;
  for (const [name, value] of Object.entries(review.log)) await savePin(name, value);
  await submit(item.id, review.digests.map(digest => signRaidDigest(digest, privateKey)));
}
// A war chest capture: replay the recorded battle, then check that the capture is what the rules and the chest script allow.
async function reviewCapture(capture) {
  const problems = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  check(capture.attestors.includes(me), 'this key is not an attestor of these war chest outputs');
  for (const source of capture.sources) check(kingdomVault(source.kv).script === source.script && source.kv.capturePercent > 0, 'an input is not the war chest its terms describe');
  // The battle record is asked for as an attestor (it is public only a day after the battle).
  const proof = await evidenceOf(capture.id);
  const battle = proof?.battles.find(entry => entry.record.battle.id === capture.battle) ?? (capture.battle ? await read('/api/public/battle/' + capture.battle).catch(() => null) : null);
  check(battle, 'the server gave no battle record for this capture');
  const pinned = await loadPins();
  check(!pinned['capture:' + capture.payment] || pinned['capture:' + capture.payment] === capture.battle, 'this attestor already signed a capture for this raid');
  if (battle) {
    const fought = battle.record.battle;
    check(verifyBattle(fought) === true, 'replaying the recorded battle does not reproduce its result');
    check(fought.winner === 'attacker' && fought.attacker === capture.attacker && fought.defender === capture.defender, 'the record does not show this attacker beating this defender');
    check(battle.record.initiation?.txid, 'the battle has no on-chain raid payment');
  }
  check(capture.address === capture.verifiedWallet, 'the capture does not pay the verified wallet of the attacker');
  check(!capture.stakeSatoshis || capture.satoshis <= capture.stakeSatoshis, 'the capture exceeds the stake the attacker risked');
  const total = [...capture.sources, ...(capture.feeders ?? [])].reduce((sum, source) => sum + source.satoshis, 0);
  check(capture.satoshis * 100 <= total * capture.capturePercent, 'the capture exceeds the capture limit of these outputs');
  const plan = planChestCapture(capture.sources, { satoshis: capture.satoshis, script: capture.script, eventScript: capture.eventScript, feeders: (capture.feeders ?? []).map(item => ({ ...item, contract: chestFeeder(item.cf) })) });
  check(JSON.stringify(captureDigests(plan)) === JSON.stringify(capture.digests), 'the server digests do not match the rebuilt transaction');
  console.log(JSON.stringify({ capture: capture.id, battle: capture.battle, attacker: capture.attacker, defender: capture.defender, satoshis: capture.satoshis,
    address: capture.address, alreadySigned: capture.signed, problems }, null, 2));
  if (problems.length || !approve || capture.signed.includes(me)) return;
  await savePin('capture:' + capture.payment, capture.battle);
  const response = await fetch(origin + '/api/public/prize-awards/' + capture.id + '/attest', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: me, signatures: signCaptureDigests(plan, privateKey) }) });
  console.log('attested', capture.id, response.status, (await response.json()).result?.state ?? 'refused');
}

for (const award of pending.filter(item => !only || item.id === only)) {
  if (award.kind === 'capture') { await reviewCapture(award); continue; }
  if (award.kind === 'raid') { await reviewRaid(award); continue; }
  if (award.kind === 'stake') { await reviewStake(award); continue; }
  const problems = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  check(award.attestors.includes(me), 'this key is not an attestor of these prize fund outputs');
  // 1. Every input is a prize fund output whose script follows from its published terms, and its season has closed.
  for (const source of award.sources) {
    const contract = prizeFund(source.fund);
    check(contract.script === source.script, 'input ' + source.txid + ':' + source.vout + ' is not the prize fund its terms describe');
    check(contract.closesAt <= Date.now() / 1000, 'the season of input ' + source.txid + ' has not closed');
  }
  // 2. The amount follows from the published rule, and the destination is the winner's verified wallet.
  const share = award.percentages?.[award.rank - 1];
  check(award.rank >= 1 && share > 0, 'the player holds no paid rank');
  check(award.satoshis === Math.floor(award.prizeBase * share / 100), 'the amount is not rank share × prize base');
  check(award.address === award.verifiedWallet, 'the destination is not the verified wallet of the player');
  // 3. Outputs are [award, remainder] per fund output: awards pay the winner, remainders return to the same fund script.
  const pairs = award.sources.map((source, index) => [award.outputs[2 * index], award.outputs[2 * index + 1], source]);
  check(pairs.every(([part, rest, source]) => part?.script === award.script && rest?.script === source.script), 'an output is not an award to the winner or a remainder in its own fund');
  check(pairs.reduce((sum, [part]) => sum + (part?.satoshis ?? 0), 0) === award.satoshis, 'the award parts do not add up to the award');
  check(award.outputs.length <= award.sources.length * 2 + 1 && award.outputs.slice(award.sources.length * 2).every(item => item.satoshis === 0), 'an extra output carries money');
  check(award.feeSatoshis <= 2_000 * award.sources.length, 'the network fee exceeds the covenant limit');
  // 4. The digests are the ones of the transaction rebuilt here from those parts, so the signature covers exactly this payment.
  const plan = planPrizeAward(award.sources, award.outputs, { now: award.locktime });
  check(JSON.stringify(plan.digests) === JSON.stringify(award.digests), 'the server digests do not match the rebuilt transaction');
  // 5. The standings are recomputed here from the season's public score journal: its hash chain, every entry against the
  //    scoring rules, every battle with a public record replayed, and nothing changed since this attestor last looked.
  //    What this cannot establish is that a recorded non-battle event really happened in the game.
  const audit = await auditSeason(origin, award.seasonId, { pinFile: process.env.PRIZE_ATTESTOR_PINS ?? 'prize-attestor-pins.json' }).catch(error => ({ ok: false, problems: ['the season evidence could not be audited: ' + error.message] }));
  for (const problem of audit.problems) check(false, 'season evidence: ' + problem);
  check(audit.ranking?.find(row => row.playerId === award.playerId)?.score === award.score, 'the journal does not give this player this score');
  // 6. The award must follow the published season result: same hash as first seen (pinned on this machine), same rank,
  //    same wallet, and exactly the amount the fixed rule gives that rank.
  const { result: season } = await read('/api/public/season-result').catch(() => ({ result: null }));
  check(season && season.seasonId === award.seasonId, 'no published result for this season');
  if (season) {
    const pinFile = (process.env.PRIZE_ATTESTOR_PINS ?? 'prize-attestor-pins.json');
    const pins = await readFile(pinFile, 'utf8').then(JSON.parse).catch(() => ({}));
    if (!pins[season.seasonId]) { pins[season.seasonId] = season.resultHash; await writeFile(pinFile, JSON.stringify(pins, null, 2) + '\n'); }
    check(pins[season.seasonId] === season.resultHash, 'the published season result changed after this attestor first saw it');
    check(award.resultHash === season.resultHash, 'the award does not commit to the published season result');
    const place = season.rankings.find(item => item.playerId === award.playerId);
    check(place && place.rank === award.rank && place.wallet === award.address, 'the published result does not give this player this rank and wallet');
    check(award.satoshis === Math.floor(award.prizeBase * season.rules.percentages[award.rank - 1] / 100), 'the amount is not what the published rule gives this rank');
    check(award.prizeBase <= Math.floor(season.poolSatoshis * (100 - season.rules.reservePercent) / 100) || award.prizeBase === season.prizeBase, 'the prize base exceeds the confirmed pool less its reserve');
  }
  const explorer = await read('/api/public/ledger').catch(() => null);
  console.log(JSON.stringify({ award: award.id, season: award.seasonId, player: award.playerId, rank: award.rank, score: award.score,
    satoshis: award.satoshis, address: award.address, feeSatoshis: award.feeSatoshis, prizePoolReported: explorer?.buckets?.prize ?? 'unavailable',
    alreadySigned: award.signed, problems }, null, 2));
  if (problems.length || !approve || award.signed.includes(me)) continue;
  const response = await fetch(origin + '/api/public/prize-awards/' + award.id + '/attest', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: me, signatures: signPrizeAward(plan, privateKey) }) });
  console.log('attested', award.id, response.status, (await response.json()).result?.state ?? 'refused');
}
if (!pending.length) console.log('No award is waiting for attestation.');

// With PRIZE_ATTESTOR_BUNDLE_DIR set, every run also saves the closed season's evidence bundle (once the season has one and
// until its battle records are all public). It is what scripts/attestor-payout.mjs needs to pay the prizes if the server is gone.
if (process.env.PRIZE_ATTESTOR_BUNDLE_DIR) {
  try {
    const { exportBundle } = await import('./attestor-payout.mjs');
    const bundle = await exportBundle(origin);
    const file = process.env.PRIZE_ATTESTOR_BUNDLE_DIR.replace(/[\\/]$/, '') + '/season-' + bundle.season + '.json';
    const earlier = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (!earlier || Object.keys(bundle.pages).length > Object.keys(earlier.pages ?? {}).length) {
      await mkdir(process.env.PRIZE_ATTESTOR_BUNDLE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify(bundle) + '\n');
      console.log('Season ' + bundle.season + ' evidence bundle saved: ' + file);
    }
  } catch (error) { console.log('No evidence bundle saved: ' + error.message); }
}
