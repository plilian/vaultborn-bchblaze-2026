# VaultBorn status

Updated 20 November 2026.

## Live on Bitcoin Cash Mainnet

VaultBorn runs on Bitcoin Cash Mainnet at **[vaultborn.parhamlilian.com](https://vaultborn.parhamlilian.com)**. The launch was
recorded on chain in block 978,040 on 19 November 2026, and players have been playing on the live server since.

| What | Transaction | Block |
|---|---|---|
| Launch record: the hash of the game key, the three attestor keys, the 2-of-3 threshold, the price book and the contract versions | [`7e5d53bb…`](https://blockchair.com/bitcoin-cash/transaction/7e5d53bbf8586c6474982f1e6c1e11a26d5444e607c0221c85a7cf1ea74db7cc) | 978,040 |
| Territory claim: 6,600 sat into a `stake-escrow-v3` contract, signed in Selene through WizardConnect | [`29dc9fc2…`](https://blockchair.com/bitcoin-cash/transaction/29dc9fc2022f0acc2391eb50646f93fd7558058d6ae3499a996c5d07f1064483) | 978,066 |
| War Chest deposit: 10,000 sat into a `war-chest-v4` contract, signed in Selene through WizardConnect | [`3364cea4…`](https://blockchair.com/bitcoin-cash/transaction/3364cea414af757ad4e34ba78c24aa61b34f6e2208893c716037ff88fdb9eb46) | 978,066 |
| Settlement: the claim's escrow returns the 6,000 sat stake to the claimant, signed by 2 of the 3 attestors | [`1022549a…`](https://blockchair.com/bitcoin-cash/transaction/1022549ae29f30d57b3327f6f381f553375a5227c197390b0564fd4a6f7a8505) | 978,094 |

Each of them can be checked offline from this repository with `npm run verify:mainnet` (TXIDs, Merkle branches, proof of
work, the launch manifest's hash, the War Chest contract rebuilt from this code, and the settlement's contract, signatures
and amounts). Details: [MAINNET_TRANSACTIONS.md](MAINNET_TRANSACTIONS.md). The live game lists its own transactions in its
public ledger: [vaultborn.parhamlilian.com/ledger.html](https://vaultborn.parhamlilian.com/ledger.html).

What runs on Mainnet, in the live game:

- **Wallet:** pairing with WizardConnect over its public relay, the wallet proof at connection (sign-in with the wallet,
  from any browser), and every payment signed in the player's own wallet. The payments listed above were signed in Selene.
- **Payments:** the server builds each payment from the player's coins, shows every output and the fee before the wallet
  signs, and credits it once it is confirmed, checked on Electrum servers of two different operators.
- **Contracts:** War Chest funding (`war-chest-v4`), territory stakes (`stake-escrow-v3`), and a settlement opened by the
  attestor panel (2 of 3 signatures, without the game key).
- **Attestors:** three attestors, run by the VaultBorn team, replay and sign outcomes on the server.
- **Public record:** the public ledger, the season score journal (`/api/public/season-events`) and its anchors in the
  payments' event records (`/api/public/season-anchors`).
- **Server:** the game runs in its own Docker project behind nginx on a server that also hosts other sites, installed with
  [`infrastructure/mainnet/install-behind-nginx.sh`](../infrastructure/mainnet/install-behind-nginx.sh).

## Contracts and payments on the test networks

- **BCH virtual machine:** every contract path of the current contracts (War Chest release, capture and two-step exit;
  matched-raid outcomes and refund; territory lanes; prize fund and pool; proof reserve; treaty escrow) runs in the unit
  tests (`npm test`).
- **Bitcoin Cash Node Regtest:** the same paths mined on a real node with standard relay rules
  ([evidence](audit/remediation/evidence/regtest-remediation.json)).
- **Chipnet:** earlier versions of the contracts and the game's payment flows ran on Chipnet: the split payment and burn,
  a funded City Hall upgrade, a paid raid and its escrow settlement, sponsor funding, a prize claim, territory contests,
  political escrows and CashTokens collectibles. Receipts: `docs/*_CHIPNET*.json`, `docs/*_RECEIPTS.json`,
  [VAULTBORN_CHIPNET.md](VAULTBORN_CHIPNET.md), [TERRITORY_CHIPNET.md](TERRITORY_CHIPNET.md) and
  [audit/blockchain/CHIPNET_EVIDENCE.md](audit/blockchain/CHIPNET_EVIDENCE.md).

## Tests in this repository

| Command | Result |
|---|---|
| `npm test` | 265 of 265 (rules, ledger, contracts in the BCH virtual machine, identity, server set-up, the Mainnet proof). [Last run](audit/remediation/evidence/unit-tests.txt) |
| `npm run verify:mainnet` | All checks pass for the four Mainnet transactions |
| `npm run test:browser` | The game in Chromium: map, raids, politics, wallet proof, payments, mobile layout ([result](audit/remediation/evidence/browser-qa.txt)) |
| `npm run test:wallet:connect` | 9 of 9 with the official WizardConnect wallet SDK: pairing, sign-in, the same kingdom from another browser, the wallet gate on pay buttons ([result](audit/remediation/evidence/wizardconnect-browser.json)) |
| `npm run test:browser:warchest` | War Chest, matched-stake raid and payment dialogs ([result](audit/remediation/evidence/browser-war-chest.json)) |
| `npm run test:xo` | 6 of 6: the XO treaty escrow template in the XO engine on a local chain (install the XO tools first: `npm --prefix xo ci`) |

**Decentralized identity on public relays.** A BCH key and a Nostr key were linked in one signed event, published to two
public Nostr relays (`wss://nos.lol`, `wss://nostr.mom`), read back from each of them, verified from the relay data alone,
and both keys then answered a challenge from a separate relying application. The record, and the command that checks it
again from the relays: [IDENTITY_PUBLIC_RELAY_RUN.json](IDENTITY_PUBLIC_RELAY_RUN.json).

## Known limits

- **The attestors are run by the VaultBorn team.** Raid outcomes and prizes rest on their signatures until other people
  run attestors ([ATTESTOR_GUIDE.md](ATTESTOR_GUIDE.md)). A colluding game key and attestor majority could sign a false raid
  outcome (at most that raid's stake) or a false prize.
- **A service credit is not a refund.** A paid service that cannot be delivered when its payment confirms is owed as the
  next service of the same kind; no BCH is sent back.
- **The game state is kept by the server.** Battles can be replayed by anyone from the public record; building, research
  and mission scores are checked against the rules, but player commands are not signed.
- **Chain data beyond the pinned checkpoint comes from the Electrum servers** the server uses; an own Bitcoin Cash Node is the
  stronger source (`MAINNET_RPC_URL`).
- **No third-party audit** of the contracts has been done.
