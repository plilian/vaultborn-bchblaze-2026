# Running VaultBorn on Bitcoin Cash Mainnet

Status on 20 November 2026: **live on Mainnet** at https://vaultborn.parhamlilian.com since the launch record in block 978,040 (19 November). The first real game payments, a territory claim and a War Chest deposit, confirmed in block 978,066, and the claim's escrow settled in block 978,094 with the signatures of two of the three attestors. All of them, with an offline check, are listed in [MAINNET_TRANSACTIONS.md](MAINNET_TRANSACTIONS.md). The server refuses to start on Mainnet until the owner writes the authorisation into the configuration (step 7).

**Tested on Mainnet.** The game is live on Bitcoin Cash Mainnet and real transactions have been signed in a real wallet (Selene, through WizardConnect) and confirmed: the launch record (block 978,040), a territory claim into `stake-escrow-v3` and a War Chest deposit into `war-chest-v4` (block 978,066), and the claim's settlement, opened by two of the three attestors without the game key (block 978,094). See [MAINNET_TRANSACTIONS.md](MAINNET_TRANSACTIONS.md). Every contract path (raid captures, settlements, exits) is also covered in the BCH virtual machine and on a Bitcoin Cash Node Regtest chain. Anyone running their own copy should do the Chipnet rehearsal in step 0 first.

## The launcher (the short way)

The owner starts Mainnet with a small local launcher, a page that runs on the owner's computer only. It is an owner's tool and is kept outside the public repository. It does by itself what the manual route below does by hand: it connects the owner's Developer Wallet with WizardConnect, shows its Mainnet balance, lists the funding (nothing is mandatory except the network fee of one public launch record), and sends one launch transaction to the wallet for approval; nothing is broadcast before the owner approves it there. It then waits for confirmations, creates and checks the operational keys, writes `.env.mainnet`, and starts the game and its attestors, on that computer or on a Linux server that stays online. It never asks for a seed phrase or a private key of the owner's wallet. The launch record is a public data output that carries the hash of the keys and rules the game was launched with.

The attestors the launcher runs are run by the VaultBorn team: they do every check an attestor does, and the owner holds the game key and all three attestor keys; the game's rules say so. Everything below is the manual route and the background.

## How the network is chosen

One process works on one network. `VAULTBORN_NETWORK=mainnet` switches everything together (`config/network.mjs`):

| | Chipnet | Mainnet |
|---|---|---|
| Addresses | `bchtest:` | `bitcoincash:` |
| Configuration variables | `CHIPNET_…` | `MAINNET_…` |
| Configuration file | `.env` | `.env.mainnet` |
| Block that identifies the chain | 302144 | 661648 (exists on Bitcoin Cash only) |
| Explorer links | chipnet.imaginary.cash | blockchair.com/bitcoin-cash |

Protection against the wrong network:

- An address of the other network is refused before it is decoded.
- Every observer session first checks the identifying block; a server or node of another chain is refused.
- With `VAULTBORN_NETWORK=mainnet`, any `CHIPNET_` variable present stops the start. Mainnet keys are only read from `MAINNET_` variables.
- A database that holds payments of the other network is refused. Mainnet starts with a new database.
- Every Chipnet test tool (`scripts/chipnet-*.mjs`) stops immediately on Mainnet.
- The browser learns the network from the server; a Selene wallet on the wrong network is refused at pairing. The server builds every payment from coins it found on its own network, so a wallet on another network has nothing to sign.
- Attestors and the payout tool refuse a server, node or evidence bundle of another network.

Contract scripts are identical on both networks for the same keys; only the address prefix differs.

## What you need

| Item | Who creates it | Where it lives |
|---|---|---|
| Developer receiving address | you, in your own wallet | `MAINNET_DEVELOPMENT_ADDRESS` (address only; the game never has its key) |
| Game automation key | the server operator, on the server | `var/mainnet/game.key` (file, mode 600) |
| Two or three attestor keys | each attestor, on their own machine | only the **public** keys go into `MAINNET_PRIZE_ATTESTOR_KEYS` |
| Optional CashTokens issuer key | the server operator | `var/mainnet/issuer.key` |
| A server with a domain name | you | Node 24, or Docker |

No contract has to be deployed or funded in advance. Every contract output is created by a player's payment or a sponsor's.

## Funding

| Purpose | Amount | Kind |
|---|---:|---|
| Running the game | **0 BCH** | Nothing is required. Fees are paid by the reserves inside each payment, by the War Chest being withdrawn, or by the prize pool for its awards. |
| Game key float (optional) | 20,000 sat | Network fees for returning a payment someone mis-sent. Not used in normal operation. |
| Launch test with two of your own wallets (recommended) | 52,000 sat (0.00052 BCH): 40,000 in the first wallet, 12,000 in the second | About 41,000 sat returns to you (War Chest balances, stake, your Development share). About 2,200 is burned, 4,700 stays in the season prize pool and roughly 3,700 is network fees. |
| The same test including one political operation | + 22,000 sat | 14,000 returns (War Chest and Development share); 2,000 burned, 4,000 to the prize pool, about 1,300 reserves and fees. |
| CashTokens collectibles (optional) | 50,000 sat per category | Creates the category and about 24 collectibles (about 2,000 sat each: 1,500 travel with the token to its holder, about 500 are the fee). |
| Seeding the first season's prizes (optional) | 0.25 BCH or more, as a sponsorship | 30% returns to your Development address; 70% is prize money. |

