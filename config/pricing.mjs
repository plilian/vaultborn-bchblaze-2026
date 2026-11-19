// VaultBorn BCH prices. One place, versioned.
//
// Every paid action reads its price, stake and network reserve from the price book named by its intent. A new book never
// changes an intent that was already funded: its event record names the book it was quoted under, and it is verified and
// settled under that book. An unpaid checkout quoted under an earlier book is refused and must be prepared again.
//
// How the current book was derived (the measured transaction sizes are in docs/audit/remediation/evidence/pricing.json;
// `npm run pricing:measure` reproduces them). BCH relays at one satoshi per byte, and an output below 546 satoshis
// (576 for a contract output) is not relayed at all. There is no universal minimum price: each number below follows
// from the cost of the transactions that action causes.
//
//   Paid raid. The attacker chooses the stake S. An attacker victory is ONE transaction that spends the defender's War
//   Chest and the attacker's escrow: 1,205 bytes with one attestor, 1,384 with two of three (560 or 701 more for each
//   further War Chest output, three at most). The attacker funds the heaviest case as a network reserve on top of S, and
//   the contract returns whatever a settlement did not need. The smallest stake is the one at which the fee of that
//   settlement, the heaviest network cost a raid normally has, stays below about one seventh of the stake: 10,000 satoshis
//   (12.1% and 13.9%). A larger stake pays the same fee. Stakes, deposits and War Chest shares are multiples of 1,000
//   satoshis, so a capture can never leave a remainder too small to exist.
//
//   Services. Half of a service price becomes the payer's War Chest. A share lands there as its own output, and that
//   output must be worth raiding and worth withdrawing on its own (one purchase, one usable War Chest), so the share is at
//   least the smallest raid stake and a service costs at least 20,000 satoshis. At that price the fixed network cost of a
//   purchase (a 300-satoshi reserve for the reward share and roughly 360 satoshis of wallet fee) is 3.3% of the
//   price; at the earlier 4,000 it was 16%, and the War Chest share could be captured only after several purchases.
//   Rush and paid espionage are single-use and sit at that floor. A premium improvement is permanent and costs a tenth
//   more, as it did before. A protectorate already cost more than the floor and is unchanged.
//
//   Political operation. The same single-use service price, plus the smallest contract output the network relays (576):
//   that output can only ever be spent as the fee of the operation's public proof record.
//
//   Territory. A stake is refundable principal; its reserve pays the one settlement transaction of at most 600 bytes.
//   The stake is sized so that this reserve is at most a tenth of the principal, and so that the half a contested claim
//   or a failed attack forfeits is several times the dust limit. An attack on a held territory is a contest between two
//   players and uses the smallest raid stake.
export const LEGACY_PRICING = 'prices-v1';
export const PRICING = 'prices-v2';

const freeze = value => { for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item); return Object.freeze(value); };

export const priceBooks = freeze({
  [LEGACY_PRICING]: {
    // A treaty charter cost 4,000 and paid political support 6,000; both were closed because nothing could pay for their proof record.
    services: { rush: 4_000, 'espionage-paid': 4_000, premium: 4_500, protectorate: 24_000, 'political-operation': 4_000, 'political-support': 6_000 },
    stakes: { 'attack-paid': { principal: 3_000, reserve: 600 }, 'territory-claim': { principal: 2_000, reserve: 600 },
      'territory-attack': { principal: 3_000, reserve: 600 }, 'territory-raffle': { principal: 3_700, reserve: 1_500 } },
    reserves: { prizeFeed: 300, chestFeed: 220 },
    warChest: { minimumDeposit: null, revision: 3 },
    raid: { matched: false },
  },
  [PRICING]: {
    services: { rush: 20_000, 'espionage-paid': 20_000, premium: 22_000, protectorate: 24_000, 'political-operation': 20_000 },
    // Refundable principal and the reserve that pays its single settlement transaction.
    stakes: { 'territory-claim': { principal: 6_000, reserve: 600 }, 'territory-attack': { principal: 10_000, reserve: 600 },
      'territory-raffle': { principal: 6_000, reserve: 600 } },
    // prizeFeed travels with the reward share and pays its keyless move into the season pool; record pays a political proof record.
    reserves: { prizeFeed: 300, record: 576 },
    // A deposit is one War Chest output; it must cover the smallest stake on its own.
    warChest: { minimumDeposit: 10_000, step: 1_000, revision: 4 },
    // The attacker picks any stake from `minimumStake` to `maximumStake` in steps of `step`. The reserve is computed per raid
    // from the measured size of its settlement transactions (`raidTermsFor` in the chain observer), never from a table.
    raid: { matched: true, minimumStake: 10_000, maximumStake: 250_000, step: 1_000, suggested: [10_000, 25_000, 50_000, 100_000, 250_000], maximumChestOutputs: 3, refundDays: 3 },
  },
});

export const priceBook = (version = PRICING) => {
  const book = priceBooks[version];
  if (!book) throw new RangeError('Unknown price book.');
  return book;
};
export const servicePrice = (action, version = PRICING) => priceBook(version).services[action];
export const stakePrice = (action, version = PRICING) => priceBook(version).stakes[action];

// A stake is valid under a book when it sits on the book's grid.
export function validStake(satoshis, version = PRICING) {
  const { raid } = priceBook(version);
  return Boolean(raid.matched) && Number.isSafeInteger(satoshis) && satoshis >= raid.minimumStake && satoshis <= raid.maximumStake && satoshis % raid.step === 0;
}
