# VaultBorn BCH blockchain and smart-contract audit

Audit started 18 November 2026. **Audit and report only: no implementation changes.** The selected new live lifecycles are now confirmed.

**Mainnet readiness: NO.** Mainnet is explicitly disabled. The current game's Kingdom, prize and most competitive funds are still governed by an operator signer and authoritative game state. Successfully compiling or spending a generic covenant does not integrate it into the application or remove that trust. Two High findings and several recovery/coverage gaps remain. No production keys/funds, deployment, Git push or submission were used.

## Findings and report map

| Blocker | Critical | High | Medium | Low |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 2 | 5 | 1 |

These are unique findings, not duplicate counts from each workstream. No remote unauthorized drain was demonstrated. A zero Critical count is not a certification of safety.

- [All findings, reproduction and prioritized recommendations](ALL_FINDINGS.md)
- [Contracts, signers, consensus execution and recovery](CONTRACTS_AND_SECURITY.md)
- [Transactions, allocations, wallets and financial accounting](TRANSACTIONS_AND_ECONOMY.md)
- [CashTokens, political escrow and seasonal rewards](TOKENS_ESCROW_AND_REWARDS.md)
- [Actual chain evidence, fees, addresses and TXIDs](CHIPNET_EVIDENCE.md)

## Scope, reuse and provenance

Existing reports, contract artifacts, disposable wallet setups, test source and live receipts were inspected first. The audit indexed 15 prior public-evidence artifacts, refreshed **46** historical Chipnet transactions, rechecked current token/authority outpoints, and reused the existing political Regtest chain and application save. It did not rerun the entire already passing 134-test suite or replay historical successful payments, mints, transfers and refunds without a gap.

Current source was fingerprinted before new tests: **90 implementation/configuration files remain byte-identical** at report generation. [Baseline](evidence/implementation-baseline.json) · [unchanged-source check](evidence/implementation-unchanged.json). New drivers, private contexts and test keys stay under ignored var/; audit documentation and public redacted evidence are under this directory. Existing runtime/publication data and the production game save were not changed by this audit.

The prior official Selene test's recorded game hashes match the current source. That supports its connection/consent/reload/disconnect result only; its mock balance and no-payment scope were not promoted to real payment evidence. The newly executed Selene payment is separately documented.

## Architecture and trust

The illustrated browser creates authenticated HTTP intents and uses WizardConnect for wallet approval. The backend verifies exact signed bytes, sources, outputs and VM signatures before broadcast. Native Chipnet observations drive the SQLite payment journal; the game changes only on accepted confirmation/fulfillment. BCH/Nostr proof authentication signs messages and does not transfer BCH.

Funding outputs separate Development, prizes, personal deposits, Kingdom allocations and competitive principal/reserves. SQLite reservations and retained signed transactions prevent uncoordinated repeat payouts across restarts. Current battle/territory outcomes and rankings remain off-chain game decisions; the main live payout paths spend operator-controlled scripts. The political compensation covenant has real constrained release/timed-payer recovery. Optional external/2-of-3 Development custody and generic battle/Kingdom/territory/prize templates are distinct from the normal operator-signing lanes.

The Electrum observer checks a fixed Chipnet checkpoint and Merkle inclusion but relies on its TLS indexer for post-checkpoint headers and active-chain view. It does not validate accumulated work and all header links locally. BCHN RPC delegates validation to the configured node. This trust boundary is disclosed; the blocked adversarial simulation is not presented as an executed attack.

## Connected feature-parity matrix

