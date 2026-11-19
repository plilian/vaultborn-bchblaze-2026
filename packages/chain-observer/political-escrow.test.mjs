import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVirtualMachineBCH } from '@bitauth/libauth';
import { eventOutput, gameEvent } from './vaultborn.mjs';
import { fromHex, readTransaction, walletFromPrivateKey } from './primitives.mjs';
import { POLITICAL_ESCROW_FEE, politicalEscrow, signPoliticalEscrow } from './political-escrow.mjs';

const privateKeys=[23,33,43].map(value=>value.toString(16).padStart(64,'0'));
const [operator,payer,payee]=privateKeys.map(walletFromPrivateKey);
const plan=politicalEscrow({id:'12'.repeat(16),operatorKey:operator.publicKey,payerKey:payer.publicKey,payeeKey:payee.publicKey,
  principal:8300,refundAt:1800000000});
const source={txid:'ac'.repeat(32),vout:0,script:plan.script,satoshis:plan.satoshis};
const eventScript=eventOutput(gameEvent('political-refund','pact-2',{principal:plan.principal})).script;
const sources=[{lockingBytecode:fromHex(plan.script),valueSatoshis:BigInt(plan.satoshis)}];
const vm=(transaction)=>createVirtualMachineBCH().verify({transaction,sourceOutputs:sources});

test('political principal can only reach the ratified recipient or return to the linked payer',()=>{
  const {rawHex,feeSatoshis}=signPoliticalEscrow({contract:plan,source,privateKey:privateKeys[0],lane:'release',eventScript});
  const {transaction}=readTransaction(rawHex);
  assert.equal(feeSatoshis,POLITICAL_ESCROW_FEE);
  assert.equal(vm(transaction),true);
  assert.deepEqual(transaction.outputs[0].lockingBytecode,fromHex(payee.script));
  assert.equal(transaction.outputs[0].valueSatoshis,8300n);
  const diverted=structuredClone(transaction);
  diverted.outputs[0].lockingBytecode=fromHex(operator.script);
  assert.notEqual(vm(diverted),true);
  diverted.outputs[0].lockingBytecode=fromHex(payee.script);
  diverted.outputs[0].valueSatoshis=7000n;
  assert.notEqual(vm(diverted),true);
  assert.throws(()=>signPoliticalEscrow({contract:plan,source,privateKey:privateKeys[2],lane:'release',eventScript}),/key cannot sign/i);
});

test('payer refund has a non-final input and prescribed locktime with independent signing',()=>{
  const {rawHex}=signPoliticalEscrow({contract:plan,source,privateKey:privateKeys[1],lane:'payer-refund',eventScript});
  const {transaction}=readTransaction(rawHex);
  assert.deepEqual(transaction.outputs[0].lockingBytecode,fromHex(payer.script));
  assert.equal(transaction.locktime,plan.refundAt);
  assert.equal(transaction.inputs[0].sequenceNumber,0xfffffffe);
  const tooEarly=structuredClone(transaction);
  tooEarly.locktime--;
  assert.notEqual(vm(tooEarly),true);
  assert.throws(()=>signPoliticalEscrow({contract:plan,source:{...source,satoshis:source.satoshis+1},privateKey:privateKeys[1],
    lane:'payer-refund',eventScript}),/funding output/i);
});

// Version 2: exact release, and a refund for every amount that can actually be paid to the address.
const next=politicalEscrow({id:'34'.repeat(16),operatorKey:operator.publicKey,payerKey:payer.publicKey,payeeKey:payee.publicKey,
  principal:8300,refundAt:1800000000,version:2});
const sponsorKey=(53).toString(16).padStart(64,'0');
const sponsorWallet=walletFromPrivateKey(sponsorKey);
const funded=satoshis=>({txid:'bd'.repeat(32),vout:0,script:next.script,satoshis});
const run=(rawHex,values)=>createVirtualMachineBCH().verify({transaction:readTransaction(rawHex).transaction,
  sourceOutputs:values.map(([script,satoshis])=>({lockingBytecode:fromHex(script),valueSatoshis:BigInt(satoshis)}))});

