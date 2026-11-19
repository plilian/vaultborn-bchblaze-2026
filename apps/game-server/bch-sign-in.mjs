import { bigIntToCompactUint, secp256k1 } from '@bitauth/libauth';
import { hash256, hex, verifyWalletProof, walletFromPublicKey } from '../../packages/chain-observer/primitives.mjs';

const magic=Buffer.from('Bitcoin Signed Message:\n','utf8');
const serialized=value=>Buffer.concat([bigIntToCompactUint(BigInt(value.length)),value]);
export const bchSignMessageDigest=message=>hash256(Buffer.concat([serialized(magic),serialized(Buffer.from(message,'utf8'))]));

// In addition to VaultBorn's original Schnorr proof, accept compact Sign Message
// signatures from wallets that implement Bitcoin Cash Node's verifymessage format.
export function verifiedBchMessageKey({address,publicKey,signature,challenge}) {
  if (verifyWalletProof({address,publicKey,signature,challenge})) return publicKey.toLowerCase();
  if (typeof challenge!=='string' || challenge.length>1000 || typeof signature!=='string' || !/^[A-Za-z0-9+/]{87}=$/.test(signature)) return null;
  try {
    const compact=Buffer.from(signature,'base64');
    const header=compact[0];
    if (compact.length!==65 || compact.toString('base64')!==signature || header<31 || header>34) return null;
    const key=secp256k1.recoverPublicKeyCompressed(compact.subarray(1),header-31,bchSignMessageDigest(challenge));
    if (typeof key==='string') return null;
    const recovered=hex(key);
    return (!publicKey || typeof publicKey==='string' && recovered===publicKey.toLowerCase()) &&
      walletFromPublicKey(recovered).address===address ? recovered : null;
  } catch { return null; }
}
