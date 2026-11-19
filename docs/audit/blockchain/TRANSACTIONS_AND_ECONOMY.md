# Transactions, wallets, and economic accounting

Audit date: 18 November 2026. Audit and report only. No implementation or economic parameter was changed. Statuses distinguish a current check from historical evidence with narrower applicability. Live tests still in progress are not passes.

## Version and evidence applicability

Current application defaults are `separate-stake-v2`, `sponsor-split-v1`, and `season-rollover-v1`. The original BCH Dominion single-output payments and later `classic-v1` four-output payments remain valid historical transactions. They do not prove the current amounts, allocations, two-participant prize gate, or new rollover policy.

All **46** indexed historical Chipnet transactions were freshly observed with the current network checkpoint, transaction decoding, Merkle inclusion checks, exact recorded block hashes, and applicable recorded fees. See [the read-only verification](evidence/chipnet-reverification.json). Two observations initially failed when a long-lived client's height estimate diverged from a later verbose response; both passed through fresh connections. Those initial errors remain in the evidence. This result proves inclusion as reported by the configured TLS indexer, not independent verification of accumulated header-chain work.

The previous official Selene web-release pairing result records game JavaScript hashes that match the current implementation. Its connection, consent, reload, and disconnect evidence is **PREVIOUSLY VERIFIED**. That earlier run used mocked balances and a local transport bridge and did not sign a payment. Current actual-payment evidence is recorded separately, not inferred from the pairing test.

## Financial rules

| Rule | Result | Evidence and limits |
| --- | --- | --- |
| Service nominal 20% Development / 10% prizes / 5% burn / 65% Kingdom | **FAIL for low-priced services; PASS for tested higher prices** | `config/payments.mjs:44` promotes the prize output to 546 sats and subtracts the difference from Kingdom. Exact examples below and [new local probes](evidence/payments-gap-probes.json). This is an existing documented dust rule, not a new audit change. |
| Sponsorship 20% Development / 80% prizes | **PASS on current Chipnet flow; PREVIOUSLY VERIFIED for local bounds** | The new 8,000-sat payment has confirmed 1,600 Development and 6,400 prize outputs. Integer division requires multiples of five. Standard minimum 2,730; a 576-sat Development-script dust threshold raises it to 2,880. The existing suite checks all 49,455 allowed standard amounts, external custody, wrong outputs and duplicate credit. |
| Competitive principal entirely into escrow | **PASS for current live raid and sole claim; other branches locally verified** | New raid: 3,000 principal + 600 reserve, actual win, confirmed 3,000-sat settlement. New sole claim: 2,000 + 600, land result and confirmed full principal return. Territory attack and rare entry retain their local and historical applicability limits. Actual application settlement remains operator-signed. |
| Burn is genuinely unspendable | **PASS on current premium; PREVIOUSLY VERIFIED for older policies** | New actual Selene payment has a confirmed 225-sat `OP_RETURN` output. Value-bearing `OP_RETURN` starts with `0x6a`; a zero-value event commitment alone is not counted as BCH burn. |
| Conservation and duplicate allocation | **PREVIOUSLY VERIFIED locally** | Allocation sums, reserved outpoints, exact decoded outputs, a unique TXID column, command idempotency, and compare-before-observation updates. Public-chain evidence is per flow; a passing mocked test is not a chain receipt. |

| Service total | Development | Prize | Burn | Kingdom | Strict requested ratio |
| ---: | ---: | ---: | ---: | ---: | --- |
| 4,000 | 800 | 546 | 200 | 2,454 | FAIL: prize 13.65%, Kingdom 61.35% |
| 4,500 | 900 | 546 | 225 | 2,829 | FAIL: prize 12.1333%, Kingdom 62.8667% |
| 6,000 | 1,200 | 600 | 300 | 3,900 | PASS |
| 24,000 | 4,800 | 2,400 | 1,200 | 15,600 | PASS |

Amounts are satoshis, excluding the wallet network fee. No output is rounded into additional money. Sponsorship 8,000 divides exactly into 1,600 and 6,400. Changing the configured Development script can change the effective dust minimum; it cannot retroactively change a committed intent.

## Every transaction route

