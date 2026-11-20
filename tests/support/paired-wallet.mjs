// A wallet pairing as the game keeps it in the browser after a player connected a WizardConnect wallet.
// Browser checks put it into the page before it opens, so the page starts with a connected wallet, exactly as a player
// who paired earlier on this browser. Its relay never answers: nothing can be signed with it. Test keys only.
import { randomBytes } from 'node:crypto';
import { binToHex, deriveHdPath, deriveHdPrivateNodeChild, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeHdPublicKey } from '@bitauth/libauth';
import { walletFromPrivateKey } from '../../packages/chain-observer/index.mjs';
import { REAL_VALUE } from '../../config/network.mjs';

// An HD wallet whose first receiving address is the returned wallet. Its private key stays in the test process.
export function hdTestWallet(seed = randomBytes(32)) {
  const root = deriveHdPrivateNodeFromSeed(Uint8Array.from(seed));
  const branch = name => deriveHdPath(root, "m/44'/145'/0'/" + (name === 'receive' ? 0 : 1));
  const xpub = name => encodeHdPublicKey({ network:REAL_VALUE ? 'mainnet' : 'testnet', node:deriveHdPublicNode(branch(name)) }).hdPublicKey;
  const privateKey = binToHex(deriveHdPrivateNodeChild(branch('receive'), 0).privateKey);
  return { ...walletFromPrivateKey(privateKey), privateKey, paths:[{ name:'receive', xpub:xpub('receive') }, { name:'change', xpub:xpub('change') }] };
}

// The saved pairing for one kingdom on the given relay (the server's test relay), as the game's wallet module stores it.
export function pairingEntry(player, relay, wallet, walletName = 'Test wallet') {
  return {
    key:'vaultborn-wizard-v1:' + player + ':' + relay,
    value:JSON.stringify({ privateKey:randomBytes(32).toString('hex'), secret:randomBytes(8).toString('hex'),
      walletPublicKey:randomBytes(32).toString('hex'), walletName, paths:wallet.paths }),
  };
}

// Put the pairing into every page of a browser context before its scripts run.
export async function seedPairing(context, entries) {
  await context.addInitScript(list => { for (const { key, value } of list) localStorage.setItem(key, value); }, entries);
}
