# Politics and diplomacy

> **Current rules (19 November 2026):** the economy, prices and custody described in parts of this document were replaced. The authoritative description is [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md) and the transaction list is [BLOCKCHAIN_TRANSACTION_MATRIX.md](BLOCKCHAIN_TRANSACTION_MATRIX.md). Where this document differs, those two are right.

Open **Politics & Diplomacy** from the world map to govern your kingdom, review regional influence, negotiate, manage trade, and coordinate interventions. The same save keeps existing alliances, protectorates, spy reports, territory claims, and treasury balances. The Political Archive at `/verify/politics` shows public agreements, resolved conflicts, and verifiable Chipnet records.

## Kingdom government

Each kingdom starts at 60 Legitimacy, 60 Public Loyalty, 30 Diplomatic Influence, and 20 Political Unrest. All four indicators stay between 0 and 100. Real raids, war declarations, conquest, territorial loss, rebellion, treaty ratifications and breaches, sanctions, and decisions record distinct effects. For example, conquest raises the victor's legitimacy and influence and increases the former owner's unrest. A replayed event does not apply twice. Public influence controls diplomatic tempo and is also spent to organize conflicts.

| Choice or condition | Effect |
| --- | --- |
| Tax exempt, balanced, or heavy | Diverts 0%, 8%, or 15% of earned production into the civic reserve. Raising taxes lowers loyalty and increases unrest; light taxation lets strained communities recover. |
| Civic Stewardship | Stable baseline for production and morale. |
| Merchant Charter | Adds 6 percentage points to the political production modifier. |
| Military Mobilization | Gives up 5 percentage points of production for 3 points of combat morale. |
| Relief, public works, audit, outreach, and levy | Spend earned goods to improve standing, support production temporarily, or move already collected civic stock into the city at a public cost. |
| High unrest or disputed authority | At 65 unrest a holding earns 85% of its usual yield. A temporarily contested holding earns half its applicable yield. |

Policies have a six-hour cooldown; civic decisions have a three-hour cooldown. Taxes apply to earned production and cannot draw from existing warehouse or wallet balances. The civic reserve holds up to 10,000 units of each resource. It covers eligible policies and decisions before the warehouse covers any remainder. Levy can move at most 80 units of each resource from that reserve. Loyalty and unrest change production within a 78–115% range. Legitimacy, loyalty, and unrest change combat morale within a 90–110% range. Periodic reviews, relief, and enforced caps keep temporary losses from locking a player into decline.

## Internal conflicts and coalition intervention

Coups require at least 28 unrest or loyalty below 50. Civil wars require 35 unrest and control of a nonstarter frontier holding. Independence requires an active protectorate or a recorded conquest of the claimant's former territory. Coalition wars check normal attack eligibility against the opposing kingdom. The initiator must clear starter protection, complete the tutorial, enroll for seasonal play, have at least 24 available troops, and pay the earned-resource and influence costs.

After 30 minutes of organization, armies fight three deterministic fronts: the Outer Approaches, the Supply Crossing, and the Seat of Authority. The last front is worth two points and breaks a tie. The engine uses the recorded troops, tactics, formations, terrain, actual intelligence and support, and political morale. It publishes a seed commitment before resolution and reveals the seed and battle records afterward. While active, an opponent cannot inspect a faction's private orders and receipts.

Commanders can add troops, earned resources, intelligence, equipment, or logistics during organization. An eligible ally may intervene for a permitted side; fresh covert intelligence can authorize a limited intelligence contribution to some challengers without a formal alliance. Troops move out of the contributor's active roster, each supporter can commit up to 12 units, and losses are attributed to their owners. External intervention has a rolling one-day cooldown. Offensive troop contributions to a coalition recheck normal attack eligibility and consume attack capacity; defensive participants do not launch an attack. One kingdom cannot contribute to both sides. Only a confirmed, explicitly approved Chipnet payment can supply a paid logistics package; the same benefit is available with earned goods.

A faction commander can privately request intervention from up to three eligible alliance, defense, military assistance, or federation partners per side while organizing. Each request costs 12 food and 8 wood and starts a two-minute sender cooldown. A commander can request a particular kingdom only once per conflict. Sending a request does not commit troops or supplies: the recipient still chooses an eligible support package. Contributing fulfills the request; an unused request closes when the first front begins. Only the sender and recipient see the request.

The engine returns survivors and records the actual consequences. A successful coup sets a new government era, resets policy to tax exemption and Civic Stewardship, and temporarily removes the commander. A successful civil war can temporarily reduce production in the realigned holding. Independence can end protectorate tribute or restore a previously conquered holding if normal ownership, capacity, and proximity rules still permit it. It cannot grant protected or rare land. Existing protectorate rebellions remain playable. Resolving a conflict normally grants 12 hours of political recovery, and initiating another conflict has a one-day cooldown.

## Political events

