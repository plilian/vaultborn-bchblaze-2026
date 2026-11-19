# VAULTBORN territory protocol

> **Current rules (19 November 2026):** the economy, prices and custody described in parts of this document were replaced. The authoritative description is [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md) and the transaction list is [BLOCKCHAIN_TRANSACTION_MATRIX.md](BLOCKCHAIN_TRANSACTION_MATRIX.md). Where this document differs, those two are right.

Open War and then Territories, or select a site on the map. Starter lands belong to their city and cannot be permanently conquered. River valleys, mines and forests replenish particular resources. Strategic sites start with an NPC garrison unless a player already holds them. Taking a strategic site requires conquest, and its NPC garrison returns after abandonment or lapse. Rare sites are leased through a separate Chipnet raffle. Existing landmark ownership is migrated into the territory registry.

[Territory atlas](screenshots/vaultborn-territory-atlas.png) · [Claim screen](screenshots/vaultborn-territory-claim.png) · [Mobile rare-site panel](screenshots/vaultborn-territory-rare-mobile.png)

## Claims and control

A confirmed stake of 6,000 sats (plus a 600-sat settlement reserve) opens or enters a public 60-minute claim. The army lock and entry cutoff are two minutes before the end. The first entrant gets the same eligibility and army rules as every other contender. An uncontested claim returns its stake; in a contested claim the loser forfeits half of the stake to the winner.

The controller must keep holdings within the progression-based city and alliance limits and connect a site to the city or another holding. Garrisons and fortifications commit actual troops and in-game resources. Alliance aid supplies garrisons through permitted alliances and treaties. Defender and recovery protections restrict repeated conquest. Upkeep rises with the size of the holding. Inactivity and missed upkeep can reopen the site, including during later seasons. Starter lands retain permanent protection.

An attack on a held territory locks a stake of 10,000 sats (plus a 600-sat reserve). Army, tactics, commander, terrain, research and garrison defenses determine the result. A winning attack transfers the site and returns the stake; a failed attack forfeits half of the stake to the defender. A territory attack never touches a War Chest.

## Raffles and extraction

Rare entries cost 7,400 sats. The production schedule repeats every 36 verified Chipnet blocks. For a round starting at a height divisible by 36, entry transactions must be mined at heights start through start + 19. Checkout closes once the observed tip reaches the last entry height. The selection block is start + 27, and the server waits for six confirmations. Each verified wallet and alliance can have one active entry or lease across rare sites. Entries and role allocation can be inspected in the chain explorer and territory record.

The algorithm sorts valid transactions by TXID and hashes their canonical public roster. It hashes the roster commitment, round ID, final selection block hash and a counter. Rejection sampling over the 256-bit range selects the winning index without modulo bias. A wallet has no secret reveal step to miss. Every entry fixes the block height in its on-chain commitment, and its confirmed inclusion height determines whether it met the cutoff. Miners can influence block selection by withholding work. The hosted game applies eligibility and publishes the roster, so entrants can compare it with their independent receipts. The independent verifier checks the announced block and entry inclusion against Chipnet.

The winner extracts the site’s resources for exactly 72 hours. The authoritative game clock enforces expiry even when the lease NFT is still present in a compatible wallet. A timeout without a verified future block creates a recovery settlement for the 50% stake of each valid entrant. A successful draw also returns all entrant stakes. The economic prize is extraction; confirmed entry costs allocated to development, burn and season prizes remain final.

## Escrow and evidence

Territory stakes are not service charges and are not split: the whole stake sits in a `stake-escrow-v3` contract whose only possible payouts were fixed when it was funded, and whose contested outcomes are opened by the independent attestors. The server verifies the exact outputs, active-chain inclusion and unique transaction before it records anything.

The public archive identifies accepted receipts, the treasury public key, independently replayable battles, escrow allocations and outcome transactions. New battles use the same full combat verifier as ordinary VAULTBORN fights. With the Chipnet option the independent verifier checks the exact split scripts and amounts, settlement input outpoints, lease expiry’s reserved input, block inclusion and archive commitments.

```sh
node scripts/verify-territory.mjs "http://127.0.0.1:4173/verify/territory/east-meadow" --chipnet
```

## CashTokens

CashTokens are collectible evidence of a claim, conquest or lease. A hosted controller and the game clock decide gameplay access. Transfer of a collectible changes its wallet holder and never transfers a starter land, site, garrison or lease. Lease expiration is an independent protocol event. Authorization uses a separately funded Chipnet category with a rotating minting NFT and an issuance journal. The game displays the category, commitment, current unspent proof when available, and historical transactions. [Official CashTokens specification](https://cashtokens.org/docs/spec/chip/)

## Testing and network scope

Regtest uses an isolated local BCHN process and TCP loopback RPC. It validates the same exact split and anchor transactions plus a CashTokens genesis and non-fungible transfer. [BCHN 29.2.0 release](https://github.com/bitcoin-cash-node/bitcoin-cash-node/releases/tag/v29.2.0) · [Regtest receipts](TERRITORY_REGTEST_RECEIPTS.json)

Use a disposable test wallet to reproduce live integration. The end-to-end Chipnet fixture shortens block offsets for the raffle and advances only its isolated game clock. Independent confirmations and block hashes still come from public Chipnet. The playable build uses the standard schedule above. The existing offline Mainnet preflight remains available for an owner-controlled review. Mainnet spending, Mainnet paid raffles, and Mainnet player-funded capture stay disabled in the application.

Set the separate CashTokens issuer values from the setup script in the ignored local environment file. The script can initialize a disposable Chipnet authority using a funded fixture. Pass `--install-local` to make it active for this save. An existing authority stays in place. Use a separate category and journal for fixture runs so a test cannot consume a live save’s first deed. The operator can replenish the issuer’s ordinary Chipnet BCH using the funding address shown in the public authority configuration. See the exact run results in the [territory Chipnet report](TERRITORY_CHIPNET.md).
