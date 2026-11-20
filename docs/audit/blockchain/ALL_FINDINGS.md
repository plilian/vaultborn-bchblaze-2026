# All blockchain findings

> **Dated report (18 November 2026),** written before the Mainnet launch. Its findings are kept as they were written; its statements about what had not yet run, and about Mainnet readiness, describe that day. VaultBorn has since gone live on Bitcoin Cash Mainnet, with wallet-signed payments and a contract settlement signed by the attestors. Current state and evidence: [STATUS.md](../../STATUS.md) · [MAINNET_TRANSACTIONS.md](../../MAINNET_TRANSACTIONS.md).

Audit date: 18 November 2026. These are audit findings and recommendations; no implementation was fixed. A finding supported by source or an isolated negative test is not presented as a successful real-world exploit. Read the evidence scope for each entry.

| Severity | Count |
| --- | ---: |
| Blocker | 0 |
| Critical | 0 |
| High | 2 |
| Medium | 5 |
| Low | 1 |

The counts are unique issues, not duplicated mentions across reports. The recorded limitations in Mainnet readiness and unexecuted tests are not additional exploit findings. No unapproved transfer from a production wallet was attempted or demonstrated.

## BC-CON-01 — High: Most current game treasuries and competitive escrows still require the operator key

**Status:** FAIL.

**Impact:** Operator-key loss or refusal prevents ordinary kingdom/season/territory withdrawals; compromise of that key can spend its controlled outputs without enforcing application balances or battle/season results on-chain.

**Location:** `packages/chain-observer/index.mjs:116`, `packages/chain-observer/index.mjs:172`, `packages/chain-observer/index.mjs:213`, `packages/chain-observer/index.mjs:219`.

**Evidence:** `packages/chain-observer/index.mjs:116`, `packages/chain-observer/index.mjs:172`, `packages/chain-observer/index.mjs:213`, `packages/chain-observer/index.mjs:219`, `docs/TREASURY_COVENANTS.md`.

**Reproduction:** Inspect createIntent destinations, preparePayout sources, and signPayout. They use operator-derived scripts and treasuryPrivateKey. The current game routes do not instantiate the new battle/kingdom/territory/season-prize covenant descriptors. Starting without the settlement signer disables those checkout/payout paths.

**Cause:** The application continues its existing custodial ledger while the independently compiled covenant profiles remain owner-tool templates.

**Recommended future fix:** Before accepting real player funds under a covenant-custody promise, integrate funding descriptors, independent attestations, spend discovery, reservations, claim/recovery distribution, and migration of legacy liabilities. Keep the current custodial disclosure explicit until that work is independently audited.

**Applicability:** Previously documented trust dependency, still applicable to current code; no demonstrated remote unauthenticated drain. Optional external/2-of-3 Development and the existing political escrow are exceptions. Configuring external Development currently blocks paid political proof and classic competitive operations needing the operator Development reserve.

## BC-CON-02 — Medium: Small underfunding of a generic treasury covenant is irrecoverable

**Status:** FAIL.

**Impact:** A standard 576-satoshi P2SH32 payment below the fixed refund reserve becomes permanently unspendable under the available covenant branches, even after the timeout and with the correct owner key.

**Location:** `packages/chain-observer/treasury-covenants.mjs:50`, `packages/chain-observer/treasury-covenants.mjs:105`, `packages/chain-observer/treasury-covenants.mjs:109`, `packages/chain-observer/treasury-covenants.mjs:111`, `packages/chain-observer/treasury-covenants.mjs:140`.

**Evidence:** `packages/chain-observer/treasury-covenants.mjs:50`, `packages/chain-observer/treasury-covenants.mjs:105`, `packages/chain-observer/treasury-covenants.mjs:109`, `packages/chain-observer/treasury-covenants.mjs:111`, `packages/chain-observer/treasury-covenants.mjs:140`, `docs/audit/blockchain/evidence/generic-covenants-regtest.json:underfundedRecovery`.

