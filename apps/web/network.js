// The Bitcoin Cash network this realm runs on. The game server answers /network.js with the values of its own
// configuration (config/network.mjs); this file holds the Chipnet defaults for tools that read the folder directly.
export const NETWORK = Object.freeze({ id: 'chipnet', label: 'Chipnet', prefix: 'bchtest', explorer: 'https://chipnet.imaginary.cash/tx/', realValue: false,
  attestorOperation: 'independent', attestorAdjective: 'independent', attestorNote: '' });
export const NETWORK_LABEL = NETWORK.label;
export const ATTESTOR_ADJECTIVE = NETWORK.attestorAdjective;
export const explorerUrl = txid => NETWORK.explorer + txid;
