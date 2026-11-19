import { readFile } from 'node:fs/promises';
import { createChain } from '../packages/chain-observer/index.mjs';
import { signPoliticalEscrow } from '../packages/chain-observer/political-escrow.mjs';
import { eventOutput, gameEvent } from '../packages/chain-observer/vaultborn.mjs';

// Payer-signed recovery after the escrow timeout. It needs no game server and no operator key.
// A version 2 escrow returns whatever amount was actually paid. Payments too small to carry the fee take a sponsor input:
//   POLITICAL_REFUND_SPONSOR_KEY_FILE=<hex key file> POLITICAL_REFUND_SPONSOR_OUTPOINT=<txid>:<vout>
const [contractFile,txid]=process.argv.slice(2);
if (!contractFile || !txid || !process.env.POLITICAL_REFUND_KEY_FILE) {
  throw new Error('Supply a reviewed checkout JSON file, funding TXID, and a local Chipnet signing key file.');
}
const saved=JSON.parse(await readFile(contractFile,'utf8'));
const {contract,event}=saved.result ?? saved;
const version=contract?.version ?? 1;
const chain=createChain();
const observed=await chain.verifyPublishedTransaction(txid);
const source=observed?.outputs.find(output=>output.script===contract?.script && output.asset==='BCH' &&
  (version===2 || output.satoshis===contract.satoshis));
if (!source || !observed.confirmations) {
  throw new Error(version===2 ? 'The confirmed Chipnet funding outpoint was not found.' :
    'The confirmed, exactly funded Chipnet outpoint was not found. A version 1 escrow cannot return another amount through this tool.');
}
let sponsor;
if (process.env.POLITICAL_REFUND_SPONSOR_KEY_FILE) {
  const [sponsorTxid,sponsorVout]=(process.env.POLITICAL_REFUND_SPONSOR_OUTPOINT ?? '').split(':');
  const funded=await chain.verifyPublishedTransaction(sponsorTxid);
  const coin=funded?.outputs[Number(sponsorVout)];
  if (!coin || coin.asset!=='BCH' || !funded.confirmations) throw new Error('The confirmed sponsor outpoint was not found.');
  sponsor={privateKey:(await readFile(process.env.POLITICAL_REFUND_SPONSOR_KEY_FILE,'utf8')).trim(),
    source:{txid:sponsorTxid,vout:coin.vout,script:coin.script,satoshis:coin.satoshis}};
}
const commitment=gameEvent('political-refund','pe-'+contract.id,{entryTxid:txid,principal:contract.principal,
  treaty:event.data.treaty,termsHash:event.data.termsHash,...(source.satoshis!==contract.satoshis && {satoshis:source.satoshis,misfunded:true})});
const privateKey=(await readFile(process.env.POLITICAL_REFUND_KEY_FILE,'utf8')).trim();
const result=signPoliticalEscrow({contract,source:{...source,txid},privateKey,lane:'payer-refund',eventScript:eventOutput(commitment).script,sponsor});
console.log(JSON.stringify({...result,network:'chipnet',refundAt:contract.refundAt,version},null,2));
