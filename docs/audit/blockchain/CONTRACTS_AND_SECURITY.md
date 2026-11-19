# Contracts and security audit

Audit date: 18 November 2026. This report inspects the existing code and reuses prior evidence. No implementation was changed. New execution was limited to genuine coverage gaps on the existing isolated BCHN Regtest chain. No Chipnet or Mainnet transaction was sent by this contract workstream.

The new generic contracts now have real Regtest spending evidence, beyond compilation and mocks. Their nominal spends passed, but a small-underfunding recovery failure was confirmed. Most active game funds still use the earlier operator-controlled custody path. That integration boundary is a High readiness risk, not evidence of an unauthenticated web exploit.

## Architecture and coverage

| Contract or financial path | Current application use and custody | Evidence and result |
| --- | --- | --- |
| Development | Direct configured native destination; optional compiled 2-of-3 P2SH32 covenant. Default destination is operator-derived. Council keys may choose arbitrary destinations; the covenant does not impose a further allocation. | **PASS**: newly funded 2-of-3 spend confirmed on Regtest; outsider substitution rejected. The incoming 20% allocation is checked separately by payment outputs. |
| Premium/services, burn, sponsorship | Direct wallet-approved allocation outputs, not an intermediate split covenant. BCH burn uses a value-bearing unspendable OP_RETURN; sponsorship has two spendable 20/80 outputs. | Refer to [transaction accounting](TRANSACTIONS_AND_ECONOMY.md). Historical fee/ratio evidence is not automatically proof of the current allocation policy. |
| Live Kingdom Treasury / raid funds | Current per-intent operator-derived custody and signed payout ledger. Application outcomes determine moves. | **FAIL** against operator-independent recovery/fully covenant-backed feature parity: generic profiles are not connected. Correct custodial receipt flows are covered separately. |
| Generic battle escrow | Exact principal, fixed reserve, two distinct attestor signatures for authorized outcomes; owner-signed timeout refund. | **PASS** for real confirmed return, opposed settlement, and correctly/overfunded timeout refund; **FAIL** for small underfunding. |
| Generic kingdom exposure | Same authorization with capture capped at min(20% of principal, 3,000 sats). | **PASS**: 20,000 principal gives an exact 3,000 transfer and 17,000 owner output on Regtest. Not the live application funding script. |
| Generic opposed territory escrow | Fixed two-party tranche, two attestors, owner timeout recovery. | **PASS**: actual opposed spend confirmed; same small-underfunding limitation. It does not implement open multi-entrant cohorts. |
| Generic uncontested territory | Permissionless fixed owner return after closure; owner refund after the later timeout. | **PASS**: early return rejected and post-closure return mined. |
| Live territory contests | Existing application scheduler and operator signer handle accepted entrants, drawing, principal returns and lease bookkeeping. | Generic tranche verification does **not** prove live cohort migration or independent payer recovery. See [tokens/escrow report](TOKENS_ESCROW_AND_REWARDS.md). |
| Generic seasonal voucher | One compile-time fixed winner destination, public claim, public timed fixed rollover destination. No battle/season validator or signature slot is required for these fixed destinations. | **PASS**: actual claim and rollover on separate vouchers mined; early rollover rejected. **FAIL** for app integration; this is not a contract-computed leaderboard. |
| Existing political compensation | P2SH20 covenant restricts exact principal to the named recipient, or named payer through operator refund / payer-signed timeout refund. | **PREVIOUSLY VERIFIED**: all three historical contracts compile byte-identically under current source, and their Regtest funding/spends still match stored blocks. Mismatched-value tooling is a separate **FAIL**. |
| CashTokens | Token authority/issuance and ownership rules are separate from treasury custody; NFT ownership is not game command authority. | Covered in [tokens/escrow report](TOKENS_ESCROW_AND_REWARDS.md); no repeat token issuance was needed here. |

## Evidence reuse and chain identity

