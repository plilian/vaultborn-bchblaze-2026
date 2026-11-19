# VAULTBORN presentation copy

> **Current rules (19 November 2026):** the economy, prices and custody described in parts of this document were replaced. The authoritative description is [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md) and the transaction list is [BLOCKCHAIN_TRANSACTION_MATRIX.md](BLOCKCHAIN_TRANSACTION_MATRIX.md). Where this document differs, those two are right.

> **Updated 19 November 2026 (remediation).** New sponsorships send **30% to the single configured Development address and 70% into a per-sponsorship Seasonal Prize Fund covenant** (`prize-fund-v1`). The minimum is 0.25 BCH. A prize leaves the fund only after the season closes and only with the game automation key **and** every independent prize attestor; anything not awarded by the refund date returns to the sponsor's wallet through a keyless lane. Sponsorships quoted earlier under 20/80 keep their original terms and stay verifiable. Service payments keep 20/10/5/65; at 4,000 and 4,500 satoshis the exact split is reached with the `prize-carrier-v1` covenant instead of a 546-satoshi floor. See `docs/audit/remediation/`.


## World

Players build a fortress on a shared frontier. They train commanders and armies, spy on rivals, secure landmarks, and negotiate or overturn protectorates.

## Bitcoin Cash use

Every service payment is split by the payer's own transaction into four auditable outputs: 50% into the payer's own War Chest contract, 20% to the season prize pool, 20% to Development and 10% to a provable burn. Paid raids use matched stakes: the attacker locks a stake, the raid is offered only if the defender's War Chest covers the same amount, and the winner takes both. Wallet signatures authorize the exact amounts shown at checkout.

## Strategy

Free and paid raids share eligibility and cooldowns. BCH changes the escrow terms. Terrain, army composition, tactics, protection and intelligence determine combat. Two verified kingdoms can opt into treasury exposure. The cap is 20% of the committed balance.

## Verification

Show the split receipt, the battle replay and the independent battle record. Point to the output committing to its result, then show the operator-confirmed sponsor payout. Explain which evidence is available on Chipnet and which Mainnet steps remain for the owner.

## Governance

Sponsors can fund scheduled and approved season placements. Verified active players can propose development payments and vote on them. Execution requires demonstrated quorum, approval and consent from the operator who holds the Chipnet signing key.

## Evidence

- [World screenshot](screenshots/vaultborn-world.png)
- [Wallet checkout](screenshots/vaultborn-checkout.png)
- [Battle verification](screenshots/vaultborn-battle-verification.png)
- [Council mobile view](screenshots/vaultborn-council-mobile.png)
- [Chipnet verification](VAULTBORN_CHIPNET.md)
