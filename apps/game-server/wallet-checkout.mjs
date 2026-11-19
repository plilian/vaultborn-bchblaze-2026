import { createVirtualMachineBCH, encodeTransaction } from '@bitauth/libauth';
import { fromHex, hex, readTransaction, walletFromPublicKey } from '../../packages/chain-observer/primitives.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';

const eligible = new Set(['created','awaiting_signature','rejected']);
const planTtl = 5 * 60_000;
const fingerprint = transaction => hex(encodeTransaction({
  ...transaction, inputs: transaction.inputs.map(input => ({ ...input, unlockingBytecode: new Uint8Array() })),
}));

export function createWalletCheckout({ store, chain, ledger, clock, notify, fail }) {
  function identify(player, id) {
    const row = store.payment(id);
    if (!row || row.playerId !== player || row.direction !== 'incoming') fail(404, 'This wallet payment is unavailable.');
    return row;
  }

  function spendable(player, id) {
    const row = identify(player, id);
    if (!eligible.has(row.state) || row.expiresAt <= clock()) fail(409, 'This checkout is no longer accepting signatures.');
    if (ledger.balances(player).quarantined) fail(409, 'Wallet checkout is paused for chain reconciliation.');
    return row;
  }

  function candidates(body) {
    if (!Array.isArray(body.keys) || !body.keys.length || body.keys.length > 12) fail(400, 'Choose a wallet address to fund this transaction.');
    const keys = [];
    for (const key of body.keys) {
      if (!key || !['receive','change'].includes(key.path) || !Number.isSafeInteger(key.index) || key.index < 0 || key.index > 100_000) {
        fail(400, 'The wallet returned an invalid derivation path.');
      }
      try {
        const wallet = walletFromPublicKey(key.publicKey);
        if (!keys.some(item => item.script === wallet.script)) keys.push({ ...wallet, path: key.path, index: key.index });
      } catch { fail(400, 'The wallet returned an invalid public key.'); }
    }
    return keys;
  }

  async function prepare(player, id, body) {
    if (!chain.enabled) fail(503, 'The ' + NETWORK_LABEL + ' checkout is offline.');
    const intent = spendable(player, id);
    const keys = candidates(body);
    const outputs = intent.outputs?.map(({script,satoshis}) => ({script,satoshis})) ?? [{ script:intent.script, satoshis:intent.satoshis }];
    let funds;
    try { funds = await chain.walletCoins(keys); }
    catch { fail(503, 'Wallet funds could not be indexed on ' + NETWORK_LABEL + '. Check the connection and retry.'); }
    return store.transaction(() => {
      const current = spendable(player, id);
      const occupied = new Set(store.payments(player).filter(other => other.id !== id && other.walletPlan &&
        (other.rawHex || other.walletPlan.expiresAt > clock())).flatMap(other => other.walletPlan.sources.map(coin => coin.txid + ':' + coin.vout)));
      const sources = [];
      let sum = 0;
      let feeSatoshis;
      const estimated = 75 + outputs.reduce((bytes, output) => bytes + 9 + output.script.length / 2, 0);
      for (const coin of funds.filter(coin => !occupied.has(coin.txid + ':' + coin.vout)).slice(0, 8)) {
        sources.push(coin);
        sum += coin.satoshis;
        feeSatoshis = estimated + sources.length * 145;
        if (sum >= intent.satoshis + feeSatoshis) break;
      }
      if (!sources.length || sum < intent.satoshis + feeSatoshis) fail(409, 'This wallet has insufficient confirmed ' + NETWORK_LABEL + ' BCH at the scanned addresses.');
      const unsignedChange = sum - intent.satoshis - feeSatoshis;
      const change = keys.find(key => key.path === 'change') ?? sources[0];
      const paymentOutputs = [...outputs];
      if (unsignedChange >= 546) paymentOutputs.push({ script: change.script, satoshis: unsignedChange });
      else feeSatoshis += unsignedChange;
      const tx = {
        version: 2, locktime: 0,
        inputs: sources.map(({ txid, vout }) => ({ outpointTransactionHash:fromHex(txid), outpointIndex:vout,
          sequenceNumber:0xffffffff, unlockingBytecode:new Uint8Array() })),
        outputs: paymentOutputs.map(({ script,satoshis }) => ({ lockingBytecode:fromHex(script), valueSatoshis:BigInt(satoshis) })),
      };
      const transaction = fingerprint(tx);
      const plan = { transaction, sources, feeSatoshis, expiresAt:clock() + planTtl };
      store.savePayment({ ...current, walletPlan:plan });
      return { transaction, feeSatoshis,
        sourceOutputs:sources.map(({ script,satoshis,txid,vout }) => ({ lockingBytecode:script, valueSatoshis:`<bigint: ${satoshis}n>`,
          outpointTransactionHash:txid, outpointIndex:vout, unlockingBytecode:'', sequenceNumber:0xffffffff })),
        inputPaths:sources.map(({path,index}, input) => [input,path,index]),
        userPrompt: 'VAULTBORN ' + NETWORK_LABEL + ' · ' + current.title + ' · ' + current.satoshis + ' sats plus ' + feeSatoshis + ' fee',
      };
    });
  }

  async function broadcast(player, id, raw) {
    if (typeof raw !== 'string' || raw.length > 14_000) fail(400, 'The wallet returned an invalid signed transaction.');
    let decoded;
    try { decoded = readTransaction(raw); } catch { fail(400, 'The wallet returned an invalid signed transaction.'); }
    const { txid, transaction } = decoded;
    const signed = store.transaction(() => {
      const existing = identify(player, id);
      if (existing.rawHex && existing.txid === txid) return existing;
      const intent = spendable(player, id);
      const plan = intent.walletPlan;
      if (!plan || plan.expiresAt <= clock() || plan.transaction !== fingerprint(transaction)) {
        fail(409, 'The signed transaction does not match the current payment review.');
      }
      const sourceOutputs = plan.sources.map(({ script,satoshis }) => ({ lockingBytecode:fromHex(script), valueSatoshis:BigInt(satoshis) }));
      const verify = createVirtualMachineBCH().verify({ transaction, sourceOutputs });
      // Only accept a complete all-inputs, all-outputs wallet signature.
      const allInputs = transaction.inputs.every(({unlockingBytecode: data}) => data.length > 65 && data[0] >= 65 && data[0] <= 73 && data[data[0]] === 0x61);
      if (verify !== true || !allInputs) fail(400, 'Use a wallet that signs every reviewed input and output with WizardConnect.');
      if (store.byTxid(txid)) fail(409, 'This signed transaction already belongs to another checkout.');
      if (!store.wallet(player)) {
        const source = plan.sources[0];
        if (!store.bindWallet(player, source.address, source.publicKey, clock())) fail(409, 'This wallet already belongs to another kingdom.');
      }
      const row = { ...chain.submit(intent, txid, clock()), rawHex:raw.toLowerCase(), walletSigned:true };
      store.savePayment(row);
      return row;
    });
    if (eligible.has(signed.state) || ['submitted','uncertain'].includes(signed.state)) {
      await chain.broadcast(signed.rawHex).catch(() => undefined);
    }
    notify();
    return ledger.list(player).find(item => item.id === id);
  }

  return { prepare, broadcast };
}
