import { createVirtualMachineBCH, encodeDataPush } from '@bitauth/libauth';
import {
  amount, decodeAddress, DUST, explorerUrl, fromHex, HEX64, hex, normalizeSource,
  readTransaction, sha256, signSpend, toAddress, walletFromPrivateKey,
} from './primitives.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';
import { ADDRESS_PATTERN, NETWORK_ID } from '../../config/network.mjs';

export const BATON_COMMITMENT = hex(Buffer.from('VAULTBORN TERRITORY AUTHORITY V1'));
export const CARRIER_SATOSHIS = 1500;
const MINIMUM_BATON = 1500;
const MINIMUM_FEE = 500;
const MAX_INPUTS = 8;
const kinds = Object.freeze({ deed:1, conquest:2, lease:3, 'lease-renewed':4, 'lease-expired':5, control:6, 'political-treaty':7 });
const anchors = new Set(['lease-expired', 'control']);
const slug = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const opReturn = (chunks) => hex(Buffer.concat([Buffer.of(0x6a), ...chunks.map(chunk => encodeDataPush(chunk))]));
const token = (category, commitment, capability) => ({
  category: fromHex(category), amount: 0n, nft: { capability, commitment: fromHex(commitment) },
});

export function normalizeTerritoryEvent(input) {
  const { eventId, territoryId, kind, version, controllerId, controlHash, holderAddress, expiresAt, relatedTxid } = input ?? {};
  if (typeof eventId !== 'string' || !slug.test(eventId) || typeof territoryId !== 'string' || !slug.test(territoryId) ||
    !Object.hasOwn(kinds, kind) || !Number.isSafeInteger(version) || version < 1 || version > 0xffffffff ||
    typeof controlHash !== 'string' || !HEX64.test(controlHash)) {
    throw new Error('Territory evidence needs an event ID, territory ID, state version and control hash.');
  }
  if (controllerId != null && (typeof controllerId !== 'string' || !slug.test(controllerId))) {
    throw new Error('Invalid controller identifier.');
  }
  if (relatedTxid != null && (typeof relatedTxid !== 'string' || !HEX64.test(relatedTxid))) {
    throw new Error('Invalid related ' + NETWORK_LABEL + ' transaction ID.');
  }
  if (expiresAt != null && (!Number.isSafeInteger(expiresAt) || expiresAt < 1)) throw new Error('Invalid lease expiration timestamp.');
  if (['lease','lease-renewed'].includes(kind) && !expiresAt) throw new Error('Lease evidence requires a real expiration timestamp.');
  const recipient = holderAddress ? decodeAddress(holderAddress) : null;
  if (anchors.has(kind) && recipient) throw new Error('A control anchor has no collectible recipient.');
  const event = {
    id: kind === 'deed' ? 'deed:' + territoryId : kind + ':' + eventId,
    eventId, territoryId, kind, version, controllerId: controllerId ?? null,
    controlHash: controlHash.toLowerCase(), holderAddress: recipient ? toAddress(recipient.script, true) : null,
    expiresAt: expiresAt ?? null, relatedTxid: relatedTxid?.toLowerCase() ?? null,
  };
  return { ...event, anchorOnly: anchors.has(kind), recipientScript: recipient?.script ?? null };
}

export function territoryCommitment(event) {
  const canonical = {
    eventId: event.eventId, territoryId: event.territoryId, kind: event.kind, version: event.version,
    controllerId: event.controllerId ?? null, controlHash: event.controlHash,
    expiresAt: event.expiresAt ?? null, relatedTxid: event.relatedTxid ?? null,
  };
  const digest = sha256(Buffer.from(JSON.stringify(canonical)));
  const version = Buffer.alloc(4);
  version.writeUInt32LE(event.version);
  const commitment = Buffer.concat([Buffer.from('VBTA'), Buffer.of(1, kinds[event.kind]), version, digest.subarray(0, 30)]);
  return {
    commitment: hex(commitment), eventDigest: hex(digest),
    anchorScript: opReturn([Buffer.from('VBTA'), Buffer.of(1, kinds[event.kind]), digest, fromHex(event.controlHash)]),
  };
}

function sameToken(actual, category, commitment, capability = 'none') {
  return actual?.nft?.capability === capability && actual.amount === 0n &&
    hex(actual.category) === category && hex(actual.nft.commitment) === commitment;
}

