# Treasury custody and covenant verification

> Money rules and prices: [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md). Every transaction and the contract that holds its money: [BLOCKCHAIN_TRANSACTION_MATRIX.md](BLOCKCHAIN_TRANSACTION_MATRIX.md). These contracts run on Bitcoin Cash Mainnet in the live game: [MAINNET_TRANSACTIONS.md](MAINNET_TRANSACTIONS.md).

VaultBorn matches incoming payments against exact amounts and destination scripts. It journals credits, reservations, signed settlement bytes, and confirmed spends by outpoint. Every pool of player or prize money is a contract; the developer's own receiving address is the only destination the game does not constrain. [Allocation and payouts](BLOCKCHAIN_TRANSACTION_MATRIX.md)

| Money | Contract | Who can move it |
| --- | --- | --- |
| Development share | none: paid straight to the developer's address in the payer's own transaction (optionally a 2-of-3 Development covenant) | The developer (or two of the three Development keys). The game never holds it. |
| War Chest | `war-chest-v4`, one script per owner | Game key: only to the owner's verified wallet. Capture: the attestors plus the attacker's equal stake in the same transaction. The owner alone: the two-step exit. |
| Paid raid stake | `stake-escrow-v4` | The attestor panel into fixed outcomes; the attacker alone after 3 days. |
| Territory claim, attack, raffle | `stake-escrow-v3` (raffle: keyless return) | The attestor panel; the owner after the timeout. Used on Mainnet: a claim was funded and returned to its claimant by two of the three attestors. |
| Season prize pool | pool contract, fed by keyless feeders | Game key and 2 of 3 attestors, at most 40% of a pool output per award; from 30 days after the season closes, the game key and any one attestor, or all attestors without the game key. |
| Sponsorship prizes | `prize-fund-v1` | Game key and attestors after season close; keyless refund to the sponsor. |
| Political proof reserve | `record-reserve-v2` | Game key: only as the fee of one zero-value data record; the payer after 2,016 blocks. |
| Treaty compensation | `political-escrow` v2 | Release to the payee or refund to the payer; the payer alone after its timestamp. [Political escrow](../packages/chain-observer/political-escrow.mjs) |
| Service burn | `OP_RETURN` | Nobody: provably unspendable. |

The generic templates below (Development council, raid, territory and prize tranches, seasonal vouchers) compile and execute in the BCH VM and on Regtest, and can be compiled, prepared and assembled by hand with `scripts/treasury-covenant.mjs`, for an operator who wants to settle or recover outside the game server.

### Owner configuration

- Set `CHIPNET_DEVELOPMENT_ADDRESS` (`MAINNET_DEVELOPMENT_ADDRESS` on Mainnet) to a CashAddr of that network, or set `CHIPNET_DEVELOPMENT_COUNCIL_KEYS` to three comma-separated compressed public keys and `CHIPNET_DEVELOPMENT_COVENANT_ID` to a unique 32-character lowercase hexadecimal ID.
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
