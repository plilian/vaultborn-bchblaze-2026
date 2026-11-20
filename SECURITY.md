# BCH Dominion security

The game runs on Chipnet (test coins) by default. Mainnet is a separate, guarded configuration that only the owner can authorise (`docs/MAINNET.md`). A player has one BCH balance in the game, the War Chest, held by a contract of the player's own script; it is at risk only against an equal stake locked by an attacker. Game loot and protectorate tribute come from earned resources and never move BCH. Player payment secrets remain in the wallet. The app receives a public key and one-time proof for an optional wallet link and checks it against the saved challenge and CashAddr.

## Controls and trust boundaries

| Risk | Current control |
| --- | --- |
| Session theft or cross-origin command | Random session secret, server-side digest, HttpOnly and SameSite cookies, JSON and origin checks. Enable `DOMINION_HTTPS` behind a terminating TLS reverse proxy. |
| Player tampering and stale commands | Server-derived prices, actor ownership, input limits and fresh eligibility checks. SQLite command idempotency and exact payment attribution. |
| Wrong BCH chain or false receipt | Network checkpoint, raw transaction hash, exact satoshis and locking script, Merkle proof or active-chain RPC, and two confirmations required by default. |
| Payout race or retry | Output-purpose ledger, serial outpoint reservations, persisted signed bytes, and repeat broadcast with one TXID. Player balances cover both payout and fee. |
| Stale intent or chain reorganization | A paid service that arrives late or whose action has become ineligible is kept for the payer as a service credit: the next action of that kind is delivered without a payment. The credit is not a BCH refund: no BCH is returned, the credit exists only in the game server's records, and it cannot be withdrawn or transferred. A raid that cannot be fought is void and its escrow returns the stake. Internal faults also reach the operator's attention list. Reconciliation revisits recently credited transactions and pauses affected settlements after a detected reorg. |
| Resource farming and griefing | New-player shield, opt-in PvP, power bracket, rolling per-target and alliance limits, protection after defeat, and earned-resource-only loot. |
| Chat abuse | Length and rate limits, text escaping, and server-scoped channel membership. Human moderation and abuse reporting remain release work. |

Guest identities live in the browser. The local seeded seats are intended for trusted demo participants. Public account recovery, stronger multi-account enforcement, moderation, signer isolation, and an independent security audit are release requirements. The public Electrum trust model relies on the configured servers for the active tip beyond the pinned checkpoint. A self-hosted Chipnet node can reduce that dependency.

Back up the operator key and SQLite database together. Restrict secret access, use one operator per trust domain, and retain audit receipts. A deployment involving mainnet funds or player-funded prizes needs independent security and jurisdiction-specific review, transparent return and refund terms, and consent for each new money movement.

New player and prize money is held by covenants: the War Chest (`war-chest-v4`), stake escrows (`stake-escrow-v3` and `-v4`), the season prize pool and sponsor funds (`prize-fund-v1`), and treaty escrows. The game key alone can pay a War Chest only to its owner's wallet; every raid, territory and prize outcome needs the attestors. A colluding game key and attestor majority could still take War Chest and prize money: they must be run by independent parties. Outputs created before covenant custody remain spendable by the game key and are listed as such in the public ledger. Current state, evidence and open items: `docs/audit/remediation/FINAL_ECONOMY_REPORT.md`. [Treasury custody and verification](docs/TREASURY_COVENANTS.md)

## Wallet verification when a wallet connects

A kingdom's War Chest, stakes, prizes and withdrawals are locked to one wallet, so the game must know that the player holds that wallet's key. WizardConnect wallets sign transactions, not messages. When a wallet pairs (on the start page or in the game), the game therefore asks it at once to sign a **proof transaction** (`apps/game-server/wallet-proof.mjs`): its only input is a coin that does not exist (its identifier is the hash of the statement being signed), its first output returns the same amount to the wallet's own first address, and its second output is a data record with the hash of the statement (site, address, expiry, a one-time number). It is never broadcast and could not be confirmed, because the input does not exist; it moves no BCH. A valid signature shows what a signed message would show. The statement is tied to the site and to the browser that asked, is valid for five minutes, and is accepted once.

- From the start page, a wallet that already holds a kingdom opens that kingdom; a wallet nobody has used starts a new one. Whoever holds the wallet's key can therefore enter its kingdom: the wallet is the account. A lost wallet is a lost sign-in unless a Nostr key was linked as well.
- In the game, a kingdom with money in its War Chest keeps its wallet; another wallet is refused until the War Chest is withdrawn.
- Checked with the official WizardConnect wallet SDK in a browser (`scripts/test-wallet-connect-browser.mjs`) and against the signing rules read from Selene's published web release (it signs an input when the stated coin is locked to the key at the stated path; it does not look the coin up). **Not yet confirmed with Selene on a phone.** A wallet that refuses the proof is told so and can try again; the older signed-message proof remains available in the wallet dialog.
