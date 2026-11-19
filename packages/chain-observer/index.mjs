import {
  amount, decodeAddress, DUST, explorerUrl, fromHex, HEX64, hex, incomingDestination, NETWORK,
  newId, normalizeSource, parseHeader, publicBytes, readTransaction, signSpend, toAddress, toBch, walletFromPrivateKey, walletFromPublicKey,
  hash256,
} from './primitives.mjs';
import { secp256k1 } from '@bitauth/libauth';
import { createElectrumTransport, createRpcTransport, observedFee } from './transports.mjs';
import { developmentOutputMinimum, eventOutput, expectedPaymentOutputs, gameEvent, prizeAggregate, protocolHash, publicOutputs } from './vaultborn.mjs';
import { PRIZE_CARRIER_V2, buildCarrierRefund, buildFeedSweep, buildPoolSweep, carrierSweepUnlocking, prizeCarrier, prizeFeeder } from './prize-carrier.mjs';
import { planVaultWithdrawal, signVaultWithdrawal, VAULT_COVENANT, vaultCovenant } from './vault-covenant.mjs';
import { LEGACY_SPONSOR_ALLOCATION, SPONSOR_ALLOCATION, sponsorshipAllocation, sponsorshipPolicy } from '../../config/payments.mjs';
import { WAR_CHEST, WAR_CHEST_3, WAR_CHEST_4, CHEST_GRID, MATCHED_INPUTS, captureDigests, kingdomVault, majority, planChestCapture, planKingdomWithdrawal, quorumOf, signChestCapture, signKingdomWithdrawal, validCaptureSignatures, vaultTerms } from './kingdom-vault.mjs';
import { buildChestFeed, chestFeeder, feedBytes, feederInputBytes, feederTerms } from './chest-feeder.mjs';
import { STAKE_ESCROW_3, completeStakeSpend, planStakeSpend, signStakeDigest, stakeEscrow, stakeTerms, validStakeSignature } from './stake-escrow.mjs';
import { MATCHED_RAID, RAID_ESCROW, chestInputBytes, completeMatchedCapture, completeRaidSpend, planMatchedCapture, planRaidSpend, raidEscrow, raidTermsFor, signRaidDigest, validMatchedSignatures, validRaidSignature } from './matched-raid.mjs';
import { RECORD_RESERVE, recordReserve, recordTerms, signRecord } from './record-reserve.mjs';
import { compileTreasuryCovenant, completeTreasurySpend, planTreasurySpend, treasurySigningHash } from './treasury-covenants.mjs';
import { PRIZE_FUND, buildPrizeRefund, layoutPrizeAward, completePrizeAward, awardQuorum, planPrizeAward, prizeFund, signPrizeAward, validAwardSignatures } from './prize-fund.mjs';
import { politicalEscrow, POLITICAL_ESCROW_VERSION, signPoliticalEscrow } from './political-escrow.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';

export { decodeAddress, signWalletChallenge, verifyWalletProof, walletFromPrivateKey, walletFromPublicKey } from './primitives.mjs';
export { CHIPNET_CHECKPOINT } from './transports.mjs';

const INTENT_TTL = 30 * 60 * 1000;
const RECOVERY_TTL = 6 * 60 * 60 * 1000;
const PAYOUT_DUST_BUFFER = 545n;

function validTxid(value) {
  if (typeof value !== 'string' || !HEX64.test(value.trim())) throw new Error('Enter a valid 64-character ' + NETWORK_LABEL + ' TXID.');
  return value.trim().toLowerCase();
}

function outputMatches(output, script, satoshis) {
  return output !== undefined && !output.token && hex(output.lockingBytecode) === script &&
    output.valueSatoshis === BigInt(satoshis);
}

function existingOrPending(intent, now) {
  if (['credited', 'confirmed', 'reorg'].includes(intent.state)) {
    return { ...intent, state: 'reorg', lastError: 'The confirmed transaction is absent from the active ' + NETWORK_LABEL + ' chain.', receipt: { ...intent.receipt, confirmations: 0 } };
  }
  if (intent.direction !== 'outgoing' && now > intent.expiresAt) {
    return { ...intent, state: 'expired', lastError: 'Payment window expired. A later transfer needs operator review.' };
  }
  return { ...intent, state: intent.txid ? 'submitted' : 'awaiting_signature', lastError: null };
}

function matchReceipt(intent, observed) {
  const { transaction, txid, confirmations, height, blockHash, blockTime } = observed;
  const outputs = transaction.outputs;
  const indexes = outputs.flatMap((output, index) => hex(output.lockingBytecode) === intent.script ? [index] : []);
  const vout = intent.direction === 'outgoing' ? 0 : indexes[0];
  const exact = intent.direction === 'outgoing' && intent.layout;
  if (!exact && (indexes.length !== 1 || !outputMatches(outputs[vout], intent.script, intent.outputs?.[0].satoshis ?? intent.satoshis))) return null;
  if (exact) {
    // A sweep is accepted only as the exact signed transaction: same inputs, same outputs, same order.
    const sameInputs = transaction.inputs.length === intent.sources.length &&
      transaction.inputs.every((input, i) => hex(input.outpointTransactionHash) === intent.sources[i].txid && input.outpointIndex === intent.sources[i].vout);
    const sameOutputs = outputs.length === intent.layout.length && intent.layout.every((item, i) => outputMatches(outputs[i], item.script, item.satoshis));
    if (!sameInputs || !sameOutputs) return null;
    return { txid, network: NETWORK, confirmations, height, blockHash, blockTime, vout: 0, satoshis: intent.satoshis,
      address: intent.address, script: intent.script, ...(intent.change && { change: { ...intent.change, txid } }),
      ...(intent.event && { event: intent.event, eventVout: intent.layout.length - 1 }), explorerUrl: explorerUrl(txid) };
  }
  let allocations;
  if (intent.outputs) {
    allocations = [];
    for (const expected of intent.outputs) {
      const matches = outputs.flatMap((output, index) => hex(output.lockingBytecode) === expected.script ? [index] : []);
      if (matches.length !== 1 || !outputMatches(outputs[matches[0]], expected.script, expected.satoshis)) return null;
      allocations.push({ ...expected, txid, vout: matches[0] });
    }
  }
  if (intent.direction === 'outgoing') {
    const exactInputs = transaction.inputs.length === intent.sources.length &&
      transaction.inputs.every((input, i) => hex(input.outpointTransactionHash) === intent.sources[i].txid &&
        input.outpointIndex === intent.sources[i].vout);
    const correctChange = !intent.change || outputMatches(outputs[1], intent.change.script, intent.change.satoshis);
    const eventIndex = intent.change ? 2 : 1;
    const correctEvent = !intent.event || outputMatches(outputs[eventIndex], intent.eventOutput.script, 0);
    const expectedCount = 1 + Number(Boolean(intent.change)) + Number(Boolean(intent.event));
    if (!exactInputs || !correctChange || !correctEvent || outputs.length !== expectedCount) return null;
  }
  return {
    txid, network: NETWORK, confirmations, height, blockHash, blockTime, vout,
    satoshis: intent.satoshis, address: intent.address, script: intent.script, redeemScript: intent.redeemScript,
    ...(allocations && { allocations }),
    ...(intent.event && { event: intent.event, eventVout: intent.direction === 'outgoing' ? (intent.change ? 2 : 1) : allocations?.at(-1)?.vout }),
    ...(intent.change && { change: { ...intent.change, txid } }),
    explorerUrl: explorerUrl(txid),
  };
}

function publicReceipt(receipt) {
  if (!receipt) return null;
  const { redeemScript, change, allocations, ...fields } = receipt;
  if (allocations) fields.allocations = publicOutputs(allocations);
  if (!change) return fields;
  const { redeemScript: changeRedeemScript, ...publicChange } = change;
  return { ...fields, change: publicChange };
}

const evidenceDigest = id => hash256(Buffer.from('vaultborn-attestor-evidence:' + id, 'utf8'));
// The signature an attestor sends with a request for the evidence of proposal `id`.
export const signAttestorRequest = (id, privateKey) => hex(secp256k1.signMessageHashSchnorr(fromHex(privateKey), evidenceDigest(id)));

