# VaultBorn security

The live game runs on Bitcoin Cash Mainnet at https://vaultborn.parhamlilian.com. A server works on exactly one network: Chipnet (test coins, the default for a local copy) or Mainnet, a guarded configuration that only the owner can authorise (`docs/MAINNET.md`). A player has one BCH balance in the game, the War Chest, held by a contract of the player's own script; it is at risk only against an equal stake locked by an attacker. Game loot and protectorate tribute come from earned resources and never move BCH. Wallet keys stay in the wallet: the game receives public keys and signatures only, and never asks for a seed phrase, a private key or a password.

## Reporting a problem

Please report a security problem privately, through **Report a vulnerability** on the Security tab of this repository (GitHub private vulnerability reporting), not in a public issue. Describe what is affected and how to reproduce it. If the button is not shown, open an issue titled "Security contact" without any details, and a private channel will be arranged. Nobody from VaultBorn will ever ask for your seed phrase or private key.

## Controls and trust boundaries

| Risk | Current control |
| --- | --- |
| Session theft or cross-origin command | Random session secret, server-side digest, HttpOnly and SameSite cookies, JSON and origin checks. Enable `DOMINION_HTTPS` behind a terminating TLS reverse proxy. |
| Player tampering and stale commands | Server-derived prices, actor ownership, input limits and fresh eligibility checks. SQLite command idempotency and exact payment attribution. |
| Wrong BCH chain or false receipt | Network checkpoint, raw transaction hash, exact satoshis and locking script, Merkle proof or active-chain RPC, and two confirmations required by default. |
| Payout race or retry | Output-purpose ledger, serial outpoint reservations, persisted signed bytes, and repeat broadcast with one TXID. Player balances cover both payout and fee. |
| Stale intent or chain reorganization | A paid service that arrives late or whose action has become ineligible is kept for the payer as a service credit: the next action of that kind is delivered without a payment. The credit is not a BCH refund: no BCH is returned, the credit exists only in the game server's records, and it cannot be withdrawn or transferred. A raid that cannot be fought is void and its escrow returns the stake; a territory claim that cannot be entered returns its stake through the attestors. Internal faults also reach the operator's attention list. Reconciliation revisits recently credited transactions and pauses affected settlements after a detected reorg. |
| Resource farming and griefing | A power window (a target may be at most 20% weaker than the attacker; stronger kingdoms are always open), three raids launched and three received per kingdom per day, a shared alliance budget, an eight-hour pause between the same two kingdoms, and loot from earned resources only. |
| Chat abuse | Length and rate limits, text escaping, and server-scoped channel membership. |

A kingdom without a sign-in method lives in its browser session; connecting a wallet (or linking a Nostr key) makes it recoverable from any browser. Chain data beyond the pinned checkpoint comes from the configured Electrum servers; an own Bitcoin Cash Node (`MAINNET_RPC_URL`) is the stronger source. No third-party security audit has been done.

Back up the game key and the SQLite database together. Restrict access to secrets, use one operator per trust domain, and keep the audit receipts. Anyone operating a copy with real money should also arrange a review of the legal terms for their jurisdiction (sponsor promotion, contests and payouts, refunds and consumer disclosures).

New player and prize money is held by covenants: the War Chest (`war-chest-v4`), stake escrows (`stake-escrow-v3` and `-v4`), the season prize pool and sponsor funds (`prize-fund-v1`), and treaty escrows. The game key alone can pay a War Chest only to its owner's wallet; every raid, territory and prize outcome needs the attestors. A colluding game key and attestor majority could still sign a false raid outcome (at most that raid's stake) or a false prize. In this deployment the attestors are run by the VaultBorn team; anyone can run one ([docs/ATTESTOR_GUIDE.md](docs/ATTESTOR_GUIDE.md)). Outputs created before covenant custody remain spendable by the game key and are listed as such in the public ledger. Current state and evidence: [docs/STATUS.md](docs/STATUS.md). [Treasury custody and verification](docs/TREASURY_COVENANTS.md)

## Wallet verification when a wallet connects

A kingdom's War Chest, stakes, prizes and withdrawals are locked to one wallet, so the game must know that the player holds that wallet's key. WizardConnect wallets sign transactions, not messages. When a wallet pairs (on the start page or in the game), the game therefore asks it at once to sign a **proof transaction** (`apps/game-server/wallet-proof.mjs`): its only input is a coin that does not exist (its identifier is the hash of the statement being signed), its first output returns the same amount to the wallet's own first address, and its second output is a data record with the hash of the statement (site, address, expiry, a one-time number). It is never broadcast and could not be confirmed, because the input does not exist; it moves no BCH. A valid signature shows what a signed message would show. The statement is tied to the site and to the browser that asked, is valid for five minutes, and is accepted once.

- A wallet that already holds a kingdom opens that kingdom, from the start page, from **Sign in**, or from the "Found your city" screen; a wallet nobody has used starts a new one. Whoever holds the wallet's key can therefore enter its kingdom: the wallet is the account. A lost wallet is a lost sign-in unless a Nostr key was linked as well.
- In the game, a kingdom with money in its War Chest keeps its wallet; another wallet is refused until the War Chest is withdrawn.
- In use on Mainnet with Selene through WizardConnect: the Mainnet payments in [docs/MAINNET_TRANSACTIONS.md](docs/MAINNET_TRANSACTIONS.md) were signed that way. Also tested with the official WizardConnect wallet SDK in a browser (`scripts/test-wallet-connect-browser.mjs`). A wallet that refuses the proof is told so and can try again; the older signed-message proof remains available in the wallet dialog.
