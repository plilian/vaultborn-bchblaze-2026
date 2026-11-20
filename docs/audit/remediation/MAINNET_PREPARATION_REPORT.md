# VaultBorn — final fixes, game consistency and Mainnet preparation

Date: 19 November 2026. This is the single report of this pass. `FINAL_ECONOMY_REPORT.md` remains the reference for the economy itself; this report supersedes its sections on open issues and Mainnet readiness.

> **Update, 20 November 2026:** this report describes the state before launch. VaultBorn has since gone live on Bitcoin Cash Mainnet at https://vaultborn.parhamlilian.com, with real, confirmed transactions; see [../../MAINNET_TRANSACTIONS.md](../../MAINNET_TRANSACTIONS.md).

**Where things stand.** The remaining issues are fixed, the game's content matches the final economy, and the whole project can now be configured for Bitcoin Cash Mainnet. **Nothing was launched:** no Mainnet transaction was built for broadcast, no real BCH moved, no wallet was contacted and nothing was deployed. The server refuses to start on Mainnet until you write your authorisation into its configuration.

**Readiness, stated plainly.** The software is prepared. I do not call it ready for real money yet, because one essential condition is still unverified: the current contracts and wallet payments have never run on a public network (section 4).

## 1. Remaining issues fixed

| Issue from the last report | What is done now |
|---|---|
| A payment could succeed while the action it bought had become invalid, and half the price was gone. | **A paid service is never lost, but it is not refunded in BCH.** The credit described here is a record in the game server's database; no BCH is sent back, and it cannot be withdrawn or transferred. If the action cannot be applied when the payment is final (the upgrade finished, the treaty lapsed, the checkout expired, or an internal fault), the payment becomes a credit for that kind of service. The player's next request of the same kind is delivered at once, with no checkout and no payment. Credit and game action change in one database transaction, so a repeated request cannot use it twice. The War Chest page, the price labels ("free · already paid") and the payment dialog show it. Stakes were already safe: a raid that cannot be fought is void and returns the stake. |
| The 576-sat proof reserve of a failed or cancelled political operation was locked for good. | New reserve contract `record-reserve-v2`: the game key can still spend it only as the fee of the proof record, and if no record is published the payer's own key takes it back once it is 2,016 blocks old (about two weeks). When a credited operation is delivered later, its proof is paid by the original reserve. `scripts/owner-recover.mjs` recovers a reserve. |
| Quote and settlement differed for withdrawals: asking for 25,000 sat took 27,000 out of the War Chest and paid 25,872. | The amount asked for, in whole thousands, is exactly what leaves the War Chest; the wallet receives it less the fee. Quote, review dialog, signed transaction and accounting now show the same three numbers. Emptying a War Chest in one step works. |
| The payout tool's Electrum adapter was never exercised. | Tested against an in-memory chain (unspent outputs, spends, broadcast, confirmations). It still has not talked to a live server. |
| Evidence for prize recovery existed only if someone exported it. | The attestor process saves each season's evidence bundle on its own runs (done in the previous pass, now documented in the attestor guide). |
| Attestors, payout tool and owner tool could be pointed at the wrong network. | Each refuses a server, node, bundle or address of another network. |

One contract version changed in this pass, because the fix required it: `record-reserve-v1` → `v2`. Prices, the 50/20/20/10 and 30/70 splits, the War Chest and the matched-stakes raid are unchanged.

## 2. Game content and behaviour corrected

- **War Chest page (in game):** renamed from "War Vault"; shows services owed to you; the old "Kingdom treasury / Battle exposure" view and the closed vault deposit wording are gone; a direct link to the War Chest withdrawal.
- **Public accounts page:** the "Commit treasury to battles / Set commitment / up to 20%" form and its handler are removed (the server endpoint was already closed). Withdrawal form and review dialog explain the exact-amount rule.
- **Tutorial:** three steps reworded for matched stakes and the War Chest ("your treasury is safe", "competitive stakes can be lost").
- **Guide and FAQ:** raid, territory and payment entries corrected; new entries for owed services and withdrawals; the test-network sentence is now network-specific.
- **Dialogs and labels:** payment titles ("Kingdom treasury withdrawal", "Vault withdrawal"), descriptions ("operator signs…", "credited to your kingdom"), the political checkout note ("existing fee split"), the late-payment message, and a dead "War vault" statistic.
- **Documentation:** `docs/ECONOMY_DESIGN.md` and `docs/BLOCKCHAIN_TRANSACTION_MATRIX.md` are rewritten as the current rules and transaction list. Outdated paragraphs in eight design documents are corrected, and five reports of earlier Chipnet runs are marked as historical records. README and SECURITY are updated.
- Missions, objectives, building, research and combat texts were checked and needed no change.

