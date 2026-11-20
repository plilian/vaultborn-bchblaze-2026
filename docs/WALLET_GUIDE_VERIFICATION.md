# Wallet and guide verification

> **Record of 18 November 2026.** Since then Selene has been used with the live game on Bitcoin Cash Mainnet through WizardConnect: the payments it signed are in [MAINNET_TRANSACTIONS.md](MAINNET_TRANSACTIONS.md). Current state and evidence: [STATUS.md](STATUS.md).

## Selene interoperability: executed 18 November 2026

`npm run test:wallet:selene` passed using the actual **Selene Wallet v2026.10.02 web release**, with its JavaScript, CSS, and HTML unchanged. Selene created a disposable, unfunded wallet in an isolated browser context. The test used Selene's actual Debug Options UI to select Chipnet, submitted VaultBorn's pairing URI in its WizardConnect screen, approved the connection in Selene, received its derived Chipnet address, recovered that same address after reloading VaultBorn, and disconnected. Desktop VaultBorn and the 430-pixel Selene view were captured and inspected.

This revealed and fixed a real compatibility regression: Selene sends a valid preliminary `wallet_ready` event with no HD paths before the user approves sharing them. VaultBorn previously closed the session immediately. It now preserves the pairing dialog and deadline, asks the player to approve in the wallet, and waits for the subsequent receive path. The ordinary SDK regression also tests that preliminary event, cancellation before consent, and successful re-pairing.

The check is isolated interoperability evidence. It is **not** a physical-device test, a test of public relay reachability, or an on-chain test. Selene's release CSP permits secure WebSockets only, so the harness changes only the URI transport parameter to `wss` and forwards that browser socket unchanged to the loopback relay. Selene's encrypted and signed WizardConnect messages remain intact. Public Electrum sockets, rates, telemetry, and other external requests are blocked. The game uses a mock-empty chain observer; the displayed zero balance is a fixture, not a real balance observation. No payment, transaction signature request, or broadcast occurred.

The published page requests `/sql-wasm.wasm`; the harness supplies the pinned `sql.js@1.14.2/dist/sql-wasm.wasm` runtime dependency. All release assets and that dependency are checked by SHA-256 against [the fixture manifest](selene-release-fixture.json). The release's main JavaScript digest is `606367e48a1845cdc8f933cd15382764025496d67277e8c7698da65f15375f14`. Release code stays under ignored `var/selene-app`, outside the production web root. The test result records the current game JavaScript hashes separately.

To reproduce from a checkout with dependencies installed:

```powershell
node scripts/cache-selene-release.mjs
npm run test:wallet:selene
npm run test:wallet:browser
```

The cache command performs read-only HTTPS GETs for pinned public assets. The browser tests then run using the cache and loopback only. If a publisher removes or changes an asset, the cache command fails rather than silently changing the fixture. Captures and the machine-readable result are under `output/selene-release/`; the official SDK baseline writes to `output/wallet-polish/`.

In this Selene release the web Debug Options screen is available at `https://app.selene.cash/debug`. Open **Debug Options → BCH Network → Chipnet**, then **Apps → WizardConnect**. Other releases or native apps may place Debug Options under Settings. The in-game Selene pairing panel links directly to the web network screen.

## Official SDK baseline

`npm run test:wallet:browser` exercises the installed WizardConnect SDK over a loopback Nostr relay. It tests provisional consent and cancellation, pairing, exact receiving address, clipboard, mocked balance refresh, signed receiving-address proof, interrupted territory action recovery, checkout review, in-game Explorer and music continuity, reload, disconnect, wrong-network rejection, and mobile pairing without a configured treasury. Its balances and Selene-named protocol fixture are mocks; the direct release check above supplies the independent web-client interoperability evidence.

Neither test authorizes a transaction. Both assert zero transaction-signing requests and zero broadcasts. Wallet pairing is deliberately separate from proving a receiving address and from BCH/Nostr authentication.

## Account recovery, education, and interface

The full `npm test` run passed **134 of 134 tests**. Auth tests cover the existing portable proof, BCH compact Sign Message against an independent Electron Cash fixture, browser-bound one-use challenges, stale proofs, duplicate keys, and recovery of the same kingdom after a SQLite restart. No network signer or chain provider is used by these tests.

`npm run test:identity:browser` passed BCH-only, Nostr-only, and dual-key recovery in fresh browser contexts. It also checks private linking, explicit logout, and an open tab whose cookie was revoked elsewhere: that tab returns to the landing sign-in without creating another kingdom. At 390px and 320px, the header controls stay separate, fit within the viewport, and work with actual pointer clicks. The test records no external or payment requests.

`npm run test:onboarding:browser` passed the existing campaign and four added BCH lessons, reload recovery, pause, skip, review, safe practice, and the unchanged one-time First Banner reward. The lessons open the actual wallet, construction, Codex, and standings views. No payment is initiated and PvP enrollment stays unchanged.

`npm run test:guide:browser` passed desktop and mobile landing navigation and Bitcoin Cash branding, all eleven Codex chapters, search, chapter filters, contextual return, and tutorial review. The construction receipt shows the committed material cost. A real conflicting construction request returns 409 without a second deduction or queue entry; dismissing its centered error refreshes the stale controls. Captures under `output/guide-ux/` were inspected. The focused guide and onboarding runs record zero external requests and financial POST requests.

The wider `npm run test:browser` gameplay suite also passed. It prepares checkout intents against an isolated provider fixture; it does not establish any on-chain outcome. No blockchain transaction, deployment, publication, or Git push was performed during this pass.

For a local review, `npm run preview:offline` keeps network capabilities disabled. `npm run preview:wallet` uses the same isolated game and enables wallet pairing via public relays when a player chooses to connect; BCH balance lookup, checkout, and all broadcasts remain disabled. A normally configured game exposes pairing and read-only balances independently of whether its treasury can accept paid checkouts.
