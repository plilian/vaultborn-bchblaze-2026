# VaultBorn — Remaining economic, raid and verification gaps: final report

> **Dated report (19 November 2026),** written before the Mainnet launch. Its findings are kept as they were written; its statements about what had not yet run, and about Mainnet readiness, describe that day. VaultBorn has since gone live on Bitcoin Cash Mainnet, with wallet-signed payments and a contract settlement signed by the attestors. Current state and evidence: [STATUS.md](../../STATUS.md) · [MAINNET_TRANSACTIONS.md](../../MAINNET_TRANSACTIONS.md).

> **Superseded on 19 November 2026 by `FINAL_ECONOMY_REPORT.md`** (final price book, matched-stakes raids, one War Chest). Kept for history; prices, raid rules and custody described below are no longer current.

Date: 19 November 2026. This report supersedes `ECONOMY_SECURITY_GAPS_REPORT.md`. (The brief named a file `FINAL_ECONOMY_AND_SECURITY_GAPS.md`; no file of that name existed in the project, so I read `ECONOMY_SECURITY_GAPS_REPORT.md` and gave this report the requested name.)

**Status.** Three of the five gaps are closed in code and proven on the BCH VM, on Bitcoin Cash Node Regtest and by a live run of the real attestor tool: the game key can no longer choose a raid or territory outcome; waiting War Chest shares are captured together with the chest; season evidence is anchored on chain and audited by the attestors before they sign. Prize recovery is stronger but still has one unrecoverable case. **Not done:** paid political operations are still closed, and nothing ran on Chipnet or with a wallet app. No price, stake, reserve or percentage was changed.

## 1. Raid and territory outcomes (high priority) — closed without a price change

**Before.** One signature of the game key chose the settlement lane of a raid stake, a territory attack stake and the open half of a territory claim.

**Now.** Contested stakes use a new escrow, `stake-escrow-v3`. Its outcome lanes are opened by the **outcome panel**, never by the game key alone:

| Attestors configured | Panel | Game key |
|---|---|---|
| 1 | the game key **and** the attestor, both required | cannot settle alone |
| 2 | both attestors | not on the panel |
| 3 | any 2 of the 3 attestors | not on the panel |

Without an attestor, paid raids and territory contests are not sold at all.

**It fits the unchanged 600-satoshi reserve.** The previous report said a second signature needed a reserve of 720–870 sat. That was true of the old script. I rewrote the escrow compactly instead of raising the reserve:

| Settlement (with the battle record output) | Old escrow, game key alone | New escrow, 2 of 3 attestors |
|---|---:|---:|
| Script size | 338 bytes | 289 bytes |
| Stake returned to the attacker | up to 583 bytes | 563 bytes |
| Stake split 1,500 / 1,500 | up to 583 bytes | 597 bytes |
| Fee paid (fixed by the script) | 600 sat | 600 sat |
| Player's price for a paid raid | 3,600 sat | 3,600 sat |

**The attestors do not trust the server's winner.** For every proposed settlement the tool:

- rebuilds the escrow from its public terms and the transaction from its parts, and signs only that digest;
- fetches the battle record as an attestor (signed request; records are not public for 24 hours) and **replays the battle** with the game's resolver;
- requires the battle to have been started by this very stake payment, the attacker to be the payer, and the fixed opponent to be the recorded defender;
- signs "return" only for an attacker win and "split" only for a defender win; a returned stake after a lost raid is accepted only under the 24-hour pair rule, checked against the attestor's own log;
- for a territory claim, requires the forfeited half to pay the verified wallet of the contest winner in the contest record;
- pins the outcome it signed for each stake, so a second, different outcome for the same stake is refused.

If the attestors do not sign, the stake returns to its owner by the owner's own key after the refund time (3 days for raids, 7 for territory), as before.

**Trust that remains.** With one attestor, that attestor and the game key together decide. With two or three, a colluding attestor majority could pick the wrong one of the two fixed lanes; it can never send a stake anywhere else. A territory contest decided without a battle (a raffle or an uncontested claim) rests on the server's contest record.

## 2. War Chest: small payments

**The limit, exactly.** A capture pays the winner in an output of at least 546 sat and pays its own fee. The smallest capture here is 663 bytes (one attestor) or 804 bytes (2 of 3). So a capture must take at least 1,209 / 1,350 sat, and at 20% that needs at least 6,045 / 6,750 sat in the inputs. One 2,250-sat share yields 450 sat: below the 546-sat dust limit whatever the fee. **A single small share cannot be captured on Bitcoin Cash at 20%; no contract design changes that.**

**What changed.**

- **Waiting shares are now capturable together with the chest.** A waiting share's script lets an attested capture of its owner's War Chest take it along as an extra input. 20% of it is captured and the rest lands in the chest. It needs no signature and adds 160 bytes instead of a 663–804 byte capture of its own. A share is therefore at risk from the moment its owner has any War Chest output and the two together reach the floor.
- **A share that already reaches the floor goes straight into the War Chest**: no feeder, no 220-sat reserve, no later move. This applies to the 24,000-sat service today.
- **Captures are attested at once.** The tool used to wait 24 hours for the public battle record; it now receives the record as an attestor.

