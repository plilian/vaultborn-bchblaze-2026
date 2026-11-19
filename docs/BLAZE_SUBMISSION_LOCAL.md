# VAULTBORN at BCH BLAZE 2026

VAULTBORN is a browser strategy game in which players build a fortress, scout and battle rival cities, negotiate treaties, and allocate optional Bitcoin Cash charges to public treasuries. Chipnet combat records can be reproduced independently and linked to the payment and settlement.

## Organizer sources

- The BLAZE schedule lists registration closing November 13, the hacking deadline on November 22 at 14:00 UTC, and the live showcase November 28 at 14:00 UTC. [Official schedule](https://bchblaze.com/schedule/)
- The organizer homepage links to DoraHacks and describes workshop preparation and the live showcase. [BLAZE 2026](https://bchblaze.com/)
- DoraHacks returned HTTP 405 to the documentation lookup. Track-level requirements for originality, WizardConnect, Mainnet transaction functionality and demo access still need confirmation in the official listing or with an organizer. [Official event listing](https://dorahacks.io/hackathon/bchblaze2026)

## Local demo

1. Open the campaign map and inspect a rival. Show the raid conditions and cooldown.
2. Open City Hall and review the payment allocation. Open the Chain Explorer and inspect the confirmed output indexes.
3. Replay a paid battle and open its verification page. Explain the deterministic outcome and settlement commitment.
4. Show confirmed sponsorship and a funded reward claim. Open the Council to show the sponsor schedules and treasury voting.
5. Return to the game and demonstrate mobile controls and combat audio settings.

Use confirmed receipts for recorded shots where block times would interrupt the walkthrough. Mainnet proof requires owner validation. The game and generated art were built for this project. The art manifest records provenance and attribution.

## Owner actions

Confirm registration, track eligibility and attendance evidence in DoraHacks. Prepare production sign-in, a treasury and secure hosting before granting public access. Review contract security and applicable rules before enabling Mainnet PvP settlement. Arrange judge access, supply wallet-approved Mainnet proof, record the demonstration and submit through the official event page.

The game can now be configured for either network: `VAULTBORN_NETWORK=chipnet` (default) or `mainnet`. Mainnet is prepared and guarded but has not been activated: see [MAINNET.md](MAINNET.md). The offline proof worksheet (`npm run preflight:mainnet`) still validates an owner-controlled Mainnet address without sending anything.

```sh
npm run preflight:mainnet -- "bitcoincash:<your-receiving-address>" 1000
```
