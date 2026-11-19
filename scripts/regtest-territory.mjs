import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { fromHex, hex, readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';
import { eventOutput, gameEvent, protocolHash } from '../packages/chain-observer/vaultborn.mjs';
import { kingdom } from '../packages/game-engine/treasury.mjs';
import { signPoliticalEscrow } from '../packages/chain-observer/political-escrow.mjs';
import { buildTerritoryGenesis, buildTerritoryIssue, knownTerritoryBaton, normalizeTerritoryEvent } from '../packages/chain-observer/territory-token.mjs';

const executable = process.env.REGTEST_BCHN;
if (!executable) throw new Error('Set REGTEST_BCHN to the local BCHN bitcoind executable.');
await mkdir('var',{recursive:true});
const dataDir = await mkdtemp(resolve('var','regtest-territory-'));
const portHolder = createServer().listen(0,'127.0.0.1');
await once(portHolder,'listening');
const port = portHolder.address().port;
await new Promise((resolve,reject) => portHolder.close(error => error ? reject(error) : resolve()));
const password = randomBytes(24).toString('hex');
const proc = spawn(executable, ['-regtest', '-server', '-disablewallet', '-listen=0','-connect=0','-dnsseed=0','-discover=0',
  '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1/32', '-rpcport=' + port, '-rpcuser=vaultborn_regtest',
  '-rpcpassword=' + password, '-txindex=1', '-datadir=' + dataDir], {windowsHide:true,stdio:'ignore'});
const stopped = once(proc,'exit');
const url = 'http://127.0.0.1:' + port;
const authorization = 'Basic ' + Buffer.from('vaultborn_regtest:' + password).toString('base64');
let ready = false;
let networkVerified = false;
const evidence = { network:'regtest', transactions:[] };
async function rpc(method, ...params) {
  const response = await fetch(url,{method:'POST',headers:{authorization,'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'1.0',id:'vaultborn',method,params}),signal:AbortSignal.timeout(12000)});
  const reply = await response.json();
  if (reply.error) throw new Error(method + ' · ' + reply.error.message);
  return reply.result;
}
const key = () => randomBytes(32).toString('hex');
const minerKey = key();
const operatorKey = key();
const playerKey = key();
const miner = walletFromPrivateKey(minerKey);
const player = walletFromPrivateKey(playerKey);
const mining = lockingBytecodeToCashAddress({prefix:'bchreg',bytecode:fromHex(miner.script)});
assert.ok(mining.address);
const chain = createChain({treasuryPrivateKey:operatorKey});
const raw = async txid => readTransaction(await rpc('getrawtransaction',txid,false),txid).transaction;
async function submit(transaction,name) {
  assert.ok(networkVerified,'Refusing to broadcast before verifying Regtest.');
  const txid = await rpc('sendrawtransaction',transaction.rawHex);
  assert.equal(txid,transaction.txid);
  await rpc('generatetoaddress',1,mining.address);
  const actual = await rpc('getrawtransaction',txid,true);
  assert.ok(actual.confirmations >= 1);
  evidence.transactions.push({name,txid,blockHash:actual.blockhash,confirmations:actual.confirmations,feeSatoshis:transaction.feeSatoshis});
  return txid;
}
async function coin(block) {
  const {tx} = await rpc('getblock',block,1);
  const output = (await raw(tx[0])).outputs[0];
  return {txid:tx[0],vout:0,satoshis:Number(output.valueSatoshis),script:miner.script};
}

try {
  for (let tries = 0; tries < 40; tries++) {
    try {
      const info = await rpc('getblockchaininfo');
      assert.equal(info.chain,'regtest');
      ready = true;
      networkVerified = true;
      break;
    } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; await delay(250); }
  }
  assert.ok(ready,'BCHN Regtest RPC did not start.');
  evidence.node = (await rpc('getnetworkinfo')).subversion;
  evidence.genesis = await rpc('getblockhash',0);
  const blocks = await rpc('generatetoaddress',103,mining.address);
  const source = await coin(blocks[0]);
  const allocation = kingdom.split(4000,'territory-claim');
  const intent = chain.createIntent({playerId:'p1',action:'territory-claim',payload:{type:'territory-claim',territory:'copper-ridge'},
    satoshis:4000,allocation,event:{territory:'copper-ridge',test:'regtest'}});
  const entryFee = 500;
  const entry = signSpend({sources:[source],outputs:[...intent.outputs,{script:miner.script,satoshis:source.satoshis-4000-entryFee}],privateKey:minerKey});
  const entryId = await submit(entry,'Territory split, stake and spendable outputs');
  const confirmed = await raw(entryId);
  assert.deepEqual(confirmed.outputs.slice(0,4).map(output => Number(output.valueSatoshis)),[2000,800,600,600]);
  assert.equal(hex(confirmed.outputs[3].lockingBytecode),eventOutput(intent.event,600).script);
  const record = {territory:'copper-ridge',entryId,winner:'p1'};
  const result = gameEvent('territory-settlement','regtest-claim',{recordHash:protocolHash(record),entryTxids:[entryId]});
  const escrow = chain.preparePayout({playerId:'council',action:'territory-settlement',payload:{},satoshis:2000,retain:true,event:result,
    sources:intent.outputs.slice(0,2).map((output,vout) => ({...output,txid:entryId,vout}))});
  const settlement = await submit(chain.signPayout(escrow),'Territory escrow settlement commitment');
  assert.equal(Number((await raw(settlement)).outputs[0].valueSatoshis),2000);
  assert.equal(hex((await raw(settlement)).outputs.at(-1).lockingBytecode),eventOutput(result).script);
  assert.equal(await rpc('gettxout',entryId,0),null);
  assert.equal(await rpc('gettxout',entryId,3),null);

  const tokenSource = await coin(blocks[1]);
  const category = tokenSource.txid;
  const commitment = protocolHash({territory:'copper-ridge',version:1,recordHash:result.data.recordHash});
  const token = {category:fromHex(category),amount:0n,nft:{capability:'none',commitment:fromHex(commitment)}};
  const genesis = signSpend({sources:[tokenSource],outputs:[
    {script:miner.script,satoshis:3000,token},{script:miner.script,satoshis:tokenSource.satoshis-3500},
  ],privateKey:minerKey});
  const tokenTxid = await submit(genesis,'Territory CashTokens genesis');
  const transfer = signSpend({sources:[{txid:tokenTxid,vout:0,satoshis:3000,script:miner.script,token}],
    outputs:[{script:player.script,satoshis:2450,token}],privateKey:minerKey});
  const transferId = await submit(transfer,'Immutable territory NFT transfer to player');
  const live = await rpc('gettxout',transferId,0,true);
  const actualToken = (await raw(transferId)).outputs[0].token;
  assert.ok(live);
  assert.equal(hex(actualToken.category),category);
  assert.equal(hex(actualToken.nft.commitment),commitment);
  assert.equal(actualToken.nft.capability,'none');
  evidence.token = {category,commitment,currentTxid:transferId,vout:0,capability:'none'};
  if (process.argv.includes('--political')) {
    const payer=walletFromPrivateKey(minerKey);
    const principal=8300;
    const blockInfo=await rpc('getblockchaininfo');
    const refundAt=blockInfo.mediantime+120;
    const funding=[];
    for (const [index,lane] of ['release','payer-refund','operator-refund'].entries()) {
      const payload={type:'political-escrow',treaty:'test-accord-'+index};
      const termsHash=protocolHash({treaty:payload.treaty,principal,payer:payer.address,payee:player.address});
      const row=chain.createPoliticalEscrowIntent({playerId:'p1',payload,payerKey:payer.publicKey,payeeKey:player.publicKey,
        principal,refundAt,event:{treaty:payload.treaty,termsHash}});
      const coinbase=await coin(blocks[index+2]);
      const charge=signSpend({sources:[coinbase],outputs:[...row.outputs,
        {script:miner.script,satoshis:coinbase.satoshis-row.satoshis-500}],privateKey:minerKey});
      const txid=await submit(charge,'Political treaty escrow funding · '+lane);
      assert.equal((await raw(txid)).outputs.length,3);
      const source={txid,vout:0,satoshis:row.satoshis,script:row.script,role:'treaty-escrow'};
      const event=gameEvent(lane==='release'?'political-release':'political-refund',row.id,{treaty:payload.treaty,termsHash,entryTxid:txid});
      funding.push({row:{...row,state:'credited',receipt:{allocations:[source]},txid},event,source,termsHash,lane});
    }
    for (const {row,source,event,lane} of funding) {
      const payout=lane==='payer-refund' ? signPoliticalEscrow({contract:row.contract,source,privateKey:minerKey,lane,eventScript:eventOutput(event).script}) :
        chain.signPoliticalSettlement({row,event,lane});
      if (lane==='payer-refund') {
        await assert.rejects(rpc('sendrawtransaction',payout.rawHex),/non-final|nonfinal/i);
        await rpc('setmocktime',refundAt+300);
        await rpc('generatetoaddress',12,mining.address);
      }
      const txid=await submit(payout,'Political treaty escrow · '+lane);
      const paid=await raw(txid);
      assert.equal(Number(paid.outputs[0].valueSatoshis),principal);
      assert.equal(hex(paid.outputs[0].lockingBytecode),lane==='release'?player.script:payer.script);
      assert.equal(hex(paid.outputs[1].lockingBytecode),eventOutput(event).script);
      assert.equal(await rpc('gettxout',row.txid,0),null);
      Object.assign(evidence.transactions.at(-1),{fundingTxid:row.txid,principal,lane,contract:row.contract,event});
    }
    const termsHash=funding[0].termsHash;
    const opening={player:'p1',action:{type:'political-operation',operation:'attest',treaty:'regtest-accord',termsHash},nonce:'af'.repeat(24)};
    const feeAllocation=kingdom.split(4000,'political-operation');
    const operation=chain.createIntent({playerId:opening.player,action:'political-operation',payload:opening.action,satoshis:4000,
      allocation:feeAllocation,event:{actionHash:protocolHash(opening),allocation:feeAllocation}});
    const politicalCoin=await coin(blocks[6]);
    const charged=signSpend({sources:[politicalCoin],outputs:[...operation.outputs,{script:miner.script,satoshis:politicalCoin.satoshis-4500}],privateKey:minerKey});
    const feeTxid=await submit(charged,'Political charter fee and four exact allocations');
    const confirmation=(await raw(feeTxid)).outputs;
    assert.deepEqual(confirmation.slice(0,4).map(output=>Number(output.valueSatoshis)),[2000,800,600,600]);
    assert.equal(hex(confirmation[3].lockingBytecode),eventOutput(operation.event,600).script);
    const record={id:'regtest-treaty',kind:'treaty-charter',treaty:'regtest-accord',termsHash};
    const resultEvent=gameEvent('political-outcome',record.id,{recordHash:protocolHash(record),entryTxid:feeTxid});
    const allocationOutpoint=operation.outputs.findIndex(output=>output.role==='development');
    const plan=chain.preparePayout({playerId:'council',action:'political-outcome',payload:{record:record.id},retain:true,event:resultEvent,
      sources:[{...operation.outputs[allocationOutpoint],txid:feeTxid,vout:allocationOutpoint}]});
    const outcomeTxid=await submit(chain.signPayout(plan),'Political outcome commitment from the development allocation');
    const outcome=await raw(outcomeTxid);
    assert.equal(Number(outcome.outputs[0].valueSatoshis),546);
    assert.equal(hex(outcome.outputs[1].lockingBytecode),eventOutput(resultEvent).script);
    assert.equal(Number(outcome.outputs[1].valueSatoshis),0);
    assert.equal(await rpc('gettxout',feeTxid,allocationOutpoint),null);
    Object.assign(evidence.transactions.at(-1),{record,opening,allocation:feeAllocation,feeTxid,event:resultEvent});
    const authoritySetup=await coin(blocks[5]);
    const operator=walletFromPrivateKey(operatorKey);
    const authorityFunding=signSpend({sources:[authoritySetup],outputs:[{script:operator.script,satoshis:15000},
      {script:miner.script,satoshis:authoritySetup.satoshis-15500}],privateKey:minerKey});
    const authorityInput=await submit(authorityFunding,'Political CashTokens authority input');
    const authority=buildTerritoryGenesis({txid:authorityInput,vout:0,satoshis:15000,script:operator.script},operatorKey);
    const authorityTxid=await submit(authority,'Political CashTokens minting authority');
    const baton=knownTerritoryBaton({transaction:await raw(authorityTxid),txid:authorityTxid,confirmations:1},authority.category,operator.script,true);
    const treaty=normalizeTerritoryEvent({eventId:'regtest-treaty',territoryId:'regtest-accord',kind:'political-treaty',version:1,
      holderAddress:player.address,controlHash:termsHash,relatedTxid:outcomeTxid});
    const charter=buildTerritoryIssue({baton,event:treaty,category:authority.category,operatorPrivateKey:operatorKey});
    const charterTxid=await submit(charter,'Immutable political treaty charter');
    const issue=(await raw(charterTxid)).outputs[1].token;
    assert.equal(issue.nft.capability,'none');
    assert.equal(hex(issue.category),authority.category);
    assert.equal(hex(issue.nft.commitment),charter.commitment);
    evidence.politics={refundBeforeDeadlineRejected:true,category:authority.category,genesis:authorityTxid,
      charter:{txid:charterTxid,vout:1,commitment:charter.commitment,kind:treaty.kind}};
  }
  await writeFile(resolve(dataDir,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log('BCHN Regtest validated split and burn, settlement, NFT genesis and NFT transfer.'+
    (evidence.politics?' Political escrow release and both refunds, paid outcome anchor, and immutable charter issuance also confirmed.':''),
    'Evidence:',resolve(dataDir,'evidence.json'));
} finally {
  if (ready) await rpc('stop').catch(() => proc.kill());
  else proc.kill();
  await Promise.race([stopped.catch(() => undefined),delay(3000)]);
}
