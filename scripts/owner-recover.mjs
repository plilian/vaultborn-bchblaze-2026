// Owner-only recovery of money held for you by a VaultBorn covenant, after its recovery date. It needs no game server and
// no game key: only the public terms of the output (saved from GET /api/payments or the public ledger) and your own key.
//   OWNER_KEY_FILE=<hex key file> node scripts/owner-recover.mjs <output.json> <destination address of this network> [--broadcast]
// The network is the one of VAULTBORN_NETWORK (chipnet by default, mainnet for real BCH); an address of the other network is refused.
// <output.json> is one output object with txid, vout, satoshis, script and its terms: "kv" (kingdom vault or war chest),
// "cf" (a War Chest share still waiting in its feeder) or "escrow" (raid stake). Without --broadcast it prints the signed
// transaction for review.
// A current War Chest output leaves in two steps. Run the tool once to move it into its exit script (any time, your key
// alone). It prints the exit output; save that as a new <output.json> and run the tool again once it is 288 blocks old.
// Step one of a matched-stakes War Chest (revision 4) moves the WHOLE output, so its network fee comes from an ordinary
// output of your own wallet: add `--fee <fee-output.json>` with that output's { "txid", "vout", "satoshis" } (about 800
// satoshis are needed; the rest returns to your wallet).
// A raid or territory stake ("escrow") returns to your wallet by its own refund lane once its refund time has passed.
// The proof-record reserve of a political operation ("rr") whose record was never published returns to your wallet once
// it is 2,016 blocks old; it also needs `--fee <fee-output.json>`, because 576 satoshis cannot carry a fee on their own.
// A waiting share needs no key at all: once it has waited its period (13,104 blocks, about three months) the tool moves it into your War Chest.
import { readFile } from 'node:fs/promises';
import { secp256k1 } from '@bitauth/libauth';
import { createChain, decodeAddress } from '../packages/chain-observer/index.mjs';
import { fromHex, hex } from '../packages/chain-observer/primitives.mjs';
import { signChestExit, signKingdomRecovery } from '../packages/chain-observer/kingdom-vault.mjs';
import { buildChestFeed } from '../packages/chain-observer/chest-feeder.mjs';
import { completeTreasurySpend, planTreasurySpend, treasurySigningHash } from '../packages/chain-observer/treasury-covenants.mjs';
import { signStakeRefund } from '../packages/chain-observer/stake-escrow.mjs';
import { signRaidRefund } from '../packages/chain-observer/matched-raid.mjs';
import { signRecordRecovery } from '../packages/chain-observer/record-reserve.mjs';
import { NETWORK_ID } from '../config/network.mjs';

const args = process.argv.slice(2);
const feeFile = args.includes('--fee') ? args[args.indexOf('--fee') + 1] : null;
const [file, destination] = args.filter((item, index) => !item.startsWith('--') && args[index - 1] !== '--fee');
const flag = args.includes('--broadcast') ? '--broadcast' : undefined;
const output = JSON.parse(await readFile(file ?? '', 'utf8'));
if (!destination || (!output.cf && !process.env.OWNER_KEY_FILE)) throw new Error('Supply the output JSON, a destination address and OWNER_KEY_FILE.');
if (output.network && output.network !== NETWORK_ID) throw new Error('This output belongs to ' + output.network + ', but this tool is running for ' + NETWORK_ID + '. Set VAULTBORN_NETWORK.');
const privateKey = output.cf ? null : (await readFile(process.env.OWNER_KEY_FILE, 'utf8')).trim();
const target = decodeAddress(destination);
let signed;
if (output.cf) {
  // Keyless: the share can only become an output of its owner's War Chest.
  signed = buildChestFeed([output], { aged: true });
} else if (output.kv?.revision === 4 && !output.kv.exiting) {
  if (!feeFile) throw new Error('Step one of this exit keeps the whole War Chest output. Name an ordinary output of your own wallet for the network fee: --fee <fee-output.json>.');
  const exit = signChestExit([output], privateKey, { fee: JSON.parse(await readFile(feeFile, 'utf8')) });
  signed = { ...exit, next: { ...exit.exits[0], txid: exit.txid }, note: 'Step one. Save "next" as the output file and run again when it is ' + output.kv.exitDelay + ' blocks old.' };
} else if (output.kv?.revision === 3 && !output.kv.exiting) {
  const exit = signChestExit([output], privateKey);
  signed = { ...exit, next: { ...exit.exits[0], txid: exit.txid }, note: 'Step one. Save "next" as the output file and run again when it is ' + output.kv.exitDelay + ' blocks old.' };
} else if (output.kv) {
  signed = signKingdomRecovery([output], privateKey, [{ script: target.script, satoshis: output.satoshis - 700 }]);
} else if (output.escrow?.version === 4) {
  // A matched raid stake: after its refund time the attacker's key alone takes it back, less the settlement fee.
  signed = signRaidRefund(output, privateKey);
} else if (output.escrow?.version === 3) {
  signed = signStakeRefund(output, privateKey);
} else if (output.escrow) {
  // The escrow refund lane pays its owner's own wallet; the destination argument is not used by the script.
  const plan = planTreasurySpend(output.escrow, output, { lane: 'refund' });
  signed = completeTreasurySpend(plan, plan.contract.refundKey ? [hex(secp256k1.signMessageHashSchnorr(fromHex(privateKey), treasurySigningHash(plan)))] : []);
} else if (output.rr) {
  if (!feeFile) throw new Error('A record reserve needs an ordinary output of your own wallet for the network fee: --fee <fee-output.json>.');
  signed = signRecordRecovery(output, privateKey, { fee: JSON.parse(await readFile(feeFile, 'utf8')) });
} else throw new Error('This output carries no kingdom vault, feeder, stake escrow or record reserve terms.');
if (flag === '--broadcast') await createChain().broadcast(signed.rawHex);
console.log(JSON.stringify({ ...signed, network: NETWORK_ID, broadcast: flag === '--broadcast' }, null, 2));
