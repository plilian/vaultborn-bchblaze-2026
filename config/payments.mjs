import { LEGACY_PRICING, PRICING, priceBook } from './pricing.mjs';
export { LEGACY_PRICING, PRICING, priceBook, servicePrice, stakePrice, validStake } from './pricing.mjs';

export const LEGACY_ALLOCATION = 'classic-v1';
export const GAMEPLAY_ALLOCATION = 'separate-stake-v2';
// Final service economy: 50% to the payer's War Chest (always at risk), 20% Seasonal Reward Pool, 20% Development, 10% burned.
// It applies to service purchases only. Stakes, deposits, escrows and sponsorships keep their own rules.
export const SERVICE_ALLOCATION = 'war-chest-v3';
export const serviceSplit = Object.freeze({ warChest:50, prize:20, development:20, burn:10 });
// A payer-funded network reserve that travels with the prize share and pays its keyless move into the season pool.
export const PRIZE_FEED_RESERVE = 300;
// The War Chest share waits in a keyless feeder until the payer's waiting shares are large enough to be captured and
// withdrawn economically. This payer-funded reserve pays that one move; what it does not need stays in the payer's War Chest.
export const CHEST_FEED_RESERVE = 220;
// A share that has waited this many blocks (about thirteen weeks) may join the War Chest below the threshold. The period is
// long so that a player who pays only now and then still gathers enough shares for one capturable output.
export const CHEST_FEED_WAIT_BLOCKS = 13_104;
// An owner's exit from the War Chest takes this many blocks (about two days). A capture owed before the exit began can confirm first.
export const CHEST_EXIT_BLOCKS = 288;
const modern = version => version === GAMEPLAY_ALLOCATION || version === SERVICE_ALLOCATION;
// New sponsorships: 30% to the developer's own address, 70% into the season's prize fund covenant.
export const SPONSOR_ALLOCATION = 'sponsor-fund-v2';
// Sponsorships quoted before the change: 20% Development, 80% to an operator-key prize output. Kept to verify old payments.
export const LEGACY_SPONSOR_ALLOCATION = 'sponsor-split-v1';
// How a season prize share below the BCH dust limit is paid: carried with the kingdom share and swept later, or raised to the dust floor.
export const PRIZE_CARRIER = 'prize-carrier-v1';
export const PRIZE_DUST_MODES = Object.freeze(['carrier','floor']);

// Fixed BCH prices: 0.25 BCH minimum, 25 BCH maximum, in steps of 10 satoshis so that 30% and 70% are whole satoshis.
export const sponsorshipPolicy = Object.freeze({ developmentPercent: 30, prizePercent: 70,
  minimumSatoshis: 25_000_000, maximumSatoshis: 2_500_000_000, satoshiStep: 10 });
export const legacySponsorshipPolicy = Object.freeze({ developmentPercent: 20, prizePercent: 80,
  minimumSatoshis: 2_730, maximumSatoshis: 250_000, satoshiStep: 5 });
export const sponsorshipPolicies = Object.freeze({ [SPONSOR_ALLOCATION]: sponsorshipPolicy, [LEGACY_SPONSOR_ALLOCATION]: legacySponsorshipPolicy });

export const legacyFees = Object.freeze({attack:6000,protectorate:120_000,premium:4500,rush:4000,espionage:4000});
export const competitiveActions = new Set(['attack-paid','territory-claim','territory-attack','territory-raffle']);
const services = new Set(['premium','rush','protectorate','espionage-paid','political-operation']);
export const bchPolicy = Object.freeze({
  servicePercent:Object.freeze({development:20,prize:10,burn:5,kingdom:65}),
  minSpendable:546,
  settlementReserve:600,
  raffleReserve:1500,
  protectoratePrice:24_000,
  capturePercent:20,
  defenderForfeitPercent:50,
});

// The total a checkout asks for. `pricing` names the price book; rows funded before the books existed carry none and keep
// the arithmetic they were quoted under. A matched raid is not in this table: its stake is chosen by the attacker and its
// reserve is measured per raid.
export function paymentPrice(action,previousPrice,version=GAMEPLAY_ALLOCATION,pricing=LEGACY_PRICING) {
  if (!modern(version)) return previousPrice;
  if (pricing!==LEGACY_PRICING) {
    const book=priceBook(pricing);
    if (book.services[action]!==undefined) return book.services[action];
    if (book.stakes[action]) return book.stakes[action].principal+book.stakes[action].reserve;
    return previousPrice;
  }
  if (action==='protectorate') return bchPolicy.protectoratePrice;
  if (!competitiveActions.has(action)) return previousPrice;
  return previousPrice/2+(action==='territory-raffle'?bchPolicy.raffleReserve:bchPolicy.settlementReserve);
}

