# VaultBorn economy and money rules (current)

This is the authoritative description of how Bitcoin Cash is used in the game. It matches the code as of 19 November 2026: price book `prices-v2` (`config/pricing.mjs`), War Chest `war-chest-v4`, raid escrow `stake-escrow-v4`, territory escrow `stake-escrow-v3`, proof reserve `record-reserve-v2`. Earlier versions of this file described a different economy (a Kingdom Treasury, a 20/15/15/50 split, a 20% capture limit); none of that applies any more.

The game is free to play. Building, recruiting, research, trade, NPC expeditions and free raids never need BCH. No payment buys combat strength, and a higher stake never changes a battle.

## 1. One treasury per player: the War Chest

Every player has exactly one BCH balance in the game, the War Chest. There is no Kingdom Treasury, no protected balance and no risk setting. All of it is at risk, in one way only: a paid raid with matched stakes (section 4).

- It is a contract output of the player's own script. The game key can only send it to the wallet the player verified; a capture needs the independent attestors and an equal stake from the attacker in the same transaction.
- It is funded by half of every service payment and by direct deposits (minimum 10,000 sat, whole thousands, not split).
- **Withdrawal through the game:** the amount named, in whole thousands, is exactly what leaves the chest; the wallet receives it less the network fee shown beforehand (cap 2,000 sat). An output must be 144 blocks old. Money matched against a funded raid stays until that raid settles.
- **Exit without the game:** the owner's wallet key moves an output, whole, into an exit script and takes it out 288 blocks later. A raid funded before the exit still settles from the exit script.
- A raid can use at most three War Chest outputs, so the amount open to a raid is the sum of the three largest. A withdrawal or a settlement merges the outputs it spends.

## 2. Service payments: 50 / 20 / 20 / 10

| Service | Price (sat) |
|---|---:|
| Rush an upgrade | 20,000 |
| Paid intelligence mission | 20,000 |
| Premium building improvement | 22,000 |
| Protectorate proposal | 24,000 |
| Political operation (treaty charter, political support) | 20,000 |

The payer's own transaction splits the price into separate outputs:

| Share | Goes to |
|---|---|
| 50% | the payer's War Chest |
| 20% | the season prize pool (through a keyless feeder into the pool contract) |
| 20% | the developer's one receiving address |
| 10% | burned in a value-carrying `OP_RETURN` output |

On top of the price the checkout shows, as separate lines, a 300-sat network reserve (the fee of moving the prize share into the pool; what it does not need stays in the pool) and the wallet's own fee. A political operation adds a 576-sat proof reserve (section 6). These never change the percentages.

**A paid service is never lost.** If the action can no longer be applied when the payment is final (the upgrade finished, the treaty lapsed, the checkout expired), the service is owed: the player's next request of the same kind is delivered at once, without a checkout. The War Chest page lists what is owed.

**A service credit is not a BCH refund.** The payment was final when it confirmed: its outputs already went to the payer's War Chest (50%), the season prize pool (20%), Development (20%) and the burn (10%), and none of that is sent back. The credit is an entry in the game server's own records, not an on-chain asset: it cannot be withdrawn, transferred, sold or exchanged for BCH, it covers one service of the same kind only, and it depends on the game server continuing to run and keeping its database. The half that reached the payer's War Chest stays theirs and can be withdrawn like any War Chest balance.

Paid convenience (rush, premium) is limited to one use per rolling day.

## 3. Sponsorship: 30 / 70

A sponsor pays 0.25 to 25 BCH (Season Banner from 0.5 BCH, Title Sponsor from 2 BCH). 30% goes to the developer's address and 70% into a prize fund contract for the season. Prizes leave it only with the attestors' signatures after the season closes; what is not awarded returns to the sponsor by a keyless refund. No USD conversion is used anywhere.

## 4. Paid raids: matched stakes

The attacker chooses a stake S from 10,000 to 250,000 sat in whole thousands and locks S plus a network reserve (2,880 sat with one attestor, 3,340 with two of three) in an escrow.

A paid raid is offered only when the defender has at least S of confirmed War Chest money that is not being withdrawn, not exiting and not matched against another raid. Otherwise only the free raid is available.

| Outcome | Result |
|---|---|
| Attacker wins | One transaction pays the attacker exactly 2 × S: the attacker's own stake and S from the defender's War Chest. |
| Defender wins | The defender's wallet receives the attacker's whole stake S. The War Chest is untouched. |
| Void (the battle could not be fought, or the cover was gone when the payment arrived) | The stake returns to the attacker. |
| No settlement for 3 days | The attacker's key alone takes the stake back. |

The unused part of the reserve returns to the attacker in every case. The outcome is signed by the independent attestors after each has replayed the recorded battle; the game key alone cannot open any outcome. The same two kingdoms can fight one paid raid per 24 hours, and allies cannot stake against each other.

## 5. Territory

| Action | Stake + reserve (sat) | Rule |
|---|---:|---|
| Claim an open territory | 6,000 + 600 | Uncontested: the stake returns. Contested: the loser forfeits half to the winner. |
| Attack a held territory | 10,000 + 600 | A failed attack forfeits half of its stake to the defender. |
| Rare territory raffle entry | 6,000 + 600 | Returns to the entrant only, without any key. |

A territory attack never touches a War Chest. Contested outcomes are signed by the attestors.

## 6. Political operations

A treaty charter or political support costs 20,000 sat, split 50/20/20/10 like every service. The payer adds a 576-sat proof reserve that the game key can spend only as the network fee of the operation's public proof record. If no record is published, the payer's own key takes the reserve back once it is 2,016 blocks old (about two weeks). Treaty compensation between players is a separate escrow: the amount the treaty names plus 650 sat for its settlement.

## 7. Seasons and prizes

At season close 85% of the pool is distributed and 15% carries to the next season. The top five receive 40 / 25 / 15 / 10 / 10 percent. The server proposes the awards automatically; attestors rebuild the ranking from the published score journal, replay the battles in it and sign only amounts that follow from it. A season with fewer than two eligible players carries its pool forward. A prize is never guaranteed.

## 8. Networks

A server runs on exactly one network: Chipnet (test coins) or Mainnet (real BCH), chosen by `VAULTBORN_NETWORK`. Addresses, keys, observer servers and the database are separate per network. See `docs/MAINNET.md`.

## 9. What remains trust

The attestors must be independent of the developer and of each other: a colluding game key and attestor majority could sign a false raid outcome (limited to S per raid) or a false prize. Battles are verified by replay, but building, research and mission scores are checked against the rules only; player commands are not signed.
