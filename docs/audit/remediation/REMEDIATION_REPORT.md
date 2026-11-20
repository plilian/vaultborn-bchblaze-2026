# VaultBorn — Remediation, Contract Inventory, Evidence, Audit and Readiness

> **Dated report (19 November 2026),** written before the Mainnet launch. Its findings are kept as they were written; its statements about what had not yet run, and about Mainnet readiness, describe that day. VaultBorn has since gone live on Bitcoin Cash Mainnet, with wallet-signed payments and a contract settlement signed by the attestors. Current state and evidence: [STATUS.md](../../STATUS.md) · [MAINNET_TRANSACTIONS.md](../../MAINNET_TRANSACTIONS.md).

> **Superseded on 19 November 2026 by `FINAL_ECONOMY_REPORT.md`** (final price book, matched-stakes raids, one War Chest). Kept for history; prices, raid rules and custody described below are no longer current.

Date: 19 November 2026. Scope: the blockchain remediation requested on 18–19 November, including the final sponsorship and hackathon requirements (30/70, one developer address, covenant-controlled funds).

> **Second pass, 19 November 2026.** The Kingdom Treasury, raid stakes and at-risk funds are now under covenants, and the prize fund award lane is constrained. Territory stakes and the 10% service prize share are still operator-custodial. The current per-pool custody proof, evidence counts (180 tests, 48 Regtest cases) and open items are in [`CUSTODY_PROOF_AND_STATUS.md`](CUSTODY_PROOF_AND_STATUS.md). Where the two documents differ, that one is current.

**Read this first.**

- **No transaction in this report was made on Chipnet or Mainnet by this work.** The environment used for the remediation cannot reach Chipnet. Every new contract was executed in the BCH virtual machine and on a private Bitcoin Cash Node 29.2.0 Regtest chain with standard relay policy. Regtest is a local chain; it is not Chipnet evidence.
- **Mainnet is not ready and stays disabled.** The Kingdom Treasury, competitive stakes, the settlement reserve and the 10% service prize share are still spendable by the single game automation key.
- This is a self-audit by the author of the changes. It does not replace an independent security audit.

## 0. Status checklist

| Area | Status |
|---|---|
| Sponsorship 30% developer address / 70% prize fund covenant, 0.25 BCH minimum | DONE in code; VM + Regtest; NOT VERIFIED on Chipnet |
| Prize awards need independent attestors; keyless refund to sponsor | DONE in code; VM + Regtest; NOT VERIFIED on Chipnet |
| One developer receiving address | DONE (a second, different sponsorship address is refused at start-up) |
| Personal vault covenant | DONE in code; VM + Regtest; NOT VERIFIED on Chipnet |
| Treaty escrow v2 (any mis-funded amount returns to payer) | DONE in code; VM + Regtest; NOT VERIFIED on Chipnet |
| Exact 20/10/5/65 at 4,000 and 4,500 satoshis (prize carrier) | DONE in code; VM + Regtest; NOT VERIFIED on Chipnet |
| Reconciliation starvation, poison rows, stuck payouts, scoped reorg quarantine | DONE; fixture tests |
| CashTokens ownership tracing beyond the old limit | DONE; fixture tests |
| Electrum hardening, proxy-aware rate limits, city cap | DONE; unit tests |
| Kingdom Treasury, raid/battle stakes, territory escrow, service prize share under covenants | NOT IMPLEMENTED (templates fixed and Regtest-validated, not connected to the game) |
| Refund tool for mis-paid ordinary payments (non-escrow) | NOT IMPLEMENTED |
| Live Chipnet run of any new contract, Selene/WizardConnect re-test, browser suites | NOT VERIFIED |
| A feature that sends a BCH Mainnet transaction (BLAZE Mainnet Track) | NOT IMPLEMENTED (Mainnet deliberately disabled) |

## 1. Remediation report

### 1.1 Sponsorship (final requirements)

