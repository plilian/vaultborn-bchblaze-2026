# VaultBorn transaction matrix (current)

Every BCH transaction the game causes, what it contains, which contract holds the money and who can move it. Amounts are satoshis. This file replaces the earlier matrix, which described the previous economy. Rules and prices are explained in `ECONOMY_DESIGN.md`; measured sizes are in `audit/remediation/evidence/pricing.json`.

## Payments a player's wallet signs

| Transaction | Outputs | Held by | Who can move it afterwards |
|---|---|---|---|
| Service (rush, intelligence, premium, protectorate) | 50% War Chest · 20% prize feeder (+300 reserve) · 20% developer address · 10% `OP_RETURN` burn · data record | `war-chest-v4`, prize feeder, developer wallet | See the rows below. The burn is unspendable. |
| Political operation | as a service, plus 576 proof reserve | plus `record-reserve-v2` | Game key: only as the fee of one zero-value data record. Payer alone after 2,016 blocks. |
| War Chest deposit | 100% War Chest · data record | `war-chest-v4` | See War Chest rows. |
| Paid raid stake | S + reserve in one escrow output · data record | `stake-escrow-v4` | Attestor panel into fixed outcomes; attacker alone after 3 days. |
| Territory claim, attack, raffle | stake + 600 reserve · data record | `stake-escrow-v3` (raffle: keyless return) | Attestor panel; owner refund after timeout. |
| Treaty compensation | principal + 650 | `political-escrow` v2 | Payee on release, payer on refund or timeout. |
| Sponsorship | 30% developer address · 70% prize fund | `prize-fund-v1` | Game key + attestors after season close; keyless refund to the sponsor. |

## Transactions the game or the attestors sign

| Transaction | Signed by | What the contract enforces |
|---|---|---|
| Prize share into the season pool | nobody (keyless) | Can only pay the season pool contract; fee from its own 300 reserve. |
| War Chest withdrawal | game key | Output 0 is the owner's verified wallet; the rest returns to the same chest; output 144 blocks old; fee at most 2,000. |
| Raid won by the attacker | game key and attestors (one attestor), or attestor majority | One transaction: escrow and up to three War Chest outputs in; exactly 2 × S to the attacker, unused reserve to the attacker, remainder back to the chest. |
| Raid won by the defender | attestor panel | Exactly S to the defender's wallet fixed at funding; unused reserve to the attacker. |
| Void raid | attestor panel | S and the unused reserve to the attacker. |
| Territory settlement | attestor panel | Return to the owner, or the fixed split between owner and opponent. |
| Political proof record | game key | One input, one zero-value data output; the whole 576 reserve is the fee. |
| Season prize | game key + attestor threshold | At most 40% of a pool output per award; amount and winner follow the published result the award commits to. |
| Sponsor refund | nobody (keyless) | Only to the sponsor's wallet, after the refund date. |

## Transactions a player signs alone, without the game

| Transaction | Condition |
|---|---|
| War Chest exit, step one | Any time. The whole output moves into the exit script; the fee comes from the owner's wallet. |
| War Chest exit, step two | 288 blocks later. A raid funded before the exit can still settle in between. |
| Raid stake refund | 3 days after funding, if no outcome was settled. |
| Territory stake refund | After its timeout. |
| Proof reserve recovery | 2,016 blocks after funding, if no record was published. |
| Earlier vault deposit or earlier War Chest revision | As their own contracts allow (`scripts/owner-recover.mjs`). |

## Not on chain

**Service credits.** When a paid service cannot be delivered at confirmation, the payer is owed one service of the same kind. This is a record in the game server's database. It is not a BCH refund, no transaction returns the payment, and the credit cannot be withdrawn or transferred.


Resources, troops, buildings, research, loot from free raids, tribute, alliance aid and Season Points are game state only. CashTokens are used for optional transferable proof collectibles (territory deeds, treaty charters) when an issuer is configured; transferring one does not move control of a city or a territory.
