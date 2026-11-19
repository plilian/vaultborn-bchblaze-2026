import { getDustThreshold } from '@bitauth/libauth';
import { amount, DUST, fromHex, hex, incomingDestination, sha256 } from './primitives.mjs';
import { LEGACY_SPONSOR_ALLOCATION, PRIZE_CARRIER, sponsorshipAllocation } from '../../config/payments.mjs';
import { PRIZE_CARRIER_V2, prizeCarrier, prizeCarrier2 } from './prize-carrier.mjs';

const eventCodes = Object.freeze({
  premium: 1, rush: 2, 'attack-paid': 3, protectorate: 4, 'espionage-paid': 5,
  'vault-deposit': 6, 'sponsor-fund': 7, withdraw: 8, claim: 9, 'kingdom-withdraw': 10,
  'dao-spend': 11, 'battle-settlement': 12, conquest: 13, 'asset-transfer': 14, 'payment-recovery': 15,
  'territory-claim': 16, 'territory-attack': 17, 'territory-raffle': 18, 'territory-settlement': 19,
  'raffle-draw': 20, 'lease-expired': 21,
  'political-operation':22, 'political-escrow':23, 'political-release':24, 'political-refund':25, 'political-outcome':26,
  'payout-void':27, 'allocation-sweep':28, 'vault-recovery':29, 'sponsor-refund':30,
  'war-chest':31, 'chest-capture':32, 'stake-settlement':33, 'prize-settlement':34, 'carrier-refund':35,
});