**Reproduction:** On reused BCHN Regtest, pay 576 sats to an already-tested expired battle-escrow P2SH32 descriptor with principal 20,000 and reserve 800. The node mines the funding output. Normal settlement requires exactly 20,800 sats; refund requires one output equal to 576-800=-224 sats and allows only one input. The planner refuses it; a properly signed non-dust refund candidate fails the BCH VM. The actual zero-output candidate is separately rejected by node dust policy. The funded outpoint remains unspent.

**Cause:** Refund value subtracts the full fixed reserve regardless of observed funding, while the covenant forbids an added fee-sponsor input and fixes the refund output count/destination.

**Recommended future fix:** Design and audit a recovery branch for every standard fundable amount, including additional fee sponsorship or an explicitly bounded alternative recovery transaction. Enforce exact payment in clients and observers, but do not rely on those checks to prevent unsolicited on-chain underpayments.

**Applicability:** Confirmed Regtest funding loss in a not-yet-integrated generic template. Production game custody currently uses different scripts. The same fixed-fee design also needs policy/fee-raising review before deployment.

## BC-CON-03 — Medium: Political escrow recovery tools reject mismatched funding amounts

**Status:** FAIL.

**Impact:** An expired political escrow funded with an incorrect amount cannot be recovered through the supplied payer-refund tooling. Overpayment cannot be returned as extra principal by the existing fixed-principal script; a custom spend would send excess value to fees unless additional policy is designed.

**Location:** `packages/chain-observer/political-escrow.mjs:28`, `packages/chain-observer/political-escrow.mjs:46`, `packages/chain-observer/political-escrow.mjs:55`, `scripts/political-escrow-refund.mjs:14`.

**Evidence:** `packages/chain-observer/political-escrow.mjs:28`, `packages/chain-observer/political-escrow.mjs:46`, `packages/chain-observer/political-escrow.mjs:55`, `scripts/political-escrow-refund.mjs:14`, `docs/audit/blockchain/evidence/political-misfunding-probe.json`.

**Reproduction:** Issue a descriptor, then call the unchanged payer-refund planner with matching script/key but funding equal to the quoted value minus 1, plus 1, or plus 120 sats. Every call rejects with the exact-source error. The public CLI also filters the observed output by exact quoted value before constructing the refund.

**Cause:** The helper and CLI require exact principal+650 funding in both settlement and timeout recovery. The script itself has a fixed principal output and zero-value second output.

**Recommended future fix:** Specify supported recovery for under/overpayments and implement audited tooling for those cases, preserving actual funding proofs and avoiding accidental excess fees. Do not silently credit an invalid payment to the game.

**Applicability:** Source review plus newly executed offline planner probes; no fresh political funding was created solely to repeat earlier valid refund tests. Correctly funded political refunds remain previously verified.

## BC-PAY-01 — Medium: Low-price services do not preserve strict 20/10/5/65 allocation

**Status:** FAIL.

**Impact:** A larger prize output reduces the advertised Kingdom percentage at low service prices.

**Location:** `config/payments.mjs:44`.

**Evidence:** `docs/audit/blockchain/evidence/payments-gap-probes.json`.

**Reproduction:** Compare paymentAllocation for current-policy services at 4,000, 4,500, 6,000 and 24,000 sats against the strict stated percentages. Existing audit probe records the exact returned amounts without a chain transfer.

**Cause:** A 546-sat prize-output floor is deducted from the residual Kingdom share.

**Recommended future fix:** Choose a conforming price/output policy and align published percentages before accepting funds under that promise.

## BC-PAY-02 — High: Newest-first reconciliation can indefinitely delay older funded operations

**Status:** FAIL.

**Impact:** New unpaid rows can prevent automatic observations and credit for older submitted or funded financial actions.

**Location:** `apps/game-server/ledger.mjs:525`.

**Evidence:** `docs/audit/blockchain/evidence/payments-gap-probes.json`.

**Reproduction:** The isolated benign probe places one submitted synthetic deposit behind 64 newer unpaid rows, performs ten reconciliation cycles, and observes no lookup/credit for that deposit until the newer quotes expire. No public service was flooded.

**Cause:** A newest-first candidate list is cut to 64 rows without a persisted fair cursor or funded-operation priority.

**Recommended future fix:** Implement fair bounded scheduling and funded-operation priority with per-account quote quotas and owner retries.

