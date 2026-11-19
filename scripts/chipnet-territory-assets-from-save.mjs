import './support/chipnet-only.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile,writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { relative,resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { fromHex, signSpend } from '../packages/chain-observer/primitives.mjs';
import { createTerritoryAssets } from '../packages/chain-observer/territory-assets.mjs';

const [saveDirectory,issuerDirectory] = process.argv.slice(2);
if (process.env.CHIPNET_TEST_APPROVE !== 'true' || !saveDirectory || !issuerDirectory) {
  throw new Error('Approve Chipnet testing and supply isolated territory-chipnet and territory-issuer fixture directories.');
}
const scratch=resolve(saveDirectory);
const issuer=resolve(issuerDirectory);
for (const [directory,prefix] of [[scratch,'territory-chipnet-'],[issuer,'territory-issuer-']]) {
  const below=relative(resolve('var'),directory);
  if (!below.startsWith(prefix) || /[\\/]/.test(below)) throw new Error('Use isolated fixture directories inside var.');
}
const config=JSON.parse(await readFile(resolve(issuer,'authority.json'),'utf8'));
const operatorPrivateKey=(await readFile(resolve(issuer,'operator.key'),'utf8')).trim();
const assets=createTerritoryAssets({ ...config, operatorPrivateKey,database:resolve(issuer,'integrated-issuer.sqlite') });
const chain=createChain();
const database=resolve(scratch,'world.sqlite');
const sample=new DatabaseSync(database,{readOnly:true});
const {now}=JSON.parse(sample.prepare('SELECT body FROM world WHERE singleton=1').get().body);
sample.close();
const app=createApp({database,chain,territoryAssets:assets,clock:() => now});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const expected=new Set(['deed','conquest','control','lease','lease-expired']);
const started=Date.now();
const transferDeed=process.argv.includes('--transfer-deed');

async function verifyTransfer(deed) {
  const sender=(JSON.parse(await readFile(process.env.CHIPNET_FIXTURE_FILE,'utf8'))).player.priv;
  const recipientKey=(await readFile(resolve(scratch,'secondary.key'),'utf8')).trim();
  const recipient=walletFromPrivateKey(recipientKey);
  const current=deed.proof.current;
  if (current.address === recipient.tokenAddress && current.txid !== deed.txid) return deed;
  assert.equal(current.address,walletFromPrivateKey(sender).tokenAddress,'The isolated fixture must own the issued deed.');
  const token={category:fromHex(deed.category),amount:0n,nft:{capability:'none',commitment:fromHex(deed.commitment)}};
  const spend=signSpend({privateKey:sender,sources:[{...current,token}],outputs:[{script:recipient.script,satoshis:current.satoshis-400,token}]});
  console.log('East Meadow collectible transfer TXID',spend.txid);
  const end=Date.now()+15*60_000;
  while (Date.now()<end) {
    const receipt=await assets.verify(deed.id);
    if (receipt.proof.current?.txid===spend.txid && receipt.proof.current.address===recipient.tokenAddress) {
      assert.deepEqual(receipt.proof.history.map(item=>item.type),['issued','transferred']);
      assert.equal(app.territory.verify('east-meadow').territory.controller,'p2','An NFT transfer must preserve game-controlled territory.');
      return receipt;
    }
    await chain.broadcast(spend.rawHex).catch(() => undefined);
    await delay(7000);
  }
  throw new Error('The territory collectible transfer has not reached finality.');
}
try {
  let previously='';
  while (Date.now()-started<24*60_000) {
    await app.territory.reconcileAssets();
    const seen=assets.list();
    const mark=seen.map(item=>item.id+':'+item.state).join(' | ');
    if (mark!==previously) {
      console.log(mark||'Waiting for verified territory settlements');
      previously=mark;
    }
    await writeFile(resolve(scratch,'assets-reconciled.json'),JSON.stringify({network:'chipnet',authority:assets.authority(),assets:seen},null,2)+'\n');
    if ([...expected].every(kind=>seen.some(item=>item.kind===kind && item.state==='confirmed'))) break;
    await delay(7_000);
  }
  const verified=[];
  for (const asset of assets.list().filter(row=>row.state==='confirmed')) {
    let receipt;
    for (let attempt=0; attempt<4; attempt++) {
      receipt=await assets.verify(asset.id);
      if (receipt.proof.status!=='uncertain') break;
      await delay(2000);
    }
    assert.equal(receipt.proof.status,asset.anchorOnly ? 'anchored' : 'unspent');
    assert.ok(receipt.relatedTxid,'The minted artifact must refer to its verified game settlement.');
    verified.push(receipt);
  }
  await writeFile(resolve(scratch,'assets-reconciled.json'),JSON.stringify({network:'chipnet',authority:assets.authority(),assets:verified},null,2)+'\n');
  for (const kind of expected) assert.ok(verified.some(item=>item.kind===kind),'No confirmed evidence of '+kind);
  if (transferDeed) {
    const index=verified.findIndex(item=>item.kind==='deed');
    verified[index]=await verifyTransfer(verified[index]);
    await writeFile(resolve(scratch,'assets-reconciled.json'),JSON.stringify({network:'chipnet',authority:assets.authority(),assets:verified},null,2)+'\n');
  }
} finally {
  const closed=once(app.server,'close');
  app.close();
  await closed;
  await assets.close();
}
