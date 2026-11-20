# VAULTBORN payments and treasury

How the game's Bitcoin Cash payments are built, recorded and checked. The money rules themselves (prices, shares, stakes,
prizes) are in [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md), and every transaction the game can cause, with the contract that
holds its money, is in [BLOCKCHAIN_TRANSACTION_MATRIX.md](BLOCKCHAIN_TRANSACTION_MATRIX.md). The live game runs on
Mainnet; its transactions so far are in [MAINNET_TRANSACTIONS.md](MAINNET_TRANSACTIONS.md).

## Checkout

A paid action becomes a payment intent with exact outputs. The server builds the transaction from the player's own coins
(found on the network the server runs on), and the player's wallet, paired through WizardConnect, shows every output and
the fee before the player approves it. Nothing is sent without that approval. A service payment is split by the payer's
own transaction: 50% into the payer's War Chest contract, 20% into the season prize pool (through a keyless feeder), 20% to
the developer's address and 10% burned in a value-carrying `OP_RETURN` output. Network reserves are separate lines and
never change the percentages. Stakes (paid raids, territory claims and attacks) and War Chest deposits go into their own
contracts in full.

If the action can no longer be applied when the payment is final, the payment is not lost: a service is owed as the next
one of the same kind (a credit in the game, not a BCH refund), a raid is void and its stake returns, and a territory claim
returns its stake.

## Event records

Every game payment and settlement carries a zero-value data output: the four-byte identifier `VBRN` and 34 bytes holding
version `01`, a one-byte event code and a 32-byte SHA-256 digest. The digest is taken over UTF-8 JSON with lexical key
order and original array order; the preimage has version, kind, subject and data fields
(`packages/chain-observer/vaultborn.mjs`). A payment commits to the quoted action, its allocation, the price book and the
head of the season score journal; a settlement commits to the transaction it settles and, for a raid, to the hash of the
recorded battle. The launch itself was recorded with `VBLN`, version and the SHA-256 of the launch manifest.

## Observation

The chain observer finds a payment by its unique outputs and checks every expected output (script and exact amount), the
transaction hash and its block inclusion, on Electrum servers of two different operators or an own Bitcoin Cash Node. Each
TXID belongs to one intent. Unexpected or late transfers go to the operator's attention list. A detected reorganization
pauses the affected settlements until the chain view agrees again. Outgoing transactions keep their reserved inputs and
signed bytes across restarts, so a retry broadcasts the same TXID.

## Matched-stake raids

A paid raid is offered only when the defender's War Chest holds at least the attacker's stake S. The attacker's stake and
a network reserve go into a `stake-escrow-v4` contract. If the attacker wins, one transaction pays the attacker exactly
2 × S: the escrow and S from the defender's War Chest. If the defender wins, the defender's wallet receives S. A void raid
returns S. Every outcome is opened by the attestor panel (2 of 3) after each attestor has replayed the recorded battle; the
game key alone opens none. After three days without a settlement the attacker's key alone takes the stake back. The same
two kingdoms can fight one paid raid per 24 hours; allies cannot stake against each other. Free raids use the same combat
and move only game resources.

## Custody and prizes

There is no operator-held pool. Each player's War Chest is a `war-chest-v4` contract of the player's own key: the game key
can pay it only to the owner's verified wallet, a capture needs the attestors and an equal stake in the same transaction,
and the owner can always leave through the two-step exit (288 blocks). Season prizes sit in the pool contract; at season
close 85% is awarded to the top five (40 / 25 / 15 / 10 / 10 percent) and 15% carries over. Attestors rebuild the ranking
from the public score journal, replay its battles and sign only awards that follow from it. In this deployment the
attestors are run by the VaultBorn team.

## Sponsors and the Council

A sponsor pays 0.25 to 25 BCH for a season (Season Banner from 0.5 BCH, Title Sponsor from 2 BCH): 30% to the developer's
address and 70% into a `prize-fund-v1` contract, from which prizes leave only with the attestors' signatures after the season
closes; what is not awarded returns to the sponsor without any key. Campaigns have a title, sponsor name, HTTPS link,
schedule and optional logo, are approved by the administrator, and report at most one impression and click per account
per day.

Council members are players with a verified wallet and a score of at least ten. A member may propose one
payment of 600 to 100,000 satoshis at a time; voting lasts three days, needs at least three voters and a quarter of the
members, and passes with 60% of the yes and no votes. A passed proposal is paid by the administrator with an exact quote.

## Battle verification

Participants can inspect a battle record at once; archived records become public after 24 hours, so that active garrisons
are not disclosed. The JSON view holds the inputs, the rules fingerprint, the seed, losses, rounds, the result hash and the
transactions that carried the raid.

```sh
node scripts/verify-battle.mjs path/to/battle.json
node scripts/verify-battle.mjs path/to/battle.json --chain
```

The first command replays the battle and checks the archive hashes. The second also checks the recorded initiation and
settlement on the network chosen by `VAULTBORN_NETWORK` (`mainnet` for the live game).
