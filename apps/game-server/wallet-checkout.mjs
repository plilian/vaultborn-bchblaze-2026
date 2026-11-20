import { createVirtualMachineBCH, encodeTransaction } from '@bitauth/libauth';
import { fromHex, hex, readTransaction, walletFromPublicKey } from '../../packages/chain-observer/primitives.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';

const eligible = new Set(['created','awaiting_signature','rejected']);
const planTtl = 5 * 60_000;
// A signed payment keeps its coins for this long. A coin it holds that is still unspent after that never reached the
// network (a transaction in the mempool already removes its coins from the wallet's unspent list), so it is free again.
const signedHold = 10 * 60_000;
// The same addresses the wallet balance reads, and enough coins for a wallet that holds many small ones.
const MOST_KEYS = 48;
const MOST_INPUTS = 20;
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
    if (!Array.isArray(body.keys) || !body.keys.length || body.keys.length > MOST_KEYS) fail(400, 'Choose a wallet address to fund this transaction.');
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
    try { funds = await chain.walletCoins(keys, { unconfirmed: true }); }
    catch { fail(503, 'Wallet funds could not be indexed on ' + NETWORK_LABEL + '. Check the connection and retry.'); }
    return store.transaction(() => {
      const current = spendable(player, id);
      const now = clock();
      const coinId = coin => coin.txid + ':' + coin.vout;
      // Only a payment already signed in the wallet, and only for a while, holds coins. A checkout that was opened and
      // left unsigned holds nothing; its review is withdrawn below when this one takes the same coins.
      const others = store.payments(player).filter(other => other.id !== id && other.walletPlan);
      const occupied = new Set(others.filter(other => other.rawHex && (other.submittedAt ?? 0) > now - signedHold)
        .flatMap(other => other.walletPlan.sources.map(coinId)));
      const free = funds.filter(coin => !occupied.has(coinId(coin)));
      const sources = [];
      let sum = 0;
      let feeSatoshis;
      const estimated = 75 + outputs.reduce((bytes, output) => bytes + 9 + output.script.length / 2, 0);
      for (const coin of free.slice(0, MOST_INPUTS)) {
        sources.push(coin);
        sum += coin.satoshis;
        feeSatoshis = estimated + sources.length * 145;
        if (sum >= intent.satoshis + feeSatoshis) break;
      }
      if (!sources.length || sum < intent.satoshis + feeSatoshis) {
        const needed = intent.satoshis + (feeSatoshis ?? estimated + 145);
        const total = free.reduce((all, coin) => all + coin.satoshis, 0);
        if (free.length > MOST_INPUTS && total >= needed) fail(409, 'This wallet holds its BCH in too many small amounts for one payment. Send it to yourself once in the wallet to combine it, then try again.');
        if (occupied.size && funds.reduce((all, coin) => all + coin.satoshis, 0) >= needed) fail(409, 'Part of this wallet\'s BCH is in a payment you signed a moment ago. Try again in a few minutes.');
        fail(409, 'This wallet does not have enough ' + NETWORK_LABEL + ' BCH for this payment: ' + total.toLocaleString('en-US') + ' sat available, ' + needed.toLocaleString('en-US') + ' sat needed including the network fee.');
      }
      const taken = new Set(sources.map(coinId));
      for (const other of others) if (!other.rawHex && other.walletPlan.sources.some(coin => taken.has(coinId(coin)))) {
        const { walletPlan, ...withdrawn } = other;
        store.savePayment(withdrawn);
      }
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
      // A signed payment whose coins another payment has taken since can never confirm.
      const spent = new Set(store.payments(player).filter(other => other.id !== id && other.rawHex && other.walletPlan &&
        (other.submittedAt ?? 0) > clock() - signedHold)
        .flatMap(other => other.walletPlan.sources.map(coin => coin.txid + ':' + coin.vout)));
      if (plan.sources.some(coin => spent.has(coin.txid + ':' + coin.vout))) fail(409, 'These coins were used by another payment. Open the payment again.');
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
