# VaultBorn presentation copy

Live on Bitcoin Cash Mainnet: [vaultborn.parhamlilian.com](https://vaultborn.parhamlilian.com). Money rules: [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md). Every transaction the game causes: [BLOCKCHAIN_TRANSACTION_MATRIX.md](BLOCKCHAIN_TRANSACTION_MATRIX.md).

## World

Players build a fortress on a shared frontier. They train commanders and armies, spy on rivals, secure landmarks, and negotiate or overturn protectorates. The game is free to play; Bitcoin Cash comes in only when a player chooses a paid action.

## Bitcoin Cash use

Every service payment is split by the payer's own transaction into four auditable outputs: 50% into the payer's own War Chest contract, 20% to the season prize pool, 20% to Development and 10% to a provable burn. Paid raids use matched stakes: the attacker locks a stake, the raid is offered only if the defender's War Chest covers the same amount, and the winner takes both. Sponsors fund the season: 30% to Development, 70% into a prize fund contract. The wallet shows every output and the fee before the player approves.

## Strategy

Free and paid raids share eligibility and cooldowns, and the same combat rules: a stake never changes a battle. Terrain, army composition, tactics and intelligence decide it. A target may be at most 20% weaker than the attacker; stronger kingdoms are always open.

## Verification

Show the Mainnet launch record and its manifest hash, a split receipt, the battle replay and its public record, and the settlement signed by two of the three attestors. Anyone can check the Mainnet transactions offline with `npm run verify:mainnet` ([MAINNET_TRANSACTIONS.md](MAINNET_TRANSACTIONS.md)). The attestors are run by the VaultBorn team.

## Governance

Sponsors fund scheduled and approved season placements. Verified active players can propose development payments in the Council and vote on them.

## Evidence

- [World screenshot](screenshots/vaultborn-world.png)
- [Wallet checkout](screenshots/vaultborn-checkout.png)
- [Battle verification](screenshots/vaultborn-battle-verification.png)
- [Council mobile view](screenshots/vaultborn-council-mobile.png)
- [Mainnet transactions](MAINNET_TRANSACTIONS.md) · [Status](STATUS.md) · [Chipnet verification](VAULTBORN_CHIPNET.md)
