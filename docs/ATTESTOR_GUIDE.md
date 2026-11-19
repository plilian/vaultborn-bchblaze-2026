# VaultBorn attestor guide

An attestor is an independent person or organisation that checks game outcomes before money moves. Without attestor signatures no War Chest can be captured, no contested stake can be settled and no prize can be paid. The game operator cannot do any of this alone. You must not be the operator, and you should not share a machine or a key with another attestor.

## What you sign, and what you check first

Your tool does the checking; it signs nothing it could not rebuild itself.

| Proposal | What the tool verifies before signing |
|---|---|
| Paid raid outcome | Replays the recorded battle and compares the winner with the proposed outcome; rebuilds the transaction and checks every output and amount against the escrow that was funded. |
| Territory contest | Compares the proposed payout with the published contest record. |
| Season prize | Rebuilds the ranking from the published score journal, replays its battles, checks the on-chain anchors, the 85/15 split and the 40/25/15/10/10 shares, and refuses a result that changed after it first saw it. |

If anything does not match, the tool prints the reasons and does not sign. That is the correct behaviour, not an error to work around.

## Set-up (once)

1. Install Node 24 and a copy of the project on your own machine.
2. Choose the network for everything that follows: `export VAULTBORN_NETWORK=mainnet` (or leave it unset for Chipnet).
3. Create your key: `node scripts/network-keys.mjs new ~/vaultborn/attestor.key`. Send the operator the **public key** it prints. Never send the file.
4. Make an offline backup of the key file. Whoever holds it can sign as you.

## Running

One run reviews everything that is waiting and signs what passes:

```
PRIZE_ATTESTOR_KEY_FILE=~/vaultborn/attestor.key \
PRIZE_ATTESTOR_PINS=~/vaultborn/pins.json \
PRIZE_ATTESTOR_BUNDLE_DIR=~/vaultborn/bundles \
node scripts/prize-attest.mjs https://<the game's address> --approve
```

Without `--approve` it only prints what it checked. Schedule the command every few minutes (`infrastructure/mainnet/attestor.service` and `attestor.timer`, or cron, or Task Scheduler) so that raids settle promptly: an attacker's stake refunds itself after three days, and a defender who has started an exit can leave after about two days.

- `pins.json` is your own memory of what you have seen. Keep it; it is what detects a rewritten season.
- `bundles/` receives a copy of each closed season's evidence. Keep it too: it is what lets prizes be paid if the game server disappears.

The tool refuses a server that runs on another network than your `VAULTBORN_NETWORK`.

## If the game server is gone

Prizes can still be paid from the evidence you saved, with `scripts/attestor-payout.mjs` and a Bitcoin Cash node or Electrum server:

```
node scripts/attestor-payout.mjs status  --bundle bundles/season-7.json --config config.json --electrum <host:port>
node scripts/attestor-payout.mjs propose --bundle … --config … --rank 1 --out rank1.json --electrum …
node scripts/attestor-payout.mjs sign    rank1.json --bundle … --config … --key-file ~/vaultborn/attestor.key --electrum …
node scripts/attestor-payout.mjs send    rank1.json --bundle … --config … [--game-key-file game.key] --electrum …
```

`config.json` holds public keys only: `{ "operatorKey": "<game public key>", "attestors": ["…", "…", "…"], "threshold": 2 }`. Each attestor runs `sign` on their own machine and passes the file on. Who must sign is fixed by the contracts: the game key and a majority of attestors; from 30 days after the season closed the game key and any one attestor; or, if the game key is lost, all attestors together from that same date. A sponsor's own fund is not paid this way: it returns to the sponsor by itself after its refund date.

## What you are trusted with

If a majority of attestors colluded with the operator, they could sign a false raid outcome (limited to the stake of that raid) or a false prize. Your independence is the protection. Refuse to sign by hand anything the tool refused.
