// Mainnet preflight. Reads the Mainnet configuration, checks everything that must be true before real BCH may move,
// and prints what the owner has to provide. It signs nothing and broadcasts nothing.
//
//   node --env-file=.env.mainnet scripts/mainnet-preflight.mjs            configuration only, no network access
//   node --env-file=.env.mainnet scripts/mainnet-preflight.mjs --online   also asks the configured observers (read-only)
//                                                                         for the block that identifies Bitcoin Cash
// It refuses to run unless VAULTBORN_NETWORK=mainnet, so it cannot be pointed at a Chipnet configuration by mistake.
import { NETWORK_ID, NETWORK_PROFILE, assertNetworkEnvironment, networkEnv, networkEnvName } from '../config/network.mjs';

if (NETWORK_ID !== 'mainnet') throw new Error('Set VAULTBORN_NETWORK=mainnet (use --env-file=.env.mainnet). This check is for the Mainnet configuration only.');
const { MAINNET_ACK, mainnetStartupProblems } = await import('../apps/game-server/index.mjs');
const { treasuryConfig } = await import('../config/treasury.mjs');
const { createChain, walletFromPrivateKey } = await import('../packages/chain-observer/index.mjs');
const { createElectrumTransport } = await import('../packages/chain-observer/transports.mjs');
const { PRICING, priceBook } = await import('../config/pricing.mjs');
const { GAMEPLAY_ALLOCATION } = await import('../config/payments.mjs');
const { readFileSync } = await import('node:fs');

const problems = [];
const attempt = (label, work) => { try { return work(); } catch (error) { problems.push(label + ': ' + error.message); return undefined; } };
attempt('Mixed configuration', () => assertNetworkEnvironment());
const treasury = attempt('Developer address and attestor keys', () => treasuryConfig()) ?? {};
const keyPath = networkEnv('TREASURY_KEY_FILE');
const gameKey = attempt('Game automation key', () => networkEnv('TREASURY_PRIVATE_KEY') || (keyPath ? readFileSync(keyPath, 'utf8').trim() : undefined));
const chain = attempt('Chain configuration', () => createChain({ enabled: networkEnv('GAME') !== 'false', treasuryPublicKey: networkEnv('TREASURY_PUBLIC_KEY'), treasuryPrivateKey: gameKey,
  developmentAddress: treasury.developmentAddress, sponsorshipDevelopmentAddress: treasury.sponsorshipDevelopmentAddress, prizeAttestors: treasury.prizeAttestors,
  ...(networkEnv('PRIZE_ATTESTOR_THRESHOLD') && { prizeAttestorThreshold: Number(networkEnv('PRIZE_ATTESTOR_THRESHOLD')) }),
  rpcUrl: networkEnv('RPC_URL'), rpcUser: networkEnv('RPC_USER'), rpcPassword: networkEnv('RPC_PASSWORD'), electrumHost: networkEnv('ELECTRUM_HOST'),
  minConfirmations: Math.max(1, Number(networkEnv('MIN_CONFIRMATIONS')) || NETWORK_PROFILE.minConfirmations) }));
if (chain) problems.push(...mainnetStartupProblems({ localDemo: process.env.DOMINION_LOCAL_DEMO !== 'false', chain, database: process.env.DOMINION_DB ?? 'var/dominion.sqlite',
  kingdomCustody: process.env.VAULTBORN_KINGDOM_CUSTODY ?? 'covenant', vaultCustody: process.env.VAULTBORN_VAULT_CUSTODY ?? 'covenant',
  allocationPolicy: process.env.DOMINION_ALLOCATION_POLICY ?? GAMEPLAY_ALLOCATION, pricing: PRICING, personalVault: 'closed' })
  // The owner's acknowledgement is the last step and is reported separately below.
  .filter(text => !text.startsWith('The owner has not authorised Mainnet')));
