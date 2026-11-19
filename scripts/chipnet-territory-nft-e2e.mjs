import './support/chipnet-only.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { createTerritoryAssets } from '../packages/chain-observer/territory-assets.mjs';
import { buildTerritoryGenesis } from '../packages/chain-observer/territory-token.mjs';
import { fromHex, hex, sha256, signSpend } from '../packages/chain-observer/primitives.mjs';

const directory = process.env.CHIPNET_TERRITORY_FIXTURE;
if (process.env.CHIPNET_TEST_APPROVE !== 'true' || !directory) {
  throw new Error('Set CHIPNET_TEST_APPROVE=true and CHIPNET_TERRITORY_FIXTURE to a funded disposable fixture directory.');
}
const work = resolve(directory);
const load = name => readFile(resolve(work,name),'utf8').then(JSON.parse);
const operatorKey = (await load('test-wallet.json')).treasury.priv;
const holderKey = (await load('test-wallet.json')).player.priv;
const successorKey = (await load('game-wallet.json')).treasury.priv;
const operator = walletFromPrivateKey(operatorKey);
const holder = walletFromPrivateKey(holderKey);
const successor = walletFromPrivateKey(successorKey);
assert.equal(new Set([operator.address,holder.address,successor.address]).size,3);
const setup = await load('setup.json');
const chain = createChain({ electrumHost:process.env.CHIPNET_ELECTRUM_HOST });
const evidenceFile = resolve(work,'evidence.json');
const evidence = existsSync(evidenceFile) ? await load('evidence.json') : {
  network:'chipnet', start:new Date().toISOString(), setup, operator:operator.address, publicKey:operator.publicKey,
  holder:holder.tokenAddress, successor:successor.tokenAddress,
};
const save = () => writeFile(evidenceFile,JSON.stringify(evidence,null,2)+'\n');

async function eventual(label, check) {
  const expires = Date.now()+600_000;
  while (Date.now()<expires) {
    const value = await check();
    if (value) return value;
    await delay(5000);
  }
  throw new Error('Timed out while waiting for ' + label);
}
const published = txid => chain.verifyPublishedTransaction(txid).catch(() => null);
async function confirmed(label, txid) {
  return eventual(label, async () => {
    const record = await published(txid);
    return record?.confirmations >= 2 ? record : null;
  });
}

const funding = await confirmed('plain category input', setup.txid);
assert.equal(funding.outputs[0].script,operator.script);
assert.equal(funding.outputs[0].asset,'BCH');
const planned = buildTerritoryGenesis({ txid:setup.txid, vout:0, satoshis:funding.outputs[0].satoshis, script:operator.script },operatorKey);
evidence.genesis = {txid:planned.txid,category:planned.category,feeSatoshis:planned.feeSatoshis};
await save();
if (!(await published(planned.txid))) await chain.broadcast(planned.rawHex);
console.log('Territory category genesis',planned.category,planned.txid);
evidence.genesis.receipt = await confirmed('authority genesis',planned.txid);
assert.equal(evidence.genesis.receipt.outputs[0].token.nft.capability,'minting');
await save();

const service = createTerritoryAssets({
  database:resolve(work,'assets.sqlite'), operatorPrivateKey:operatorKey, category:planned.category, genesisTxid:planned.txid,
  electrumHost:process.env.CHIPNET_ELECTRUM_HOST,
});
const sample = [
  { eventId:'native-test-claim', territoryId:'silverpass-test', kind:'deed', version:1, controllerId:'sample-ranger', holderAddress:holder.tokenAddress },
  { eventId:'native-test-conquest', territoryId:'silverpass-test', kind:'conquest', version:2, controllerId:'sample-conqueror', holderAddress:successor.tokenAddress },
  { eventId:'native-test-lease', territoryId:'crystal-dell-test', kind:'lease', version:1, controllerId:'sample-ranger', holderAddress:holder.tokenAddress, expiresAt:Date.parse('2026-11-20T01:02:03Z') },
  { eventId:'native-test-renewal', territoryId:'crystal-dell-test', kind:'lease-renewed', version:2, controllerId:'sample-ranger', holderAddress:holder.tokenAddress, expiresAt:Date.parse('2026-11-23T01:02:03Z') },
  { eventId:'native-test-expired', territoryId:'crystal-dell-test', kind:'lease-expired', version:3, expiresAt:Date.parse('2026-11-23T01:02:03Z') },
].map(event=>({ ...event, controlHash:hex(sha256(Buffer.from(JSON.stringify(event)))) }));
try {
  const queued = sample.map(event => service.enqueue(event));
  assert.equal(service.enqueue(sample[0]).id,queued[0].id);
  evidence.events ??= {};
  for (const item of queued) {
    await eventual(item.kind, async () => {
      await service.reconcile();
      const latest = service.list(item.territoryId).find(record=>record.id===item.id);
      const previous = evidence.events[item.id];
      if (latest?.txid && previous?.state !== latest.state) {
        evidence.events[item.id] = latest;
        await save();
        console.log(item.kind,latest.state,latest.txid,latest.receipt?.confirmations ?? '');
      }
      return latest?.state === 'confirmed';
    });
    const proof = await service.verify(item.id);
    assert.equal(proof.proof.status,item.anchorOnly ? 'anchored' : 'unspent');
    evidence.events[item.id] = proof;
    await save();
    if (item.kind === 'deed' && !evidence.transfer) {
      const { txid,vout,satoshis,script } = proof.proof.current;
      const token = { category:fromHex(proof.category),amount:0n,
        nft:{capability:'none',commitment:fromHex(proof.commitment)} };
      const moved = signSpend({privateKey:holderKey,sources:[{txid,vout,satoshis,script,token}],
        outputs:[{script:successor.script,satoshis:satoshis-400,token}]});
      evidence.transfer = {txid:moved.txid,feeSatoshis:moved.feeSatoshis,address:successor.tokenAddress};
      await save();
      await chain.broadcast(moved.rawHex);
      console.log('Independent holder transferred territory deed',moved.txid);
    }
  }
  await confirmed('holder transfer',evidence.transfer.txid);
  const deed = await service.verify(queued[0].id);
  assert.equal(deed.proof.status,'unspent');
  assert.equal(deed.proof.current.address,successor.tokenAddress);
  assert.deepEqual(deed.proof.history.map(entry=>entry.type), ['issued','transferred']);
  evidence.events[deed.id] = deed;
  evidence.authority = service.authority();
  evidence.finishedAt = new Date().toISOString();
  await save();
  console.log('Confirmed native territory authority, deed, conquest, lease, renewal, expiry anchor, and holder transfer.');
} finally {
  await service.close();
}