| Application route or action | Current mechanism | Existing evidence and current gap |
| --- | --- | --- |
| `premium` | Wallet signs four exact service outputs; ordinary confirmation gate; server applies one entitlement | Historical real Hall/Scout/Vault improvements and old WizardConnect payment; current-policy actual Selene Vault test is separately journaled. |
| `rush` | Same payment lane, normal cap, 50% timer reduction or one saved rush credit | Real historical rush, unchanged gameplay rule; current 4,000-sat dust-adjusted allocation has local evidence. No needless repeat solely to redo its timer. |
| `espionage-paid` | 4,000-sat service; normal mission capacity, supply and target requirements still apply | Source and existing local coverage; no specifically recorded current live paid-recon receipt. **NOT TESTED end to end on current Chipnet.** |
| `protectorate` | 24,000-sat current service; backend eligibility and response/expiry process | Original 24,000 single-output and later older-policy operations are historical, not current split proof. Current complete connected flow remains **NOT TESTED** unless linked to a current receipt. |
| `attack-paid` | 3,000 principal + 600 reserve; recorded eligible battle and subsequent settlement | Classic real paid attack/anchor reverified. Current v2 intake and settlement are a new targeted live test. |
| `territory-claim` | 2,000 principal + 600 reserve, entry cohort, closure and settlement | Historical claim/conquest/return reverified. Current v2 sole-claim test is a new targeted live test. |
| `territory-attack` | 3,000 principal + 600 reserve, eligibility and published result | Historical actual conquest plus current local checks. Current v2 complete intake/settlement remains **NOT TESTED**; no duplicate contest was opened just to repeat existing conquest math. |
| `territory-raffle` | 3,700 refundable principal + 1,500 reserve; future block and lease expiry | Historical real draw, return and expiry reverified. Current v2 amount and fully refundable intake policy have local evidence, not a fresh complete 36-block live draw in this audit. |
| `political-operation` and charter proof | Service funding and separately recorded disclosure/outcome anchor | Real political payment and attestation remain verified as historical evidence; its old allocation cannot certify today's service percentages. External Development can intentionally disable new app-funded proof operations. |
| `political-escrow` | Fixed-principal release or timed payer refund covenant | Current source recompiled byte-identically against historical descriptors; release confirmed on Chipnet and both refund lanes previously exercised on Regtest. No redundant funding/refund. See the contract and token reports. |
| `vault-deposit` | Explicit personal deposit, no raid exposure | Historical real 8,000-sat deposit reverified; the personal lane is not taxed by service allocations. |
| `withdraw` | Operator signs selected personal-vault outpoints and change after consent | Historical real payout reverified. A new missing negative recovery probe exposes the stuck-payout issue below. |
| Kingdom commitment and `kingdom-withdraw` | Commitment is an off-chain risk authorization over verified Kingdom funds; withdrawal is a real operator-signed payout | Do not count commitment as a wallet transfer. Current live withdrawal coverage is recorded only when a confirmed receipt exists. |
| `sponsor-fund` and campaign contributions | Exact current 20/80 outputs; fees separate; confirmed campaign activation | Legacy single-output sponsorship does not prove the current split. Current 8,000-sat sponsorship is a targeted live test. |
| `claim` | Archived eligible rank, funded fixed award base, verified address, one payout, fee reserve and carry-forward | Real older-policy claims reverified; current two-participant/split/rollover connected claim is a targeted live test. Generic covenant vouchers are not used by this route. |
| DAO/council Development spend | Application-approved proposal; operator-key spend of available Development outputs | Application quorum/authorization tests exist; no independently secured DAO custody is implied. Configured external or 2-of-3 Development custody is a different lane. Current UI-to-chain DAO payout remains **NOT TESTED**. |
| CashTokens issuance and transfer | Segregated authority baton and immutable event outputs | Existing real mint, transfer and current ownership evidence applies; see [tokens, escrow and rewards](TOKENS_ESCROW_AND_REWARDS.md). A collectible transfer does not transfer game control. |

## Wallet approval, receipts, and failure handling

`wallet-checkout.mjs` binds the unsigned transaction fingerprint, complete ordered outputs, source amounts, derivation paths, fee, and expiry. The backend checks the returned transaction and its VM signatures before broadcasting its derived TXID. A separately supplied TXID does not establish payment. The observer checks exact native outputs, excludes token-bearing outputs for native amounts, and credits only after the configured confirmations. Historical receiving-address proof, replay and account recovery tests remain valid for unchanged code.

Native network handling is Chipnet-only: receiving-address parsing rejects Mainnet, and Electrum/BCHN transports check the fixed Chipnet checkpoint. Testnet4 shares address syntax and needs the checkpoint, not an address-prefix assumption. Physical-device and public-Nostr-relay operation are not inferred from the local Selene bridge. Actual Selene's independent balance/history service is outside a test in which those sockets are blocked.

