# Territory lifecycle on public Chipnet

> **Historical record.** This file documents an earlier run under earlier prices, splits and contracts (before the final economy of 19 November 2026). It is kept as evidence of that run only. Current rules: [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md).

The run used two independently linked, disposable Chipnet wallets and an isolated game database. It tested a contested claim with two genuine entrant payments, a successful territorial conquest, a paid rare draw, and the expiry of the resulting lease. The test advanced the game clock at the claim and lease deadlines. The test used a shorter, fixed block schedule for the rare draw. Transaction confirmations and the randomness block came from public Chipnet.

| Event | Amount or outcome | Confirmed transaction |
| --- | --- | --- |
| Riverhold enters East Meadow | 4,000 sats | [6c45291b…5eb2](https://chipnet.imaginary.cash/tx/6c45291b09f80e1089ebf998218a48d282c8f5878eed872eeac72d2db4a65eb2) |
| Ironhaven contests East Meadow | 4,000 sats | [417df272…de15](https://chipnet.imaginary.cash/tx/417df272d18fc60411e762515b19ba0b5be99a7356a212da58167b3ddfeede15) |
| Claim contest settlement | Riverhold won both 2,000-sat stakes | [1813d114…fdbc](https://chipnet.imaginary.cash/tx/1813d1143e9ce2ec166c00c1bc1d6d0f53cbfa55ba171e9574b105bb5a7efdbc) |
| Ironhaven attacks East Meadow | 6,000 sats | [938fa59e…8f59](https://chipnet.imaginary.cash/tx/938fa59ea7e0fcc8fa96d2393179546e0637efc1970e6bf0a5df5af2b25e8f59) |
| Conquest settlement | Ironhaven took control and captured 400 of 2,000 committed sats | [cabc4592…ff1f](https://chipnet.imaginary.cash/tx/cabc45926dacb16aff42d2da85109cf9be6a4a2d64da5d6f93be583dc7feff1f) |
| Oracle Ruins paid raffle entry | 7,400 sats | [cc44a0b5…fb7d](https://chipnet.imaginary.cash/tx/cc44a0b5de2b6d0bc669aff6d156c2c7ee7de713ba2cb69b298750721991fb7d) |
| Oracle Ruins raffle settlement | 72-hour lease and 3,700-sat escrow return | [c56554bc…09fd](https://chipnet.imaginary.cash/tx/c56554bce33eae950789d72a5f0d553bca4548f09aff2bd9890ccd30b6f609fd) |
| Oracle Ruins lease expiry | Extraction rights closed | [e5d0d5f8…4cb3](https://chipnet.imaginary.cash/tx/e5d0d5f855985aa4d84c08cf04fd534ace20d9e480a14252c6c32c4959434cb3) |

The verified selection block was height 334571 with hash `00000000000079cf56147799789cd63b4e7ca92d8d160f48d43aaa4d3c61b521`. The two-player battle ran independently of the single-entrant raffle. Multi-entrant draw fairness, duplicate ownership prevention, and timeout recovery were verified in separate automated tests.

The archived East Meadow replay and Oracle Ruins draw reproduce locally. The independent verifier checked the corresponding entry and settlement outputs against active public Chipnet.

The isolated game’s confirmed settlements also authorized these native CashTokens transactions through a separate issuance journal.

| Event | Confirmed Chipnet transaction |
| --- | --- |
| Dedicated category genesis and minting baton | [c4a6b853…d5bc](https://chipnet.imaginary.cash/tx/c4a6b85324df77c1183d697cfd1cbee7096a3a608316b37072c83022c63ed5bc) |
| East Meadow immutable deed | [7cd314a5…ec59](https://chipnet.imaginary.cash/tx/7cd314a52217b9667c3f313a200fea38456dcc41bdc5b72af9a02cae9cc8ec59) |
| East Meadow immutable conquest trophy | [0a799b70…a8b2](https://chipnet.imaginary.cash/tx/0a799b707693af5dcc3ae4a840d16c292df7f3dfa8c083609d5c0f68d84da8b2) |
| East Meadow control record | [741b784d…2f71](https://chipnet.imaginary.cash/tx/741b784d25b5811d1aa01abe9de5d3df9ce2ae1d59d7b57870e45a6e54a52f71) |
| Oracle Ruins immutable 72-hour lease collectible | [68d26d81…4a4a](https://chipnet.imaginary.cash/tx/68d26d810b809c4e1f8d6128585851b484743f51040740eb3bb61f241e0f4a4a) |
| Oracle Ruins lease expiry record | [83597038…c914](https://chipnet.imaginary.cash/tx/83597038563f02a09e309b3d93d1bacc0cdb952329f84f7dce5d00ec87d6c914) |
| East Meadow deed transferred between independent fixture wallets | [a7c61efe…9a0b](https://chipnet.imaginary.cash/tx/a7c61efeab5e1df8a351dbf4215bc034dc34987a3ff484be684aa84aad7a9a0b) |

The holder transfer preserved the category, immutable commitment and game’s controller. The observer followed the original issue to the confirmed receiving UTXO and checked that it was unspent. The expired lease collectible remains in its wallet, with extraction closed in the game.

A separate protocol fixture issued and verified a native immutable lease-renewal collectible on Chipnet. The game records a renewal when the previous holder wins a later raffle for the same site. The game fixture above tested a full first lease and its expiry. [Lease-renewal transaction](https://chipnet.imaginary.cash/tx/0eb8f289e058d56c580a88c9e4ca899bbeaef910734e24ade40dce150836ee74) · [Standalone CashTokens receipts](TERRITORY_NATIVE_CASHTOKENS.json)

- [All Chipnet receipts](TERRITORY_CHIPNET_RECEIPTS.json)
- [Native on-chain asset, current UTXO, and transfer evidence](TERRITORY_CHIPNET_ASSETS.json)
- [East Meadow full battle and ownership archive](TERRITORY_EAST_MEADOW_PROOF.json)
- [Oracle Ruins draw and expiry archive](TERRITORY_RARE_LEASE_PROOF.json)
- [Confirmed authority for the local playable save](TERRITORY_PREVIEW_AUTHORITY.json)
- [Independent BCHN Regtest receipts](TERRITORY_REGTEST_RECEIPTS.json)

```sh
node scripts/verify-territory.mjs docs/TERRITORY_EAST_MEADOW_PROOF.json --chipnet
node scripts/verify-territory.mjs docs/TERRITORY_RARE_LEASE_PROOF.json --chipnet
node scripts/verify-territory-assets.mjs docs/TERRITORY_CHIPNET_ASSETS.json
```

The archive contains public receipts and test-game identifiers. Signing keys and transaction journals are stored in ignored local paths.
