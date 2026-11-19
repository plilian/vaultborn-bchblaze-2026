import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLedger } from '../../apps/game-server/ledger.mjs';
import { openStore } from '../../apps/game-server/store.mjs';

function fixture(t, observe) {
  const store = openStore(':memory:', { archive: [] });
  t.after(() => store.close());
  const ledger = createLedger({
    store,
    chain: { enabled: true, observe },
    clock: () => 1000,
    notify() {},
  });
  return { store, ledger };
}

test('the reconciler promotes an outgoing Chipnet payout after its first confirmation', async (t) => {
  const confirmed = (row) => ({ ...row, state:'confirmed', receipt:{ ...row.receipt, confirmations:2 } });
  const { store, ledger } = fixture(t, confirmed);
  store.savePayment({ id:'withdrawal', playerId:'p1', direction:'outgoing', action:'withdraw', state:'confirming',
    txid:'7'.repeat(64), receipt:{ confirmations:1 } });
  await ledger.reconcile();
  assert.equal(store.payment('withdrawal').state, 'credited');
  assert.equal(store.payment('withdrawal').receipt.confirmations, 2);
});

test('automatic discovery can settle a multi-output transaction against one intent only', async (t) => {
  const sharedTxid = '8'.repeat(64);
  const confirm = (row) => ({ ...row, state:'confirmed', txid:sharedTxid, receipt:{confirmations:2} });
  const { store, ledger } = fixture(t, confirm);
  for (const id of ['incoming-a','incoming-b']) {
    store.savePayment({ id, playerId:'p1', direction:'incoming', pool:'personal', action:'vault-deposit',
      address:id, satoshis:1000, state:'awaiting_signature' });
  }
  await ledger.reconcile();
  const result = store.payments();
  assert.deepEqual(result.map(row=>row.state).sort(), ['credited','rejected']);
  assert.equal(result.filter(row=>row.txid===sharedTxid).length,1);
});
