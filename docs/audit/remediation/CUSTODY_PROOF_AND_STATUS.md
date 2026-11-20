# VaultBorn — Custody proof per pool, final audit and open limits (third pass)

> **Dated report (19 November 2026),** written before the Mainnet launch. Its findings are kept as they were written; its statements about what had not yet run, and about Mainnet readiness, describe that day. VaultBorn has since gone live on Bitcoin Cash Mainnet, with wallet-signed payments and a contract settlement signed by the attestors. Current state and evidence: [STATUS.md](../../STATUS.md) · [MAINNET_TRANSACTIONS.md](../../MAINNET_TRANSACTIONS.md).

> **Superseded on 19 November 2026 by `FINAL_ECONOMY_REPORT.md`** (final price book, matched-stakes raids, one War Chest). Kept for history; prices, raid rules and custody described below are no longer current.

> **Superseded.** The service split is now 50/20/20/10 and the kingdom vault has been replaced by one War Chest. See [`FINAL_REMEDIATION_REPORT.md`](FINAL_REMEDIATION_REPORT.md).

Date: 19 November 2026. This document supersedes the custody statements in `REMEDIATION_REPORT.md` and the earlier version of this file.

**Summary.** With the developer address, at least one independent attestor key and covenant custody configured (the default), every new non-Development output is created inside a contract and no path lets the game key send it to an arbitrary address. Four limits remain and are listed in section 4; two of them mean a stated requirement is only partly met. Outputs created before this work are still operator-held. Nothing was run on Chipnet or Mainnet, and the browser and wallet suites were not run.

## 1. Who can spend what

"Game key" is the single automation key on the server. "Attestor" is a key configured in `CHIPNET_PRIZE_ATTESTOR_KEYS` whose secret is never on the server.

| Pool | Contract | Who must sign | Where the contract lets it go | Can the developer move it arbitrarily? | If the server disappears |
|---|---|---|---|---|---|
| Development (20% of services, 30% of sponsorships) | The one developer address | Developer | Anything | Yes — the one developer-controlled destination | Unaffected |
| Kingdom Treasury (65% share) | `kingdom-vault-v2`, one output per payment | Game key; or owner after 7 days | The whole output to the owner's wallet, once, less at most 700 sat fee. No change, no re-issue | No | Owner spends alone (`scripts/owner-recover.mjs`) |
| At-risk funds | `war-chest-v2`, funded only by the owner's wallet | Release: game key. Capture: game key **and every attestor**. Recovery: owner after 3 days | Release: owner's wallet, change back to the chest, output 144 blocks old. Capture: at most 20% of an output, rest back to the chest, output 144 blocks old | No. The server cannot capture alone | Owner spends alone |
| Service prize share + kingdom share in transit | `prize-carrier-v2` (no key at all) | Nobody | Sweep: prize share into the season pool, kingdom share into the payer's vault. Refund after 14 days: everything to the payer's wallet | No | Anyone can sweep or refund |
| Service prize pool (10%) | Season pool: `prize-fund-v1` without a sponsor | Award: game key **and every attestor**. Top-up: nobody | Award: after season close, at most 40% of the pool per award, rest back to the pool. Top-up: only back into the pool with at least 300 sat more | No | Locked. Not stealable, but not recoverable without the attestors (see 4.2) |
| Sponsorship prizes (70%) | `prize-fund-v1` per sponsorship | Award: game key **and every attestor**. Refund: nobody | Award as above. Refund after `refundAt`: the sponsor's wallet | No | Sponsor refunded by a keyless transaction |
| Raid stake and its reserve | `battle-escrow` v2 | Game key picks one of two lanes; attacker after 3 days | Whole stake to the attacker, or half each to the attacker and the defender named at funding | No third address is possible. The lane choice is the server's (see 4.1) | Attacker refunds alone |
| Territory attack stake | `territory-escrow` v2 | As the raid stake; owner refund after 7 days | Attacker, or attacker and the territory owner named at funding | As the raid stake | Attacker refunds alone |
| Territory claim stake | `territory-claim` v2 | Game key picks a lane; claimant after 7 days | Whole stake to the claimant, or at least half to the claimant and at most half to one wallet named at settlement | **Bounded, not zero** (see 4.1) | Claimant refunds alone |
| Raffle entry and its reserve | `territory-uncontested` v2 (no key) | Nobody; entrant after 7 days | Stake plus the unused 900 sat of reserve to the entrant, 8 hours after entry | No | Anyone can broadcast the return |
| Personal vault, treaty compensation | `vault-covenant-v1`, political escrow v2 | Game key; owner or payer after timeout | Owner's wallet only; payee or payer only | No | Owner or payer recovers alone |
| **Outputs created before this work** | Operator-key P2SH | Game key | Anything | **Yes — historical** | Depends on the game key |

Settlement reserves are no longer a pool: each stake escrow carries its own reserve and spends it on its own settlement. There is no admin route that can redirect covenant money.

## 2. What the third pass changed

