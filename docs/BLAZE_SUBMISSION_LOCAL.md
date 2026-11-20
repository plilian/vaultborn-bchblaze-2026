# VaultBorn at BCH BLAZE 2026

**Live game:** [vaultborn.parhamlilian.com](https://vaultborn.parhamlilian.com) · **Source code:** [github.com/plilian/vaultborn-bchblaze-2026](https://github.com/plilian/vaultborn-bchblaze-2026) · **Presentation:** [VaultBorn slides](https://docs.google.com/presentation/d/1CPrmv3eMdY-d4T-1jlzeaIJjqFChHq8enlrpVClCOv8/edit?usp=sharing) · **Hackathon:** [BCH BLAZE 2026 on DoraHacks](https://dorahacks.io/hackathon/bchblaze2026/detail)

VaultBorn is a browser strategy game on Bitcoin Cash. Players build a city, command an army, sign treaties and raid rivals. The game is free to play; every paid action is a Bitcoin Cash Mainnet transaction that the player approves in their own wallet through WizardConnect.

## What the Mainnet Track asks for, and where it is

| Requirement | In VaultBorn |
| --- | --- |
| A feature that sends BCH Mainnet transactions, usable by anyone | Paid services, War Chest deposits, matched-stake raids and season sponsorship are Mainnet transactions built by the game and signed in the player's wallet. The wallet proof at connection signs, but is never broadcast. |
| A live demo judges can open with one click | [vaultborn.parhamlilian.com](https://vaultborn.parhamlilian.com) |
| A banner at the top of the home page | Filled from [`config/blaze.json`](../config/blaze.json): the presentation link, the source code link and the CashTokens address for EMBER2026 tokens (the token-aware form of the developer wallet's address unless another one is given). |
| WizardConnect or XO integration | WizardConnect for every wallet action (pairing, the sign-in proof and every payment); an XO template for treaty escrows in [`xo/`](../xo/README.md). |

## A two-minute walkthrough

1. Open the home page and press **Connect wallet**. Pair Selene (or another WizardConnect wallet) and approve the check in the wallet. The game opens your kingdom: a new one for a new wallet.
2. In **My City**, look at the buildings; under **Commanders**, assign one.
3. Go to **War** and launch a free raid against a stronger kingdom. Watch the battle replay.
4. Open **Vault** to see the War Chest and the price of each paid action. Approve a payment in the wallet to see the outputs and the fee before anything is sent.
5. Open **Rankings** to see the season standings and the prize pool (every kingdom is in the season from day one), and **Politics** for treaties and councils.

## The Mainnet record

The Mainnet launch was recorded in transaction [`7e5d53bb…a74db7cc`](https://blockchair.com/bitcoin-cash/transaction/7e5d53bbf8586c6474982f1e6c1e11a26d5444e607c0221c85a7cf1ea74db7cc) (block 978,040). Its data output is the SHA-256 hash of the launch manifest: the game key, the three attestor keys and their 2-of-3 threshold, the price book and the contract versions. The first game payments, a territory claim and a War Chest deposit signed in Selene through WizardConnect, confirmed in block 978,066, and the claim's escrow settled in block 978,094 with the signatures of two of the three attestors. All four, and how to check them offline with `npm run verify:mainnet`: [MAINNET_TRANSACTIONS.md](MAINNET_TRANSACTIONS.md).

## The other two bounties

- **Build with XO:** the treaty escrow template, its test in the XO engine and a Chipnet runner: [`xo/`](../xo/README.md).
- **Decentralized Identity:** a BCH key and a Nostr key bound in one signed record, published to two public Nostr relays and read back from each: [DECENTRALIZED_IDENTITY.md](DECENTRALIZED_IDENTITY.md), [the recorded run](IDENTITY_PUBLIC_RELAY_RUN.json).

## Stated plainly

- The attestors are run by the VaultBorn team; the game's rules say so.
- A paid service that cannot be delivered becomes a credit in the game, not a BCH refund.
- No third-party audit of the contracts has been done. What runs where, with the evidence: [STATUS.md](STATUS.md).