Battle reports of raids fought under the earlier rules still show those rules, on purpose: they describe what happened then.

## 3. Mainnet infrastructure prepared

**One switch.** `VAULTBORN_NETWORK=mainnet` changes everything together (`config/network.mjs`): `bitcoincash:` addresses, `MAINNET_…` configuration variables, the Electrum servers, explorer links, and the block that identifies the chain (661648, which exists on Bitcoin Cash only and is the checkpoint compiled into Bitcoin Cash Node).

**Wrong-network protection.**

- An address of the other network is refused before it is decoded.
- Every observer session checks the identifying block first.
- On Mainnet, any `CHIPNET_` variable present stops the start; Mainnet keys are read from `MAINNET_` variables only.
- A database holding payments of the other network is refused.
- All fourteen Chipnet test tools stop immediately on Mainnet.
- The browser takes the network from the server; Selene on the wrong network is refused at pairing; the checkout shows a real-money notice.

**Start conditions on Mainnet.** The server lists every unmet condition and refuses to start: your authorisation line, demo seats off, TLS on, a database file, covenant custody, the final split and price book, the game key, your developer address, at least two independent attestor keys (none equal to the game key), at least two confirmations, and a second observer when no own node is used.

**Contracts.** Scripts are identical on both networks for the same keys; only the address prefix differs. No contract has to be deployed or funded in advance.

**Files added.**

| File | Purpose |
|---|---|
| `mainnet.env.example` | Mainnet configuration template |
| `scripts/mainnet-preflight.mjs` (`npm run preflight:mainnet`) | Checks the configuration and prints what is missing; sends nothing |
| `scripts/network-keys.mjs` | Creates a key on the machine it runs on and prints only the public half |
| `scripts/token-genesis.mjs` | Prepares the optional CashTokens category; dry run unless told to broadcast |
| `infrastructure/mainnet/` | Docker Compose with a TLS proxy, systemd units for server and attestor, database backup script |
| `docs/MAINNET.md`, `docs/ATTESTOR_GUIDE.md` | Runbook (keys, backups, recovery, funding, launch steps) and attestor instructions |

## 4. What is still blocked

