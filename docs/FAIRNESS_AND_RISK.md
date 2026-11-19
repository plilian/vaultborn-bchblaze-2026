# Fairness and risk

> **Current rules (19 November 2026):** the economy, prices and custody described in parts of this document were replaced. The authoritative description is [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md) and the transaction list is [BLOCKCHAIN_TRANSACTION_MATRIX.md](BLOCKCHAIN_TRANSACTION_MATRIX.md). Where this document differs, those two are right.

## Player agency

- Cities complete onboarding and explicitly enable seasonal PvP. New settlements receive a 30-minute shield. A defeat gives four hours of recovery. Enrollment cannot be withdrawn during an open protectorate or within one hour of a battle.
- A standard target must be within the configured 80–120% composite power window. Same-alliance, treaty-protected, shielded and protected vassal cities are excluded. Each city receives a rolling budget of three launched raids and three incoming raids per 24 hours. Alliance members share a ten-raid budget and an eight-hour repeat-target guard.
- A raid with a Chipnet fee uses those same checks. Time of confirmation can change eligibility. The engine declines fulfillment if a previously eligible target changes state before confirmation, and the payment requires operator review.
- Allied aid has a bounded daily allowance on both sides. The aid spread is 5%. The engine rejects protected starter accounts, transfers beyond storage capacity, invalid resources and quantities.
- Buildings, research and all six troop classes progress using earned resources. Payments add limited conveniences and cosmetic or archival entitlements. A short speedup can affect when a building comes online. Combat formulas ignore payment status.
- Counterintelligence, stale intel, decoys, mission caps and seeded uncertainty preserve defensive options. Private reports remain limited to the reporter and eligible current alliance recipients. Public powers are estimates and exact combat inputs are visible to battle participants.
- A 20× paid protectorate is a proposal with separate defender agency. Term, tribute, immunity, simultaneous holdings and sponsor upkeep are bounded. Rebellion requires time and resources, with support for both sides and cooldown after failure.

## Measured balance and abuse checks

The final economy run used 1,000 paired 30-day progression cases, 12,000 baseline combat outcomes, 36,000 paired combat resolutions and 200 diplomacy scenarios. The equal-army attacker win rate was 35.3%. Paid markers changed zero outcomes in identical paired fights. Strong intel improved win rate by 4.57 percentage points. The aggressive free cohort recovered its previous army size after a loss in a 12-hour median across 334 observed recoveries.

All twelve fresh alt-identity probes failed the seasonal eligibility requirement, starter aid failed, and the alliance-spam probe failed the repeat-target check. This evidence concerns the scripted guardrails. Established colluding accounts, dynamic alliance-shuffling incentives and shared-session evasion remain beta risks. Alliance churning has a cooldown, but browser identity and limited shared raid quotas are insufficient to prove unique human ownership.

Late expansion also has economy risk. Three median cohorts reached the accelerated Hall 9 cap by day 30 and readily filled storage. Some high-level cities could no longer match the scripted rivals. Production play needs matched opponents at higher maturity, persistent economic source/sink telemetry, and aggregate monitoring of alliances, grants and suspect paired actions before material rewards are offered.

## Custody and competitive risk

A player has one BCH balance in the game, the War Chest, held by a contract of the player's own script. All of it is at risk, but only against an equal stake that an attacker locked first (matched stakes). Sponsor funds and the season pool are separate contracts. Earned loot and political tribute are in-game only and never move BCH. No pool except the developer's own receiving address is held by a key the operator controls alone.

The default two-confirmation policy settles Chipnet actions after observing the expected locking script and exact amount. Mempool state gives no advantage. A reorg can require manual reconciliation and temporarily quarantine a ledger. An on-chain fee can succeed after a game action becomes ineligible. Review terminal receipts and payment policy before adding Mainnet activation or a public deposit path.

## Public-release decisions still open

A public deployment needs authenticated account recovery, moderation workflow and reporting, independent treasury recovery practice, more systematic cross-account abuse monitoring and external security review. A jurisdiction-specific review should cover sponsor promotion terms, age and geographic restrictions, consumer disclosures, cancellation and refund terms, contest entry/eligibility and payout handling. Live Chipnet evidence establishes test-network behavior only. [Balance data](ECONOMY_DESIGN.md) · [Chain settlement matrix](BLOCKCHAIN_TRANSACTION_MATRIX.md) · [Chipnet evidence](CHIPNET_VERIFICATION_REPORT.md)