| Requirement | What the code does now | Files | Tests |
|---|---|---|---|
| 30% / 70% | `sponsor-fund-v2`: development = 30%, prize = 70%, amounts in steps of 10 satoshis so both parts are whole satoshis. The observer credits a payment only if both outputs match script and amount exactly. | `config/payments.mjs`, `packages/chain-observer/index.mjs` (`createSponsorIntent`), `apps/game-server/ledger.mjs` | `tests/sponsorship-fund.test.mjs` (20,000 random amounts plus bounds; wrong-split payment not credited) |
| 30% to the one developer address | The Development output pays `CHIPNET_DEVELOPMENT_ADDRESS` directly from the sponsor's wallet. The game never holds it. `CHIPNET_SPONSOR_DEVELOPMENT_ADDRESS` is retired: start-up fails if it is set to a different address. Sponsorship is closed (HTTP 503) until the developer address is configured. | `config/treasury.mjs`, `ledger.mjs` | same file: "one developer address is accepted…", "pays 30% to the developer address…" |
| 70% to a covenant, no operator wallet in between | The prize output pays a per-sponsorship `prize-fund-v1` P2SH32 covenant directly from the sponsor's wallet. Anyone can rebuild its address from the published terms. | `packages/chain-observer/prize-fund.mjs` | same file; Regtest group `prize-fund` |
| Developer and server cannot withdraw the 70% | Award lane: only after the season closes (CLTV) and only with the automation key **and every** configured prize attestor key over the whole transaction. The server holds the automation key only. Attestor keys equal to the automation key are refused. | `prize-fund.mjs`, `index.mjs` (`attestPrizeAward`) | "neither the automation key nor an early signature can move a prize fund output"; Regtest: automation key alone rejected, one of two attestors rejected, award before close rejected as non-final |
| Claims follow enforceable rules | A claim creates an unsigned proposal. `GET /api/public/prize-awards` publishes everything needed to rebuild it; `scripts/prize-attest.mjs` rebuilds the transaction, checks rank share × prize base, destination = the winner's verified wallet, remainder back into the fund, fee ≤ 5,000 satoshis, and signs only then. After the last attestor signature the automation key signs and the award is broadcast. Unsigned proposals lapse after 72 hours and the winner can claim again. | `ledger.mjs` (`pendingAwards`, `attestAward`, `watchFunds`), `scripts/prize-attest.mjs`, routes in `apps/game-server/index.mjs` | "a prize is only a proposal until every attestor signs…", "an award the attestors do not sign lapses…" |
| Refunds follow enforceable rules | Refund lane: after `refundAt` (season end + two season lengths + one day) anyone may broadcast a transaction that returns the output to the sponsor's own wallet, minus at most 1,000 satoshis of fee. No key is involved. The server sends it automatically and the ledger removes the amount from the prize pool. | `prize-fund.mjs` (`buildPrizeRefund`), `ledger.mjs` (`watchFunds`) | "a contribution that is never awarded returns to its sponsor without any key"; Regtest: refund before the date, redirected refund and over-fee refund rejected; two-input refund mined |
| Tiers, benefits, workflows kept | Campaign proposal, admin approval, funding, scheduled publication, impressions and tournament placement are unchanged. | `apps/game-server/portal.mjs` | `tests/server.test.mjs` "sponsor funding requires approval…" (now 0.5 BCH, 35,000,000 / 15,000,000) |
| Minimum 0.25 BCH, fixed BCH prices | See the price table below. No USD conversion exists anywhere. | `config/payments.mjs`, `portal.mjs`, `apps/web/screens.js`, `apps/web/citadel.js` | `tests/sponsorship-fund.test.mjs` |
| Ordinary service allocation unchanged | Still 20% Development / 10% Season Prizes / 5% burn / 65% Kingdom Treasury. | — | existing suite |

**Price change (explicit).** The code before this change did **not** have a 0.25 BCH minimum. It had a 2,730-satoshi minimum. The instruction said the minimum "remains" 0.25 BCH; it has been set to 0.25 BCH and the other values scaled as follows.

| Item | Before | Now |
|---|---|---|
| Minimum contribution | 2,730 sat | 0.25 BCH (25,000,000 sat) |
| Season banner | 5,000 sat | 0.5 BCH (50,000,000 sat) |
| Title sponsor | 20,000 sat | 2 BCH (200,000,000 sat) |
| Maximum contribution | 250,000 sat | 25 BCH (2,500,000,000 sat) |
| Amount step | 5 sat | 10 sat |
| Split | 20% / 80% | 30% / 70% |

Title sponsor stays 4× the banner. The maximum is 100× the minimum (it was about 92×). The banner is 2× the minimum (it was 1.8×).

