// Imported first by every Chipnet test tool. Those tools use disposable keys, fixtures and faucets: none of them may
// ever run against real BCH.
import { NETWORK_ID } from '../../config/network.mjs';
if (NETWORK_ID !== 'chipnet') throw new Error('This is a Chipnet test tool with disposable keys. It refuses to run with VAULTBORN_NETWORK=' + NETWORK_ID + '.');
