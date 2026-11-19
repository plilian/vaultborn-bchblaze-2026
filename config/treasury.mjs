import { decodeAddress } from '../packages/chain-observer/primitives.mjs';
import { compileTreasuryCovenant } from '../packages/chain-observer/treasury-covenants.mjs';
import { NETWORK_ID, networkEnv, networkEnvName } from './network.mjs';

// Reads the developer address and the attestor keys of the ACTIVE network only (CHIPNET_… or MAINNET_… variables).
export function treasuryConfig(env = process.env) {
  const address = networkEnv('DEVELOPMENT_ADDRESS', env)?.trim();
  const keys = networkEnv('DEVELOPMENT_COUNCIL_KEYS', env)?.trim();
  const id = networkEnv('DEVELOPMENT_COVENANT_ID', env)?.trim();
  const sponsorAddress = networkEnv('SPONSOR_DEVELOPMENT_ADDRESS', env)?.trim();
  if ((keys || id) && address) throw new Error('Choose a configured Development address or a 2-of-3 Development covenant.');
  if ((keys || id) && !(keys && id)) throw new Error('The Development covenant requires three public keys and a unique covenant ID.');
  const direct = value => {
    if (!value) return undefined;
    const destination = decodeAddress(value);
    if (destination.tokenSupport) throw new Error('Treasury destinations must use native BCH CashAddr.');
    return destination.address;
  };
  const development = keys ? compileTreasuryCovenant({ kind:'development', network:NETWORK_ID, id,
    keys:keys.split(',').map(key => key.trim()) }) : null;
  const developmentAddress = development?.address ?? direct(address);
  // One developer receiving address. The older separate sponsorship variable may only repeat it.
  if (sponsorAddress && direct(sponsorAddress) !== developmentAddress) {
    throw new Error('Configure one developer address: ' + networkEnvName('SPONSOR_DEVELOPMENT_ADDRESS') + ' must be unset or equal to ' + networkEnvName('DEVELOPMENT_ADDRESS') + '.');
  }
  const prizeAttestors = (networkEnv('PRIZE_ATTESTOR_KEYS', env) ?? '').split(',').map(key => key.trim().toLowerCase()).filter(Boolean);
  if (prizeAttestors.some(key => !/^0[23][0-9a-f]{64}$/.test(key)) || new Set(prizeAttestors).size !== prizeAttestors.length || prizeAttestors.length > 3) {
    throw new Error(networkEnvName('PRIZE_ATTESTOR_KEYS') + ' takes one to three distinct compressed public keys.');
  }
  return { development, developmentAddress, sponsorshipDevelopmentAddress:developmentAddress, prizeAttestors };
}
export const chipnetTreasuryConfig = treasuryConfig; // earlier name
