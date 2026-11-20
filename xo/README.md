# VaultBorn Treaty Escrow, an XO template

Entry for the **Build with XO** bounty of BCH BLAZE 2026. It is the XO form of the compensation escrow that VaultBorn uses
for treaties and protectorates (`packages/chain-observer/political-escrow.mjs`).

**Tested in the XO engine.** The template runs in the real XO engine (`@xo-cash/engine` 0.1.1-next.18170561234)
against a local test chain that checks every transaction with the BCH virtual machine. Six checks pass: the template is
valid and survives export; three accounts open an escrow that all of them track; the arbiter releases to the recipient;
the arbiter returns to the payer; the arbiter cannot send the escrow anywhere else; the payer reclaims alone, only after
the expiry time. The Chipnet runner below performs the same steps on Chipnet and saves the invitations and transactions
in `evidence/`. The live game settles its treaties with the same escrow rules through its own checkout
(`political-escrow` v2, WizardConnect); this template is that escrow in XO form.

## What the contract does

Three roles: a **payer** locks a compensation, a **recipient** is named, an **arbiter** decides (in VaultBorn, the game's
settlement key).

| Action | Who signs | Result enforced by the contract |
|---|---|---|
| `openEscrow` | payer funds; recipient and arbiter join first | The principal sits in a pay-to-script-hash-32 output that all three accounts track. |
| `releaseEscrow` | arbiter | Output 0 pays the recipient's address fixed at opening. |
| `returnEscrow` | arbiter | Output 0 pays the payer's address fixed at opening. |
| `reclaimEscrow` | payer alone | Same as a return, valid only after the expiry time (`OP_CHECKLOCKTIMEVERIFY`). |

In every settlement the escrow must be the only input and output 0 must carry everything it held except a fixed 600-satoshi
network fee. The arbiter can therefore choose between two outcomes and nothing else; it cannot send the money to itself.
The three settlements are the follow-up actions of the escrow output: the arbiter's account is offered release and return,
the payer's account is offered reclaim.

## Files

| File | Purpose |
|---|---|
| `treaty-escrow.template.mjs` | The template, with comments. |
| `treaty-escrow.template.json` | The same template as JSON, for the debug tool at https://blaze.xo.cash/ and `Engine.importTemplate`. Rebuild with `npm run build`. |
| `flow.mjs` | The steps each account performs, used by the test and by the Chipnet runner. |
| `test-offline.mjs`, `sim/` | Engine test on a local chain. No network. |
| `run-chipnet.mjs`, `role-step.mjs`, `Run on Chipnet.cmd` | Opens and settles one escrow on Chipnet and saves the invitations. |

## Reproduce

Node.js 22 or newer. The XO packages are installed in this folder only (about 160 MB); the game does not depend on them.
One of them builds a native SQLite module during the install; on Windows that needs the C++ build tools (Visual Studio
Build Tools with "Desktop development with C++").

```sh
cd xo
npm ci
npm test            # six checks in the engine on a local chain, a few seconds
```

From the repository root the same is `npm --prefix xo ci` once, then `npm run test:xo`.

On Chipnet (on Windows, double-click `Run on Chipnet.cmd` instead):

```sh
node run-chipnet.mjs                    # open, then the arbiter releases to the recipient
node run-chipnet.mjs --outcome return   # open, then the arbiter returns to the payer
```

1. The first run creates three Chipnet-only accounts in `xo/var/chipnet/` (not committed) and prints the payer's address.
2. Send it at least 6,000 Chipnet satoshis, for example from https://tbch.googol.cash/. The window waits for the coin.
3. The runner then performs every step, one account per process: payer creates the invitation, recipient joins with its
   payout address, arbiter joins with its key, payer funds and broadcasts, arbiter settles and broadcasts.
4. It writes `xo/evidence/open-invitation.json`, `xo/evidence/settle-invitation.json` and `xo/evidence/run.json` (both
   transaction identifiers with explorer links, the template identifier and the package versions).

If it stops, run the same command again; it continues where it stopped. To inspect an invitation, open the XO debug tool
at https://blaze.xo.cash/ with a disposable account, import `treaty-escrow.template.json`, then import the invitation file.

`node run-chipnet.mjs --simulate` runs the same steps on the local test chain and writes under `xo/var/`; its output is
labelled SIMULATED.

## Limits

- Use a principal of at least 2,000 satoshis: the payout is the principal less 600 and must stay above the dust limit.
- The fee is fixed in the contract. A settlement cannot add a second input to pay a higher fee.
- An expiry time is a Unix time; the network accepts a reclaim only once the median time of recent blocks has passed it,
  which is about an hour after the wall clock.
- Build and test on Chipnet first, as the XO bounty asks; on Mainnet use only small amounts you can get back. No
  third-party audit of the template has been done.