## Steps

**0. Rehearse on Chipnet first.** `node scripts/chipnet-covenant-fixture.mjs var/covenant-keys.json`, fund the two printed addresses from a Chipnet faucet, then run `scripts/chipnet-covenants-e2e.mjs` as described in its header. Pair Selene (Chipnet mode) with the local game and make one payment. This rehearses on test coins what the live launch did on Mainnet.

**1. Keys.** On the server: `VAULTBORN_NETWORK=mainnet node scripts/network-keys.mjs new var/mainnet/game.key`. Each attestor does the same on their own machine (see `ATTESTOR_GUIDE.md`) and sends you the public key only.

**2. Configuration.** Copy `mainnet.env.example` to `.env.mainnet` and fill in your developer address, the attestor public keys and, if you have one, your own node. Leave `VAULTBORN_MAINNET_ACK` empty.

**3. Preflight.** `npm run preflight:mainnet` checks the configuration and prints the developer address, the game key's public half, the attestors and every problem. It sends nothing. Add `-- --online` to also ask the observers, read-only, for the identifying block.

**4. Attestors.** Each attestor installs the project, sets `VAULTBORN_NETWORK=mainnet` and schedules `scripts/prize-attest.mjs` against your public address (`infrastructure/mainnet/attestor.service` and `.timer`).

**5. Server and site.** Docker: set `DOMAIN` and run `docker compose -f infrastructure/mainnet/compose.yaml up -d` (game server plus a TLS proxy). On a server where nginx already serves other sites, use `DOMAIN=play.example.org bash infrastructure/mainnet/install-behind-nginx.sh` instead: the game then listens on the server itself only (127.0.0.1), runs as its own Docker project, and gets one nginx site file and one certificate of its own; no existing site is edited, nginx is only reloaded after its configuration test has passed, and a failed step takes its additions out again (`… install-behind-nginx.sh remove` takes the game off the server). That script installed the live game at vaultborn.parhamlilian.com on a server shared with other sites, and its tests run it against a simulated server (`tests/server-install.test.mjs`); read it before you run it on yours. Without Docker: `infrastructure/mainnet/vaultborn.service`. Schedule `infrastructure/mainnet/backup.sh`.

**6. Optional collectibles.** Fund the issuer address, then `scripts/token-genesis.mjs` (dry run first, `--broadcast` when you agree) and add the printed lines to `.env.mainnet`.

**7. Authorisation.** Only when you decide that real BCH may move: set `VAULTBORN_MAINNET_ACK=real-bch` in `.env.mainnet` and start the server. Until then it refuses to start on Mainnet.

**8. Launch test.** With two of your own wallets: buy one service, deposit into the second wallet's War Chest, fight one paid raid at the smallest stake, and a day later withdraw both War Chests. Compare each wallet receipt with the amounts the game showed beforehand.

## Keys, backups, recovery

- **Developer wallet:** yours alone. Losing it loses future Development income, nothing else.
- **Game key:** keep one offline copy of `var/mainnet/game.key`. If it is stolen, no player or prize money can be taken with it alone: it can only force War Chests back to their owners. If it is lost, players leave with their own keys (War Chest exit, stake refunds), and the season pool is paid by all attestors together from 30 days after the season closed.
- **Attestor keys:** each attestor keeps their own copy. With three attestors, one may be lost or offline. If a majority is lost, raids stop settling (stakes refund to attackers after 3 days) and the season pool needs the game key plus one attestor from 30 days after close.
- **Database:** `backup.sh` makes a consistent copy while the game runs. The database holds no private keys. Restoring an older copy loses the game's own record of what happened since. No money is lost by that, because it sits in contracts that their owners can leave with their own keys, but a service paid for in the gap would have to be honoured by hand. Back up often.
- **Players without the server:** `scripts/owner-recover.mjs` (War Chest exit, stake refunds, proof reserve). **Prizes without the server:** `scripts/attestor-payout.mjs` with the evidence bundles the attestors save on every run.
- **Stopping paid activity:** set `MAINNET_GAME=false` and restart. The game continues as free play; nothing held by a contract depends on the server.

## What remains trust on Mainnet

- **A service credit is not a BCH refund.** A paid service that cannot be delivered when its payment confirms becomes a credit for the same kind of service, kept in the game server's database. No BCH is returned, and the credit cannot be withdrawn, transferred or exchanged. It is honoured only while the game server runs and keeps that database.


- **Attestors.** In this deployment they are run by the VaultBorn team. Who runs an attestor cannot be proven by code: a colluding game key and attestor majority could sign a false raid outcome (limited to the stake of each raid) or a false prize. Battle outcomes are verified by replay; building, research and mission scores are checked against the rules but player commands are not signed.
- **Audit.** No third-party audit of the contracts has been done.