function outputIs(output, script, satoshis) {
  return output && hex(output.lockingBytecode) === script && output.valueSatoshis === BigInt(satoshis);
}

function inputIs(input, source) {
  return input && hex(input.outpointTransactionHash) === source.txid && input.outpointIndex === source.vout;
}

function vmVerified(spend, sources) {
  const { transaction } = readTransaction(spend.rawHex, spend.txid);
  const sourceOutputs = sources.map(({ script, satoshis, token }) => ({
    lockingBytecode: fromHex(script), valueSatoshis: BigInt(satoshis), token,
  }));
  const validated = createVirtualMachineBCH().verify({ transaction, sourceOutputs });
  if (validated !== true) throw new Error('The territory CashTokens transaction failed VM verification: ' + validated);
  return spend;
}

// metadataScript (optional): a Bitcoin Cash Metadata Registry publication, OP_RETURN <'BCMR'> <sha256> <uri>, so that
// wallets can show the category's name and picture. Without it the transaction is exactly as before.
export function buildTerritoryGenesis(source, operatorPrivateKey, metadataScript) {
  const operator = walletFromPrivateKey(operatorPrivateKey);
  const coin = normalizeSource({ ...source, script:source.script ?? operator.script });
  if (coin.vout !== 0 || coin.script !== operator.script || coin.token || coin.satoshis < MINIMUM_BATON + MINIMUM_FEE) {
    throw new Error('Genesis needs an ordinary operator-owned BCH output at vout zero.');
  }
  if (metadataScript != null && (typeof metadataScript !== 'string' || !/^6a0442434d5220[0-9a-f]{64}[0-9a-f]*$/.test(metadataScript) || metadataScript.length > 300)) {
    throw new Error('The metadata output must be a BCMR publication.');
  }
  const category = coin.txid;
  const baton = { script:operator.script, satoshis:coin.satoshis - MINIMUM_FEE,
    token:token(category, BATON_COMMITMENT, 'minting') };
  const outputs = [baton, { script:opReturn([Buffer.from('VBTA'), Buffer.of(1, 0), fromHex(category)]), satoshis:0 },
    ...(metadataScript ? [{ script:metadataScript, satoshis:0 }] : [])];
  const signed = vmVerified(signSpend({ sources:[coin], outputs, privateKey:operatorPrivateKey, requireUtxos:true }), [coin]);
  return { ...signed, category, batonVout:0 };
}

export function knownTerritoryBaton(observed, category, operatorScript, genesis = false) {
  const transaction = observed?.transaction;
  if (!transaction) throw new Error('The authority baton is unavailable on ' + NETWORK_LABEL + '.');
  if (genesis && !transaction.inputs.some(input => inputIs(input, { txid:category, vout:0 }))) {
    throw new Error('The configured transaction did not originate this category.');
  }
  const outputs = transaction.outputs.flatMap((output, vout) =>
    sameToken(output.token, category, BATON_COMMITMENT, 'minting') ? [{ output, vout }] : []);
  const exactAuthority = transaction.outputs.filter(output => output.token?.nft?.capability === 'minting' &&
    hex(output.token.category) === category);
  if (exactAuthority.length !== 1 || outputs.length !== 1 || outputs[0].vout !== 0 ||
    hex(outputs[0].output.lockingBytecode) !== operatorScript || outputs[0].output.valueSatoshis < BigInt(MINIMUM_BATON)) {
    throw new Error('The authority transaction must return one minting baton to the configured operator at vout zero.');
  }
  return { txid:observed.txid, vout:0, script:operatorScript, satoshis:Number(outputs[0].output.valueSatoshis),
    token:outputs[0].output.token, confirmations:observed.confirmations };
}