The reused node is BCHN 29.2.0, with Regtest genesis `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`. Its existing data directory is `var/regtest-territory-9OcMCX`. The audit queried all **15** transactions in [the historical political Regtest record](../../POLITICS_REGTEST_RECEIPTS.json), checked their recorded block hashes and positive confirmations, and recompiled all **3** political refund/release redeem scripts byte-for-byte with current `politicalEscrow()`. These are **PREVIOUSLY VERIFIED** political/territory/token operations; they were not recreated or rebroadcast.

The earlier generic treasury tests proved BCH VM behavior but contained no mined Development/battle/kingdom/season voucher spends. That was an actual gap, so a single fresh funding transaction supplied the missing cases on the reused chain. Fresh disposable Regtest keys were necessary because the old test script generated its miner keys only in memory. The new keys remain in ignored `var/`, never in public evidence. New blocks and mock time were used only in this isolated Regtest environment. The node was stopped after verification.

Current generic compiler SHA-256: `3894dbf28725ca6c74dff59591a74521a5e00b1f0a9f26da42c6b680f707fcb9`. Redacted receipts, scripts, amounts, output indexes, block hashes and rejection messages are in [generic-covenants-regtest.json](evidence/generic-covenants-regtest.json). Regtest TXIDs are not public Chipnet explorer records.

## Newly confirmed transactions

All ten nominal covenant spends have at least one mined confirmation. Funding paid a 1,200-sat miner fee; the Development spend paid 1,000 sats; tranche spends paid the explicitly committed 800-sat reserve. No fees are fabricated from estimates.

| Operation | Regtest TXID | Confirmations at observation | Fee (sats) |
| --- | --- | ---: | ---: |
| Funding missing generic treasury profiles | dd56f6974e1bebaa882f1691dd5ae779ba843af4101504c1be625c3aa0afc6b0 | 1 | 1200 |
| development-2of3 | c72ed378982bedb702df15bf8e521de20784bc81e5136fd12e2789d63e5b2a6c | 1 | 1000 |
| battle-opponent-wins | b00422f583afd16769ff2eaf0e5ba8f69944dad529d426e892df5797163afb55 | 1 | 800 |
| battle-return | 2e3430e9d0243148a7589b88fa734ec21a51d1116acef8432a587d03e61ff2d2 | 1 | 800 |
| kingdom-capped-capture | 62cd9d45d79d5865c2617289649e909ced82797f90d976932b994fb3ec9ab2a6 | 1 | 800 |
| territory-opponent-wins | 00ad2dd90d54bf3e7db9d4372c36b928538763a4a9912e4f6a56b7d811822572 | 1 | 800 |
| season-prize-claim | d0b5e1c1d817a3edca00a5728ff0dbcc567bd288998b7bd2de991962e4ebbf2d | 1 | 800 |
| battle-owner-refund | 7695c85b9de94e8a1026444dc6ee101e7341a4b2d9499e28039da7a40c52a4c2 | 1 | 800 |
| battle-misfunded-refund | dea6ea9fa83fb1dd007e3291ed4c9e56185d2fea0781d79b6d9e6e63a94e835e | 1 | 800 |
| territory-uncontested-return | 7ad50ba2d3e0bd44c3b3c65af02b93b8b03c30acc3abce5056ddc3ec6735cfdd | 1 | 800 |
| season-prize-rollover | 6154040b8d603f3f76699a84898e4e072d6e14bf95fa2ee437a194aaa153a30c | 1 | 800 |

The separate underfunding probe funded the **same already-tested expired battle covenant**, not a new descriptor: `5d25c98a403bce5e6a6ccde166548af55dfffb50bf8cce3cec4fe865b48cb884:0`, 576 sats, 12 confirmations at observation, block `61be8b01a9e1e461be2d2171687f357b70f4e52be81fece44cea9087399cb6cc`. The 576 sats remain unspent and are below the contract's fixed 800-sat reserve. This is an intentionally documented Regtest failure, not an unexecuted test marked complete.

## Negative and recovery checks