**Migration.** Sponsorships already paid under 20/80 keep their terms: their outputs are still verified under `sponsor-split-v1` and their prize outputs are still claimable (`tests/sponsorship.test.mjs`). A campaign approved at an old price but not yet paid cannot be funded any more; it must be proposed again (HTTP 409 explains this). No funds are involved in that case. A sponsor now needs a verified wallet before funding, because the refund lane pays that wallet.

### 1.2 Earlier findings

| Finding | Fix | Main files | Tests | Remaining |
|---|---|---|---|---|
| H1 / BC-CON-01: one hot key controls all game funds | Personal vault → `vault-covenant-v1`. Sponsorship prizes → `prize-fund-v1`. Treaty escrow → v2 covenant. Sub-dust shares → `prize-carrier-v1`. Development → external developer address. | `vault-covenant.mjs`, `prize-fund.mjs`, `political-escrow.mjs`, `prize-carrier.mjs` | `tests/vault-covenant.test.mjs`, `tests/sponsorship-fund.test.mjs`, `tests/prize-carrier.test.mjs`, Regtest | **Open:** Kingdom Treasury, competitive stakes, settlement reserve, service prize share remain under the automation key |
| H2 / BC-PAY-02: reconciliation looked only at the newest 64 rows | Five priority classes with guaranteed shares and rotating cursors, oldest first | `ledger.mjs` (`reconcileBatch`) | `tests/payment-resilience.test.mjs` | — |
| M2: one unreadable row stopped all reconciliation | Per-row and per-lane fault isolation; a row is parked for review after three faults | `ledger.mjs` | same | — |
| BC-PAY-03: a payout that never relays stayed "submitted" forever | Periodic rebroadcast, recorded broadcast error, admin cancellation by a confirmed conflicting spend; balances restored | `ledger.mjs` (`voidPayout`), `treasury.mjs` (`restore`) | same, plus vault test | A prize fund award cannot be cancelled by the operator (by design) |
| M1: one reorganised payment froze every payout | Quarantine limited to the payer and the pools that payment funded; admin write-off for permanently reorganised payments | `ledger.mjs` (`quarantine`, `resolveReorg`) | same | — |
| BC-PAY-01: 10% prize share below dust was raised to 546 sat | Prize + kingdom shares travel in one carrier output and are swept by a keyless covenant spend into exact outputs. Prices unchanged. | `prize-carrier.mjs`, `ledger.mjs` (`sweepCarriers`) | `tests/prize-carrier.test.mjs`, Regtest | With a developer address configured the sweep fee must come from the settlement reserve; until one exists the disclosed 546 floor is used (see NF-05) |
| BC-CON-02: covenant templates could strand under- or over-funded outputs | Version 2 templates: refund lane pays the output at its own index, accepts a fee-sponsor input, recovers any amount | `treasury-covenants.mjs` | unit tests, Regtest | Templates are still not connected to the game |
| BC-CON-03: wrongly funded treaty escrow was unrecoverable | Escrow v2 returns any amount to the payer; admin route and CLI | `political-escrow.mjs`, `scripts/political-escrow-refund.mjs` | unit tests, Regtest | Version 1 escrows funded with a wrong amount still need a custom transaction |
| TR-01: payer refunds were not recognised without the operator signer | Observation runs before the signer check and rotates through matured escrows | `politics-protocol.mjs` | `tests/politics-server.test.mjs` | — |
| TR-02: NFT ownership tracing stopped at a hop limit | Resumable trace with a verified checkpoint | `territory-token.mjs`, `territory-assets.mjs` | `territory-assets.test.mjs` | — |
| M5: single Electrum server trusted | Header linkage and proof-of-work self-check over the confirmation depth; optional second-server witness | `transports.mjs`, `primitives.mjs` | `transport-hardening.test.mjs` | Chipnet permits minimum-difficulty blocks, so the work check is weak there |
| H3: shared rate limit behind a proxy | Per-player limits; `X-Forwarded-For` honoured only with `DOMINION_TRUST_PROXY=true` | `apps/game-server/index.mjs` | `tests/payment-resilience.test.mjs` | — |
| H4: unbounded anonymous cities | City cap (`DOMINION_MAX_CITIES`), 12 unpaid checkouts per player | `index.mjs`, `ledger.mjs` | `tests/payment-resilience.test.mjs` covers the checkout limit; the city cap has no test | No pruning of abandoned cities; the world is still one JSON document |
| M4: no operator tooling | Admin list, payout cancellation, write-off, mis-funded escrow return | `index.mjs`, `ledger.mjs` | same | No general refund tool for mis-paid ordinary payments |
| Stale claims in documents and UI | Dated correction note at the top of six documents; guide and protectorate text corrected; public custody map in `/api/public/ledger` | `docs/*.md`, `README.md`, `game-guide.js`, `packages/game-engine/index.mjs` | — | Older audit documents are left as historical records |
| Sybil exposure of ranked prizes, guest-session fragility, duplicate fee tables, inert flags (`XO_TEMPLATE_ENABLED`) | Not changed | — | — | Open |

