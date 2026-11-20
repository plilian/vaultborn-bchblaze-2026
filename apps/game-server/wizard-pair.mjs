// WizardConnect pairing held by the game server, so that the wallet shows "Connect" at the first try.
//
// A phone pauses a web page while the wallet app is in front, and a wallet shows its "Connect" button only after the game
// has answered it. The server never pauses: it answers the wallet at once. When the wallet has approved the connection,
// the server hands the relay session (a relay session, not a BCH key) to the page, which continues it as before and asks
// for the wallet check when the player is back on the site. The server never sees a wallet key.
import { randomBytes } from 'node:crypto';
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import { decodeHdPublicKey } from '@bitauth/libauth';
import { NETWORK_LABEL, REAL_VALUE } from '../../config/network.mjs';

const PAIRING_MS = 180_000;
const KEPT_MS = 300_000;
const MOST = 50;
// Node's own WebSocket behaves as a browser's does. The "ws" package throws from a socket closed while it is still
// opening (a pairing that ends during a relay reconnect), which would stop the whole server.
if (globalThis.WebSocket) useWebSocketImplementation(globalThis.WebSocket);

export function createWizardPairing({ testRelay }) {
  const pairings = new Map();

  // Ends the server's part. The wallet is not told to disconnect: the page continues the same session.
  function release(entry) {
    clearTimeout(entry.timer);
    if (entry.manager) { void entry.manager.destroy(); entry.manager = null; }
    if (entry.relay) { entry.relay.cleanup(); entry.relay = null; }
    entry.timer = setTimeout(() => pairings.delete(entry.id), KEPT_MS);
    entry.timer.unref?.();
  }
  function finish(entry, fields) {
    if (entry.done) return;
    entry.done = true;
    Object.assign(entry, fields);
    release(entry);
  }

  function start({ token }) {
    for (const entry of pairings.values()) if (entry.token === token) { finish(entry, { status: 'closed' }); pairings.delete(entry.id); }
    if ([...pairings.values()].filter(entry => !entry.done).length >= MOST) {
      throw Object.assign(new Error('Too many wallets are connecting right now. Try again in a minute.'), { status: 503 });
    }
    const id = randomBytes(16).toString('hex');
    const memory = new Map();
    const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) };
    const manager = new DappConnectionManager('VAULTBORN ' + NETWORK_LABEL, undefined, { session: { key: 'pairing', storage } });
    const entry = { id, token, status: 'pairing', manager, done: false };
    pairings.set(id, entry);
    // The relay session as the page needs it to continue: its keys, plus the wallet's name and paths. (The SDK stores the
    // paths only after its "walletready" event, so they are taken from the manager itself.)
    const session = () => {
      let stored = {};
      try { stored = JSON.parse(memory.get('pairing') ?? '{}'); } catch { /* nothing stored yet */ }
      return JSON.stringify({ ...stored, walletName: entry.walletName ?? stored.walletName, paths: manager.getSessionPaths() });
    };

    manager.on('walletready', message => {
      if (entry.done) return;
      const paths = manager.getSessionPaths();
      // Selene first announces itself without paths, then asks its user; the approval brings the paths.
      if (!paths.length) { entry.status = 'approving'; return; }
      const receive = paths.find(path => path.name === 'receive');
      const walletNetwork = receive ? decodeHdPublicKey(receive.xpub)?.network : undefined;
      if (/\bselene\b/i.test(message.wallet_name) && walletNetwork && walletNetwork !== (REAL_VALUE ? 'mainnet' : 'testnet')) {
        finish(entry, { status: 'failed', error: REAL_VALUE ? 'Selene is on a test network. Switch Selene to Mainnet, then pair again.' : 'Selene is on Mainnet. Switch to Chipnet in Selene, then pair again.' });
        return;
      }
      const key = manager.getPubkey(0, 0n);
      if (!key) {
        finish(entry, { status: 'failed', error: 'This wallet did not share a receiving address. Choose a compatible HD wallet and pair again.' });
        return;
      }
      // Connected. The page takes over here; it sends the wallet check itself once the player is back on the site.
      // (Released on the next turn, after the SDK has finished handling this message.)
      entry.walletName = message.wallet_name;
      setImmediate(() => finish(entry, { status: 'connected', session: session() }));
    });
    manager.on('disconnect', (reason, message) => {
      if (/protocol/i.test(String(reason)) || /protocol/i.test(String(message))) finish(entry, { status: 'failed', error: message || 'This wallet cannot be used here.' });
    });

    const relay = initiateDappRelay(({ client, status }) => { if (!entry.done) manager.updateConnection(client, status); },
      testRelay ? { explicitRelayUrls: [testRelay] } : {});
    entry.relay = relay;
    manager.attachRelay(relay);
    entry.timer = setTimeout(() => { if (entry.status === 'pairing' || entry.status === 'approving') finish(entry, { status: 'failed', error: 'Pairing expired. Choose a wallet to try again.' }); }, PAIRING_MS);
    entry.timer.unref?.();
    return { id, uri: relay.uri, qrUri: relay.qrUri };
  }

  // What the page needs to take over. The relay session is handed out once, to the same browser.
  function status(id, token) {
    const entry = pairings.get(id);
    if (!entry || entry.token !== token) return { status: 'failed', error: 'Pairing expired. Choose a wallet to try again.' };
    if (!entry.done) return { status: entry.status };
    pairings.delete(id);
    clearTimeout(entry.timer);
    const { status: state, error, session, walletName } = entry;
    return { status: state, error, session, walletName };
  }

  function close() { for (const entry of pairings.values()) { entry.done = true; release(entry); clearTimeout(entry.timer); } pairings.clear(); }

  return { start, status, close };
}
