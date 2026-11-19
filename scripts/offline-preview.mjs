import { createApp } from '../apps/game-server/index.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';

const chain=createChain({enabled:false,transport:{withClient:async()=>{
  throw new Error('The audit preview cannot contact a blockchain provider.');
}}});
const assets={enabled:false,list:()=>[],authority:()=>null,close:()=>{}};
const port=Number(process.env.PORT??4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a valid offline preview port.');
const pairingOnly=process.argv.includes('--wallet');
const app=createApp({database:':memory:',localDemo:true,chain,territoryAssets:assets,politicalAssets:assets,
  walletConnect:pairingOnly,walletRead:false,sessionCookieName:'dominion_preview_' + port});
app.server.listen(port,'127.0.0.1',()=>console.log(`${pairingOnly?'Wallet-pairing':'Offline'} VAULTBORN preview: http://127.0.0.1:${port}`));
process.once('SIGINT',()=>app.close());
process.once('SIGTERM',()=>app.close());
