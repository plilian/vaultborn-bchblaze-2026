# Chipnet verification report

> **Historical record.** This file documents an earlier run under earlier prices, splits and contracts (before the final economy of 19 November 2026). It is kept as evidence of that run only. Current rules: [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md).

This report records the historical BCH Dominion payment protocol. Its original fixture commands match the pre-VAULTBORN checkout and fee schedule. For the current implementation and current receipts, see [VAULTBORN Chipnet verification](VAULTBORN_CHIPNET.md).

Network evidence was gathered on public Bitcoin Cash Chipnet on 16 November 2026. The test accepted a Chipnet faucet transfer, created independent live game payment intents and signed new test transactions using disposable local keys. The application used a two-confirmation minimum. All times in the receipt data are UTC. Historical transactions and mock test fixtures carry separate status.

## Live receipts

| Action | Satoshis | Network fee | Chipnet receipt | Game and chain status |
| --- | ---: | ---: | --- | --- |
| BCH Ninja player fixture funding | 100,000 | 123 | [4b3a9065…db9b](https://chipnet.imaginary.cash/tx/4b3a906587d0bee3d528c4d3dc5b34d193bd96337b89243b98d35b9b6dd0db9b) | vout 1, block 333076, 552 confirmations at independent inspection |
| BCH Ninja separate badge fixture funding | 10,000 | 123 | [a8e98a18…4e79](https://chipnet.imaginary.cash/tx/a8e98a182a9cdecaf80586c0e654a901b9a60dd8489ebed1ebcd447a46544e79) | Testnet funding observed by the signing fixture before spend |
| City Hall premium upgrade | 1,500 | 255 | [11c8f05f…2cf0](https://chipnet.imaginary.cash/tx/11c8f05f395717bbdc975726385c437a19e91a9f976816bf5165523ea2252cf0) | vout 0 at block 333628, credited with 3 confirmations. Founders banner and civic preset applied. |
| Paid raid at Ironhaven | 1,200 | 255 | [b883706e…aafa](https://chipnet.imaginary.cash/tx/b883706eaf5c68a22c7318277e47da855b24ea79823f5f3e2bf247d86a88aafa) | vout 0 at block 333631, credited with 2 confirmations. Authoritative combat and remaining attack budget verified. |
| Scout Tower premium upgrade | 1,500 | 255 | [9951f7ee…8866](https://chipnet.imaginary.cash/tx/9951f7eea45c4a6557ab40241ce7a071f6f8dab28a049ff8535a8bf0e7af8866) | vout 0 at block 333633, credited with 2 confirmations. Private intel archive and insignia perk applied. |
| Vault Treasury premium upgrade | 1,500 | 255 | [c4bd2bfc…bdd5](https://chipnet.imaginary.cash/tx/c4bd2bfca6ac85097fc3c9c61aad7609f9509f37d37ee06b8458398a1c03bdd5) | vout 0 at block 333635, credited with 2 confirmations. Gold-trimmed treasury crest applied. |
| Protectorate proposal | 24,000 | 255 | [7a7057d7…8f73](https://chipnet.imaginary.cash/tx/7a7057d751c997f8b373156942cd37c9a280db9ac975b577f04def3b717d8f73) | vout 0 at block 333642, credited with 2 confirmations. 20× fee and defender response window opened. |
| Personal vault deposit | 8,000 | 255 | [890a6e22…8d1f](https://chipnet.imaginary.cash/tx/890a6e22cb3ccffe5dd5f8f867301b846964a556a43b0af63be5aa214f7e8d1f) | vout 0 at block 333642, credited with 2 confirmations. Confirmed balance credited with zero PvP exposure. |
| Season sponsor funding | 18,000 | 255 | [01d5ac3c…3b15](https://chipnet.imaginary.cash/tx/01d5ac3c0486f2a0e4c41cd0ab5ce443e557e88350e07e2ec4d0dc24a12e3b15) | vout 0 at block 333642, credited with 2 confirmations. Confirmed funds counted in the separate prize pool. |
| Personal vault withdrawal | 2,000 | 300 | [c902b936…dd50](https://chipnet.imaginary.cash/tx/c902b93619fa364bb7d24e9ade1e471f8bbde4d0fb594eecfcd6421a8c6cdd50) | vout 0 at block 333644, credited with 114 confirmations. Reserved inputs paid the approved address and returned change. Treasury change 5,700 sats. |
| Season reward claim | 6,120 | 300 | [951e7441…130f](https://chipnet.imaginary.cash/tx/951e744101e17aa9371157579946a749f747f1a07c3aa9da224b58562cf5130f) | vout 0 at block 333758, credited with 2 confirmations. Eligibility and one-time claim verified with sponsor-funded payout. Treasury change 11,580 sats. |
| Paid City Hall rush | 1,000 | 255 | [f1522466…5910](https://chipnet.imaginary.cash/tx/f1522466a48ef3dbf5ebed0b4a50289ade1c9e1370076e522436d0a14a575910) | vout 0 at block 333636, credited with 2 confirmations. Rush applied by game server. |
| Immutable Founder CashToken NFT | 2,150 carrier sats | 350 | [a00fd941…8959](https://chipnet.imaginary.cash/tx/a00fd941c606f24d4dd8b282d5cadcc895dc97340138a8e53d861dd6ec878959) | vout 0 at block 333639, verified unspent with 2 confirmations. Genesis input category [e80083d7…e993](https://chipnet.imaginary.cash/tx/e80083d71ed1330c8f27089a8181b521447307e0c7ddb6390af7920e3791e993), NFT capability none, FT amount 0, commitment 42434820446f6d696e696f6e20466f756e646572. |

The funded player fixture was bchtest:qp3w6c2x3syvjpfn3tf5muffvlnggpfzuy7s6zr6z6 and the separate sponsor badge fixture was bchtest:qzygq4xr0d0hq0lcku5xwj2dc6w9vvxqjqfla9ra3n. Treasury signing used a separate locally retained Chipnet key. Private keys, private session secrets, and signed raw transactions remain locally isolated from the report.

The observer's independent historical test verified Merkle inclusion and obtained 542 confirmations for the [GoogoL faucet history transaction](https://chipnet.imaginary.cash/tx/8c437361ca74a0bbacd9833b322a7cd0969c46d257ce1ec692429f40401dd1e5) at block 332445. Its recipient output was 1,017,000 sats and fee 300 sats. That third-party historical transaction did not fund the fixture or fulfill a game action.

The full addresses, TXIDs, verified block hashes, output indexes and actual game result data are in [CHIPNET_RECEIPTS.json](CHIPNET_RECEIPTS.json). For the paid raid, the result includes the server commitment and replay event count. The lead city initially failed protectorate eligibility at a power ratio of 1.597. Its archers rose from 14 to 28 through ordinary recruitment and the ratio rose to 1.880 before issuing the paid proposal. The defender accepted through a separate fixture session and prepared a covert cell. The game calendar was accelerated for standard recruitment and season finality in this isolated test. Network confirmation checks used public Chipnet independently of those clock changes.

A live negative test used the public Testnet4 Electrum endpoint blackie.c3-soft.com:62002 and failed with "Wrong network: Chipnet checkpoint mismatch." An independent lookup on chipnet.bch.ninja:50002 gave five confirmations for the immutable badge in block 333639 and independently matched its category, output and 350-sat fee.

## Commands and verification

From the repository root, generate a fresh fixture and fund the printed Chipnet wallet with at least 65,000 sats through the [BCH Ninja faucet](https://chipnet.bch.ninja/). The key file stays under the ignored var directory. Use a fresh Chipnet key. The E2E run starts a loopback application and writes redacted JSON receipts into a new ignored directory. The season calendar is advanced locally once, while confirmations and payout status come from public Chipnet.

~~~powershell
node scripts/chipnet-wallet.mjs new var/chipnet-keys.json
$env:CHIPNET_FIXTURE_FILE = 'var/chipnet-keys.json'
$env:CHIPNET_TEST_APPROVE = 'true'
node scripts/chipnet-game-e2e.mjs
node scripts/chipnet-badge-e2e.mjs
node scripts/chipnet-wallet.mjs inspect 11c8f05f395717bbdc975726385c437a19e91a9f976816bf5165523ea2252cf0
node --test packages/chain-observer/*.test.mjs
~~~

The badge script accepts a separate funded sponsor entry in the fixture. When omitted it uses the player entry. Run the scripts sequentially when using a single signer. Unit tests use deterministic fixtures, including validation by the Libauth virtual machine. The chain package reported 12 passing tests and 0 failures. Test cases include wrong network, amount, unique recipient, token exclusion, mempool/confirmed/reorg transitions, late payments, wallet proof, Merkle inclusion, protected treasury signing and token conservation, outgoing confirmation promotion and atomic multi-output transaction deduplication.

The withdrawal conserved the personal vault balance as 2,000 payout + 5,700 change + 300 fee = 8,000 sats. The funded reward conserved the sponsor pool as 6,120 payout + 11,580 change + 300 fee = 18,000 sats. A repeated claim request received an eligibility error and the ledger retained exactly one confirmed claim. Wallet signing and the game operated on separate processes and private fixture keys.

Selected output from the executed live tests

~~~text
premium seen_in_mempool 0
premium confirming 1
premium credited 3
attack-paid credited 2
protectorate credited 2
vault-deposit credited 2
sponsor-fund credited 2
withdraw credited 114
claim seen_in_mempool 0
claim confirming 1
claim credited 2
Persistent live Chipnet fixture completed. Evidence: var/chipnet-run-i4iaxP/receipts.json
Live duplicate claim HTTP request refused; one confirmed claim remains in the ledger.
Rush credited with 2 confirmations
Founder NFT verified unspent at 2 confirmations
Chipnet rush and Founder NFT test passed.
~~~

## Observed issues

- APECS returned HTTP 502 with a Fulcrum WebSocket error during the faucet transfer. The initial proof-of-work request succeeded.
- GoogoL selected Chipnet and returned a broadcast error for a non-standard transaction version. BCH Ninja proof of work completed and delivered the test funds.
- Public Electrum can close idle connections or fall behind. The observer reports uncertainty and retries. The default configuration can fail over to other documented Chipnet endpoints.
- An outgoing withdrawal retained one confirmation in the application while public Chipnet had already mined further blocks. The ledger now reconciles the confirming state and the same signed withdrawal completed after restart without issuing another transfer.
- Live evidence uses the Electrum transport. The optional BCHN RPC path was implemented without a live BCHN integration run. Reorg cases were exercised in deterministic tests.
- The Founder badge was minted and its current holder was independently verified. Automated season-triggered badge issuance and full transfer history remain outside this flow.
- XO has no executed invitation and no verified template. The test scope was Chipnet only.
