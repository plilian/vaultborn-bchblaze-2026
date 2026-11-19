import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createChain, walletFromPublicKey } from '../packages/chain-observer/index.mjs';
import { BATON_COMMITMENT, normalizeTerritoryEvent, territoryCommitment } from '../packages/chain-observer/territory-token.mjs';

const file=process.argv[2];
if (!file) throw new Error('Supply a public territory CashTokens evidence archive.');
const {network,authority,assets}=JSON.parse(await readFile(file,'utf8'));
assert.equal(network,'chipnet');
const chain=createChain();
const operator=walletFromPublicKey(authority.publicKey);
const fetched=new Map();

async function confirmed(txid) {
  if (fetched.has(txid)) return fetched.get(txid);
  let result;
  for (let attempt=0; attempt<3; attempt++) {
    result=await chain.verifyPublishedTransaction(txid).catch(() => null);
    if (result?.confirmations>=2) break;
  }
  assert.ok(result?.confirmations>=2,'Expected confirmed Chipnet transaction '+txid);
  fetched.set(txid,result);
  return result;
}

const baton={category:authority.category,amount:'0',nft:{capability:'minting',commitment:BATON_COMMITMENT}};
const genesis=await confirmed(authority.genesisTxid);
assert.deepEqual(genesis.inputs[0],{txid:authority.category,vout:0});
assert.deepEqual(genesis.outputs[0].token,baton);
assert.equal(genesis.outputs[0].script,operator.script);
const successors=new Map();
const seen=new Set();
for (const asset of assets) {
  const event=normalizeTerritoryEvent(asset);
  const expected=territoryCommitment(event);
  assert.equal(asset.id,event.id);
  assert.ok(!seen.has(event.id),'Duplicate territory asset '+event.id);
  seen.add(event.id);
  const issue=await confirmed(asset.txid);
  assert.deepEqual(issue.outputs[0].token,baton);
  assert.equal(issue.outputs[0].script,operator.script);
  assert.ok(!successors.has(issue.inputs[0].txid),'A minting baton has two successors.');
  successors.set(issue.inputs[0].txid,issue.txid);
  const previous=await confirmed(issue.inputs[0].txid);
  assert.equal(issue.inputs[0].vout,0);
  assert.deepEqual(previous.outputs[0].token,baton);
  assert.equal(previous.outputs[0].script,operator.script);
  assert.ok(issue.outputs.some(output=>output.script===expected.anchorScript && output.satoshis===0));
  await confirmed(event.relatedTxid);
  if (!event.anchorOnly) {
    const nft={category:authority.category,amount:'0',nft:{capability:'none',commitment:expected.commitment}};
    assert.equal(asset.commitment,expected.commitment);
    assert.equal(issue.outputs[1].script,event.recipientScript);
    assert.deepEqual(issue.outputs[1].token,nft);
    let outpoint={txid:issue.txid,vout:1};
    for (const move of asset.proof.history.slice(1)) {
      const transfer=await confirmed(move.txid);
      assert.ok(transfer.inputs.some(input=>input.txid===outpoint.txid && input.vout===outpoint.vout));
      assert.deepEqual(transfer.outputs[move.vout].token,nft);
      outpoint={txid:move.txid,vout:move.vout};
    }
    assert.equal(asset.proof.current.txid,outpoint.txid);
    assert.equal(asset.proof.current.vout,outpoint.vout);
    const available=await chain.listCashTokens(asset.proof.current.address);
    assert.ok(available.some(output=>output.txid===outpoint.txid && output.vout===outpoint.vout &&
      output.category===nft.category && output.commitment===nft.nft.commitment),'The announced NFT output is no longer unspent.');
  }
  console.log(asset.id+' · '+(event.anchorOnly?'anchored':'unspent')+' · '+issue.txid);
}
let head=genesis.txid;
for (let step=0; step<successors.size; step++) {
  assert.ok(successors.has(head),'The archive does not trace every recorded issue to its genesis.');
  head=successors.get(head);
}
assert.equal(head,authority.headTxid);