## 2. Contract inventory

"Integrated" means the running game creates, funds and spends the contract. No contract below has a Chipnet address or TXID produced by this work.

| Contract | Purpose | Integrated | Evidence | Chipnet |
|---|---|---|---|---|
| `prize-fund-v1` (new) | 70% of each sponsorship; attested awards; keyless sponsor refund | Yes | VM tests; Regtest 9/9 | Not deployed |
| `vault-covenant-v1` (new) | Personal vault deposits | Yes (default) | VM tests; Regtest 6/6 | Not deployed |
| `prize-carrier-v1` (new) | Carries sub-dust prize + kingdom shares until swept | Yes (when a fee output exists) | VM tests; Regtest 6/6 | Not deployed |
| Political escrow v2 | Treaty compensation | Yes (new escrows) | VM tests; Regtest 5/5 | Not deployed. Version 1 has the project's own earlier Chipnet receipts (`docs/audit/blockchain/CHIPNET_EVIDENCE.md`), which I could not re-verify |
| Development 2-of-3 (`development`) | Optional form of the developer address | Yes, if configured | Existing unit tests | Not deployed by this work |
| Treasury covenant v2 `battle-escrow` | Raid stake escrow | **No** | Unit tests; Regtest | Not deployed |
| Treasury covenant v2 kingdom / territory tranches | Kingdom and territory funds | **No** | Unit tests | Not deployed |
| Treasury covenant v2 `season-prize` voucher | Per-winner voucher | **No** (superseded for sponsorships by `prize-fund-v1`) | Unit tests; Regtest | Not deployed |
| CashTokens territory and political NFTs | Collectibles and charters | Yes (dedicated issuer key held by the operator) | Existing tests; tracing fix tested | Project's own earlier receipts; not re-run |

Money still controlled by the automation key alone: Kingdom Treasury, raid and territory stakes, settlement reserve, the 10% service prize share (including swept carrier prize outputs), prize outputs of 20/80 sponsorships, and vault deposits made before the covenant.

## 3. Test evidence

| Kind | What ran | Result | Where |
|---|---|---|---|
| **Chipnet, newly executed** | Nothing | — | The environment cannot reach Chipnet |
| **Chipnet, historical** | The project's own receipts from before this work | Not re-verified (the explorer refused automated access) | `docs/audit/blockchain/CHIPNET_EVIDENCE.md`, `docs/CHIPNET_VERIFICATION_REPORT.md` |
| **Regtest, newly executed** | 30 accept/reject cases on Bitcoin Cash Node 29.2.0, standard relay policy: prize carrier 6, treaty escrow v2 5, treasury covenant v2 4, vault 6, prize fund 9 | 30 passed, 0 failed | `docs/audit/remediation/evidence/regtest-remediation.json` (local TXIDs, sizes, fees, node error texts); `npm run test:regtest:remediation` |
| **BCH VM + fixtures, newly executed** | Full suite: `node --test "tests/*.test.mjs" "packages/*/*.test.mjs"`. Real server over loopback, real chain code, a fixture node that runs the BCH VM on every broadcast and refuses conflicts and non-final transactions | 175 passed, 0 failed (134 before the remediation) | `tests/`, `packages/*/` |
| Mocked | Electrum transport responses in `transport-hardening.test.mjs` | Included above | — |
| Not run | Browser suites, Selene/WizardConnect, load test, Node 24 (Node 22 was used) | NOT VERIFIED | — |

