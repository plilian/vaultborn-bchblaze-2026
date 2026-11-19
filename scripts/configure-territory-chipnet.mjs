import './support/chipnet-only.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { buildTerritoryGenesis } from '../packages/chain-observer/territory-token.mjs';

const fixture = process.env.CHIPNET_FIXTURE_FILE;
const politics = process.argv.includes('--install-politics');
const install = politics || process.argv.includes('--install-local');
const prefix = politics ? 'CHIPNET_POLITICS_' : 'CHIPNET_TERRITORY_';
const configured = new RegExp('^'+prefix+'CATEGORY=','m');
const resume = process.argv.indexOf('--resume');
const resumePath = resume === -1 ? null : process.argv[resume+1];
const knownFunding = resume === -1 ? null : process.argv[resume+2];
if ((!fixture && !resumePath) || process.env.CHIPNET_TEST_APPROVE !== 'true') throw new Error('Supply a disposable funded Chipnet fixture and explicit test approval.');
const envPath = resolve('.env');
if (install && configured.test(await readFile(envPath,'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
}))) throw new Error('This save already has a territory category. Keep its existing operator.');

const chain = createChain({electrumHost:process.env.CHIPNET_ELECTRUM_HOST});
assert.equal((await chain.blockAt()).network,'chipnet');
await mkdir('var',{recursive:true});
const dir = resumePath ? resolve(resumePath) : await mkdtemp(resolve('var','territory-issuer-'));
const below = relative(resolve('var'),dir);
if (!/^territory-issuer-[a-z0-9]+$/i.test(below)) throw new Error('The issuer directory must be an isolated directory inside var.');
const keyPath = resolve(dir,'operator.key');
const privateKey = resumePath ? (await readFile(keyPath,'utf8')).trim() : randomBytes(32).toString('hex');
const operator = walletFromPrivateKey(privateKey);
let fundingTxid = knownFunding;
if (!resumePath) {
  const {player} = JSON.parse(await readFile(fixture,'utf8'));
  if (!player?.priv) throw new Error('The disposable Chipnet fixture is missing its player key.');
  await writeFile(keyPath,privateKey,{mode:0o600});
  fundingTxid = (await chain.sendWithLocalKey(player.priv,operator.address,20_000)).txid;
}
assert.match(fundingTxid ?? '',/^[0-9a-f]{64}$/);
console.log('Chipnet issuer funding TXID',fundingTxid,'in',dir);
async function confirmed(txid) {
  const deadline = Date.now()+15*60_000;
  while (Date.now()<deadline) {
    const receipt = await chain.verifyPublishedTransaction(txid).catch(() => null);
    if (receipt?.confirmations >= 2) return receipt;
    await delay(7_000);
  }
  throw new Error('Chipnet confirmation timeout for ' + txid);
}
const input = await confirmed(fundingTxid);
assert.equal(input.outputs[0].script,operator.script);
assert.equal(input.outputs[0].asset,'BCH');
const genesis=buildTerritoryGenesis({txid:fundingTxid,vout:0,satoshis:input.outputs[0].satoshis,script:operator.script},privateKey);
console.log('Chipnet territory category genesis TXID',genesis.txid);
for (let attempt=0; attempt<4; attempt++) {
  try { await chain.broadcast(genesis.rawHex); break; }
  catch (error) {
    if (await chain.verifyPublishedTransaction(genesis.txid).catch(() => null)) break;
    if (attempt === 3) throw error;
    await delay(2500);
  }
}
const receipt=await confirmed(genesis.txid);
assert.equal(receipt.outputs[0].token.category,genesis.category);
assert.equal(receipt.outputs[0].token.nft.capability,'minting');
const config = { category:genesis.category, genesisTxid:genesis.txid, operatorPublicKey:operator.publicKey,
  genesisBlockHash:receipt.blockHash, genesisHeight:receipt.height, minConfirmations:2 };
await writeFile(resolve(dir,'authority.json'),JSON.stringify(config,null,2)+'\n');
if (install) {
  const existing = await readFile(envPath,'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (configured.test(existing)) throw new Error('A category was installed concurrently. The new issuer remains in var.');
  const vars = [`${prefix}CATEGORY=${config.category}`,`${prefix}GENESIS=${config.genesisTxid}`,
    `${prefix}ISSUER_PUBLIC_KEY=${operator.publicKey}`,`${prefix}ISSUER_KEY=${privateKey}`];
  await writeFile(envPath,existing.trimEnd()+'\n\n'+vars.join('\n')+'\n',{mode:0o600});
}
console.log('Confirmed Chipnet authority configuration in',dir);
