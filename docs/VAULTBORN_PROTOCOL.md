# VAULTBORN payments and treasury

> **Current rules (19 November 2026):** the economy, prices and custody described in parts of this document were replaced. The authoritative description is [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md) and the transaction list is [BLOCKCHAIN_TRANSACTION_MATRIX.md](BLOCKCHAIN_TRANSACTION_MATRIX.md). Where this document differs, those two are right.

> **Updated 19 November 2026 (remediation).** New sponsorships send **30% to the single configured Development address and 70% into a per-sponsorship Seasonal Prize Fund covenant** (`prize-fund-v1`). The minimum is 0.25 BCH. A prize leaves the fund only after the season closes and only with the game automation key **and** every independent prize attestor; anything not awarded by the refund date returns to the sponsor's wallet through a keyless lane. Sponsorships quoted earlier under 20/80 keep their original terms and stay verifiable. Service payments keep 20/10/5/65; at 4,000 and 4,500 satoshis the exact split is reached with the `prize-carrier-v1` covenant instead of a 546-satoshi floor. See `docs/audit/remediation/`.


The application keeps the existing SQLite world, accounts, wallet links and receipts. Historical receipts retain their original one-output terms. New quotes show the exact Chipnet outputs before requesting a signature.

## Gameplay charge

Payments allocate 20% to development, 15% to a provable OP_RETURN burn and 15% to the quoted season’s prizes. The remaining 50% goes to the paying kingdom or its paid raid escrow. The wallet signs these outputs and adds change and fees. The confirmed receipt enumerates the exact output indexes. Spendable outputs must meet Bitcoin Cash dust limits. If the original move is no longer eligible when a valid transfer confirms, the owner share stays in the kingdom treasury. Any BCH already burned remains unspendable.

The on-chain script pushes the four-byte identifier VBRN and 34 bytes containing version 01, a one-byte event code and a 32-byte SHA-256 digest. That digest uses UTF-8 JSON with lexical key order and original array order. The preimage has version, kind, subject and data fields. Raid initiation commits to the quoted action and allocation. Settlement commits to the initiation TXID and the hash of the persisted battle record. The settlement uses part of the same raid’s development output for the network fee.

The observer discovers payments by unique output and verifies every expected allocation, transaction hash and applicable block inclusion proof. Each TXID belongs to one intent. Unexpected or late transfers are surfaced for operator review. Financial reorgs pause affected operations until the observed chain reconciles. Broadcast recovery retains the reserved input list and signed transaction across restarts.

A kingdom can commit available funds after linking its wallet and joining seasonal PvP. Only eligible pairs of separately verified players can exchange financial loot. The pair can settle once every 24 hours, regardless of who attacked. A winning attacker receives its escrow plus up to 20% of the defender’s committed funds. A successful defender receives the attacker’s escrow when the defender had an eligible commitment. Exposure reductions take effect after 12 hours. Free raids still settle in ordinary game resources.

In the 24,000-run treasury simulation, comparable attackers used the baseline 35.3% win rate. At 15,000 sats of defender exposure the sample attacker lost 4,266 sats per raid on average after the modeled fee, and the defender gained 900 sats. At 90,000 sats of exposure, the sample attacker gained 648 sats on average, while losing the full fee on a defeat. These are measured scenario averages for testnet tuning. [Model inputs and results](vaultborn-kingdom-simulation.json)

## Custody and prizes

Development funds, season prizes, kingdom funds and personal deposits occupy distinct ledger buckets. The Chipnet operator signs from reconstructible P2SH outputs. Personal vault deposits remain outside battle. Kingdom withdrawals require the kingdom’s verified Chipnet receive address and consent to the displayed amount and fee.

Each season receives 15% of eligible gameplay charges and direct sponsorships. At close, the award base is 85% of eligible funds available when the first paid claim reserves inputs. The top five non-NPC scorers with positive scores receive 40%, 25%, 15%, 10% and 10% of that base. The remainder covers fees, dust and liquidity. Each claim reserves confirmed inputs and is limited to one payout per player and season. Claims under 600 sats remain in the prize pool.

## Sponsors and DAO

The Council offers a season banner for 5,000 sats or a title sponsorship for 20,000 sats. Campaigns have a title, sponsor name, HTTPS link, current season schedule and optional PNG or WebP logo up to 7 KB. The local administrator approves requests before they become payable. Placements require confirmed funds and a scheduled start. Title sponsorship windows cannot overlap. Those windows rank their first eligible raid per pair and UTC day, with 15 points for the attacking winner or 10 for a successful defender. Completed tables stay in the tournament archive. Campaigns report up to one impression and click per account per day.

Council membership requires a verified wallet, tutorial completion and at least ten campaign points. Proposals snapshot the voting membership and publish their amount, purpose, vote totals and destination. Voting lasts three days. Quorum requires at least three voters and 25% of the snapshot. Passage requires 60% of yes and no votes. Abstentions count for quorum. Execution requires operator authorization, a current exact quote and explicit confirmation. The Chipnet operator holds the spending key. A future treasury handover needs reviewed contract rules or independent signers.

## Battle verification

Participants can inspect the battle record immediately. New archived records become public after 24 hours to limit disclosure of active garrisons. Older battles remain available to participants. The JSON view includes inputs, the rules fingerprint, seed, losses, rounds, result hash and available Chipnet receipts.

```sh
node scripts/verify-battle.mjs path/to/battle.json
node scripts/verify-battle.mjs path/to/battle.json --chipnet
```

The first command recomputes combat and archive hashes. The second also checks the recorded initiation and settlement against live Chipnet outputs.
