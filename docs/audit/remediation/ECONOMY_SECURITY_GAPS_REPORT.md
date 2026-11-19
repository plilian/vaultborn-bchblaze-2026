# VaultBorn — Final economy and security gaps: report

> **Superseded on 19 November 2026 by `FINAL_ECONOMY_REPORT.md`** (final price book, matched-stakes raids, one War Chest). Kept for history; prices, raid rules and custody described below are no longer current.

> **Superseded by [`FINAL_ECONOMY_AND_SECURITY_GAPS.md`](FINAL_ECONOMY_AND_SECURITY_GAPS.md).** Open issue 2 (outcome lanes) is closed there without a price change.

Date: 19 November 2026. Builds on `FINAL_REMEDIATION_REPORT.md`; where the two differ, this one is current.
The 50/20/20/10 split, the single War Chest and all gameplay prices are unchanged.

**Status.** Small service shares now become capturable War Chest money by a keyless, contract-enforced consolidation; the owner's recovery can no longer outrun a capture; captures and prizes need a majority of attestors instead of all; season standings can be recomputed from a public, hash-chained score journal. This is **not finished**: nothing has run on Chipnet or with a wallet app, raid and territory outcomes are still chosen by the game key alone, and paid political operations are still closed. Section 6 gives the reasons.

## 1. Small War Chest balances

**What was wrong.** A 2,000–2,250 sat share sat in its own War Chest output. 20% of it (400–450) is less than a capture's fee, so it could never be captured, and withdrawing it cost 24–27%.

**What is built.**

- A service payment's 50% share is paid into a keyless feeder (`chest-feeder-v1`) with a 220-sat payer-funded reserve. The feeder can only become an output of the payer's own War Chest script; the fee is capped at the reserves; at most four feeders move at once.
- Feeders move only when the resulting output reaches the **capture floor**: the smallest output from which a 20% capture pays its own fee and leaves a spendable 546 sat. The server sends the move as soon as that is true. No wallet approval is involved.
- Every player has one War Chest script (`war-chest-v3`), so service shares and direct deposits land together. A direct deposit must reach the floor.
- A capture spends up to four outputs of one War Chest and returns **one** remainder of at least 80% of all of them. Captures therefore keep the chest consolidated.
- The raid preview, the accounting and the settlement use one function that plans the real capture. The advertised win is the amount after the capture's own fee, and a capture the chain cannot pay is never recorded.
- A lone share that never reaches the floor joins the War Chest after 13,104 blocks (about 13 weeks), so nothing is stranded if the player stops paying or the server disappears.

**What is disclosed to the player**, in the Vault, Council, raid and payment screens: shares waiting to join, the floor, the amount capturable now, the capture's fee, and money in an exit.

**Not at risk, by design or by arithmetic:**

| Money | Why | For how long |
|---|---|---|
| Shares waiting in feeders | Not yet in the War Chest | Until the waiting shares reach the floor: 3–4 purchases at 4,000–4,500 sat |
| A War Chest below the floor | 20% of it cannot pay a capture's fee | Until more shares or a deposit arrive |
| Money in the owner's exit | The owner has started to leave | 288 blocks; a capture already owed is still taken |

A player who deliberately lets each share wait 13 weeks and moves it alone keeps that share below the floor. The contract cannot prevent this without spending the player's money on fees.

**Measured fees (1 sat/byte; `evidence/war-chest-model.json`)**

| | Before | After, 1 attestor | After, 2 of 3 attestors |
|---|---:|---:|---:|
| Network reserve added to a service price | 300 | 520 | 520 |
| Payer's cost on top of a 4,500-sat service (reserve + fee) | 664 (14.8%) | 884 (19.6%) | 884 (19.6%) |
| Shares needed for one capturable output (4,500-sat services) | never | 3 | 4 |
| Consolidation fee per share (paid from the reserve) | – | 172 | 168 |
| Capture floor | none reachable | 6,350 | 7,050 |
| Capture fee | 610 | 663 | 804 |
| Capture from the first consolidated output (gross → winner) | not possible | 1,378 → 715 | 1,842 → 1,038 |
| Withdrawal fee per share | 544 (24%) | 199 (8.7%) | 168 (7.3%) |
| Total network cost per share, payment to wallet | 876 | 703 | 667 |

The price a payer sees rises by 220 sat per service. Of that, the unused part (144–210 sat per batch) returns to the payer's own War Chest. The total cost of getting a share from payment to wallet falls by about 20%.

**Players who never deposit** (12 weeks of 4,500-sat services, raided by a different winner every day a capture is executable):

| Services per week | First capturable (1 attestor / 2 of 3) | Captures | Captured | Reached winners | War Chest at end |
|---:|---|---:|---:|---:|---|
| 0.25 | day 83 / not within 12 weeks | 1 / 0 | 1,378 / 0 | 715 / 0 | 5,516 below floor / 6,750 waiting |
| 1 | day 20 / day 27 | 10 / 7 | 18,134 / 15,221 | 9,785 / 8,165 | one output, above floor |
| 3 | day 6 / day 9 | 40 / 31 | 73,316 / 70,168 | 40,493 / 39,532 | one output, above floor |
| 7 | day 2 / day 3 | 80 / 79 | 181,728 / 180,684 | 113,217 / 102,888 | one output, above floor |

