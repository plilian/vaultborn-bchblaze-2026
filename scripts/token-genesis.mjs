// Creates the CashTokens category that issues the game's optional proof collectibles (territory deeds or political
// charters) on the ACTIVE network (VAULTBORN_NETWORK). Without --broadcast it only builds, checks and prints the
// transaction, so it can be reviewed first.
//
//   ISSUER_KEY_FILE=<hex key file> node scripts/token-genesis.mjs territory|politics <funding txid> <funding satoshis> [--broadcast]
//
// The funding transaction must pay the issuer's own address at output 0 (a CashTokens category is named after the
// transaction whose output 0 it spends) with ordinary BCH. Each collectible issued later costs about 2,000 satoshis
// (1,500 travel with the token to its holder, about 500 are the fee), so 50,000 covers the category and about 24 issues.
// On Mainnet, --broadcast also needs VAULTBORN_MAINNET_ACK=real-bch.
import { readFile } from 'node:fs/promises';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { buildTerritoryGenesis } from '../packages/chain-observer/territory-token.mjs';
import { NETWORK_ID, REAL_VALUE, networkEnv, networkEnvName } from '../config/network.mjs';

const args = process.argv.slice(2).filter(item => !item.startsWith('--'));
const broadcast = process.argv.includes('--broadcast');
const [kind, txid, amount] = args;
if (!['territory', 'politics'].includes(kind) || !/^[0-9a-f]{64}$/.test(txid ?? '') || !Number.isSafeInteger(Number(amount)) || !process.env.ISSUER_KEY_FILE) {
  throw new Error('Usage: ISSUER_KEY_FILE=<file> node scripts/token-genesis.mjs territory|politics <funding txid> <funding satoshis> [--broadcast]');
}
const privateKey = (await readFile(process.env.ISSUER_KEY_FILE, 'utf8')).trim();
const issuer = walletFromPrivateKey(privateKey);
const genesis = buildTerritoryGenesis({ txid, vout: 0, satoshis: Number(amount), script: issuer.script }, privateKey);
const prefix = kind === 'politics' ? 'POLITICS_' : 'TERRITORY_';
const settings = [`${networkEnvName(prefix + 'CATEGORY')}=${genesis.category}`, `${networkEnvName(prefix + 'GENESIS')}=${genesis.txid}`,
  `${networkEnvName(prefix + 'ISSUER_PUBLIC_KEY')}=${issuer.publicKey}`, `# ${networkEnvName(prefix + 'ISSUER_KEY')}=<the issuer private key, on the server only>`];
if (broadcast) {
  if (REAL_VALUE && process.env.VAULTBORN_MAINNET_ACK !== 'real-bch') throw new Error('Mainnet broadcast needs the owner\'s VAULTBORN_MAINNET_ACK=real-bch.');
  await createChain({ electrumHost: networkEnv('ELECTRUM_HOST') }).broadcast(genesis.rawHex);
}
console.log(JSON.stringify({ network: NETWORK_ID, kind, issuerAddress: issuer.address, category: genesis.category, genesisTxid: genesis.txid,
  bytes: genesis.rawHex.length / 2, broadcast, rawHex: genesis.rawHex, addToEnvironment: settings }, null, 2));