| Check | Actual BCHN response |
| --- | --- |
| Development outsider cannot replace second council key | 16: mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation) |
| Forged second battle attestor rejected | 16: mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation) |
| Even valid attestors cannot redirect committed outcome | 16: mandatory-script-verify-flag-failed (Script failed an OP_EQUALVERIFY operation) |
| Owner recovery before absolute locktime rejected | 64: bad-txns-nonfinal |
| Uncontested return before closure rejected | 64: bad-txns-nonfinal |
| Prize rollover before deadline rejected | 64: bad-txns-nonfinal |
| A second confirmed prize claim cannot spend its consumed outpoint | 18: txn-already-known |

The final row submits exactly the already-confirmed prize bytes and receives `txn-already-known`; it proves duplicate handling, not a distinct competing-spend scenario. Ordinary UTXO consumption was checked with `gettxout == null` after all successful spends. The prior VM suite also tests a claim/rollover pair against a consumed-outpoint fixture; do not promote that fixture alone to a separate real competing-spend test.

For the underfunded output, the supplied recovery planner rejects the negative refund quantity. A zero-valued P2PKH candidate is rejected by node dust policy, while an independently owner-signed, non-dust 546-sat candidate fails the current BCH VM's verify operation. The structural failure is the immutable equation `refund = observed value - reserve`: a valid nonnegative output cannot equal -224 sats, and the script forbids adding a second input to supply fees.

## Trust, signer and deadline limits

- Development's two-of-three authorization protects against a single independent key; it does not establish that the keys are held by different people or enforce an application council vote.
- Opposed generic settlements require both attestors and exact committed outputs. The attestor helper verifies a reproducible archived raid and matches supplied admission identifiers/outpoints. Attestors must independently establish that the admission and funding are legitimate. BCH consensus does not execute the game engine or verify standings.
- Current live kingdom, territory and season outputs remain spendable by the operation's server signer. UI approval and receipt verification protect application workflows; they do not bind a compromised custodian to application accounting. A confirmed journal credit is not itself a payer-only recovery right.
- Political timeout recovery is payer-signed and independent of the operator for correctly funded outputs. It still requires the claimant to retain the descriptor, outpoint, key and adequate fee conditions.
- A generic prize claim remains valid after the rollover timestamp until the same UTXO is spent. Rollover opens a competing fixed destination; it does not invalidate a previously authorized claim. This race is documented behavior, not a newly discovered unauthorized payout.
- Generic refunds fix one input, fixed reserve and destination; fee sponsorship or a higher miner fee cannot simply be appended. Current 1-sat/byte spends passed, but relay policy and future fee pressure are separate risks. A claimant-controlled output may support CPFP only if the parent is accepted under available node policy.
- Compiling a descriptor with `network: mainnet` is rejected; the scripts themselves are consensus bytecode and do not encode a network identity. Network verification must remain at the transport/wallet boundary. No Mainnet operation was performed.

## Findings and recommendations

This workstream contributes **0 Blocker, 0 Critical, 1 High, 2 Medium, 0 Low** findings. Counts for the complete audit are in [ALL_FINDINGS.md](ALL_FINDINGS.md). Full machine-readable records and exact evidence references are in [contracts-findings.json](evidence/contracts-findings.json).

### BC-CON-01 — High: Most current game treasuries and competitive escrows still require the operator key

**FAIL.** Operator-key loss or refusal prevents ordinary kingdom/season/territory withdrawals; compromise of that key can spend its controlled outputs without enforcing application balances or battle/season results on-chain.

**Evidence:** packages/chain-observer/index.mjs:116, packages/chain-observer/index.mjs:172, packages/chain-observer/index.mjs:213, packages/chain-observer/index.mjs:219, docs/TREASURY_COVENANTS.md.

**Reproduce:** Inspect createIntent destinations, preparePayout sources, and signPayout. They use operator-derived scripts and treasuryPrivateKey. The current game routes do not instantiate the new battle/kingdom/territory/season-prize covenant descriptors. Starting without the settlement signer disables those checkout/payout paths.

**Cause:** The application continues its existing custodial ledger while the independently compiled covenant profiles remain owner-tool templates.

