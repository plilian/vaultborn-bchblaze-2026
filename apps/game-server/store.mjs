import { sealScores } from './season-evidence.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(filename, initialWorld) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS world (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      body TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      secret TEXT PRIMARY KEY,
      player TEXT NOT NULL UNIQUE,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commands (
      player TEXT NOT NULL, request TEXT NOT NULL, input TEXT NOT NULL,
      result TEXT NOT NULL, submitted INTEGER NOT NULL,
      PRIMARY KEY (player, request)
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, player TEXT NOT NULL, txid TEXT UNIQUE,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payments_player ON payments(player);
    CREATE TABLE IF NOT EXISTS wallets (
      player TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, verified_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_challenges (
      player TEXT PRIMARY KEY, address TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_challenges (
      nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL, body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS identity_challenges_expiry ON identity_challenges(expires);
    CREATE TABLE IF NOT EXISTS wallet_keys (
      player TEXT PRIMARY KEY, body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kingdom_chronicles (
      player TEXT PRIMARY KEY, body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portal (
      kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE TABLE IF NOT EXISTS sponsor_events (
      sponsor TEXT NOT NULL, player TEXT NOT NULL, day INTEGER NOT NULL, kind TEXT NOT NULL,
      PRIMARY KEY (sponsor, player, day, kind)
    );
    PRAGMA user_version = 3;
  `);
  db.prepare('INSERT OR IGNORE INTO world VALUES (1, ?, 1)').run(JSON.stringify(initialWorld));

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    transaction,
    close: () => db.close(),
    read() {
      const row = db.prepare('SELECT body, revision FROM world WHERE singleton=1').get();
      return { world: JSON.parse(row.body), revision: row.revision };
    },
    write(world) {
      // Score events queued by the game rules are sealed into the public season journal with the world that produced them.
      sealScores({ savePortal: (kind, id, body) => db.prepare('INSERT INTO portal VALUES (?, ?, ?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind, id, JSON.stringify(body)) }, world);
      return db.prepare('UPDATE world SET body=?, revision=revision+1 WHERE singleton=1 RETURNING revision')
        .get(JSON.stringify(world)).revision;
    },
    session(secret, now) {
      return db.prepare('SELECT player FROM sessions WHERE secret=? AND expires>?').get(secret, now)?.player;
    },
    hasSeat(player) {
      return Boolean(db.prepare('SELECT 1 FROM sessions WHERE player=?').get(player));
    },
    addSession(secret, player, expires) {
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(secret, player, expires);
    },
    renewIdentitySession(secret, player, expires) {
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET secret=excluded.secret, expires=excluded.expires')
        .run(secret,player,expires);
    },
    revokeSession(secret) {
      // Keep the assigned seat reserved even when its browser session ends.
      db.prepare('UPDATE sessions SET expires=0 WHERE secret=?').run(secret);
    },
    saveIdentityChallenge(record,now) {
      db.prepare('DELETE FROM identity_challenges WHERE expires<=?').run(now);
      db.prepare('INSERT INTO identity_challenges VALUES (?, ?, ?)').run(record.payload.nonce,record.payload.expiresAt,JSON.stringify(record));
    },
    identityChallenge(nonce,now) {
      const row=db.prepare('SELECT body FROM identity_challenges WHERE nonce=? AND expires>?').get(nonce,now);
      return row && JSON.parse(row.body);
    },
    consumeIdentityChallenge(nonce) {
      return db.prepare('DELETE FROM identity_challenges WHERE nonce=?').run(nonce).changes===1;
    },
    kingdomChronicle(player) {
      const row = db.prepare('SELECT body FROM kingdom_chronicles WHERE player=?').get(player);
      return row ? JSON.parse(row.body) : null;
    },
    saveKingdomChronicle(player, chronicle) {
      db.prepare(`INSERT INTO kingdom_chronicles VALUES (?, ?)
        ON CONFLICT(player) DO UPDATE SET body=excluded.body`).run(player, JSON.stringify(chronicle));
    },
    wallet(player) {
      return db.prepare('SELECT address, verified_at AS verifiedAt FROM wallets WHERE player=?').get(player) ?? null;
    },
    // The addresses of the linked HD wallet (from public keys its owner's wallet shared), so its whole balance can be read
    // when the wallet is not connected at that moment.
    walletAddresses(player) {
      const row = db.prepare('SELECT body FROM wallet_keys WHERE player=?').get(player);
      return row ? JSON.parse(row.body) : null;
    },
    saveWalletAddresses(player, keys) {
      db.prepare('INSERT INTO wallet_keys VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET body=excluded.body').run(player, JSON.stringify(keys));
    },
    walletKey(player) {
      return db.prepare('SELECT address, public_key AS publicKey FROM wallets WHERE player=?').get(player) ?? null;
    },
    walletOwner(address) {
      return db.prepare('SELECT player FROM wallets WHERE address=?').get(address)?.player;
    },
    saveChallenge(player, address, challenge, expires) {
      db.prepare('INSERT OR REPLACE INTO wallet_challenges VALUES (?, ?, ?, ?)').run(player,address,challenge,expires);
    },
    challenge(player) {
      return db.prepare('SELECT address, challenge, expires FROM wallet_challenges WHERE player=?').get(player);
    },
    bindWallet(player,address,publicKey,now) {
      const oldAddress=db.prepare('SELECT address FROM wallets WHERE player=?').get(player)?.address;
      const savedOwner=db.prepare("SELECT body FROM portal WHERE kind='identity-wallet-history' AND id=?").get(address)?.body;
      const owner = db.prepare('SELECT player FROM wallets WHERE address=?').get(address)?.player ?? (savedOwner && JSON.parse(savedOwner).player);
      if (owner && owner !== player) return false;
      if (oldAddress && oldAddress!==address) db.prepare("INSERT OR IGNORE INTO portal VALUES ('identity-wallet-history',?,?)")
        .run(oldAddress,JSON.stringify({player}));
      db.prepare('INSERT OR REPLACE INTO wallets VALUES (?, ?, ?, ?)').run(player,address,publicKey,now);
      db.prepare('DELETE FROM wallet_challenges WHERE player=?').run(player);
      return true;
    },
    previousCommand(player, request) {
      return db.prepare('SELECT input, result FROM commands WHERE player=? AND request=?').get(player, request);
    },
    recordCommand(player, request, input, result, time) {
      db.prepare('INSERT INTO commands VALUES (?, ?, ?, ?, ?)').run(player, request, input, JSON.stringify(result ?? null), time);
    },
    payments(player) {
      const rows = player ? db.prepare('SELECT body FROM payments WHERE player=? ORDER BY rowid DESC').all(player)
        : db.prepare('SELECT body FROM payments ORDER BY rowid DESC').all();
      return rows.map((row) => JSON.parse(row.body));
    },
    payment(id) {
      const row = db.prepare('SELECT body FROM payments WHERE id=?').get(id);
      return row && JSON.parse(row.body);
    },
    byTxid(txid) {
      return db.prepare('SELECT id FROM payments WHERE txid=?').get(txid)?.id;
    },
    savePayment(payment) {
      db.prepare(`INSERT INTO payments VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET txid=excluded.txid, body=excluded.body`)
        .run(payment.id, payment.playerId, payment.txid ?? null, JSON.stringify(payment));
    },
    portal(kind, id) {
      const record = db.prepare('SELECT body FROM portal WHERE kind=? AND id=?').get(kind, id);
      return record && JSON.parse(record.body);
    },
    portalRows(kind) {
      return db.prepare('SELECT body FROM portal WHERE kind=? ORDER BY rowid DESC').all(kind).map(row => JSON.parse(row.body));
    },
    savePortal(kind, id, body) {
      db.prepare('INSERT INTO portal VALUES (?, ?, ?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body')
        .run(kind, id, JSON.stringify(body));
    },
    sponsorEvent(sponsor, player, day, kind) {
      db.prepare('INSERT OR IGNORE INTO sponsor_events VALUES (?, ?, ?, ?)').run(sponsor, player, day, kind);
    },
    sponsorAnalytics(sponsor) {
      return Object.fromEntries(db.prepare('SELECT kind, count(*) AS total FROM sponsor_events WHERE sponsor=? GROUP BY kind')
        .all(sponsor).map(({ kind, total }) => [kind, total]));
    },
  };
}