1. **No public-network run of the current contracts.** They pass in the BCH virtual machine, on a private Bitcoin Cash Node Regtest chain with standard relay rules, and in a full local lifecycle with the process set to Mainnet. They have not run on Chipnet or Mainnet, and no real wallet has signed the new payment shapes. The Chipnet rehearsal (`docs/MAINNET.md`, step 0) closes this; it needs a machine with network access and faucet coins, which this environment does not have.
2. **Independent attestors do not exist yet.** At least two people who are not you must each create a key and run the attestor. Until then paid activity cannot be opened on Mainnet at all.
3. **The public Electrum server names for Mainnet are from memory of the Electron Cash list and were not contacted.** `npm run preflight:mainnet -- --online` checks them read-only; your own node is the better source.
4. **No external audit** of `war-chest-v4`, `stake-escrow-v4` and `record-reserve-v2`.
5. **Legal review.** Real-money stakes between players and prize pools are regulated in many places. I am not a lawyer; this needs a decision from you before real BCH is accepted.
6. Unchanged trust limits: a colluding game key and attestor majority could sign a false raid outcome (limited to that raid's stake) or prize; player commands are not signed, so non-battle scores are rule-checked, not proven.

I know of no critical defect in the code. Items 1 and 2 are the reason I do not mark the project ready for real money.

## 5. What you need to provide

**1. Ready or blocked?** Prepared, blocked by items 1 and 2 above (and your decision on 5).

**2. Which wallet, and how.** The game never connects to your wallet to operate. Your Development income arrives at an address you give it. To play or test, pair Selene (set to Mainnet) or another WizardConnect wallet in the game's wallet pane by scanning the code; each payment is then shown in the wallet for approval.

**3. Addresses and keys to configure (`.env.mainnet`).**

| Setting | What | Who holds the private key |
|---|---|---|
| `MAINNET_DEVELOPMENT_ADDRESS` | your one receiving address (`bitcoincash:…`) | you, in your own wallet |
| `MAINNET_TREASURY_KEY_FILE` | the game automation key, created on the server | the server |
| `MAINNET_PRIZE_ATTESTOR_KEYS` | two or three attestor **public** keys | each attestor, on their own machine |
| optional `MAINNET_TERRITORY_…`, `MAINNET_POLITICS_…` | CashTokens issuer | the server |
| `VAULTBORN_MAINNET_ACK=real-bch` | your authorisation, set last | |

**4. BCH needed.**

| Purpose | Amount | Network fees | Returns to you | Other |
|---|---:|---:|---:|---|
| Running the game | **0** | | | Fees are paid from each payment's own reserve, the War Chest being withdrawn, or the prize pool. |
| Launch test with two of your own wallets (recommended): one service, one deposit, one raid at the smallest stake, two withdrawals | 52,000 sat (0.00052 BCH) | about 3,700 | about 41,000 (War Chest balances, the stake, your Development share) | 2,200 burned; 4,700 stays in the season prize pool |
| The same with one political operation | + 22,000 sat | about 700 | 14,000 | 2,000 burned; 4,000 to the prize pool; 876 reserves |
| Game key float (optional) | 20,000 sat | used only to return mis-sent payments | | |
| CashTokens collectibles (optional) | 50,000 sat per category | about 500 per collectible | | 1,500 sat travel with each collectible to its holder |
| First season's prizes (optional) | 0.25 BCH or more, as a sponsorship | wallet fee | 30% (your Development share) | 70% is prize money |

The launch-test figures are estimates from the measured transaction sizes at 1 sat per byte.

**5. Contracts needing initial funding.** None. Every contract output is created by a player's payment or a sponsor's.

**6. What I can do after your authorisation.** From this environment I cannot reach Chipnet or Mainnet, and the command shell on your computer does not start (it reports too little free disk space). So today I can review your preflight output and Chipnet rehearsal results, fix whatever they show, and update the configuration files and records. If the shell on your computer becomes available with network access, I can also run the preflight, the Chipnet rehearsal and a local start there. I would not deploy to a public server or broadcast on Mainnet without your explicit instruction for that step.

**7. What needs you.**

- Creating the developer address in your wallet, and choosing two or three independent attestors.
- Running `scripts/network-keys.mjs` on the server (and each attestor on theirs): private keys should never pass through me.
- Filling in `.env.mainnet`, running `npm run preflight:mainnet`, providing a server and a domain name.
- Running the Chipnet rehearsal and approving payments in Selene.
- Setting `VAULTBORN_MAINNET_ACK=real-bch` and starting the server.
- Approving the launch-test payments in your wallets.

## 6. Tests run in this pass

Only what this pass changed, plus the Mainnet safety checks. Everything else relies on the evidence of the previous pass.

| Check | Why it was run | Result |
|---|---|---|
| New tests: service credit (2), reserve recovery and credited political operation (2), network isolation and Mainnet start conditions (4), Electrum adapter (1) | new behaviour | pass |
| Unit suite, once | the network change touched about 40 files | 224 of 224 |
| Regtest, once | the reserve contract gained a lane | 145 pass, 0 fail (4 new cases) |
| Local attestor lifecycle with the process set to Mainnet | Mainnet configuration end to end, in the virtual machine | 11 of 11 (`evidence/mainnet-profile-lifecycle.json`) |
| The same lifecycle on the Chipnet profile | credit, reserve and withdrawal code changed | 11 of 11 |
| Both browser suites, once each | pages and wording changed | pass |

Not rerun: economic simulations. The Mainnet-profile lifecycle is a local run with fixture keys; it shows that the Mainnet configuration works, not that anything ran on Mainnet.