// What the client shows before any checkout is prepared.
export const checkoutFees=(version,pricing=LEGACY_PRICING)=>pricing===LEGACY_PRICING ?
  ({...legacyFees,attack:paymentPrice('attack-paid',legacyFees.attack,version),protectorate:paymentPrice('protectorate',legacyFees.protectorate,version)}) :
  ({attack:priceBook(pricing).raid.minimumStake,protectorate:priceBook(pricing).services.protectorate,premium:priceBook(pricing).services.premium,
    rush:priceBook(pricing).services.rush,espionage:priceBook(pricing).services['espionage-paid'],political:priceBook(pricing).services['political-operation']});

export function sponsorshipAllocation(satoshis, minimumSatoshis, version = SPONSOR_ALLOCATION) {
  const policy = sponsorshipPolicies[version];
  if (!policy) throw new RangeError('Unknown sponsorship allocation policy.');
  const { maximumSatoshis, satoshiStep, developmentPercent } = policy;
  const minimum = minimumSatoshis ?? policy.minimumSatoshis;
  if (!Number.isSafeInteger(satoshis) || satoshis < minimum || satoshis > maximumSatoshis || satoshis % satoshiStep !== 0) {
    throw new RangeError(`Choose ${minimum.toLocaleString('en-US')}–${maximumSatoshis.toLocaleString('en-US')} satoshis in multiples of ${satoshiStep} so that both sponsorship outputs are spendable.`);
  }
  const development = satoshis * developmentPercent / 100;
  return { development, prize: satoshis - development };
}

export function prizeNeedsCarrier(total,action,version) {
  return version===GAMEPLAY_ALLOCATION && services.has(action) && Number.isSafeInteger(total) &&
    Math.floor(total*bchPolicy.servicePercent.prize/100)<bchPolicy.minSpendable;
}

export function paymentAllocation(total,action,version=LEGACY_ALLOCATION,{carrier=false,pricing=LEGACY_PRICING,reserve}={}) {
  if (!services.has(action) && !competitiveActions.has(action)) throw new RangeError('This action is outside the gameplay allocation policy.');
  if (version!==LEGACY_ALLOCATION && !modern(version)) throw new RangeError('Unknown gameplay allocation policy.');
  if (!Number.isSafeInteger(total) || total<1) throw new RangeError('The gameplay charge must support an exact satoshi allocation.');
  if (version===LEGACY_ALLOCATION) {
    if (total<4000 || total%20!==0) throw new RangeError('The gameplay charge must support an exact satoshi allocation.');
    const base=total/20;
    return {development:base*4,burn:base*3,prize:base*3,[competitiveActions.has(action)?'battle':'kingdom']:base*10};
  }
  if (competitiveActions.has(action)) {
    // Under a price book the reserve of a territory stake comes from the book, and the reserve of a matched raid from the raid itself.
    const settlement=pricing!==LEGACY_PRICING ? (action==='attack-paid' ? reserve : priceBook(pricing).stakes[action]?.reserve) :
      action==='territory-raffle'?bchPolicy.raffleReserve:bchPolicy.settlementReserve;
    if (!Number.isSafeInteger(settlement) || settlement<1) throw new RangeError('This stake has no network reserve under its price book.');
    if (total-settlement<bchPolicy.minSpendable) throw new RangeError('The competitive stake is below the minimum spendable BCH output.');
    return {battle:total-settlement,settlement};
  }
  if (version===SERVICE_ALLOCATION) {
    // Exact tenths, each a spendable output or a funded burn. Nothing is rounded, floored or moved between shares.
    if (total%10!==0) throw new RangeError('A service price must be a multiple of 10 satoshis so that 50/20/20/10 is exact.');
    const allocation={warChest:total*serviceSplit.warChest/100,prize:total*serviceSplit.prize/100,
      development:total*serviceSplit.development/100,burn:total*serviceSplit.burn/100};
    if (allocation.prize<576 || allocation.development<546) throw new RangeError('A service price under 2,880 satoshis cannot fund its four exact outputs.');
    return allocation;
  }
  const share=percent=>Math.floor(total*percent/100);
  const {servicePercent,minSpendable}=bchPolicy;
  const development=share(servicePercent.development);
  const burn=share(servicePercent.burn);
  // With a carrier the prize share stays exact and rides with the kingdom share in one spendable output.
  const prize=carrier ? share(servicePercent.prize) : Math.max(minSpendable,share(servicePercent.prize));
  const kingdom=total-development-burn-prize;
  if (development<minSpendable || kingdom<minSpendable || burn<1 || prize<1 || (carrier && prize+kingdom<576)) {
    throw new RangeError('The service charge cannot fund its spendable outputs.');
  }
  return {development,burn,prize,kingdom};
}
