import { createHash, randomBytes } from 'node:crypto';
import {
  cashAddressToLockingBytecode, decodeTransaction, encodeDataPush, encodeTransaction,
  generateSigningSerializationBCH, hashTransaction, lockingBytecodeToCashAddress, secp256k1,
  validateSecp256k1PrivateKey
} from '@bitauth/libauth';
import { ADDRESS_PREFIX, NETWORK_ID, NETWORK_LABEL, explorerUrl as networkExplorerUrl } from '../../config/network.mjs';

// The network of this process (config/network.mjs). Every address this module encodes or accepts belongs to it.
export const NETWORK = NETWORK_ID;
export const DUST = 546n;
export const HEX64 = /^[a-f0-9]{64}$/i;
const MONEY_LIMIT = 2_100_000_000_000_000n;

export const hex = (value) => Buffer.from(value).toString('hex');
export const fromHex = (value) => Uint8Array.from(Buffer.from(value, 'hex'));
export const sha256 = (value) => createHash('sha256').update(value).digest();
export const hash256 = (value) => sha256(sha256(value));
const hash160 = (value) => createHash('ripemd160').update(sha256(value)).digest();
export const scriptHash = (script) => hex(sha256(fromHex(script)).reverse());
export const newId = () => randomBytes(16).toString('hex');
export const explorerUrl = (txid) => networkExplorerUrl(txid);

export function amount(value, minimum = 0n) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Satoshis must be an exact integer.');
  if (!/^\d+$/.test(String(value))) throw new Error('Satoshis must be a nonnegative integer.');
  const result = BigInt(value);
  if (result < minimum || result > MONEY_LIMIT) throw new Error('Satoshi amount is outside the permitted range.');
  return result;
}

export function toBch(value) {
  const satoshis = amount(value);
  return (satoshis / 100000000n) + '.' + String(satoshis % 100000000n).padStart(8, '0');
}

export function toAddress(script, tokenSupport = false) {
  const encoded = lockingBytecodeToCashAddress({ prefix: ADDRESS_PREFIX, bytecode: fromHex(script), tokenSupport });
  if (!encoded.address) throw new Error('Unsupported destination script.');
  return encoded.address;
}

export function decodeAddress(address) {
  // The prefix is required and must be this network's: an address of another network is refused before it is decoded.
  if (typeof address !== 'string' || !address.toLowerCase().startsWith(ADDRESS_PREFIX + ':') || !/^[a-z]+:[a-zA-Z0-9]+$/.test(address)) throw new Error('A prefixed ' + NETWORK_LABEL + ' CashAddr (' + ADDRESS_PREFIX + ':…) is required.');
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string' || decoded.prefix !== ADDRESS_PREFIX) throw new Error('Invalid ' + NETWORK_LABEL + ' CashAddr.');
  const script = hex(decoded.bytecode);
  return { script, address: toAddress(script), tokenSupport: decoded.tokenSupport };
}

export function publicBytes(publicKey) {
  if (typeof publicKey !== 'string' || !/^(02|03)[a-f0-9]{64}$/i.test(publicKey)) throw new Error('A compressed treasury public key is required.');
  const bytes = fromHex(publicKey);
  if (!secp256k1.validatePublicKey(bytes)) throw new Error('Invalid treasury public key.');
  return bytes;
}

function secretBytes(privateKey) {
  if (typeof privateKey !== 'string' || !HEX64.test(privateKey)) throw new Error('Expected a 32-byte local ' + NETWORK_LABEL + ' private key.');
  const bytes = fromHex(privateKey);
  if (!validateSecp256k1PrivateKey(bytes)) throw new Error('Invalid local ' + NETWORK_LABEL + ' key.');
  return bytes;
}

export function walletFromPublicKey(publicKey) {
  const script = '76a914' + hex(hash160(publicBytes(publicKey))) + '88ac';
  return { script, address: toAddress(script), tokenAddress: toAddress(script, true), publicKey: publicKey.toLowerCase(), network: NETWORK };
}

export function walletFromPrivateKey(privateKey) {
  return walletFromPublicKey(hex(secp256k1.derivePublicKeyCompressed(secretBytes(privateKey))));
}

const messageDigest = (challenge) => sha256(Buffer.from('BCH Dominion wallet authentication v1\n' + challenge, 'utf8'));

export function signWalletChallenge(privateKey, challenge) {
  const wallet = walletFromPrivateKey(privateKey);
  return { ...wallet, signature: hex(secp256k1.signMessageHashSchnorr(secretBytes(privateKey), messageDigest(challenge))) };
}

export function verifyWalletProof({ address, publicKey, signature, challenge }) {
  try {
    return typeof challenge === 'string' && challenge.length <= 1000 &&
      typeof signature === 'string' && /^[a-f0-9]{128}$/i.test(signature) &&
      walletFromPublicKey(publicKey).address === decodeAddress(address).address &&
      secp256k1.verifySignatureSchnorr(fromHex(signature), publicBytes(publicKey), messageDigest(challenge));
  } catch {
    return false;
  }
}

export function incomingDestination(id, publicKey) {
  const bytes = publicBytes(publicKey);
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid payment intent identifier.');
  const redeemScript = hex(Buffer.concat([encodeDataPush(fromHex(id)), Buffer.of(0x75), encodeDataPush(bytes), Buffer.of(0xac)]));
  const script = 'a914' + hex(hash160(fromHex(redeemScript))) + '87';
  return { address: toAddress(script), script, redeemScript };
}