A ready-to-run Chipnet lifecycle exists and has been executed by nobody: `CHIPNET_FIXTURE_FILE=… CHIPNET_TEST_APPROVE=true npm run test:chipnet:remediation`. It covers the carrier and sweep, vault deposit and withdrawal, escrow v2 return, treasury v2 recovery and, with a developer address, an attestor key and 0.2502 test BCH in the fixture, a 30/70 sponsorship. It writes addresses and TXIDs to `var/remediation-chipnet-*/receipts.json`.

## 4. Security audit of the final code

### 4.1 Attempts to break the new sponsorship path

| Attempt | Outcome |
|---|---|
| Automation key signs in every position | Rejected by the script (VM and BCHN) |
| Automation key plus one of two attestors | Rejected |
| Fully signed award before the season closes | Non-final; BCHN refuses to relay or mine it |
| Refund before the refund date | Non-final |
| Refund paying someone other than the sponsor, or keeping more than 1,000 sat | Rejected |
| Two inputs sharing one refund output | Impossible: each input checks the output at its own index |
| Sponsor payment with the right scripts but a 20/80 split | Not credited |
| Attestation signed by the automation key or a stranger | HTTP 400; nothing stored |
| Attestor signature reused on another award | Impossible: the digest covers inputs and outputs |
| Attestor key equal to the automation key | Refused at start-up and in the covenant builder |
| Developer address sponsoring its own prize fund | Refused |

### 4.2 Findings in the final code

| ID | Severity | Finding | State |
|---|---|---|---|
| NF-01 | High | The automation key alone still controls the Kingdom Treasury, competitive stakes, settlement reserve, service prize share and old prize outputs. This contradicts the non-custodial requirement. | Open — Mainnet blocker |
| NF-02 | High (trust) | A prize fund cannot rank players. After the season closes, the automation key **together with all attestors** can pay any address. Safety depends on the attestors being independent of the developer. The software cannot check that. With one attestor this is two parties. | Open by design — needs real independent attestors |
| NF-03 | Medium | The attestor tool checks amount, destination, remainder, fee and digests, but takes the ranking from the server. A false ranking reported by the server is caught only if the attestor reviews the public season archive. | Open |
| NF-04 | Medium | Awards are serial: a pending proposal reserves the fund outputs it spends, and its remainder is usable only after confirmation. A slow attestor delays every later claim; a proposal lapses after 72 hours. Claims have a finite window. | Open |
| NF-05 | Medium | With a developer address configured, the game holds no Development money, so (a) a carrier sweep can only be paid from the settlement reserve — before one exists, 4,000 and 4,500 sat services use the disclosed 546-sat prize floor instead of the exact split, and (b) council treasury votes have nothing to spend. | Open |
| NF-06 | Medium | The public attestation endpoint needs no login. It is protected by signature checks and rate limits only. | Accepted; review before public hosting |
| NF-07 | Medium | Personal vault: the operator can still refuse to co-sign until the recovery date (liveness, not theft). Deposits made before the covenant stay operator-held until withdrawn. | Open |
| NF-08 | Low | One claim spends either old operator-key prize outputs or covenant outputs, not both. In a mixed pool a claim can return HTTP 409 although the total would cover it. | Open |
| NF-09 | Low | An award remainder under 576 sat cannot be an output and becomes fee (at most 575 sat, shown in the quote). | Accepted |
| NF-10 | Low | After the refund date the award lane and the refund lane are both open; whoever confirms first wins. Refund fee (≤ 1,000 sat) is chosen by the broadcaster. | Accepted |
| NF-11 | Low | A 0.25 BCH minimum makes a Chipnet rehearsal need at least 0.25 test BCH. | Open |
| NF-12 | Info | On Chipnet the header proof-of-work check is weak because minimum-difficulty blocks are allowed. | Accepted |
| NF-13 | Info | The web client changes (sponsor wording, BCH amounts, attestation status) were syntax-checked only, not exercised in a browser. `scripts/browser-qa.mjs` probably needs updating: vault deposits and sponsorships now require a verified wallet. | NOT VERIFIED |

### 4.3 Trust assumptions that remain

1. Game state (scores, rankings, battle outcomes) is computed by the server. No contract verifies it.
2. Prize awards: automation key + every attestor. Sponsor recovery needs nobody.
3. Vault: the operator can delay, not take. The owner recovers alone after the recovery date.
4. Kingdom, stakes, reserve, service prize share: the operator can take. This is the main open problem.
5. Confirmations come from Electrum servers; a second witness is optional.