export function buildTerritoryIssue({ baton, funding = [], event, category, operatorPrivateKey }) {
  const operator = walletFromPrivateKey(operatorPrivateKey);
  const spec = territoryCommitment(event);
  const isCollectible = !event.anchorOnly;
  if (isCollectible && !event.recipientScript) throw new Error('The recipient must link a ' + NETWORK_LABEL + ' wallet before collectible issuance.');
  if (!sameToken(baton.token, category, BATON_COMMITMENT, 'minting') || baton.vout !== 0 || baton.script !== operator.script) {
    throw new Error('The live minting baton is required to authorize territory evidence.');
  }
  const sources = [normalizeSource(baton)];
  const occupied = new Set([baton.txid + ':0']);
  let value = amount(baton.satoshis);
  const needed = BigInt(MINIMUM_BATON + (isCollectible ? CARRIER_SATOSHIS : 0));
  const fee = () => BigInt(MINIMUM_FEE + (sources.length - 1) * 160);
  for (const candidate of funding) {
    if (value >= needed + fee() || sources.length >= MAX_INPUTS) break;
    const coin = normalizeSource(candidate);
    const key = coin.txid + ':' + coin.vout;
    if (occupied.has(key) || coin.script !== operator.script || coin.token) continue;
    occupied.add(key);
    sources.push(coin);
    value += amount(coin.satoshis);
  }
  if (value < needed + fee()) throw new Error('The territory issuer needs more confirmed ' + NETWORK_LABEL + ' BCH.');
  const batonSatoshis = Number(value - fee() - BigInt(isCollectible ? CARRIER_SATOSHIS : 0));
  const outputs = [{ script:operator.script, satoshis:batonSatoshis, token:baton.token }];
  const assetVout = isCollectible ? 1 : null;
  if (isCollectible) outputs.push({
    script:event.recipientScript, satoshis:CARRIER_SATOSHIS, token:token(category, spec.commitment, 'none'),
  });
  const anchorVout = outputs.length;
  outputs.push({ script:spec.anchorScript, satoshis:0 });
  const signed = vmVerified(signSpend({ sources, outputs, privateKey:operatorPrivateKey }), sources);
  return { ...signed, ...spec, assetVout, anchorVout, batonSatoshis,
    batonInput: { txid:baton.txid, vout:baton.vout }, category,
    intentSources:sources.map(({txid,vout}) => ({txid,vout})),
  };
}

export function validateTerritoryIssue(observed, record, operatorScript) {
  const { event, plan } = record;
  const transaction = observed?.transaction;
  if (!transaction || observed.txid !== plan.txid || !inputIs(transaction.inputs[0], plan.batonInput)) {
    throw new Error('The territory transaction does not spend the recorded authorization baton.');
  }
  const exactAnchor = outputIs(transaction.outputs[plan.anchorVout], plan.anchorScript, 0);
  if (!exactAnchor || transaction.outputs[plan.anchorVout].token || transaction.outputs.length !== plan.anchorVout + 1 ||
    !outputIs(transaction.outputs[0], operatorScript, plan.batonSatoshis)) {
    throw new Error('The confirmed outputs do not match the territory event commitment.');
  }
  knownTerritoryBaton(observed, plan.category, operatorScript);
  if (!event.anchorOnly) {
    const output = transaction.outputs[plan.assetVout];
    if (!outputIs(output, event.recipientScript, CARRIER_SATOSHIS) ||
      !sameToken(output.token, plan.category, plan.commitment)) {
      throw new Error('The collectible output does not match the authorized holder and commitment.');
    }
  }
  return {
    txid:observed.txid, confirmations:observed.confirmations, height:observed.height,
    blockHash:observed.blockHash ?? null, network:NETWORK_ID, explorerUrl:explorerUrl(observed.txid),
    category:plan.category, commitment:event.anchorOnly ? null : plan.commitment, eventDigest:plan.eventDigest,
    anchorVout:plan.anchorVout, assetVout:plan.assetVout, feeSatoshis:plan.feeSatoshis,
    authorityInput:plan.batonInput, authorityVout:0,
  };
}

function ownerOutpoint(observed, vout) {
  const output = observed.transaction.outputs[vout];
  const script = hex(output.lockingBytecode);
  let address = null;
  try { address = toAddress(script, true); } catch { /* An arbitrary contract may own the collectible. */ }
  return {
    txid:observed.txid, vout, address, script, satoshis:Number(output.valueSatoshis),
    height:observed.height, confirmations:observed.confirmations, explorerUrl:explorerUrl(observed.txid),
  };
}