test('version 2 escrow uses a 32-byte script hash and releases only an exactly funded principal',()=>{
  assert.match(next.script,/^aa20[0-9a-f]{64}87$/);
  assert.notEqual(next.script,plan.script);
  const release=signPoliticalEscrow({contract:next,source:funded(next.satoshis),privateKey:privateKeys[0],lane:'release',eventScript});
  assert.equal(run(release.rawHex,[[next.script,next.satoshis]]),true);
  assert.equal(readTransaction(release.rawHex).transaction.outputs[0].valueSatoshis,8300n);
  for (const wrong of [next.satoshis-1,next.satoshis+1,next.satoshis+5000]) {
    assert.throws(()=>signPoliticalEscrow({contract:next,source:funded(wrong),privateKey:privateKeys[0],lane:'release',eventScript}),/exactly funded/);
    // The covenant itself, not only the signer, refuses to release a wrongly funded output.
    assert.notEqual(run(release.rawHex,[[next.script,wrong]]),true);
  }
  const stolen=readTransaction(release.rawHex).transaction;
  stolen.outputs[0].lockingBytecode=fromHex(operator.script);
  assert.notEqual(createVirtualMachineBCH().verify({transaction:stolen,sourceOutputs:[{lockingBytecode:fromHex(next.script),valueSatoshis:BigInt(next.satoshis)}]}),true);
});

test('version 2 returns under- and overpayments to the payer, by operator at once or by the payer after the timeout',()=>{
  for (const paid of [next.satoshis-1,next.satoshis+1,next.satoshis+120,1196,250_000]) {
    for (const [lane,signer] of [['operator-refund',privateKeys[0]],['payer-refund',privateKeys[1]]]) {
      const refund=signPoliticalEscrow({contract:next,source:funded(paid),privateKey:signer,lane,eventScript});
      const {transaction}=readTransaction(refund.rawHex);
      assert.equal(run(refund.rawHex,[[next.script,paid]]),true);
      assert.deepEqual(transaction.outputs[0].lockingBytecode,fromHex(payer.script));
      assert.equal(transaction.outputs[0].valueSatoshis,BigInt(paid-POLITICAL_ESCROW_FEE));
      assert.equal(refund.feeSatoshis,POLITICAL_ESCROW_FEE);
      const skimmed=structuredClone(transaction);
      skimmed.outputs[0].valueSatoshis-=1n;
      assert.notEqual(createVirtualMachineBCH().verify({transaction:skimmed,sourceOutputs:[{lockingBytecode:fromHex(next.script),valueSatoshis:BigInt(paid)}]}),true);
      const diverted=structuredClone(transaction);
      diverted.outputs[0].lockingBytecode=fromHex(payee.script);
      assert.notEqual(createVirtualMachineBCH().verify({transaction:diverted,sourceOutputs:[{lockingBytecode:fromHex(next.script),valueSatoshis:BigInt(paid)}]}),true);
      if (lane==='payer-refund') {
        const early=structuredClone(transaction);
        early.locktime--;
        assert.notEqual(createVirtualMachineBCH().verify({transaction:early,sourceOutputs:[{lockingBytecode:fromHex(next.script),valueSatoshis:BigInt(paid)}]}),true);
      }
    }
  }
  assert.throws(()=>signPoliticalEscrow({contract:next,source:funded(9000),privateKey:privateKeys[2],lane:'payer-refund',eventScript}),/key cannot sign/i);
});

test('a version 2 payment too small to carry its fee is returned in full with a fee sponsor',()=>{
  for (const paid of [546,576,1000,1195]) {
    assert.throws(()=>signPoliticalEscrow({contract:next,source:funded(paid),privateKey:privateKeys[1],lane:'payer-refund',eventScript}),/fee sponsor/);
    const sponsor={privateKey:sponsorKey,source:{txid:'ce'.repeat(32),vout:1,script:sponsorWallet.script,satoshis:4000}};
    const refund=signPoliticalEscrow({contract:next,source:funded(paid),privateKey:privateKeys[1],lane:'payer-refund',eventScript,sponsor});
    const {transaction}=readTransaction(refund.rawHex);
    assert.equal(run(refund.rawHex,[[next.script,paid],[sponsorWallet.script,4000]]),true);
    assert.deepEqual(transaction.outputs[0].lockingBytecode,fromHex(payer.script));
    assert.ok(transaction.outputs[0].valueSatoshis>=BigInt(paid));
    assert.deepEqual(transaction.outputs[2].lockingBytecode,fromHex(sponsorWallet.script));
    // The sponsor cannot take the escrowed value: paying the payer less than was funded fails.
    const short=structuredClone(transaction);
    short.outputs[0].valueSatoshis=BigInt(paid-1);
    short.outputs[2].valueSatoshis+=1n;
    assert.notEqual(createVirtualMachineBCH().verify({transaction:short,sourceOutputs:[[next.script,paid],[sponsorWallet.script,4000]]
      .map(([script,satoshis])=>({lockingBytecode:fromHex(script),valueSatoshis:BigInt(satoshis)}))}),true);
  }
});

