# VaultBorn — Final BCH economy, matched-stakes PvP and security remediation

> **Dated report (19 November 2026),** written before the Mainnet launch. Its findings are kept as they were written; its statements about what had not yet run, and about Mainnet readiness, describe that day. VaultBorn has since gone live on Bitcoin Cash Mainnet, with wallet-signed payments and a contract settlement signed by the attestors. Current state and evidence: [STATUS.md](../../STATUS.md) · [MAINNET_TRANSACTIONS.md](../../MAINNET_TRANSACTIONS.md).

> **Later update (19 November 2026):** the open issues and the Mainnet readiness of this report were taken further in `MAINNET_PREPARATION_REPORT.md` (service credit, recoverable proof reserve `record-reserve-v2`, exact withdrawals, Mainnet configuration). The economy described here is unchanged. VaultBorn has since gone live on Bitcoin Cash Mainnet; see [../../MAINNET_TRANSACTIONS.md](../../MAINNET_TRANSACTIONS.md).

Date: 19 November 2026. This is the single report of this pass. It supersedes `FINAL_ECONOMY_AND_SECURITY_GAPS.md`, `ECONOMY_SECURITY_GAPS_REPORT.md`, `FINAL_REMEDIATION_REPORT.md`, `CUSTODY_PROOF_AND_STATUS.md` and `REMEDIATION_REPORT.md` wherever they differ.

**Verdict in one paragraph.** Everything in the brief that can be built and tested without a public network is implemented and passes: a versioned price book, the exact 50/20/20/10 and 30/70 splits, one War Chest per player, matched-stakes raids settled in one atomic transaction, restored paid political operations, stricter season evidence and a standalone attestor payout tool. **Nothing was run on Chipnet and no real wallet (Selene/WizardConnect) signed anything in this pass**: the cloud workspace cannot reach Chipnet and holds no test funds. Every transaction id in the evidence files is from a local chain (BCH VM fixture or a private Bitcoin Cash Node Regtest). **Mainnet readiness: BLOCKED — not ready** (section 10).

Three things I decided that you should confirm or reverse, because they change what players pay or own:

1. **Single-use services cost 20,000 sat instead of 4,000** (premium 22,000 instead of 4,500). Reason and alternatives are in section 1. All prices live in one file, `config/pricing.mjs`.
2. **The personal protected vault is closed to new deposits**, because the brief allows exactly one player treasury. Existing deposits stay withdrawable by their owner. One server option (`personalVault: 'open'`) reverses it.
3. **A territory attack no longer touches a War Chest.** War Chest money now leaves only against an equal stake in a paid raid. The territory stake rule itself (the loser of a contest forfeits half the stake to the winner) is unchanged.

## 1. Prices: old, new, measured fees, justification

There is no universal minimum and no multiplier. Each price was set from the measured size of the transactions it causes (1 satoshi per byte) and from one design rule taken from the brief: *one normal purchase should create War Chest money that can actually be used*. The smallest stake that settles sensibly on-chain is 10,000 sat (below it the settlement fee exceeds 14% of the stake), so a service is priced so that its 50% share equals one smallest stake.