export function canonical(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : Number(a > b))
        .map(([key, child]) => [key, normalize(child)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export const protocolHash = (value) => hex(sha256(Buffer.from(canonical(value), 'utf8')));

export function gameEvent(kind, subject, data) {
  if (!Object.hasOwn(eventCodes, kind)) throw new Error('Unknown VAULTBORN event kind.');
  const record = { version: 1, kind, subject, data };
  return { ...record, digest: protocolHash(record) };
}

export function eventOutput(event, satoshis = 0, role = 'event') {
  const { version, kind, digest, ...fields } = event;
  if (version !== 1 || !Object.hasOwn(eventCodes, kind) || digest !== protocolHash({ ...fields, version, kind })) {
    throw new Error('Invalid VAULTBORN event commitment.');
  }
  // OP_RETURN, push "VBRN", push protocol version, event code and SHA-256 digest.
  return {
    role, script: '6a045642524e22' + '01' + eventCodes[kind].toString(16).padStart(2, '0') + digest,
    satoshis: Number(amount(satoshis)),
  };
}

export function developmentOutputMinimum(destination) {
  if (!destination) return DUST;
  const dust = getDustThreshold({ lockingBytecode: fromHex(destination.script), valueSatoshis: 0n });
  return dust > DUST ? dust : DUST;
}

export function expectedPaymentOutputs({ id, publicKey, satoshis, allocation, event, developmentDestination, kingdomLock, prizeLock, sweep }) {
  // Only sponsorships quoted before the prize fund covenant use this operator-key layout. New ones are built by createSponsorIntent.
  const sponsor = event?.kind === 'sponsor-fund' && event.data?.allocationPolicy === LEGACY_SPONSOR_ALLOCATION;
  if (sponsor) {
    const { development, prize } = sponsorshipAllocation(Number(satoshis), undefined, LEGACY_SPONSOR_ALLOCATION);
    if (allocation?.development !== development || allocation?.prize !== prize ||
        event.data.allocation?.development !== development || event.data.allocation?.prize !== prize) {
      throw new Error('The sponsorship must send exactly 20% to Development and 80% to Seasonal Prizes.');
    }
  } else if (event?.kind === 'sponsor-fund' && allocation) {
    throw new Error('Use the sponsorship allocation policy for sponsor funding.');
  }
  const competitive=Object.hasOwn(allocation??{},'settlement');
  const role = allocation?.warChest !== undefined ? 'warChest' : allocation?.battle === undefined ? 'kingdom' : 'battle';
  if (role === 'warChest' && !((kingdomLock?.cf ? kingdomLock.chest?.kv?.capturePercent : kingdomLock?.kv?.capturePercent) && prizeLock?.feeder)) throw new Error('A service payment funds the payer War Chest covenant and the season pool feeder.');
  const spendable = sponsor ? ['prize', 'development'] : competitive ? ['battle','settlement'] :
    allocation ? [role, 'development', 'prize'] : ['funding'];
  if (allocation) {
    const roles = sponsor || competitive ? spendable : [...spendable, 'burn'];
    if (Object.keys(allocation).length!==roles.length) throw new Error('The BCH allocation contains unsupported outputs.');
    const total = roles.reduce((sum, bucket) => sum + amount(allocation[bucket]), 0n);
    if (!event || total !== amount(satoshis)) throw new Error('The BCH allocation does not conserve the payment.');
    if (roles.includes('development') && event.data?.developmentAddress !== developmentDestination?.address) {
      throw new Error('The payment commitment does not match its Development destination.');
    }
  }
  const carried = event?.data?.dust === PRIZE_CARRIER;
  if (carried) {
    if (sponsor || competitive || !allocation || !Number.isSafeInteger(event.data.seasonId)) throw new Error('Only a service payment can use a prize carrier.');
    const kingdom = kingdomLock ?? incomingDestination(id, publicKey);
    const prize = prizeLock ?? prizeAggregate(event.data.seasonId, publicKey);
    // With a payer-funded sweep reserve the carrier needs no operator key: it sweeps into the season pool and the payer's vault.
    const pooled = event.data.carrier === PRIZE_CARRIER_V2;
    if (pooled && !(kingdomLock?.kv && prizeLock?.fund && sweep?.payerScript && sweep.reserve === event.data.sweepReserve)) throw new Error('A pooled carrier needs the payer vault, the season pool and its sweep reserve.');
    const terms = pooled ? { id, prize:allocation.prize, kingdom:allocation.kingdom, reserve:sweep.reserve, prizeScript:prize.script, kingdomScript:kingdom.script,
      payerScript:sweep.payerScript, refundAt:sweep.refundAt } : null;
    const carrier = pooled ? prizeCarrier2(terms) : prizeCarrier({ id, operatorKey:publicKey, prize:allocation.prize, kingdom:allocation.kingdom,
      prizeScript:prize.script, kingdomScript:kingdom.script });
    const external = developmentDestination;
    const development = external || incomingDestination(protocolHash({ id, bucket:'development' }).slice(0, 32), publicKey);
    if (amount(allocation.development) < (external ? developmentOutputMinimum(external) : DUST)) throw new RangeError('Satoshi amount is outside the permitted range.');
    return [{ role:'carrier', script:carrier.script, address:carrier.address, redeemScript:carrier.redeemScript, satoshis:carrier.satoshis,
      prizeSatoshis:carrier.prize, kingdomSatoshis:carrier.kingdom, seasonId:event.data.seasonId, prize, kingdom,
      ...(pooled && { reserveSatoshis:carrier.reserve, carrier2:terms }) },
      { role:'development', ...development, ...(external && { custody:'external' }), satoshis:allocation.development },
      eventOutput(event, allocation.burn, 'burn')];
  }
  const outputs = spendable.map((bucket, index) => {
    const outputId = index === 0 ? id : protocolHash({ id, bucket }).slice(0, 32);
    const external = bucket === 'development' && developmentDestination;
    // A kingdom share is locked to its owner's vault and a prize share to the season pool when those covenants are supplied.
    const destination = external || (['kingdom','warChest'].includes(bucket) && kingdomLock) || (bucket === 'prize' && !sponsor && prizeLock) || incomingDestination(outputId, publicKey);
    // A prize share in a feeder carries its payer-funded network reserve on top of the exact share.
    // The War Chest share in its feeder carries its own reserve in the same way.
    const value = amount(allocation ? allocation[bucket] : satoshis) + BigInt(bucket === 'prize' && !sponsor && prizeLock?.feeder ? prizeLock.reserveSatoshis : 0) +
      BigInt(bucket === 'warChest' && kingdomLock?.cf ? kingdomLock.reserveSatoshis : 0);
    const minimum = external ? developmentOutputMinimum(destination) : DUST;
    if (value < minimum) {
      if (external) throw new RangeError(`The configured Development destination requires at least ${minimum} satoshis per output.`);
      throw new RangeError('Satoshi amount is outside the permitted range.');
    }
    return { role: bucket, ...destination, ...(external && { custody: 'external' }),
      satoshis: Number(value) };
  });
  if (event) outputs.push(eventOutput(event, allocation?.burn ?? 0, allocation && !competitive && !sponsor ? 'burn' : 'event'));
  if (new Set(outputs.map(output => output.script)).size !== outputs.length) throw new Error('Payment outputs must use distinct scripts.');
  return outputs;
}

// One operator-key prize output per season receives every swept carrier of that season.
export function prizeAggregate(seasonId, publicKey) {
  return incomingDestination(protocolHash({ season:seasonId, bucket:'prize-aggregate' }).slice(0, 32), publicKey);
}

export function publicOutputs(outputs) {
  // Covenant terms are public data. Publishing them lets an owner rebuild and spend the output without the game.
  return outputs?.map(({ role, script, address, satoshis, vout, custody, prizeSatoshis, kingdomSatoshis, reserveSatoshis, kv, escrow, fund, carrier2, feeder, cf, chest, chestSatoshis, rr }) => ({ role, script, address, satoshis, vout,
    ...(rr && { rr, label:'Network fee of this operation\'s public proof record · can be spent as that fee only' }),
    ...(cf && { cf, chest, chestSatoshis, reserveSatoshis,
      label:`War Chest share ${chestSatoshis} + network reserve ${reserveSatoshis} · joins your War Chest once your waiting shares reach ${cf.threshold} sats` }),
    ...(custody && { custody }), ...(kv && { kv }), ...(escrow && { escrow, ...(escrow.version === 4 && { label:`Matched raid stake ${escrow.principal} + network reserve ${escrow.reserve} · the unused reserve returns to you` }) }), ...(fund && { fund }), ...(carrier2 && { carrier2, reserveSatoshis }),
    ...(feeder && { feeder, prizeSatoshis, reserveSatoshis, label:`Season reward share ${prizeSatoshis} + network reserve ${reserveSatoshis}` }),
    ...(role === 'warChest' && !cf && { label:'Your War Chest · always at risk' }),
    ...(role === 'carrier' && { prizeSatoshis, kingdomSatoshis,
      label:`Kingdom ${kingdomSatoshis} + Prize ${prizeSatoshis}${reserveSatoshis ? ' + sweep reserve ' + reserveSatoshis : ''} · locked together until swept` }) }));
}
