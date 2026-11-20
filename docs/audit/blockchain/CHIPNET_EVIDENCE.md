# Chipnet and Regtest evidence

> **Dated report (18 November 2026),** written before the Mainnet launch. Its findings are kept as they were written; its statements about what had not yet run, and about Mainnet readiness, describe that day. VaultBorn has since gone live on Bitcoin Cash Mainnet, with wallet-signed payments and a contract settlement signed by the attestors. Current state and evidence: [STATUS.md](../../STATUS.md) · [MAINNET_TRANSACTIONS.md](../../MAINNET_TRANSACTIONS.md).

Audit started 18 November 2026. Evidence timestamps are UTC. Status at this report generation: **planned targeted live lifecycles confirmed**. No Mainnet funds, production signers, deployment, Git push, or submission was used.

## Reused historical public transactions

**46/46 PASS** on fresh observation with the current transport and exact recorded hashes/fees where supplied. No historical payment, refund, mint, transfer or settled contract was replayed. See [full indexed evidence](evidence/prior-artifacts.json) and [fresh transaction observations](evidence/chipnet-reverification.json). Recorded confirmations increased naturally; old pricing and allocation policies remain old pricing and allocation policies.

The first long-lived observation encountered two inconsistent height estimates; fresh connections verified both transactions successfully. The previous attempts are retained, not erased or portrayed as successful first attempts. These checks use a trusted TLS indexer's checkpoint/header view and do not establish independently validated chain work.

## New public Chipnet operations

