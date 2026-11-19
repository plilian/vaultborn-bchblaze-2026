// Creates one new private key on THIS machine and prints only its public half. Nothing is sent anywhere.
//
//   node scripts/network-keys.mjs new  <key file>     create a key (refuses to overwrite a file)
//   node scripts/network-keys.mjs show <key file>     print the public key and address of an existing key file
//
// Use it for: the game automation key (on the server), each attestor's key (on that attestor's own machine: the server
// must never see it), and the optional CashTokens issuer key. The address shown belongs to the network of
// VAULTBORN_NETWORK. Keep an offline copy of every key file; whoever holds it can sign with it.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { NETWORK_ID } from '../config/network.mjs';

const [action, target] = process.argv.slice(2);
if (!['new', 'show'].includes(action) || !target) throw new Error('Usage: node scripts/network-keys.mjs new|show <key file>');
const file = resolve(target);
if (action === 'new') {
  await mkdir(dirname(file), { recursive: true });
  // "wx": fails if the file exists, so a key in use can never be replaced by accident.
  await writeFile(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
}
const wallet = walletFromPrivateKey((await readFile(file, 'utf8')).trim());
console.log(JSON.stringify({ network: NETWORK_ID, file, publicKey: wallet.publicKey, address: wallet.address,
  note: 'Share the public key only. Back the key file up offline; it is not stored anywhere else.' }, null, 2));
