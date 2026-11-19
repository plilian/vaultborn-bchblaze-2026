# VaultBorn at BCH BLAZE 2026

**Live game:** [vaultborn.parhamlilian.com](https://vaultborn.parhamlilian.com) · **Source code:** [github.com/plilian/vaultborn-bchblaze-2026](https://github.com/plilian/vaultborn-bchblaze-2026) · **Presentation:** [VaultBorn slides](https://docs.google.com/presentation/d/1CPrmv3eMdY-d4T-1jlzeaIJjqFChHq8enlrpVClCOv8/edit?usp=sharing) · **Hackathon:** [BCH BLAZE 2026 on DoraHacks](https://dorahacks.io/hackathon/bchblaze2026/detail)

VaultBorn is a browser strategy game on Bitcoin Cash. Players build a city, command an army, sign treaties and raid rivals. The game is free to play; every paid action is a Bitcoin Cash Mainnet transaction that the player approves in their own wallet through WizardConnect.

## What the Mainnet Track asks for, and where it is

| Requirement | In VaultBorn |
| --- | --- |
| A feature that sends BCH Mainnet transactions, usable by anyone | Paid services, War Chest deposits, matched-stake raids and season sponsorship are Mainnet transactions built by the game and signed in the player's wallet. The wallet proof at connection signs, but is never broadcast. |
| A live demo judges can open with one click | [vaultborn.parhamlilian.com](https://vaultborn.parhamlilian.com) |
| A banner at the top of the home page | Filled from [`config/blaze.json`](../config/blaze.json): the presentation link, the source code link and the CashTokens address for EMBER2026 tokens (the token-aware form of the developer wallet's address unless another one is given). |
| WizardConnect or XO integration | WizardConnect for every wallet action; an XO template for treaty escrows in [`xo/`](../xo/README.md). |

## A two-minute walkthrough

1. Open the home page and press **Connect wallet**. Pair Selene (or another WizardConnect wallet) and approve the check in the wallet. The game opens your kingdom: a new one for a new wallet.
2. In **My City**, look at the buildings; under **Commanders**, assign one.
3. Go to **War** and launch a free raid against a stronger kingdom. Watch the battle replay.
4. Open **Vault** to see the War Chest and the price of each paid action. Approve a payment in the wallet to see the outputs and the fee before anything is sent.
5. Open **Rankings** to join the season and see the prize pool, and **Politics** for treaties and councils.

## The public launch record

The Mainnet launch was recorded in transaction [`7e5d53bb…a74db7cc`](https://blockchair.com/bitcoin-cash/transaction/7e5d53bbf8586c6474982f1e6c1e11a26d5444e607c0221c85a7cf1ea74db7cc) (block 978,040). Its data output is the SHA-256 hash of the launch manifest: the game key, the three attestor keys and their 2-of-3 threshold, the price book and the contract versions.

## Stated plainly

- The attestors are run by the game's owner and are therefore not independent; the game tells its players so.
- A paid service that cannot be delivered becomes a credit in the game, not a BCH refund.
- There has been no external audit of the contracts. See [MAINNET.md](MAINNET.md) for what has run on a public network.
