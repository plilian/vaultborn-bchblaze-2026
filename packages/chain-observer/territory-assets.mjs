import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createElectrumTransport } from './transports.mjs';
import { explorerUrl, hex, HEX64, walletFromPrivateKey, walletFromPublicKey } from './primitives.mjs';
import {
  buildTerritoryIssue, knownTerritoryBaton, normalizeTerritoryEvent, publicTerritoryAsset,
  traceTerritoryCollectible, validateTerritoryIssue,
} from './territory-token.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';
import { ADDRESS_PATTERN, NETWORK_ID } from '../../config/network.mjs';

function openJournal(database) {
  if (database !== ':memory:') mkdirSync(dirname(database), { recursive:true });
  const db = new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS authority (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, territory TEXT NOT NULL, status TEXT NOT NULL, txid TEXT UNIQUE, body TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS assets_territory ON assets (territory);'
  );
  const getAsset = db.prepare('SELECT body FROM assets WHERE id = ?');
  const getAuthority = db.prepare('SELECT body FROM authority WHERE id = 1');
  const saveAsset = db.prepare(
    'INSERT INTO assets VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, txid=excluded.txid, body=excluded.body'
  );
  return {
    close: () => db.close(),
    transaction(operation) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    authority() {
      const row = getAuthority.get();
      return row ? JSON.parse(row.body) : null;
    },
    saveAuthority(record) {
      db.prepare('INSERT INTO authority VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(record));
    },
    get(id) {
      const row = getAsset.get(id);
      return row ? JSON.parse(row.body) : null;
    },
    list(territory) {
      const hits = territory
        ? db.prepare('SELECT body FROM assets WHERE territory = ? ORDER BY rowid ASC').all(territory)
        : db.prepare('SELECT body FROM assets ORDER BY rowid ASC').all();
      return hits.map(row => JSON.parse(row.body));
    },
    active() {
      const row = db.prepare("SELECT body FROM assets WHERE status IN ('signed','submitted','confirming') ORDER BY rowid ASC LIMIT 1").get();
      return row ? JSON.parse(row.body) : null;
    },
    save(record) {
      saveAsset.run(record.event.id, record.event.territoryId, record.state, record.plan?.txid ?? null, JSON.stringify(record));
    },
  };
}

function sameEvent(oldEvent, newEvent) {
  const omitRecipient = ({holderAddress,recipientScript,...rest}) => JSON.stringify(rest);
  return omitRecipient(oldEvent) === omitRecipient(newEvent);
}

async function operatorSources(client, operator, minConfirmations, baton) {
  const candidates = (await client.listUnspent(operator.script, 'exclude_tokens'))
    .filter(coin => coin.height > 0 && client.tip - coin.height + 1 >= minConfirmations && coin.txid !== baton.txid)
    .sort((a,b) => b.satoshis - a.satoshis).slice(0, 8);
  const verified = await Promise.all(candidates.map(async coin => {
    const previous = await client.lookup(coin.txid, coin.height);
    const output = previous?.transaction.outputs[coin.vout];
    const coinbase = previous?.transaction.inputs.some(input => /^0+$/.test(hex(input.outpointTransactionHash)));
    return output && !output.token && output.valueSatoshis === BigInt(coin.satoshis) &&
      hex(output.lockingBytecode) === operator.script && (!coinbase || previous.confirmations >= 101)
      ? { ...coin, script:operator.script }
      : null;
  }));
  return verified.filter(Boolean);
}

export function createTerritoryAssets({
  database = 'var/territory-assets.sqlite', operatorPrivateKey, operatorPublicKey, category, genesisTxid,
  electrumHost, minConfirmations = 2, transport, clock = Date.now,
} = {}) {
  if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 144) {
    throw new Error('Invalid territory CashTokens confirmation threshold.');
  }
  const privateOperator = operatorPrivateKey ? walletFromPrivateKey(operatorPrivateKey) : null;
  const publicOperator = operatorPublicKey ? walletFromPublicKey(operatorPublicKey) : null;
  if (privateOperator && publicOperator && privateOperator.publicKey !== publicOperator.publicKey) {
    throw new Error('Territory issuer public and private keys do not match.');
  }
  const operator = publicOperator ?? privateOperator;
  if ((category && !HEX64.test(category)) || (genesisTxid && !HEX64.test(genesisTxid))) {
    throw new Error('Territory issuer needs 64-character ' + NETWORK_LABEL + ' category and genesis transaction IDs.');
  }
  category = category?.toLowerCase();
  genesisTxid = genesisTxid?.toLowerCase();
  const enabled = Boolean(operator && category && genesisTxid);
  const signingEnabled = Boolean(enabled && privateOperator);
  const provider = transport ?? createElectrumTransport(electrumHost);
  const journal = openJournal(database);
  try {
    journal.transaction(() => {
      const prior = journal.authority();
      if (!enabled) return;
      if (prior && (prior.category !== category || prior.genesisTxid !== genesisTxid || prior.publicKey !== operator.publicKey)) {
        throw new Error('The territory journal belongs to a different ' + NETWORK_LABEL + ' category or issuer.');
      }
      if (!prior) journal.saveAuthority({ category, genesisTxid, publicKey:operator.publicKey, headTxid:genesisTxid });
    });
  } catch (error) {
    journal.close();
    throw error;
  }
  let busy;
  let closing = false;

  function enqueue(input) {
    if (closing) throw new Error('The territory issuer is shutting down.');
    const event = normalizeTerritoryEvent(input);
    return journal.transaction(() => {
      const existing = journal.get(event.id);
      if (existing) {
        if (event.kind === 'deed' && existing.event.eventId !== event.eventId) return publicTerritoryAsset(existing);
        if (!sameEvent(existing.event, event)) throw new Error('The territory evidence ID is already in use by a different event.');
        if (existing.state === 'waiting-wallet' && event.holderAddress) {
          const ready = { ...existing, event, state:'queued', lastError:null };
          journal.save(ready);
          return publicTerritoryAsset(ready);
        }
        return publicTerritoryAsset(existing);
      }
      const state = event.anchorOnly || event.holderAddress ? 'queued' : 'waiting-wallet';
      const record = { event, state, category, createdAt:clock() };
      journal.save(record);
      return publicTerritoryAsset(record);
    });
  }

  const list = (territoryId) => journal.list(territoryId).map(publicTerritoryAsset);

  function verifyRecord(record, client) {
    return client.lookup(record.plan.txid).then(async observed => {
      if (!observed || observed.confirmations < minConfirmations) {
        return { status:observed ? 'confirming' : 'unobserved', current:null, history:[] };
      }
      const receipt = validateTerritoryIssue(observed, record, operator.script);
      if (record.event.anchorOnly) return { status:'anchored', receipt, current:null, history:[] };
      // Follow up to four bounded passes per request and keep the verified checkpoint for the next one.
      let trace;
      let checkpoint = record.ownershipCheckpoint;
      for (let pass = 0; pass < 4; pass += 1) {
        trace = await traceTerritoryCollectible(client, observed, record.plan.assetVout, record.plan.category,
          record.plan.commitment, minConfirmations, checkpoint);
        checkpoint = trace.checkpoint ?? checkpoint;
        if (trace.status !== 'continuing') break;
      }
      if (trace.checkpoint && JSON.stringify(trace.checkpoint) !== JSON.stringify(record.ownershipCheckpoint)) {
        journal.save({ ...journal.get(record.id), ownershipCheckpoint:trace.checkpoint });
      }
      return { receipt, ...trace };
    });
  }

  async function verify(assetId) {
    const record = journal.get(assetId);
    if (!record) return null;
    const publicRecord = publicTerritoryAsset(record);
    if (!enabled || !record.plan) return { ...publicRecord, proof:{ status:enabled ? 'awaiting-issuance' : 'issuer-offline' } };
    try {
      const proof = await provider.withClient(client => verifyRecord(record, client));
      return { ...publicRecord, proof };
    } catch {
      return { ...publicRecord, proof:{ status:'uncertain' } };
    }
  }

  async function broadcastRecorded(record) {
    try {
      const txid = await provider.withClient(async client => {
        try { return await client.broadcast(record.plan.rawHex); }
        catch (error) {
          if (/already (?:in|known|have)/i.test(error.message) && await client.lookup(record.plan.txid)) return record.plan.txid;
          throw error;
        }
      });
      if (txid !== record.plan.txid) throw new Error('The Chain returned a different TXID for the recorded payment.');
      journal.transaction(() => {
        const latest = journal.get(record.event.id);
        if (latest?.plan?.txid !== txid || latest.state === 'confirmed') return;
        journal.save({ ...latest, state:'submitted', lastError:null });
      });
    } catch {
      journal.transaction(() => {
        const latest = journal.get(record.event.id);
        if (latest?.plan?.txid !== record.plan.txid || latest.state === 'confirmed') return;
        journal.save({ ...latest, lastError:'The signed transaction is retained. ' + NETWORK_LABEL + ' broadcast will retry.' });
      });
    }
  }

  async function settleActive(record) {
    const observation = await provider.withClient(client => client.lookup(record.plan.txid));
    if (!observation) {
      if (!signingEnabled) return { status:'awaiting-broadcast', assetId:record.event.id };
      await broadcastRecorded(record);
      return { status:'awaiting-chipnet', assetId:record.event.id };
    }
    const receipt = validateTerritoryIssue(observation, record, operator.script);
    return journal.transaction(() => {
      const latest = journal.get(record.event.id);
      if (latest?.plan?.txid !== observation.txid || latest.state === 'confirmed') {
        return { status:latest?.state ?? 'unavailable', assetId:record.event.id };
      }
      if (receipt.confirmations < minConfirmations) {
        journal.save({ ...latest, state:receipt.confirmations === 0 ? 'submitted' : 'confirming', receipt, lastError:null });
        return { status:'awaiting-confirmations', assetId:record.event.id };
      }
      const authority = journal.authority();
      if (authority.headTxid !== record.plan.batonInput.txid) throw new Error('The authority head changed during reconciliation.');
      journal.save({ ...latest, state:'confirmed', receipt, lastError:null });
      journal.saveAuthority({ ...authority, headTxid:observation.txid });
      return { status:'confirmed', assetId:record.event.id };
    });
  }

  async function stageQueued(authority, entry) {
    const funding = await provider.withClient(async client => {
      const activeHead = await client.lookup(authority.headTxid);
      if (!activeHead || activeHead.confirmations < minConfirmations) {
        return null;
      }
      const baton = knownTerritoryBaton(activeHead, category, operator.script, authority.headTxid === genesisTxid);
      const unspent = await client.listUnspent(operator.script, 'tokens_only');
      if (!unspent.some(({txid,vout,satoshis}) => txid === baton.txid && vout === baton.vout && satoshis === baton.satoshis)) {
        return null;
      }
      const minimum = entry.event.anchorOnly ? 2000 : 3500;
      const extra = baton.satoshis < minimum ? await operatorSources(client,operator,minConfirmations,baton) : [];
      return { baton, extra };
    });
    if (!funding) return { status:'authority-unavailable', assetId:entry.event.id };

    let staged;
    try {
      staged = journal.transaction(() => {
        const current = journal.get(entry.event.id);
        if (current?.state !== 'queued' || journal.active() || journal.authority()?.headTxid !== authority.headTxid) {
          return null;
        }
        const plan = buildTerritoryIssue({ baton:funding.baton, funding:funding.extra, event:current.event,
          category, operatorPrivateKey });
        const updated = { ...current, state:'signed', plan, lastError:null };
        journal.save(updated);
        return updated;
      });
    } catch (error) {
      if (!/more confirmed /.test(error.message)) throw error;
      journal.transaction(() => {
        const current = journal.get(entry.event.id);
        if (current?.state === 'queued') journal.save({ ...current, lastError:error.message });
      });
      return { status:'awaiting-funding', assetId:entry.event.id };
    }
    if (!staged) return { status:'busy' };
    await broadcastRecorded(staged);
    return { status:'awaiting-chipnet', assetId:entry.event.id };
  }

  async function work() {
    if (!enabled) return { status:'issuer-offline' };
    try {
      const inFlight = journal.active();
      if (inFlight) return await settleActive(inFlight);
      const entry = journal.list().find(record => record.state === 'queued');
      if (!entry) return { status:'idle' };
      if (!signingEnabled) return { status:'issuer-read-only', assetId:entry.event.id };
      return await stageQueued(journal.authority(), entry);
    } catch {
      return { status:'verification-uncertain' };
    }
  }

  function reconcile() {
    if (closing) return Promise.resolve({ status:'closed' });
    if (!busy) busy = work().finally(() => { busy = undefined; });
    return busy;
  }

  async function close() {
    if (closing) return;
    closing = true;
    await busy;
    journal.close();
  }

  function authority() {
    const current = journal.authority();
    if (!current) return { status:'unconfigured', network:NETWORK_ID, signingEnabled };
    return { ...current, network:NETWORK_ID, signingEnabled, fundingAddress:operator?.address ?? null,
      explorerUrl:explorerUrl(current.genesisTxid), batonVout:0, status:enabled ? 'configured' : 'unconfigured' };
  }

  return { enabled, signingEnabled, enqueue, list, verify, reconcile, authority, close };
}