Political crises, corruption scandals, succession disputes, uprisings, independence declarations, territorial disputes, diplomatic incidents, negotiations, public war declarations, and international votes have requirements, response windows, cooldowns, and effects. Pay for relief or arbitration, negotiate, vote, or choose a campaign when eligible. Missed deadlines can hurt standing. An assassination attempt is an in-game intelligence operation against a fictional commander. It requires fresh hostile intel and spends scout points; counterintelligence or a response can reduce its chance of success. An affected commander can be temporarily unavailable. Covert incident details are withheld from the public while the decision window is active.

## Treaty negotiation

Player kingdoms send a proposal to a named counterpart. The proposer spends 16 food and 12 wood. The offer lasts 24 hours. The counterpart can accept, reject, or submit revised terms for the original proposer to review. Each revision has a version and SHA-256 commitment to the kind, participants, and canonical terms. An acceptance must name the exact version and commitment. Drafts and pending amendments are visible to their signatories. The public chronicle shows ratified agreements and their outcomes.

Terms can last 1–720 hours. A voluntary protectorate follows the existing 48-hour maximum. Each kingdom may have up to six outgoing proposals. Repeating the same offer to the same recipient takes six hours at ordinary diplomatic influence, five hours at 60 influence or above, and seven hours at 20 influence or below. Treaty ratification can increase political influence once per pair per day.

| Agreement | Effect while active |
| --- | --- |
| Peace | Ends a declared war between the signatories and blocks hostile combat for the agreed term. |
| Ceasefire | Suspends a live declaration and blocks hostile combat for the agreed term. The war resumes if its declaration still has time remaining. |
| Non-aggression | Blocks hostile combat between the signatories. |
| Defensive alliance | Blocks hostile combat and authorizes defensive aid and intervention. |
| Military assistance | Authorizes military aid and intervention through the regular eligibility, availability, and loss rules. |
| Trade | Authorizes partner trade where route and jurisdiction rules permit it. |
| Territory sharing | Grants supply access to as many as five named holdings controlled by the signatories. The territory owner retains control and garrison authority. |
| Reparations | Transfers the accepted earned resources or confirmed BCH compensation. |
| Protectorate | Starts the existing tribute and upkeep rules after voluntary ratification. The sponsor must be a current alliance leader and have a free protectorate slot. The defender retains access to the existing independence mechanics. |
| Federation | Grants mutual defense, trade, and an independent joint council with a contributed earned-resource reserve. |

An amendment leaves the effective version in force until ratification. A signatory can give six hours' notice of cancellation. The other signatory can approve an earlier end. Expiration and cancellation remove only the permissions supplied by that agreement. If a named shared holding leaves both signatories' control, the engine records the breach at the ownership change and applies the political penalty to the responsible party.

## Compensation

Earned-resource terms name an agreed payer, an agreed recipient, and the goods to transfer. Ratification checks the payer's available stock and the recipient's warehouse capacity and transfers the full amount once. An accepted compensation obligation stays fixed when the term is amended.

A BCH agreement accepts a principal from 1,000 to 250,000 sats. Ratification opens a 24-hour funding window. The named payer explicitly authorizes Chipnet funding from a linked verified wallet. The separate 650-sat fee pays for settlement. The engine records the exact accepted commitment, payer, recipient, principal, and funding outpoint transaction. The agreement activates when the release is confirmed. The escrow script enforces the payout destination and principal, and the payer has an independent refund path after the six-hour on-chain timelock. A confirmed refund closes the agreement. Funding and settlement commitments are available in the Political Archive. The allocation rules for eligible gameplay charges apply independently of compensation principal.

## Trade and economic pressure

Trade or alliance partners can commission up to four outgoing routes for 48 hours in exchange for 28 food and 25 wood per route. A route registers one resource and links markets within reach, directly or through an owned or explicitly treaty-shared waypoint. The registrar can update the course of future shipments. The market level limits shipment size to at most 200 units. Ordinary cargo takes four minutes to reach its destination and is debited on departure. Delivery rechecks the agreement and the original waypoint; failed deliveries or overflow return to the origin as its storage permits.

A sanction applies only to traffic between the issuing kingdom and its target, or traffic that uses an issuer-controlled waypoint. A blockade requires a strategic holding. Tariffs start at 15% with a 25% aggregate ceiling; restrictions reduce ordinary shipment capacity to 45%; embargoes and blockades stop ordinary shipments. A kingdom may have at most three active measures, each lasting 1–24 hours. The same measure against the same kingdom has a six-hour cooldown. Neither sanctions nor tariffs can seize city stocks or tax unrelated routes.

The target can seek a new agreement or route, ask the issuer to lift a measure, or impose its own measures where it has jurisdiction. Smuggling requires a blocked route, has a one-hour cooldown, and moves at most 50 units at greater expense and the risk of cargo loss. An eligible military escort can challenge a strategic blockade using available armed strength; this consumes a normal attack and may incur losses. The trade panel shows active measures, waypoint control, cargo, timing, and the available responses.

## Alliance and federation councils

An alliance council includes its current human members. A federation has a council with the kingdom signatories and its own leader, roles, ballots, policy, and reserve. Federations retain separate kingdom assets and alliance memberships. A ballot fixes the eligible members when it opens and closes after twelve hours. Current eligible voters can approve, oppose, or abstain once. Departed members' ballots are excluded when the council tallies the result. Quorum requires two-thirds of the original eligible roster, rounded up. Passage requires a majority of that roster approving. Abstentions count toward turnout.