| Action | Old | New (`prices-v2`) | Network cost paid on top | Why |
|---|---:|---:|---|---|
| Rush an upgrade | 4,000 | **20,000** | 300 reserve + ~357 wallet fee | Share = 10,000 = one smallest stake. Fixed network cost falls from 16.4% to 3.3% of the price. |
| Paid intelligence mission | 4,000 | **20,000** | same | Same single-use class. |
| Premium building improvement | 4,500 | **22,000** | same | Permanent effect; one tenth above single use, as before. |
| Protectorate proposal | 24,000 | **24,000** | same | Unchanged: its share (12,000) already covers a stake. |
| Treaty charter | 4,000 (was closed) | **20,000** | 876 reserve (300 + 576 proof record) + ~401 | Restored (section 5). |
| Political support | 6,000 (was closed) | **20,000** | same | Restored at the single-use price. |
| Paid raid | stake 3,000 + 600; win 20% of the chest, loss half the stake | **stake S, 10,000 to 250,000 in steps of 1,000** | 2,880 (one attestor) or 3,340 (two of three) locked, unused part returned | Matched stakes (section 4). |
| Territory claim | 2,000 + 600 | **6,000 + 600** | reserve 600 | Reserve was 30% of the stake, now 10%. |
| Territory attack | 3,000 + 600 | **10,000 + 600** | reserve 600 | Same stake as the smallest raid; reserve 6%. |
| Territory raffle entry | 3,700 + 1,500 | **6,000 + 600** | reserve 600 | Reserve was 40.5% of the entry, now 10%. |
| War Chest deposit | min. 6,350 / 7,050 | **min. 10,000, steps of 1,000** | wallet fee only, no split | One deposit = one smallest stake. |
| Personal vault deposit | 1,000 to 250,000 | **closed** | | One treasury. |
| Treaty compensation escrow | principal + 650 | unchanged | | Player-to-player money, not a price. |
| Sponsorship | 0.25 / 0.5 / 2 / 25 BCH | unchanged | | No USD conversion anywhere. |

Measured transaction costs behind the table (`evidence/pricing.json`, built and verified in the BCH VM by the game's own contract code):

| Transaction | One attestor | Two of three attestors |
|---|---:|---:|
| Raid won, 1 / 2 / 3 War Chest outputs | 1,207 / 1,767 / 2,327 | 1,386 / 2,087 / 2,788 |
| Raid lost or void | 610 | 650 |
| Attacker's own refund after 3 days | 451 bytes | 488 bytes |
| War Chest withdrawal, 1 / 2 / 3 outputs (script cap 2,000) | 634 / 1,128 / 1,622 | 708 / 1,276 / 1,844 |
| Owner's exit, step one (paid from the owner's wallet) / step two | 732 / 494 bytes | 806 / 568 bytes |
| Political proof record | 231 bytes, paid by a 576 reserve | same |

**About the fivefold service price.** You rejected a price rise twice before and authorised repricing in this brief, so I state the trade-off plainly. A 4,000-sat service produces a 2,000-sat share. No stake that small can be matched on-chain: winning it costs 1,207 to 1,386 sat in fees. The alternatives were (a) keep 4,000 and accept that a player needs five purchases before the War Chest is usable, which the brief rules out, or (b) keep 4,000 and merge shares through an extra contract hop, which the brief also asks to remove. If you prefer cheaper services, change `services` in `config/pricing.mjs` and bump the book version; the stake floor does not depend on it, only the "one purchase = one stake" property does.

**Versioning.** Every checkout records its price book. An unpaid checkout quoted under an earlier book is refused and has to be quoted again; a payment that was already funded keeps its original terms (tested in `tests/pricing.test.mjs`). Free play is untouched and no price buys combat strength.

## 2. Allocation

**Services: 50% War Chest / 20% Seasonal Prize Pool / 20% Development / 10% burn**, split by the payer's own transaction into separate outputs. For 20,000 sat: 10,000 / 4,000 / 4,000 / 2,000. The percentages apply to the price only. The 300-sat reserve (fee of moving the prize share into the season pool) and the wallet's own fee are shown as separate lines in the checkout and never change the split. The server refuses a payment whose outputs do not match to the satoshi.

- War Chest share: one output of the payer's own `war-chest-v4` covenant. No feeder, no waiting.
- Prize share: a keyless feeder that can only pay the season pool covenant.
- Development: paid straight to your one configured address. The game never holds it.
- Burn: a value-carrying `OP_RETURN` output, provably unspendable. It is not a zero-value record and not a miner fee.

**Direct War Chest deposit:** 100% to the depositor's War Chest, no split.

**Sponsorship: 30% Development / 70% prize covenant**, minimum 0.25 BCH, Season Banner 0.5 BCH, Title Sponsor 2 BCH, maximum 25 BCH, unchanged.

