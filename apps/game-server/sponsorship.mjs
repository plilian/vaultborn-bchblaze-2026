const pendingStates = new Set(['created','awaiting_signature','submitted','seen_in_mempool','confirming','confirmed','uncertain']);
const funding = () => ({ total: 0, development: 0, prize: 0, count: 0 });

export function summarizeSponsorship(records, now) {
  const confirmed = { ...funding(), legacyPrize: 0, externalDevelopment: 0 };
  const pending = { ...funding(), observedCount: 0 };
  for (const row of records) {
    if (row.action !== 'sponsor-fund' || row.direction === 'outgoing') continue;
    const credited = row.state === 'credited' && row.receipt;
    if (!credited && (!pendingStates.has(row.state) || !row.txid && row.expiresAt <= now)) continue;
    const totals = credited ? confirmed : pending;
    const outputs = credited ? row.receipt.allocations : row.outputs;
    const development = outputs?.find(output => output.role === 'development');
    const prize = outputs?.find(output => output.role === 'prize');
    totals.total += row.satoshis;
    totals.count++;
    totals.development += development?.satoshis ?? 0;
    const legacyPrize = !prize ? outputs?.find(output => output.role === 'funding')?.satoshis ?? row.satoshis : 0;
    totals.prize += prize?.satoshis ?? legacyPrize;
    if (credited) {
      confirmed.legacyPrize += legacyPrize;
      if (development?.custody === 'external') confirmed.externalDevelopment += development.satoshis;
    } else if (row.receipt?.txid) {
      pending.observedCount++;
    }
  }
  return { confirmed, pending };
}