**What is still not at risk, and is shown as such:** shares of a player who has no War Chest output yet (until 3–4 purchases join), a War Chest that together with its waiting shares is below the floor, and money in an exit.

I did not build deferred "pending capture" obligations. A capture owed against a chest too small to pay it could not be enforced against the owner's exit, so it would be a promise without contract backing.

**Measured (1 sat/byte; `evidence/war-chest-model.json`)**

| | Previous pass | Now |
|---|---:|---:|
| 24,000-sat service: reserve / payer overhead | 520 / 884 sat | 300 / 664 sat |
| 4,500-sat service: reserve / payer overhead | 520 / 884 sat | 520 / 884 sat (unchanged) |
| Extra fee to capture one waiting share | not capturable | 160 sat |
| Player buying 1 service a week, never depositing: days capturable in 12 weeks (1 attestor / 2 of 3) | 10 / 7 | 16 / 13 |
| Same, 3 services a week | 40 / 31 | 56 / 49 |
| Average wait of a share before it is in the chest, 1 a week | 7 / 10.5 days | 1.8 / 3.5 days |

The first capturable day is unchanged (day 20–27 at one service a week): it is set by the limit above. Under constant daily raiding a third to a half of what is captured from a chest near the floor still goes to network fees.

## 3. Season verification

Kept: the hash-chained score journal, the closing entry, the keyless audit tool. Added:

- **On-chain anchors.** Every player payment commits, in its own record output, to the journal's length and head. The audit checks every anchor against the journal, so a rewrite of anchored history is caught even by a verifier who never looked before. No extra transaction is needed.
- **Level order.** A building or research level is scored once and only above the level already scored.
- **Pair limit (a new scoring rule).** Season points between the same attacker and defender count once per 24 hours; the game already refused a repeat attack for 8 hours. The audit applies the same rule to replayed battles and still flags a player who earned most battle points against one opponent.
- **Attestors audit before signing.** Run live (section 5): the tool recomputed the standings, signed the legitimate award, and refused an award built on an altered result with four independent findings.

Three faults were found by that live run and fixed. Keyless moves of reward shares were counted as prize payouts, which moved the published prize base and relaxed eligibility. The audit compared the fixed prize base with a pool figure that shrinks once an award is pending, so the tool would have refused every first award. And the attestor's evidence request crashed on a missing import.

**Trust that remains.** Only battles are replayed. Buildings, research, scouting, territory and political events are recorded by the server; the audit checks amount, order and uniqueness, not that they happened. Events are not signed by players. Eligibility (seat, verified wallet, not computer-run) and the tie-break values in the closing entry are server-reported. Confirming that an anchor transaction is on chain takes a block explorer; the tool has no node.

## 4. Prize availability and recovery

| Situation | Result |
|---|---|
| One of three attestors offline | Prizes and captures continue (2 of 3) |
| All but one attestor lost | From 30 days after the season closes: game key + that attestor |
| **Game key lost, attestors alive (new)** | From 30 days after the season closes: **every attestor together**, without the game key. Needs at least two attestors, so no single party ever spends alone |
| Game key lost and an attestor lost; or every attestor lost | **Still locked.** Any rule that released the pool here would hand it to one party or to nobody in particular |
| Sponsor money | Unchanged: keyless refund to the sponsor's own wallet |

All ways keep the same limits: at most 40% of a pool output per award, the remainder back to the pool, six blocks apart, not before the season closes.

**Reduced quorum, reviewed.** From day 30 the game key and one attestor can name any recipient, as the full quorum can from day 0; the script does not know who won. What limits abuse is time (30 days in which an honest majority pays the winners), the 40% and spacing limits, and the pins of the other attestors. I left it in place: without it the loss of two attestors would lock the pool.

The all-attestors lane is proven at contract level (VM and Regtest). There is no ready-made command for attestors to build those awards without the server.

## 5. Evidence

| Kind | What ran | Result |
|---|---|---|
| **Chipnet** | Nothing. No connectivity, no test funds | **NOT VERIFIED** |
| **Wallet (Selene / WizardConnect)** | Nothing. No wallet app in this environment | **NOT VERIFIED** |
| BCH VM, real server, enforcing fixture node | `node --test` | 188 of 188 |
| BCHN 29.2.0 Regtest, standard relay | `evidence/regtest-remediation.json` | 112 of 112; 12 new: panel-signed stakes inside the 600-sat fee, riding shares, all-attestor prize award |
| **Live attestor lifecycle** | `evidence/attestor-lifecycle.json`: a running local server over HTTP; three attestor keys, each running the real tool as its own process with its own key and pin files | 7 of 7 (below) |
| Browser, War Chest screens | `evidence/browser-war-chest.json` | 8 of 8 |
| Browser, original suite | `evidence/browser-qa.txt` | 3 of 3 consecutive runs after the fix (was 2 of 3). The fault was a click that waited for an animating tab to stop moving |

