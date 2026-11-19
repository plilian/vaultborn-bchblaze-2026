import './support/chipnet-only.mjs';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createChain, signWalletChallenge, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';

const [action, first, second, third] = process.argv.slice(2);
const transport = { electrumHost: process.env.CHIPNET_ELECTRUM_HOST };
const chain = createChain(transport);

function newWallet() {
  const priv = randomBytes(32).toString('hex');
  const { publicKey: pub, address } = walletFromPrivateKey(priv);
  return { priv, pub, address };
}

if (action === 'new') {
  if (!first) throw new Error('Select a private, gitignored fixture file, e.g. var/chipnet-keys.json.');
  const file = resolve(first);
  if (!file.startsWith(resolve('var') + sep)) throw new Error('Use a key file within the repository’s gitignored var directory.');
  await mkdir(dirname(file), { recursive: true });
  const keys = { player: newWallet(), treasury: newWallet() };
  await writeFile(file, JSON.stringify(keys, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({
    network: 'chipnet', wallet: keys.player.address, treasuryPublicKey: keys.treasury.pub,
  }, null, 2));
} else if (action === 'inspect') {
  if (!first) throw new Error('Supply the transaction ID to verify.');
  console.log(JSON.stringify(await chain.verifyPublishedTransaction(first), null, 2));
} else if (action === 'balance') {
  console.log(JSON.stringify({ address: first, network: 'chipnet', satoshis: await chain.localWalletBalance(first) }));
} else if (action === 'pay') {
  if (process.env.CHIPNET_TEST_APPROVE !== 'true' || !process.env.CHIPNET_LOCAL_KEY) {
    throw new Error('Set CHIPNET_TEST_APPROVE=true and supply a throwaway CHIPNET_LOCAL_KEY in the local process environment.');
  }
  const { txid, feeSatoshis } = await chain.sendWithLocalKey(process.env.CHIPNET_LOCAL_KEY, first, second);
  console.log(JSON.stringify({ txid, feeSatoshis, network: 'chipnet' }));
} else if (action === 'tokens') {
  console.log(JSON.stringify(await chain.listCashTokens(first), null, 2));
} else if (action === 'mint-badge') {
  if (process.env.CHIPNET_TEST_APPROVE !== 'true' || !process.env.CHIPNET_LOCAL_KEY) {
    throw new Error('Explicit Chipnet-only approval and a throwaway fixture signer are required.');
  }
  const { txid, category, address, commitment, feeSatoshis } = await chain.mintBadgeWithLocalKey(
    process.env.CHIPNET_LOCAL_KEY, first, second, third,
  );
  console.log(JSON.stringify({ txid, category, address, commitment, feeSatoshis, network: 'chipnet' }));
} else if (action === 'prove') {
  if (!process.env.CHIPNET_LOCAL_KEY || !first) throw new Error('Supply CHIPNET_LOCAL_KEY and the game wallet authorization challenge.');
  console.log(JSON.stringify(signWalletChallenge(process.env.CHIPNET_LOCAL_KEY, first), null, 2));
} else {
  throw new Error('Use new <keyfile>, inspect <txid>, balance <CashAddr>, pay <CashAddr> <satoshis>, tokens <CashAddr>, mint-badge <category> <token-aware CashAddr> <commitment-hex>, or prove <challenge>.');
}