export function readTransaction(rawHex, expectedTxid) {
  if (typeof rawHex !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(rawHex) || rawHex.length > 2_000_000) throw new Error('Malformed transaction hex.');
  const bytes = fromHex(rawHex);
  const txid = hashTransaction(bytes);
  if (expectedTxid && txid !== expectedTxid) throw new Error('Transaction data does not hash to the expected TXID.');
  const transaction = decodeTransaction(bytes);
  if (typeof transaction === 'string') throw new Error('Malformed Bitcoin Cash transaction.');
  return { txid, transaction };
}

export function parseHeader(raw) {
  if (typeof raw !== 'string' || !/^[a-f0-9]{160}$/i.test(raw)) throw new Error('Invalid block header from ' + NETWORK_LABEL + ' observer.');
  const header = Buffer.from(raw, 'hex');
  const bits = header.readUInt32LE(72);
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x007fffff);
  // The compact target a header claims. A header is real work only if its own hash does not exceed it.
  const target = bits & 0x00800000 || mantissa === 0n ? 0n : exponent <= 3 ? mantissa >> BigInt(8 * (3 - exponent)) : mantissa << BigInt(8 * (exponent - 3));
  const hash = hex(hash256(header).reverse());
  return { hash, previous: hex(Buffer.from(header.subarray(4, 36)).reverse()), merkleRoot: hex(header.subarray(36, 68)),
    timestamp: header.readUInt32LE(68), bits, meetsTarget: target > 0n && BigInt('0x' + hash) <= target };
}

// Checks that consecutive raw headers each carry their claimed work and link to the one before.
export function verifyHeaderChain(rawHeaders) {
  let previous;
  for (const raw of rawHeaders) {
    const header = parseHeader(raw);
    if (!header.meetsTarget || (previous && header.previous !== previous.hash)) return false;
    previous = header;
  }
  return rawHeaders.length > 0;
}

export function verifyInclusion(txid, proof, header) {
  if (!proof || !Array.isArray(proof.merkle) || proof.merkle.length > 32 ||
      !Number.isSafeInteger(proof.pos) || proof.pos < 0) return false;
  let position = proof.pos;
  let digest = fromHex(txid).reverse();
  for (const sibling of proof.merkle) {
    if (!HEX64.test(sibling)) return false;
    const hash = fromHex(sibling).reverse();
    digest = hash256(Buffer.concat(position % 2 === 0 ? [digest, hash] : [hash, digest]));
    position = Math.floor(position / 2);
  }
  return position === 0 && header.merkleRoot === hex(digest);
}

export function normalizeSource(source) {
  if (!source || typeof source.txid !== 'string' || !HEX64.test(source.txid) ||
      !Number.isInteger(source.vout) || source.vout < 0 || source.vout > 0xffffffff) {
    throw new Error('Invalid payout outpoint.');
  }
  return { ...source, txid: source.txid.toLowerCase(), satoshis: Number(amount(source.satoshis, DUST)) };
}

export function signSpend({ sources, outputs, privateKey, requireUtxos = false }) {
  const secret = secretBytes(privateKey);
  const { script: keyScript, publicKey } = walletFromPrivateKey(privateKey);
  const sourceOutputs = sources.map((source) => ({
    lockingBytecode: fromHex(source.script ?? keyScript),
    valueSatoshis: amount(source.satoshis, DUST), token: source.token,
  }));
  const transaction = {
    version: 2,
    locktime: 0,
    inputs: sources.map((source) => ({
      outpointTransactionHash: fromHex(source.txid),
      outpointIndex: source.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array(),
    })),
    outputs: outputs.map(({ script, satoshis, token }) => ({
      lockingBytecode: fromHex(script), valueSatoshis: amount(satoshis, script.startsWith('6a') && !token ? 0n : DUST), token,
    })),
  };
  const type = Uint8Array.of(requireUtxos || sources.some((source) => source.token) ? 0x61 : 0x41);
  transaction.inputs.forEach((input, inputIndex) => {
    const redeem = sources[inputIndex].redeemScript;
    if (sources[inputIndex].unlocking !== undefined) {
      // A keyless covenant input carries only its lane selector and redeem script.
      input.unlockingBytecode = Buffer.concat([fromHex(sources[inputIndex].unlocking), encodeDataPush(fromHex(redeem))]);
      return;
    }
    const serialization = generateSigningSerializationBCH({ inputIndex, sourceOutputs, transaction }, {
      coveredBytecode: redeem ? fromHex(redeem) : sourceOutputs[inputIndex].lockingBytecode,
      signingSerializationType: type,
    });
    const signed = secp256k1.signMessageHashSchnorr(secret, hash256(serialization));
    if (typeof signed === 'string') throw new Error('' + NETWORK_LABEL + ' transaction signing failed.');
    input.unlockingBytecode = Buffer.concat([
      encodeDataPush(Buffer.concat([signed, type])),
      encodeDataPush(fromHex(redeem ?? publicKey)),
    ]);
  });
  const raw = encodeTransaction(transaction);
  const fee = sources.reduce((total, source) => total + amount(source.satoshis), 0n) -
    outputs.reduce((total, output) => total + amount(output.satoshis), 0n);
  if (fee < BigInt(raw.length)) throw new Error('Signed payout would violate the configured minimum fee rate.');
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis: Number(fee) };
}