The ledger preserves signed payout bytes and reservations through restarts and avoids issuing a second transaction after uncertain broadcast. That protects against accidental double spends but has no complete permanently rejected transaction recovery route. Reorganization detection quarantines affected financial operations; it does not establish automatic rollback of every applied game outcome.

## Findings

### BC-PAY-01 — Medium: Low-price service allocation contradicts the strict percentages

**FAIL.** The 546-sat prize floor reduces the Kingdom share for 4,000/4,500-sat services. The code conserves satoshis and the quote shows the actual outputs, but a strict 20/10/5/65 assertion is false. Reproduction, actual amounts, and source hashes are in `evidence/payments-gap-probes.json`; implementation is `config/payments.mjs:44`.

**Recommendation:** Decide and document a conforming price/output policy before promising those percentages. Audit that future change independently. No economic change was made here.

### BC-PAY-02 — High: Newest-first reconciliation can indefinitely delay older funded operations

**FAIL.** `apps/game-server/ledger.mjs:525` takes the newest 64 eligible rows without a rotating cursor or funded-first fairness. A new local probe retained a submitted, confirmed synthetic deposit behind 64 newer unpaid intents for ten reconciliation cycles: zero victim observations and zero credit until those quotes expired. This is an availability issue affecting deposits, action fulfillment, payouts and settlement visibility, not evidence of a theft.

Account and request limits increase the effort but do not provide scheduler fairness. Normal confirmation retries can remain delayed while a stream of newer unpaid rows is maintained. A knowledgeable account owner can submit a known TXID through the individual submit endpoint; the automatic receipt UI does not remove the global scheduling limitation.

**Recommendation:** Use bounded fair scheduling with priority/continuation for already submitted financial operations, quotas for unpaid intents, and an independently tested owner retry/recovery path.

### BC-PAY-03 — Medium: Permanently rejected signed payouts keep funds reserved without a recovery operation

**FAIL.** The new benign rejection probe retained a submitted signed payout for seven simulated days after every broadcast failed. A 10,000-sat input remained fully reserved; available personal balance was zero and a later withdrawal returned “You already have a pending payout.” No real rejection transaction was broadcast. `apps/game-server/ledger.mjs:22`, `:371`, `:404`, and `:525` retain the raw plan, reservations, retry state and pending guard.

Blindly clearing reservations would be unsafe because the signed transaction might later become valid or have been broadcast elsewhere. The missing operation needs proof of conflict/absence plus a safe replacement/cancellation policy, not a timeout-only reset.

**Recommendation:** Define durable rejected/conflicted payout recovery, status reporting and fee replacement with exact outpoint safety; test restart and late-observation behavior.

## Observer trust boundary

The current Electrum path checks a known header at height 302144 and verifies a transaction's Merkle inclusion against another header returned by the same TLS indexer. It does not link and validate all intervening headers, accumulated work, or an independently trusted current tip (`packages/chain-observer/transports.mjs:92`, `:125`, `:140`, `:160`). The optional BCHN RPC path delegates that work to the configured validating node.

This is a material Mainnet trust dependency and must be disclosed. An adversarial indexer simulation was **NOT TESTED** because automated safety review blocked that proposed test; it was not retried. No fabricated transaction or header is represented as chain evidence. Recommendations are to use an independently controlled validating node or an audited header-verification/independent observation design before claiming trust-minimized payment recognition.

## Current-policy live evidence

The selected new lifecycles are confirmed: actual Selene premium approval/payment/entitlement; exact 20/80 sponsorship; current raid and its stake settlement; sole claim and its full principal return; a 1,200-sat Kingdom withdrawal; and a 4,389-sat current-season payout. All game financial results required the real two-confirmation gate. Season-pool conservation was checked as 12,910 = 4,389 paid + 356 network fee + 8,165 remaining. Wrong destination and duplicate claims were rejected without another transfer.

See [current-policy journal](evidence/current-policy-chipnet.json), [actual Selene receipt](evidence/selene-live-chipnet.json), and [all new chain receipts](CHIPNET_EVIDENCE.md). A broadcast, mempool observation, unsigned quote, signature, or synthetic fixture assertion was not recorded as confirmed fulfillment. Per-route limits in the matrix above still apply; the selected successes do not establish every live failure branch or public/device wallet path.