In the simulation the realised split is 50.00 / 20.00 / 20.00 / 10.00 in all 15 scenarios; network fees add 5.3% to 8.1% of service spend on top, disclosed separately.

## 3. War Chest: funding, risk, withdrawal, recovery

**One treasury.** There is no kingdom treasury, no protected balance, no at-risk switch. The old risk endpoint is closed.

**Funding.** Half of every service payment, and any direct deposit of 10,000 sat or more. Both arrive as ordinary outputs of the owner's War Chest script and count as soon as they are confirmed.

**Risk.** All of it is at risk, but only in one way: the contract lets value leave toward an attacker only inside a transaction whose first output pays at least twice that value. Combined with the raid escrow (which fixes that output at exactly 2 × S), a War Chest can lose exactly S, and only against an attacker who locked S. No key combination can take an arbitrary amount for nothing.

**Withdrawal.** The owner asks in the game; the game key signs, and the contract forces the money to the owner's own wallet with the remainder back in the chest. The output must be 144 blocks old (about a day), the fee is capped at 2,000 sat per transaction, and money already claimed by a *funded* raid cannot be withdrawn until that raid settles.

**Recovery without the game.** The owner's key alone moves a War Chest output, whole, into an exit script and takes it out 288 blocks later (about two days). The fee comes from the owner's own wallet, so an exit cannot shrink a chest below a stake it owes. A raid funded before the exit still settles from the exit script during the wait. `scripts/owner-recover.mjs` does both steps and also refunds raid and territory escrows.

**Unavoidable limits, stated explicitly.**

- A raid can spend at most **three** War Chest outputs (transaction size and the fee reserve). A chest made of many small shares offers the sum of its three largest outputs, not its total. A withdrawal, or any raid settlement, merges the outputs it spends; there is no separate keyless merge.
- Stakes, deposits and remainders sit on a 1,000-sat grid, so a remainder below the dust limit never occurs.
- At the smallest stake the win fee is 12.1% (one attestor) or 13.9% (two of three) of the stake; at the simulated average stake of about 22,000 it is 7.6% to 9.1%.
- If the attestors are unreachable for longer than the 288-block exit, a defender who exited after losing can escape the capture; the raid is then void and the attacker gets the stake back. In the simulation this happened in 0 to 2 of up to 5,977 raids per run, with a 1% chance of a two-day outage per settlement.
- Earlier War Chest outputs (revision 3), feeder shares and personal vault deposits remain their owners' money and remain recoverable, but they are not raidable under the new rules.

## 4. Matched-stakes raids

**Rule.** The attacker picks S. A paid raid is offered only if the defender has at least S of confirmed War Chest money that is not being withdrawn, not exiting and not already claimed by another raid. Otherwise the paid option is disabled with the reason shown; the free raid stays available. The `acceptNoReward` override is removed. The half-stake forfeit is removed.

**Contract (`stake-escrow-v4`).** The attacker locks S plus a network reserve. Four exits exist and the script fixes the amounts:

| Outcome | Who opens it | Attacker's escrow pays | Defender's War Chest |
|---|---|---|---|
| Attacker wins | outcome panel | attacker exactly 2 × S, plus the unused reserve | loses exactly S, **in the same transaction** |
| Defender wins | outcome panel | defender's wallet (fixed at funding) exactly S; unused reserve back to the attacker | not an input, untouched |
| Void (battle could not be fought, cover gone) | outcome panel | attacker S plus the unused reserve | untouched |
| Refund | attacker's key alone after 3 days | attacker | untouched |

The outcome panel is the game key **and** the attestor (one attestor), or a majority of the attestors without the game key (two or more). The game key alone opens nothing. Before signing, each attestor replays the recorded battle and refuses a lane that does not follow from it (`scripts/attestor-review.mjs`).