// A long transfer chain or a busy holding address is followed across calls. Each call verifies a bounded amount of history and
// returns a checkpoint: the latest outpoint proven to hold the collectible, plus how much address history was already examined.
// A checkpoint is re-verified against the chain before it is trusted, so a stale or forged one cannot assert ownership.
export async function traceTerritoryCollectible(client, issued, vout, category, commitment, minConfirmations, checkpoint) {
  const first = ownerOutpoint(issued, vout);
  const history = [{ ...first, type:'issued' }];
  let current = first;
  let scanned = 0;
  let hops = 0;
  if (checkpoint && /^[0-9a-f]{64}$/.test(checkpoint.txid ?? '') && Number.isSafeInteger(checkpoint.vout) &&
      !(checkpoint.txid === first.txid && checkpoint.vout === first.vout)) {
    const held = await client.lookup(checkpoint.txid);
    if (held && held.confirmations >= minConfirmations && sameToken(held.transaction.outputs[checkpoint.vout]?.token, category, commitment)) {
      current = ownerOutpoint(held, checkpoint.vout);
      hops = Number.isSafeInteger(checkpoint.hops) && checkpoint.hops > 0 ? checkpoint.hops : 1;
      history.push({ ...current, type:'transferred', resumed:true, priorTransfers:hops - 1 });
    }
  }
  if (checkpoint && checkpoint.txid === current.txid && checkpoint.vout === current.vout && Number.isSafeInteger(checkpoint.scanned)) {
    scanned = Math.max(0, checkpoint.scanned);
  }
  const mark = () => ({ txid:current.txid, vout:current.vout, hops, scanned });
  for (let hop = 0; hop < 16; hop += 1) {
    const unspent = await client.listUnspent(current.script, 'tokens_only');
    if (unspent.some(coin => coin.txid === current.txid && coin.vout === current.vout && coin.satoshis === current.satoshis && coin.height > 0)) {
      return { status:'unspent', current, history, checkpoint:mark() };
    }
    const candidates = (await client.history(current.script)).filter(candidate => candidate.txid !== current.txid &&
      (candidate.height >= current.height || candidate.height <= 0))
      .sort((one, two) => (one.height > 0 ? one.height : Infinity) - (two.height > 0 ? two.height : Infinity));
    if (scanned > candidates.length) scanned = 0;
    const bounded = candidates.slice(scanned, scanned + 256);
    let successor;
    for (const candidate of bounded) {
      const raw = await client.raw(candidate.txid);
      if (!raw) continue;
      const decoded = readTransaction(raw, candidate.txid);
      if (!decoded.transaction.inputs.some(input => inputIs(input, current))) continue;
      successor = await client.lookup(candidate.txid, candidate.height);
      if (successor) break;
    }
    if (!successor) {
      if (scanned + bounded.length < candidates.length) {
        scanned += bounded.length;
        return { status:'continuing', current:null, lastVerified:current, history, checkpoint:mark() };
      }
      return { status:'unresolved', current:null, lastVerified:current, history, checkpoint:{ ...mark(), scanned:0 } };
    }
    if (successor.confirmations < minConfirmations) {
      return { status:'transfer-pending', current:null, history, pendingTxid:successor.txid, checkpoint:mark() };
    }
    const matches = successor.transaction.outputs.flatMap((output, index) =>
      sameToken(output.token, category, commitment) ? [index] : []);
    if (!matches.length) return {
      status:'burned', current:null, history:[...history, {
        type:'burned', txid:successor.txid, height:successor.height, explorerUrl:explorerUrl(successor.txid),
      }],
    };
    if (matches.length !== 1) return { status:'ambiguous', current:null, history };
    current = ownerOutpoint(successor, matches[0]);
    scanned = 0;
    hops += 1;
    history.push({ ...current, type:'transferred' });
  }
  // More transfers remain. The caller keeps the checkpoint and the next call continues from it.
  return { status:'continuing', current:null, lastVerified:current, history, checkpoint:mark() };
}

export function publicTerritoryAsset(record) {
  const { event, state, receipt, lastError, plan } = record;
  const { recipientScript, ...fields } = event;
  return {
    ...fields, state, receipt:receipt ?? null, txid:plan?.txid ?? null,
    category:plan?.category ?? record.category, commitment:plan?.commitment && !event.anchorOnly ? plan.commitment : null,
    statusDetail:lastError ?? null, authority:'game-controlled; collectible transfer does not change territory control',
  };
}
