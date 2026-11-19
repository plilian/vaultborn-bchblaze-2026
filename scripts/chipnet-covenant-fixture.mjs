// Creates the disposable Chipnet test keys that scripts/chipnet-covenants-e2e.mjs needs and prints the two addresses to fund.
// Test keys only: never fund them with real BCH. The file is refused if it already exists or lies outside var/ (gitignored).
//   node scripts/chipnet-covenant-fixture.mjs var/covenant-keys.json
import './support/chipnet-only.mjs';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { walletFromPrivateKey } from '../packages/chain-observer/index.mjs';

const file = resolve(process.argv[2] ?? 'var/covenant-keys.json');
if (!file.startsWith(resolve('var') + sep)) throw new Error('Keep the key file inside the var directory.');
const wallet = () => { const priv = randomBytes(32).toString('hex'); return { priv, address: walletFromPrivateKey(priv).address }; };
const keys = { treasury: wallet(), attestor: wallet(), developer: wallet(), player: wallet(), rival: wallet() };
await mkdir(dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(keys, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ network: 'chipnet', file, fund: { player: { address: keys.player.address, satoshis: 90_000 }, rival: { address: keys.rival.address, satoshis: 60_000 } } }, null, 2));