// The mutation checks above also break the signature. These spends are validly signed and still violate a covenant rule.
import { encodeDataPush, encodeTransaction, generateSigningSerializationBCH, secp256k1 } from '@bitauth/libauth';
import { hash256 } from './primitives.mjs';
function signedEscrowSpend({ paid, outputs, lane, key, locktime=0 }) {
  const transaction={version:2,locktime,inputs:[{outpointTransactionHash:fromHex('bd'.repeat(32)),outpointIndex:0,
    sequenceNumber:locktime ? 0xfffffffe : 0xffffffff,unlockingBytecode:new Uint8Array()}],
    outputs:outputs.map(([script,satoshis])=>({lockingBytecode:fromHex(script),valueSatoshis:BigInt(satoshis)}))};
  const sourceOutputs=[{lockingBytecode:fromHex(next.script),valueSatoshis:BigInt(paid)}];
  const type=Uint8Array.of(0x61);
  const digest=hash256(generateSigningSerializationBCH({inputIndex:0,sourceOutputs,transaction},
    {coveredBytecode:fromHex(next.redeemScript),signingSerializationType:type}));
  const selector={release:[0x51],'operator-refund':[0x51,0x00],'payer-refund':[0x00,0x00]}[lane];
  transaction.inputs[0].unlockingBytecode=Buffer.concat([encodeDataPush(Buffer.concat([secp256k1.signMessageHashSchnorr(fromHex(key),digest),type])),
    Buffer.from(selector),encodeDataPush(fromHex(next.redeemScript))]);
  return createVirtualMachineBCH().verify({transaction:readTransaction(Buffer.from(encodeTransaction(transaction)).toString('hex')).transaction,sourceOutputs});
}

test('validly signed version 2 spends that break a covenant rule are rejected by the BCH VM',()=>{
  const exact=next.satoshis;
  // Controls: the same builder produces accepted spends.
  assert.equal(signedEscrowSpend({paid:exact,lane:'release',key:privateKeys[0],outputs:[[payee.script,8300],[eventScript,0]]}),true);
  assert.equal(signedEscrowSpend({paid:9000,lane:'operator-refund',key:privateKeys[0],outputs:[[payer.script,9000-POLITICAL_ESCROW_FEE],[eventScript,0]]}),true);
  assert.equal(signedEscrowSpend({paid:9000,lane:'payer-refund',key:privateKeys[1],locktime:next.refundAt,outputs:[[payer.script,9000-POLITICAL_ESCROW_FEE],[eventScript,0]]}),true);
  // The operator cannot pay itself, underpay the payee, release a wrongly funded output, or skim a refund.
  assert.notEqual(signedEscrowSpend({paid:exact,lane:'release',key:privateKeys[0],outputs:[[operator.script,8300],[eventScript,0]]}),true);
  assert.notEqual(signedEscrowSpend({paid:exact,lane:'release',key:privateKeys[0],outputs:[[payee.script,8299],[eventScript,0]]}),true);
  assert.notEqual(signedEscrowSpend({paid:exact+500,lane:'release',key:privateKeys[0],outputs:[[payee.script,8300],[eventScript,0]]}),true);
  assert.notEqual(signedEscrowSpend({paid:9000,lane:'operator-refund',key:privateKeys[0],outputs:[[payer.script,9000-POLITICAL_ESCROW_FEE-1],[eventScript,0]]}),true);
  assert.notEqual(signedEscrowSpend({paid:9000,lane:'operator-refund',key:privateKeys[0],outputs:[[operator.script,9000-POLITICAL_ESCROW_FEE],[eventScript,0]]}),true);
  assert.notEqual(signedEscrowSpend({paid:1000,lane:'operator-refund',key:privateKeys[0],outputs:[[payer.script,999],[eventScript,0]]}),true);
  // The payee and a stranger cannot use any lane. The payer cannot refund early or to another script.
  assert.notEqual(signedEscrowSpend({paid:exact,lane:'release',key:privateKeys[2],outputs:[[payee.script,8300],[eventScript,0]]}),true);
  assert.notEqual(signedEscrowSpend({paid:exact,lane:'payer-refund',key:privateKeys[2],locktime:next.refundAt,outputs:[[payer.script,8300],[eventScript,0]]}),true);
  assert.notEqual(signedEscrowSpend({paid:exact,lane:'payer-refund',key:privateKeys[1],locktime:next.refundAt-1,outputs:[[payer.script,8300],[eventScript,0]]}),true);
  assert.notEqual(signedEscrowSpend({paid:exact,lane:'payer-refund',key:privateKeys[1],locktime:next.refundAt,outputs:[[payee.script,8300],[eventScript,0]]}),true);
  // A value-bearing second output is refused, so the commitment slot cannot carry funds away.
  assert.notEqual(signedEscrowSpend({paid:9000,lane:'operator-refund',key:privateKeys[0],outputs:[[payer.script,8350],[operator.script,600]]}),true);
});
