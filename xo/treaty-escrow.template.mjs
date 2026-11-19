// XO template for the VaultBorn treaty and protectorate escrow.
//
// A payer locks a compensation principal for a named recipient. The arbiter (in VaultBorn: the game's settlement key) can
// sign exactly two outcomes, a payout to the recipient or a return to the payer, and nothing else: the contract fixes both
// destinations and the amount. If the arbiter never acts, the payer takes the money back alone after the expiry time.
// The rules are the ones of the game's own escrow (packages/chain-observer/political-escrow.mjs); the destinations here are
// locking scripts instead of public keys so that each party is paid at an address its own XO wallet already tracks.

const slot = (role) => ({ role, slots: { min: 1, max: 1 } });
const AMOUNTS_NONE = { satoshis: 0n, fungibleTokens: 0n, nonfungibleTokens: 0 };

export const treatyEscrowTemplate = {
  $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',
  name: 'VaultBorn Treaty Escrow',
  description: 'Compensation escrow for a treaty or protectorate: an arbiter can only pay the named recipient or return the money to the payer, and the payer can take it back alone after the expiry time.',
  icon: 'treaty',
  version: '1',
  supported: ['BCH_2023_05', 'BCH_2024_05', 'BCH_2025_05', 'BCH_2026_05'],
  resources: [{
    name: 'VaultBorn',
    description: 'The strategy game whose treaties and protectorates this escrow settles, with the reproduction steps for this template.',
    url: 'https://github.com/plilian/vaultborn-bchblaze-2026',
  }],
  roles: {
    payer: { name: 'Payer', description: 'The kingdom that locks the compensation, for example the guardian of a protectorate.', icon: 'payer' },
    recipient: { name: 'Recipient', description: 'The kingdom that is paid if the arbiter releases the escrow.', icon: 'recipient' },
    arbiter: { name: 'Arbiter', description: 'Decides between the two fixed outcomes. It can never send the money anywhere else.', icon: 'arbiter' },
  },
  start: [{ action: 'openEscrow', role: 'payer', generate: ['payerKey'] }],
  actions: {
    openEscrow: {
      name: 'Open escrow',
      description: 'Lock the compensation for a treaty. All three parties join before the payer funds it.',
      icon: 'treaty',
      roles: {
        payer: {
          name: 'Lock the compensation',
          description: 'Name the treaty, the amount, the expiry time and your return address, then fund the escrow.',
          generate: ['payerKey'],
          requirements: { variables: ['treatyIdentifier', 'principalSatoshis', 'expiryTime', 'payerLockingScript'] },
        },
        recipient: {
          name: 'Name your payout address',
          description: 'Provide the address that is paid if the arbiter releases the escrow.',
          requirements: { variables: ['recipientLockingScript'] },
        },
        arbiter: {
          name: 'Accept the arbiter seat',
          description: 'Add the key that will sign the outcome.',
          generate: ['arbiterKey'],
        },
      },
      requirements: { participants: [slot('payer'), slot('recipient'), slot('arbiter')] },
      transaction: 'openEscrowTransaction',
    },
    releaseEscrow: {
      name: 'Release to recipient',
      description: 'The arbiter pays the compensation to the named recipient.',
      icon: 'release',
      roles: { arbiter: { requirements: { variables: ['principalSatoshis', 'recipientLockingScript'], secrets: ['arbiterKey'] } } },
      requirements: { participants: [slot('arbiter')] },
      transaction: 'releaseTransaction',
    },
    returnEscrow: {
      name: 'Return to payer',
      description: 'The arbiter returns the compensation to the payer.',
      icon: 'return',
      roles: { arbiter: { requirements: { variables: ['principalSatoshis', 'payerLockingScript'], secrets: ['arbiterKey'] } } },
      requirements: { participants: [slot('arbiter')] },
      transaction: 'returnTransaction',
    },
    reclaimEscrow: {
      name: 'Reclaim after expiry',
      description: 'The payer takes the compensation back without the arbiter once the expiry time has passed.',
      icon: 'return',
      roles: { payer: { requirements: { variables: ['principalSatoshis', 'payerLockingScript', 'expiryTime'], secrets: ['payerKey'] } } },
      requirements: { participants: [slot('payer')] },
      transaction: 'reclaimTransaction',
    },
  },
  transactions: {
    openEscrowTransaction: {
      name: 'Escrow opened',
      description: '$(<principalSatoshis>) satoshis were locked for the treaty.',
      icon: 'treaty',
      inputs: [],
      outputs: [{ output: 'escrowOutput' }],
      version: 2,
      locktime: 0,
      composable: true,
    },
    releaseTransaction: {
      name: 'Escrow released',
      description: 'The arbiter paid the compensation to the recipient.',
      icon: 'release',
      inputs: [{ input: 'releaseInput', inputIndex: 0 }],
      outputs: [{ output: 'recipientPayoutOutput', outputIndex: 0 }],
      version: 2,
      locktime: 0,
    },
    returnTransaction: {
      name: 'Escrow returned',
      description: 'The arbiter returned the compensation to the payer.',
      icon: 'return',
      inputs: [{ input: 'returnInput', inputIndex: 0 }],
      outputs: [{ output: 'payerPayoutOutput', outputIndex: 0 }],
      version: 2,
      locktime: 0,
    },
    reclaimTransaction: {
      name: 'Escrow reclaimed',
      description: 'The payer took the compensation back after the expiry time.',
      icon: 'return',
      inputs: [{ input: 'reclaimInput', inputIndex: 0 }],
      outputs: [{ output: 'payerPayoutOutput', outputIndex: 0 }],
      version: 2,
      locktime: '$(<expiryTime>)',
    },
  },
  inputs: {
    releaseInput: { name: 'Escrow', description: 'The escrow, spent by the arbiter in favour of the recipient.', icon: 'release', unlockingScript: 'unlockRelease' },
    returnInput: { name: 'Escrow', description: 'The escrow, spent by the arbiter in favour of the payer.', icon: 'return', unlockingScript: 'unlockReturn' },
    reclaimInput: { name: 'Escrow', description: 'The escrow, spent by the payer after the expiry time.', icon: 'return', unlockingScript: 'unlockReclaim' },
  },
  outputs: {
    escrowOutput: {
      name: 'Treaty escrow',
      description: '$(<principalSatoshis>) satoshis held for the treaty.',
      icon: 'treaty',
      lockingScript: 'escrowLockingScript',
      valueSatoshis: '$(<principalSatoshis>)',
      token: null,
    },
    recipientPayoutOutput: {
      name: 'Compensation paid',
      description: 'The compensation, less the fixed network fee, paid to the recipient.',
      icon: 'release',
      lockingScript: '$(<recipientLockingScript>)',
      valueSatoshis: '$(<principalSatoshis> <settlementFeeSatoshis> OP_SUB)',
      token: null,
    },
    payerPayoutOutput: {
      name: 'Compensation returned',
      description: 'The compensation, less the fixed network fee, returned to the payer.',
      icon: 'return',
      lockingScript: '$(<payerLockingScript>)',
      valueSatoshis: '$(<principalSatoshis> <settlementFeeSatoshis> OP_SUB)',
      token: null,
    },
  },
  lockingScripts: {
    escrowLockingScript: {
      name: 'Treaty escrow',
      description: 'Pays the named recipient or returns to the payer on the arbiter\'s signature, and returns to the payer alone after the expiry time.',
      icon: 'treaty',
      lockingType: 'p2sh',
      lockingBytecode: 'escrowRedeemScript',
      state: { variables: ['treatyIdentifier', 'principalSatoshis', 'expiryTime', 'payerLockingScript', 'recipientLockingScript'] },
      actions: [],
      selectable: false,
      roles: {
        payer: {
          state: { secrets: ['payerKey'] },
          actions: [{ action: 'reclaimEscrow', role: 'payer', secrets: [{ payerKey: null }] }],
          balance: { satoshis: true, fungibleTokens: 0n, nonfungibleTokens: 0 },
          selectable: false,
        },
        arbiter: {
          state: { secrets: ['arbiterKey'] },
          actions: [
            { action: 'releaseEscrow', role: 'arbiter', secrets: [{ arbiterKey: null }] },
            { action: 'returnEscrow', role: 'arbiter', secrets: [{ arbiterKey: null }] },
          ],
          balance: AMOUNTS_NONE,
          selectable: false,
        },
        recipient: { balance: AMOUNTS_NONE, selectable: false },
      },
    },
  },
  scripts: {
    // Unlocking data, top of stack last: the outcome chosen by the arbiter (1 recipient, 0 payer), then the lane (1 arbiter, 0 expiry).
    unlockRelease: '<arbiterKey.schnorr_signature.all_outputs> OP_1 OP_1',
    unlockReturn: '<arbiterKey.schnorr_signature.all_outputs> OP_0 OP_1',
    unlockReclaim: '<payerKey.schnorr_signature.all_outputs> OP_0',
    // One script, top to bottom. Engine 0.1.1-next reports another participant's key as "still owed" only when the key is
    // used in the locking script itself, not in a script it includes, and it does not offer template constants to locking
    // scripts, so nothing is split out and the fee is a literal that must equal the settlementFeeSatoshis constant.
    //   arbiter lane: pick the destination, then require the arbiter's signature
    //   expiry lane:  require the expiry time and the payer's signature, destination is the payer
    //   both lanes:   the destination must be output 0, the escrow must be the only input, and output 0 must carry
    //                 everything the escrow held except the fixed fee
    escrowRedeemScript: '<treatyIdentifier> OP_DROP OP_IF OP_IF <recipientLockingScript> OP_ELSE <payerLockingScript> OP_ENDIF OP_SWAP <arbiterKey.public_key> OP_CHECKSIGVERIFY OP_ELSE <expiryTime> OP_CHECKLOCKTIMEVERIFY OP_DROP <payerKey.public_key> OP_CHECKSIGVERIFY <payerLockingScript> OP_ENDIF OP_0 OP_OUTPUTBYTECODE OP_EQUALVERIFY OP_TXINPUTCOUNT OP_1 OP_NUMEQUALVERIFY OP_0 OP_OUTPUTVALUE OP_INPUTINDEX OP_UTXOVALUE <600> OP_SUB OP_GREATERTHANOREQUAL',
  },
  constants: {
    settlementFeeSatoshis: {
      name: 'Settlement fee',
      description: 'Fixed number of satoshis the escrow leaves for the network fee when it is settled.',
      type: 'integer',
      value: 600,
    },
  },
  variables: {
    payerKey: { name: 'Payer key', description: 'The private key the payer uses to reclaim after the expiry time.', type: 'private_key' },
    arbiterKey: { name: 'Arbiter key', description: 'The private key the arbiter uses to sign the outcome.', type: 'private_key' },
    treatyIdentifier: { name: 'Treaty identifier', description: 'Sixteen bytes that name the treaty or protectorate this escrow belongs to.', type: 'bytes', hint: '32 hexadecimal characters' },
    principalSatoshis: { name: 'Compensation', description: 'The amount locked in the escrow. Use at least 2000 satoshis so the payout stays above the dust limit.', type: 'satoshis' },
    expiryTime: { name: 'Expiry time', description: 'Unix time in seconds after which the payer can reclaim without the arbiter.', type: 'integer' },
    payerLockingScript: { name: 'Payer return address', description: 'The locking script that receives a return or a reclaim.', type: 'locking_script' },
    recipientLockingScript: { name: 'Recipient payout address', description: 'The locking script that receives a release.', type: 'locking_script' },
  },
  icons: ['treaty', 'payer', 'recipient', 'arbiter', 'release', 'return'].map((name) => ({ name, hash: '0000000000000000000000' })),
};
