import { readFile } from 'node:fs/promises';
import { createChain, decodeAddress } from '../packages/chain-observer/index.mjs';
import { signVaultRecovery } from '../packages/chain-observer/vault-covenant.mjs';

// Owner-only recovery of a personal vault deposit after its recovery date. It needs no game server and no operator key.
//   VAULT_OWNER_KEY_FILE=<hex key file> node scripts/vault-recover.mjs <payment.json> <funding txid> <destination bchtest: address> [--broadcast]
// <payment.json> is the saved deposit checkout (GET /api/payments). It holds the public vault terms.
const [file, txid, destination, flag] = process.argv.slice(2);
if (!file || !/^[0-9a-f]{64}$/.test(txid ?? '') || !destination || !process.env.VAULT_OWNER_KEY_FILE) {
  throw new Error('Supply the saved deposit JSON, its funding TXID, a destination address, and VAULT_OWNER_KEY_FILE.');
}
const saved = JSON.parse(await readFile(file, 'utf8'));
const vault = (saved.result ?? saved).vault;
if (!vault?.script) throw new Error('This file has no vault terms.');
const chain = createChain();
const observed = await chain.verifyPublishedTransaction(txid);
const source = observed?.outputs.find(output => output.script === vault.script && output.asset === 'BCH');
if (!source || !observed.confirmations) throw new Error('The confirmed vault output was not found on Chipnet.');
const target = decodeAddress(destination);
const fee = 500;
const privateKey = (await readFile(process.env.VAULT_OWNER_KEY_FILE, 'utf8')).trim();
const result = signVaultRecovery(vault, { txid, vout: source.vout, script: source.script, satoshis: source.satoshis }, privateKey,
  [{ script: target.script, satoshis: source.satoshis - fee }]);
if (flag === '--broadcast') await chain.broadcast(result.rawHex);
console.log(JSON.stringify({ ...result, network: 'chipnet', recoverAt: vault.recoverAt, destination: target.address,
  satoshis: source.satoshis - fee, broadcast: flag === '--broadcast' }, null, 2));
