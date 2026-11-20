import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createReadStream, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, addPlayer, advance, snapshot, command, quote, taskSnapshot } from '../../packages/game-engine/index.mjs';
import { marketQuote, trainingQuote } from '../../packages/game-engine/economy.mjs';
import { createChain, decodeAddress } from '../../packages/chain-observer/index.mjs';
import { walletFromPublicKey } from '../../packages/chain-observer/primitives.mjs';
import { openStore } from './store.mjs';
import { createLedger } from './ledger.mjs';
import { createPortal } from './portal.mjs';
import { readBattle, registerNewBattles } from './battle-records.mjs';
import { genesis, readJournal, scoreRules } from './season-evidence.mjs';
import { kingdom } from './kingdom.mjs';
import { bchPolicy, checkoutFees, GAMEPLAY_ALLOCATION, LEGACY_ALLOCATION, LEGACY_PRICING, PRICING, priceBook, paymentAllocation, PRIZE_FEED_RESERVE, CHEST_FEED_RESERVE, CHEST_FEED_WAIT_BLOCKS, CHEST_EXIT_BLOCKS, SERVICE_ALLOCATION, serviceSplit } from '../../config/payments.mjs';
import { chipnetTreasuryConfig } from '../../config/treasury.mjs';
import { blazeBanner } from '../../config/blaze.mjs';
import { attackPreview } from '../../packages/game-engine/stats.mjs';
import { createWalletCheckout } from './wallet-checkout.mjs';
import * as territoryGame from '../../packages/game-engine/territories.mjs';
import { createTerritoryProtocol } from './territory-protocol.mjs';
import { createTerritoryAssets } from '../../packages/chain-observer/territory-assets.mjs';
import { createPoliticsProtocol } from './politics-protocol.mjs';
import { createIdentity } from './identity.mjs';
import { createWizardPairing } from './wizard-pair.mjs';
import { verifiedBchMessageKey } from './bch-sign-in.mjs';
import { awayThreshold, dismissKingdomChronicle, readKingdomChronicle } from './kingdom-chronicle.mjs';
import { ADDRESS_PREFIX, ATTESTOR_ADJECTIVE, ATTESTOR_NOTE, ATTESTOR_OPERATION, NETWORK_ID, NETWORK_LABEL, NETWORK_PROFILE, REAL_VALUE, assertNetworkEnvironment, browserNetwork, networkEnv, networkEnvName } from '../../config/network.mjs';

// Files named *.private.* stay on the operator's own computer and server; they are never published. When such a file
// adds routes, the server serves them before its own.
let privateRoutes = null;
try { privateRoutes = (await import('./routes.private.mjs')).default; }
catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes('routes.private.mjs')) console.error('Private routes not loaded:', error.message); }

const root = fileURLToPath(new URL('../../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.vtt': 'text/vtt; charset=utf-8' };
const hash = (token) => createHash('sha256').update(token).digest('hex');
const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])])) : value;
const canonical = (value) => JSON.stringify(canonicalize(value));
const day = 86_400_000;
const demoSeats = new Set(['p1', 'p2', 'p3', 'p4']);
const archivePaths = new Set(['/ledger.html','/explorer','/council.html']);
const gzipBytes = promisify(gzip);

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function gameStateJson(req, res, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const accepted = (req.headers['accept-encoding'] ?? '').toLowerCase().split(',').map(item => item.split(';').map(part => part.trim()));
  const gzipRule = accepted.find(([name]) => name === 'gzip') ?? accepted.find(([name]) => name === '*');
  const quality = gzipRule?.slice(1).find(part => /^q\s*=/.test(part))?.split('=')[1];
  const compressed = body.length >= 64 * 1024 && gzipRule && (quality === undefined || Number(quality) > 0)
    ? await gzipBytes(body, { level: 3 }) : null;
  const encoded = compressed && compressed.length < body.length;
  res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', Vary:'Accept-Encoding',
    'Content-Length':encoded ? compressed.length : body.length, ...(encoded && { 'Content-Encoding':'gzip' }) });
  res.end(encoded ? compressed : body);
}
async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'Send application/json.');
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 16_384) fail(413, 'Command is too large.');
    parts.push(part);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { fail(400, 'Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a JSON object.');
  return body;
}

// What the configured keys and addresses allow. `blocking` lists what stops paid services; `lines` is the start-up notice.
export function financialReadiness({ chain, kingdomCustody = 'covenant', vaultCustody = 'covenant' }) {
  const blocking = [];
  const lines = [];
  if (!chain.enabled) return { ready: false, blocking: ['' + NETWORK_LABEL + ' payments are not configured.'], lines: ['' + NETWORK_LABEL + ' payments are off: the game is free-to-play only.'] };
  if (!chain.developmentAddress) blocking.push('No developer address (' + networkEnvName('DEVELOPMENT_ADDRESS') + '): paid services, sponsorship and deposits into the War Chest are closed.');
  const attestors = chain.prizeAttestors?.length ?? 0;
  if (!attestors) blocking.push('No ' + ATTESTOR_ADJECTIVE + ' attestor key (' + networkEnvName('PRIZE_ATTESTOR_KEYS') + '): paid services, War Chest deposits, captures and prizes are closed.');
  if (!chain.payoutsEnabled) blocking.push('No automation key: withdrawals, settlements and prize proposals cannot be signed.');
  if (kingdomCustody !== 'covenant' || vaultCustody !== 'covenant') blocking.push('Custody is set to "operator": player money would be held by the game key. Use covenant custody.');
  if (attestors === 1) lines.push('One attestor is configured: captures and prizes stop while it is offline, and it must be run by someone independent of the developer.');
  if (attestors && ATTESTOR_OPERATION === 'owner') lines.push('The attestors are run by the game owner, so they are not independent. Players see this in the rules and the public ledger.');
  if (attestors === 2) lines.push('Two attestors are configured: both must sign every capture and prize (a majority of two is two). Three allow one to be offline.');
  if (attestors && !blocking.length) lines.push(`Paid services are open: ${chain.attestorThreshold} of ${attestors} attestor(s) sign captures and prizes; the season pool accepts one attestor from 30 days after a season closes.`);
  lines.push(...blocking);
  lines.push('Free play does not depend on any of this.');
  return { ready: !blocking.length, blocking, lines };
}

const keyFile = path => path ? readFileSync(resolve(root, path), 'utf8').trim() : undefined;

