import './support/chipnet-only.mjs';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { walletFromPrivateKey } from '../packages/chain-observer/index.mjs';

const key = randomBytes(32).toString('hex');
const { publicKey } = walletFromPrivateKey(key);
const env = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const example = env.replace('# CHIPNET_TREASURY_PUBLIC_KEY=', `CHIPNET_TREASURY_PUBLIC_KEY=${publicKey}`);
const content = example.replace('# CHIPNET_TREASURY_PRIVATE_KEY=', `CHIPNET_TREASURY_PRIVATE_KEY=${key}`);
try {
  await writeFile(new URL('../.env', import.meta.url), content, { flag:'wx', mode:0o600 });
  console.log('Created a local Chipnet-only operator key in .env. Restart the game to enable checkout and payouts.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('The project already has an .env file. Keep the existing operator key and restart the game.');
}