// Without these three the server would start as free play only, with every paid action closed. For a Mainnet launch that is not ready.
if (!gameKey) problems.push('The game automation key is missing: set ' + networkEnvName('TREASURY_KEY_FILE') + ' (create it with scripts/network-keys.mjs).');
if (!treasury.developmentAddress && !problems.some(text => text.includes(networkEnvName('DEVELOPMENT_ADDRESS')))) problems.push(networkEnvName('DEVELOPMENT_ADDRESS') + ' (your one receiving address) is missing.');
if ((treasury.prizeAttestors ?? []).length < 2 && !problems.some(text => text.includes(networkEnvName('PRIZE_ATTESTOR_KEYS')))) problems.push(networkEnvName('PRIZE_ATTESTOR_KEYS') + ' needs at least two independent attestor public keys (three recommended).');
if ((process.env.DOMINION_DB ?? '').includes('chipnet') || !process.env.DOMINION_DB) problems.push('DOMINION_DB must name a new database file used for Mainnet only (for example var/mainnet/vaultborn.sqlite).');
if ((process.env.VAULTBORN_ADMIN_TOKEN ?? '').length && process.env.VAULTBORN_ADMIN_TOKEN.length < 32) problems.push('VAULTBORN_ADMIN_TOKEN must be at least 32 characters, or unset.');

const book = priceBook(PRICING);
const game = gameKey ? attempt('Game key', () => walletFromPrivateKey(gameKey)) : undefined;
const hosts = (networkEnv('ELECTRUM_HOST') ?? NETWORK_PROFILE.electrumHosts.join(',')).split(',').map(item => item.trim()).filter(Boolean);
const report = {
  network: NETWORK_ID, addressPrefix: NETWORK_PROFILE.prefix,
  checkpoint: NETWORK_PROFILE.checkpoint,
  developerAddress: treasury.developmentAddress ?? null,
  gameKey: game ? { publicKey: game.publicKey, address: game.address, holds: 'no player or prize money; it needs no balance for ordinary operation' } : null,
  attestors: { publicKeys: treasury.prizeAttestors ?? [], threshold: chain?.attestorThreshold ?? null },
  observers: { ownNode: networkEnv('RPC_URL') ? 'configured' : 'not configured (recommended)', electrum: hosts, secondServerRequired: networkEnv('REQUIRE_WITNESS') !== 'false' },
  confirmations: chain?.minConfirmations ?? null,
  priceBook: PRICING, services: book.services, raidStake: { minimum: book.raid.minimumStake, maximum: book.raid.maximumStake },
  contracts: ['war-chest-v4', 'stake-escrow-v4', 'stake-escrow-v3', 'prize-fund-v1 and the season pool', 'record-reserve-v2', 'political-escrow v2'],
  initialContractFunding: 'none: every contract output is created by a player payment or a sponsorship; nothing has to be deployed or funded in advance',
  optional: { cashTokensIssuer: networkEnv('TERRITORY_CATEGORY') || networkEnv('POLITICS_CATEGORY') ? 'configured' : 'not configured (collectibles are off; see scripts/token-genesis.mjs)' },
};
if (process.argv.includes('--online')) {
  // Read-only: asks each observer for the checkpoint block and its tip. Nothing is sent.
  report.online = [];
  for (const host of hosts) {
    try { const tip = await createElectrumTransport(host, { requireWitness: false }).withClient(client => client.tip); report.online.push({ host, ok: true, tip }); }
    catch (error) { report.online.push({ host, ok: false, error: error.message }); problems.push('Observer ' + host + ': ' + error.message); }
  }
}
const acknowledged = process.env.VAULTBORN_MAINNET_ACK === MAINNET_ACK;
console.log(JSON.stringify({ ...report, problems, ownerAuthorisation: acknowledged ? 'VAULTBORN_MAINNET_ACK is set: the server will start on Mainnet' :
  'NOT GIVEN. The server refuses to start on Mainnet until the owner sets VAULTBORN_MAINNET_ACK=' + MAINNET_ACK,
  verdict: problems.length ? 'NOT READY: fix the problems listed' : acknowledged ? 'Configuration complete and authorised' : 'Configuration complete. Waiting for the owner\'s authorisation.' }, null, 2));
process.exit(problems.length ? 1 : 0);
