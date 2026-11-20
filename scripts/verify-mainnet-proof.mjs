// Checks the proof of VaultBorn's Bitcoin Cash Mainnet transactions (docs/mainnet/), offline, from the repository alone:
//   1. each raw transaction hashes to its TXID;
//   2. its Merkle branch leads to the Merkle root of its block header, the header hashes to the named block, and the
//      header carries the proof of work its target claims;
//   3. the launch record's data output is "VBLN" + version + SHA-256 of docs/mainnet/launch-manifest.json;
//   4. the War Chest deposit pays exactly the war-chest-v4 contract this repository builds for the manifest's game key,
//      its attestors and threshold, and the depositor's own public key (read from the transaction's input);
//   5. the game payments carry a VaultBorn event record ("VBRN");
//   6. the claim's settlement spends the claim's escrow output, its unlocking script reveals exactly that escrow contract
//      (hash256 of the script = the P2SH32 hash of the claim's output) with the manifest's three attestor keys, carries two
//      attestor signatures, and pays 6,000 sat to the wallet fixed in the contract, the 600 sat reserve being the fee.
// That a block is part of the main chain is checked by opening the explorer link, or any Bitcoin Cash node.
// Usage: node scripts/verify-mainnet-proof.mjs [folder with transactions.json and launch-manifest.json]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { decodeAuthenticationInstructions, decodeTransaction, lockingBytecodeToCashAddress } from '@bitauth/libauth';

process.env.VAULTBORN_NETWORK = 'mainnet';
const { kingdomVault } = await import('../packages/chain-observer/kingdom-vault.mjs');
const { CHEST_EXIT_BLOCKS } = await import('../config/payments.mjs');

const root = process.argv[2] ? pathToFileURL(resolve(process.argv[2]) + '/') : new URL('../docs/mainnet/', import.meta.url);
const proof = JSON.parse(readFileSync(new URL('transactions.json', root), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('launch-manifest.json', root), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest();
const hash256 = bytes => sha256(sha256(bytes));
const hex = bytes => Buffer.from(bytes).toString('hex');
const reversed = value => Buffer.from(value, 'hex').reverse();
const address = script => lockingBytecodeToCashAddress({ prefix: 'bitcoincash', bytecode: Buffer.from(script, 'hex') }).address;
let failures = 0;
const check = (ok, text) => { console.log((ok ? 'ok    ' : 'FAIL  ') + text); if (!ok) failures++; };

const manifestHash = hex(sha256(Buffer.from(JSON.stringify(manifest))));
console.log('Launch manifest SHA-256: ' + manifestHash + '\n');
const decodedByName = {};

for (const tx of proof.transactions) {
  console.log(tx.title + ' — ' + tx.txid);
  const raw = Buffer.from(tx.rawHex, 'hex');
  check(hex(hash256(raw).reverse()) === tx.txid, 'the raw transaction hashes to its TXID');
  // Merkle branch: hash upwards, left or right by the bits of the position.
  let node = reversed(tx.txid);
  tx.merkleBranch.forEach((sibling, level) => {
    const other = reversed(sibling);
    node = hash256((tx.position >> level) & 1 ? Buffer.concat([other, node]) : Buffer.concat([node, other]));
  });
  const header = Buffer.from(tx.blockHeader, 'hex');
  check(header.length === 80 && node.equals(header.subarray(36, 68)), 'its Merkle branch leads to the Merkle root of block ' + tx.blockHeight);
  const blockHash = hex(hash256(header).reverse());
  check(blockHash === tx.blockHash, 'the block header hashes to ' + tx.blockHash);
  const bits = header.readUInt32LE(72);
  const target = BigInt(bits & 0x007fffff) << BigInt(8 * ((bits >>> 24) - 3));
  check(BigInt('0x' + blockHash) <= target, 'the header carries the proof of work its target claims');
  const decoded = decodeTransaction(raw);
  const outputs = decoded.outputs.map(output => ({ script: hex(output.lockingBytecode), satoshis: Number(output.valueSatoshis) }));
  const records = outputs.filter(output => output.script.startsWith('6a'));
  if (tx.name === 'launch') {
    check(records[0]?.script === '6a0456424c4e02010020' + manifestHash, 'the data output is VBLN v1.0 with the SHA-256 of the launch manifest');
  } else {
    check(records.some(output => output.script.startsWith('6a045642524e') && output.satoshis === 0), 'it carries a VaultBorn event record (VBRN)');
  }
  if (tx.name === 'chest') {
    // The depositor's public key is the last push of the P2PKH unlocking script of the input.
    const unlocking = decoded.inputs[0].unlockingBytecode;
    const ownerKey = hex(unlocking.subarray(unlocking.length - 33));
    const chest = kingdomVault({ operatorKey: manifest.gamePublicKey, ownerKey, attestors: manifest.attestors, threshold: manifest.attestorThreshold,
      exitDelay: CHEST_EXIT_BLOCKS, revision: 4 });
    check(outputs[0].script === chest.script && outputs[0].satoshis === 10_000,
      '10,000 sat to the war-chest-v4 contract of the depositor (' + address(chest.script) + ')');
  }
  if (tx.name === 'claim') {
    check(/^aa20[0-9a-f]{64}87$/.test(outputs[0].script) && outputs[0].satoshis === 6_600, '6,600 sat to a P2SH32 contract (' + address(outputs[0].script) + ')');
  }
  if (tx.name === 'settle') {
    const claim = decodedByName.claim;
    const input = decoded.inputs[0];
    check(decoded.inputs.length === 1 && claim && hex(Buffer.from(input.outpointTransactionHash)) === claim.txid && input.outpointIndex === 0,
      'it spends output 0 of the territory claim (the stake escrow)');
    const pushes = decodeAuthenticationInstructions(input.unlockingBytecode);
    const redeem = Buffer.from(pushes.at(-1)?.data ?? []);
    const escrow = claim?.outputs[0];
    check(escrow && escrow.script === 'aa20' + hex(hash256(redeem)) + '87' && manifest.attestors.every(key => hex(redeem).includes('21' + key)),
      'its unlocking script reveals that escrow contract, which names the three attestor keys of the launch manifest');
    check(pushes.slice(0, -1).filter(push => push.data?.length === 65).length === 2, 'it carries two attestor signatures (2 of 3)');
    const fee = (escrow?.satoshis ?? 0) - outputs.reduce((sum, output) => sum + output.satoshis, 0);
    check(outputs[0].satoshis === 6_000 && /^76a914[0-9a-f]{40}88ac$/.test(outputs[0].script) && hex(redeem).includes(outputs[0].script) && fee === 600,
      '6,000 sat back to the claimant\'s wallet fixed in the contract (' + address(outputs[0].script) + '); the 600 sat reserve is the fee');
  }
  decodedByName[tx.name] = { txid: tx.txid, outputs };
  console.log('      ' + tx.explorer + '\n');
}
console.log(failures ? failures + ' check(s) failed.' : 'All checks passed.');
process.exit(failures ? 1 : 0);