// Everything that must be true before this process may handle real BCH. Returned as a list so that the owner sees all
// of it at once; createApp refuses to start on Mainnet while the list is not empty. Nothing here broadcasts anything.
export const MAINNET_ACK = 'real-bch';
export function mainnetStartupProblems({ env = process.env, localDemo, chain, database, kingdomCustody, vaultCustody, allocationPolicy, pricing,
  personalVault, testWizardRelay, simulatedChain, storedNetworks = [] }) {
  const problems = [];
  const name = networkEnvName;
  if (env.VAULTBORN_MAINNET_ACK !== MAINNET_ACK) problems.push('The owner has not authorised Mainnet: set VAULTBORN_MAINNET_ACK=' + MAINNET_ACK + ' only when real BCH may move.');
  if (localDemo) problems.push('DOMINION_LOCAL_DEMO must be false: demo seats would let any visitor take over a seeded kingdom.');
  if (testWizardRelay || simulatedChain) problems.push('Test wallet relays and the simulated chain are not allowed.');
  if (database === ':memory:') problems.push('Use a database file: an in-memory database loses every payment record on restart.');
  // A server that only listens on this computer needs no TLS. Anything reachable from outside does.
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(env.HOST ?? '127.0.0.1');
  if (env.DOMINION_HTTPS !== 'true' && !loopback) problems.push('DOMINION_HTTPS must be true: session cookies must be Secure and the site must be served over TLS.');
  if (!['owner', 'independent'].includes(env[name('ATTESTOR_OPERATION')])) problems.push(name('ATTESTOR_OPERATION') + ' must say who runs the attestors: "independent" or "owner". Owner-operated attestors work, but are disclosed to players as not independent.');
  if (storedNetworks.some(id => id !== NETWORK_ID)) problems.push('This database holds payments of another network (' + storedNetworks.filter(id => id !== NETWORK_ID).join(', ') + '). Mainnet starts with a new, empty database.');
  if (!chain.enabled) return problems; // free play only: no money can move
  if (kingdomCustody !== 'covenant' || vaultCustody !== 'covenant') problems.push('Custody must be "covenant".');
  if (allocationPolicy !== GAMEPLAY_ALLOCATION) problems.push('The allocation policy must be the final 50/20/20/10 split.');
  if (pricing !== PRICING) problems.push('The price book must be the current one (' + PRICING + ').');
  if (personalVault !== 'closed') problems.push('The personal vault must stay closed: the War Chest is the one player treasury.');
  if (!chain.treasuryPublicKey || !chain.payoutsEnabled) problems.push(name('TREASURY_PRIVATE_KEY') + ' (the game automation key) is missing.');
  if (!chain.developmentAddress) problems.push(name('DEVELOPMENT_ADDRESS') + ' (your one receiving address) is missing.');
  const attestors = chain.prizeAttestors ?? [];
  if (attestors.length < 2) problems.push(name('PRIZE_ATTESTOR_KEYS') + ' needs at least two ' + ATTESTOR_ADJECTIVE + ' attestor public keys (three recommended): with one, a lost game key locks the season pool and the game key sits on the raid panel.');
  if (attestors.includes(chain.treasuryPublicKey)) problems.push('An attestor key equals the game automation key. Every attestor needs its own key.');
  if (!(chain.minConfirmations >= 2)) problems.push(name('MIN_CONFIRMATIONS') + ' must be at least 2.');
  if (!env[name('RPC_URL')] && env[name('REQUIRE_WITNESS')] === 'false') problems.push('Without an own node (' + name('RPC_URL') + '), ' + name('REQUIRE_WITNESS') + ' must not be false: a single public server could lie about a confirmation.');
  return problems;
}