**No double promises.** Each funded raid reserves S of the defender's chest until it settles; a second raid is matched only against what is left. An unpaid checkout reserves nothing against withdrawals and is not shown to the defender; if the cover is gone when the payment arrives, the raid is void and the attacker is refunded. The stake has no effect on the battle (tested with a fixed seed at different stakes).

**Actual payouts at the smallest stake (S = 10,000), measured:**

| | One attestor | Two of three |
|---|---:|---:|
| Wallet pays (S + reserve) | 12,880 | 13,340 |
| Win, one chest output: attacker receives / net | 21,673 / +8,793 | 21,954 / +8,614 |
| Win, three chest outputs: attacker receives / net | 20,553 / +7,673 | 20,552 / +7,212 |
| Loss: attacker gets back / net; defender receives | 2,270 / −10,610; +10,000 | 2,690 / −10,650; +10,000 |
| Void: attacker gets back / net | 12,270 / −610 | 12,690 / −650 |

**Live run with three attestor processes (local chain, not Chipnet):** S = 25,000, wallet paid 28,340, preview said the attacker would receive 51,953, the attacker received 51,953, fee 1,387, defender's chest 41,000 → 16,000, signed by attestors 1 and 2 with attestor 3 offline. Defender-win raid at S = 10,000: defender received 10,000, attacker got 2,690 of the reserve back, fee 650. A forged "defender wins", a forged capture and an edited battle record were each refused by every attestor.

**A flaw found and fixed during this work.** My first version paid the reserve refund in the same output as the winnings. Correctly signed test transactions showed that this let up to half the unused reserve leave the chest beyond S. The refund now has its own output and the winnings output is exactly 2 × S. The negative tests re-sign every wrong transaction properly, so each refusal comes from a contract rule and not from a broken signature.

## 5. Territory and political operations

**Territory.** Repriced as in section 1; the settlement fits the 600-sat reserve (558 / 597 bytes). Contested claims and attacks are settled by the outcome panel, never by the game key alone; raffle entries return to the entrant only, without any key. In the live run a contested claim of 6,000 left 3,000 with the loser and paid 3,000 to the winner's verified wallet, and a forged payee was refused.

**Paid political operations are open again.** The blocker was the fee of the public proof record, which used to come from an operator-held reserve. The payer now adds one 576-sat output locked by a new covenant, `record-reserve-v1`: the game key can spend it only into a single zero-value data output, so the whole amount becomes the network fee of that one record and can never be paid to anyone. No attestor and no operator money is involved. Tested: a successful operation (proof record 231 bytes); a spend to the game key's own wallet, a second paying output next to the record and a spend by another key (all refused by the node); requests without consent, by a stranger to the treaty or for an unknown operation (refused before a checkout exists); and an operation that can no longer be applied when its payment confirms.

*Limit, and it applies to every service, not only political ones:* the payer's own transaction performs the split, so when a paid action turns out to be inapplicable after payment (here: the treaty ended while the payment was confirming), no proof is published, the payer keeps the War Chest half, and the case is flagged for review, but the prize, Development and burn shares have already left and no contract can return them. The 576-sat record reserve of such a payment stays locked for good. The server refuses inapplicable actions at checkout, so this needs a state change inside the confirmation window.

## 6. Season rankings and automatic prizes

**What is now checked independently.** Every score entry names the record it comes from. Attestors and the public audit (`npm run audit:season`) rebuild the ranking from the journal and check: the hash chain and its on-chain anchors; every battle entry by replaying the recorded battle; construction against the least possible building time; research against its exact duration; missions against the shortest mission; one construction and one research slot per city at a time. An award is signed only if its amount equals rank share × prize base, with 85% of the pool distributable, 15% carried to the next season, and 40 / 25 / 15 / 10 / 10 for the top five. Each attestor pins the season result when it first sees it and refuses a later rewrite.

**Automatic.** At season close the server proposes the awards without anyone asking; attestors running on a schedule sign what they can rebuild; the payment is broadcast when the threshold is met. No manual winner selection exists. Live run: rank 1 was paid 4,646 sat after two attestors audited the evidence; an altered result was refused by all three.

