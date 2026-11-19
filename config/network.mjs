// The ONE place that decides which Bitcoin Cash network this process works on.
//
// A process works on exactly one network for its whole life: VAULTBORN_NETWORK=chipnet (default, test coins) or mainnet
// (real BCH). Addresses, the pinned block that identifies the chain, the observer servers, the explorer links and the
// names of the environment variables that hold keys all follow from this one value, so that a test key, a test address
// or a test server cannot be used on Mainnet by accident, and the reverse.
const PROFILES = Object.freeze({
  chipnet: Object.freeze({
    id: 'chipnet', label: 'Chipnet', prefix: 'bchtest', env: 'CHIPNET', realValue: false,
    explorer: 'https://chipnet.imaginary.cash/tx/',
    electrumHosts: Object.freeze(['chipnet.imaginary.cash:50002', 'chipnet.bch.ninja:50002', 'chipnet.c3-soft.com:64002']),
    // The three servers in Electron Cash's Chipnet registry independently returned this hash at 302144.
    // Testnet4 shares test addresses but not this block.
    checkpoint: Object.freeze({ height: 302144, hash: '0000000038161e1d24f9cad45fc46bc4e5512453b8523bb5f393b46ea7f752cd' }),
    minConfirmations: 2, requireWitness: false,
  }),
  mainnet: Object.freeze({
    id: 'mainnet', label: 'Mainnet', prefix: 'bitcoincash', env: 'MAINNET', realValue: true,
    explorer: 'https://blockchair.com/bitcoin-cash/transaction/',
    // The Mainnet servers listed in the @electrum-cash/servers package, ordered so that the first two belong to different
    // operators. On 19 November 2026 each of them answered from the owner's computer (WebSocket port 50004) with the
    // checkpoint hash below at height 661648 and the same tip. The game itself uses their TLS port 50002. Override with
    // MAINNET_ELECTRUM_HOST (comma-separated); an own Bitcoin Cash Node (MAINNET_RPC_URL) is the recommended primary source.
    electrumHosts: Object.freeze(['bch.imaginary.cash:50002', 'cashnode.bch.ninja:50002', 'fulcrum.greyh.at:50002', 'electrum.imaginary.cash:50002']),
    // Block 661648 is the first block of the November 2020 upgrade and exists only on Bitcoin Cash: BTC, BSV and eCash
    // have a different block at this height. The hash is the checkpoint compiled into Bitcoin Cash Node and was returned by
    // seven public Mainnet servers on 19 November 2026.
    checkpoint: Object.freeze({ height: 661648, hash: '0000000000000000029e471c41818d24b8b74c911071c4ef0b4a0509f9b5a8ce' }),
    minConfirmations: 2, requireWitness: true,
  }),
});

const selected = (process.env.VAULTBORN_NETWORK ?? 'chipnet').trim().toLowerCase();
if (!Object.hasOwn(PROFILES, selected)) throw new Error('VAULTBORN_NETWORK must be "chipnet" or "mainnet".');

export const NETWORK_PROFILE = PROFILES[selected];
export const NETWORK_ID = NETWORK_PROFILE.id;
export const NETWORK_LABEL = NETWORK_PROFILE.label;
export const ADDRESS_PREFIX = NETWORK_PROFILE.prefix;
export const REAL_VALUE = NETWORK_PROFILE.realValue;
export const networkProfiles = PROFILES;
// A prefixed CashAddr of the active network, as text. The checksum is verified where the address is decoded.
export const ADDRESS_PATTERN = new RegExp('^' + ADDRESS_PREFIX + ':[a-z0-9]{40,120}$', 'i');
export const explorerUrl = txid => NETWORK_PROFILE.explorer + txid;
// Keys, addresses and servers are read from variables named after the network: CHIPNET_TREASURY_PRIVATE_KEY on Chipnet,
// MAINNET_TREASURY_PRIVATE_KEY on Mainnet. A value configured for the other network is never read.
export const networkEnv = (name, env = process.env) => env[NETWORK_PROFILE.env + '_' + name];
export const networkEnvName = name => NETWORK_PROFILE.env + '_' + name;

// Refuses a mixed configuration. On Mainnet no CHIPNET_ key, address or server may be present at all: test keys have
// been written to fixtures and logs and must never guard real money.
export function assertNetworkEnvironment(env = process.env) {
  if (!REAL_VALUE) return;
  const stray = Object.keys(env).filter(name => name.startsWith('CHIPNET_') && String(env[name] ?? '').trim() !== '');
  if (stray.length) throw new Error('VAULTBORN_NETWORK=mainnet, but Chipnet settings are present: ' + stray.sort().join(', ') + '. Remove them; Mainnet uses its own MAINNET_ variables and new keys.');
}
// Who runs the attestors that sign raid outcomes and prizes. "independent": people other than the game's operator.
// "owner": the operator runs them itself. That is a working configuration, but it is NOT independent: whoever controls
// the operator's machines holds the game key and the attestor keys together, and could sign a false raid outcome or a
// false prize. The game says so wherever it describes the attestors, and never calls owner-operated attestors independent.
const operation = (networkEnv('ATTESTOR_OPERATION') ?? 'independent').trim().toLowerCase();
if (!['independent', 'owner'].includes(operation)) throw new Error(networkEnvName('ATTESTOR_OPERATION') + ' must be "independent" or "owner".');
export const ATTESTOR_OPERATION = operation;
export const ATTESTOR_ADJECTIVE = operation === 'owner' ? 'owner-operated' : 'independent';
export const ATTESTOR_NOTE = operation === 'owner' ?
  'The attestors of this realm are run by the game\'s operator, not by independent parties. They replay every battle before signing, and anyone can replay a battle afterwards, but you are trusting the operator not to sign a false raid outcome or prize.' : '';
// What the browser needs to know about the network. Served as /network.js.
export const browserNetwork = () => ({ id: NETWORK_ID, label: NETWORK_LABEL, prefix: ADDRESS_PREFIX, explorer: NETWORK_PROFILE.explorer, realValue: REAL_VALUE,
  attestorOperation: ATTESTOR_OPERATION, attestorAdjective: ATTESTOR_ADJECTIVE, attestorNote: ATTESTOR_NOTE });