Under constant daily raiding, 38–46% of what is captured from a small chest goes to network fees. That is the cost of 20% captures at these balances; larger chests pay the same fee on larger captures.

## 2. Paid raid settlement and recovery

**Recovery race: closed.** The dated owner recovery (owner key alone after three days) is replaced by a two-step exit:

1. At any time the owner's key moves a War Chest output into its exit script. The script allows no other owner-signed destination.
2. The exit script keeps the same capture lane (output 144 blocks old) and lets the owner's key spend only when the output is 288 blocks old.

A capture that was owed when the exit began therefore has blocks 144–288 to confirm, and its remainder restarts both clocks. The ledger watches for exits, lets the stale capture proposal lapse, proposes it again against the exit script, and stops offering exiting money to new raids.

*Residual race:* if the game server or the attestor majority is down for the whole two-day window, the owner leaves with the money. That is the intended recovery when the system has failed.

**Lifecycle, as reviewed.** Stake 3,000 + 600 reserve in an escrow that can only pay the attacker or the named defender. A win returns the stake and proposes a capture of min(20% of the capturable War Chest, stake). A loss sends 1,500 to the defender. One capture per pair per day; several attackers are served one capture at a time, each from the remainder of the last once it is 144 blocks old. Withdrawals are refused while a raid against the player is unsettled. A battle is captured once; the attestor replays it before signing.

**Where captured BCH goes: the winner's wallet, unchanged.** Paying it into the winner's War Chest would create an output below the floor, or need the winner's chest as an extra input (about 600 more sat of fee). The wallet payment is final for the winner at once.

**Free and paid raids** use the same combat rules. A free raid never moves BCH; the raid screen says so.

## 3. Independent winner verification

**Built.**

- Every score change is queued by the game rules and sealed, with the world save that produced it, into a per-season **score journal**: numbered entries, each hashing the previous one, each naming the player, the amount, the kind of event and, for battles, buildings and research, the record that earned it.
- When a season closes, its final standings and tie-break values become the journal's last entry. The published season result commits to the journal's length and head, and every award transaction commits to that result.
- `GET /api/public/season-events` serves the journal. `scripts/season-audit.mjs` (no key needed) checks the chain, checks each amount against the scoring table, refuses a record scored twice for one player, replays every battle whose record is public, recomputes the standings and the prize of each rank, and compares them with the published result.
- With a pin file it also proves that nothing it saw on an earlier run was changed or removed, even if the server recomputes every hash.
- The attestor tool runs this audit and refuses to sign an award whose player, score, rank, wallet or amount does not follow from it.

**Tested:** altered, removed, inflated and duplicated entries; a battle scored for the wrong side; a consistently rewritten journal; a standing raised without any event.

**Trust that remains — this is not full verification.**

- Only battles can be replayed. A finished building, a research level, a scouting mission, a territory or political event is recorded by the game server alone. The audit checks its amount and uniqueness, not that it happened.
- Events are not signed by players. A server could record events for an account it controls.
- Battle records become public 24 hours after the battle; newer ones are reported as not yet replayed.
- Eligibility (not computer-run, holds a seat, verified wallet) is reported by the server.
- Sybil and collusion rules are unchanged: distinct verified wallets, daily attack limits, the ±20% power bracket. The audit only flags a player who earned most battle points against one opponent.

## 4. Attestor availability and prize recovery

- **Threshold.** Captures and prize awards need the game key and a strict majority of the attestors (1 of 1, 2 of 2, 2 of 3). A smaller threshold is refused when the script is built. One of three attestors can be offline.
- **No unilateral access.** The game key alone can never capture or award. The attestors alone cannot either.
- **Season pool recovery.** From 30 days after a season closes, an award from the season pool needs the game key and any one attestor, so the pool is not lost when all but one attestor disappear. The 40% per-output limit, the remainder rule and the six-block spacing still apply.
- **Sponsor refunds** are unchanged: keyless, to the sponsor's own wallet.
- **What still locks the season pool for good:** the loss of the game key, or of every attestor. I found no rule that releases it in those cases without handing it to a single party.
- Attestors chosen and run by the developer are not independent. The contract cannot check who holds a key.

## 5. Other gaps

| Gap | Result |
|---|---|
| Lone reward shares waiting for another payment | Fixed: after six hours a lone share becomes a pool output of its own |
| Incomplete financial configuration at start-up | Fixed: the server prints what is open, what is closed and why; `VAULTBORN_REQUIRE_FINANCIAL_CONFIGURATION=true` refuses to start |
| Balances, custody map and records disagreeing | Fixed for the War Chest: waiting, in-chest, capturable and exiting amounts come from the outputs themselves; reserve remainders and exit fees are booked; the public ledger lists waiting shares |
| Game key chooses raid and territory outcomes | **Open** (section 6) |
| Paid political operations | **Open** (section 6) |
| Historical operator-held funds | Unchanged. The voluntary path is the existing withdrawal to the owner's wallet followed by a deposit from that wallet. Nothing is moved automatically |
| Fee overhead on small purchases | Up 220 sat at payment, down about 20% end to end (section 1) |

