// Consensus and relay-policy validation of the remediation contracts on a private Bitcoin Cash Node Regtest chain.
// Regtest is a local chain. Nothing here is Chipnet evidence. The node runs with standard relay policy (-acceptnonstdtxn=0).
//   REGTEST_BCHN=/path/to/bitcoind node scripts/regtest-remediation.mjs [evidence.json]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeDataPush, encodeTransaction, generateSigningSerializationBCH, lockingBytecodeToCashAddress, secp256k1 } from '@bitauth/libauth';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { fromHex, hash256, hex, incomingDestination, readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';
import { politicalEscrow, signPoliticalEscrow } from '../packages/chain-observer/political-escrow.mjs';
import { prizeCarrier } from '../packages/chain-observer/prize-carrier.mjs';
import { buildCarrierRefund, buildFeedSweep, buildPoolSweep, prizeCarrier2, prizeFeeder } from '../packages/chain-observer/prize-carrier.mjs';
import { kingdomVault, planChestCapture, planKingdomWithdrawal, signCaptureDigests, signChestCapture, signChestExit, signKingdomRecovery, signKingdomWithdrawal, vaultTerms as chestTermsOf } from '../packages/chain-observer/kingdom-vault.mjs';
import { buildChestFeed, chestFeeder, feederTerms as chestFeederTerms } from '../packages/chain-observer/chest-feeder.mjs';
import { completeStakeSpend, planStakeSpend, signStakeDigest, signStakeRefund, stakeEscrow, stakeTerms } from '../packages/chain-observer/stake-escrow.mjs';
import { buildPrizeRefund, completePrizeAward, layoutPrizeAward, planPrizeAward, prizeFund, signPrizeAward } from '../packages/chain-observer/prize-fund.mjs';
import { compileTreasuryCovenant, completeTreasurySpend, planTreasurySpend, sponsorSigningHash, treasurySigningHash } from '../packages/chain-observer/treasury-covenants.mjs';
import { planVaultWithdrawal, signVaultRecovery, signVaultWithdrawal, vaultCovenant } from '../packages/chain-observer/vault-covenant.mjs';
import { eventOutput, gameEvent, prizeAggregate } from '../packages/chain-observer/vaultborn.mjs';
import { completeMatchedCapture, completeRaidSpend, planMatchedCapture, planRaidSpend, raidEscrow, raidTermsFor, redigest, signMatchedDigests, signRaidDigest, signRaidRefund } from '../packages/chain-observer/matched-raid.mjs';
import { RECORD_RESERVE_SATOSHIS, recordReserve, signRecord, signRecordRecovery } from '../packages/chain-observer/record-reserve.mjs';
import { rpcChain } from './attestor-payout.mjs';

const binary = process.env.REGTEST_BCHN;
if (!binary) throw new Error('Set REGTEST_BCHN to a Bitcoin Cash Node bitcoind executable.');
const key = n => n.toString(16).padStart(64, '0');
const [minerKey, operatorKey, payerKey, payeeKey, ownerKey, judgeKey, auditorKey, opponentKey] = [11, 12, 13, 14, 15, 16, 17, 18].map(key);
const [miner, operator, payer, payee, owner, judge, auditor, opponent] = [minerKey, operatorKey, payerKey, payeeKey, ownerKey, judgeKey, auditorKey, opponentKey].map(walletFromPrivateKey);
const regtestAddress = script => { const result = lockingBytecodeToCashAddress({ prefix:'bchreg', bytecode:fromHex(script) }); return result.address ?? result; };
const datadir = mkdtempSync(join(tmpdir(), 'vaultborn-regtest-'));
const port = 28443 + Math.floor(Math.random() * 500);
const node = spawn(binary, ['-regtest', '-datadir=' + datadir, '-server', '-rpcuser=audit', '-rpcpassword=audit', '-rpcport=' + port, '-listen=0',
  '-acceptnonstdtxn=0', '-txindex=1', '-disablewallet=1', '-printtoconsole=0'], { stdio:'ignore' });
