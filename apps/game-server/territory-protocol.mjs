import { gameEvent, protocolHash } from '../../packages/chain-observer/vaultborn.mjs';
import { acceptRaffle, advanceRaffles, publicRaffle, quoteRaffle, rafflePolicy } from './territory-raffles.mjs';
import { activity, notify as gameNotice } from '../../packages/game-engine/world.mjs';
import { GAMEPLAY_ALLOCATION, LEGACY_PRICING, paymentPrice } from '../../config/payments.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';
import { ADDRESS_PATTERN, NETWORK_ID } from '../../config/network.mjs';

export const territoryPayments = new Set(['territory-claim','territory-attack','territory-raffle']);
const entrants = record => record.entries ?? [];
const sum = rows => rows.reduce((value,row) => value + Number(row.satoshis),0);
const sameOutpoint = (one,two) => one.txid === two.txid && one.vout === two.vout;
const field = site => site?.category ?? site?.kind ?? site?.type;

export function createTerritoryProtocol({ store, chain, clock, gameplay, war, fail, notify, policy = rafflePolicy, assets,
  allocationPolicy=GAMEPLAY_ALLOCATION, pricing=LEGACY_PRICING }) {
  let head;
  let lastRead = 0;

  function ensure(world, now) {
    gameplay.ensureTerritories(world, now);
  }

  function siteOf(world, id) {
    return Array.isArray(world.territories) ? world.territories.find(item => item.id === id) :
      Object.hasOwn(world.territories ?? {},id) ? world.territories[id] : undefined;
  }

  function publicSite(world, id, now) {
    const site = siteOf(world,id);
    if (!site) return null;
    const report = gameplay.readTerritories(world,null,now,{historyLimit:Infinity});
    const rows = Array.isArray(report) ? report : report.territories;
    const detail = rows?.find(item => item.id === id);
    if (!detail) return null;
    return { ...detail, blockchain:site.blockchain, assets:assets?.list(id) ?? [],
      ...(field(site) === 'rare' && { raffle:raffleView(world,id,now) }) };
  }

  const raffleView=(world,id,now)=>({...publicRaffle(world,id,head,now,policy),fee:paymentPrice('territory-raffle',policy.fee,allocationPolicy,pricing)});

  async function prepare(body) {
    if ((body.type ?? body.action) !== 'territory-raffle') return null;
    if (!chain.blockAt) fail(503, 'A ' + NETWORK_LABEL + ' block observer is required for rare entries.');
    try {
      const block = await chain.blockAt();
      if (block?.network !== NETWORK_ID) fail(503, 'Rare entries are available on ' + NETWORK_LABEL + '.');
      head = block;
      return block;
    } catch {
      fail(503,'' + NETWORK_LABEL + ' block data is unavailable. Try again after the observer reconnects.');
    }
  }

  function quote(world, player, body, now, block) {
    ensure(world,now);
    const site = siteOf(world, body.territory);
    if (!site) fail(404, 'This territory is unavailable.');
    const address = store.wallet(player)?.address;
    if (!address) fail(403, 'Connect your wallet first. Paid territory activity is tied to your ' + NETWORK_LABEL + ' wallet.');
    if (body.type === 'territory-raffle') {
      if (field(site) !== 'rare') fail(400, 'Only rare territories offer raffles.');
      const result=quoteRaffle(world,player,site.id,address,block ?? head,now,policy);
      if (allocationPolicy===GAMEPLAY_ALLOCATION) result.description='The entire competitive stake is recoverable by every accepted entrant. The separate network reserve funds the draw and lease-expiration transactions.';
      return result;
    }
    return gameplay.quoteTerritory(world,player,body,now);
  }

  function accept(world, row, now) {
    ensure(world,now);
    const { playerId, receipt } = row;
    const address = store.wallet(playerId)?.address;
    if (!address) fail(403, 'The verified ' + NETWORK_LABEL + ' wallet is missing.');
    if (row.action === 'territory-raffle') {
      const entry = acceptRaffle(world,row,address,now,policy);
      const site = siteOf(world,entry.territory);
      site.history.push({kind:'raffle-entry',playerId:playerId,round:entry.round,txid:row.txid,at:now});
      site.blockchain.push({kind:'entry',id:row.id,txid:row.txid,at:now});
      gameNotice(world,playerId,'Your raffle entry at ' + site.name + ' is in. The draw follows the entry window.',now,'territory',{title:'Raffle entry'});
      return entry;
    }
    const stake = receipt.allocations.find(item => item.role === 'battle' || item.role === 'escrow');
    const escrowSatoshis = stake?.battleSatoshis ?? stake?.satoshis;
    return gameplay.applyTerritoryPayment(world,playerId,row.payload,
      { id:row.id, txid:row.txid, satoshis:row.satoshis, escrowSatoshis, walletAddress:address,
        acceptedAt:row.acceptedAt, includedAt:receipt.blockTime, confirmations:receipt.confirmations,allocationPolicy:row.event?.data.allocationPolicy,pricing:row.event?.data.pricing },now);
  }

  function announceAttack(world,row,now) {
    ensure(world,now);
    const site = siteOf(world,row.payload.territory);
    const defender = site?.owner;
    if (!defender || defender !== row.payload.expectedOwner || world.cities[defender]?.npc) return;
    const attacker = world.cities[row.playerId]?.name ?? 'A rival army';
    gameNotice(world,defender,'Incoming attack at ' + site.name + '. ' + attacker + ' has submitted a ' + NETWORK_LABEL + ' payment.',now,'territory');
    return true;
  }

  function registerAttack(world,row,outcome,previous,now,capturable) {
    const id = outcome?.battle?.id ?? outcome?.battleId ?? (outcome?.events ? outcome.id : undefined);
    const battle = world.battles.find(item => item.id === id) ?? (world.battles[0]?.id !== previous ? world.battles[0] : null);
    if (!battle || battle.attacker !== row.playerId) throw new Error('Paid territory resolution did not publish its battle.');
    const settlement = war.apply(world,row,battle,now,id => store.wallet(id)?.address,capturable);
    const item = (world.territorySettlements ??= []).find(record => entrants(record).some(entry => entry.id === row.id));
    const paid = row.receipt.allocations.find(output => output.role === 'battle' || output.role === 'escrow');
    const owner = { ...paid, satoshis: paid.battleSatoshis ?? paid.satoshis };
    const record = { ...item,id:item?.id ?? 'conquest-' + battle.id, kind:'territory-attack', territoryId:row.payload.territory,
      entries:[{id:row.id,txid:row.txid,player:row.playerId,escrowSatoshis:owner.satoshis}],
      attacker:battle.attacker,defender:battle.defender,
      winner:battle.winner === 'attacker' ? battle.attacker : battle.defender,
      battles:[structuredClone(battle)], payout:[], treasury:settlement,
      controller:siteOf(world,row.payload.territory)?.controller ?? siteOf(world,row.payload.territory)?.owner ?? null, at:now };
    if (item) world.territorySettlements[world.territorySettlements.indexOf(item)] = record;
    else world.territorySettlements.push(record);
  }

  function tick(world, now) {
    ensure(world,now);
    gameplay.advanceTerritories(world,now);
    const battles = new Map(world.battles.map(item => [item.id,item]));
    for (const record of world.territorySettlements ?? []) {
      if (record.battles?.some(item => typeof item === 'string')) {
        record.battles = record.battles.map(item => typeof item === 'string' && battles.has(item) ? structuredClone(battles.get(item)) : item);
      }
    }
  }

  function change(world, player, body, now) {
    tick(world,now);
    return gameplay.territoryCommand(world,player,body,now);
  }

  function view(world, player, now) {
    ensure(world,now);
    const report = gameplay.readTerritories(world,player,now);
    const rows = Array.isArray(report) ? report : report.territories ?? [];
    return rows.map(site => ({
      ...site, assets:assets?.list(site.id) ?? [],
      ...(field(site) === 'rare' && { raffle:raffleView(world,site.id,now) }),
    }));
  }

  function rules(world, player, now) {
    const {rules:mechanics,holdings,capacity} = gameplay.readTerritories(world,player,now);
    return { ...mechanics,claimFee:paymentPrice('territory-claim',mechanics.claimFee,allocationPolicy,pricing),
      attackFee:paymentPrice('territory-attack',mechanics.attackFee,allocationPolicy,pricing),holdings,capacity,
      raffle:{...policy,fee:paymentPrice('territory-raffle',policy.fee,allocationPolicy,pricing)},assetsEnabled:Boolean(assets && assets.enabled !== false) };
  }

  function recordsFor(world, id, rows) {
    const byIntent = new Map(rows.map(row => [row.id,row]));
    const byAnchor = new Map(rows.filter(row => row.territoryAnchor).map(row => [row.territoryAnchor,row]));
    return (world.territorySettlements ?? []).filter(item => item.territoryId === id).sort((a,b) => b.at-a.at).map(record => {
      const anchor = byAnchor.get(record.id);
      const proofs = entrants(record).flatMap(entry => {
        const payment = byIntent.get(entry.id);
        if (!payment?.receipt) return [];
        const { txid, confirmations, explorerUrl, blockHash, height, eventVout, event } = payment.receipt;
        return [{ txid, confirmations, explorerUrl, blockHash, height, eventVout, event }];
      });
      const receipt = anchor?.receipt;
      return { record, recordHash:protocolHash(record), proofs, settlement:receipt && anchor.state === 'credited' ? {
        txid:receipt.txid, explorerUrl:receipt.explorerUrl, height:receipt.height, blockHash:receipt.blockHash,
        eventVout:receipt.eventVout, event:receipt.event, feeSatoshis:receipt.feeSatoshis,
      } : null, anchorStatus:anchor?.state ?? 'queued' };
    });
  }

  function verify(id) {
    const { world } = store.read();
    const detail = publicSite(world,id,clock());
    if (!detail) return null;
    const rows = store.payments();
    const recent = rows.filter(row => row.direction !== 'outgoing' && row.payload?.territory === id && row.state === 'credited' && row.receipt?.event)
      .map(row => ({ activity:row.action, txid:row.txid, explorerUrl:row.receipt.explorerUrl,
        confirmations:row.receipt.confirmations, event:row.receipt.event, eventVout:row.receipt.eventVout }));
    return { territory:detail, records:recordsFor(world,id,rows), chain:NETWORK_ID, recent,
      treasuryPublicKey:chain.treasuryPublicKey ?? null, authority:assets?.authority() ?? null };
  }

  async function processRaffles() {
    if (!chain.blockAt || !chain.enabled) return;
    const now = clock();
    if (now < lastRead + 8_000 && now >= lastRead) return;
    lastRead = now;
    const current = store.read().world;
    const open = Object.values(current.territoryRaffles ?? {}).flatMap(item => item.round?.status === 'open' ? [item.round] : []);
    const blocks = new Map();
    try {
      head = await chain.blockAt() ?? head;
      for (const height of new Set(open.map(item => item.drawHeight))) {
        if (head?.tip - height + 1 < policy.drawConfirmations) continue;
        const confirmed = await chain.blockAt(height);
        if (confirmed) blocks.set(height,confirmed);
      }
    } catch { /* Timeouts and leases use the game clock when the observer is offline. */ }
    const changed = store.transaction(() => {
      const { world } = store.read();
      const paid = store.payments();
      const changes = advanceRaffles(world,{ now,blocks,policy,ready:round => !paid.some(row =>
        row.payload?.round?.id === round.id && row.receipt?.height <= round.closeHeight &&
        ['seen_in_mempool','confirming','reorg','uncertain'].includes(row.state)) });
      for (const change of changes) {
        const site = siteOf(world,change.territoryId);
        if (!site) continue;
        const expired = change.kind === 'lease-expired';
        const holder = change.lease?.playerId;
        const detail = expired ? 'Lease expired at ' : change.winner ? 'Rare lease awarded at ' : 'Raffle escrow released at ';
        site.history.push({kind:expired ? 'lease-expired' : change.winner ? 'lease-started' : 'raffle-refunded',
          playerId:holder ?? null,record:change.id,at:change.at});
        activity(world,'territory',detail+site.name+'.',now);
        if (holder) gameNotice(world,holder,(change.winner ? 'You won the raffle at ' : detail)+site.name+'.',now,'territory',
          {title:change.winner ? 'Raffle won' : expired ? 'Lease ended' : 'Raffle',...(change.lease?.expiresAt && !expired && {until:change.lease.expiresAt})});
        // Every other entrant hears the result too: not drawn, and their escrow is on its way back.
        for (const player of new Set((change.entries ?? []).map(entry => entry.player)))
          if (player !== holder) gameNotice(world,player,(change.winner ? 'Raffle at ' + site.name + ' drawn: not you this time.' : 'Raffle at ' + site.name + ' closed without a draw.') +
            ' Your escrow returns to your wallet.',now,'territory',{title:'Raffle result'});
      }
      if (changes.length) store.write(world);
      return changes.length;
    });
    if (changed) notify();
  }

  function settlementPayout(record, payments) {
    const expected = payments.reduce((total,row) => total + Number(row.receipt.allocations.find(output => output.role === 'battle').satoshis),0);
    if (record.kind === 'territory-attack') return { total:expected, payouts:[] };
    const combined = new Map();
    for (const item of record.payout ?? record.payouts ?? record.distributions ?? []) {
      const who = item.player ?? item.playerId;
      combined.set(who,(combined.get(who) ?? 0) + item.satoshis);
    }
    if (combined.size === 0 && record.kind !== 'raffle') {
      // The default contest policy returns all sole stakes and half of forfeited loser stakes.
      const victor = record.winner ?? record.winnerId;
      for (const entry of entrants(record)) {
        const player = entry.player ?? entry.playerId;
        const stake = entry.escrowSatoshis;
        const share = victor && player !== victor ? Math.floor(stake / 2) : 0;
        combined.set(player,(combined.get(player) ?? 0) + stake - share);
        if (share) combined.set(victor,(combined.get(victor) ?? 0) + share);
      }
    }
    const payouts = [...combined].map(([player,satoshis]) => ({player,satoshis}));
    if (sum(payouts) !== expected) throw new Error('Territory escrow split mismatches confirmed inputs.');
    return {total:expected,payouts};
  }

  async function anchorNext() {
    if (!chain.payoutsEnabled) return;
    const signed = store.transaction(() => {
      const all = store.payments();
      const { world } = store.read();
      const spent = all.flatMap(item => item.direction === 'outgoing' && (item.rawHex || item.receipt) ? item.sources ?? [] : []);
      const available = output => output && !spent.some(prior => sameOutpoint(output,prior));
      for (const record of [...world.territorySettlements ?? []].sort((a,b) => a.at-b.at)) {
        if (all.some(row => row.territoryAnchor === record.id)) continue;
        const expiry = record.kind === 'lease-expired';
        const eventKind = expiry ? 'lease-expired' : record.kind === 'raffle' ? 'raffle-draw' :
          record.kind === 'territory-attack' ? 'conquest' : 'territory-settlement';
        const event = gameEvent(eventKind,record.id,{ territory:record.territoryId, recordHash:protocolHash(record),
          entryTxids:entrants(record).map(entry => entry.txid) });
        let sources;
        let ledgerEntry;
        let reservePool='development';
        if (expiry) {
          const opening=all.find(row => row.territoryAnchor === record.preceding && row.state === 'credited');
          const source = opening?.receipt?.change;
          if (opening?.pool==='settlement') reservePool='settlement';
          if (!available(source) || source.satoshis < 902) continue;
          sources = [source];
        } else {
          const entries = entrants(record);
          if (!entries.length || entries.length > 12 || new Set(entries.map(item => item.id)).size !== entries.length) continue;
          const inputs = entries.map(entry => all.find(row => row.id === entry.id && row.txid === entry.txid && row.state === 'credited' && row.territoryEscrow));
          if (inputs.some(row => !row)) continue;
          if (inputs.some(row=>row.event?.data.allocationPolicy===GAMEPLAY_ALLOCATION)) reservePool='settlement';
          sources = inputs.flatMap(row => row.receipt.allocations.filter(output => ['battle','development','settlement'].includes(output.role)));
          if (sources.length !== inputs.length * 2 || sources.some(output => !available(output))) continue;
          ledgerEntry = settlementPayout(record,inputs);
        }
        const plan = chain.preparePayout({playerId:'council',action:eventKind,payload:{territory:record.territoryId,record:record.id},
          sources,satoshis:ledgerEntry?.total,event,retain:true,now:clock()});
        const row = { ...plan,...chain.signPayout(plan),territoryAnchor:record.id,territoryBattles:record.battles?.map(item => item.id ?? item) ?? [],
          retainedPool:expiry ? reservePool : 'kingdom', title:expiry ? 'Rare lease expiration' : 'Territory escrow settlement',
          pool:reservePool,state:'submitted',...(record.kind === 'raffle' && record.lease && {territoryLeaseReserve:true}),
          ...(ledgerEntry && {territoryCredit:ledgerEntry}) };
        store.savePayment(row);
        return row;
      }
    });
    if (!signed) return;
    await chain.broadcast(signed.rawHex).catch(() => undefined);
    notify();
  }

  function credit(world, row, now) {
    if (row.fulfillment) return null;
    const ledger = row.territoryCredit?.payouts.length ?
      war.releaseTerritory(world,row.id,row.territoryCredit.payouts,row.territoryCredit.total,now) : null;
    const site = siteOf(world,row.payload?.territory);
    if (site) {
      const proof = site.blockchain.find(item => item.id === row.territoryAnchor);
      const settled = {kind:row.action,id:row.territoryAnchor,txid:row.txid,at:now};
      if (proof) Object.assign(proof,settled);
      else site.blockchain.push(settled);
    }
    return { territory:row.payload?.territory, settlement:row.territoryAnchor, txid:row.txid, ledger };
  }

  async function reconcileAssets() {
    if (!assets || assets.enabled === false) return;
    const all = store.payments();
    if (all.some(row => row.state === 'reorg' && (row.territoryAnchor || row.territoryEscrow))) return;
    const { world } = store.read();
    const statesBefore = assets.list().map(({id,state}) => id + ':' + state).join('|');
    for (const record of [...world.territorySettlements ?? []].sort((a,b) => a.at-b.at)) {
      const proof = all.find(row => row.territoryAnchor === record.id && row.state === 'credited' && row.receipt);
      if (!proof || store.portal('territory-asset-queue',record.id)) continue;
      const territoryId = record.territoryId;
      const controlHash = protocolHash(record);
      const version = Number.isSafeInteger(record.version) && record.version > 0 ? record.version : 1;
      const event = { eventId:record.id,territoryId,controlHash,version,relatedTxid:proof.txid };
      const owner = record.lease?.playerId ?? record.controller ?? record.winner ?? record.winnerId;
      const address = owner && store.wallet(owner)?.address;
      if (record.kind === 'raffle' && record.lease && address) {
        await assets.enqueue({ ...event,kind:record.lease.renewalOf ? 'lease-renewed' : 'lease',
          holderAddress:address,controllerId:owner,expiresAt:record.lease.expiresAt });
      } else if (record.kind === 'lease-expired') {
        await assets.enqueue({ ...event,kind:'lease-expired',expiresAt:record.lease.expiresAt });
      } else if (record.kind === 'territory-attack') {
        const battled = record.battles?.[0];
        if (battled?.winner === 'attacker' && address) {
          await assets.enqueue({ ...event,kind:'conquest',holderAddress:address,controllerId:owner });
          await assets.enqueue({ ...event,kind:'control',controllerId:owner });
        }
      } else if (record.kind !== 'raffle' && address) {
        await assets.enqueue({ ...event,kind:'deed',holderAddress:address,controllerId:owner });
      }
      store.savePortal('territory-asset-queue',record.id,{anchored:proof.txid,at:clock()});
    }
    await assets.reconcile();
    if (statesBefore !== assets.list().map(({id,state}) => id + ':' + state).join('|')) notify();
  }

  // The settlement record an escrowed entry belongs to, with the event that anchors it.
  function settlementOf(world, rowId) {
    const record = (world.territorySettlements ?? []).find(item => entrants(item).some(entry => entry.id === rowId));
    if (!record) return null;
    const eventKind = record.kind === 'raffle' ? 'raffle-draw' : record.kind === 'territory-attack' ? 'conquest' : 'territory-settlement';
    return { record, eventKind, victor: record.winner ?? record.winnerId ?? null,
      event: gameEvent(eventKind, record.id, { territory: record.territoryId, recordHash: protocolHash(record), entryTxids: entrants(record).map(entry => entry.txid) }) };
  }

  return { ensure, prepare, quote, accept, announceAttack, registerAttack, settlementOf, tick, change, view, rules, verify, processRaffles, anchorNext, credit, reconcileAssets };
}