## 5. Mainnet readiness

| Lifecycle | Result | Reason |
|---|---|---|
| Sponsorship 30/70 into the prize fund | BLOCKED | Correct in VM and Regtest. No Chipnet run. Needs real independent attestors and an independent audit |
| Prize claim and sponsor refund | BLOCKED | Same |
| Personal vault deposit, withdrawal, owner recovery | BLOCKED | Correct in VM and Regtest. No Chipnet run |
| Treaty escrow v2 | BLOCKED | Correct in VM and Regtest. No Chipnet run |
| Service payment 20/10/5/65 | FAIL | Kingdom and prize shares end under the automation key; exact split depends on a fee output (NF-05) |
| Kingdom Treasury withdrawal | FAIL | Operator custody |
| Paid raid stake and settlement | FAIL | Operator custody; covenant not connected |
| Territory claims, contests, raffles | FAIL | Operator custody; covenant not connected |
| CashTokens issuance and ownership | BLOCKED | Tracing fixed in tests; no new Chipnet run; issuer key is operator-held |
| Payment reconciliation, reorg handling, stuck payouts | BLOCKED | Pass in fixtures; not exercised against a live network |
| Wallet connection (WizardConnect / Selene) | BLOCKED | Not re-tested after these changes |

**Overall: Mainnet NOT READY.** Mainnet remains disabled in the code and was not touched.

## 6. BCH BLAZE 2026 alignment

Sources: the official DoraHacks listing (I could read only the parts search engines index; the page itself refused automated access) and the BCH Bullet newsletters of 25 October and 15 November 2026. Confirm every point on the official page before submitting.

| Requirement (as published) | VaultBorn | Result |
|---|---|---|
| Register on DoraHacks and submit by 22 November 2026, 14:00 UTC; teams of up to four | Owner action | Not verifiable from the code |
| **Mainnet Track:** at least one feature that sends a BCH **Mainnet** transaction, and judges must be able to make a useful Mainnet transaction with the app | The game is pinned to Chipnet; Mainnet requests are rejected by client and signer | **UNMET** |
| **Mainnet Track:** WizardConnect or XO Template integration | WizardConnect pairing exists; the project's earlier notes record a Selene session. Not re-tested here | Present in code; NOT VERIFIED by this work |
| "Build with XO" bounty | Only an inert `XO_TEMPLATE_ENABLED` flag; no XO template | **Not eligible** |
| Paytaca decentralized identity bounty (500 PUSD): Nostr-based identity that makes BCH payments easier than copying addresses | BCH ⇄ Nostr linked identity with a public proof route exists (`packages/decentralized-identity`). I did not find a pay-by-identity flow, and could not read the full bounty text | **PARTIAL — not verified** |
| SolidCash and Folding Cash bounties | Not used | Not applicable |
| Verifiable contracts and genuine transaction evidence | Contracts are open, rebuildable from public terms, and listed in `/api/public/ledger` (custody map). New contracts have Regtest evidence only | Chipnet evidence for new contracts missing |

Using BCH covenants does not make the project eligible for any track. As it stands, VaultBorn does **not** meet the Mainnet Track because it cannot send a Mainnet transaction. Enabling one is an owner decision that this work was told not to take. The safest candidate would be a wallet-signed payment that never touches game-held funds.

## 7. Summary

**Fixed:** sponsorship is 30/70 with a 0.25 BCH minimum; the 30% goes straight to the one developer address and the 70% straight into a covenant that the server cannot spend alone and that returns unawarded money to the sponsor without any key. Before that: personal vault covenant, treaty escrow v2, exact service split through the prize carrier, payment reconciliation and recovery, CashTokens tracing, Electrum and rate-limit hardening.

**Works on Chipnet:** nothing new has been proven there. All new contracts pass the BCH VM (175 tests) and a real BCHN Regtest node (30 cases). A Chipnet script is ready and has not been run.

**Blocks Mainnet:** operator custody of the Kingdom Treasury, stakes, reserve and service prize share; no live Chipnet run of the new contracts; no real independent prize attestors; server-computed rankings; no independent audit. For BLAZE, the missing Mainnet transaction feature blocks the Mainnet Track.