Live attestor lifecycle:

| Scenario | Outcome |
|---|---|
| Four small payments by one player | One War Chest output of 9,186 sat, keyless, fee 694 from the reserves |
| Contested territory claim; forged payee | Forged forfeit to the game's own wallet refused; honest settlement signed by 2 attestors: loser kept 1,000, winner received 1,000 |
| Forged raid outcome ("defender won") | Refused by all three: the replay shows the attacker won |
| Legitimate paid raid | One signature moved nothing; two settled it: 3,000 back to the attacker, 563 bytes, fee 600 |
| Defender starts an exit while a capture is owed | Capture re-proposed against the exit script, signed, paid first: 3,000 captured, 2,193 received (2,136 advertised) |
| Legitimate season prize | Proposed automatically; paid after two attestors audited the journal: 3,962 sat to rank 1 |
| Season result altered afterwards | Refused by all three; nothing signed |

Not covered live: a lost paid raid (the fixture's battle was an attacker win; the split lane is covered on VM and Regtest) and the 30-day prize lanes (Regtest only).

**To run on Chipnet (not verified):** create `var/covenant-keys.json` with test keys for the treasury, one attestor, a player and a rival, plus a developer address; fund the player and rival keys with about 100,000 Chipnet satoshis each; then run `CHIPNET_FIXTURE_FILE=var/covenant-keys.json CHIPNET_TEST_APPROVE=true npm run test:chipnet:covenants`. The script covers service payments, consolidation, a deposit, a raid with panel-signed settlement, a capture, the first exit step, a territory claim and, with 0.2502 test BCH, a sponsorship. **To test a wallet:** start the server with that configuration, pair Selene through WizardConnect, and approve one 4,500-sat service; the wallet must show four outputs, one of them a funded OP_RETURN of 450 sat.

## 6. Still open

| # | Issue | Reason |
|---|---|---|
| 1 | Chipnet and wallet runs | Environment: no network path to Chipnet, no funds, no wallet app |
| 2 | Paid political operations closed | Their proof transaction is paid from a game-key output. Reopening needs a new covenant whose reserve the game key can spend only as the fee of a record transaction, and about 240 sat of reserve added to the player's cost — an owner decision. Not built |
| 3 | Season pool locked if the game key and an attestor are both lost, or all attestors | Section 4 |
| 4 | Non-battle score events rest on the server | Section 3 |
| 5 | A War Chest below the floor is not capturable | Section 2 |
| 6 | No command for attestors to pay prizes without the server | Contract lane exists; tool not written |
| 7 | Historical operator-held outputs | Unchanged; owners can withdraw and re-deposit |

## 7. Acceptance

| # | Requirement | Result |
|---|---|---|
| 1 | Exact 50/20/20/10 | Met (VM, Regtest); unchanged |
| 2 | War Chest usable in PvP, limits disclosed | Met above the floor; the limit is stated and shown |
| 3 | No outcome chosen by the server key alone | **Met** for raids, territory attacks and claims (VM, Regtest, live) |
| 4 | Results reproducible as far as feasible | Reproducible from the anchored journal; battles replayed; other events server-recorded |
| 5 | Winners paid without the developer | Met live: automatic proposal, attestors sign |
| 6 | Safe prize recovery | Improved; one unrecoverable case remains |
| 7 | Prices unchanged | Met: no price, stake, reserve or percentage changed |
| 8 | Evidence kinds distinguished | Section 5 |
| 9 | Features functional or blockers reported | Paid political operations closed (open issue 2); everything else passes |

Mainnet was not touched. Nothing was pushed or deployed.

## Reproduce

```
node --test "tests/*.test.mjs" "packages/*/*.test.mjs"
REGTEST_BCHN=/path/to/bitcoind npm run test:regtest:remediation
npm run test:attestors
npm run simulate:warchest
npm run test:browser:warchest
DOMINION_BROWSER_REDUCED_MOTION=true npm run test:browser
```

## Changed in this pass

New: `packages/chain-observer/stake-escrow.mjs`, `scripts/attestor-lifecycle.mjs`.
Changed: `packages/chain-observer/{index,kingdom-vault,chest-feeder,prize-fund,vaultborn,threshold.test}.mjs`; `packages/game-engine/military.mjs`; `apps/game-server/{index,ledger,season-evidence}.mjs`; `apps/web/{screens,citadel}.js`; `scripts/{prize-attest,season-audit,simulate-war-chest,regtest-remediation,chipnet-covenants-e2e,browser-qa,browser-war-chest}.mjs`; `tests/{kingdom-covenant,territory-covenant,season-evidence}.test.mjs`; `tests/support/covenant-node.mjs`; `package.json`.