| Operation | Satoshis | Network fee | Height | Recorded confirmations | Status | Actual TXID |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Disposable actual Selene provisioning | 5000 | 254 | 337139 | 1 | PASS | [602b9085529ec87398382081c02be43d822abd797f8b0e99038240cda43a2d6f](https://chipnet.imaginary.cash/tx/602b9085529ec87398382081c02be43d822abd797f8b0e99038240cda43a2d6f) |
| Actual Selene Vault premium | 4500 | 500 | 337143 | 3 | PASS | [5d70026b034a2e0da374fa48e9d8902685d8ce9e47f3138d97c3cdcb8fb43b83](https://chipnet.imaginary.cash/tx/5d70026b034a2e0da374fa48e9d8902685d8ce9e47f3138d97c3cdcb8fb43b83) |
| sponsor-fund | 8000 | 334 | 337139 | 13 | PASS | [f64241d4d4265ae4eddc7f337a4e9193d9c4d008c5c5a1431ce8e75ab23089d7](https://chipnet.imaginary.cash/tx/f64241d4d4265ae4eddc7f337a4e9193d9c4d008c5c5a1431ce8e75ab23089d7) |
| attack-paid | 3600 | 334 | 337139 | 13 | PASS | [ebc696dd1c4b3c3b1f42c173ed986f72c1d532c3241aa23e5496e6c17277731e](https://chipnet.imaginary.cash/tx/ebc696dd1c4b3c3b1f42c173ed986f72c1d532c3241aa23e5496e6c17277731e) |
| territory-claim | 2600 | 334 | 337139 | 13 | PASS | [e4f3d6184a9596c603a54db2d9f4cde43b5376a4e4b0d2ab9b133d096b30dbd4](https://chipnet.imaginary.cash/tx/e4f3d6184a9596c603a54db2d9f4cde43b5376a4e4b0d2ab9b133d096b30dbd4) |
| claim | 4389 | 356 | 337148 | 4 | PASS | [056a9cb0cf0e519bf1ffb977e07b45e77592a630887a76095e7a8877007eaf1e](https://chipnet.imaginary.cash/tx/056a9cb0cf0e519bf1ffb977e07b45e77592a630887a76095e7a8877007eaf1e) |
| territory-settlement | 2000 | 600 | 337146 | 6 | PASS | [dfb4c2287bb9a5deb8cf81e64536616381a892ff46dd1ae9f068fa95f4b79dc9](https://chipnet.imaginary.cash/tx/dfb4c2287bb9a5deb8cf81e64536616381a892ff46dd1ae9f068fa95f4b79dc9) |
| kingdom-withdraw | 1200 | 356 | 337146 | 6 | PASS | [b8d054937b47c5361462f902f01de2415a7cefcc0a6a75fe4776ec714bdb264b](https://chipnet.imaginary.cash/tx/b8d054937b47c5361462f902f01de2415a7cefcc0a6a75fe4776ec714bdb264b) |
| battle-settlement | 3000 | 600 | 337141 | 11 | PASS | [8994d3c130f6990b4a7c59d8e6778713533699276070d94dfe2d088c7492f8f6](https://chipnet.imaginary.cash/tx/8994d3c130f6990b4a7c59d8e6778713533699276070d94dfe2d088c7492f8f6) |

These are real transaction identifiers, not synthetic fixtures. Intake fees are separate from the quoted action amount. Outgoing settlement fees consume the separate committed reserve where applicable.

The actual Selene test covered **game UI → Selene approval → signature → backend broadcast → confirmation → applied entitlement** using the unchanged official web release and a local secure-WebSocket transport bridge. It received one 5,000-sat provisioning output and spent all of it as 4,500 sats plus a 500-sat wallet fee. The real payment allocation is 2,829 Kingdom + 900 Development + 546 Prize + 225 unspendable burn. This confirms the documented low-price deviation from a strict 65% Kingdom/10% prize split. [Selene receipt and scope](evidence/selene-live-chipnet.json) · [confirmed UI](evidence/selene-live/game-confirmed.png).

The other new intakes were approved and signed by the existing disposable local-key harness through actual game HTTP intents and a real Chipnet observer. They are **not** claimed as separate Selene approvals. The 8,000-sat sponsor payment has exact 1,600 Development and 6,400 Prize outputs. The 3,600-sat raid has a 3,000-sat principal and 600-sat reserve; its actual attacker win is committed by the settlement. The 2,600-sat sole claim has 2,000 principal and 600 reserve. East Meadow was awarded to p1 before season reset; its 2,000-sat return is separately checked.

The Kingdom withdrawal pays 1,200 sats to the existing verified account address with a 356-sat fee. The season claim quotes 4389 sats plus 356 fee. It follows actual HTTP construction orders and their completed scores (28 and 5), then an accelerated **isolated game calendar**. Blockchain timestamps, blocks, confirmations, fees and transfers were not accelerated or fabricated. Wrong claim destination status: 403. Duplicate request status: 409; total claim-row count stayed 2 → 2 including the retained historical claim. [Complete current-policy game journal](evidence/current-policy-chipnet.json).

Existing save: var/vaultborn-chipnet-R5XVjn/world.sqlite; original backup: var/blockchain-audit-live/before-audit.sqlite. p1 used an existing verified disposable BCH key and a real signed login challenge. p2's existing test seat received a private fixture session; no duplicate city or artificial score was added. The actual Selene wallet needed a new disposable profile because the earlier pairing-only profile was intentionally ephemeral. No additional authority, contract or environment was created just to duplicate an existing successful flow.

## Current token and authority outpoints

Fresh read-only checks verify **7 existing immutable NFTs** and **3 existing minting authorities** across the territory and political categories. No repeat mint or transfer was needed. [Token ownership](evidence/tokens-current-ownership.json) · [political baton](evidence/tokens-political-authority.json). Transfer of a collectible is not an entitlement to game control, territory yield, troops, or a lease extension.

## Regtest consensus execution

The installed BCHN instance reused var/regtest-territory-9OcMCX. All **15** matching historical receipts were revalidated and three political scripts recompiled byte-identically. The previous miner keys were ephemeral, so new disposable miner/signing keys were necessary to fund only the unverified generic profiles on this existing chain.

**10 newly confirmed nominal spends** cover Development 2-of-3, battle outcome/return/refund, overfund recovery, bounded Kingdom capture, territory outcome/sole return, and seasonal claim/rollover. There are 11 recorded funding/nominal transactions, plus the separate underfunded recovery probe. Seven negative checks are documented with their exact rejection scope. An exact repeated prize transaction returned already-known; this is not a claim that a different conflicting transaction was independently submitted. [Full consensus evidence](evidence/generic-covenants-regtest.json).

| Regtest operation | Actual local-chain TXID | Recorded fee |
| --- | --- | ---: |
| Funding missing generic treasury profiles | dd56f6974e1bebaa882f1691dd5ae779ba843af4101504c1be625c3aa0afc6b0 | 1200 |
| development-2of3 | c72ed378982bedb702df15bf8e521de20784bc81e5136fd12e2789d63e5b2a6c | 1000 |
| battle-opponent-wins | b00422f583afd16769ff2eaf0e5ba8f69944dad529d426e892df5797163afb55 | 800 |
| battle-return | 2e3430e9d0243148a7589b88fa734ec21a51d1116acef8432a587d03e61ff2d2 | 800 |
| kingdom-capped-capture | 62cd9d45d79d5865c2617289649e909ced82797f90d976932b994fb3ec9ab2a6 | 800 |
| territory-opponent-wins | 00ad2dd90d54bf3e7db9d4372c36b928538763a4a9912e4f6a56b7d811822572 | 800 |
| season-prize-claim | d0b5e1c1d817a3edca00a5728ff0dbcc567bd288998b7bd2de991962e4ebbf2d | 800 |
| battle-owner-refund | 7695c85b9de94e8a1026444dc6ee101e7341a4b2d9499e28039da7a40c52a4c2 | 800 |
| battle-misfunded-refund | dea6ea9fa83fb1dd007e3291ed4c9e56185d2fea0781d79b6d9e6e63a94e835e | 800 |
| territory-uncontested-return | 7ad50ba2d3e0bd44c3b3c65af02b93b8b03c30acc3abce5056ddc3ec6735cfdd | 800 |
| season-prize-rollover | 6154040b8d603f3f76699a84898e4e072d6e14bf95fa2ee437a194aaa153a30c | 800 |

The separate confirmed **576-sat** underpayment remains unspent: fixed reserve 800 would require a negative refund output, and the exact-funded settlement branch cannot rescue it. This is a **FAIL**, not a passing recovery test. [Contract findings](CONTRACTS_AND_SECURITY.md). Regtest TXIDs are local evidence and must not be looked up as public Chipnet payments.

## Explicit limitations

Physical devices, public relay reachability, Selene's independent Electrum/history/rate service, current-policy paid-recon/protectorate/political-service/contested-territory/rare-draw client lifecycles, an individual live political-charter NFT mint, current full-application use of the generic covenant profiles, and production reorganization/disaster recovery remain unverified or incomplete as detailed in the master matrix. A blocked adversarial indexer simulation was not executed. Offline synthetic negative probes are labeled synthetic and are never included in this real-chain TXID table.
