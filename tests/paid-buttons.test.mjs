// A paid order shows that it is paid while its payment is on its way, instead of offering the payment again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmationText, paidFor, pay, setPaymentsInFlight } from '../apps/web/view.js';

const claim = { type:'territory-claim', territory:'mine' };
const sent = (state, confirmations, extra = {}) => ({ id:'pay-1', action:'territory-claim', state, direction:'incoming', minConfirmations:2,
  payload:{ ...claim }, receipt:{ confirmations }, ...extra });

test('a claim that was paid shows its confirmation instead of the pay button; other sites and settled payments do not', () => {
  setPaymentsInFlight([]);
  assert.match(pay('Open claim · 6,000 sats', 'flag', claim, 'primary'), /data-pay=/);
  setPaymentsInFlight([sent('seen_in_mempool', 0)]);
  const shown = pay('Open claim · 6,000 sats', 'flag', claim, 'primary');
  assert.doesNotMatch(shown, /data-pay=/);
  assert.match(shown, /Paid · 0 of 2 confirmations · about 20 more minutes/);
  assert.match(shown, /data-modal="payment"/);
  assert.match(pay('Open claim', 'flag', { type:'territory-claim', territory:'quarry' }), /data-pay=/, 'another site is not paid');
  setPaymentsInFlight([sent('confirming', 1)]);
  assert.match(pay('Open claim', 'flag', claim), /1 of 2 confirmations · about 10 more minutes/);
  setPaymentsInFlight([sent('confirmed', 2)]);
  assert.match(pay('Open claim', 'flag', claim), /Confirmed · being applied/);
  for (const state of ['credited', 'expired', 'rejected', 'awaiting_signature', 'created']) {
    setPaymentsInFlight([sent(state, 2)]);
    assert.match(pay('Open claim', 'flag', claim), /data-pay=/, state);
  }
  // Deposits can be repeated: their button stays.
  setPaymentsInFlight([{ ...sent('seen_in_mempool', 0), action:'war-chest', payload:{ type:'war-chest', satoshis:10_000, consent:true } }]);
  assert.equal(paidFor({ type:'war-chest', satoshis:10_000, consent:true }), null);
  setPaymentsInFlight([]);
});

test('the waiting time follows the confirmations still needed', () => {
  assert.equal(confirmationText({ state:'seen_in_mempool', minConfirmations:2, receipt:{ confirmations:0 } }), '0 of 2 confirmations · about 20 more minutes');
  assert.equal(confirmationText({ state:'confirming', minConfirmations:3, confirmations:1 }), '1 of 3 confirmations · about 20 more minutes');
  assert.equal(confirmationText({ state:'confirming', minConfirmations:2, receipt:{ confirmations:5 } }), 'Confirmed · being applied');
});