**Recommended future fix:** Before accepting real player funds under a covenant-custody promise, integrate funding descriptors, independent attestations, spend discovery, reservations, claim/recovery distribution, and migration of legacy liabilities. Keep the current custodial disclosure explicit until that work is independently audited.

**Scope:** Previously documented trust dependency, still applicable to current code; no demonstrated remote unauthenticated drain. Optional external/2-of-3 Development and the existing political escrow are exceptions. Configuring external Development currently blocks paid political proof and classic competitive operations needing the operator Development reserve.

### BC-CON-02 — Medium: Small underfunding of a generic treasury covenant is irrecoverable

**FAIL.** A standard 576-satoshi P2SH32 payment below the fixed refund reserve becomes permanently unspendable under the available covenant branches, even after the timeout and with the correct owner key.

**Evidence:** packages/chain-observer/treasury-covenants.mjs:50, packages/chain-observer/treasury-covenants.mjs:105, packages/chain-observer/treasury-covenants.mjs:109, packages/chain-observer/treasury-covenants.mjs:111, packages/chain-observer/treasury-covenants.mjs:140, docs/audit/blockchain/evidence/generic-covenants-regtest.json:underfundedRecovery.

**Reproduce:** On reused BCHN Regtest, pay 576 sats to an already-tested expired battle-escrow P2SH32 descriptor with principal 20,000 and reserve 800. The node mines the funding output. Normal settlement requires exactly 20,800 sats; refund requires one output equal to 576-800=-224 sats and allows only one input. The planner refuses it; a properly signed non-dust refund candidate fails the BCH VM. The actual zero-output candidate is separately rejected by node dust policy. The funded outpoint remains unspent.

**Cause:** Refund value subtracts the full fixed reserve regardless of observed funding, while the covenant forbids an added fee-sponsor input and fixes the refund output count/destination.

**Recommended future fix:** Design and audit a recovery branch for every standard fundable amount, including additional fee sponsorship or an explicitly bounded alternative recovery transaction. Enforce exact payment in clients and observers, but do not rely on those checks to prevent unsolicited on-chain underpayments.

**Scope:** Confirmed Regtest funding loss in a not-yet-integrated generic template. Production game custody currently uses different scripts. The same fixed-fee design also needs policy/fee-raising review before deployment.

### BC-CON-03 — Medium: Political escrow recovery tools reject mismatched funding amounts

**FAIL.** An expired political escrow funded with an incorrect amount cannot be recovered through the supplied payer-refund tooling. Overpayment cannot be returned as extra principal by the existing fixed-principal script; a custom spend would send excess value to fees unless additional policy is designed.

**Evidence:** packages/chain-observer/political-escrow.mjs:28, packages/chain-observer/political-escrow.mjs:46, packages/chain-observer/political-escrow.mjs:55, scripts/political-escrow-refund.mjs:14, docs/audit/blockchain/evidence/political-misfunding-probe.json.

**Reproduce:** Issue a descriptor, then call the unchanged payer-refund planner with matching script/key but funding equal to the quoted value minus 1, plus 1, or plus 120 sats. Every call rejects with the exact-source error. The public CLI also filters the observed output by exact quoted value before constructing the refund.

**Cause:** The helper and CLI require exact principal+650 funding in both settlement and timeout recovery. The script itself has a fixed principal output and zero-value second output.

**Recommended future fix:** Specify supported recovery for under/overpayments and implement audited tooling for those cases, preserving actual funding proofs and avoiding accidental excess fees. Do not silently credit an invalid payment to the game.

**Scope:** Source review plus newly executed offline planner probes; no fresh political funding was created solely to repeat earlier valid refund tests. Correctly funded political refunds remain previously verified.

## Readiness

Nominal generic contract spends have advanced from VM-only coverage to real Regtest execution, and historical political contracts remain applicable and confirmed on their existing chain. Current full-game covenant integration, independent outcome authorization, misfunding recovery and production operational availability remain incomplete. Generic profiles were not funded on Chipnet in this workstream; their real Regtest success must not be labeled full connected Chipnet parity or Mainnet readiness. No source changes, production keys, Mainnet transactions, deployment or Git publication occurred.
