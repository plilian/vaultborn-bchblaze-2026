# Portable BCH and Nostr identity

VaultBorn lets a player start as a guest and add a recovery method to the same kingdom. **Verify Chipnet wallet** enables BCH sign-in. **Profile & settings → Decentralized identity → Link a Nostr sign-in** adds a private Nostr sign-in without requiring a wallet. **Link BCH and Nostr** joins both keys in a portable, public proof; if a private Nostr key is already linked, use that same key for the first portable proof. An active portable binding also enables sign-in with its current Nostr key. A fresh browser can choose **BCH wallet**, **Nostr**, or **Both keys** from **Sign in**. Login remains separate from pairing, and it recovers the saved kingdom without creating a city or spending BCH. VaultBorn prevents sign-out while a guest lacks a verified recovery method.

BCH-only sign-in and wallet verification accept VaultBorn's original 128-character Schnorr signature, or a compact Base64 **Sign Message** signature for a compressed key and the exact issued text, following [Bitcoin Cash Node's signed-message format](https://docs.bitcoincashnode.org/doc/json-rpc/verifymessage/). Use a personal Chipnet P2PKH CashAddr. The portable dual-key proof retains its original Schnorr format. The Nostr browser signer can supply a public key and sign exact events using NIP-07. Players can also paste signed event JSON from their own signer. VaultBorn never requests or stores a private key. Nostr login and private linking send no events to relays.

The profile explicitly asks whether the player wants both public keys, the wallet address, and the game association available in a local proof. The route `/api/public/identity/<genesis-nostr-public-key>` returns the signed event history, discovery filter, and a separate application-supplied profile with kingdom name, reputation, achievements, alliance, and the permanent and rented commanders currently associated with the kingdom. A player uses one identity for the entire roster. Rotation and sign-in keep the same account and progression. This association is not a transfer of a commander, wallet funds, or token ownership. Signed wallet/Nostr bindings are portable; the game profile is a report from the authoritative save and is not a decentralized credential for the accuracy of game statistics.

## Reproduce locally

```sh
node scripts/identity-proof.mjs demo
node --test packages/decentralized-identity/identity.test.mjs tests/identity-server.test.mjs tests/identity-relay.test.mjs
npm run test:identity:browser
```

Without arguments, the demo generates two distinct disposable keys in memory, verifies both signatures, discovers the signed record from an in-process Nostr REQ/EOSE mock, and verifies a separate challenge as a relying application. It does not create any account, connect to a relay, or call a blockchain provider. It emits the public proof as JSON. An exported archive can be checked on any machine with the package: `node scripts/identity-proof.mjs verify <archive.json>`. Use `node scripts/identity-proof.mjs bch-sign <challenge.txt>` for the manual disposable BCH fixture; `VAULTBORN_IDENTITY_BCH_KEY_FILE` points to the local hex signing file. This produces a 128-hex signature for the exact text. To test a manual Nostr signer, `nostr-sign <unsigned-event.json>` reads `VAULTBORN_IDENTITY_NOSTR_KEY_FILE`. Prefer local signer files under `var/` for disposable tests and keep both files outside the web directory and out of source control.

## Publish to Nostr relays and discover from them

The signed binding events are ordinary Nostr events, so any relay that stores regular kinds can carry them and anyone can read them back without VaultBorn. The game server never opens a relay connection; the player (or anyone holding the signed history) publishes it with the tool below, and a relying application reads it from relays it chooses.

```sh
# 1. In the game: Profile & settings → Decentralized identity → Open public proof (JSON). Save the page as proof.json.
node scripts/identity-proof.mjs publish proof.json wss://<relay-one> wss://<relay-two>
# 2. On any machine, knowing only the identity and the relays:
node scripts/identity-proof.mjs discover nostr:<genesis public key> wss://<relay-one> wss://<relay-two>
# 3. The whole path with two disposable keys: link, publish, discover from each relay, challenge and response.
node scripts/identity-proof.mjs demo wss://<relay-one> wss://<relay-two>
```

`publish` verifies the history first and sends only the events, which already carry both signatures; no key is read. `discover` reads and verifies every relay separately and reports whether they agree on the newest revision, and exits with an error when one relay is missing or behind, so a relay cannot silently serve an old record. `demo` with relay addresses prints one JSON record (relay answers, the event identifier, the verified binding from each relay, and the result of the two-key challenge); save that output as evidence of a public-relay run.

**Status:** this path is covered by `tests/identity-relay.test.mjs` against two relays started inside the test. No public relay has been contacted by the project's automated work, and no public-relay record is stored in this repository. Kind `7428` is an application kind, so an individual public relay may refuse it; the answer of each relay is in the output.

## BCH BLAZE decentralized identity bounty: where each requirement is met

| Requirement | Where |
|---|---|
| Users hold their own keys and link a BCH wallet identity to a Nostr identity, no custodian | Signing happens in the player's wallet and Nostr signer; the server stores public keys and signatures only (`apps/game-server/identity.mjs`, `apps/web/decentralized-identity.js`). |
| Cryptographic binding with proof of control over both keys, no shared key | The BCH key signs a domain-separated statement naming the Nostr key; that proof is inside an event the Nostr key signs. Keys with the same x-coordinate are refused (`verifyBindingEvent`). |
| Discovery through Nostr without a proprietary database | `publish` / `discover` above; filter `{kinds:[7428], "#d":[identity]}` (`identityDiscoveryFilter`, `readIdentityFromRelay`). **Open:** a recorded run on public relays. |
| Independent verification and authentication without a central authority | `verifyIdentityHistory` needs only the events. `createAuthenticationChallenge` / `verifyIdentityAuthentication` are a challenge and response answered by both keys; `demo` runs them as a separate relying application. |
| Working demo, source, setup, architecture | In the game: Profile & settings → Decentralized identity (link, rotate, revoke, sign in). On the command line: the three commands above. This document describes the protocol; tests are listed under "Reproduce locally". |
| Stretch goals present | Key rotation and revocation with signed history; a reusable library (`packages/decentralized-identity`). Not present: paying an identity without exchanging an address, third-party attestations, selective disclosure. |

## Protocol and transport

`packages/decentralized-identity/index.mjs` can verify JSON without an account database or chain client. The stable identity is `nostr:<genesis x-only public key>`. A canonical statement binds purpose, stable identity, version and prior event ID, game realm and account label, current compressed BCH public key and its canonical Chipnet CashAddr, current Nostr public key, a random nonce, and a five-minute issuance window. BCH signs a separate domain-prefixed challenge using the existing BCH Schnorr proof scheme. The two keys cannot have the same secp256k1 x-coordinate. Nostr signs the NIP-01 event hash with BIP340. The signed binding includes the BCH proof. `verifyIdentityHistory(events)` verifies initial ownership, all revisions and both signatures against the statement. It returns the independently verified binding and current `active` or `revoked` status. The stable identity never changes on key rotation.

Proof events use regular application kind `7428`, with `d` equal to the stable identity, so prior events can be retained across updates; authentication and prior Nostr rotation approvals use ephemeral application kind `27777`. These are application identifiers, not a registered NIP. Discovery uses a standard NIP-01 `REQ` filter `{ kinds:[7428], '#d':[identity], limit:96 }`. `readIdentityFromRelay(socket, identity)` consumes `EVENT`, `EOSE`, and `CLOSED` on a caller-supplied open socket and sends only `REQ` and `CLOSE`. `discoverIdentity(fetchEvents, identity)` accepts a read-only relay or fixture adapter. Both validate the complete chain from the genesis event and reject conflicting signed branches; `expectedHead` lets a relying app reject an older view. The game server does not open any Nostr relay; a signed history is published with `scripts/identity-proof.mjs publish` by whoever holds it (see above). Relays can refuse application kinds, omit history, or show an older record. A single offline export cannot prove that no newer rotation or revocation exists. Use independent relay views or pin an expected head when freshness matters.

For cross-application authentication, verify the history, call `createAuthenticationChallenge(binding, audience)`, persist the challenge in the relying application, and let both keys sign it. `verifyIdentityAuthentication(event, challenge, binding, {audience})` verifies the key pair, challenge window, audience, and current binding head. The relying application must atomically consume the issued nonce after proof verification; the library is stateless. VaultBorn consumes verified challenges in SQLite and only then rotates the local session cookie. Single-key recovery binds the issued challenge to the site, its purpose, and a short-lived browser cookie. A private Nostr link also requires the same live game session that requested it. The account is the same regardless of which possession proof is used. The dual-key proof option does not impose a two-factor policy on the player’s other recovery methods.

Rotation requires ownership of the new pair plus authorization from each changed old key. Revocation is signed by both current keys. A revoked binding can no longer supply Nostr or dual-key sign-in, and cannot expose a current game profile. Its signed history remains verifiable, and the current verified BCH key can still sign in independently. If the player changes the game wallet separately, portable and associated Nostr sign-in pause until the binding is updated. A retired wallet address cannot be enrolled by a different kingdom. This version limits each identity history to 24 revisions. Losing every verified recovery key and the active session makes that kingdom unrecoverable through these flows. The included tests use offline signers and an independent Electron Cash signature fixture; hardware wallets and public relay interoperability require separate testing.

References: [BCH BLAZE decentralized identity requirements](https://bchblaze.cash/bounties/decentralized-identity/), [NIP-01 event and relay protocol](https://github.com/nostr-protocol/nips/blob/master/01.md), [NIP-07 browser signers](https://github.com/nostr-protocol/nips/blob/master/07.md).
