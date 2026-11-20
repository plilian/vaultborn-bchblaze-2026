# Fairness and risk

> Money rules and prices: [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md). Every transaction the game causes: [BLOCKCHAIN_TRANSACTION_MATRIX.md](BLOCKCHAIN_TRANSACTION_MATRIX.md). The measured balance figures below come from the simulation runs named in each paragraph.

## Player agency

- Every kingdom is in the season from its first day. A kingdom can leave seasonal PvP, but not while its War Chest holds money, during its territory contest or protectorate, or within an hour of a battle. There are no shields this season: nobody starts behind one and a defeat gives none.
- A target may be at most 20% weaker than the attacker in composite power; stronger kingdoms are always open. Same-alliance, treaty-protected and protected vassal cities are excluded. Each city receives a rolling budget of three launched raids and three incoming raids per 24 hours. Alliance members share a ten-raid budget, and the same two kingdoms pause eight hours between raids.
- A paid raid uses those same checks. Time of confirmation can change eligibility. If a previously eligible target changes state before confirmation, the raid is void and its escrow returns the stake to the attacker.
- Allied aid has a bounded daily allowance on both sides. The aid spread is 5%. The engine rejects transfers beyond storage capacity, invalid resources and quantities.
- Buildings, research and all six troop classes progress using earned resources. Payments add limited conveniences and cosmetic or archival entitlements. A short speedup can affect when a building comes online. Combat formulas ignore payment status.
- Counterintelligence, stale intel, decoys, mission caps and seeded uncertainty preserve defensive options. Private reports remain limited to the reporter and eligible current alliance recipients. Public powers are estimates and exact combat inputs are visible to battle participants.
- A paid protectorate (24,000 sat) is a proposal with separate defender agency. Term, tribute, immunity, simultaneous holdings and sponsor upkeep are bounded. Rebellion requires time and resources, with support for both sides and cooldown after failure.

## Measured balance and abuse checks

The final economy run used 1,000 paired 30-day progression cases, 12,000 baseline combat outcomes, 36,000 paired combat resolutions and 200 diplomacy scenarios. The equal-army attacker win rate was 35.3%. Paid markers changed zero outcomes in identical paired fights. Strong intel improved win rate by 4.57 percentage points. The aggressive free cohort recovered its previous army size after a loss in a 12-hour median across 334 observed recoveries.

In the scripted abuse probes, the alliance-spam probe failed the repeat-target check. Established colluding accounts, alliance shuffling and several accounts run by one person are risks that rules alone cannot exclude: alliance churning has a cooldown and raid quotas are shared, but a browser or a wallet does not prove that two kingdoms belong to two different people.

Late expansion also has economy risk. In the accelerated simulation three median cohorts reached the Hall 9 cap by day 30 and readily filled storage, and some high-level cities could no longer match the scripted rivals. The live game slows this down: build times rise eight-fold from level 2. Watching matchmaking at higher levels, the flow of resources, and suspicious paired actions between alliances stays part of running a season.

## Custody and competitive risk

A player has one BCH balance in the game, the War Chest, held by a contract of the player's own script. All of it is at risk, but only against an equal stake that an attacker locked first (matched stakes). Sponsor funds and the season pool are separate contracts. Earned loot and political tribute are in-game only and never move BCH. No pool except the developer's own receiving address is held by a key the operator controls alone.

Payments are credited after the expected locking script and exact amount are observed with the required confirmations (two by default; one for a rush on a construction that ends within the hour). Mempool state gives no advantage. A reorg can require manual reconciliation and temporarily quarantine a ledger. A payment can confirm after its game action has become ineligible: a service then becomes a credit, a raid is void and its stake returns, and a territory claim returns its stake.

## Operating a season with real money

Account recovery is the player's wallet (and an optional Nostr key). Players can leave every contract with their own keys, without the server. Anyone running a season with real money should have the terms reviewed for their jurisdiction: sponsor promotion, age and geographic limits, consumer disclosures, refunds, contest eligibility and payouts. No third-party security audit has been done. [Balance data](ECONOMY_DESIGN.md) · [Chain settlement matrix](BLOCKCHAIN_TRANSACTION_MATRIX.md) · [Status and evidence](STATUS.md)