Councils can elect a leader, appoint a diplomat or quartermaster, decide war, propose alliances and peace treaties, levy a jurisdiction-bound sanction, approve a reserve appropriation, or change the shared spending policy. The candidate must still be a member at settlement. A successful election opens a seven-day election cooldown. A diplomat can carry an additional foreign motion and a quartermaster can carry an additional spending or policy motion. Each motion costs its proposer 12 food and 8 wood.

Members voluntarily contribute up to 500 earned units per transaction to the reserve, with up to 5,000 units stored for each resource. Passed spending motions deliver to a current member with sufficient capacity. The reserve, balanced, and investment policies cap each appropriation at 100, 300, and 500 units respectively. Council peace and alliance proposals spend 16 food and 12 wood from the reserve. War declarations spend 65 food and 40 iron from the reserve. Each action rechecks authority, conditions, and funding at settlement. Council votes and reserves operate independently of the Development Treasury DAO and personal BCH wallets.

## Chain records and verification

| Political checkout | Amount | Allocation and public record |
| --- | ---: | --- |
| Logistics | 6,000 sats | 1,200 development, 900 burn, 900 seasonal, 3,000 kingdom. A salted payment commitment is opened when the conflict resolves or is cancelled. |
| Treaty charter | 20,000 sats + 576 proof reserve | 10,000 to the payer's War Chest, 4,000 season prizes, 4,000 Development, 2,000 burned. The version and terms hash of the ratified treaty are anchored in a proof record paid by the reserve. |
| Compensation | 1,000–250,000 sats principal plus 650 sats | The agreed payee receives the full principal on release. A refund returns that principal to the payer. No gameplay split applies. The checkout wallet may quote its own network fee in addition. |

For compensation, the locking script binds the contract identifier, both verified wallet destinations, the amount, and the refund time. The operator can sign only a fixed payout to the named recipient or an exact refund to the payer. The script enforces destinations and amounts; the game and the signatories supply treaty consent. After the locktime, the payer can sign independently. Save the original checkout JSON for that route. `scripts/political-escrow-refund.mjs` accepts the checkout file and confirmed funding TXID, with a local Chipnet key file supplied through `POLITICAL_REFUND_KEY_FILE`. It outputs a signed transaction for review and does not broadcast it. Keep the signing key out of save files and source control.

The archive provides funding and settlement TXIDs, event digests, the canonical record hash and, when appropriate, the payment opening. Paid outcome anchors use the existing event format. Protected strategies and unrelated free decisions do not require an on-chain payment. Once a paid attestation anchor or compensation release confirms, the separately configured political CashTokens issuer can mint an immutable NFT using that treaty's version and terms hash. A charter records the agreement and can be independently inspected. Voting rights remain tied to current council membership, and transferring a charter does not amend a treaty or move a kingdom's assets.

Use `npm run verify:politics -- <archive-file-or-url>` to recompute record commitments from a public archive. Add `--chipnet` to verify confirmed outputs, compensation inputs, the payment split, and outcome anchors against Chipnet. The [BCHN Regtest receipt set](POLITICS_REGTEST_RECEIPTS.json) records mined principal release, operator refund, and payer refund transactions, including rejection of the payer refund before the locktime. It also records the paid operation's four outputs, the mined outcome anchor spending its development output, and a distinct minting category with a mined immutable treaty charter. The [Chipnet authority receipt](POLITICS_CHIPNET_AUTHORITY.json) records a confirmed category genesis for the preview's political issuer; authority genesis is distinct from issuance of an individual charter.

An isolated two-kingdom fixture also ratified and settled a live [Chipnet compensation agreement](POLITICS_CHIPNET_ESCROW.json). Its confirmed 3,750-sat funding output was spent by a transaction with a 650-sat network fee, a 3,100-sat payout to the ratified recipient, and a zero-value event commitment. `npm run verify:politics -- docs/POLITICS_CHIPNET_ESCROW.json --chipnet` independently reconstructs and checks both confirmed transactions.

The fixture separately paid for a [Chipnet charter attestation](POLITICS_CHIPNET_ATTESTATION.json). The confirmed 4,000-sat checkout produced all four allocation outputs. Its confirmed outcome anchor spent the development output and committed the ratified terms. The Regtest receipt above also verifies individual native charter issuance on BCHN; the live Chipnet fixture tested the payment and outcome anchor, not an individual mint.

Run `npm run simulate:politics` for a fixed-start production and tax comparison and 300 deterministic coup simulations. In that sample, the heavy tax and mobilization setting raised 63 civic units in an hour versus 36 under balanced tax and commerce, but cut private resource gain from 461 to 373 and raised unrest from 25 to 31. Across 100 paired seeds, the sample coup succeeded 3 times with the default order, 4 times with flank/wedge, and 94 times when an ally added 12 infantry to flank/wedge and the government wing added none. These are stress scenarios for specific rosters, not a live win-rate forecast. Each reinforcing kingdom commits real troops and may lose them.