## 6. Open issues and blockers

| # | Issue | Technical reason |
|---|---|---|
| 1 | No Chipnet transaction and no wallet run | The work environment cannot reach Chipnet and holds no test funds or wallet app. `npm run test:chipnet:covenants` is extended for this model and has never been executed |
| 2 | Raid and territory outcome lanes are chosen by the game key alone | The escrow spend is 583 bytes with one signature and the reserve is 600 sat. A second signature needs about 118 more. It fits only with a reserve of about 720 sat (one attestor) or 870 (2 of 3), which changes the paid raid total and needs your approval, or by naming one attestor instead of the game key as the only outcome key |
| 3 | Paid political operations closed | Their proof transaction is paid from a game-key output. A covenant that lets the game key spend a reserve only as the fee of a record transaction would reopen them; it is not built |
| 4 | Non-battle score events rest on the server's word | Section 3 |
| 5 | Season pool locked if the game key or all attestors are lost | Section 4 |
| 6 | Money below the capture floor is not capturable | Section 1 |
| 7 | The attestor tool was not run end to end in this pass | Its new checks are covered through the audit's tests; the tool itself needs a live server with a pending award |
| 8 | The original browser suite passed in two of three runs | One run stopped on a click on the "Conflicts" tab that Playwright reported as never stable. No payment step was involved |

## 7. Evidence

| Kind | Result |
|---|---|
| Chipnet | None |
| Wallet app (Selene / WizardConnect) | None. The wallet library loads in the browser runs; no wallet was paired |
| BCH VM, real server, enforcing fixture node | 186 of 186 |
| BCHN 29.2.0 Regtest, standard relay (`evidence/regtest-remediation.json`) | 100 of 100, including 23 new cases: consolidation, lone-share wait, 2-of-3 capture, three-output capture with one remainder, the two-step exit against an owed capture, 2-of-3 and reduced-quorum prize awards |
| War Chest model (`evidence/war-chest-model.json`) | Section 1 |
| Browser, War Chest screens (`evidence/browser-war-chest.json`) | 8 of 8 |
| Browser, original suite updated for the final configuration (`evidence/browser-qa.txt`) | Complete in 2 of 3 runs; run with reduced motion; prepares payments only |

Acceptance, point by point:

| # | Requirement | Result |
|---|---|---|
| 1 | Split exact, burn real | Met on VM and Regtest |
| 2 | All War Chest money at feasible risk under disclosed conditions | Met above the floor; disclosed exceptions in section 1 |
| 3 | Small contributions do not accumulate as unusable outputs | Met: shares join, captures consolidate; a chest below the floor remains withdrawable at one fee |
| 4 | Raid winners and losers receive the correct amounts | Met on VM and Regtest; the lane is chosen by the game key (open issue 2) |
| 5 | No evasion through recovery races | Met, with the stated two-day outage case |
| 6 | Rankings reproducible from trustworthy evidence | Partly: reproducible from the journal; only battles are independently replayable |
| 7 | Winners paid without developer action | Met; attestors must run their tool |
| 8 | Prize funds recoverable when servers or attestors disappear | Partly: down to one attestor; not without the game key |
| 9 | All non-Development funds covenant-controlled | Met for new money; historical outputs unchanged |
| 10 | Previously working features remain | 186 tests pass and the original browser suite completes (2 of 3 runs); paid political operations remain closed |

**Mainnet: not ready.** Mainnet was not touched; nothing was pushed or deployed.

## Reproduce

```
node --test "tests/*.test.mjs" "packages/*/*.test.mjs"
REGTEST_BCHN=/path/to/bitcoind npm run test:regtest:remediation
npm run simulate:warchest
npm run test:browser:warchest
DOMINION_BROWSER_REDUCED_MOTION=true npm run test:browser
npm run audit:season -- <server origin>               # against a running server
CHIPNET_FIXTURE_FILE=var/covenant-keys.json CHIPNET_TEST_APPROVE=true npm run test:chipnet:covenants   # never executed
```

## Changed in this pass

New: `packages/chain-observer/chest-feeder.mjs`, `packages/chain-observer/threshold.test.mjs`, `apps/game-server/season-evidence.mjs`, `scripts/season-audit.mjs`, `scripts/simulate-war-chest.mjs`, `tests/season-evidence.test.mjs`.
Changed: `config/payments.mjs`; `packages/chain-observer/{index,kingdom-vault,prize-fund,vaultborn}.mjs`; `packages/game-engine/{world,economy,military,npc,treasury}.mjs`; `apps/game-server/{index,ledger,store}.mjs`; `apps/web/{screens,citadel,strategy-stats}.js`; `scripts/{browser-qa,browser-war-chest,chipnet-covenants-e2e,owner-recover,prize-attest,regtest-remediation}.mjs`; `tests/{kingdom-covenant,sponsorship-fund}.test.mjs`; `tests/support/covenant-node.mjs`; `package.json`.
