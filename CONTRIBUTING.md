# Contributing

VaultBorn is published to be read, not to be reused: see the [license](LICENSE). The author does not accept code contributions. Bug reports and suggestions are welcome as GitHub issues; anything you send may be used by the author without obligation to you.

## Notes for the author

Use Node 24 and run `npm ci` before starting the game. Implement authoritative rules in `packages/game-engine`, presentation in `apps/web`, and operator signing and proof checks in `packages/chain-observer`. Use `config` for changes to paid amounts or economy coefficients.

Run `npm test` for gameplay and ledger changes. Run `npm run simulate` before submitting a balance change. Use `npm run test:browser` for map, HUD, mobile layout, and interaction work. Check the Mainnet transaction proof with `npm run verify:mainnet` after changing anything in `docs/mainnet/`. Store keys, databases, and temporary fixtures under ignored paths.

When adding art, include the packed source filename, provenance, intended use, dimensions and frame layout in `packages/assets/manifest.json`. Test asset loading in the screens that actually use it.