export function createChain({
  treasuryPublicKey, treasuryPrivateKey, developmentAddress, sponsorshipDevelopmentAddress, rpcUrl, rpcUser, rpcPassword, electrumHost,
  minConfirmations = 2, transport, enabled: requested = true, prizeAttestors = [], prizeAttestorThreshold, poolRecoveryDays = 30,
} = {}) {
  if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 100) {
    throw new Error('' + NETWORK_LABEL + ' confirmation threshold must be an integer between 1 and 100.');
  }
  const derivedPublicKey = treasuryPrivateKey ? walletFromPrivateKey(treasuryPrivateKey).publicKey : undefined;
  const publicKey = treasuryPublicKey?.trim().toLowerCase() || derivedPublicKey;
  if (publicKey) publicBytes(publicKey);
  if (derivedPublicKey && publicKey !== derivedPublicKey) throw new Error('' + NETWORK_LABEL + ' treasury public and private keys do not match.');
  function nativeDestination(address) {
    if (!address) return undefined;
    const destination = decodeAddress(address.trim());
    if (destination.tokenSupport) throw new Error('Use a native BCH CashAddr for Development funds.');
    return destination;
  }
  const development = nativeDestination(developmentAddress);
  const sponsorDevelopment = nativeDestination(sponsorshipDevelopmentAddress) ?? development;
  const sponsorshipMinimumSatoshis = Math.max(sponsorshipPolicy.minimumSatoshis,
    Number(developmentOutputMinimum(sponsorDevelopment)) * sponsorshipPolicy.satoshiStep);
  // Independent co-signers of every prize fund award. Their secrets never reach this process.
  const attestors = [...new Set(prizeAttestors.map(item => hex(publicBytes(item.trim().toLowerCase()))))].sort();
  if (attestors.length > 3) throw new Error('Configure at most three prize attestor keys.');
  // How many independent attestors must sign a capture or an award: a strict majority unless more are asked for.
  const quorum = attestors.length ? Number(prizeAttestorThreshold ?? majority(attestors.length)) : 0;
  if (attestors.length && (!Number.isInteger(quorum) || quorum < majority(attestors.length) || quorum > attestors.length)) {
    throw new Error('The attestor threshold must be a strict majority of the configured attestor keys.');
  }
  if (publicKey && attestors.some(item => item.slice(2) === publicKey.slice(2))) throw new Error('A prize attestor must not be the game automation key.');
  const observer = transport ?? (rpcUrl ? createRpcTransport({ rpcUrl, rpcUser, rpcPassword }) : createElectrumTransport(electrumHost));
  const enabled = Boolean(requested && publicKey);
  const payoutsEnabled = Boolean(enabled && treasuryPrivateKey);

  // One War Chest script per owner. Every share and deposit of that owner lands in it, so outputs can be consolidated.
  function chestOf({ ownerKey, capturePercent = 20, captureAge = 144, exitDelay = 288, revision = 3 }) {
    const owner = hex(publicBytes(ownerKey));
    // Revision 4 is the matched-stakes chest: no percentage, no capture age, and no ID (the owner's key makes the script unique).
    const chest = revision === 4 ? kingdomVault({ operatorKey: publicKey, ownerKey: owner, attestors, threshold: quorum, exitDelay, revision: 4 }) :
      kingdomVault({ id: protocolHash({ chest: owner }).slice(0, 32), operatorKey: publicKey, ownerKey: owner, capturePercent, captureAge, exitDelay,
        attestors, threshold: quorum, revision: 3 });
    return { script: chest.script, address: chest.address, redeemScript: chest.redeemScript, kv: vaultTerms(chest), exitScript: chest.exitScript, exitAddress: chest.exitAddress };
  }
  // Who opens the outcome lanes of a stake: the attestor majority, or the game key together with a single attestor.
  const outcomePanel = () => attestors.length === 1 ? { keys: [publicKey, attestors[0]].sort(), threshold: 2 } : attestors.length ? { keys: attestors, threshold: quorum } : null;
  // The network fee of a capture that spends `count` outputs of this chest, and the smallest single output a capture can
  // take from at all: 20% of it must pay that fee and still leave a spendable payment.
  function captureCost(chest, count = 1, shares = 0) {
    const terms = chest.kv;
    // A waiting share that joins the capture adds only its small keyless input.
    const riding = shares * feederInputBytes(chestFeeder({ id: '00'.repeat(16), chestScript: chest.script ?? kingdomVault(terms).script, threshold: 6000, reserve: 220, wait: 13_104 }));
    return 10 + count * (40 + 3 + 66 * (1 + quorumOf(terms)) + (terms.revision === 3 ? terms.attestors.length - terms.threshold : 0) + 1 + 3 + kingdomVault(terms).redeemScript.length / 2) + riding + 44 + 34 + 2 + 60;
  }
  const captureFloor = chest => Math.ceil((captureCost(chest) + 546) * 100 / chest.kv.capturePercent / 10) * 10;

  function createIntent({ playerId, action, payload, satoshis, allocation, event, kingdomOwner, chestOwner, chestFeed, prizeFeed, recordReserve: recordSatoshis, prizeLock: givenPrizeLock, sweep, now = Date.now() }) {
    if (!enabled) throw new Error('A ' + NETWORK_LABEL + ' treasury public key is required to issue payment intents.');
    const id = newId();
    if (action === 'sponsor-fund' && event?.allocationPolicy === SPONSOR_ALLOCATION) throw new Error('A sponsorship is paid into its prize fund covenant.');
    const sponsor = action === 'sponsor-fund' && event?.allocationPolicy === LEGACY_SPONSOR_ALLOCATION;
    const developmentDestination = Object.hasOwn(allocation ?? {}, 'development') ? (sponsor ? sponsorDevelopment : development) : undefined;
    const commitment = event ? gameEvent(action, id, developmentDestination ?
      { ...event, developmentAddress: developmentDestination.address } : event) : undefined;
    // `kingdomOwner` locks the kingdom share to the payer's own vault covenant instead of an operator-key output.
    // A service payment under the final policy pays its 50% straight into the payer's War Chest and its 20% into a season pool feeder.
    const chested = chestOwner && Object.hasOwn(allocation ?? {}, 'warChest');
    if (chested && !attestors.length) throw new Error('A War Chest needs at least one independent battle attestor key.');
    const chest = chested ? chestOf(chestOwner) : null;
    // A share that is already large enough to be captured goes straight into the War Chest: no feeder, no reserve, no later move.
    const direct = chest && (chest.kv.revision === 4 || allocation.warChest >= captureFloor(chest));
    if (chest?.kv.revision === 4 && allocation.warChest % CHEST_GRID) throw new Error('A War Chest share is a multiple of 1,000 satoshis.');
    const feeder = chest && !direct && chestFeeder({ id, chestScript: chest.script, threshold: captureFloor(chest), reserve: chestFeed.reserve, wait: chestFeed.wait });
    const vault = chested ? null :
      kingdomOwner && Object.hasOwn(allocation ?? {}, 'kingdom') ? kingdomVault({ id, operatorKey: publicKey, ...kingdomOwner, revision: 2 }) : null;
    let prizeLock = givenPrizeLock;
    if (chested) {
      const pool = seasonPool(prizeFeed.seasonId, prizeFeed.closesAt);
      const feeder = prizeFeeder({ poolScript: pool.script, share: allocation.prize });
      prizeLock = { script: feeder.script, address: feeder.address, redeemScript: feeder.redeemScript, feeder: { poolScript: pool.script, share: allocation.prize },
        pool, prizeSatoshis: allocation.prize, reserveSatoshis: prizeFeed.reserve, seasonId: prizeFeed.seasonId };
    }
    // The War Chest share waits in a keyless feeder that can only become an output of the payer's own War Chest.
    const kingdomLock = feeder ? { script: feeder.script, address: feeder.address, redeemScript: feeder.redeemScript, cf: feederTerms(feeder),
      chest: { script: chest.script, address: chest.address, redeemScript: chest.redeemScript, kv: chest.kv }, chestSatoshis: allocation.warChest, reserveSatoshis: chestFeed.reserve } :
      direct ? { script: chest.script, address: chest.address, redeemScript: chest.redeemScript, kv: chest.kv } :
      vault && { script: vault.script, address: vault.address, redeemScript: vault.redeemScript, kv: vaultTerms(vault) };
    const outputs = (allocation || commitment) ?
      expectedPaymentOutputs({ id, publicKey, satoshis, allocation, event: commitment, developmentDestination, kingdomLock, prizeLock,
        ...(sweep && { sweep: { reserve: sweep.reserve, refundAt: sweep.refundAt, payerScript: walletFromPublicKey(sweep.payerKey).script } }) }) : undefined;
    if (recordSatoshis) {
      // A political operation also funds the fee of its own proof record, in an output only that record can spend.
      // Its payer can take it back alone once it is old enough, so a failed or cancelled operation never strands it.
      const reserve = recordReserve({ id, operatorKey: publicKey, ownerKey: chestOwner?.ownerKey ?? kingdomOwner?.ownerKey });
      outputs.splice(outputs.length - 1, 0, { role: 'record', script: reserve.script, address: reserve.address, redeemScript: reserve.redeemScript, satoshis: recordSatoshis, rr: recordTerms(reserve) });
    }
    // Discovery watches the intent-derived owner or prize script, never a shared external recipient.
    const lead = outputs?.[0].role === 'carrier' || outputs?.[0].kv || outputs?.[0].cf ? outputs[0] : null;
    const destination = lead ? { script: lead.script, address: lead.address, redeemScript: lead.redeemScript } : incomingDestination(id, publicKey);
    if (outputs && outputs[0].script !== destination.script) throw new Error('The payment does not have a unique discovery output.');
    return {
      id, playerId, action, payload, satoshis: Number(amount(satoshis, DUST)),
      direction: 'incoming', network: NETWORK, state: 'awaiting_signature',
      createdAt: now, expiresAt: now + INTENT_TTL,
      ...destination,
      ...(outputs && { outputs, event: commitment }),
    };
  }

  // A sponsorship: 30% straight to the developer address, 70% straight into the season's prize fund covenant.
  function createSponsorIntent({ playerId, payload, satoshis, allocation, event, sponsorKey, closesAt, refundAt, now = Date.now() }) {
    if (!enabled) throw new Error('A ' + NETWORK_LABEL + ' treasury public key is required to issue payment intents.');
    if (!sponsorDevelopment) throw new Error('Sponsorship needs the configured developer address.');
    if (!attestors.length) throw new Error('Sponsorship needs at least one independent prize attestor key.');
    const exact = sponsorshipAllocation(Number(satoshis), sponsorshipMinimumSatoshis);
    if (allocation?.development !== exact.development || allocation?.prize !== exact.prize || event?.allocationPolicy !== SPONSOR_ALLOCATION) {
      throw new Error('The sponsorship must send exactly 30% to the developer address and 70% to the prize fund.');
    }
    const id = newId();
    // Every limit is stored with the output, so its script can be rebuilt from public data whatever the defaults become.
    const fund = { id, operatorKey: publicKey, attestors, sponsorKey, closesAt, refundAt, refundFee: 1000, awardPercent: 40, awardAge: 6, maxFee: 2000, threshold: quorum };
    const contract = prizeFund(fund);
    if (contract.sponsorScript === sponsorDevelopment.script) throw new Error('The developer address cannot sponsor its own prize fund.');
    const commitment = gameEvent('sponsor-fund', id, { ...event, developmentAddress: sponsorDevelopment.address,
      fund: { version: PRIZE_FUND, script: contract.script, sponsor: contract.sponsorAddress, attestors, closesAt, refundAt,
        awardPercent: fund.awardPercent, awardAge: fund.awardAge, maxFee: fund.maxFee, refundFee: fund.refundFee, threshold: quorum } });
    const lock = { script: contract.script, address: contract.address, redeemScript: contract.redeemScript };
    return { id, playerId, action: 'sponsor-fund', payload, satoshis: Number(satoshis), direction: 'incoming', network: NETWORK,
      state: 'awaiting_signature', createdAt: now, expiresAt: now + INTENT_TTL, ...lock, fund,
      outputs: [{ role: 'prize', ...lock, satoshis: exact.prize, fund, seasonId: event.seasonId },
        { role: 'development', script: sponsorDevelopment.script, address: sponsorDevelopment.address, custody: 'external', satoshis: exact.development },
        eventOutput(commitment)], event: commitment };
  }

  // A prize paid out of prize fund outputs. It is only a proposal until every attestor of those outputs has signed.
  function preparePrizeAward({ playerId, action, payload, sources: offered, satoshis, address, event, now = Date.now() }) {
    if (!payoutsEnabled) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    const destination = decodeAddress(address);
    const record = event && eventOutput(event);
    const lead = prizeFund(offered[0].fund);
    if (lead.operatorKey !== publicKey) throw new Error('These prize fund outputs belong to another automation key.');
    const { sources, outputs, changes, feeSatoshis } = layoutPrizeAward(offered, { script: destination.script, satoshis, eventScript: record?.script });
    const plan = planPrizeAward(sources, outputs, { now: Math.floor(now / 1000) });
    return { id: newId(), playerId, action, payload, script: destination.script, address: destination.address, satoshis,
      sources: sources.map(({ txid, vout, satoshis: value, script, fund }) => ({ txid, vout, satoshis: value, script, fund })),
      fundSource: true, feeSatoshis, layout: outputs, changes, ...(event && { event, eventOutput: record }),
      attestation: { version: PRIZE_FUND, attestors: lead.attestors, threshold: Math.max(...plan.contracts.map(item => awardQuorum(item, plan.locktime))), digests: plan.digests, locktime: plan.locktime, signatures: {} },
      direction: 'outgoing', network: NETWORK, state: 'created', createdAt: now, expiresAt: now + 72 * 60 * 60_000 };
  }

  const awardPlan = intent => planPrizeAward(intent.sources, intent.layout, { now: intent.attestation?.locktime });

  // Records one attestor's signatures. Once every attestor has signed, the automation key signs last and the award is final.
  function attestPrizeAward(intent, attestorKey, signatures) {
    if (!intent.attestation || intent.rawHex) throw new Error('This award is not waiting for attestation.');
    const key = typeof attestorKey === 'string' ? attestorKey.toLowerCase() : '';
    if (intent.attestation.version === STAKE_ESCROW_3) {
      const plan = stakePlan(intent);
      if (!intent.attestation.attestors.includes(key) || !validStakeSignature(plan, key, signatures?.[0])) throw new Error('This is not a valid signature of an outcome attestor for this settlement.');
      const gathered = { ...intent.attestation.signatures, [key]: signatures };
      const state = { ...intent.attestation, signatures: gathered };
      if (Object.keys(gathered).length < intent.attestation.threshold) return { ...intent, attestation: state };
      const all = Object.fromEntries(Object.entries(gathered).map(([item, list]) => [item, list[0]]));
      if (plan.contract.panel.keys.includes(publicKey)) all[publicKey] = signStakeDigest(plan, treasuryPrivateKey);
      return { ...intent, attestation: state, ...completeStakeSpend(plan, all), state: 'submitted', expiresAt: null };
    }
    if (intent.attestation.version === MATCHED_RAID) {
      const plan = raidPlan(intent);
      const win = intent.lane === 'attacker-wins';
      const valid = win ? validMatchedSignatures(plan, key, signatures) : Array.isArray(signatures) && signatures.length === 1 && validRaidSignature(plan.digest, key, signatures[0]);
      if (!intent.attestation.attestors.includes(key) || !valid) throw new Error('These are not valid signatures of an attestor for this raid settlement.');
      const gathered = { ...intent.attestation.signatures, [key]: signatures };
      const state = { ...intent.attestation, signatures: gathered };
      if (intent.attestation.attestors.filter(item => gathered[item]).length < intent.attestation.threshold) return { ...intent, attestation: state };
      if (win) {
        if (!payoutsEnabled) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
        return { ...intent, attestation: state, ...completeMatchedCapture(plan, treasuryPrivateKey, gathered), state: 'submitted', expiresAt: null };
      }
      const all = Object.fromEntries(Object.entries(gathered).map(([item, list]) => [item, list[0]]));
      if (plan.contract.panel.keys.includes(publicKey)) all[publicKey] = signRaidDigest(plan.digest, treasuryPrivateKey);
      return { ...intent, attestation: state, ...completeRaidSpend(plan, all), state: 'submitted', expiresAt: null };
    }
    if (intent.attestation.version === WAR_CHEST) {
      const capture = planChestCapture(intent.sources, { satoshis: intent.captureSatoshis, script: intent.captureScript, eventScript: intent.eventOutput?.script,
        feeders: (intent.feeders ?? []).map(item => ({ ...item, contract: chestFeeder(item.cf) })) });
      if (!intent.attestation.attestors.includes(key) || !validCaptureSignatures(capture, key, signatures)) {
        throw new Error('These are not valid signatures of a battle attestor for this capture.');
      }
      const gathered = { ...intent.attestation.signatures, [key]: signatures };
      const state = { ...intent.attestation, signatures: gathered };
      if (intent.attestation.attestors.filter(item => gathered[item]).length < (intent.attestation.threshold ?? intent.attestation.attestors.length)) return { ...intent, attestation: state };
      if (!payoutsEnabled) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
      return { ...intent, attestation: state, ...signChestCapture(capture, treasuryPrivateKey, gathered), state: 'submitted', expiresAt: null };
    }
    const plan = awardPlan(intent);
    if (!intent.attestation.attestors.includes(key) || !validAwardSignatures(plan, key, signatures)) {
      throw new Error('These are not valid signatures of a prize attestor for this award.');
    }
    const collected = { ...intent.attestation.signatures, [key]: signatures };
    const attestation = { ...intent.attestation, signatures: collected };
    if (intent.attestation.attestors.filter(item => collected[item]).length < (intent.attestation.threshold ?? intent.attestation.attestors.length)) return { ...intent, attestation };
    if (!payoutsEnabled) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    const signed = completePrizeAward(plan, signPrizeAward(plan, treasuryPrivateKey), collected);
    if (signed.feeSatoshis !== intent.feeSatoshis) throw new Error('The attested award does not match its quote.');
    return { ...intent, attestation, ...signed, state: 'submitted', expiresAt: null };
  }

  function prizeRefund(sources, fee) { return buildPrizeRefund(sources, fee); }

  // The season pool of service prize shares: a prize fund without a sponsor. Anyone can rebuild it from the season number.
  function seasonPool(seasonId, closesAt) {
    if (!enabled || !attestors.length) return null;
    // A strict majority of the attestors signs an award. From `recoverAt` (the close plus the recovery period) one attestor is enough, so the pool is not lost when attestors disappear.
    const fund = { id: protocolHash({ season: seasonId, bucket: 'season-pool' }).slice(0, 32), operatorKey: publicKey, attestors, closesAt, awardPercent: 40, awardAge: 6, maxFee: 2000,
      threshold: quorum, recoverAt: closesAt + poolRecoveryDays * 86_400 };
    const contract = prizeFund(fund);
    return { script: contract.script, address: contract.address, redeemScript: contract.redeemScript, fund };
  }

  // A keyless move of prize feeders into their season pool.
  function feedSweep({ feeders, pool, seasonId, now = Date.now() }) {
    const built = buildFeedSweep(feeders, { pool });
    const lock = feeders[0].pool;
    return { ...built, id: newId(), playerId: 'council', action: 'allocation-sweep', payload: { feeders: feeders.map(item => item.txid + ':' + item.vout), seasonId },
      network: NETWORK, direction: 'outgoing', state: 'submitted', createdAt: now, expiresAt: null, keyless: true,
      script: lock.script, address: lock.address, satoshis: built.poolSatoshis, layout: built.outputs,
      sources: [...feeders.map(({ txid, vout, satoshis: value, script }) => ({ txid, vout, satoshis: value, script })),
        ...(pool ? [{ txid: pool.txid, vout: pool.vout, satoshis: pool.satoshis, script: pool.script }] : [])],
      sweepOutputs: [{ role: 'prize', vout: 0, ...lock, satoshis: built.poolSatoshis, seasonId }] };
  }

  // A keyless sweep of reserve-funded carriers into their season pool and their payers' kingdom vaults.
  function poolSweep({ carriers, pool, seasonId, event, now = Date.now() }) {
    const record = eventOutput(event);
    const built = buildPoolSweep(carriers, { pool, eventScript: record.script });
    const lock = carriers[0].prize;
    return { ...built, id: newId(), playerId: 'council', action: 'allocation-sweep', payload: { carriers: carriers.map(item => item.txid + ':' + item.vout), seasonId },
      network: NETWORK, direction: 'outgoing', state: 'submitted', createdAt: now, expiresAt: null, keyless: true,
      script: lock.script, address: lock.address, satoshis: built.poolSatoshis, layout: built.outputs, event, eventOutput: record,
      sources: [...carriers.map(({ txid, vout, satoshis: value, script }) => ({ txid, vout, satoshis: value, script })),
        ...(pool ? [{ txid: pool.txid, vout: pool.vout, satoshis: pool.satoshis, script: pool.script }] : [])],
      sweepOutputs: [{ role: 'prize', vout: 0, ...lock, satoshis: built.poolSatoshis, seasonId },
        ...carriers.map((item, index) => ({ role: 'kingdom', vout: index + 1, ...item.kingdom, satoshis: item.kingdomSatoshis }))] };
  }

  // A war chest deposit: money its owner's wallet puts at risk. Only this output type has the bounded capture lane.
  function createChestIntent({ playerId, payload, satoshis, ownerKey, capturePercent, captureAge, exitDelay, revision = 3, minimum, event, now = Date.now() }) {
    if (!enabled) throw new Error('A ' + NETWORK_LABEL + ' treasury public key is required to issue payment intents.');
    if (!attestors.length) throw new Error('A war chest needs at least one independent battle attestor key.');
    const id = newId();
    const chest = chestOf({ ownerKey, capturePercent, captureAge, exitDelay, revision });
    const value = Number(amount(satoshis, BigInt(minimum ?? captureFloor(chest))));
    if (revision === 4 && value % CHEST_GRID) throw new Error('A War Chest deposit is a multiple of 1,000 satoshis.');
    const commitment = gameEvent('war-chest', id, { ...event, chest: revision === 4 ?
      { version: WAR_CHEST_4, script: chest.script, exitScript: chest.exitScript, owner: walletFromPublicKey(chest.kv.ownerKey).address, exitDelay: chest.kv.exitDelay, releaseAge: chest.kv.releaseAge, attestors, threshold: quorum } :
      { version: WAR_CHEST_3, script: chest.script, owner: walletFromPublicKey(chest.kv.ownerKey).address,
      capturePercent: chest.kv.capturePercent, captureAge: chest.kv.captureAge, exitDelay: chest.kv.exitDelay, attestors, threshold: quorum } });
    const lock = { script: chest.script, address: chest.address, redeemScript: chest.redeemScript, kv: chest.kv };
    // The chest script is shared by all of this owner's deposits; the payment is told apart by its own event record.
    return { id, playerId, action: 'war-chest', payload, satoshis: value, direction: 'incoming', network: NETWORK, state: 'awaiting_signature',
      createdAt: now, expiresAt: now + INTENT_TTL, ...lock, outputs: [{ role: 'kingdom', ...lock, satoshis: value, chest: true }, eventOutput(commitment)], event: commitment };
  }

  // A keyless move of one owner's waiting War Chest shares into one output of that owner's War Chest.
  function chestFeed({ feeders, aged = false, playerId, now = Date.now() }) {
    const built = buildChestFeed(feeders, { aged });
    const lock = feeders[0].chest;
    return { ...built, id: newId(), playerId, action: 'chest-consolidation', payload: { chestFeeders: feeders.map(item => item.txid + ':' + item.vout), aged },
      network: NETWORK, direction: 'outgoing', state: 'submitted', createdAt: now, expiresAt: null, keyless: true,
      script: lock.script, address: lock.address, satoshis: built.chestSatoshis, layout: built.outputs,
      shareSatoshis: feeders.reduce((sum, item) => sum + item.chestSatoshis, 0),
      sources: feeders.map(({ txid, vout, satoshis: value, script }) => ({ txid, vout, satoshis: value, script })),
      sweepOutputs: [{ role: 'kingdom', vout: 0, ...lock, satoshis: built.chestSatoshis }] };
  }

  // The public proof record of a paid political operation, paid for by the reserve its payer locked for exactly this.
  function signPoliticalRecord({ source, event, playerId = 'council', action = 'political-outcome', payload = {}, now = Date.now() }) {
    if (!payoutsEnabled) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    if (source?.rr?.operatorKey !== publicKey) throw new Error('This record reserve belongs to another game key.');
    const record = eventOutput(event);
    const signed = signRecord(source, record.script, treasuryPrivateKey);
    return { ...signed, id: newId(), playerId, action, payload, network: NETWORK, direction: 'outgoing', state: 'submitted', createdAt: now, expiresAt: null,
      script: record.script, address: null, satoshis: 0, layout: [{ script: record.script, satoshis: 0 }], event, eventOutput: record,
      sources: [{ txid: source.txid, vout: source.vout, satoshis: source.satoshis, script: source.script, rr: source.rr }] };
  }

  // A competitive stake locked in an escrow whose only possible payouts were fixed when it was funded.
  function createStakeIntent({ playerId, action, payload, satoshis, allocation, event, ownerKey, opponent, claim = false, refundAt, closesAt, now = Date.now() }) {
    if (!enabled) throw new Error('A ' + NETWORK_LABEL + ' treasury public key is required to issue payment intents.');
    if (amount(allocation.battle) + amount(allocation.settlement) !== amount(satoshis)) throw new Error('The stake and its reserve do not conserve the payment.');
    const id = newId();
    // A stake that no outcome can move away from its owner returns whole, with the unused part of its reserve.
    // With attestors configured, a contested stake is settled by the outcome panel: the attestor majority, or the game
    // key together with the single attestor. The game key alone can then not choose who is paid.
    const panel = outcomePanel();
    if (panel && (claim || opponent)) {
      const contract = stakeEscrow({ id, kind: claim ? 'territory-claim' : action === 'attack-paid' ? 'battle-escrow' : 'territory-escrow', ownerKey,
        ...(!claim && { opponent: decodeAddress(opponent).script }), principal: allocation.battle, reserve: allocation.settlement, refundAt, panel });
      const terms = stakeTerms(contract);
      const commitment = gameEvent(action, id, { ...event, custody: 'stake-escrow-v2', escrow: { kind: terms.kind, version: 3, script: contract.script, owner: contract.ownerAddress, opponent: opponent ?? null, refundAt, panel } });
      const lock = { script: contract.script, address: contract.address, redeemScript: contract.redeemScript };
      return { id, playerId, action, payload, satoshis: Number(satoshis), direction: 'incoming', network: NETWORK, state: 'awaiting_signature',
        createdAt: now, expiresAt: now + INTENT_TTL, ...lock, escrow: terms,
        outputs: [{ role: 'escrow', ...lock, satoshis: contract.satoshis, escrow: terms, battleSatoshis: allocation.battle, settlementSatoshis: allocation.settlement },
          eventOutput(commitment)], event: commitment };
    }
    const escrow = claim ? { id, kind: 'territory-claim', version: 2, record: true, principal: allocation.battle, reserve: allocation.settlement,
        refundAt, ownerKey, attestors: [publicKey] } :
      opponent ? { id, kind: action === 'attack-paid' ? 'battle-escrow' : 'territory-escrow', version: 2, record: true, principal: allocation.battle, reserve: allocation.settlement,
        refundAt, ownerKey, opponent, attestors: [publicKey] } :
      { id, kind: 'territory-uncontested', version: 2, record: true, principal: allocation.battle + allocation.settlement - 600, reserve: 600, refundAt, closesAt, ownerKey };
    const contract = compileTreasuryCovenant(escrow);
    const commitment = gameEvent(action, id, { ...event, custody: 'stake-escrow-v2',
      escrow: { kind: escrow.kind, script: contract.script, owner: contract.refundAddress, opponent: opponent ?? null, refundAt, ...(closesAt && { closesAt }) } });
    const lock = { script: contract.script, address: contract.address, redeemScript: contract.redeemScript };
    return { id, playerId, action, payload, satoshis: Number(satoshis), direction: 'incoming', network: NETWORK, state: 'awaiting_signature',
      createdAt: now, expiresAt: now + INTENT_TTL, ...lock, escrow,
      outputs: [{ role: 'escrow', ...lock, satoshis: contract.satoshis, escrow, battleSatoshis: allocation.battle, settlementSatoshis: allocation.settlement },
        eventOutput(commitment)], event: commitment };
  }

  // The terms a matched raid of `stake` against this defender would have: its reserve and the fee of each settlement.
  function raidQuote({ stake, ownerKey, opponent, defenderKey, id = '00'.repeat(16), refundAt = 1_900_000_000 }) {
    const panel = outcomePanel();
    if (!panel) throw new Error('A paid raid needs at least one independent attestor.');
    const chest = kingdomVault(chestOf({ ownerKey: defenderKey, revision: 4 }).kv);
    return raidTermsFor({ id, ownerKey, opponent: decodeAddress(opponent).script, principal: stake, refundAt, panel, chest });
  }
  // A matched raid: the attacker's stake and its network reserve, locked in an escrow that names the defender's wallet.
  function createRaidIntent({ playerId, payload, stake, ownerKey, opponent, defenderKey, event, refundAt, now = Date.now() }) {
    if (!enabled) throw new Error('A ' + NETWORK_LABEL + ' treasury public key is required to issue payment intents.');
    const id = newId();
    const terms = raidQuote({ id, stake, ownerKey, opponent, defenderKey, refundAt });
    const contract = raidEscrow(terms);
    const chest = chestOf({ ownerKey: defenderKey, revision: 4 });
    const commitment = gameEvent('attack-paid', id, { ...event, custody: RAID_ESCROW, allocation: { battle: stake, settlement: terms.reserve },
      escrow: { kind: 'matched-raid', version: 4, script: contract.script, owner: contract.ownerAddress, opponent, refundAt, panel: terms.panel, stake, reserve: terms.reserve,
        settleFee: terms.settleFee, winBase: terms.winBase, winPerInput: terms.winPerInput, defenderChest: chest.script, defenderExit: chest.exitScript } });
    const lock = { script: contract.script, address: contract.address, redeemScript: contract.redeemScript };
    return { id, playerId, action: 'attack-paid', payload, satoshis: contract.satoshis, direction: 'incoming', network: NETWORK, state: 'awaiting_signature',
      createdAt: now, expiresAt: now + INTENT_TTL, ...lock, escrow: terms,
      outputs: [{ role: 'escrow', ...lock, satoshis: contract.satoshis, escrow: terms, battleSatoshis: stake, settlementSatoshis: terms.reserve },
        eventOutput(commitment)], event: commitment };
  }
  // Rebuilds the unsigned transaction of a matched raid proposal from what the proposal stores.
  function raidPlan(intent) {
    const escrow = intent.sources.at(-1);
    if (intent.lane === 'attacker-wins') return planMatchedCapture(intent.sources.slice(0, -1), escrow, { eventScript: intent.eventOutput?.script });
    return planRaidSpend(escrow, { lane: intent.lane, eventScript: intent.eventOutput?.script });
  }
  // A settlement of a matched raid. `lane` is 'void', 'defender-wins' or 'attacker-wins'; the last one also spends `chests`,
  // the defender's War Chest outputs, in the same transaction. It is only a proposal until the attestors have signed.
  function proposeRaidSettlement({ source, lane, chests = [], event, playerId = 'council', action = 'stake-settlement', payload = {}, now = Date.now() }) {
    const record = event ? eventOutput(event) : null;
    const win = lane === 'attacker-wins';
    const plan = win ? planMatchedCapture(chests, source, { eventScript: record?.script }) : planRaidSpend(source, { lane, eventScript: record?.script });
    const contract = win ? plan.escrow : plan.contract;
    if (contract.panel.keys.includes(publicKey) && !payoutsEnabled) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    if (win && (!payoutsEnabled || plan.contracts.some(item => item.operatorKey !== publicKey))) throw new Error('These War Chest outputs do not belong to the configured game key.');
    const pick = ({ txid, vout, satoshis, script, kv, escrow }) => ({ txid, vout, satoshis, script, ...(kv && { kv }), ...(escrow && { escrow }) });
    return { id: newId(), playerId, action, payload, network: NETWORK, direction: 'outgoing', state: 'created', createdAt: now, expiresAt: now + 48 * 3_600_000,
      script: plan.outputs[0].script, address: toAddress(plan.outputs[0].script), satoshis: plan.outputs[0].satoshis, layout: plan.outputs, lane, feeSatoshis: plan.feeSatoshis,
      sources: [...chests.map(pick), pick(source)], ...(win && plan.change && { changes: [plan.change] }),
      ...(win && { captureSatoshis: contract.principal, chestOutputs: chests.length }),
      attestation: { version: MATCHED_RAID, attestors, threshold: quorum, digests: win ? plan.digests : [plan.digest], signatures: {} },
      ...(record && { event, eventOutput: record }) };
  }

  // A version 3 stake is only proposed here. The panel signs after checking the battle or contest that decided it.
  const stakePlan = intent => planStakeSpend(intent.sources[0], { lane: intent.lane, payee: intent.payeeScript, eventScript: intent.eventOutput?.script });
  function proposeStakeSettlement({ source, lane, event, payee, playerId, action, payload, now }) {
    const payeeScript = payee ? decodeAddress(payee).script : undefined;
    let record = event ? eventOutput(event) : null;
    let plan = planStakeSpend(source, { lane, payee: payeeScript, eventScript: record?.script });
    // The outcome's fee is exactly the reserve. If the record output would not fit, the settlement goes without it.
    const size = 10 + 40 + 3 + 66 * plan.contract.panel.threshold + (plan.contract.panel.keys.length - plan.contract.panel.threshold) + 1 + 3 + plan.contract.redeemScript.length / 2 +
      plan.outputs.reduce((sum, item) => sum + 9 + item.script.length / 2, 0);
    if (size > plan.contract.reserve) { record = null; plan = planStakeSpend(source, { lane, payee: payeeScript }); }
    const mine = plan.contract.panel.keys.includes(publicKey);
    if (mine && !payoutsEnabled) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    const external = plan.contract.panel.keys.filter(item => item !== publicKey);
    return { id: newId(), playerId, action, payload, network: NETWORK, direction: 'outgoing', state: 'created', createdAt: now, expiresAt: now + 48 * 3_600_000,
      script: plan.outputs[0].script, address: toAddress(plan.outputs[0].script), satoshis: plan.outputs[0].satoshis, layout: plan.outputs, lane, ...(payeeScript && { payeeScript }),
      feeSatoshis: plan.contract.reserve, sources: [{ txid: source.txid, vout: source.vout, satoshis: source.satoshis, script: source.script, escrow: source.escrow }],
      attestation: { version: STAKE_ESCROW_3, attestors: external, threshold: plan.contract.panel.threshold - (mine ? 1 : 0), digests: [plan.digest], signatures: {} },
      ...(record && { event, eventOutput: record }) };
  }

  // Settles a stake escrow through one of its fixed lanes. `lane` is an outcome name, or 'refund' for the timed recovery.
  function signStakeSettlement({ source, lane, event, payee, chests, playerId = 'council', action = 'stake-settlement', payload = {}, now = Date.now() }) {
    const descriptor = source.escrow;
    if (descriptor.version === 4) return proposeRaidSettlement({ source, lane, chests, event, playerId, action, payload, now });
    if (descriptor.version === 3) return proposeStakeSettlement({ source, lane, event, payee, playerId, action, payload, now });
    if (!payoutsEnabled) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    const record = event && descriptor.record === true && lane !== 'refund' ? eventOutput(event) : null;
    const plan = planTreasurySpend(descriptor, source, { lane, ...(payee && { payee }), ...(record && { eventScript: record.script }) });
    if (plan.refund && plan.contract.refundKey) throw new Error('Only the owner can sign the timed recovery of this escrow.');
    const digest = treasurySigningHash(plan);
    const needed = plan.refund ? 0 : plan.contract.keys.length;
    const signed = completeTreasurySpend(plan, Array.from({ length: needed }, () => hex(secp256k1.signMessageHashSchnorr(fromHex(treasuryPrivateKey), digest))));
    const layout = plan.transaction.outputs.map(output => ({ script: hex(output.lockingBytecode), satoshis: Number(output.valueSatoshis) }));
    return { ...signed, id: newId(), playerId, action, payload, network: NETWORK, direction: 'outgoing', state: 'submitted', createdAt: now, expiresAt: null,
      script: layout[0].script, address: toAddress(layout[0].script), satoshis: layout[0].satoshis, layout, lane,
      sources: [{ txid: source.txid, vout: source.vout, satoshis: source.satoshis, script: source.script }],
      ...(record && { event, eventOutput: record }) };
  }

  // Kingdom vault outputs pay their owner's wallet only. The plan may spend several outputs of one owner.
  function prepareKingdomPayout({ playerId, action, payload, sources, satoshis, leaving, event, now = Date.now() }) {
    if (!enabled || sources.some(source => source.kv?.operatorKey !== publicKey)) throw new Error('These kingdom vault outputs do not belong to the configured game key.');
    const record = event && eventOutput(event);
    const plan = planKingdomWithdrawal(sources, leaving !== undefined ? { leaving, eventScript: record?.script } : { satoshis, eventScript: record?.script });
    const owner = plan.contracts[0];
    return { id: newId(), playerId, action, payload, script: owner.ownerScript, address: owner.ownerAddress, satoshis: plan.paid, feeSatoshis: plan.feeSatoshis,
      sources: plan.sources.map(({ txid, vout, satoshis: value, script, kv }) => ({ txid, vout, satoshis: value, script, kv })), kvSource: true,
      layout: plan.outputs, change: plan.change, ...(event && { event, eventOutput: record }),
      direction: 'outgoing', network: NETWORK, state: 'awaiting_signature', createdAt: now, expiresAt: null };
  }

  function signKingdomPayout(intent) {
    if (!payoutsEnabled || !intent.kvSource) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    const record = intent.event && intent.eventOutput;
    const plan = planKingdomWithdrawal(intent.sources, { satoshis: intent.satoshis, eventScript: record?.script });
    if (plan.paid !== intent.satoshis || plan.feeSatoshis !== intent.feeSatoshis) throw new Error('The kingdom payout no longer matches its quote.');
    return signKingdomWithdrawal(plan, treasuryPrivateKey);
  }

  // A capture after a lost battle. It is only a proposal: the war chest script needs every independent attestor as well.
  function prepareCapture({ sources, feeders = [], satoshis, address, event, playerId = 'council', payload = {}, now = Date.now() }) {
    if (!payoutsEnabled) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    const destination = decodeAddress(address);
    const record = event && eventOutput(event);
    const riding = feeders.map(item => ({ txid: item.txid, vout: item.vout, satoshis: item.satoshis, script: item.script, cf: item.cf, contract: chestFeeder(item.cf) }));
    const plan = planChestCapture(sources, { satoshis, script: destination.script, eventScript: record?.script, feeders: riding });
    const lead = plan.contracts[0];
    if (plan.contracts.some(item => item.attestors.join() !== lead.attestors.join() || quorumOf(item) !== quorumOf(lead))) throw new Error('One capture spends war chest outputs of one attestor set.');
    return { id: newId(), playerId, action: 'chest-capture', payload, network: NETWORK, direction: 'outgoing', state: 'created', createdAt: now, expiresAt: now + 7 * 86_400_000,
      script: plan.outputs[0].script, address: plan.changes[0].address, satoshis: plan.outputs[0].satoshis, layout: plan.outputs, capturedSatoshis: plan.paid,
      captureSatoshis: satoshis, captureAddress: destination.address, captureScript: destination.script, feeSatoshis: plan.feeSatoshis, changes: plan.changes,
      sources: plan.sources.map(({ txid, vout, satoshis: value, script, kv }) => ({ txid, vout, satoshis: value, script, kv })),
      ...(riding.length && { feeders: riding.map(({ contract, ...item }) => item) }),
      attestation: { version: WAR_CHEST, attestors: lead.attestors, threshold: quorumOf(lead), digests: captureDigests(plan), signatures: {} },
      ...(event && { event, eventOutput: record }) };
  }

  // A personal deposit locked to the owner's vault covenant instead of an operator-only output.
  function createVaultIntent({ playerId, payload, satoshis, ownerKey, recoverAt, event, now = Date.now() }) {
    if (!enabled) throw new Error('A ' + NETWORK_LABEL + ' treasury public key is required to issue payment intents.');
    const id = newId();
    const vault = vaultCovenant({ id, operatorKey: publicKey, ownerKey, recoverAt });
    const value = Number(amount(satoshis, 576n));
    const commitment = gameEvent('vault-deposit', id, { ...event,
      vault: { version: VAULT_COVENANT, script: vault.script, owner: vault.ownerAddress, recoverAt } });
    return { id, playerId, action: 'vault-deposit', payload, satoshis: value, direction: 'incoming', network: NETWORK,
      state: 'awaiting_signature', createdAt: now, expiresAt: now + INTENT_TTL,
      script: vault.script, address: vault.address, redeemScript: vault.redeemScript, vault,
      outputs: [{ role: 'funding', script: vault.script, address: vault.address, redeemScript: vault.redeemScript, satoshis: value, vault },
        eventOutput(commitment)], event: commitment };
  }

  // The operator lane of a vault pays its owner only. `satoshis` undefined pays the whole output.
  function prepareVaultPayout({ playerId, action, payload, source, satoshis, event, now = Date.now() }) {
    if (!enabled || !source?.vault || source.vault.operatorKey !== publicKey) throw new Error('This vault output does not belong to the configured operator.');
    const record = event && eventOutput(event);
    const plan = planVaultWithdrawal(source.vault, source, { satoshis, eventScript: record?.script });
    const { contract } = plan;
    return { id: newId(), playerId, action, payload, script: contract.ownerScript, address: contract.ownerAddress, satoshis: plan.paid,
      sources: [{ txid: source.txid, vout: source.vout, satoshis: source.satoshis, script: contract.script, redeemScript: contract.redeemScript, vault: source.vault }],
      vaultSource: true, feeSatoshis: plan.feeSatoshis,
      change: plan.change ? { script: contract.script, address: contract.address, redeemScript: contract.redeemScript, vout: 1,
        satoshis: plan.change, vault: source.vault } : undefined,
      ...(event && { event, eventOutput: record }),
      direction: 'outgoing', network: NETWORK, state: 'awaiting_signature', createdAt: now, expiresAt: null };
  }

  function signVaultPayout(intent) {
    if (!payoutsEnabled || !intent.vaultSource || intent.network !== NETWORK) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    const [source] = intent.sources;
    const plan = planVaultWithdrawal(source.vault, source, { satoshis: intent.change ? intent.satoshis : undefined, eventScript: intent.eventOutput?.script });
    if (plan.paid !== intent.satoshis || plan.change !== (intent.change?.satoshis ?? 0)) throw new Error('The vault payout no longer matches its plan.');
    return signVaultWithdrawal(plan, treasuryPrivateKey);
  }

  // An attestor proves who it is before it is given a battle record that is not public yet.
  const attestorRequest = (id, key, signature) => attestors.includes(String(key).toLowerCase()) && /^[0-9a-f]{128}$/.test(signature ?? '') &&
    secp256k1.verifySignatureSchnorr(fromHex(signature), fromHex(String(key).toLowerCase()), evidenceDigest(id)) === true;

  // The height of the best block the observer knows, for covenants that count blocks.
  const height = () => observer.withClient(async client => Number.isSafeInteger(client.tip) ? client.tip : null);

  // Finds a confirmed transaction, other than our own, that spent a watched output.
  async function findSpend(source) {
    return observer.withClient(async client => {
      if (!client.history || !client.raw) return null;
      const history = await client.history(source.script);
      for (const candidate of history.filter(item => item.txid !== source.txid && item.height > 0).slice(-25)) {
        const raw = await client.raw(candidate.txid);
        if (!raw) continue;
        const { transaction } = readTransaction(raw, candidate.txid);
        const inputIndex = transaction.inputs.findIndex(input => hex(input.outpointTransactionHash) === source.txid && input.outpointIndex === source.vout);
        if (inputIndex < 0) continue;
        const receipt = await client.lookup(candidate.txid, candidate.height);
        if (receipt && receipt.confirmations >= minConfirmations) {
          return { txid: receipt.txid, confirmations: receipt.confirmations, height: receipt.height, explorerUrl: explorerUrl(receipt.txid), inputIndex,
            inputs: transaction.inputs.map(input => ({ txid: hex(input.outpointTransactionHash), vout: input.outpointIndex })),
            outputs: transaction.outputs.map((output, vout) => ({ vout, script: hex(output.lockingBytecode), satoshis: Number(output.valueSatoshis) })) };
        }
      }
      return null;
    });
  }

  function createPoliticalEscrowIntent({playerId,payload,payerKey,payeeKey,principal,refundAt,event,now=Date.now()}) {
    if (!enabled || !publicKey) throw new Error('The ' + NETWORK_LABEL + ' political escrow operator is unavailable.');
    const contract=politicalEscrow({id:newId(),operatorKey:publicKey,payerKey,payeeKey,principal,refundAt,version:POLITICAL_ESCROW_VERSION});
    const commitment=gameEvent('political-escrow',contract.id,{...event,principal,refundAt,script:contract.script});
    return {id:contract.id,playerId,payload,action:'political-escrow',direction:'incoming',network:NETWORK,
      script:contract.script,address:contract.address,satoshis:contract.satoshis,contract,state:'awaiting_signature',
      createdAt:now,expiresAt:now+INTENT_TTL,event:commitment,
      outputs:[{role:'treaty-escrow',script:contract.script,address:contract.address,satoshis:contract.satoshis},eventOutput(commitment)]};
  }

  function signPoliticalSettlement({row,lane,event,now=Date.now()}) {
    if (!payoutsEnabled || !row.contract || row.action!=='political-escrow' || row.state!=='credited' || !row.receipt) {
      throw new Error('A confirmed political escrow is required before settlement.');
    }
    const source=row.receipt.allocations?.find(output=>output.role==='treaty-escrow');
    if (!source || source.txid!==row.txid) throw new Error('Missing confirmed political escrow outpoint.');
    const commitment=eventOutput(event);
    const signed=signPoliticalEscrow({contract:row.contract,source,privateKey:treasuryPrivateKey,lane,eventScript:commitment.script});
    return {...signed,id:newId(),playerId:row.playerId,action:event.kind,payload:row.payload,network:NETWORK,
      satoshis:row.contract.principal,sources:[source],event,eventOutput:commitment,direction:'outgoing',
      state:'submitted',createdAt:now,expiresAt:null};
  }

  // Returns a wrongly funded version 2 escrow output to its payer through the operator refund lane.
  function signPoliticalMisfundRefund({row,source,event,now=Date.now()}) {
    if (!payoutsEnabled || row.action!=='political-escrow' || row.contract?.version!==2) {
      throw new Error('Only a version 2 political escrow can return a wrongly funded payment.');
    }
    const commitment=eventOutput(event);
    const signed=signPoliticalEscrow({contract:row.contract,source,privateKey:treasuryPrivateKey,lane:'operator-refund',eventScript:commitment.script});
    return {...signed,id:newId(),playerId:row.playerId,action:event.kind,payload:row.payload,network:NETWORK,
      sources:[{txid:source.txid,vout:source.vout,satoshis:source.satoshis,script:source.script}],event,eventOutput:commitment,
      direction:'outgoing',state:'submitted',createdAt:now,expiresAt:null};
  }

  async function politicalSpend(row) {
    const source=row.receipt?.allocations?.find(output=>output.role==='treaty-escrow');
    if (!source || !row.contract) return null;
    return observer.withClient(async client=> {
      if (!client.history) return null;
      const history=await client.history(source.script);
      for (const candidate of history.filter(item=>item.txid!==source.txid && item.height>0).slice(-12)) {
        const receipt=await client.lookup(candidate.txid,candidate.height);
        if (!receipt || receipt.confirmations<minConfirmations || !receipt.transaction.inputs.some(input=>
          hex(input.outpointTransactionHash)===source.txid && input.outpointIndex===source.vout)) continue;
        const [payment]=receipt.transaction.outputs;
        const payer=decodeAddress(row.contract.payer).script;
        const payee=decodeAddress(row.contract.payee).script;
        if (outputMatches(payment,payer,row.contract.principal) || outputMatches(payment,payee,row.contract.principal)) {
          return {txid:receipt.txid,confirmations:receipt.confirmations,height:receipt.height,blockHash:receipt.blockHash,
            explorerUrl:explorerUrl(receipt.txid),lane:hex(payment.lockingBytecode)===payee ? 'release' : 'payer-refund'};
        }
      }
      return null;
    });
  }

  function preparePayout({ playerId, action, payload, satoshis, address, sources, event, retain = false, now = Date.now() }) {
    if (!enabled || !publicKey) throw new Error('The ' + NETWORK_LABEL + ' treasury is not configured.');
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > 32) throw new Error('The payout requires confirmed treasury outputs.');
    const id = newId();
    const destination = retain ? incomingDestination(id, publicKey) : decodeAddress(address);
    const outpoints = sources.map((source) => {
      const verified = normalizeSource(source);
      const redemption = verified.redeemScript;
      if (typeof redemption !== 'string') throw new Error('Invalid treasury redeem script.');
      const intentId = redemption.slice(2, 34);
      const expected = incomingDestination(intentId, publicKey);
      if (expected.redeemScript !== redemption || (verified.script && verified.script !== expected.script)) {
        throw new Error('Payout source does not belong to the configured ' + NETWORK_LABEL + ' treasury.');
      }
      return { ...expected, txid: verified.txid, vout: verified.vout, satoshis: verified.satoshis };
    });
    if (new Set(outpoints.map(({ txid, vout }) => txid + ':' + vout)).size !== outpoints.length) {
      throw new Error('A payout cannot spend the same outpoint twice.');
    }
    const balance = outpoints.reduce((sum, source) => sum + BigInt(source.satoshis), 0n);
    // An outcome anchor spends one Schnorr P2SH input and writes two outputs in 253 bytes.
    const compactAnchor = action === 'political-outcome' && retain && satoshis === undefined &&
      event && outpoints.length === 1;
    const projectedFee = BigInt(compactAnchor ? 254 : 140 + 160 * outpoints.length + (event ? 56 : 0));
    const value = amount(retain && satoshis === undefined ? balance - projectedFee : satoshis, DUST);
    const remainder = balance - value - projectedFee;
    if (remainder < 0n) throw new Error('Reserved outputs do not cover the payout amount and network fee.');
    const change = remainder >= DUST ? {
      ...incomingDestination(retain ? protocolHash({ id, role: 'change' }).slice(0, 32) : id, publicKey), vout: 1, satoshis: Number(remainder),
    } : undefined;
    const fee = projectedFee + (change ? 0n : remainder);
    if (fee > projectedFee + PAYOUT_DUST_BUFFER) throw new Error('Invalid payout fee.');
    return {
      id, playerId, action, payload, ...destination, satoshis: Number(value),
      sources: outpoints, change, feeSatoshis: Number(fee),
      ...(event && { event, eventOutput: eventOutput(event) }),
      direction: 'outgoing', network: NETWORK, state: 'awaiting_signature',
      createdAt: now, expiresAt: null,
    };
  }

  // Sweeps exactly funded prize carriers into the season prize output and each kingdom output. One treasury output pays the fee.
  function signCarrierSweep({ carriers, feeSource, seasonId, event, now = Date.now() }) {
    if (!payoutsEnabled) throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    if (!Array.isArray(carriers) || !carriers.length || carriers.length > 24) throw new Error('Sweep between 1 and 24 carriers.');
    // The carrier committed to its two destinations when it was funded; they are stored with the carrier output.
    const prize = carriers[0].prize?.script ? carriers[0].prize : prizeAggregate(seasonId, publicKey);
    if (carriers.some(item => (item.prize?.script ?? prize.script) !== prize.script)) throw new Error('One sweep serves carriers of one prize destination.');
    const inputs = carriers.map(item => {
      const kingdom = item.kingdom?.script ? item.kingdom : incomingDestination(item.id, publicKey);
      const contract = prizeCarrier({ id: item.id, operatorKey: publicKey, prize: item.prizeSatoshis, kingdom: item.kingdomSatoshis,
        prizeScript: prize.script, kingdomScript: kingdom.script });
      if (contract.script !== item.script || contract.satoshis !== item.satoshis) throw new Error('A carrier does not match its committed terms.');
      return { contract, kingdom, source: { txid: item.txid, vout: item.vout, satoshis: item.satoshis, script: contract.script,
        redeemScript: contract.redeemScript, unlocking: carrierSweepUnlocking } };
    });
    if (new Set(inputs.map(item => item.source.txid + ':' + item.source.vout)).size !== inputs.length) throw new Error('A carrier can be swept once.');
    const payer = normalizeSource(feeSource);
    const owned = incomingDestination(String(payer.redeemScript).slice(2, 34), publicKey);
    if (owned.redeemScript !== payer.redeemScript) throw new Error('The sweep fee input does not belong to the configured ' + NETWORK_LABEL + ' treasury.');
    const id = newId();
    const shares = inputs.map(item => item.contract.prize);
    const owed = shares.reduce((sum, value) => sum + value, 0);
    // Every carrier demands its own share for each carrier input. A lone carrier is raised to the dust limit by the fee input.
    const prizeValue = Math.max(Number(DUST), owed, Math.max(...shares) * inputs.length);
    const commitment = eventOutput(event);
    const payments = [{ script: prize.script, satoshis: prizeValue }, ...inputs.map(item => ({ script: item.kingdom.script, satoshis: item.contract.kingdom }))];
    const bytes = 10 + inputs.reduce((sum, item) => sum + 45 + item.contract.redeemScript.length / 2, 0) + 160 +
      (payments.length + 1) * 32 + 9 + commitment.script.length / 2;
    const balance = inputs.reduce((sum, item) => sum + item.source.satoshis, 0) + payer.satoshis;
    const remainder = balance - payments.reduce((sum, item) => sum + item.satoshis, 0) - bytes;
    if (remainder < 0) throw new Error('The sweep fee input is too small.');
    const change = remainder >= Number(DUST) ? { ...incomingDestination(protocolHash({ id, role: 'change' }).slice(0, 32), publicKey),
      vout: payments.length, satoshis: remainder } : undefined;
    const layout = [...payments, ...(change ? [{ script: change.script, satoshis: change.satoshis }] : []), { script: commitment.script, satoshis: 0 }];
    const signed = signSpend({ sources: [...inputs.map(item => item.source), { ...owned, txid: payer.txid, vout: payer.vout, satoshis: payer.satoshis }],
      outputs: layout, privateKey: treasuryPrivateKey });
    return { ...signed, id, playerId: 'council', action: 'allocation-sweep', payload: { carriers: inputs.map(item => item.source.txid + ':' + item.source.vout), seasonId },
      ...prize, satoshis: prizeValue, direction: 'outgoing', network: NETWORK, state: 'submitted', createdAt: now, expiresAt: null,
      sources: [...inputs.map(item => ({ txid: item.source.txid, vout: item.source.vout, satoshis: item.source.satoshis, script: item.source.script })),
        { txid: payer.txid, vout: payer.vout, satoshis: payer.satoshis, script: owned.script, redeemScript: owned.redeemScript }],
      layout, change, event, eventOutput: commitment, topUpSatoshis: prizeValue - owed,
      sweepOutputs: [{ role: 'prize', vout: 0, ...prize, satoshis: prizeValue, seasonId },
        ...inputs.map((item, index) => ({ role: 'kingdom', vout: index + 1, ...item.kingdom, satoshis: item.contract.kingdom }))] };
  }

  function signPayout(intent) {
    if (!payoutsEnabled || intent.network !== NETWORK || intent.direction !== 'outgoing') {
      throw new Error('The ' + NETWORK_LABEL + ' payout signer is unavailable.');
    }
    return signSpend({
      sources: intent.sources, outputs: [intent, ...(intent.change ? [intent.change] : []), ...(intent.event ? [intent.eventOutput] : [])],
      privateKey: treasuryPrivateKey,
    });
  }

  function submit(intent, provided, now = Date.now()) {
    const txid = validTxid(provided);
    if (intent.network !== NETWORK) throw new Error('This intent is unavailable on ' + NETWORK_LABEL + '.');
    if (intent.txid === txid) return { ...intent };
    if (intent.txid && !['rejected', 'expired'].includes(intent.state)) throw new Error('A transaction is already attached to this intent.');
    return {
      ...intent, txid, submittedAt: now, acceptedAt: undefined, receipt: null, lastError: null, state: 'submitted',
    };
  }

  async function findObservation(client, intent) {
    const history = client.history ? await client.history(intent.script) : [];
    if (intent.txid) {
      const matchingHistory = history.find((entry) => entry.txid === intent.txid);
      // Scripthash history distinguishes missing from unconfirmed on Fulcrum.
      // Without a history match, fetch the specified TXID to report a wrong payment.
      return client.lookup(intent.txid, matchingHistory?.height);
    }
    for (const candidate of history.slice(-12).reverse()) {
      const found = await client.lookup(candidate.txid, candidate.height);
      if (found && matchReceipt(intent, found)) return found;
    }
    return null;
  }

  async function observe(intent, now = Date.now()) {
    try {
      if (intent.network !== NETWORK) return { ...intent, state: 'rejected', lastError: 'Intent belongs to another network.' };
      const recoveryOpen = intent.event && now <= intent.expiresAt + RECOVERY_TTL;
      if (intent.direction === 'incoming' && !intent.txid && now > intent.expiresAt && !intent.acceptedAt && !recoveryOpen) {
        return existingOrPending(intent, now);
      }
      return await observer.withClient(async (client) => {
        const observed = await findObservation(client, intent);
        if (!observed) return existingOrPending(intent, now);
        const receipt = matchReceipt(intent, observed);
        if (!receipt) {
          return {
            ...intent, state: 'rejected', receipt: null,
            lastError: 'The ' + NETWORK_LABEL + ' transaction does not have the exact expected BCH outputs and inputs for this intent.',
          };
        }
        const feeSatoshis = intent.direction === 'outgoing'
          ? intent.feeSatoshis
          : intent.receipt?.feeSatoshis ?? await observedFee(client, observed.transaction);
        const acceptedAt = intent.acceptedAt ?? now;
        const funded = { ...intent, txid: observed.txid, receipt: { ...receipt, feeSatoshis }, lastError: null, acceptedAt };
        if (intent.direction !== 'outgoing' && acceptedAt > intent.expiresAt && !intent.event) {
          return { ...funded, state: 'expired', lastError: 'Transfer observed after the payment window. Contact the operator using this receipt.' };
        }
        if (intent.direction === 'incoming' && acceptedAt > intent.expiresAt) funded.late = true;
        if (observed.confirmations < minConfirmations &&
          ['confirmed', 'credited', 'reorg'].includes(intent.state)) {
          return { ...funded, state: 'reorg', lastError: '' + NETWORK_LABEL + ' confirmations fell below the finalization threshold.' };
        }
        if (observed.confirmations >= minConfirmations) {
          return { ...funded, state: intent.state === 'credited' ? 'credited' : 'confirmed' };
        }
        return { ...funded, state: observed.confirmations > 0 ? 'confirming' : 'seen_in_mempool' };
      });
    } catch {
      return {
        ...intent, state: ['confirmed', 'credited', 'reorg'].includes(intent.state) ? intent.state : 'uncertain',
        lastError: '' + NETWORK_LABEL + ' observer unavailable or returned inconsistent data. Verification will retry.',
      };
    }
  }

  function publicIntent(intent) {
    const {
      id, playerId, action, payload, network, state, direction, address, satoshis, feeSatoshis,
      createdAt, expiresAt, txid, receipt, lastError,
    } = intent;
    return {
      id, playerId, action, payload, network, state, direction, address, satoshis,
      feeSatoshis: feeSatoshis ?? receipt?.feeSatoshis ?? null,
      amountBch: toBch(satoshis), createdAt, expiresAt, txid, receipt: publicReceipt(receipt), lastError,
      minConfirmations,
      walletUri: direction === 'incoming' && !intent.outputs ? address + '?amount=' + toBch(satoshis) : undefined,
      ...(intent.outputs && { outputs: publicOutputs(intent.outputs) }),
      ...(intent.event && { event: intent.event }),
      ...(intent.contract && { contract:intent.contract }),
      ...(intent.vault && { vault:intent.vault }),
      ...(intent.fund && { fund: { ...intent.fund, version: PRIZE_FUND } }),
      ...(intent.attestation && { attestation: { version: intent.attestation.version, attestors: intent.attestation.attestors,
        signed: Object.keys(intent.attestation.signatures), complete: Boolean(intent.rawHex) } }),
      ...(intent.late && { late: true }),
      explorerUrl: txid ? explorerUrl(txid) : undefined,
    };
  }

  async function verifyPublishedTransaction(provided) {
    const txid = validTxid(provided);
    return observer.withClient(async (client) => {
      const observation = await client.lookup(txid);
      if (!observation) return null;
      const { transaction, ...fields } = observation;
      return {
        ...fields, network: NETWORK, explorerUrl: explorerUrl(txid),
        feeSatoshis: await observedFee(client, transaction),
        inputs: transaction.inputs.map(input => ({ txid:hex(input.outpointTransactionHash), vout:input.outpointIndex })),
        outputs: transaction.outputs.map((output, vout) => ({
          vout, script: hex(output.lockingBytecode), satoshis: Number(output.valueSatoshis),
          asset: output.token ? 'CashTokens' : 'BCH',
          ...(output.token && { token: {
            category: hex(output.token.category), amount: String(output.token.amount),
            ...(output.token.nft && { nft: {
              capability: output.token.nft.capability, commitment: hex(output.token.nft.commitment),
            } }),
          } }),
        })),
      };
    });
  }

  async function blockAt(height) {
    return observer.withClient(async client => {
      const target = height ?? client.tip;
      if (!Number.isSafeInteger(target) || target < 1 || target > client.tip || !client.block) return null;
      const raw = await client.block(target);
      const header = parseHeader(raw);
      return { network:NETWORK, height:target, tip:client.tip, confirmations:client.tip - target + 1,
        hash:header.hash, raw, timestamp:header.timestamp * 1000 };
    });
  }

  async function broadcast(rawHex) {
    const { txid } = readTransaction(rawHex);
    await observer.withClient(async (client) => {
      let reported;
      try {
        reported = await client.broadcast(rawHex);
      } catch (error) {
        // Transaction submits can race a previous broadcast or process restart.
        if (/already (?:in|known|have)/i.test(error.message) && await client.lookup(txid)) return;
        throw error;
      }
      if (reported !== txid) throw new Error('The ' + NETWORK_LABEL + ' broadcast returned an unexpected transaction ID.');
    });
    return txid;
  }

  async function listCashTokens(address) {
    const destination = decodeAddress(address);
    return observer.withClient(async (client) => {
      if (!client.listUnspent) throw new Error('CashTokens inventory requires a ' + NETWORK_LABEL + ' Fulcrum indexer.');
      const coins = await client.listUnspent(destination.script, 'tokens_only');
      const candidates = coins.filter(({ height }) => height > 0).slice(0, 50);
      const outputs = await Promise.all(candidates.map(async ({ txid, vout, height, satoshis }) => {
        const observed = await client.lookup(txid, height);
        const output = observed?.transaction.outputs[vout];
        if (!output?.token || observed.confirmations < minConfirmations ||
            hex(output.lockingBytecode) !== destination.script || output.valueSatoshis !== BigInt(satoshis)) return null;
        const { amount, category, nft } = output.token;
        return {
          txid, vout, satoshis, height, address: destination.address, network: NETWORK,
          confirmations: observed.confirmations, explorerUrl: explorerUrl(txid),
          category: hex(category), amount: String(amount), capability: nft?.capability ?? null,
          commitment: nft ? hex(nft.commitment) : null,
        };
      }));
      return outputs.filter(Boolean);
    });
  }

  async function mintBadgeWithLocalKey(privateKey, category, address, commitment) {
    const owner = walletFromPrivateKey(privateKey);
    const destination = decodeAddress(address);
    if (!destination.tokenSupport) throw new Error('Use a token-aware ' + NETWORK_LABEL + ' CashAddr.');
    const txid = validTxid(category);
    if (typeof commitment !== 'string' || !/^(?:[0-9a-f]{2}){1,40}$/i.test(commitment)) {
      throw new Error('An immutable badge needs a 1–40 byte hexadecimal commitment.');
    }
    const signed = await observer.withClient(async (client) => {
      if (!client.listUnspent) throw new Error('Badge minting requires a ' + NETWORK_LABEL + ' Fulcrum indexer.');
      const coins = await client.listUnspent(owner.script);
      const source = coins.find((coin) => coin.txid === txid && coin.vout === 0);
      if (!source) throw new Error('The fixture key must own the unspent vout 0 of the category transaction.');
      const { transaction } = readTransaction(await client.raw(txid), txid);
      if (!outputMatches(transaction.outputs[0], owner.script, source.satoshis)) {
        throw new Error('The genesis input must contain ordinary ' + NETWORK_LABEL + ' BCH and belong to the fixture wallet.');
      }
      const fee = 350n;
      const carried = amount(source.satoshis, DUST + fee);
      const token = { category: fromHex(txid), amount: 0n, nft: { capability: 'none', commitment: fromHex(commitment) } };
      return signSpend({
        privateKey, sources: [normalizeSource(source)], outputs: [
          { ...destination, satoshis: Number(carried - fee), token },
        ],
      });
    });
    await broadcast(signed.rawHex);
    return { ...signed, category: txid, address: destination.address, commitment: commitment.toLowerCase() };
  }

  async function localWalletBalance(address) {
    const { script } = decodeAddress(address);
    return observer.withClient(async (client) => {
      if (!client.listUnspent) throw new Error('Wallet balance lookup requires a ' + NETWORK_LABEL + ' Electrum indexer.');
      const coins = await client.listUnspent(script);
      return coins.reduce((total, coin) => total + Number(coin.satoshis), 0);
    });
  }

  async function walletCoins(keys) {
    return observer.withClient(async client => {
      if (!client.listUnspent) throw new Error('The wallet checkout needs a ' + NETWORK_LABEL + ' UTXO indexer.');
      const groups = await Promise.all(keys.map(async key => ({ ...key, coins: await client.listUnspent(key.script) })));
      const gathered = groups.flatMap(({ coins, ...key }) => coins.map(source => ({ ...key, ...source })));
      const verified = await Promise.all(gathered.sort((a, b) => b.satoshis - a.satoshis).slice(0, 32).map(async source => {
        if (!HEX64.test(source.txid) || source.satoshis < Number(DUST) || source.height <= 0) return null;
        const { transaction } = readTransaction(await client.raw(source.txid), source.txid);
        if (!outputMatches(transaction.outputs[source.vout], source.script, source.satoshis)) return null;
        const coinbase = transaction.inputs.length === 1 && /^0+$/.test(hex(transaction.inputs[0].outpointTransactionHash));
        if (coinbase && client.tip - source.height + 1 < 101) return null;
        return source;
      }));
      return verified.filter(Boolean);
    });
  }

  async function sendOutputsWithLocalKey(privateKey, outputs) {
    const wallet = walletFromPrivateKey(privateKey);
    const spend = outputs.reduce((sum, output) => sum + amount(output.satoshis), 0n);
    const overhead = 75 + outputs.reduce((sum, output) => sum + 9 + output.script.length / 2, 0);
    const signed = await observer.withClient(async (client) => {
      if (!client.listUnspent) throw new Error('The local fixture signer requires a ' + NETWORK_LABEL + ' Electrum indexer.');
      const available = await client.listUnspent(wallet.script);
      const sources = [];
      let total = 0n;
      for (const item of available.sort((one, two) => two.satoshis - one.satoshis).slice(0, 32)) {
        if (!HEX64.test(item.txid) || Number(item.satoshis) < Number(DUST)) continue;
        const { transaction } = readTransaction(await client.raw(item.txid), item.txid);
        if (!outputMatches(transaction.outputs[item.vout], wallet.script, item.satoshis)) continue;
        const coinbase = transaction.inputs.length === 1 && /^0+$/.test(hex(transaction.inputs[0].outpointTransactionHash));
        if (coinbase && (item.height <= 0 || client.tip - item.height + 1 < 101)) continue;
        sources.push(normalizeSource(item));
        total += amount(item.satoshis);
        if (total >= spend + BigInt(overhead + 145 * sources.length)) break;
      }
      const remainder = total - spend - BigInt(overhead + 145 * sources.length);
      if (sources.length === 0 || remainder < 0n) throw new Error('The local wallet has insufficient available ' + NETWORK_LABEL + ' BCH.');
      return signSpend({
        privateKey, sources, outputs: [
          ...outputs, ...(remainder >= DUST ? [{ script: wallet.script, satoshis: Number(remainder) }] : []),
        ],
      });
    });
    await broadcast(signed.rawHex);
    return signed;
  }

  function sendWithLocalKey(privateKey, address, satoshis) {
    return sendOutputsWithLocalKey(privateKey, [{ ...decodeAddress(address), satoshis: Number(amount(satoshis, DUST)) }]);
  }

  return {
    enabled, payoutsEnabled, minConfirmations, createIntent, createPoliticalEscrowIntent, signPoliticalSettlement, signPoliticalMisfundRefund, politicalSpend,
    preparePayout, signPayout, signCarrierSweep, seasonPool, poolSweep, feedSweep, attestorRequest, height, chestContract: terms => kingdomVault(terms), chestFeed, chestOf, captureCost, captureFloor, chestFeedBytes: feedBytes, attestorThreshold: quorum, carrierRefund: carriers => buildCarrierRefund(carriers), createChestIntent, signPoliticalRecord, recordReserve: RECORD_RESERVE, createStakeIntent, createRaidIntent, raidQuote, chestGrid: CHEST_GRID, matchedOutputs: MATCHED_INPUTS - 1, signStakeSettlement, prepareKingdomPayout, signKingdomPayout, prepareCapture, createSponsorIntent, preparePrizeAward, attestPrizeAward, prizeRefund, createVaultIntent, prepareVaultPayout, signVaultPayout, findSpend, submit, observe,
    publicIntent, verifyPublishedTransaction, blockAt, listCashTokens, mintBadgeWithLocalKey, broadcast, sendWithLocalKey, sendOutputsWithLocalKey, localWalletBalance, walletCoins,
    supportsVaultborn: true, treasuryPublicKey: publicKey ?? null, developmentAddress: development?.address ?? null,
    sponsorshipMinimumSatoshis, prizeAttestors: attestors, sponsorDevelopmentAddress: sponsorDevelopment?.address ?? null,
  };
}
