# VaultBorn — Final remediation report: one War Chest, 50/20/20/10, automatic prizes

> **Dated report (19 November 2026),** written before the Mainnet launch. Its findings are kept as they were written; its statements about what had not yet run, and about Mainnet readiness, describe that day. VaultBorn has since gone live on Bitcoin Cash Mainnet, with wallet-signed payments and a contract settlement signed by the attestors. Current state and evidence: [STATUS.md](../../STATUS.md) · [MAINNET_TRANSACTIONS.md](../../MAINNET_TRANSACTIONS.md).

> **Superseded on 19 November 2026 by `FINAL_ECONOMY_REPORT.md`** (final price book, matched-stakes raids, one War Chest). Kept for history; prices, raid rules and custody described below are no longer current.

> **Updated by [`ECONOMY_SECURITY_GAPS_REPORT.md`](ECONOMY_SECURITY_GAPS_REPORT.md).** The War Chest contract, the capture and withdrawal figures, the attestor rules and open items 2, 3, 5, 6, 11 and 12 below have changed.

Date: 19 November 2026. This report supersedes `CUSTODY_PROOF_AND_STATUS.md` and `REMEDIATION_REPORT.md` where they differ.

**Status in one paragraph.** The final economy is implemented in the server and its contracts: one War Chest per player that is always at risk, an exact 50/20/20/10 service split paid by the payer's own transaction, a funded burn, a contract-held season pool, attested captures, automatic prize proposals. It passes 179 of 179 tests, 77 of 77 cases on a Bitcoin Cash Node Regtest chain under standard relay rules, and 8 of 8 checks of the updated screens in Chromium. **It is not complete:** nothing ran on Chipnet or with a wallet app; at today's 4,000–4,500 satoshi prices a single War Chest share is too small to capture or withdraw economically; scores are still computed by the server; and the season pool depends on every attestor staying available. Section 9 lists every open item.

## 1. Before and after

| | Before this pass | Now |
|---|---|---|
| Service split | 20% Development / 10% prizes / 5% burn / 65% kingdom | **50% War Chest / 20% season pool / 20% Development / 10% burn**, exact tenths, policy `war-chest-v3` |
| 4,000-sat service | 800 / 400 / 200 / 2,600 | **2,000 / 800 / 800 / 400** |
| Player treasuries | Kingdom vault (safe) + optional war chest (at risk) | **One War Chest, all at risk, no setting** |
| Prize share transport | Carrier with a 500-sat reserve | Prize feeder with a **300-sat** reserve; War Chest share paid directly |
| Burn | 5% in a funded OP_RETURN | 10% in a funded OP_RETURN (accepted by BCHN under standard policy; never enters the spendable set) |
| Development | Developer address | Unchanged: the one developer address, paid directly by the payer |
| Sponsorship | 30/70, 0.25 / 0.5 / 2 / 25 BCH | Unchanged |

Prices are unchanged. A service price must be a multiple of 10 satoshis and at least 2,880, otherwise the quote is refused; nothing is rounded, floored or moved between shares. The payer pays, on top of the price, a disclosed 300-sat network reserve and the ordinary network fee of the payment.

**Cost of one service payment (measured, 1 sat/byte)**

| Price | War Chest | Pool | Dev | Burn | Reserve | Payer fee | Overhead | Fee to withdraw that one share | Capturable alone |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 4,000 | 2,000 | 800 | 800 | 400 | 300 | 364 | 16.6% | 544 (27%) | No |
| 4,500 | 2,250 | 900 | 900 | 450 | 300 | 364 | 14.8% | 544 (24%) | No |
| 24,000 | 12,000 | 4,800 | 4,800 | 2,400 | 300 | 364 | 2.8% | 544 (4.5%) | Yes |
| 40,000 (not a current price) | 20,000 | 8,000 | 8,000 | 4,000 | 300 | 364 | 1.7% | 544 (2.7%) | Yes |

## 2. War Chest architecture

- **One treasury.** New service payments pay 50% straight into the payer's `war-chest-v2` output. A direct deposit (`war-chest` checkout) pays the same kind of output with no split. There is no kingdom treasury for new money, no safe balance and no risk setting: `POST /api/kingdom/risk` answers 410 with an explanation. Balances report `warChestSatoshis`, equal to the amount at risk.
- **Contract rules.** Release: game key, to the owner's wallet, change only back to the same chest, output 144 blocks old. Capture: game key **and every independent attestor**, at most 20% of an output, the rest back to the same chest, output 144 blocks old. Recovery: the owner's key alone after 3 days.
- **Withdrawals** are signed automatically on request and can only reach the verified wallet. They are refused while a paid raid against the player is unsettled or a capture is pending; this lock ends with the settlement and creates no second balance.
- **Server disappearance.** `scripts/owner-recover.mjs` spends any War Chest output with the owner's key after its recovery date. The terms needed to rebuild the script are published with every payment.
- **Historical funds.** Operator-key outputs from before are untouched, keep their old withdrawal route, and are counted in `buckets.legacyOperatorHeld`. They were not migrated or reclassified.
- **Internal names.** The storage pool id `kingdom`, the payout kind `kingdom-withdraw` and the field `kingdomSatoshis` are kept so that old records stay readable. They now describe the War Chest.