async function rpc(method, ...params) {
  const response = await fetch('http://127.0.0.1:' + port + '/', { method:'POST', headers:{ Authorization:'Basic ' + Buffer.from('audit:audit').toString('base64') },
    body:JSON.stringify({ jsonrpc:'1.0', id:1, method, params }) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { code:body.error.code });
  return body.result;
}
const results = [];
const failures = [];
let coins = [];
try {
  for (let attempt = 0; ; attempt++) {
    try { await rpc('getblockcount'); break; }
    catch (error) { if (attempt > 80) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  const version = (await rpc('getnetworkinfo')).subversion;
  const mine = async (count = 1) => rpc('generatetoaddress', count, regtestAddress(miner.script));
  const blocks = await mine(130);
  for (const hash of blocks.slice(0, 25)) {
    const block = await rpc('getblock', hash, 2);
    coins.push({ txid:block.tx[0].txid, vout:0, satoshis:Math.round(block.tx[0].vout[0].value * 1e8), script:miner.script });
  }
  const send = async raw => rpc('sendrawtransaction', raw);
  const confirmed = async txid => { const tx = await rpc('getrawtransaction', txid, true); return tx.confirmations ?? 0; };
  const unspent = async (txid, vout) => Boolean(await rpc('gettxout', txid, vout, true));
  // Pays arbitrary scripts from a mature coinbase output and mines the payment.
  async function fund(outputs) {
    const coin = coins.shift();
    const total = outputs.reduce((sum, item) => sum + item.satoshis, 0);
    const signed = signSpend({ privateKey:minerKey, sources:[coin], outputs:[...outputs, { script:miner.script, satoshis:coin.satoshis - total - 2000 }] });
    await send(signed.rawHex);
    await mine();
    return outputs.map((item, vout) => ({ txid:signed.txid, vout, script:item.script, satoshis:item.satoshis }));
  }
  async function expectMined(name, group, signed, detail = {}) {
    try {
      const txid = await send(signed.rawHex);
      await mine();
      const confirmations = await confirmed(txid);
      const outputs = readTransaction(signed.rawHex).transaction.outputs.map(output => ({ script:hex(output.lockingBytecode), satoshis:Number(output.valueSatoshis) }));
      results.push({ group, name, expected:'accepted', result:confirmations > 0 ? 'PASS' : 'FAIL', txid, confirmations, feeSatoshis:signed.feeSatoshis,
        bytes:signed.rawHex.length / 2, outputs, ...detail });
      if (!confirmations) failures.push(name);
    } catch (error) { results.push({ group, name, expected:'accepted', result:'FAIL', error:error.message, ...detail }); failures.push(name); }
  }
  async function expectRejected(name, group, raw, detail = {}) {
    try {
      const txid = await send(raw);
      results.push({ group, name, expected:'rejected', result:'FAIL', txid, ...detail });
      failures.push(name);
    } catch (error) { results.push({ group, name, expected:'rejected', result:'PASS', nodeError:error.message, ...detail }); }
  }
  const tip = await rpc('getblock', await rpc('getbestblockhash'));
  const past = tip.mediantime - 3600;
  const future = tip.time + 30 * 86_400;
  const eventScript = eventOutput(gameEvent('political-refund', 'regtest', { note:'remediation' })).script;
  const chain = createChain({ treasuryPrivateKey:operatorKey, transport:{ withClient:() => { throw new Error('offline'); } } });

  // 1. Prize carrier
  const season = 9;
  const prize = prizeAggregate(season, operator.publicKey);
  const carrier = (label, share = 400) => {
    const id = hex(hash256(Buffer.from('carrier-' + label))).slice(0, 32);
    const kingdom = incomingDestination(id, operator.publicKey);
    return { id, kingdom, contract:prizeCarrier({ id, operatorKey:operator.publicKey, prize:share, kingdom:2600, prizeScript:prize.script, kingdomScript:kingdom.script }) };
  };
  const [ca, cb, cc, cd] = ['a', 'b', 'c', 'd'].map(label => carrier(label));
  const feeIds = ['f1', 'f2'].map(label => hex(hash256(Buffer.from('fee-' + label))).slice(0, 32));
  const feeOutputs = feeIds.map(id => incomingDestination(id, operator.publicKey));
  const funded = await fund([...[ca, cb, cc].map(item => ({ script:item.contract.script, satoshis:item.contract.satoshis })),
    { script:cd.contract.script, satoshis:cd.contract.satoshis + 10 }, ...feeOutputs.map(item => ({ script:item.script, satoshis:5000 })),
    { script:miner.script, satoshis:6000 }, { script:miner.script, satoshis:6000 }]);
  const carrierSource = (item, coin) => ({ ...coin, redeemScript:item.contract.redeemScript, unlocking:'00' });
  const shortSweep = signSpend({ privateKey:minerKey, requireUtxos:true, sources:[carrierSource(ca, funded[0]), carrierSource(cb, funded[1]), funded[6]],
    outputs:[{ script:prize.script, satoshis:799 }, { script:ca.kingdom.script, satoshis:2600 }, { script:cb.kingdom.script, satoshis:2600 }, { script:miner.script, satoshis:5000 }] });
  await expectRejected('sweep that underpays the prize output by 1 satoshi', 'prize-carrier', shortSweep.rawHex);
  const divertedSweep = signSpend({ privateKey:minerKey, requireUtxos:true, sources:[carrierSource(ca, funded[0]), carrierSource(cb, funded[1]), funded[6]],
    outputs:[{ script:prize.script, satoshis:800 }, { script:miner.script, satoshis:2600 }, { script:cb.kingdom.script, satoshis:2600 }, { script:miner.script, satoshis:5000 }] });
  await expectRejected('sweep that redirects a kingdom share', 'prize-carrier', divertedSweep.rawHex);
  const operatorGrab = (() => {
    const source = { ...funded[2], redeemScript:cc.contract.redeemScript };
    const signed = signSpend({ privateKey:operatorKey, requireUtxos:true, sources:[source], outputs:[{ script:operator.script, satoshis:source.satoshis - 500 }] });
    const { transaction } = readTransaction(signed.rawHex);
    const unlocking = transaction.inputs[0].unlockingBytecode;
    transaction.inputs[0].unlockingBytecode = Uint8Array.from([...unlocking.slice(0, unlocking[0] + 1), 0x51, ...unlocking.slice(unlocking[0] + 1)]);
    return hex(encodeTransaction(transaction));
  })();
  await expectRejected('operator key trying to move an exactly funded carrier', 'prize-carrier', operatorGrab);
  const event = gameEvent('allocation-sweep', 'regtest-pair', { seasonId:season });
  const pair = chain.signCarrierSweep({ seasonId:season, event, feeSource:{ ...feeOutputs[0], ...funded[4] },
    carriers:[ca, cb].map((item, index) => ({ id:item.id, prizeSatoshis:400, kingdomSatoshis:2600, script:item.contract.script, ...funded[index] })) });
  await expectMined('two carriers swept by the game signer: prize 800, kingdom 2,600 each', 'prize-carrier', pair, { topUpSatoshis:pair.topUpSatoshis });
  const lone = chain.signCarrierSweep({ seasonId:season, event:gameEvent('allocation-sweep', 'regtest-lone', { seasonId:season }), feeSource:{ ...feeOutputs[1], ...funded[5] },
    carriers:[{ id:cc.id, prizeSatoshis:400, kingdomSatoshis:2600, script:cc.contract.script, ...funded[2] }] });
  await expectMined('lone carrier swept with a 146-satoshi top-up to the dust limit', 'prize-carrier', lone, { topUpSatoshis:lone.topUpSatoshis });
  const recoverCarrier = (() => {
    const source = { ...funded[3], redeemScript:cd.contract.redeemScript };
    const signed = signSpend({ privateKey:operatorKey, requireUtxos:true, sources:[source], outputs:[{ script:payer.script, satoshis:source.satoshis - 500 }] });
    const { transaction } = readTransaction(signed.rawHex);
    const unlocking = transaction.inputs[0].unlockingBytecode;
    transaction.inputs[0].unlockingBytecode = Uint8Array.from([...unlocking.slice(0, unlocking[0] + 1), 0x51, ...unlocking.slice(unlocking[0] + 1)]);
    return { rawHex:hex(encodeTransaction(transaction)), feeSatoshis:500 };
  })();
  await expectMined('wrongly funded carrier returned through the operator recovery lane', 'prize-carrier', recoverCarrier);

  // 2. Political escrow version 2
  const escrow = (label, refundAt) => politicalEscrow({ id:hex(hash256(Buffer.from('escrow-' + label))).slice(0, 32), operatorKey:operator.publicKey,
    payerKey:payer.publicKey, payeeKey:payee.publicKey, principal:8300, refundAt, version:2 });
  const [e1, e2, e3, e4, e5] = ['1', '2', '3', '4', '5'].map((label, index) => escrow(label, index === 4 ? future : past));
  const escrowCoins = await fund([{ script:e1.script, satoshis:e1.satoshis }, { script:e2.script, satoshis:e2.satoshis + 500 },
    { script:e3.script, satoshis:e3.satoshis - 1 }, { script:e4.script, satoshis:600 }, { script:e5.script, satoshis:e5.satoshis }, { script:miner.script, satoshis:5000 }]);
  await expectMined('exactly funded escrow released to the payee', 'political-escrow-v2',
    signPoliticalEscrow({ contract:e1, source:escrowCoins[0], privateKey:operatorKey, lane:'release', eventScript }));
  await expectMined('overfunded escrow (+500) returned to the payer by the operator lane', 'political-escrow-v2',
    signPoliticalEscrow({ contract:e2, source:escrowCoins[1], privateKey:operatorKey, lane:'operator-refund', eventScript }));
  await expectMined('underfunded escrow (-1) recovered by the payer alone after the timeout', 'political-escrow-v2',
    signPoliticalEscrow({ contract:e3, source:escrowCoins[2], privateKey:payerKey, lane:'payer-refund', eventScript }));
  await expectMined('600-satoshi payment recovered in full with a fee sponsor', 'political-escrow-v2',
    signPoliticalEscrow({ contract:e4, source:escrowCoins[3], privateKey:payerKey, lane:'payer-refund', eventScript, sponsor:{ privateKey:minerKey, source:escrowCoins[5] } }));
  await expectRejected('payer refund before the timeout', 'political-escrow-v2',
    signPoliticalEscrow({ contract:e5, source:escrowCoins[4], privateKey:payerKey, lane:'payer-refund', eventScript }).rawHex);

  // 3. Treasury covenants version 2
  const tranche = (kind, label, extra = {}) => ({ id:hex(hash256(Buffer.from('tranche-' + label))).slice(0, 32), kind, version:2, principal:20_000, reserve:800,
    refundAt:past, ownerKey:owner.publicKey, opponent:opponent.address, attestors:[judge.publicKey, auditor.publicKey], ...extra });
  const [t1, t2, t3] = [tranche('battle-escrow', '1'), tranche('battle-escrow', '2'), tranche('battle-escrow', '3')];
  const voucher = { id:hex(hash256(Buffer.from('voucher'))).slice(0, 32), kind:'season-prize', version:2, principal:6000, reserve:800, refundAt:past,
    recipient:owner.address, rollover:opponent.address };
  const contracts = [t1, t2, t3, voucher].map(compileTreasuryCovenant);
  const trancheCoins = await fund([{ script:contracts[0].script, satoshis:576 }, { script:contracts[1].script, satoshis:contracts[1].satoshis + 900 },
    { script:contracts[2].script, satoshis:contracts[2].satoshis }, { script:contracts[3].script, satoshis:600 },
    { script:miner.script, satoshis:5000 }, { script:miner.script, satoshis:5000 }]);
  const schnorr = (secret, digest) => hex(secp256k1.signMessageHashSchnorr(fromHex(secret), digest));
  const sponsored = coin => ({ publicKey:miner.publicKey, source:coin });
  const stranded = planTreasurySpend(t1, trancheCoins[0], { lane:'refund', sponsor:sponsored(trancheCoins[4]) });
  await expectMined('576-satoshi underpayment (stranded under version 1) recovered by the owner with a fee sponsor', 'treasury-covenant-v2',
    completeTreasurySpend(stranded, [schnorr(ownerKey, treasurySigningHash(stranded))], schnorr(minerKey, sponsorSigningHash(stranded))));
  const overfunded = planTreasurySpend(t2, trancheCoins[1], { lane:'refund' });
  await expectMined('overfunded tranche (+900) recovered by the owner', 'treasury-covenant-v2',
    completeTreasurySpend(overfunded, [schnorr(ownerKey, treasurySigningHash(overfunded))]));
  const settled = planTreasurySpend(t3, trancheCoins[2], { lane:'opponent-wins' });
  await expectMined('exact battle tranche settled by two attestor signatures', 'treasury-covenant-v2',
    completeTreasurySpend(settled, [schnorr(judgeKey, treasurySigningHash(settled)), schnorr(auditorKey, treasurySigningHash(settled))]));
  const rolled = planTreasurySpend(voucher, trancheCoins[3], { lane:'refund', sponsor:sponsored(trancheCoins[5]) });
  await expectMined('600-satoshi prize voucher rolled over without any key, fee paid by a sponsor', 'treasury-covenant-v2',
    completeTreasurySpend(rolled, [], schnorr(minerKey, sponsorSigningHash(rolled))));

  // 4. Personal vault covenant
  const vaultTerms = (label, recoverAt) => ({ id:hex(hash256(Buffer.from('vault-' + label))).slice(0, 32), operatorKey:operator.publicKey, ownerKey:owner.publicKey, recoverAt });
  const [v1, v2, v3] = [vaultTerms('1', future), vaultTerms('2', past), vaultTerms('3', future)];
  const vaults = [v1, v2, v3].map(vaultCovenant);
  const vaultCoins = await fund(vaults.map(item => ({ script:item.script, satoshis:20_000 })));
  const steal = (() => {
    const transaction = { version:2, locktime:0, inputs:[{ outpointTransactionHash:fromHex(vaultCoins[0].txid), outpointIndex:vaultCoins[0].vout, sequenceNumber:0xffffffff, unlockingBytecode:new Uint8Array() }],
      outputs:[{ lockingBytecode:fromHex(operator.script), valueSatoshis:19_500n }] };
    const sourceOutputs = [{ lockingBytecode:fromHex(vaults[0].script), valueSatoshis:20_000n }];
    const type = Uint8Array.of(0x61);
    const digest = hash256(generateSigningSerializationBCH({ inputIndex:0, transaction, sourceOutputs }, { coveredBytecode:fromHex(vaults[0].redeemScript), signingSerializationType:type }));
    transaction.inputs[0].unlockingBytecode = Buffer.concat([encodeDataPush(Buffer.concat([secp256k1.signMessageHashSchnorr(fromHex(operatorKey), digest), type])),
      Uint8Array.of(0x51), encodeDataPush(fromHex(vaults[0].redeemScript))]);
    return hex(encodeTransaction(transaction));
  })();
  await expectRejected('operator key trying to pay a vault deposit to itself', 'vault-covenant', steal);
  const partial = planVaultWithdrawal(v1, vaultCoins[0], { satoshis:5000, eventScript });
  const partialSigned = signVaultWithdrawal(partial, operatorKey);
  await expectMined('assisted withdrawal of 5,000 to the owner with change back to the vault', 'vault-covenant', partialSigned);
  const rest = planVaultWithdrawal(v1, { txid:partialSigned.txid, vout:1, script:vaults[0].script, satoshis:partial.change }, {});
  await expectMined('the vault change output withdrawn in full to the owner', 'vault-covenant', signVaultWithdrawal(rest, operatorKey));
  await expectMined('owner-only recovery after the recovery time, to an address of the owner\'s choice', 'vault-covenant',
    signVaultRecovery(v2, vaultCoins[1], ownerKey, [{ script:payee.script, satoshis:19_400 }]));
  await expectRejected('owner-only recovery before the recovery time', 'vault-covenant',
    signVaultRecovery(v3, vaultCoins[2], ownerKey, [{ script:payee.script, satoshis:19_400 }]).rawHex);
  results.push({ group:'vault-covenant', name:'early-recovery vault output is still unspent', expected:'unspent',
    result:await unspent(vaultCoins[2].txid, vaultCoins[2].vout) ? 'PASS' : 'FAIL' });

  // 5. Seasonal Prize Fund (the 70% share of a sponsorship)
  const fundTerms = (label, closesAt, refundAt) => ({ id:hex(hash256(Buffer.from('fund-' + label))).slice(0, 32), operatorKey:operator.publicKey,
    attestors:[judge.publicKey, auditor.publicKey], sponsorKey:owner.publicKey, closesAt, refundAt });
  const [p1, p2, p3, p4] = [fundTerms('1', past - 60, future), fundTerms('2', future, future + 86_400), fundTerms('3', past - 120, past - 60), fundTerms('4', past - 120, past - 60)];
  const funds = [p1, p2, p3, p4].map(prizeFund);
  const fundCoins = (await fund(funds.map(item => ({ script:item.script, satoshis:17_500_000 })))).map((coin, index) => ({ ...coin, fund:[p1, p2, p3, p4][index] }));
  for (let block = 0; block < 6; block += 1) await mine();
  const awardOutputs = [{ script:payee.script, satoshis:5_950_000 }, { script:funds[0].script, satoshis:17_500_000 - 5_950_000 - 700 }, { script:eventScript, satoshis:0 }];
  const collusion = outputs => { const plan = planPrizeAward([fundCoins[0]], outputs);
    return completePrizeAward(plan, signPrizeAward(plan, operatorKey), { [judge.publicKey]:signPrizeAward(plan, judgeKey), [auditor.publicKey]:signPrizeAward(plan, auditorKey) }, { unchecked:true }).rawHex; };
  await expectRejected('all signers together awarding more than 40% of a fund output', 'prize-fund',
    collusion([{ script:payee.script, satoshis:7_000_001 }, { script:funds[0].script, satoshis:17_500_000 - 7_000_001 - 700 }]));
  await expectRejected('all signers together sending the remainder out of the fund', 'prize-fund',
    collusion([{ script:payee.script, satoshis:5_950_000 }, { script:operator.script, satoshis:17_500_000 - 5_950_000 - 700 }]));
  await expectRejected('all signers together skimming into an extra output', 'prize-fund',
    collusion([{ script:payee.script, satoshis:5_950_000 }, { script:funds[0].script, satoshis:17_500_000 - 5_950_000 - 1_900 }, { script:operator.script, satoshis:1_200 }]));
  const award = planPrizeAward([fundCoins[0]], awardOutputs);
  const byOperator = signPrizeAward(award, operatorKey);
  const attested = { [judge.publicKey]:signPrizeAward(award, judgeKey), [auditor.publicKey]:signPrizeAward(award, auditorKey) };
  await expectRejected('automation key signing in every position, without the attestors', 'prize-fund',
    completePrizeAward(award, byOperator, { [judge.publicKey]:byOperator, [auditor.publicKey]:byOperator }, { unchecked:true }).rawHex);
  await expectRejected('automation key plus only one of the two attestors', 'prize-fund',
    completePrizeAward(award, byOperator, { ...attested, [auditor.publicKey]:byOperator }, { unchecked:true }).rawHex);
  await expectRejected('keyless sponsor refund before the refund date', 'prize-fund', buildPrizeRefund([fundCoins[0]]).rawHex);
  await expectMined('attested award to the winner with the remainder back in the same prize fund', 'prize-fund', completePrizeAward(award, byOperator, attested));
  const early = planPrizeAward([fundCoins[1]], [{ script:payee.script, satoshis:5_000_000 }, { script:funds[1].script, satoshis:12_499_000 }]);
  await expectRejected('fully signed award before the season has closed', 'prize-fund', completePrizeAward(early, signPrizeAward(early, operatorKey),
    { [judge.publicKey]:signPrizeAward(early, judgeKey), [auditor.publicKey]:signPrizeAward(early, auditorKey) }).rawHex);
  const diverted = (() => {
    const { transaction } = readTransaction(buildPrizeRefund([fundCoins[2]]).rawHex);
    transaction.outputs[0].lockingBytecode = fromHex(operator.script);
    return hex(encodeTransaction(transaction));
  })();
  await expectRejected('keyless refund redirected away from the sponsor', 'prize-fund', diverted);
  const greedy = (() => {
    const { transaction } = readTransaction(buildPrizeRefund([fundCoins[2]]).rawHex);
    transaction.outputs[0].valueSatoshis = 17_500_000n - 1_001n;
    return hex(encodeTransaction(transaction));
  })();
  await expectRejected('keyless refund that keeps more than the fee cap', 'prize-fund', greedy);
  await expectMined('two unawarded contributions returned to their sponsor in one keyless transaction', 'prize-fund', buildPrizeRefund([fundCoins[2], fundCoins[3]]));
  results.push({ group:'prize-fund', name:'prize fund output of the open season is still unspent', expected:'unspent',
    result:await unspent(fundCoins[1].txid, fundCoins[1].vout) ? 'PASS' : 'FAIL' });

  // 6. Kingdom vault and war chest
  const kvTerms = (label, extra = {}) => ({ id:hex(hash256(Buffer.from('kv-' + label))).slice(0, 32), operatorKey:operator.publicKey, ownerKey:owner.publicKey, recoverAt:future, revision:2, ...extra });
  const [k1, k2, k3, k4] = [kvTerms('1'), kvTerms('2'), kvTerms('3'), kvTerms('4', { recoverAt:past })];
  const [c1, c2] = [kvTerms('c1', { capturePercent:20, captureAge:10, attestors:[judge.publicKey] }), kvTerms('c2', { capturePercent:20, captureAge:10, attestors:[judge.publicKey] })];
  const witnessed = plan => ({ [judge.publicKey]:signCaptureDigests(plan, judgeKey) });
  const kvAll = [k1, k2, k3, k4, c1, c2];
  const kvCoins = (await fund(kvAll.map((terms, index) => ({ script:kingdomVault(terms).script, satoshis:index < 4 ? 2_925 + index * 100 : 50_000 }))))
    .map((coin, index) => ({ ...coin, kv:kvAll[index] }));
  const tamper = (plan, change) => { const copy = structuredClone(plan); change(copy.transaction); return copy; };
  const whole = planKingdomWithdrawal(kvCoins.slice(0, 3), { satoshis:6_000, eventScript });
  await expectRejected('game key sending a kingdom vault output to itself', 'kingdom-vault',
    signKingdomWithdrawal(tamper(whole, tx => { tx.outputs[0].lockingBytecode = fromHex(operator.script); }), operatorKey, { unchecked:true }).rawHex);
  await expectRejected('game key skimming a vault output into an extra output', 'kingdom-vault',
    signKingdomWithdrawal(tamper(whole, tx => { tx.outputs[0].valueSatoshis -= 1_000n; tx.outputs.at(-1).valueSatoshis = 900n; tx.outputs.at(-1).lockingBytecode = fromHex(operator.script); }), operatorKey, { unchecked:true }).rawHex);
  await expectRejected('game key re-issuing a vault output to its own script to burn fees', 'kingdom-vault',
    signKingdomWithdrawal(tamper(whole, tx => { tx.outputs[0].lockingBytecode = fromHex(kingdomVault(k1).script); }), operatorKey, { unchecked:true }).rawHex);
  await expectRejected('war chest release before the output has reached its age', 'war-chest', signKingdomWithdrawal(planKingdomWithdrawal([kvCoins[5]], { satoshis:20_000 }), operatorKey).rawHex);
  await expectRejected('owner recovery before the recovery date', 'kingdom-vault', signKingdomRecovery([kvCoins[0]], ownerKey, [{ script:payee.script, satoshis:2_400 }]).rawHex);
  await expectMined('three whole vault outputs paid to their owner in one transaction', 'kingdom-vault', signKingdomWithdrawal(whole, operatorKey));
  await expectMined('owner-only recovery of a vault output after its date', 'kingdom-vault', signKingdomRecovery([kvCoins[3]], ownerKey, [{ script:payee.script, satoshis:kvCoins[3].satoshis - 400 }]));
  const taken = planChestCapture([kvCoins[4]], { satoshis:10_000, script:payee.script, eventScript });
  await expectRejected('capture from a war chest output younger than its capture age', 'war-chest', signChestCapture(taken, operatorKey, witnessed(taken)).rawHex);
  for (let block = 0; block < 10; block += 1) await mine();
  await expectRejected('capture of more than 20% of a war chest output', 'war-chest',
    (plan => signChestCapture(plan, operatorKey, witnessed(plan), { unchecked:true }).rawHex)(tamper(taken, tx => { tx.outputs[0].valueSatoshis -= 1n; tx.outputs[1].valueSatoshis += 1n; })));
  await expectRejected('capture signed by the game key alone, without the independent attestor', 'war-chest',
    signChestCapture(taken, operatorKey, { [judge.publicKey]:signCaptureDigests(taken, operatorKey) }, { unchecked:true }).rawHex);
  await expectRejected('capture that returns the remainder somewhere else', 'war-chest',
    (plan => signChestCapture(plan, operatorKey, witnessed(plan), { unchecked:true }).rawHex)(tamper(taken, tx => { tx.outputs[0].lockingBytecode = fromHex(operator.script); })));
  await expectMined('capture of exactly 20% to the winner, 80% back in the same chest', 'war-chest', signChestCapture(taken, operatorKey, witnessed(taken)));
  await expectRejected('game key sending a war chest output to itself through the assisted lane', 'war-chest',
    signKingdomWithdrawal(tamper(planKingdomWithdrawal([kvCoins[5]], {}), tx => { tx.outputs[0].lockingBytecode = fromHex(operator.script); }), operatorKey, { unchecked:true }).rawHex);
  await expectMined('war chest output released to its owner wallet', 'war-chest', signKingdomWithdrawal(planKingdomWithdrawal([kvCoins[5]], { satoshis:20_000 }), operatorKey));

  // 7. Raid stake escrow with one outcome key and a settlement record
  const stake = label => ({ id:hex(hash256(Buffer.from('stake-' + label))).slice(0, 32), kind:'battle-escrow', version:2, record:true, principal:3000, reserve:600,
    refundAt:future, ownerKey:owner.publicKey, opponent:opponent.address, attestors:[operator.publicKey] });
  const [s1, s2, s3] = [stake('1'), stake('2'), stake('3')];
  const stakeCoins = await fund([s1, s2, s3].map(item => ({ script:compileTreasuryCovenant(item).script, satoshis:3600 })));
  const settleWith = (descriptor, coin, lane, signer = operatorKey, withRecord = true, payTo) => {
    const plan = planTreasurySpend(descriptor, coin, { lane, ...(payTo && { payee:payTo }), ...(withRecord && { eventScript }) });
    return completeTreasurySpend(plan, [schnorr(signer, treasurySigningHash(plan))]);
  };
  await expectMined('attacker lane: whole stake back to the attacker, with the battle record', 'stake-escrow', settleWith(s1, stakeCoins[0], 'return'));
  await expectMined('defender lane: stake split between attacker and the named defender', 'stake-escrow', settleWith(s2, stakeCoins[1], 'opponent-wins'));
  const robbed = (() => {
    const plan = planTreasurySpend(s3, stakeCoins[2], { lane:'return', eventScript });
    plan.transaction.outputs[0].lockingBytecode = fromHex(operator.script);
    const signature = schnorr(operatorKey, treasurySigningHash(plan));
    const { transaction } = readTransaction(settleWith(s3, stakeCoins[2], 'return').rawHex);
    const unlocking = transaction.inputs[0].unlockingBytecode;
    plan.transaction.inputs[0].unlockingBytecode = Uint8Array.from([65, ...fromHex(signature), 0x61, ...unlocking.slice(66)]);
    return hex(encodeTransaction(plan.transaction));
  })();
  await expectRejected('outcome key paying the stake to itself', 'stake-escrow', robbed);
  results.push({ group:'stake-escrow', name:'the attacked escrow is still unspent', expected:'unspent', result:await unspent(stakeCoins[2].txid, stakeCoins[2].vout) ? 'PASS' : 'FAIL' });

  // 8. Territory: open claim (at least half stays with the claimant) and raffle entry (returns to the entrant only)
  const claim = label => ({ id:hex(hash256(Buffer.from('claim-' + label))).slice(0, 32), kind:'territory-claim', version:2, record:true, principal:3000, reserve:600,
    refundAt:future, ownerKey:owner.publicKey, attestors:[operator.publicKey] });
  const entry = { id:hex(hash256(Buffer.from('raffle-entry'))).slice(0, 32), kind:'territory-uncontested', version:2, record:true, principal:4600, reserve:600,
    refundAt:future, closesAt:past, ownerKey:owner.publicKey };
  const lateEntry = { ...entry, id:hex(hash256(Buffer.from('raffle-late'))).slice(0, 32), closesAt:future - 86_400 };
  const [q1, q2] = [claim('1'), claim('2')];
  const landCoins = await fund([...[q1, q2].map(item => ({ script:compileTreasuryCovenant(item).script, satoshis:3600 })),
    { script:compileTreasuryCovenant(entry).script, satoshis:5200 }, { script:compileTreasuryCovenant(lateEntry).script, satoshis:5200 }]);
  const forfeit = (descriptor, coin, change) => {
    const plan = planTreasurySpend(descriptor, coin, { lane:'forfeit', payee:payee.address, eventScript });
    change?.(plan.transaction);
    const signature = Buffer.concat([secp256k1.signMessageHashSchnorr(fromHex(operatorKey), treasurySigningHash(plan)), Uint8Array.of(0x61)]);
    const honest = planTreasurySpend(descriptor, coin, { lane:'forfeit', payee:payee.address, eventScript });
    const template = readTransaction(completeTreasurySpend(honest, [schnorr(operatorKey, treasurySigningHash(honest))]).rawHex).transaction.inputs[0].unlockingBytecode;
    plan.transaction.inputs[0].unlockingBytecode = Uint8Array.from([65, ...signature, ...template.slice(66)]);
    return hex(encodeTransaction(plan.transaction));
  };
  await expectRejected('settlement key taking more than half of a claim stake', 'territory', forfeit(q1, landCoins[0], tx => { tx.outputs[0].valueSatoshis -= 1n; tx.outputs[1].valueSatoshis += 1n; }));
  await expectRejected('settlement key redirecting the claimant\'s own half', 'territory', forfeit(q1, landCoins[0], tx => { tx.outputs[0].lockingBytecode = fromHex(operator.script); }));
  await expectMined('lost claim: half back to the claimant, half to the contest winner, with the record', 'territory', settleWith(q1, landCoins[0], 'forfeit', operatorKey, true, payee.address));
  await expectMined('won or sole claim: whole stake back to the claimant', 'territory', settleWith(q2, landCoins[1], 'return'));
  const keyless = (descriptor, coin) => completeTreasurySpend(planTreasurySpend(descriptor, coin, { lane:'return', eventScript }), []);
  await expectRejected('raffle entry returned before the draw time', 'territory', keyless(lateEntry, landCoins[3]).rawHex);
  const stolenEntry = (() => { const { transaction } = readTransaction(keyless(entry, landCoins[2]).rawHex); transaction.outputs[0].lockingBytecode = fromHex(operator.script); return hex(encodeTransaction(transaction)); })();
  await expectRejected('raffle entry sent to anyone but its entrant', 'territory', stolenEntry);
  await expectMined('raffle entry and unused reserve returned to the entrant without any key', 'territory', keyless(entry, landCoins[2]));

  // 9. Service prize pool: reserve-funded carriers, keyless sweeps, pool top-up, payer refund, attested award
  const poolTerms = { id:hex(hash256(Buffer.from('season-pool'))).slice(0, 32), operatorKey:operator.publicKey, attestors:[judge.publicKey], closesAt:past - 60, awardPercent:40, awardAge:6, maxFee:2000 };
  const seasonPool = prizeFund(poolTerms);
  const carrierTerms = (label, refundAt = future) => { const id = hex(hash256(Buffer.from('carrier2-' + label))).slice(0, 32);
    const vaultTerms = { id, operatorKey:operator.publicKey, ownerKey:owner.publicKey, recoverAt:future, revision:2 };
    return { id, prize:450, kingdom:2925, reserve:500, prizeScript:seasonPool.script, kingdomScript:kingdomVault(vaultTerms).script, payerScript:owner.script, refundAt }; };
  const carriers2 = ['a', 'b', 'c', 'd', 'e'].map(label => carrierTerms(label)).concat([carrierTerms('late', past - 60), carrierTerms('early')]);
  const carrierCoins = (await fund([...carriers2.map(terms => ({ script:prizeCarrier2(terms).script, satoshis:3875 })), { script:miner.script, satoshis:5000 }]));
  const held = carriers2.map((terms, index) => ({ ...carrierCoins[index], carrier2:terms }));
  const firstSweep = buildPoolSweep(held.slice(0, 2), { eventScript });
  const bent = (signed, change) => { const { transaction } = readTransaction(signed.rawHex); change(transaction); return hex(encodeTransaction(transaction)); };
  await expectRejected('sweep that sends the prize shares somewhere other than the season pool', 'service-pool', bent(firstSweep, tx => { tx.outputs[0].lockingBytecode = fromHex(operator.script); }));
  await expectRejected('sweep that pays the pool one satoshi less than the prize shares', 'service-pool', bent(firstSweep, tx => { tx.outputs[0].valueSatoshis = 899n; }));
  await expectRejected('sweep that redirects a payer\'s kingdom share', 'service-pool', bent(firstSweep, tx => { tx.outputs[1].lockingBytecode = fromHex(operator.script); }));
  await expectRejected('carrier refund before its date', 'service-pool', buildCarrierRefund([held[6]]).rawHex);
  await expectMined('first keyless sweep: two carriers start the season pool, fee paid from their reserves', 'service-pool', firstSweep);
  const poolCoin = { txid:firstSweep.txid, vout:0, satoshis:firstSweep.poolSatoshis, script:seasonPool.script, redeemScript:seasonPool.redeemScript };
  const stall = signSpend({ privateKey:minerKey, requireUtxos:true, sources:[carrierCoins[7], { ...poolCoin, unlocking:'00' }],
    outputs:[{ script:seasonPool.script, satoshis:poolCoin.satoshis + 299 }, { script:miner.script, satoshis:5000 - 299 - 700 }] });
  await expectRejected('re-issuing the pool without adding at least 300 satoshis (stalling awards)', 'service-pool', stall.rawHex);
  const topUp = buildPoolSweep(held.slice(2, 5), { pool:poolCoin, eventScript });
  await expectRejected('top-up sweep that shrinks the pool', 'service-pool', bent(topUp, tx => { tx.outputs[0].valueSatoshis = BigInt(poolCoin.satoshis + 1349); }));
  await expectMined('top-up sweep: three carriers and the pool output itself, no key', 'service-pool', topUp);
  await expectMined('unswept carrier returned to its payer after the refund date, no key', 'service-pool', buildCarrierRefund([held[5]]));
  for (let block = 0; block < 6; block += 1) await mine();
  const pooled = { txid:topUp.txid, vout:0, satoshis:topUp.poolSatoshis, script:seasonPool.script, fund:poolTerms };
  const share = Math.floor(pooled.satoshis * 0.34);
  const poolAward = planPrizeAward([pooled], [{ script:payee.script, satoshis:share }, { script:seasonPool.script, satoshis:pooled.satoshis - share - 600 }]);
  await expectRejected('award from the season pool by the game key alone', 'service-pool',
    completePrizeAward(poolAward, signPrizeAward(poolAward, operatorKey), { [judge.publicKey]:signPrizeAward(poolAward, operatorKey) }, { unchecked:true }).rawHex);
  await expectMined('attested award from the season pool, remainder back in the pool', 'service-pool',
    completePrizeAward(poolAward, signPrizeAward(poolAward, operatorKey), { [judge.publicKey]:signPrizeAward(poolAward, judgeKey) }));

  // 10. Final service economy: one payer transaction with exact 50/20/20/10 outputs, a funded burn, and keyless feeder moves
  const feedPool = prizeFund({ id:hex(hash256(Buffer.from('feed-pool'))).slice(0, 32), operatorKey:operator.publicKey, attestors:[judge.publicKey], closesAt:past - 60, awardPercent:40, awardAge:6, maxFee:2000 });
  const feederTerms = { poolScript:feedPool.script, share:800 };
  const feederLock = prizeFeeder(feederTerms);
  const chestTerms = label => ({ id:hex(hash256(Buffer.from('svc-chest-' + label))).slice(0, 32), operatorKey:operator.publicKey, ownerKey:owner.publicKey, recoverAt:future,
    capturePercent:20, captureAge:144, attestors:[judge.publicKey], revision:2 });
  const burnScript = eventOutput(gameEvent('premium', 'regtest-service', { allocation:{ warChest:2000, prize:800, development:800, burn:400 } })).script;
  const service = label => [{ script:kingdomVault(chestTerms(label)).script, satoshis:2000 }, { script:payee.script, satoshis:800 }, { script:feederLock.script, satoshis:1100 }, { script:burnScript, satoshis:400 }];
  const servicePaid = await fund([...service('1'), ...service('2').slice(0, 3), ...service('3').slice(0, 3), ...service('4').slice(0, 3), { script:miner.script, satoshis:4000 }]);
  const burned = servicePaid[3];
  results.push({ group:'service-economy', name:'a 4,000-satoshi service payment with 2,000 / 800 / 800(+300 reserve) / 400 outputs is relayed and mined under standard policy',
    expected:'accepted', result:await confirmed(burned.txid) > 0 ? 'PASS' : 'FAIL', txid:burned.txid, outputs:service('1') });
  results.push({ group:'service-economy', name:'the 400-satoshi burn is a funded OP_RETURN output that never enters the spendable output set',
    expected:'unspendable', result:burnScript.startsWith('6a') && !(await unspent(burned.txid, burned.vout)) && await unspent(servicePaid[0].txid, servicePaid[0].vout) ? 'PASS' : 'FAIL', txid:burned.txid, vout:burned.vout });
  const feedCoins = [servicePaid[2], servicePaid[6], servicePaid[9], servicePaid[12]].map(coin => ({ ...coin, feeder:feederTerms }));
  const soloFeed = buildFeedSweep([feedCoins[0]]);
  await expectRejected('feeder moved anywhere but its season pool', 'service-economy', bent(soloFeed, tx => { tx.outputs[0].lockingBytecode = fromHex(operator.script); }));
  await expectRejected('feeder move that gives the pool less than the exact reward share', 'service-economy', bent(soloFeed, tx => { tx.outputs[0].valueSatoshis = 799n; }));
  await expectMined('one feeder starts the season pool without any key, fee paid from its own reserve', 'service-economy', soloFeed);
  const poolNow = { txid:soloFeed.txid, vout:0, satoshis:soloFeed.poolSatoshis, script:feedPool.script, redeemScript:feedPool.redeemScript };
  const joined = buildFeedSweep(feedCoins.slice(1, 3), { pool:poolNow });
  await expectRejected('top-up that returns less than the pool plus the new shares', 'service-economy', bent(joined, tx => { tx.outputs[0].valueSatoshis = BigInt(poolNow.satoshis + 1599); }));
  await expectMined('two feeders top up the existing pool output, no key', 'service-economy', joined);
  let tooPoor = 'refused before broadcast';
  try { buildFeedSweep([feedCoins[3]], { pool:{ ...poolNow, txid:joined.txid, satoshis:joined.poolSatoshis } }); tooPoor = 'built'; } catch (error) { tooPoor = error.message; }
  results.push({ group:'service-economy', name:'a single feeder cannot pay for a top-up alone and waits for the next payment', expected:'refused', result:/reserve|fee/.test(tooPoor) ? 'PASS' : 'FAIL', detail:tooPoor });

  // 11. War Chest revision 3: keyless consolidation of small shares, majority attestation, two-step owner exit
  const panelKeys = [21, 22, 23].map(key);
  const panel = panelKeys.map(walletFromPrivateKey);
  const panelSecret = publicKey => panelKeys[panel.findIndex(item => item.publicKey === publicKey)];
  const chest3 = kingdomVault({ id:'00'.repeat(16), operatorKey:operator.publicKey, ownerKey:owner.publicKey, capturePercent:20, captureAge:144, exitDelay:288,
    attestors:panel.map(item => item.publicKey), revision:3 });
  const exit3 = kingdomVault({ ...chestTermsOf(chest3), exiting:true });
  const feed = (label, wait = 2016) => chestFeederTerms(chestFeeder({ id:hex(hash256(Buffer.from('chest-feed-' + label))).slice(0, 32), chestScript:chest3.script, threshold:6700, reserve:220, wait }));
  const feedTerms = [feed('a'), feed('b'), feed('c'), feed('d', 20)];
  const chestPaid = await fund([...feedTerms.map(cf => ({ script:chestFeeder(cf).script, satoshis:2470 })), { script:chest3.script, satoshis:20_000 }, { script:chest3.script, satoshis:20_000 }]);
  const chestFeeders = chestPaid.slice(0, 4).map((coin, index) => ({ ...coin, cf:feedTerms[index] }));
  const kv3 = chestTermsOf(chest3);
  const deposits = chestPaid.slice(4).map(coin => ({ ...coin, kv:kv3 }));
  await expectRejected('two War Chest shares below the threshold moved early', 'war-chest-v3', buildChestFeed(chestFeeders.slice(0, 2), { aged:true, unchecked:true }).rawHex);
  const three = buildChestFeed(chestFeeders.slice(0, 3));
  await expectRejected('War Chest shares moved to their owner\'s wallet instead of the War Chest', 'war-chest-v3', bent(three, tx => { tx.outputs[0].lockingBytecode = fromHex(owner.script); }));
  await expectRejected('consolidation that keeps more than the payers\' reserves as fee', 'war-chest-v3', bent(three, tx => { tx.outputs[0].valueSatoshis -= 300n; }));
  await expectMined('three small War Chest shares join into one capturable War Chest output, no key and no wallet approval', 'war-chest-v3', three, { chestSatoshis:three.chestSatoshis });
  const loneFeed = buildChestFeed(chestFeeders.slice(3), { aged:true });
  await expectRejected('a lone share moved before its waiting period', 'war-chest-v3', loneFeed.rawHex);
  await mine(20);
  await expectMined('a lone share joins the War Chest after its waiting period (20 blocks in this run, 2,016 in the game)', 'war-chest-v3', loneFeed, { chestSatoshis:loneFeed.chestSatoshis });
  await mine(144);
  const joinedChest = { txid:three.txid, vout:0, satoshis:three.chestSatoshis, script:chest3.script, kv:kv3 };
  const smallCapture = planChestCapture([joinedChest], { satoshis:Math.floor(joinedChest.satoshis / 5), script:payee.script });
  const panelSign = (plan, count) => Object.fromEntries(chest3.attestors.slice(0, count).map(item => [item, signCaptureDigests(plan, panelSecret(item))]));
  await expectRejected('capture signed by the game key and one of three attestors', 'war-chest-v3', signChestCapture(smallCapture, operatorKey, { ...panelSign(smallCapture, 1), [chest3.attestors[1]]:signCaptureDigests(smallCapture, operatorKey) }, { unchecked:true }).rawHex);
  await expectRejected('capture signed by two attestors without the game key', 'war-chest-v3', signChestCapture(smallCapture, ownerKey, panelSign(smallCapture, 2), { unchecked:true }).rawHex);
  await expectMined('20% capture from the consolidated output, game key and two of three attestors, pays its fee and a spendable amount', 'war-chest-v3',
    signChestCapture(smallCapture, operatorKey, panelSign(smallCapture, 2)), { captured:Math.floor(joinedChest.satoshis / 5), paid:smallCapture.paid });
  // One capture, several outputs, one remainder
  const pieces = (await fund([8000, 5000, 3000].map(satoshis => ({ script:chest3.script, satoshis })))).map(coin => ({ ...coin, kv:kv3 }));
  await mine(144);
  const joinedCapture = planChestCapture(pieces, { satoshis:3200, script:payee.script });
  const shortCapture = planChestCapture(pieces, { satoshis:3200, script:payee.script });
  shortCapture.transaction.outputs[0].valueSatoshis = 12_700n;
  shortCapture.transaction.outputs[1].valueSatoshis += 99n;
  await expectRejected('capture that returns less than 80% of the outputs it spends (correctly signed)', 'war-chest-v3', signChestCapture(shortCapture, operatorKey, panelSign(shortCapture, 2), { unchecked:true }).rawHex);
  await expectMined('capture of 20% across three War Chest outputs leaves one consolidated remainder', 'war-chest-v3', signChestCapture(joinedCapture, operatorKey, panelSign(joinedCapture, 2)),
    { inputs:3, remainder:joinedCapture.outputs[0].satoshis, paid:joinedCapture.paid });
  // The owner's exit against a capture that is already owed
  const owedCapture = planChestCapture([deposits[0]], { satoshis:3000, script:payee.script });
  const owedSigned = signChestCapture(owedCapture, operatorKey, panelSign(owedCapture, 2));
  await expectRejected('owner key sends a live War Chest output straight to the owner\'s wallet', 'war-chest-v3',
    signChestExit([deposits[0]], ownerKey, { unchecked:true, outputs:[{ script:owner.script, satoshis:19_300 }] }).rawHex);
  const exitStart = signChestExit([deposits[0]], ownerKey);
  await expectMined('owner starts an exit with the wallet key alone: the output moves into the exit script', 'war-chest-v3', exitStart);
  await expectRejected('the capture transaction built before the exit (its input is spent)', 'war-chest-v3', owedSigned.rawHex);
  const exiting = { ...exitStart.exits[0], txid:exitStart.txid };
  const leave = satoshis => [{ script:owner.script, satoshis:satoshis - 700 }];
  await expectRejected('owner finishes the exit immediately', 'war-chest-v3', signKingdomRecovery([exiting], ownerKey, leave(exiting.satoshis)).rawHex);
  await mine(144);
  await expectRejected('owner finishes the exit after 144 blocks, when the capture can already confirm', 'war-chest-v3', signKingdomRecovery([exiting], ownerKey, leave(exiting.satoshis)).rawHex);
  const followed = planChestCapture([exiting], { satoshis:3000, script:payee.script });
  await expectMined('the owed capture is taken from the exit script before the owner can leave', 'war-chest-v3', signChestCapture(followed, operatorKey, panelSign(followed, 2)), { paid:followed.paid });
  const remainder = { ...followed.changes[0], txid:hex(hash256(fromHex(signChestCapture(followed, operatorKey, panelSign(followed, 2)).rawHex)).reverse()) };
  await mine(287);
  await expectMined('owner leaves with the rest once it is 288 blocks old, wallet key alone', 'war-chest-v3', signKingdomRecovery([remainder], ownerKey, leave(remainder.satoshis)));
  await expectMined('game key pays a War Chest output to its owner\'s wallet (ordinary withdrawal)', 'war-chest-v3', signKingdomWithdrawal(planKingdomWithdrawal([deposits[1]], {}), operatorKey));

  // 12. Prize fund with a majority threshold and a dated reduced quorum
  const panelFund = recoverAt => ({ id:hex(hash256(Buffer.from('panel-fund-' + recoverAt))).slice(0, 32), operatorKey:operator.publicKey, attestors:panel.map(item => item.publicKey).sort(),
    closesAt:past - 120, awardPercent:40, awardAge:6, maxFee:2000, threshold:2, recoverAt });
  const [panelOpen, panelLate] = [panelFund(future), panelFund(past - 60)];
  const panelCoins = await fund([{ script:prizeFund(panelOpen).script, satoshis:100_000 }, { script:prizeFund(panelLate).script, satoshis:100_000 }]);
  await mine(6);
  const panelAward = (coin, terms, now) => { const { sources, outputs } = layoutPrizeAward([{ ...coin, fund:terms }], { script:payee.script, satoshis:30_000 }); return planPrizeAward(sources, outputs, { now }); };
  const panelFundSign = (plan, count) => Object.fromEntries(panel.map(item => item.publicKey).sort().slice(0, count).map(item => [item, signPrizeAward(plan, panelSecret(item))]));
  const panelOpenAward = panelAward(panelCoins[0], panelOpen, past);
  await expectRejected('prize award signed by the game key and one of three attestors before the recovery time', 'prize-threshold',
    completePrizeAward({ ...panelOpenAward, locktime:future }, signPrizeAward(panelOpenAward, operatorKey), panelFundSign(panelOpenAward, 1), { unchecked:true }).rawHex);
  await expectMined('prize award signed by the game key and two of three attestors, third offline', 'prize-threshold', completePrizeAward(panelOpenAward, signPrizeAward(panelOpenAward, operatorKey), panelFundSign(panelOpenAward, 2)));
  const panelLateAward = panelAward(panelCoins[1], panelLate, past);
  await expectRejected('prize award after the recovery time signed by the game key alone', 'prize-threshold',
    completePrizeAward(panelLateAward, signPrizeAward(panelLateAward, operatorKey), { [panel.map(item => item.publicKey).sort()[0]]:signPrizeAward(panelLateAward, operatorKey) }, { unchecked:true }).rawHex);
  await expectMined('prize award after the recovery time signed by the game key and one remaining attestor', 'prize-threshold', completePrizeAward(panelLateAward, signPrizeAward(panelLateAward, operatorKey), panelFundSign(panelLateAward, 1)));

  // 13. Stake escrow version 3: outcomes need the attestor panel, inside the unchanged 600-satoshi reserve
  const panelKeysSorted = panel.map(item => item.publicKey).sort();
  const stake3 = (label, kind, extra = {}) => stakeEscrow({ id:hex(hash256(Buffer.from('stake3-' + label))).slice(0, 32), kind, ownerKey:owner.publicKey, principal:kind === 'battle-escrow' ? 3000 : 2000,
    reserve:600, refundAt:future, panel:{ keys:panelKeysSorted, threshold:2 }, ...extra });
  const stake3Duels = [stake3('a', 'battle-escrow', { opponent:opponent.script }), stake3('b', 'battle-escrow', { opponent:opponent.script }), stake3('c', 'territory-claim'), stake3('d', 'battle-escrow', { opponent:opponent.script })];
  const stake3Coins = (await fund(stake3Duels.map(item => ({ script:item.script, satoshis:item.satoshis })))).map((coin, index) => ({ ...coin, escrow:stakeTerms(stake3Duels[index]) }));
  const stake3Record = eventOutput(gameEvent('battle-settlement', 'regtest-b1', { recordHash:'ab'.repeat(32), initiationTxid:stake3Coins[0].txid })).script;
  const stake3Sign = (plan, secrets) => Object.fromEntries(secrets.map(secret => [walletFromPrivateKey(secret).publicKey, signStakeDigest(plan, secret)]));
  const stake3Lost = planStakeSpend(stake3Coins[0], { lane:'opponent-wins', eventScript:stake3Record });
  const stake3GameOnly = { [panelKeysSorted[0]]:signStakeDigest(stake3Lost, operatorKey), [panelKeysSorted[1]]:signStakeDigest(stake3Lost, operatorKey) };
  await expectRejected('stake outcome signed by the game key in place of the attestors', 'stake-escrow-v3', completeStakeSpend(stake3Lost, stake3GameOnly, { unchecked:true }).rawHex);
  await expectRejected('stake outcome signed by one of three attestors', 'stake-escrow-v3',
    completeStakeSpend(stake3Lost, { ...stake3Sign(stake3Lost, [panelSecret(panelKeysSorted[0])]), [panelKeysSorted[1]]:signStakeDigest(stake3Lost, ownerKey) }, { unchecked:true }).rawHex);
  const stake3LostSigned = completeStakeSpend(stake3Lost, stake3Sign(stake3Lost, [panelSecret(panelKeysSorted[0]), panelSecret(panelKeysSorted[2])]));
  await expectRejected('attested split that pays the defender more than half', 'stake-escrow-v3', bent(stake3LostSigned, tx => { tx.outputs[0].valueSatoshis = 1000n; tx.outputs[1].valueSatoshis = 2000n; }));
  await expectMined('lost raid: two of three attestors split the stake 1,500 / 1,500 with the battle record, fee exactly the 600-satoshi reserve', 'stake-escrow-v3', stake3LostSigned, { panel:'2 of 3 attestors, no game key' });
  const stake3Won = planStakeSpend(stake3Coins[1], { lane:'return', eventScript:stake3Record });
  await expectMined('won raid: two of three attestors return the whole stake to the attacker', 'stake-escrow-v3', completeStakeSpend(stake3Won, stake3Sign(stake3Won, [panelSecret(panelKeysSorted[1]), panelSecret(panelKeysSorted[2])])));
  const stake3Forfeit = planStakeSpend(stake3Coins[2], { lane:'forfeit', payee:payee.script, eventScript:stake3Record });
  await expectMined('territory claim: half to the contest winner named in the attested transaction, half kept', 'stake-escrow-v3', completeStakeSpend(stake3Forfeit, stake3Sign(stake3Forfeit, [panelSecret(panelKeysSorted[0]), panelSecret(panelKeysSorted[1])])));
  await expectRejected('owner refund before the refund time', 'stake-escrow-v3', signStakeRefund(stake3Coins[3], ownerKey, { unchecked:true }).rawHex);

  // 14. Waiting shares join an attested capture of their own War Chest
  const rideTerms = [feed('ride-1'), feed('ride-2')];
  const rideCoins = await fund([{ script:chest3.script, satoshis:5000 }, ...rideTerms.map(cf => ({ script:chestFeeder(cf).script, satoshis:2470 }))]);
  await mine(144);
  const smallChest = { ...rideCoins[0], kv:kv3 };
  const riders = rideCoins.slice(1).map((coin, index) => ({ ...coin, cf:rideTerms[index], contract:chestFeeder(rideTerms[index]) }));
  const rideCapture = planChestCapture([smallChest], { satoshis:1988, script:payee.script, feeders:riders });
  await expectRejected('waiting shares taken along without the attestors', 'war-chest-v3', signChestCapture(rideCapture, operatorKey, { [chest3.attestors[0]]:signCaptureDigests(rideCapture, operatorKey), [chest3.attestors[1]]:signCaptureDigests(rideCapture, operatorKey) }, { unchecked:true }).rawHex);
  await expectMined('a 5,000-satoshi War Chest output and two waiting shares: one attested capture takes 20% of all three and leaves one output', 'war-chest-v3',
    signChestCapture(rideCapture, operatorKey, panelSign(rideCapture, 2)), { inputs:3, captured:1988, paid:rideCapture.paid, remainder:rideCapture.outputs[0].satoshis });

  // 15. Season pool continuity: every attestor together, without the game key, after the recovery time
  const [lostKeyLate, lostKeyOpen] = [{ ...panelFund(past - 61), id:hex(hash256(Buffer.from('lost-key-late'))).slice(0, 32) }, { ...panelFund(future), id:hex(hash256(Buffer.from('lost-key-open'))).slice(0, 32) }];
  const lostKeyCoins = await fund([{ script:prizeFund(lostKeyLate).script, satoshis:100_000 }, { script:prizeFund(lostKeyOpen).script, satoshis:100_000 }]);
  await mine(6);
  const noGameLate = panelAward(lostKeyCoins[0], lostKeyLate, past);
  await expectRejected('prize award by two of three attestors without the game key', 'prize-threshold',
    completePrizeAward({ ...noGameLate, contracts:noGameLate.contracts.map(item => ({ ...item, continuity:true, attestors:item.attestors })) }, null, { ...panelFundSign(noGameLate, 2), [panelKeysSorted[2]]:signPrizeAward(noGameLate, ownerKey) }, { unchecked:true }).rawHex);
  await expectMined('prize award by all three attestors without the game key, after the recovery time', 'prize-threshold', completePrizeAward(noGameLate, null, panelFundSign(noGameLate, 3)));
  const noGameOpen = panelAward(lostKeyCoins[1], lostKeyOpen, past);
  await expectRejected('prize award by all three attestors without the game key before the recovery time', 'prize-threshold',
    completePrizeAward({ ...noGameOpen, locktime:future }, null, panelFundSign(noGameOpen, 3), { unchecked:true }).rawHex);

  // 16. Matched stakes: the revision 4 War Chest, the raid escrow and their atomic settlement
  const secrets = { [operator.publicKey]:operatorKey, [judge.publicKey]:judgeKey, [auditor.publicKey]:auditorKey, [opponent.publicKey]:opponentKey };
  const matchedSetup = attestorSet => {
    const chest = kingdomVault({ operatorKey:operator.publicKey, ownerKey:owner.publicKey, attestors:attestorSet, revision:4 });
    const panel = attestorSet.length === 1 ? { keys:[operator.publicKey, attestorSet[0]], threshold:2 } : { keys:attestorSet, threshold:2 };
    const escrowFor = (label, principal) => {
      const terms = raidTermsFor({ id:hex(hash256(Buffer.from('raid-' + label))).slice(0, 32), ownerKey:payer.publicKey, opponent:owner.script, principal, refundAt:label.startsWith('late') ? past : future, panel, chest });
      return { terms, contract:raidEscrow(terms) };
    };
    return { chest, kv:chestTermsOf(chest), panel, escrowFor, attest:(plan, count) => Object.fromEntries(chest.attestors.slice(0, count).map(item => [item, signMatchedDigests(plan, secrets[item])])) };
  };
  const solo = matchedSetup([judge.publicKey]);
  const [eWin, eLose, eVoid, eLate, eExit, eOpen] = ['win', 'lose', 'void', 'late-refund', 'exit', 'open'].map(label => solo.escrowFor(label, 10_000));
  const mCoins = await fund([{ script:solo.chest.script, satoshis:25_000 }, { script:solo.chest.script, satoshis:12_000 }, { script:solo.chest.script, satoshis:10_000 },
    ...[eWin, eLose, eVoid, eLate, eExit, eOpen].map(item => ({ script:item.contract.script, satoshis:item.contract.satoshis })), { script:owner.script, satoshis:3_000 }, { script:payer.script, satoshis:12_000 }]);
  const chestCoin = index => ({ ...mCoins[index], kv:solo.kv });
  const escrowCoin = (index, item) => ({ ...mCoins[index], escrow:item.terms });
  const raw4 = (transaction) => hex(encodeTransaction(transaction));
  const winPlan = planMatchedCapture([chestCoin(0)], escrowCoin(3, eWin), { eventScript });
  await expectRejected('matched capture signed by the game key alone', 'matched-stakes', completeMatchedCapture(winPlan, operatorKey, { [judge.publicKey]:signMatchedDigests(winPlan, operatorKey) }, { unchecked:true }).rawHex);
  await expectRejected('matched capture signed by the attestor without the game key', 'matched-stakes', completeMatchedCapture(winPlan, payeeKey, solo.attest(winPlan, 1), { unchecked:true }).rawHex);
  // The next two are signed CORRECTLY by the game key and the attestor. The node refuses them because of the scripts' own rules.
  { const greedy = planMatchedCapture([chestCoin(0)], escrowCoin(3, eWin), { eventScript });
    greedy.transaction.outputs[2].valueSatoshis -= 1n;
    redigest(greedy);
    await expectRejected('correctly signed capture that takes one satoshi more than the stake from the War Chest', 'matched-stakes', completeMatchedCapture(greedy, operatorKey, solo.attest(greedy, 1), { unchecked:true }).rawHex);
    const skim = planMatchedCapture([chestCoin(0)], escrowCoin(3, eWin), { eventScript });
    skim.transaction.outputs[1].valueSatoshis -= 1n;
    redigest(skim);
    await expectRejected('correctly signed victory that keeps one satoshi of the unused reserve from the attacker', 'matched-stakes', completeMatchedCapture(skim, operatorKey, solo.attest(skim, 1), { unchecked:true }).rawHex);
    const stolen = planMatchedCapture([chestCoin(0)], escrowCoin(3, eWin), { eventScript });
    stolen.transaction.outputs[2].lockingBytecode = fromHex(payee.script);
    redigest(stolen);
    await expectRejected('correctly signed capture whose remainder leaves the War Chest', 'matched-stakes', completeMatchedCapture(stolen, operatorKey, solo.attest(stolen, 1), { unchecked:true }).rawHex); }
  // The attacker tries to take the escrow back by "matching" it with the attacker's own coin instead of the defender's chest.
  { const own = mCoins[10];
    const transaction = { version:2, locktime:0, inputs:[{ outpointTransactionHash:fromHex(own.txid), outpointIndex:own.vout, sequenceNumber:0xfffffffe, unlockingBytecode:new Uint8Array() },
      { outpointTransactionHash:fromHex(mCoins[8].txid), outpointIndex:mCoins[8].vout, sequenceNumber:0xfffffffe, unlockingBytecode:new Uint8Array() }],
      outputs:[{ lockingBytecode:fromHex(payer.script), valueSatoshis:20_000n }, { lockingBytecode:fromHex(payer.script), valueSatoshis:BigInt(eOpen.contract.reserve - eOpen.contract.winBase - eOpen.contract.winPerInput) }] };
    const sourceOutputs = [{ lockingBytecode:fromHex(payer.script), valueSatoshis:BigInt(own.satoshis) }, { lockingBytecode:fromHex(eOpen.contract.script), valueSatoshis:BigInt(mCoins[8].satoshis) }];
    const sig0 = secp256k1.signMessageHashSchnorr(fromHex(payerKey), hash256(generateSigningSerializationBCH({ inputIndex:0, sourceOutputs, transaction }, { coveredBytecode:fromHex(payer.script), signingSerializationType:Uint8Array.of(0x61) })));
    transaction.inputs[0].unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([sig0, Uint8Array.of(0x61)])), encodeDataPush(fromHex(payer.publicKey))]));
    transaction.inputs[1].unlockingBytecode = Uint8Array.from(Buffer.concat([Uint8Array.of(0x00, 0x00, 0x53), encodeDataPush(fromHex(eOpen.contract.redeemScript))]));
    await expectRejected('attacker takes the escrow back by matching it with the attacker\'s own money, without the panel', 'matched-stakes', raw4(transaction)); }
  const wonRaid = completeMatchedCapture(winPlan, operatorKey, solo.attest(winPlan, 1));
  await expectMined('attacker victory, one attestor: the escrow and the defender\'s War Chest in ONE transaction; 2 x S and the unused reserve to the attacker, the rest back to the chest', 'matched-stakes', wonRaid,
    { stake:10_000, reserve:eWin.contract.reserve, attackerReceives:winPlan.paid, chestBefore:25_000, chestAfter:winPlan.outputs[2].satoshis });
  const losePlan = planRaidSpend(escrowCoin(4, eLose), { lane:'defender-wins', eventScript });
  const loseSign = plan => Object.fromEntries(solo.panel.keys.map(item => [item, signRaidDigest(plan.digest, secrets[item])]));
  await expectRejected('defender victory signed by the game key alone', 'matched-stakes', completeRaidSpend(losePlan, { [operator.publicKey]:signRaidDigest(losePlan.digest, operatorKey), [judge.publicKey]:signRaidDigest(losePlan.digest, operatorKey) }, { unchecked:true }).rawHex);
  { const redirected = planRaidSpend(escrowCoin(4, eLose), { lane:'defender-wins', eventScript });
    redirected.transaction.outputs[0].lockingBytecode = fromHex(payee.script);
    redigest(redirected);
    await expectRejected('defender victory, correctly signed by the panel, paid to a wallet other than the defender\'s', 'matched-stakes', completeRaidSpend(redirected, loseSign(redirected), { unchecked:true }).rawHex); }
  await expectMined('defender victory: the whole stake to the defender, the unused reserve back to the attacker', 'matched-stakes', completeRaidSpend(losePlan, loseSign(losePlan)),
    { defenderReceives:losePlan.outputs[0].satoshis, attackerGetsBack:losePlan.outputs[1]?.satoshis ?? 0 });
  const voidPlan = planRaidSpend(escrowCoin(5, eVoid), { lane:'void', eventScript });
  await expectMined('void raid: stake and unused reserve back to the attacker', 'matched-stakes', completeRaidSpend(voidPlan, loseSign(voidPlan)), { attackerGetsBack:voidPlan.outputs[0].satoshis });
  await expectRejected('attacker\'s own refund before the refund time', 'matched-stakes', signRaidRefund(escrowCoin(7, eExit), payerKey, { unchecked:true }).rawHex);
  await expectMined('attacker\'s own refund after the refund time, with the attacker\'s key alone', 'matched-stakes', signRaidRefund(escrowCoin(6, eLate), payerKey));
  // Release by the game key: young output refused, 144 blocks later accepted, and only to the owner.
  const releasePlan = planKingdomWithdrawal([chestCoin(1)], { satoshis:4_000, eventScript });
  await expectRejected('game-key withdrawal of a War Chest output younger than 144 blocks', 'matched-stakes', signKingdomWithdrawal(releasePlan, operatorKey, { unchecked:true }).rawHex);
  // Exit: the owner's key alone, whole, into the exit script; the fee comes from the owner's wallet.
  const exitPurse = mCoins[9];
  await expectRejected('exit that pays the owner\'s wallet instead of the exit script', 'matched-stakes', signChestExit([chestCoin(2)], ownerKey, { fee:exitPurse, unchecked:true, outputs:[{ script:owner.script, satoshis:10_000 }] }).rawHex);
  await expectRejected('exit that shrinks the War Chest by one satoshi', 'matched-stakes', signChestExit([chestCoin(2)], ownerKey, { fee:exitPurse, unchecked:true, outputs:[{ script:solo.chest.exitScript, satoshis:9_999 }] }).rawHex);
  await expectRejected('exit started by the game key', 'matched-stakes', signChestExit([chestCoin(2)], operatorKey, { fee:exitPurse, unchecked:true }).rawHex);
  const exit4 = signChestExit([chestCoin(2)], ownerKey, { fee:exitPurse });
  await expectMined('owner\'s exit: the whole output moves into the exit script, fee paid from the owner\'s wallet', 'matched-stakes', exit4, { moved:exit4.exits[0].satoshis });
  const exited4 = { ...exit4.exits[0], txid:exit4.txid };
  await expectRejected('owner spends the exit output before 288 blocks', 'matched-stakes', signKingdomRecovery([exited4], ownerKey, [{ script:owner.script, satoshis:9_300 }]).rawHex);
  // A raid that was funded before the exit is still settled from the exit script.
  const followPlan = planMatchedCapture([exited4], escrowCoin(7, eExit), { eventScript });
  await expectMined('attacker victory against an output already in its owner\'s exit script (exactly S: nothing remains)', 'matched-stakes', completeMatchedCapture(followPlan, operatorKey, solo.attest(followPlan, 1)),
    { attackerReceives:followPlan.paid, remainder:followPlan.remainder });
  await mine(144);
  { const elsewhere = planKingdomWithdrawal([chestCoin(1)], { satoshis:4_000, eventScript });
    elsewhere.transaction.outputs[0].lockingBytecode = fromHex(operator.script);
    await expectRejected('game-key withdrawal to a wallet other than the owner\'s', 'matched-stakes', signKingdomWithdrawal(elsewhere, operatorKey, { unchecked:true }).rawHex); }
  const released4 = signKingdomWithdrawal(releasePlan, operatorKey);
  await expectMined('game-key withdrawal after 144 blocks: the owner\'s wallet and a remainder on the 1,000-satoshi grid', 'matched-stakes', released4, { paid:releasePlan.paid, remainder:releasePlan.change?.satoshis ?? 0 });
  // Two of three attestors, two War Chest outputs, a stake of exactly their sum.
  const trio = matchedSetup([judge.publicKey, auditor.publicKey, opponent.publicKey]);
  const eTwo = trio.escrowFor('two-outputs', 25_000);
  const tCoins = await fund([{ script:trio.chest.script, satoshis:15_000 }, { script:trio.chest.script, satoshis:10_000 }, { script:eTwo.contract.script, satoshis:eTwo.contract.satoshis }]);
  const twoPlan = planMatchedCapture([{ ...tCoins[0], kv:trio.kv }, { ...tCoins[1], kv:trio.kv }], { ...tCoins[2], escrow:eTwo.terms }, { eventScript });
  await expectRejected('matched capture with one of three attestors', 'matched-stakes', completeMatchedCapture(twoPlan, operatorKey, { ...trio.attest(twoPlan, 1), [trio.chest.attestors[1]]:signMatchedDigests(twoPlan, operatorKey) }, { unchecked:true }).rawHex);
  await expectMined('attacker victory, two of three attestors, two War Chest outputs of exactly the stake', 'matched-stakes', completeMatchedCapture(twoPlan, operatorKey, trio.attest(twoPlan, 2)),
    { stake:25_000, reserve:eTwo.contract.reserve, attackerReceives:twoPlan.paid, remainder:twoPlan.remainder });
  // 17. Record reserve of a paid political operation
  const reserveA = recordReserve({ id:hex(hash256(Buffer.from('record-a'))).slice(0, 32), operatorKey:operator.publicKey });
  const [rCoin] = await fund([{ script:reserveA.script, satoshis:RECORD_RESERVE_SATOSHIS }]);
  const rSource = { ...rCoin, rr:{ id:reserveA.id, operatorKey:reserveA.operatorKey } };
  { const [bigCoin] = await fund([{ script:reserveA.script, satoshis:3_000 }]);
    await expectRejected('record reserve sent to the game key\'s own wallet, correctly signed by the game key', 'record-reserve',
      signRecord({ ...bigCoin, rr:rSource.rr }, eventScript, operatorKey, { unchecked:true, outputs:[{ script:operator.script, satoshis:2_000 }] }).rawHex);
    await expectRejected('record reserve with a second, paying output next to the record', 'record-reserve',
      signRecord({ ...bigCoin, rr:rSource.rr }, eventScript, operatorKey, { unchecked:true, outputs:[{ script:eventScript, satoshis:0 }, { script:operator.script, satoshis:2_000 }] }).rawHex);
    await expectRejected('record reserve spent by a key other than the game key', 'record-reserve', signRecord(rSource, eventScript, payeeKey, { unchecked:true }).rawHex); }
  await expectMined('record reserve spent as the fee of one zero-value proof record', 'record-reserve', signRecord(rSource, eventScript, operatorKey));
  // Version 2: the same record lane, and the payer's own recovery of an unused reserve once it is old enough.
  { const terms = { id:hex(hash256(Buffer.from('record-v2'))).slice(0, 32), operatorKey:operator.publicKey, ownerKey:owner.publicKey, recoveryAge:144 };
    const reserve2 = recordReserve(terms);
    const [used, unused, feeCoin, feeCoin2] = await fund([{ script:reserve2.script, satoshis:RECORD_RESERVE_SATOSHIS }, { script:reserve2.script, satoshis:RECORD_RESERVE_SATOSHIS },
      { script:owner.script, satoshis:2_000 }, { script:payee.script, satoshis:2_000 }]);
    await expectMined('version 2 record reserve spent as the fee of one zero-value proof record', 'record-reserve', signRecord({ ...used, rr:terms }, eventScript, operatorKey));
    await expectRejected('version 2 record reserve with a paying output, correctly signed by the game key', 'record-reserve',
      signRecord({ ...unused, rr:terms }, eventScript, operatorKey, { unchecked:true, outputs:[{ script:operator.script, satoshis:0 }] }).rawHex);
    await expectRejected('payer takes an unused record reserve back before it is 144 blocks old', 'record-reserve', signRecordRecovery({ ...unused, rr:terms }, ownerKey, { fee:feeCoin, unchecked:true }).rawHex);
    await mine(144);
    await expectMined('payer takes an unused record reserve back after 144 blocks, with the payer\'s key alone', 'record-reserve', signRecordRecovery({ ...unused, rr:terms }, ownerKey, { fee:feeCoin })); }

  // 18. The standalone payout tool reaches a real node: it finds a contract output by its script, broadcasts, and reads confirmations.
  { const tool = rpcChain(`http://audit:audit@127.0.0.1:${port}`, { checkpoint:false });
    const reserveB = recordReserve({ id:hex(hash256(Buffer.from('record-b'))).slice(0, 32), operatorKey:operator.publicKey });
    const [coinB] = await fund([{ script:reserveB.script, satoshis:RECORD_RESERVE_SATOSHIS }]);
    const found = await tool.unspent(reserveB.script);
    const sent = signRecord({ ...coinB, rr:{ id:reserveB.id, operatorKey:reserveB.operatorKey } }, eventScript, operatorKey);
    let detail;
    try {
      const txid = await tool.broadcast(sent.rawHex);
      await mine();
      detail = { found:found.map(item => item.txid + ':' + item.vout + ' ' + item.satoshis), txid, confirmations:await tool.confirmations(txid), leftUnspent:(await tool.unspent(reserveB.script)).length };
    } catch (error) { detail = { error:error.message }; }
    const good = found.length === 1 && found[0].txid === coinB.txid && found[0].satoshis === RECORD_RESERVE_SATOSHIS && detail.confirmations >= 1 && detail.leftUnspent === 0;
    results.push({ group:'standalone-tool', name:'the payout tool\'s node adapter finds a contract output by script, broadcasts a spend and reads its confirmation', expected:'accepted', result:good ? 'PASS' : 'FAIL', ...detail });
    if (!good) failures.push('standalone tool node adapter'); }

  const report = { network:'regtest (private local chain, not Chipnet)', node:version, relayPolicy:'standard (-acceptnonstdtxn=0)', executedAt:new Date().toISOString(),
    height:await rpc('getblockcount'), pass:results.filter(item => item.result === 'PASS').length, fail:failures.length, results };
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  for (const item of results) console.log(item.result, '·', item.group, '·', item.name, item.txid ? '· ' + item.txid.slice(0, 16) + '…' : item.nodeError ? '· ' + item.nodeError.slice(0, 70) : item.error ?? '');
  console.log(`${report.pass} passed, ${report.fail} failed on ${version} at height ${report.height}`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  await rpc('stop').catch(() => node.kill());
  await new Promise(resolve => node.once('exit', resolve));
  rmSync(datadir, { recursive:true, force:true });
}
