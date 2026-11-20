# VaultBorn on Bitcoin Cash Mainnet: transaction proof

VaultBorn runs on Bitcoin Cash **Mainnet** (real BCH) at **https://vaultborn.parhamlilian.com**. These are its Mainnet transactions so far: the launch record and the first game payments, made with the game's Developer Wallet (Selene Wallet, connected with WizardConnect) on the live site, and the first contract settlement, signed by the attestors.

| # | What | Transaction | Block | BCH |
|---|---|---|---|---|
| 1 | **Launch record**: the game goes live | [`7e5d53bb…a74db7cc`](https://blockchair.com/bitcoin-cash/transaction/7e5d53bbf8586c6474982f1e6c1e11a26d5444e607c0221c85a7cf1ea74db7cc) | 978,040 · 19 Nov 2026, 15:42 UTC | data output, 305 sat fee |
| 2 | **Territory claim**: Silver Mine | [`29dc9fc2…f1064483`](https://blockchair.com/bitcoin-cash/transaction/29dc9fc2022f0acc2391eb50646f93fd7558058d6ae3499a996c5d07f1064483) | 978,066 · 19 Nov 2026, 19:43 UTC | 6,600 sat into a stake escrow |
| 3 | **War Chest deposit** | [`3364cea4…fdb9eb46`](https://blockchair.com/bitcoin-cash/transaction/3364cea414af757ad4e34ba78c24aa61b34f6e2208893c716037ff88fdb9eb46) | 978,066 · 19 Nov 2026, 19:43 UTC | 10,000 sat into a War Chest |
| 4 | **Stake returned**: the Silver Mine claim settles | [`1022549a…6f7a8505`](https://blockchair.com/bitcoin-cash/transaction/1022549ae29f30d57b3327f6f381f553375a5227c197390b0564fd4a6f7a8505) | 978,094 · 19 Nov 2026, 23:56 UTC | 6,000 sat from the escrow back to the claimant, signed by 2 of 3 attestors |

Full TXIDs:

```
7e5d53bbf8586c6474982f1e6c1e11a26d5444e607c0221c85a7cf1ea74db7cc   launch record
29dc9fc2022f0acc2391eb50646f93fd7558058d6ae3499a996c5d07f1064483   territory claim (Silver Mine)
3364cea414af757ad4e34ba78c24aa61b34f6e2208893c716037ff88fdb9eb46   War Chest deposit
1022549ae29f30d57b3327f6f381f553375a5227c197390b0564fd4a6f7a8505   stake returned (Silver Mine claim settlement)
```

## What each one shows

**1. Launch record.** Its data output is `VBLN` (VaultBorn launch), version 1.0, followed by
`1229172ec9f78e578fe785902abb00e04b714e09f5d4fc3d716eeead763cf5f9`, the SHA-256 hash of
[`docs/mainnet/launch-manifest.json`](mainnet/launch-manifest.json): the game key, the three attestor keys, the 2-of-3
threshold, the price book (`prices-v2`) and the contract versions the game runs. Anyone can hash the file and compare.

**2. Territory claim.** A claim on the Silver Mine territory: 6,600 sat (a 6,000 sat stake and a 600 sat settlement
reserve) locked in a `stake-escrow-v3` contract,
`bitcoincash:pv2wz3qzkt5vj0dmhdzjt3jak06gcv586hu0zrhdsn9jyq9mcy086zq68mrry`, plus a VaultBorn event record (`VBRN`).
The contract lets the stake go only to the claimant or by the outcome of the contest; after its refund time the
claimant's own key takes it back.

**3. War Chest deposit.** 10,000 sat locked in the player's own `war-chest-v4` contract,
`bitcoincash:p0ynysmzfzsvlkd6s8zew2wq5cz68w5d3yf2v6thhj0rw02usd5cxe7t9a66m`, plus a `VBRN` event record. That money is
at risk in PvP raids under matched stakes; the owner's wallet key alone can always take it out through the contract's
two-step exit (about two days).

Both game payments were signed in the player's wallet through WizardConnect. Nothing was sent without the wallet's
approval.

**4. Stake returned.** The Silver Mine claim could not be entered when its payment became final, so the claim settled
on the return lane of its `stake-escrow-v3` contract. Two of the three attestors signed it (the game key alone cannot
open any lane), the escrow paid the 6,000 sat stake back to the claimant's wallet that the contract fixed at funding
(`bitcoincash:qpq4lhslz9kpkka6mxt0lg67lzama0k3pvkgxm6777`), and the 600 sat settlement reserve paid the network fee.
Its `VBRN` event record names the claim it settles. This is a contract spend on Mainnet by the attestor panel, the same
path that settles raids and territory contests.

As of block 978,155 the War Chest deposit is unspent: the War Chest holds its 10,000 sat.

## Check it yourself

On an explorer: open each link above and look for the data output (`OP_RETURN`) and the contract output.

Offline, from this repository:

```sh
npm install
npm run verify:mainnet
```

[`scripts/verify-mainnet-proof.mjs`](../scripts/verify-mainnet-proof.mjs) reads
[`docs/mainnet/transactions.json`](mainnet/transactions.json) (the raw transactions, their block headers and Merkle
branches, as served by public Fulcrum servers) and checks that:

1. each raw transaction hashes to its TXID;
2. its Merkle branch leads to the Merkle root of its block header, the header hashes to the named block, and the
   header carries the proof of work its target claims;
3. the launch record's data output is `VBLN` + version + the SHA-256 of the launch manifest;
4. the War Chest deposit pays exactly the `war-chest-v4` contract that this repository builds from the manifest's game
   key, attestors and threshold and the depositor's own public key (read from the transaction's input);
5. the game payments carry a VaultBorn event record (`VBRN`);
6. the settlement spends the claim's escrow output, reveals exactly that escrow contract (its hash is the claim
   output's P2SH32 hash) with the manifest's three attestor keys, carries two attestor signatures, and pays 6,000 sat to
   the wallet fixed in the contract, the 600 sat reserve being the fee.

Expected output ends with `All checks passed.` That a block belongs to the main chain is confirmed by the explorer or
any Bitcoin Cash node.

## Keys and addresses

| Role | Value |
|---|---|
| Developer Wallet (receives the Development share; paid the two game payments and received the returned stake) | `bitcoincash:qpq4lhslz9kpkka6mxt0lg67lzama0k3pvkgxm6777` |
| Game key | `032221720577fdc2238af7acac6a6ed311ece59565290036da4dd29a695933a556` |
| Attestors (2 of 3 sign raid outcomes and prizes; run by the VaultBorn team) | `021e13dd…7411e`, `02d2bb3e…0d750`, `025f9a40…08fd8` (full keys in the manifest) |

The live game also lists its own payments in its public ledger: https://vaultborn.parhamlilian.com/ledger.html