export function createApp({ database = resolve(root, process.env.DOMINION_DB ?? 'var/dominion.sqlite'),
  localDemo = process.env.DOMINION_LOCAL_DEMO !== 'false', clock = Date.now, chain: providedChain,
  adminToken = process.env.VAULTBORN_ADMIN_TOKEN, war = kingdom, testWizardRelay, raffleRules,
  territoryAssets: providedAssets, politicalAssets:providedPoliticalAssets, simulatedChain=false,
  registrationRate = Number(process.env.DOMINION_REGISTRATION_RATE) || 480, sessionCookieName = 'dominion',
  trustProxy = process.env.DOMINION_TRUST_PROXY === 'true', maxCities = Number(process.env.DOMINION_MAX_CITIES) || 5000,
  walletConnect = Boolean(testWizardRelay || (providedChain ? providedChain.enabled : process.env.VAULTBORN_WALLET_CONNECT !== 'false')),
  walletRead = Boolean(testWizardRelay || (providedChain ? providedChain.enabled : networkEnv('GAME') !== 'false')),
  allocationPolicy=process.env.DOMINION_ALLOCATION_POLICY??GAMEPLAY_ALLOCATION,
  prizeDust=process.env.VAULTBORN_PRIZE_DUST??'carrier', carrierWait=Number(process.env.VAULTBORN_CARRIER_WAIT_MS)||10*60_000,
  vaultCustody=process.env.VAULTBORN_VAULT_CUSTODY??'covenant', vaultRecoveryDays=Number(process.env.VAULTBORN_VAULT_RECOVERY_DAYS)||7,
  kingdomCustody=process.env.VAULTBORN_KINGDOM_CUSTODY??'covenant', kingdomRecoveryDays=Number(process.env.VAULTBORN_KINGDOM_RECOVERY_DAYS)||7,
  chestRecoveryDays=Number(process.env.VAULTBORN_CHEST_RECOVERY_DAYS)||3, captureAge=Number(process.env.VAULTBORN_CAPTURE_AGE_BLOCKS)||144,
  requireFinancialConfiguration=process.env.VAULTBORN_REQUIRE_FINANCIAL_CONFIGURATION==='true',
  // The price book of new checkouts. Earlier books exist to verify what was funded under them; tests name one explicitly.
  pricing=PRICING, personalVault='closed' } = {}) {
  if (!Number.isInteger(registrationRate) || registrationRate < 1 || registrationRate > 5000) throw new Error('Invalid registration rate.');
  if (!Number.isInteger(maxCities) || maxCities < 16 || maxCities > 100_000) throw new Error('Invalid city limit.');
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(sessionCookieName)) throw new Error('Invalid session cookie name.');
  const sessionCookiePattern = new RegExp('(?:^|;\\s*)' + sessionCookieName + '=([a-f0-9]{64})(?:;|$)');
  const proofCookieName=sessionCookieName+'_proof';
  const proofCookiePattern=new RegExp('(?:^|;\\s*)'+proofCookieName+'=([a-f0-9]{64})(?:;|$)');
  if (![GAMEPLAY_ALLOCATION,LEGACY_ALLOCATION].includes(allocationPolicy)) throw new Error('Invalid gameplay allocation policy.');
  if (testWizardRelay && !/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(testWizardRelay)) throw new Error('The test wallet relay must use loopback.');
  const relayOrigins = walletConnect ? testWizardRelay ?? 'wss://relay.riften.net wss://relay.cauldron.quest' : '';
  const treasury = providedChain ? null : chipnetTreasuryConfig();
  if (!providedChain) assertNetworkEnvironment();
  const chain = providedChain ?? createChain({
    enabled: networkEnv('GAME') !== 'false',
    treasuryPublicKey: networkEnv('TREASURY_PUBLIC_KEY'),
    // The game automation key: either inline, or (better) in a file readable by this process only.
    treasuryPrivateKey: networkEnv('TREASURY_PRIVATE_KEY') || keyFile(networkEnv('TREASURY_KEY_FILE')),
    sponsorshipDevelopmentAddress: treasury.sponsorshipDevelopmentAddress,
    prizeAttestors: treasury.prizeAttestors,
    // Optional: more than a strict majority of the attestors. A smaller number is refused.
    ...(networkEnv('PRIZE_ATTESTOR_THRESHOLD') && { prizeAttestorThreshold: Number(networkEnv('PRIZE_ATTESTOR_THRESHOLD')) }),
    ...(Number(process.env.VAULTBORN_POOL_RECOVERY_DAYS) > 0 && { poolRecoveryDays: Number(process.env.VAULTBORN_POOL_RECOVERY_DAYS) }),
    developmentAddress: treasury.developmentAddress,
    rpcUrl: networkEnv('RPC_URL'),
    rpcUser: networkEnv('RPC_USER'),
    rpcPassword: networkEnv('RPC_PASSWORD'),
    electrumHost: networkEnv('ELECTRUM_HOST'),
    minConfirmations: Math.max(1, Number(networkEnv('MIN_CONFIRMATIONS')) || NETWORK_PROFILE.minConfirmations),
  });
  const territoryAssets = providedAssets ?? (networkEnv('TERRITORY_CATEGORY') ? createTerritoryAssets({
    database:database === ':memory:' ? ':memory:' : resolve(root,networkEnv('TERRITORY_JOURNAL') ?? 'var/territory-assets.sqlite'),
    operatorPrivateKey:networkEnv('TERRITORY_ISSUER_KEY') || keyFile(networkEnv('TERRITORY_ISSUER_KEY_FILE')), operatorPublicKey:networkEnv('TERRITORY_ISSUER_PUBLIC_KEY'),
    category:networkEnv('TERRITORY_CATEGORY'), genesisTxid:networkEnv('TERRITORY_GENESIS'),
    electrumHost:networkEnv('ELECTRUM_HOST'), minConfirmations:chain.minConfirmations, clock,
  }) : undefined);
  const politicalAssets=providedPoliticalAssets ?? (networkEnv('POLITICS_CATEGORY') ? createTerritoryAssets({
    database:database === ':memory:' ? ':memory:' : resolve(root,networkEnv('POLITICS_JOURNAL') ?? 'var/political-assets.sqlite'),
    operatorPrivateKey:networkEnv('POLITICS_ISSUER_KEY') || keyFile(networkEnv('POLITICS_ISSUER_KEY_FILE')),operatorPublicKey:networkEnv('POLITICS_ISSUER_PUBLIC_KEY'),
    category:networkEnv('POLITICS_CATEGORY'),genesisTxid:networkEnv('POLITICS_GENESIS'),
    electrumHost:networkEnv('ELECTRUM_HOST'),minConfirmations:chain.minConfirmations,clock,
  }) : undefined);
  const store = openStore(database, createWorld(clock()));
  if (REAL_VALUE) {
    const problems = mainnetStartupProblems({ localDemo, chain, database, kingdomCustody, vaultCustody, allocationPolicy, pricing, personalVault,
      testWizardRelay, simulatedChain, storedNetworks: [...new Set(store.payments().map(row => row.network).filter(Boolean))] });
    if (problems.length) { store.close?.(); throw new Error('Mainnet start refused:\n - ' + problems.join('\n - ')); }
    console.log('[network] MAINNET: real BCH. Developer address ' + chain.developmentAddress + '; ' + chain.attestorThreshold + ' of ' + chain.prizeAttestors.length + ' attestors.');
    const banner = blazeBanner({ developmentAddress: chain.developmentAddress });
    if (banner.enabled && banner.missing.length) console.warn('[blaze] The home page banner is missing: ' + banner.missing.join(', ') + '. Fill in config/blaze.json.');
  } else if ([...new Set(store.payments().map(row => row.network).filter(Boolean))].some(id => id !== NETWORK_ID)) {
    store.close?.(); throw new Error('This database holds payments of another network. Use a separate database per network.');
  }
  const identity = createIdentity({store,clock,fail});
  // The server answers the wallet itself while the player is in the wallet app (see wizard-pair.mjs).
  const wizardPairing = walletConnect ? createWizardPairing({ testRelay: testWizardRelay }) : null;
  const listeners = new Set();
  const rate = new Map();
  // The last whole-wallet balance of each player, kept for a few seconds so that repeated renders do not query the indexer.
  // What the blockchain campaign tasks need: a verified wallet, and the kinds of this kingdom's confirmed BCH payments.
  const chainFacts = player => ({ wallet: Boolean(store.wallet(player)),
    paid: [...new Set(store.payments(player).filter(row => row.direction !== 'outgoing' && row.state === 'credited' && row.txid).map(row => row.action))] });
  const walletTotals = new Map();
  // The BCH on every address of a wallet, read at most every 15 seconds per kingdom.
  async function wholeWallet(player, keys) {
    if (!walletRead || !chain.walletBalances) throw new Error('Balance service offline.');
    const id = keys.map(key => key.script).join(',');
    const cached = walletTotals.get(player);
    if (cached && cached.id === id && clock() - cached.at < 15_000) return cached.result;
    const amounts = await chain.walletBalances(keys.map(key => key.script));
    const funded = keys.map((key, index) => ({ address: key.address, path: key.path, index: key.index, satoshis: amounts[index] })).filter(item => item.satoshis > 0);
    const result = { totalSatoshis: funded.reduce((total, item) => total + item.satoshis, 0), checked: keys.length, funded };
    walletTotals.set(player, { id, at: clock(), result });
    if (walletTotals.size > 2_000) walletTotals.delete(walletTotals.keys().next().value);
    return result;
  }
  // CashTokens on the linked address and on every other funded address of the wallet (at most 12 addresses).
  async function walletTokens(address, whole) {
    const addresses = [...new Set([address, ...(whole?.funded ?? []).map(item => item.address)])].slice(0, 12);
    const lists = await Promise.allSettled(addresses.map(item => chain.listCashTokens(item)));
    if (lists.every(item => item.status === 'rejected')) throw lists[0].reason;
    const seen = new Set();
    return lists.flatMap(item => item.status === 'fulfilled' ? item.value : []).filter(token => {
      const key = token.txid + ':' + token.vout;
      return !seen.has(key) && seen.add(key);
    });
  }
  let currentRevision = store.read().revision;
  const notify = (revision = store.read().revision) => {
    currentRevision = revision;
    for (const listener of listeners) {
      if (listener.writableLength > 8192) listener.end();
      else listener.write(`data: ${JSON.stringify({ revision })}\n\n`);
    }
  };
  if (chain.enabled && !chain.developmentAddress) console.warn(networkEnvName('DEVELOPMENT_ADDRESS') + ' is not set: Development shares stay under the game automation key and sponsorship is closed.');
  if (chain.enabled && chain.developmentAddress && !chain.prizeAttestors?.length) console.warn(networkEnvName('PRIZE_ATTESTOR_KEYS') + ' is not set: sponsorship is closed.');
  // One clear statement of what the financial configuration allows, and why anything is closed.
  const financial = financialReadiness({ chain, kingdomCustody, vaultCustody });
  if (chain.enabled) for (const line of financial.lines) console.warn('[financial configuration] ' + line);
  if (requireFinancialConfiguration && financial.blocking.length) {
    throw new Error('The financial configuration is incomplete (VAULTBORN_REQUIRE_FINANCIAL_CONFIGURATION is set): ' + financial.blocking.join(' '));
  }
  const portal = createPortal({ store, clock, fail, adminToken, sponsorshipMinimumSatoshis: chain.sponsorshipMinimumSatoshis });
  // Matched stakes need the covenant custody and the separate-stake policy; any other configuration keeps the earlier book.
  const activePricing = kingdomCustody==='covenant' && allocationPolicy===GAMEPLAY_ALLOCATION && chain.createRaidIntent ? pricing : LEGACY_PRICING;
  const book = priceBook(activePricing);
  const territory = createTerritoryProtocol({ store,chain,clock,gameplay:territoryGame,war,fail,notify,policy:raffleRules,assets:territoryAssets,allocationPolicy,pricing:activePricing });
  const politics=createPoliticsProtocol({store,chain,clock,notify,fail,assets:politicalAssets});
  store.transaction(() => {
    const { world } = store.read();
    const original = JSON.stringify(world);
    territory.ensure(world,clock());
    if (JSON.stringify(world) !== original) store.write(world);
  });
  const ledger = createLedger({ store, chain, clock, quote, command, advance, notify, fail, portal, war, territory, politics, allocationPolicy,
    prizeDust, carrierWait, vaultCustody, vaultRecoveryDays, kingdomCustody, kingdomRecoveryDays, chestRecoveryDays, captureAge, pricing:activePricing, personalVault });
  const walletCheckout = createWalletCheckout({ store, chain, ledger, clock, notify, fail });

  function stateFor(player, { visit = false } = {}) {
    return store.transaction(() => {
      const { world, revision } = store.read();
      const now = clock();
      let current = revision;
      const lastVisit = visit ? store.kingdomChronicle(player)?.checkpoint?.at : null;
      if (visit && lastVisit != null && now-lastVisit >= awayThreshold && world.now < now) {
        const previousBattle = world.battles[0]?.id;
        advance(world, now);
        territory.tick(world, now);
        registerNewBattles(store, world, previousBattle, null, null, now);
        current = store.write(world);
      }
      const view = snapshot(world, player, now);
      // Campaign tasks that need a wallet or a confirmed BCH payment are checked against what the server knows.
      view.player = { ...view.player, tasks: taskSnapshot(world, world.cities[player], chainFacts(player)) };
      const vault = ledger.balances(player);
      const offlineReport = readKingdomChronicle(store,{world,view,player,vault,now},{visit});
      return { ...view, territories:territory.view(world,player,now), territoryRules:territory.rules(world,player,now),
        diplomacy:{...view.diplomacy,proofRecords:(world.politicalEvidence??[]).slice(-100).map(({id,treaty,conflict,kind,termsHash})=>({id,treaty,conflict,kind,termsHash}))},
        politicalAssets:politicalAssets?.list().filter(asset=>asset.controllerId===player) ?? [],
        territoryAssets:territoryAssets?.list().filter(asset => asset.holderAddress && asset.controllerId === player) ?? [],
        config: chain.supportsVaultborn ? { ...view.config, fees:checkoutFees(allocationPolicy,activePricing), allocationPolicy, pricing:activePricing,
          ...(book.raid.matched ? { raid:{ matched:true, minimumStake:book.raid.minimumStake, maximumStake:book.raid.maximumStake, step:book.raid.step, suggested:book.raid.suggested },
            stakes:book.stakes, warChest:book.warChest, reserves:book.reserves, personalVault } :
            { competitiveRaid:paymentAllocation(checkoutFees(allocationPolicy).attack,'attack-paid',allocationPolicy) }),
          ...(ledger.unified && { economy:{ model:SERVICE_ALLOCATION, serviceSplit, rewardReserveSatoshis:PRIZE_FEED_RESERVE,
            ...(book.raid.matched ? { networkReserveSatoshis:PRIZE_FEED_RESERVE, warChestReserveSatoshis:0, recordReserveSatoshis:book.reserves.record, matchedStakes:true } :
              { networkReserveSatoshis:PRIZE_FEED_RESERVE + CHEST_FEED_RESERVE, warChestReserveSatoshis:CHEST_FEED_RESERVE, capturePercent:bchPolicy.capturePercent, chestWaitBlocks:CHEST_FEED_WAIT_BLOCKS }),
            chestExitBlocks:CHEST_EXIT_BLOCKS, attestors:chain.prizeAttestors?.length ?? 0, attestorThreshold:chain.attestorThreshold ?? null } }) } : view.config,
        revision:current, wallet: store.wallet(player), identity:identity.summary(player), signIn:identity.signIn(player),
        payments: ledger.list(player), vault, offlineReport,
        sponsors: portal.sponsors().publicCampaigns,
        chain: { enabled: chain.enabled, attestorOperation: ATTESTOR_OPERATION, attestorNote: ATTESTOR_NOTE, network: NETWORK_ID, networkLabel: NETWORK_LABEL, addressPrefix: ADDRESS_PREFIX, explorer: NETWORK_PROFILE.explorer, minConfirmations: chain.minConfirmations ?? 2,
          walletConnect, walletRead, payouts: ledger.payoutsEnabled, mainnet: REAL_VALUE, realMoneyPvp: REAL_VALUE && chain.enabled, testWizardRelay, simulated:simulatedChain }, demo: localDemo };
    });
  }

  function currentSession(req) {
    const secret=req.headers.cookie?.match(sessionCookiePattern)?.[1];
    const token=secret && hash(secret);
    const player=token && store.session(token,clock());
    return player ? {token,player} : null;
  }

  const existingAccount=req=>currentSession(req)?.player;
  // The address a page was requested at, for its link-preview tags. Only a plain host name (and port) is used; anything
  // else leaves the tags relative.
  const siteOrigin=req=>{
    const host=String(req.headers.host??'').toLowerCase();
    return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/.test(host) ? (isSecure(req)?'https':'http')+'://'+host : '';
  };
  const isSecure=req=>process.env.DOMINION_HTTPS==='true' || req.socket.encrypted;
  function setCookie(req,res,name,secret,maxAge,path='/') {
    res.appendHeader('Set-Cookie',`${name}=${secret}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecure(req)?'; Secure':''}`);
  }
  const sessionCookie=(req,res,secret)=>setCookie(req,res,sessionCookieName,secret,2592000);
  const clearProofCookie=(req,res)=>setCookie(req,res,proofCookieName,'',0,'/api/identity');

  function proofCookie(req,res,create) {
    const previous=req.headers.cookie?.match(proofCookiePattern)?.[1];
    const secret=previous ?? (create ? randomBytes(32).toString('hex') : null);
    if (create) setCookie(req,res,proofCookieName,secret,300,'/api/identity');
    return secret && hash(secret);
  }

  // Links a proven wallet to a kingdom. One wallet belongs to one kingdom, and a kingdom with money at risk keeps its wallet.
  function linkWallet(player, address, publicKey) {
    const oldWallet = store.wallet(player);
    if (oldWallet && oldWallet.address !== address && war.balance(store.read().world, player, clock()).atRiskSatoshis > 0) {
      fail(409, 'Your War Chest is locked to the wallet you connected before. Connect that wallet, or withdraw your War Chest before changing wallets.');
    }
    if (!store.bindWallet(player, address, publicKey, clock())) fail(409, 'This wallet already belongs to another kingdom. Sign out, then enter that kingdom with this wallet from the start page.');
    return store.wallet(player);
  }

  function account(req, res, data) {
    if (Object.hasOwn(data, 'entry') && data.entry !== 'new') fail(400, 'Choose a valid way to enter the kingdom.');
    const existing = existingAccount(req);
    const now = clock();
    if (existing) {
      if (typeof data.name === 'string' && data.name.trim()) {
        const revision = store.transaction(() => {
          const { world } = store.read();
          if (!world.cities?.[existing]?.founding) return;
          command(world, existing, { type: 'found', name: data.name, cityName: data.cityName, faction: data.faction }, now);
          return store.write(world);
        });
        if (revision) notify(revision);
      }
      return { player: existing, created: false };
    }
    const secret = randomBytes(32).toString('hex');
    const result = store.transaction(() => {
      const { world } = store.read();
      const seat = data.demo ?? data.seat;
      const pick = localDemo && demoSeats.has(seat) ? seat
        : localDemo && data.entry !== 'new' && !data.name && !store.hasSeat('p1') ? 'p1' : undefined;
      if (pick && store.hasSeat(pick)) fail(409, 'That demo seat already belongs to a session.');
      const id = pick ?? randomUUID();
      if (!pick) {
        if (Object.keys(world.cities).length >= maxCities) fail(503, 'This realm is full. Sign in to an existing kingdom or try again later.');
        addPlayer(world, { id, name: data.name, faction: data.faction, cityName: data.cityName }, now);
        territory.ensure(world, now);
      }
      store.addSession(hash(secret), id, now + 30 * day);
      store.write(world);
      return { player: id, created: !pick };
    });
    sessionCookie(req,res,secret);
    notify();
    return result;
  }

  // Behind a trusted reverse proxy the client address is the last forwarded hop. A signed-in player has an own budget.
  function clientAddress(req) {
    const forwarded = trustProxy && typeof req.headers['x-forwarded-for'] === 'string' ?
      req.headers['x-forwarded-for'].split(',').at(-1).trim().slice(0, 64) : '';
    return forwarded || req.socket.remoteAddress || 'unknown';
  }
  function limit(req, registration = false) {
    const player = registration ? null : existingAccount(req);
    const key = registration ? 'signup:' + clientAddress(req) : player ? 'player:' + player : 'api:' + clientAddress(req);
    const now = clock();
    const record = rate.get(key);
    if (!record || now - record.start > 60_000) rate.set(key, { start: now, count: 1 });
    else if (++record.count > (registration ? registrationRate : 480)) fail(429, 'Too many requests. Try again in a minute.');
  }

  async function api(req, res, url) {
    if (req.method !== 'GET' || ['/api/session','/api/state','/api/attack-preview','/api/training-preview','/api/market-preview','/api/wallet/assets'].includes(url.pathname)) {
      limit(req, req.method === 'POST' && url.pathname === '/api/session');
    }
    if (req.method === 'POST' && (req.headers['sec-fetch-site'] === 'cross-site' ||
      (req.headers.origin && URL.parse(req.headers.origin)?.host !== req.headers.host))) fail(403, 'Use the game’s own origin.');
    if (identity.isRoute(url.pathname)) {
      const site=URL.parse(`${isSecure(req)?'https':'http'}://${req.headers.host??''}`)?.origin;
      if (!site || site.length>200) fail(400,'Use the game’s own origin.');
      // A kingdom may have been created or opened: everyone watching the realm hears about it afterwards.
      if (url.pathname==='/api/identity/wizard/verify') res.once('finish',()=>notify());
      return identity.handle(req,res,url.pathname,{readJson,json,stateFor,session:()=>currentSession(req),
        origin:site,browser:create=>proofCookie(req,res,create),
        linkWallet,pairing:wizardPairing,
        // A wallet nobody has used here before starts a new kingdom, under the same limits as "Play now".
        createKingdom() {
          limit(req,true);
          const { world } = store.read();
          if (Object.keys(world.cities).length >= maxCities) fail(503, 'This realm is full. Sign in to an existing kingdom or try again later.');
          const id = randomUUID();
          addPlayer(world, { id }, clock());
          territory.ensure(world, clock());
          store.write(world);
          return id;
        },
        newSession(player) {
          const secret=randomBytes(32).toString('hex');
          store.renewIdentitySession(hash(secret),player,clock()+30*day);
          sessionCookie(req,res,secret);
          clearProofCookie(req,res);
        },
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, network: NETWORK_ID });
    if (req.method==='GET' && url.pathname==='/api/public/politics') return json(res,200,politics.publicProof());
    const politicalAsset=url.pathname.replace(/%3a/ig,':').match(/^\/api\/public\/political-assets\/([a-z0-9:_-]{1,160})$/i)?.[1];
    if (req.method==='GET' && politicalAsset) {
      limit(req);
      const proof=await politicalAssets?.verify(politicalAsset);
      if (!proof) fail(404,'Political charter unavailable.');
      return json(res,200,proof);
    }
    if (req.method === 'GET' && url.pathname === '/api/public/ledger') return json(res,200,{
      ...ledger.explorer(), territoryAssets:territoryAssets?.list().slice(-100).reverse() ?? [],
      source:simulatedChain?'simulated':chain.enabled?NETWORK_ID:'offline',
      territoryAuthority:territoryAssets?.authority() ?? null,
      politicalAuthority:politicalAssets?.authority() ?? null,
    });
    const territoryId = url.pathname.match(/^\/api\/public\/territories\/([a-z0-9-]{1,80})$/)?.[1];
    if (req.method === 'GET' && territoryId) {
      const proof = territory.verify(territoryId);
      if (!proof) fail(404, 'Territory unavailable.');
      return json(res,200,proof);
    }
    const assetId = url.pathname.replace(/%3a/ig,':').match(/^\/api\/public\/territory-assets\/([a-z0-9:_-]{1,160})$/i)?.[1];
    if (req.method === 'GET' && assetId) {
      if (!territoryAssets) fail(503,'Territory CashTokens are not configured on this instance.');
      limit(req);
      const proof = await territoryAssets.verify(assetId);
      if (!proof) fail(404,'Territory asset unavailable.');
      return json(res,200,proof);
    }
    const battleId = url.pathname.match(/^\/api\/public\/battle\/(b\d{1,12})$/)?.[1];
    if (req.method === 'GET' && battleId) {
      const battle = readBattle(store, battleId, existingAccount(req), clock(),{cinematic:url.searchParams.get('cinematic')==='1'});
      if (!battle) fail(404, 'Battle unavailable. New records open to the public after 24 hours.');
      return json(res, 200, battle);
    }
    // Prize attestation is public: proposals carry no secrets and a signature authenticates itself.
    if (req.method === 'GET' && url.pathname === '/api/public/prize-awards') {
      return json(res, 200, { attestors: chain.prizeAttestors ?? [], pending: ledger.pendingAwards() });
    }
    if (req.method === 'GET' && url.pathname === '/api/public/season-result') return json(res, 200, { result: ledger.seasonResult() });
    if (req.method === 'GET' && url.pathname === '/api/public/season-anchors') {
      const season = Number(url.searchParams.get('season') ?? store.read().world.season.number);
      return json(res, 200, { season, anchors: ledger.anchors(season) });
    }
    // The season score journal: every score event of a season, hash-chained, for anyone to recompute the standings from.
    if (req.method === 'GET' && url.pathname === '/api/public/season-events') {
      const { world } = store.read();
      const season = Number(url.searchParams.get('season') ?? world.season.number);
      const from = Math.max(1, Number(url.searchParams.get('from')) || 1);
      if (!Number.isSafeInteger(season) || season < 1) fail(400, 'Choose a season number.');
      const entries = readJournal(store, season);
      return json(res, 200, { season, genesis: genesis(season), count: entries.length, head: entries.at(-1)?.hash ?? genesis(season),
        closed: entries.at(-1)?.kind === 'season-close', from, entries: entries.slice(from - 1, from - 1 + 2000), rules: scoreRules });
    }
    const evidenceId = url.pathname.match(/^\/api\/public\/prize-awards\/([a-f0-9]{32})\/evidence$/)?.[1];
    if (req.method === 'POST' && evidenceId) return json(res, 200, { result: ledger.evidence(evidenceId, await readJson(req)) });
    const awardId = url.pathname.match(/^\/api\/public\/prize-awards\/([a-f0-9]{32})\/attest$/)?.[1];
    if (req.method === 'POST' && awardId) return json(res, 200, { result: await ledger.attestAward(awardId, await readJson(req)) });
    if (req.method === 'GET' && url.pathname === '/api/public/sponsors') return json(res, 200, portal.sponsors(existingAccount(req)));
    const logoId = url.pathname.match(/^\/api\/public\/sponsors\/([a-f0-9-]{36})\/logo$/)?.[1];
    if (req.method === 'GET' && logoId) {
      const logo = portal.activeSponsor(logoId).logo;
      if (!logo) fail(404, 'Logo unavailable.');
      res.writeHead(200, { 'Content-Type': logo.type, 'Cache-Control': 'public, max-age=120' });
      return res.end(Buffer.from(logo.data, 'base64'));
    }
    if (req.method === 'GET' && url.pathname === '/api/council') return json(res, 200, portal.proposals(existingAccount(req)));
    if (url.pathname.startsWith('/api/admin/')) {
      portal.requireAdmin(req);
      if (req.method === 'GET' && url.pathname === '/api/admin/sponsors') return json(res, 200, portal.adminList());
      if (req.method === 'POST' && url.pathname === '/api/admin/sponsors/review') {
        const body = await readJson(req);
        return json(res, 200, store.transaction(() => portal.reviewSponsor(body)));
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/payments') return json(res, 200, { payments: ledger.attention() });
      if (req.method === 'POST' && url.pathname === '/api/admin/payouts/void') {
        return json(res, 201, { result: await ledger.voidPayout(await readJson(req)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/political-escrow/return') {
        return json(res, 201, { result: await ledger.refundMisfundedEscrow(await readJson(req)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/payments/write-off') {
        return json(res, 200, { result: ledger.resolveReorg(await readJson(req)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/council/quote') {
        return json(res, 200, ledger.daoQuote((await readJson(req)).id));
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/council/spend') {
        return json(res, 201, await ledger.daoSpend(await readJson(req)));
      }
      fail(404, 'This administrator action does not exist.');
    }
    if (url.pathname === '/api/session') {
      // The start page also learns whether wallets can pair here, so that it can offer "Connect wallet".
      if (req.method === 'GET') return json(res, 200, { authenticated: Boolean(existingAccount(req)), demo: localDemo, walletConnect, ...(testWizardRelay && { testWizardRelay }) });
      if (req.method !== 'POST') fail(405, 'Use GET to check a session or POST to enter the kingdom.');
      const data = await readJson(req);
      if (Object.hasOwn(data, 'includeState') && typeof data.includeState !== 'boolean') fail(400, 'Choose whether to include the initial game state.');
      const result = account(req, res, data);
      if (data.includeState === false) return json(res, 200, { result });
      return gameStateJson(req, res, { result, state: stateFor(result.player,{visit:true}) });
    }
    if (req.method==='POST' && url.pathname==='/api/session/logout') {
      const data=await readJson(req);
      store.transaction(()=>{
        const current=currentSession(req);
        if (!current) return;
        const credentials=identity.signIn(current.player);
        // A kingdom without a wallet or Nostr sign-in cannot be opened again once left: only when the player says so.
        if (!credentials.bch && !credentials.nostr && data?.leaveForGood!==true) fail(409,'Set up a BCH or Nostr sign-in method before leaving your kingdom.');
        store.revokeSession(current.token);
      });
      setCookie(req,res,sessionCookieName,'',0);
      clearProofCookie(req,res);
      return json(res,200,{result:{authenticated:false}});
    }
    const player = existingAccount(req);
    if (!player) fail(401, 'Enter the kingdom to continue.');
    if (req.method === 'POST' && url.pathname === '/api/kingdom/risk') {
      // There is one player treasury, the War Chest, and all of it is always at risk. Nothing can be switched on or off.
      if (ledger.riskCeiling(player) !== null) fail(410, 'There is no risk setting. Your whole War Chest is always at risk in paid PvP; withdraw from it to reduce your exposure.');
      const body = await readJson(req);
      if (body.consent !== true) fail(400, 'Give explicit consent to the kingdom commitment.');
      if (!store.wallet(player)) fail(403, 'Connect your wallet first.');
      if (ledger.balances(player).quarantined) fail(409, 'Kingdom commitments are paused for chain recovery.');
      const result = store.transaction(() => {
        const { world } = store.read();
        if (body.satoshis > 0 && !world.cities[player]?.optIn) fail(409, 'Join seasonal PvP before committing kingdom funds.');
        // With covenant custody only money the owner's wallet paid into a war chest can be at risk.
        const ceiling = ledger.riskCeiling(player);
        if (ceiling !== null && body.satoshis > Math.min(ceiling, war.balance(world, player, clock()).atRiskSatoshis)) {
          fail(409, 'Fund your war chest from your wallet to put more at risk. This control can only lower the amount at risk.');
        }
        const outcome = war.commit(world, player, body.satoshis, clock(), store.wallet(player)?.address);
        store.write(world);
        return outcome;
      });
      notify();
      return json(res, 200, { result, state: stateFor(player) });
    }
    if (req.method === 'POST' && url.pathname === '/api/sponsors') {
      const body = await readJson(req);
      return json(res, 201, store.transaction(() => portal.proposeSponsor(player, body)));
    }
    const tracked = url.pathname.match(/^\/api\/sponsors\/([a-f0-9-]{36})\/(click|impression)$/);
    if (req.method === 'POST' && tracked) return json(res, 200, portal.trackSponsor(player, tracked[1], tracked[2]));
    if (req.method === 'POST' && url.pathname === '/api/council/proposals') {
      const body = await readJson(req);
      return json(res, 201, store.transaction(() => portal.propose(player, body)));
    }
    if (req.method === 'POST' && url.pathname === '/api/council/vote') {
      const body = await readJson(req);
      return json(res, 200, store.transaction(() => portal.vote(player, body)));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return gameStateJson(req, res, stateFor(player,{visit:url.searchParams.get('background')!=='1'}));
    }
    if (req.method === 'GET' && url.pathname === '/api/market-preview') {
      const {world} = store.read();
      const now = clock();
      advance(world, now);
      const {searchParams} = url;
      const amount = searchParams.get('amount') ?? '';
      const input = {give:searchParams.get('give'),take:searchParams.get('take'),amount:/^\d{1,3}$/.test(amount)?Number(amount):NaN};
      return json(res, 200, marketQuote(world.cities[player],input,now));
    }
    if (req.method === 'GET' && url.pathname === '/api/training-preview') {
      const {world} = store.read();
      const now = clock();
      advance(world, now);
      const count = url.searchParams.get('count') ?? '';
      return json(res,200,trainingQuote(world,world.cities[player],url.searchParams.get('unit'),/^\d{1,2}$/.test(count)?Number(count):NaN,now));
    }
    if (req.method === 'POST' && url.pathname === '/api/offline-report/dismiss') {
      const {id} = await readJson(req);
      if (typeof id!=='string'||!/^away-\d{1,16}-\d{1,16}$/.test(id)) fail(400,'Choose a valid kingdom report.');
      const report = store.transaction(() => dismissKingdomChronicle(store,player,id));
      if (!report) fail(404,'That kingdom report is unavailable.');
      return json(res, 200, report);
    }
    if (req.method === 'GET' && url.pathname === '/api/attack-preview') {
      const {world}=store.read();
      const now=clock();
      advance(world,now);
      const input=Object.fromEntries(['target','hero','tactic','formation'].flatMap(key=>url.searchParams.has(key)?[[key,url.searchParams.get(key)]]:[]));
      const outlook=attackPreview(world,player,input,now);
      // `stake` is the attacker's chosen S under matched stakes; the earlier book has one fixed raid price.
      const stake=url.searchParams.has('stake') ? Number(url.searchParams.get('stake')) : undefined;
      const raid=chain.supportsVaultborn && typeof input.target==='string' ? ledger.raidPreview(world,player,input.target,
        book.raid.matched ? stake : checkoutFees(allocationPolicy).attack,now) : null;
      return json(res,200,raid ? {...outlook,raid} : outlook);
    }
    if (req.method === 'POST' && url.pathname === '/api/wallet/challenge') {
      const data = await readJson(req);
      if (existingAccount(req)!==player) fail(401,'Enter the kingdom to continue.');
      let address;
      try {
        const decoded = decodeAddress(data.address);
        if (!decoded.script.startsWith('76a914')) fail(400, 'A personal ' + NETWORK_LABEL + ' P2PKH CashAddr is required.');
        address = decoded.address;
      } catch { fail(400, 'A personal ' + NETWORK_LABEL + ' P2PKH CashAddr is required.'); }
      const expiresAt = clock() + 5 * 60_000;
      const challenge = `BCH Dominion ${NETWORK_LABEL} link\nCity: ${player}\nAddress: ${address}\nExpires: ${new Date(expiresAt).toISOString()}\nNonce: ${randomBytes(24).toString('hex')}`;
      store.saveChallenge(player, address, challenge, expiresAt);
      return json(res, 200, { result: { address, challenge, expiresAt } });
    }
    if (req.method === 'POST' && url.pathname === '/api/wallet/verify') {
      const proof = await readJson(req);
      const result = store.transaction(() => {
        if (existingAccount(req)!==player) fail(401,'Enter the kingdom to continue.');
        const challenge = store.challenge(player);
        if (!challenge || challenge.expires <= clock()) fail(409, 'Generate a fresh wallet challenge.');
        const publicKey=proof.address===challenge.address && verifiedBchMessageKey({...proof,challenge:challenge.challenge});
        if (!publicKey) fail(400, 'The wallet proof does not match this challenge.');
        return linkWallet(player,proof.address,publicKey);
      });
      return json(res, 200, { result, state: stateFor(player) });
    }
    if (req.method === 'GET' && url.pathname === '/api/wallet/assets') {
      const linked=store.wallet(player);
      let wallet=linked;
      const requested=url.searchParams.get('address');
      if(requested){
        try {
          const decoded=decodeAddress(requested);
          if(!decoded.script.startsWith('76a914')) throw new Error('Unsupported address');
          wallet=decoded.address===linked?.address?linked:{address:decoded.address};
        } catch { fail(400,'Enter a personal ' + NETWORK_LABEL + ' P2PKH CashAddr.'); }
      }
      if (!wallet) fail(409, 'Choose a ' + NETWORK_LABEL + ' receiving address to inspect.');
      if (!walletRead) fail(503, 'The ' + NETWORK_LABEL + ' balance service is offline.');
      // The linked wallet is read whole (every address it shared), also when it is not connected right now.
      const known = wallet.address === linked?.address ? store.walletAddresses(player) : null;
      const whole = known?.some(key => key.address === wallet.address) ? await wholeWallet(player, known).catch(() => null) : null;
      const [balance, tokens] = await Promise.allSettled([chain.localWalletBalance(wallet.address), walletTokens(wallet.address, whole)]);
      if (balance.status === 'rejected' && tokens.status === 'rejected' && !whole) fail(503, '' + NETWORK_LABEL + ' wallet data is currently unavailable.');
      return json(res, 200, { wallet, verified:wallet.address===linked?.address, balance: balance.status === 'fulfilled' ? balance.value : null,
        tokens: tokens.status === 'fulfilled' ? tokens.value : null, ...(whole && { whole }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/wallet/balance') {
      // The whole wallet: an HD wallet keeps change and later payments on other addresses than the first receiving one.
      // The player's wallet shares the public keys of its first receiving and change addresses; only their balances are read.
      const body = await readJson(req);
      if (!Array.isArray(body.keys) || !body.keys.length || body.keys.length > 48) fail(400, 'Send between 1 and 48 wallet keys.');
      const keys = [];
      for (const key of body.keys) {
        if (!key || !['receive','change'].includes(key.path) || !Number.isSafeInteger(key.index) || key.index < 0 || key.index > 100_000) fail(400, 'Invalid derivation path.');
        let wallet;
        try { wallet = walletFromPublicKey(key.publicKey); } catch { fail(400, 'Invalid wallet public key.'); }
        if (!keys.some(item => item.script === wallet.script)) keys.push({ address: wallet.address, script: wallet.script, path: key.path, index: key.index });
      }
      if (!walletRead || !chain.walletBalances) fail(503, 'The ' + NETWORK_LABEL + ' balance service is offline.');
      // Kept for this kingdom only when the keys are those of its linked wallet.
      const linked = store.wallet(player);
      if (linked && keys.some(key => key.address === linked.address)) store.saveWalletAddresses(player, keys);
      try { return json(res, 200, await wholeWallet(player, keys)); }
      catch { fail(503, NETWORK_LABEL + ' wallet data is currently unavailable.'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (listeners.size >= 160) fail(503, 'Live connection capacity reached.');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
      listeners.add(res);
      res.write(`data: ${JSON.stringify({ revision: currentRevision })}\n\n`);
      res.on('close', () => listeners.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/command') {
      const data = await readJson(req);
      const requestId = req.headers['idempotency-key'] ?? data.requestId ?? randomUUID();
      if (typeof requestId !== 'string' || !/^[\w-]{6,80}$/.test(requestId)) fail(400, 'Invalid command identifier.');
      delete data.requestId;
      delete data.chainFacts;
      const input = canonical(data);
      const result = store.transaction(() => {
        const previous = store.previousCommand(player, requestId);
        if (previous) {
          if (previous.input !== input) fail(409, 'That request ID already identifies a different command.');
          return JSON.parse(previous.result);
        }
        const { world } = store.read();
        if (data.type === 'opt-in' && data.enabled === false && war.balance(world, player, clock()).atRiskSatoshis > 0) {
          fail(409, 'Release your committed kingdom funds before leaving seasonal PvP.');
        }
        const previousBattle = world.battles[0]?.id;
        advance(world, clock());
        if (data.type === 'claim-node') fail(402,'Open the territory’s ' + NETWORK_LABEL + ' claim window from the campaign map.');
        const outcome = ['territory-garrison','territory-fortify','territory-abandon','territory-aid'].includes(data.type) ?
          territory.change(world,player,data,clock()) : command(world, player,
            data.type === 'task-claim' || data.type === 'task-claim-all' ? { ...data, chainFacts: chainFacts(player) } : data, clock(), { paid: false });
        registerNewBattles(store, world, previousBattle, null, null, clock());
        store.write(world);
        store.recordCommand(player, requestId, input, outcome, clock());
        return outcome;
      });
      notify();
      return json(res, 200, { result, state: stateFor(player) });
    }
    if (req.method === 'GET' && url.pathname === '/api/payments') return json(res, 200, ledger.list(player));
    if (req.method === 'GET' && url.pathname === '/api/vault') return json(res, 200, ledger.balances(player));
    if (req.method === 'POST' && url.pathname === '/api/payments') {
      const body = await readJson(req);
      const context = await territory.prepare(body);
      const result = ledger.create(player,body,context);
      return json(res, 201, { result, state: stateFor(player) });
    }
    const walletPayment = url.pathname.match(/^\/api\/payments\/([a-zA-Z0-9_-]{6,80})\/wallet\/(prepare|broadcast)$/);
    if (req.method === 'POST' && walletPayment) {
      const body = await readJson(req);
      if (walletPayment[2] === 'prepare') return json(res, 200, { result: await walletCheckout.prepare(player, walletPayment[1], body) });
      const result = await walletCheckout.broadcast(player, walletPayment[1], body.signedTransaction);
      return json(res, 202, { result, state: stateFor(player) });
    }
    const submission = url.pathname.match(/^\/api\/payments\/([a-zA-Z0-9_-]{6,80})\/submit$/);
    if (req.method === 'POST' && submission) {
      const result = await ledger.submit(player, submission[1], (await readJson(req)).txid);
      return json(res, 200, { result, state: stateFor(player) });
    }
    if (req.method === 'POST' && url.pathname === '/api/vault/payout') {
      const result = await ledger.payout(player, await readJson(req));
      return json(res, 201, { result, state: stateFor(player) });
    }
    if (req.method === 'POST' && url.pathname === '/api/vault/quote') {
      const result = ledger.quotePayout(player, await readJson(req));
      return json(res, 200, { result });
    }
    fail(404, 'This action does not exist.');
  }

  async function staticFile(req, res, url) {
    const asset = url.pathname.startsWith('/art/');
    const publicDir = resolve(root, asset ? 'packages/assets' : 'apps/web');
    const pathname = decodeURIComponent(url.pathname);
    const verify = /^\/verify\/battle\/(b\d{1,12})$/.exec(pathname);
    const verifyTerritory = /^\/verify\/territory\/([a-z0-9-]{1,80})$/.exec(pathname);
    if (req.method==='GET' && pathname==='/verify/politics' && (url.searchParams.get('format')==='json' || req.headers.accept==='application/json')) {
      return json(res,200,politics.publicProof());
    }
    if (req.method === 'GET' && verifyTerritory && (url.searchParams.get('format') === 'json' || req.headers.accept === 'application/json')) {
      const record = territory.verify(verifyTerritory[1]);
      if (!record) fail(404,'Territory unavailable.');
      return json(res,200,record);
    }
    if (req.method === 'GET' && verify && (url.searchParams.get('format') === 'json' || req.headers.accept === 'application/json')) {
      const battle = readBattle(store, verify[1], existingAccount(req), clock());
      if (!battle) fail(404, 'Battle unavailable.');
      return json(res, 200, battle);
    }
    if (pathname === '/network.js' && ['GET', 'HEAD'].includes(req.method)) {
      // The browser's view of the network always comes from this process, never from a file that could be stale.
      const body = 'export const NETWORK = Object.freeze(' + JSON.stringify(browserNetwork()) + ');\nexport const NETWORK_LABEL = NETWORK.label;\nexport const ATTESTOR_ADJECTIVE = NETWORK.attestorAdjective;\nexport const explorerUrl = txid => NETWORK.explorer + txid;\n';
      res.writeHead(200, { 'Content-Type': types['.js'], 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (pathname === '/blaze.js' && ['GET', 'HEAD'].includes(req.method)) {
      // The hackathon banner of the home page; see config/blaze.mjs.
      const { missing, ...banner } = blazeBanner({ developmentAddress: chain.developmentAddress });
      const body = 'export const BLAZE = Object.freeze(' + JSON.stringify(banner) + ');\n';
      res.writeHead(200, { 'Content-Type': types['.js'], 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const entryRoute = pathname === '/' || pathname === '/index.html';
    const playRoute = pathname === '/play' || pathname === '/play/';
    const archiveRoute = archivePaths.has(pathname);
    const sessionRoute = entryRoute || playRoute || archiveRoute;
    const activePlayer = sessionRoute && existingAccount(req);
    const demoEntry = localDemo && demoSeats.has(url.searchParams.get('seat'));
    if (entryRoute && activePlayer && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(302, { Location: '/play' + url.search, 'Cache-Control': 'no-store', Vary: 'Cookie' });
      return res.end();
    }
    const inner = pathname==='/verify/politics' ? 'politics-proof.html' : verifyTerritory ? 'territory-proof.html' :
      verify ? 'citadel.html' : archiveRoute ? (activePlayer ? 'index.html' : 'citadel.html') :
      playRoute || (entryRoute && demoEntry) ? 'index.html' : entryRoute ? 'landing.html' :
      asset ? pathname.slice(5) : pathname.slice(1);
    let file = resolve(publicDir, inner);
    if (!file.startsWith(publicDir + sep) || !types[extname(file)] || !['GET', 'HEAD'].includes(req.method)) fail(404, 'File unavailable.');
    // The trailer can also stay where it was made (brag-output/), so the 33 MB file is not copied around.
    if (pathname === '/media/vaultborn-trailer.mp4' && !(await stat(file).catch(() => null))) file = resolve(root, 'brag-output', 'brag-narrated.mp4');
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) fail(404, 'File unavailable.');
    // Pages carry their own address in their link-preview tags; it is the address this request came in on.
    let page = null;
    if (extname(file) === '.html') {
      const text = await readFile(file, 'utf8');
      page = Buffer.from(text.includes('__SITE__') ? text.replaceAll('__SITE__', siteOrigin(req)) : text);
    }
    // A video is fetched in parts (the browser asks for byte ranges to start playing and to seek), and only when played.
    const media = pathname.startsWith('/media/');
    const range = media && !page && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] === '' ? Math.max(0, info.size - Number(range[2])) : Number(range[1]);
      const end = range[1] === '' || range[2] === '' ? info.size - 1 : Math.min(Number(range[2]), info.size - 1);
      if (!(start <= end && end < info.size)) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + info.size });
        return res.end();
      }
      res.writeHead(206, { 'Content-Type': types[extname(file)], 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' });
      if (req.method === 'HEAD') return res.end();
      return pipeline(createReadStream(file, { start, end }), res);
    }
    // Wallets and token explorers read the collectibles' metadata file and its pictures from pages of their own.
    const shared = pathname === '/.well-known/bitcoin-cash-metadata-registry.json' || /^\/art\/collectible-[a-z-]+\.png$/.test(pathname) || pathname === '/logo.png';
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Content-Length': page ? page.length : info.size,
      'Cache-Control': sessionRoute ? 'no-store' : asset ? 'public, max-age=3600' : media ? 'public, max-age=86400' : 'no-cache',
      ...(media && { 'Accept-Ranges': 'bytes' }), ...(sessionRoute && { Vary: 'Cookie' }), ...(shared && { 'Access-Control-Allow-Origin': '*' }) });
    if (req.method === 'HEAD') return res.end();
    if (page) return res.end(page);
    if (['.js', '.css'].includes(extname(file))) return res.end(await readFile(file));
    await pipeline(createReadStream(file), res);
  }

  const operatorRoutes = privateRoutes?.({ database, store, clock, isSecure, readJson, json });
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', `default-src 'self'; connect-src 'self' ${relayOrigins}; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, 'http://dominion.local');
      if (operatorRoutes && await operatorRoutes(req, res, url)) return;
      await (url.pathname.startsWith('/api/') ? api(req, res, url) : staticFile(req, res, url));
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status ?? error.statusCode ?? 500;
      if (status >= 500 && status !== 503) console.error('Request failed:', error.message);
      // Every refusal that comes from a missing wallet starts with the same sentence and carries the same code, so the
      // game can open the wallet connection instead of only showing an error.
      const code = error.code ?? (status === 403 && error.message.startsWith('Connect your wallet first') ? 'wallet-required' : undefined);
      json(res, status, { error: status >= 500 && status !== 503 ? 'The game server could not complete this request.' : error.message, code,
        ...(error.preview && { preview: error.preview }) });
    }
  });

  let activeReconciliation;
  const timer = setInterval(() => {
    const now = clock();
    for (const [key, entry] of rate) if (now - entry.start > 60_000) rate.delete(key);
    for (const listener of listeners) listener.write(': heartbeat\n\n');
    store.transaction(() => {
      const { world } = store.read();
      const baseline = JSON.stringify(world);
      const previousBattle = world.battles[0]?.id;
      advance(world, now);
      territory.tick(world,now);
      if (JSON.stringify(world) !== baseline) {
        registerNewBattles(store, world, previousBattle, null, null, now);
        store.write(world);
      }
    });
    if (store.read().revision !== currentRevision) notify();
    if (!activeReconciliation) {
      activeReconciliation = ledger.reconcile()
        .then(() => territory.reconcileAssets())
        .catch(error => console.error('Chain reconciliation:', error.message))
        .finally(() => { activeReconciliation = undefined; });
    }
  }, 10_000).unref();

  server.on('close', () => {
    clearInterval(timer);
    wizardPairing?.close();
    const cleanup = () => { store.close(); void territoryAssets?.close(); void politicalAssets?.close(); };
    if (activeReconciliation) void activeReconciliation.then(cleanup);
    else cleanup();
  });
  return { server, store, ledger, territory, politics, close() { for (const listener of listeners) listener.end(); server.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 4173);
  const host = process.env.HOST ?? '127.0.0.1';
  app.server.listen(port, host, () => console.log(`VAULTBORN is listening on http://${host}:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.close());
}