- **Territory.** Claims, attacks and raffle entries are paid into stake escrows and settle automatically from the contest, battle or draw record. The record is carried in the settlement transaction, so territory deeds and leases are still issued from an on-chain anchor.
- **Service prize pool.** Every service payment now travels in a reserve-funded carrier. The payer adds a disclosed 500-sat sweep reserve on top of the unchanged price; it pays the keyless sweep, and what the fee does not need stays in the prize pool. Two carriers start a season pool; three or more top up the existing pool output, so one output holds the season's pool. 20/10/5/65 is exact at every price.
- **Kingdom vault fee burning.** A vault output can be spent by the game key exactly once, whole, to its owner. Re-issuing is impossible. A chest output can be re-issued at most once per 144 blocks.
- **War chest captures.** A capture is an unsigned proposal until every attestor signs. `scripts/prize-attest.mjs` replays the recorded battle with the game's own resolver before signing.
- **Bug fixed.** Records of spends made by others (owner recoveries, keyless refunds) were re-observed and could be marked rejected, which would have counted the spent output as available again.
- **Transparency.** The public ledger reports `legacyOperatorHeld` separately and describes each pool's custody.

Unchanged: prices, 20/10/5/65, 30/70, sponsorship tiers, capture and forfeit percentages. New and disclosed at checkout: the 500-sat sweep reserve on services.

## 3. Evidence

| Kind | Result |
|---|---|
| Chipnet, newly executed | **None.** The environment cannot reach Chipnet |
| BCHN 29.2.0 Regtest, standard relay policy | 69 accept/reject cases, 69 passed: prize carrier v1 6, treaty escrow 5, treasury v2 4, personal vault 6, prize fund 12, kingdom vault 6, war chest 8, stake escrow 4, territory 7, service pool 11 (`evidence/regtest-remediation.json`) |
| BCH VM + real server over loopback + fixture node enforcing scripts, conflicts, finality and input age | 182 tests, 182 passed. New: `tests/territory-covenant.test.mjs`; rewritten pool test and attested-capture test in `tests/kingdom-covenant.test.mjs` |
| Browser suites, Selene/WizardConnect | **Not run.** Client changes (war chest dialog, reserve wording) were syntax-checked only. `scripts/browser-qa.mjs` still assumes payments without a verified wallet |

Regtest TXIDs belong to a private local chain. They are not Chipnet evidence.

## 4. Final audit: what is not fully met

### 4.1 The server still chooses outcomes it computes itself (requirement partly unmet)
- **Raid and territory attack:** the game key alone chooses between "attacker gets the stake back" and "half goes to the named defender". It cannot pay anyone else. A dishonest server could wrongly move half of one stake between the two named players.
- **Open territory claim:** the game key alone can send at most half of a claim stake to a wallet it names. This is the one place where a dishonest server could still take player money: half of a 3,000-sat claim stake per claim. Adding an attestor signature here needs a larger settlement reserve than the current 600 sat; the price was not changed without your decision.
- **War chest capture:** needs every attestor. The attestor replays the battle from its recorded inputs. It cannot check that the recorded armies were the true game state.
No BCH contract can verify a battle or ranking that is computed off chain. The feasible alternatives are a bounded lane (done), an independent signature (done for captures and prizes), or both.

### 4.2 No recovery for the service prize pool if the attestors disappear (requirement unmet)
Sponsor money returns to its sponsor without any key. The service prize pool has no single rightful owner on chain, so there is nobody to return it to. If every attestor is lost, that pool stays locked. It cannot be stolen. An attestor threshold (for example 2 of 3) would reduce the risk and is not built.

### 4.3 Attestors are still needed for every prize award and capture
"No manual developer action" holds: the developer signs nothing. But each award and capture waits for the attestors, who must run `scripts/prize-attest.mjs --approve` on a schedule on a machine you do not control. The software cannot check that they are independent of you.

### 4.4 Historical operator-held outputs
They keep their previous withdrawal and claim routes and were not moved. No automatic migration was built. They are counted in `buckets.legacyOperatorHeld`. They are not non-custodial.

### 4.5 Other limits
- Full non-custody needs configuration: `CHIPNET_DEVELOPMENT_ADDRESS`, `CHIPNET_PRIZE_ATTESTOR_KEYS`, covenant custody. Without the developer address the Development share is operator-held; without attestors, war chests and sponsorship are closed and service prize shares fall back to an operator-key output. The server warns at start-up but does not refuse to run.
- A lone or second waiting carrier cannot pay a top-up sweep. It waits for more payments and returns to its payer after 14 days; that prize share then never reaches the pool.
- Kingdom payouts are whole outputs, so the amount is rounded up. A 2,925-sat output costs about 400 sat to pay out.
- A capture proposal reserves the chest outputs it spends for up to 7 days. A chest past its recovery date can be withdrawn by its owner without the 12-hour release delay.
- The lease-expiry record of a raffle is no longer anchored on chain (the draw record is).
- Prize awards are still one per claim and serial.

## 5. Running it

```
node --test "tests/*.test.mjs" "packages/*/*.test.mjs"
REGTEST_BCHN=/path/to/bitcoind npm run test:regtest:remediation
CHIPNET_FIXTURE_FILE=var/covenant-keys.json CHIPNET_TEST_APPROVE=true npm run test:chipnet:covenants   # never executed
PRIZE_ATTESTOR_KEY_FILE=<key> npm run attest:prizes -- http://<game origin> --approve               # on the attestor's machine, on a schedule
```

`scripts/chipnet-covenants-e2e.mjs` covers service payments, the keyless sweep, a kingdom payout, war chest funding, a raid and its settlement, an attested capture if the battle awards one, a territory claim and its settlement, and an optional sponsorship. Prize awards, refunds, the raffle return and owner recoveries depend on real time locks or a season end and are covered on Regtest only.