## BC-PAY-03 — Medium: Permanently rejected signed payouts retain reservations without recovery

**Status:** FAIL.

**Impact:** A signed but never accepted payout can hold the full selected inputs unavailable indefinitely.

**Location:** `apps/game-server/ledger.mjs:22`, `apps/game-server/ledger.mjs:371`, `apps/game-server/ledger.mjs:404`, `apps/game-server/ledger.mjs:525`.

**Evidence:** `docs/audit/blockchain/evidence/payments-gap-probes.json`.

**Reproduction:** The isolated probe supplies a permanent synthetic broadcast rejection for a consented payout, advances seven fixture days, and checks the retained submitted state, reserved input balance and rejected later request. No invalid transaction was sent to a network.

**Cause:** Raw signed bytes keep source reservations alive, repeated broadcast errors are suppressed, and the pending-payout guard has no conflict-aware terminal recovery operation.

**Recommended future fix:** Add safe durable rejection/conflict/replacement recovery; never unlock potentially live signed inputs solely by timeout.

## TR-01 — Medium: Independent political returns are not recognized without the operator signer

**Status:** FAIL.

**Impact:** Read-only deployments leave matured escrow/treaty records and locked balance stale despite a payer's independent confirmed refund; BCH itself can still be recovered.

**Location:** `apps/game-server/politics-protocol.mjs:113`, `apps/game-server/ledger.mjs:538`.

**Evidence:** `docs/audit/blockchain/evidence/tokens-gap-results.json`.

**Reproduction:** Run node var/audit-blockchain/tokens-audit.mjs. With payoutsEnabled:false, reconcile never calls the available refund observer and retains funded status.

**Cause:** A private-signer guard precedes read-only confirmed-spend observation.

**Recommended future fix:** Separate observation/reconciliation from signing availability and add a read-only restart integration test.

## TR-02 — Low: Valid NFT ownership becomes unresolved at traversal and address-history bounds

**Status:** FAIL.

**Impact:** Current-holder queries can stop resolving valid transferable proof collectibles; token spendability and off-chain game control are unaffected.

**Location:** `packages/chain-observer/territory-token.mjs:198`, `packages/chain-observer/territory-token.mjs:205`, `packages/chain-observer/territory-token.mjs:230`.

**Evidence:** `docs/audit/blockchain/evidence/tokens-gap-results.json`.

**Reproduction:** Run node var/audit-blockchain/tokens-audit.mjs. Fifteen valid synthetic transfers resolve; sixteen return traversal-limit. A spender after 256 unrelated history entries is not reached.

**Cause:** Fixed traversal/history bounds without continuation or a persisted verified head.

**Recommended future fix:** Use bounded continuation/pagination with a verified outpoint checkpoint; retain uncertainty when unverified.

## Prioritized work after this audit

1. Keep actual custody and operator authority explicit. Integrate independently constrained recovery/outcome mechanisms before representing the existing game pools as user-recoverable covenants. Independently audit that integration and legacy liability migration.
2. Restore fairness and bounded progress for funded financial observations. Design safe rejected/conflicted payout recovery while preserving signed-transaction and exact-outpoint safety.
3. Resolve strict-percentage/dust policy, fixed-reserve underpayments, and political misfunding tooling before new commitments relying on those promises.
4. Separate refund observation from signer availability, and provide verified continuation for long NFT histories.
5. Complete the specifically unverified client, current-policy, and production-operational cases listed in the master report. Maintain Chipnet and Regtest separation; no Mainnet readiness is asserted.

## Unexecuted adversarial indexer case

A proposed adversarial indexer simulation was blocked by automatic safety review and was not rerun. The report records that the current TLS Electrum indexer supplies the post-checkpoint headers and active-chain view without local header-chain work validation. This is a source-reviewed trust dependency, not a claimed executed forged-chain attack or an additional counted exploit.

See [master audit](MASTER_AUDIT.md), [contracts](CONTRACTS_AND_SECURITY.md), [transactions](TRANSACTIONS_AND_ECONOMY.md), [tokens and rewards](TOKENS_ESCROW_AND_REWARDS.md), and [chain evidence](CHIPNET_EVIDENCE.md).