**What remains server trust, stated plainly.** A hash chain proves the journal was not rewritten after it was anchored; it does not prove that an event happened. Battles are verified by replay, but their *inputs* (the armies present) come from the server's state. Buildings, research and missions are bounded by the rules, not proven: commands are not signed by players' keys. Tie-break values are server-reported. A dishonest server could therefore still credit plausible, rule-conforming activity that never took place; it can no longer invent impossible scores, reorder a finished ranking, or change amounts. Closing the rest needs player-signed commands, which is a gameplay-protocol change outside this pass.

## 7. Standalone prize recovery and trust assumptions

`scripts/attestor-payout.mjs` (`npm run payout:attestors`) pays season prizes **without the application server**. It needs a saved evidence bundle, the public keys of the game and attestors, and a Bitcoin Cash node or Electrum server. It audits the bundle with the same code as the live audit, rebuilds each prize contract from its published terms, proposes an award, lets each attestor verify and sign on their own machine, and broadcasts.

The attestor process now saves that bundle by itself on every run when `PRIZE_ATTESTOR_BUNDLE_DIR` is set, so the evidence exists before an outage.

Who must sign is decided by the contracts, not by the tool:

| Situation | Season pool (service shares) | Sponsor fund |
|---|---|---|
| Server gone, game key available | game key + attestor majority, at once | same |
| From 30 days after season close | game key + any one attestor | same |
| Game key lost | **all** attestors together, from 30 days after close (needs two or more attestors) | not payable; it returns to the sponsor by its keyless refund |

Tested: server shut down and prize paid from the bundle and the chain alone; game key lost and all attestors paying after the recovery date but not a day earlier; the tool's node adapter against a real Bitcoin Cash Node on Regtest.

**Cryptographic limits I could not remove.** A contract cannot compute a game ranking, so some set of keys must attest to it; I did not replace that with unilateral custody. With a single attestor there is no path without the game key. The tool's Electrum adapter is written but was not exercised against a live server.

**Trust assumptions that remain.**

- A colluding game key and attestor majority can sign a false raid outcome or a false award. The matched rule limits a false raid to S per raid against a real attacker stake; it does not prevent it. Attestors must be run by people independent of you and of each other.
- A stolen game key alone cannot take player or prize money. It can force War Chest outputs back to their owners' wallets and waste up to 2,000 sat of fee per output.
- Attestor independence is an operational fact, not something the code can prove.

## 8. Custody and security audit

| Money | Held by | Who can move it |
|---|---|---|
| Development (20% of services, 30% of sponsorship) | your address | you only; never held by the game |
| War Chest | `war-chest-v4`, one script per owner | owner's wallet via game key; matched capture via game key + attestors; owner alone via exit |
| Raid stake | `stake-escrow-v4` | outcome panel into fixed lanes; attacker alone after 3 days |
| Territory stake | `stake-escrow-v3` | outcome panel; owner refund after timeout; raffles keyless |
| Season prize pool | feeders (keyless) → pool covenant | game key + attestor threshold, at most 40% of a pool output per award |
| Sponsor prize fund | `prize-fund-v1` | game key + attestors after season close; keyless refund to the sponsor |
| Treaty compensation | `political-escrow` v2 | payee on release, payer on refund or timeout |
| Political proof fee | `record-reserve-v1` | game key, only as the fee of one data record |
| Burn | `OP_RETURN` | nobody |

No operator-held pool is used by any new payment. The server publishes this map and counts any older operator-spendable outputs separately so they cannot be mistaken for covenant money.