## 3. Paid raid economics

Unchanged rules: stake 3,000 + 600 network reserve; attacker win returns the stake and captures min(20% of the defender's capturable War Chest, stake); attacker loss sends 50% of the stake to the defender; 24-hour limit per pair; distinct verified wallets; both sides opted in to PvP.

- **Preview before paying.** The raid screen shows the stake, reserve, the opponent's confirmed capturable War Chest, the maximum win and the maximum loss before any payment is prepared (`GET /api/attack-preview`), and the checkout repeats them. Capturable means outputs of at least 3,000 sat: a capture pays a 610-sat fee, so smaller outputs cannot be captured at all.
- **Empty or uncapturable War Chest.** The raid screen says that no BCH can be won and keeps the paid button disabled until the player ticks "I accept a paid raid with no BCH reward". The server enforces the same rule (409 with the preview unless the request says `acceptNoReward: true`). Free raids are unaffected.
- **Settlement.** The stake escrow can only pay the attacker or the named defender. A capture is an unsigned proposal until every attestor has replayed the recorded battle and signed; it then pays the attacker's wallet, less its network fee. A capture under 600 sat is not made.
- **What stops a fake result.** The game key cannot capture alone (script). Each capture is limited to 20% of an output that is 144 blocks old (script). The attestor replays the battle with the game's own resolver (off chain). The attestor cannot check that the recorded armies were the true game state.

## 4. Economic sustainability (model: `evidence/economy-model.json`, `npm run simulate:bch`)

Per season, premium upgrades at 4,500 sat, direct deposits of 20,000 sat where stated:

| Scenario | Payments | War Chest from services | Prize pool | Prize fees (5 awards) | Development | Burned | Capturable liquidity |
|---|---:|---:|---:|---:|---:|---:|---:|
| 20 players, no deposits | 6 | 13,500 | 5,571 | 2,305 (49% of what can be paid) | 5,400 | 2,700 | 0 |
| 20 players, 4 depositors | 6 | 13,500 | 5,571 | 2,305 (49%) | 5,400 | 2,700 | 80,000 |
| 200 players | 120 | 270,000 | 111,420 | 2,305 (2.4%) | 108,000 | 54,000 | 600,000 |
| 2,000 players | 1,000 | 2,250,000 | 928,500 | 2,305 (0.3%) | 900,000 | 450,000 | 4,000,000 |
| 200 players + one 0.25 BCH sponsor | 120 | 270,000 | 17,611,420 | 4,610 (0.03%) | 7,608,000 | 54,000 | 600,000 |
| 200 mostly inactive players | 4 | 9,000 | 3,714 | not payable | 3,600 | 1,800 | 40,000 |

Answers to the ten questions:
1. **Is the War Chest sufficiently funded?** In amount, yes: half of every payment. In usable form, no: a 2,000–2,250 sat share cannot be captured (20% is 400–450 sat, the capture fee is 610) and costs 24–27% to withdraw. Only direct deposits and larger payments are capturable today.
2. **Meaningful PvP without excessive fees?** Against a 15,000-sat or larger chest a won raid nets about 2,390 sat; a lost one costs 2,100; a win against an empty chest costs 600. Fees are 20% of the stake.
3. **Most players with empty War Chests?** No winnings exist, the preview says so, and the paid raid is refused unless explicitly accepted.
4. **Repeated raids on one participant?** One capture per pair per day (game rule) and at most 20% of an output per 144 blocks (script). Several different attackers can each capture once a day; a chest can halve in about four days of daily captures. Sybil attackers are limited only by the existing wallet and matchmaking rules.
5. **Withdraw before settlement?** Refused while a raid against the player is unsettled or a capture is pending. After its 3-day recovery date an owner could still move a chest with their own key before a capture confirms.
6. **Does 20% remove the dust problem?** Yes: 800 and 900 sat are spendable outputs, so the split is exact with no floor. Aggregation still costs the 300-sat reserve.
7. **Does the 10% burn work under standard relay?** Yes, on BCHN 29.2.0 with `-acceptnonstdtxn=0`.
8. **Cost of prize distribution?** About 461 sat per award. Negligible for 200+ players or any sponsorship; about half of the pool for 20 players without a sponsor.
9. **Sustainable without sponsorship?** The pool is 20% of service revenue. Below roughly 30 payments a season it is too small to distribute sensibly and rolls over.
10. **Collusion?** Two colluding accounts can move at most 20% of a chest per day between themselves and gain nothing but fees. Prize farming by Sybil accounts is not prevented by this work (see 9).

**Pricing proposal — not activated, needs your approval.** Raising service prices tenfold (Premium 45,000, Rush 40,000 sat) would cut overhead to 1.7%, make each War Chest share capturable and cut its withdrawal cost to 2.7%. The alternative that keeps prices is a wallet-built top-up of the player's existing chest in the payment itself; it needs WizardConnect support for a keyless extra input, which I could not test.

## 5. Financial contract inventory

| Contract | Use | State |
|---|---|---|
| `war-chest-v2` | The one player treasury | Integrated; VM + Regtest; no Chipnet |
| `prize-feeder-v1` (new) | Holds a 20% share until it joins the season pool | Integrated; VM + Regtest; no Chipnet |
| `prize-fund-v1` without sponsor | Season pool | Integrated; VM + Regtest; no Chipnet |
| `prize-fund-v1` with sponsor | 70% of a sponsorship | Integrated; VM + Regtest; no Chipnet |
| `battle-escrow`, `territory-escrow`, `territory-claim`, `territory-uncontested` v2 | Raid and territory stakes | Integrated; VM + Regtest; no Chipnet |
| `vault-covenant-v1`, political escrow v2 | Personal vault, treaty compensation | Integrated; VM + Regtest; no Chipnet |
| `kingdom-vault-v2`, `prize-carrier-v1/v2` | Earlier designs | No longer used for new payments; code and Regtest cases kept |
| Operator-key outputs | Historical | Unchanged, custodial |
| Paid political operations | Need an operator-held reserve for their proof transaction | **Closed** when the developer address is configured |

## 6. Automatic winner determination

Verified in the code, not changed: top five non-NPC ranked players with a score and a seat share 85% of the pool by 40 / 25 / 15 / 10 / 10; 15% stays; awards under 600 sat are not paid; fewer than two eligible players rolls the pool over; claims are open for one season length; unclaimed money stays in the pool.

New:
- **Published season result.** `GET /api/public/season-result` gives the season, rules, ranking with score and verified wallet, confirmed pool, prize base and each rank's entitlement, with a hash that does not depend on when it is read.
- **Automatic proposals.** After a season closes the ledger proposes each winner's award by itself, in rank order, one at a time. No player or developer action is needed.
- **Commitment.** The award transaction's record output commits to the season, rank, prize base and result hash, so every signature covers them.

**Not done:** scores are still computed inside the server from game state. There is no public event log from which a third party can recompute a season's scores. An attestor therefore verifies that an award follows the published result, not that the result is right.

## 7. Prize distribution

| Step | How |
|---|---|
| Funding | 20% of services through feeders into one season pool output; 70% of sponsorships into one fund output per sponsorship. The two are separate outputs: a sponsor's refund right is never mixed with service money |
| Displayed amounts | Only confirmed, unreserved outputs |
| Entitlement | Rank percentage × prize base, fixed by the first award of the season |
| Authorization | Game key + every attestor. The attestor tool pins the first result hash it sees for a season and refuses an award whose rank, wallet, amount or hash differs |
| Limits in the contract | Not before season close; at most 40% of an output per award; remainder back to the same contract; output six blocks old |
| Double claims | One award per player per season in the ledger; each award spends the outputs it was signed for |
| Unclaimed / unpaid | Stays in the contract and counts for the next season. Sponsor money returns to the sponsor by a keyless transaction after its refund date |
| Attestors unavailable | Sponsor money: refund. Season pool: locked, not recoverable without them |

## 8. Testing evidence

| Kind | Result |
|---|---|
| Chipnet | **None executed.** `npm run test:chipnet:covenants` is updated for the final economy and has never been run |
| BCHN 29.2.0 Regtest, standard relay | 77 of 77: prize carrier v1 6, treaty escrow 5, treasury v2 4, personal vault 6, prize fund 12, kingdom vault 6, war chest 8, stake escrow 4, territory 7, carrier-v2 pool 11, **service economy 8** (exact four-output payment, funded burn, feeder moves) |
| BCH VM + real server + enforcing fixture node | 179 of 179. `tests/kingdom-covenant.test.mjs` runs the main lifecycle in one process: exact split, direct deposit, automatic risk, a won raid with an attested 3,000-sat capture, empty-chest refusal, unauthorized spends, withdrawal, owner recovery. The lost-raid lane ran on Regtest and in template tests; the integrated run produced an attacker win |
| Season end, automatic proposals, attested awards, sponsor refund | `tests/sponsorship-fund.test.mjs` |
| Economy model | `evidence/economy-model.json` |
| Browser (Chromium, real client, real server, enforcing fixture node) | 8 of 8, `evidence/browser-war-chest.json`: economy announced to the client; empty-chest raid warning and blocked paid button; real figures after a deposit; stake escrow in the payment dialog; the four service outputs and the total the wallet sends; one War Chest with no risk control on the Vault and Council screens; old risk endpoint answers 410. Payments in this run were signed by test keys in the test process. The run used the project's scripts and stylesheets without its art, fonts and wallet library, which were not copied into the test environment |
| Existing `npm run test:browser` suite | **Not run.** It needs the art and fonts, and it predates wallet-locked payments, so its paid-raid step needs updating |
| Selene / WizardConnect | **Not run.** No wallet was paired; a wallet's handling of the four-output payment with a funded OP_RETURN is unverified |

Reproduce:
```
node --test "tests/*.test.mjs" "packages/*/*.test.mjs"
REGTEST_BCHN=/path/to/bitcoind npm run test:regtest:remediation
npm run simulate:bch
npm run test:browser:warchest        # set DOMINION_BROWSER_PATH if Playwright has no browser of its own
CHIPNET_FIXTURE_FILE=var/covenant-keys.json CHIPNET_TEST_APPROVE=true npm run test:chipnet:covenants   # never executed
```

## 9. Security audit: open items and trust

**Contract-enforced (BCH consensus):** every destination, percentage, age and time limit in sections 2, 3 and 7; that the game key alone cannot capture or award; owner and sponsor recovery.
**Depends on off-chain verification:** who won a battle; who ranked where; that attestors are independent of the developer. The system is not trustless.

| # | Open item | Effect |
|---|---|---|
| 1 | **No wallet run.** The updated client was checked in Chromium, but never with Selene or another WizardConnect wallet, and the older browser suite was not run or updated | Whether a wallet signs and relays the four-output payment is unverified |
| 2 | **Service shares are too small to capture or withdraw economically** at 4,000–4,500 sat | "100% at risk" is true in the contract but not in practice for those outputs. Needs the pricing decision in section 4 |
| 3 | **Scores are server-computed** with no public replayable log | Independent prize verification is partial |
| 4 | Game key alone chooses a raid or territory-attack lane between the two named wallets, and can send at most half of an open territory claim stake to a wallet it names | Bounded; not attested |
| 5 | Season pool has no recovery if all attestors are lost; all attestors must sign every award and capture; no threshold | Liveness risk |
| 6 | A chest owner can move a chest with their own key after 3 days, ahead of a pending capture | A winner's capture can fail |
| 7 | Sybil and collusion protection for prizes is unchanged from the original rules | Not strengthened |
| 8 | Paid political operations are closed in the final configuration | Feature unavailable |
| 9 | Historical operator-held outputs | Custodial; not migrated |
| 10 | Captures go to the winner's wallet, not the winner's War Chest, and arrive less a 610-sat fee | By design; disclosed in the preview |
| 11 | A lone feeder waits for a second payment of the same price before it can top up an existing pool | Small shares can sit in feeders |
| 12 | Start-up does not refuse an incomplete configuration; paid services answer 503 instead | Operational |

## 10. Mainnet readiness

| Lifecycle | Result | Reason |
|---|---|---|
| Service payment 50/20/20/10 with burn | BLOCKED | Correct on VM and Regtest; no Chipnet, wallet or browser run |
| War Chest deposit, withdrawal, recovery | BLOCKED | Same; item 2 for small shares |
| Paid raid, capture | BLOCKED | Same; items 4, 6 |
| Territory | BLOCKED | Same; item 4 |
| Season pool, automatic prizes | FAIL | Items 3 and 5 |
| Sponsorship | BLOCKED | No Chipnet run; real independent attestors needed |
| Browser client | BLOCKED | Screens updated and checked in Chromium; no wallet run (item 1) |
| Historical outputs | FAIL | Custodial |

**Overall: not ready for Mainnet. Mainnet stays disabled and was not touched.**

## Changed in this pass

`config/payments.mjs`, `packages/game-engine/treasury.mjs`, `packages/chain-observer/{index,vaultborn,prize-carrier,kingdom-vault}.mjs`, `apps/game-server/{ledger,index,territory-protocol}.mjs`, `apps/web/{app,screens,citadel,strategy-stats,battle-report,territory-field,game-guide}.js`, `scripts/{prize-attest,regtest-remediation,chipnet-covenants-e2e}.mjs`, new `scripts/simulate-bch-economy.mjs` and `scripts/browser-war-chest.mjs`, `tests/{kingdom-covenant,sponsorship-fund,politics-server}.test.mjs`, new `tests/support/covenant-node.mjs`, `package.json`, this report and `evidence/`.