| Feature or lifecycle | Status | Evidence and boundary |
| --- | --- | --- |
| Selene connection, consent, disconnect, reload and Chipnet detection | PREVIOUSLY VERIFIED | Prior pinned official web release hashes match current code. Wrong-network SDK fixture also tested. Public relays and physical devices are separate gaps. |
| Actual Selene premium approval/signature/broadcast/confirmation/entitlement | PASS | Actual Vault premium, 4,500 + 500 wallet fee; current v2 outputs, 3 recorded confirmations. Local relay bridge, real public Chipnet backend. |
| BCH/Nostr sign-in, linking, recovery, one-use nonce and stale-session behavior | PREVIOUSLY VERIFIED | Existing signed-message, independent compact-signature fixture, dual/private Nostr and SQLite restart/browser recovery tests; no signature is a payment or fee. Current live fixture also restored p1 through a real BCH challenge. |
| Current 20/80 sponsor funding | PASS | Real 8,000-sat current split and automatic backend credit. |
| Current raid principal → actual battle → settlement | PASS | 3,000 principal + 600 reserve, authoritative attacker win, separate confirmed 3,000-sat settlement. Actual committed-defender capture/defending-win branches remain locally verified, not fresh live cases here. |
| Current sole territorial claim → land result → principal return | PASS | East Meadow awarded to p1, then a separate 2,000-sat return and 600 fee. Game clock accelerated only after intakes confirmed. |
| Current Kingdom withdrawal to verified wallet | PASS | Actual 1,200 payout + 356 fee; operator signer required. |
| Current sponsor/prize pool → two eligible archived scores → claim | PASS | Actual game construction/scoring, archived season, verified destination, fixed quoted amount, wrong-address/duplicate rejection, real payout. Clock was accelerated only in this existing isolated fixture. |
| Personal deposits/withdrawals and historical rush | PREVIOUSLY VERIFIED | Real historical receipts rechecked; unchanged personal lane and timer semantics. Do not infer current complete UI testing for every service from those old prices. |
| Burn and exact receipts | PASS for new premium; PREVIOUSLY VERIFIED for older policies | Actual new 225-sat unspendable output. Current small services still fail the strict 20/10/5/65 claim because of dust adjustment. |
| Native CashTokens issuance, immutable transfer and current ownership | PREVIOUSLY VERIFIED + PASS current reads | Seven existing collectibles and three authorities; no new mint/transfer was needed. No token ownership confers game-command rights. |
| Political compensation release and timed recovery | PREVIOUSLY VERIFIED | Current scripts match historical descriptors; actual Chipnet release and both Regtest refund lanes remain applicable. Read-only refund recognition and misfund tooling have findings. |
| Generic Development/Kingdom/battle/territory/prize covenant spends | PASS on Regtest; NOT TESTED as full connected Chipnet game lanes | Ten new consensus spends fill the prior VM-only gap. The generic profiles are not integrated into current live pools. A confirmed low-value underpayment is irrecoverable in its template. |
| Current paid-recon, protectorate and political-service complete live client paths | NOT TESTED | Source/local checks and historical evidence exist; no fresh current-policy full-client proof is claimed. |
| Current contested-territory and rare-draw complete live paths | NOT TESTED | Older actual draw/conquest/expiry evidence remains historical; current pricing/principal policy differs. No unnecessary new 36-block draw was funded. |
| Individual political-charter NFT mint on Chipnet | NOT TESTED | Existing political authority genesis and current baton verified; Regtest issuing/shared token mechanics do not prove this individual live application mint. |
| Independently secured DAO custody and autonomous winner attestation | FAIL / not integrated | The application council and generic templates do not transfer current pool signing authority away from the operator. |
| Public-relay/device/history service and real reorganization/disaster recovery | NOT TESTED | Bridge/fixture and synthetic retry/reorg evidence are not these production cases. |

## Newly executed work

Fresh read-only public evidence; actual Selene premium; current sponsor/raid/claim/withdrawal/reward flows; ten missing generic Regtest spends; targeted local negative probes for percentage/dust behavior, scheduler fairness, rejected payout reservations, independent-refund observation, and long NFT history boundaries. Synthetic fixtures are not included as public chain receipts. Known successful old flows and the whole unit suite were not repeated merely for a new test count.

## Remaining failures and security posture

The High issues are current operator custody/incomplete constrained-covenant integration and automatic reconciliation starvation. Medium issues cover strict low-price allocation, rejected payout recovery, generic low-value recovery, political misfunding tools and refund recognition without a signer. Bounded NFT ownership resolution is Low. See the consolidated report for exact locations, impact, evidence, reproduction and future recommendations.

A proposed adversarial indexer simulation was rejected by automated safety review. It is **NOT TESTED** and was not rerun. Its source-level trust boundary is recorded separately. This report does not assert that signatures, compilation, a mempool entry or a mock establish confirmed game fulfillment.

Before considering Mainnet, resolve the documented custody/recovery and scheduling issues, define a truthful dust/allocation promise, integrate and audit any advertised independent recovery/attestation paths, complete the remaining client/current-policy cases, and establish operational chain validation and recovery evidence. These are recommendations only; this audit made no fixes or release/deployment changes.