Attacks tested and refused (VM and Regtest, with correctly signed transactions unless the attack is a missing signature): capture by the game key alone; capture by an attestor without the game key; one of three attestors; capture of S + 1; keeping part of the reserve; sending the remainder elsewhere; an attacker "winning" by matching the escrow with their own money; a defender-win paid to another wallet; early refund; withdrawal to a foreign wallet or before 144 blocks; an exit that pays a wallet, shrinks the chest or is started by the game key; early exit spend; double-claiming one chest by concurrent raids; a withdrawal racing a funded raid; an exit after funding; forged and edited battle results; a stale price book; an altered season result; misuse of the record reserve.

## 9. Tests, evidence, blockers

All figures below were produced on 19 November 2026 in the cloud workspace. Evidence files are in `docs/audit/remediation/evidence/`.

| Run | Result | Evidence |
|---|---|---|
| Full unit and BCH VM regression | 216 of 216 pass | `unit-tests.txt` |
| Bitcoin Cash Node 29.2.0 Regtest, standard relay policy | 141 pass, 0 fail (24 matched-stakes, 4 record-reserve, 1 payout-tool cases new) | `regtest-remediation.json` |
| Live attestor lifecycle (server over HTTP, three attestor processes, 2 of 3) | 11 of 11 scenarios | `attestor-lifecycle.json` |
| War Chest and matched-stakes browser checks | 9 of 9 | `browser-war-chest.json` |
| Original browser suite | 6 consecutive complete runs with the final code | `browser-qa.txt` |
| Price measurements | | `pricing.json` |
| Economy simulation: 20 / 200 / 2,000 players, 4 seasons, 1 and 2-of-3 attestors, with and without a sponsor, plus three stress cases | 15 scenarios | `economy-final.json` |

The mandatory matched-stakes tests are all present and pass: defender below S blocked; exactly S (chest emptied to the satoshi); more than S (exactly S taken, rest returned); attacker wins; defender wins; empty War Chest; concurrent raids; pending withdrawal and exit; fake battle result; fees and receipts equal to the preview.

Simulation, 200 players, 2 of 3 attestors, no sponsor, four seasons: 1,768 services, 36.8M sat spent, 610 raids fought, 29.8% of raid attempts blocked for lack of matched exposure, average stake 22,561, average win fee 2,062 (8.9%), Development 7.36M, burned 3.68M, 167 of 200 players raidable at the smallest stake, top prize 650,668 in season 1. With 20 low-activity players and no deposits, 63.6% of raid attempts are blocked: in a small, quiet world matched raids are scarce by design.

**Honest notes on the tests.**

- The original browser suite was unstable in this container: it stopped in 6 of 11 runs before I changed three of its helpers (a tab click lost during a redraw; an "expired checkout" notice covering the next button). None of the stops was in a BCH step and the game code was not changed for it, but it means the suite's earlier "3 of 3" was luck as much as proof.
- The Regtest run predates the last two commits. Those changed only server reservation logic and test scripts, not contracts, so I did not repeat it.
- The simulation is a model with fixed seeds and assumed player behaviour, not a forecast.

**Not verified — blockers.**

1. **No Chipnet transaction of any contract in this pass.** `scripts/chipnet-covenants-e2e.mjs` is rewritten for the final economy and has never been executed.
2. **No Selene or WizardConnect signing** of the new payment shapes (five-output service payment, raid stake, record reserve, exit with a wallet fee input).
3. **Electrum adapter of the payout tool** not exercised.
4. **No independent attestors exist yet** and no external audit was done. All "independent" processes in the tests ran on one machine under my control.
5. Player-signed commands (section 6) are not built.
6. The BCH BLAZE Mainnet Track requirement is not met, by your own instruction not to use Mainnet.

## 10. Mainnet readiness: BLOCKED

Not PASS. The implementation is complete against the brief and every test that could run here passes, but real-value use is blocked until, at minimum: the Chipnet end-to-end script and both browser wallets have been run with test funds and the results recorded; at least two attestors are operated by independent parties; an external reviewer has read the three new contracts (`war-chest-v4`, `stake-escrow-v4`, `record-reserve-v1`); and you have confirmed the three decisions listed at the top. Nothing was deployed, pushed to GitHub or activated on Mainnet.
