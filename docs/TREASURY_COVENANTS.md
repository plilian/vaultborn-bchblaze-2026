# Treasury custody and covenant verification

> **Current rules (19 November 2026):** the economy, prices and custody described in parts of this document were replaced. The authoritative description is [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md) and the transaction list is [BLOCKCHAIN_TRANSACTION_MATRIX.md](BLOCKCHAIN_TRANSACTION_MATRIX.md). Where this document differs, those two are right.

> **Updated 19 November 2026 (remediation).** New sponsorships send **30% to the single configured Development address and 70% into a per-sponsorship Seasonal Prize Fund covenant** (`prize-fund-v1`). The minimum is 0.25 BCH. A prize leaves the fund only after the season closes and only with the game automation key **and** every independent prize attestor; anything not awarded by the refund date returns to the sponsor's wallet through a keyless lane. Sponsorships quoted earlier under 20/80 keep their original terms and stay verifiable. Service payments keep 20/10/5/65; at 4,000 and 4,500 satoshis the exact split is reached with the `prize-carrier-v1` covenant instead of a 546-satoshi floor. See `docs/audit/remediation/`.


VaultBorn matches incoming payments against exact amounts and destination scripts. It journals credits, reservations, signed settlement bytes, and confirmed spends by outpoint. For new sponsorships, 20% goes directly to Development and 80% directly to the Seasonal Prize pool in the sponsor’s payment. The wallet fee is separate. Empty seasons, seasons with fewer than two eligible participants, expired or dust awards, and funding beyond the current input limit carry forward. Existing single-output sponsor receipts retain their original meaning. [Allocation and payouts](BLOCKCHAIN_TRANSACTION_MATRIX.md)

| Payment path | Current game checkout | Locally compiled contract |
| --- | --- | --- |
| Development | The owner may configure a native Chipnet destination or derive a 2-of-3 multisignature address. External allocations are excluded from the game signer’s spendable balance. | Two of three independent keys can spend from the Development covenant. The key holders choose the destinations and supply the fee. |
| War Chest and raid stakes | `war-chest-v4` (one script per owner) and `stake-escrow-v4`. The game key can only pay a War Chest to its owner's verified wallet; a capture needs the attestors and the attacker's equal stake in the same transaction; a raid that cannot be fought is void and returns the stake. There is no Kingdom Treasury. |
| Territory contests | The existing contest closes and settles its admitted cohort through the operator signer. The sole eligible claimant recovers principal, and invalid or expired entries follow the journaled recovery rules. | A committed sole-claimant return can be relayed after closure. A fixed two-party tranche uses signatures from two attestors and preserves owner recovery. The open multientrant contest is not migrated to that fixed-recipient template. |
| Seasonal prizes | The existing journal computes awards from confirmed funds and uses the operator signer to pay verified wallets. It applies the sponsorship split once, at funding. | A funded voucher pays one fixed claim address. Anyone may relay the claim. After a configured timestamp anyone may instead relay the fixed rollover spend. Only the first confirmed spend can consume the outpoint. |
| Political compensation | The existing contract restricts release and refund to the agreed wallets. After its timestamp the payer can recover directly using their key. | [Existing political escrow](../packages/chain-observer/political-escrow.mjs) |
| Service charges, burn, and sponsorship | Wallet-approved outputs commit every allocation. Paid services use the published dust-adjusted allocation for small payments. The burn output is provably unspendable. | These payments send exact amounts directly to their destinations. They need no intermediate covenant to split funds. |

The raid, kingdom, territory, and prize templates compile and execute in the local BCH VM. They do not replace the current checkout or its payout scheduler. Provisioning covenant-backed prize vouchers from the live pool, matching and settling open territory cohorts, rotating accounting between old and new custody, and collecting independent attestations in the application still need integration before these profiles can accept player funds. The Development destination can be configured now because checkout already delivers the allocation directly. The existing political compensation path is separate and already connected.

### Owner configuration

- Set `CHIPNET_DEVELOPMENT_ADDRESS` to a prefixed native Chipnet CashAddr, or set `CHIPNET_DEVELOPMENT_COUNCIL_KEYS` to three comma-separated compressed public keys and `CHIPNET_DEVELOPMENT_COVENANT_ID` to a unique 32-character lowercase hexadecimal ID.
- `CHIPNET_SPONSOR_DEVELOPMENT_ADDRESS` may override the Development destination for sponsorships specifically. Keep custody of that address independently of the game operator.
- These settings affect newly issued quotes. Preserve former descriptors, signer access, public keys, and payout journals for funding already committed under an older configuration. An external Development address disables new app-signed political proof charges and classic competitive quotes that require an operator-controlled Development reserve. The standard competitive checkout separates the reserve from the stake.
- Keep signing keys in the owner’s wallet or signing system. The compiler and planner work with public descriptors and signatures. They do not hold private keys or connect to a transport. [Configuration template](../.env.example)

### Compile and exercise locally

```sh
npm run test:treasury:vm
node scripts/treasury-covenant.mjs config
node scripts/treasury-covenant.mjs compile var/contest.json
node scripts/treasury-covenant.mjs prepare var/contest.json
node scripts/treasury-covenant.mjs assemble var/contest.json
```

The descriptor goes under `covenant` in the JSON file. All templates take `kind`, `id`, and optional `network` set to `chipnet`. Development takes three `keys`. Funded tranches take integer `principal`, a separate `reserve` in satoshis, and `refundAt` in Unix seconds. Player refunds use `ownerKey`. Opposed tranches take `opponent` and two `attestors`. A sole-claimant contract also takes `closesAt`. A seasonal voucher uses `recipient` and `rollover` addresses.

Include `funding` with the matching `txid`, `vout`, `script`, and `satoshis` when preparing a spend. Provide `spend.lane` as `return`, `opponent-wins`, `claim`, or `refund` as applicable. Development spends take `spend.outputs` with `address` and `satoshis`. The planner outputs the unsigned bytes and signing hash. The assembler accepts the ordered signatures as hex without a sighash suffix and checks the completed bytes in the BCH VM. Development uses ordered DER ECDSA signatures. Individual attestor and refund slots accept Schnorr signatures. A BCH relay is not part of these commands. [Compiler and spend planner](../packages/chain-observer/treasury-covenants.mjs)

An archived raid may be supplied as `battle` with an `admission` containing the expected covenant ID, outpoint, participant IDs and addresses, and archived battle ID and hash. The attestor path reproduces the battle and chooses the matching transaction before presenting the digest. Attestors must independently compare the supplied admission to the saved checkout and established funding record. The BCH VM checks their signatures and enforces output destinations and amounts. It cannot determine independently whether a battle record belongs to a legitimate game contest. [Raid attestation planner](../apps/game-server/treasury-attestation.mjs)

An absolute locktime opens the recovery branch once consensus permits inclusion. A previously authorized settlement or claim can still race recovery for the same outpoint. Keep the descriptor and outpoint available to the claimant outside the game server. The fixed reserve must meet the relay fee when recovery is needed, and recovery of a misfunded output requires enough value to cover that reserve and the destination’s dust threshold. The local tests run the compiled scripts and verify conflicting spends against a consumed outpoint fixture. They provide no evidence about relay policy on a future network or current treasury key availability. [Libauth BCH compiler and VM](https://github.com/bitauth/libauth) · [BCH transaction introspection](https://documentation.cash/protocol/forks/chips/2022-05-native-introspection-opcodes)
