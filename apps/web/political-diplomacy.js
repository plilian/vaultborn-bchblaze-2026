import { gameSelect } from './game-select.js';
import { bch, btn, command, costs, duration, empty, formatDate, html, list, number, resources, shortId, tag, title } from './view.js';
import { NETWORK, NETWORK_LABEL } from './network.js';

const types = [
  ['peace','Peace treaty'], ['ceasefire','Ceasefire'], ['non-aggression','Non-aggression pact'],
  ['defensive-alliance','Defensive alliance'], ['military-assistance','Military assistance'], ['trade','Trade agreement'],
  ['territory-sharing','Territory-sharing agreement'], ['reparations','Reparations & compensation'],
  ['protectorate','Protectorate treaty'], ['federation','Federation agreement'],
];
const sanctions = [['tariff','Tariff'], ['embargo','Embargo'], ['blockade','Border blockade'], ['restriction','Trade restriction']];
const motions = [['election','Leadership election'], ['appoint','Council appointment'], ['war','War declaration'], ['alliance','Alliance'], ['peace','Peace agreement'], ['sanction','Sanction'], ['spend','Treasury spending'], ['policy','Treasury policy']];
const compensation = [['none','None'],['resources','Earned resources'],['bch','BCH escrow']];
const policies = [['balanced','Balanced · 300 units'],['reserve','Reserve · 100 units'],['investment','Investment · 500 units']];
const roles = [['diplomat','Diplomat'],['quartermaster','Quartermaster'],['member','Member']];
const openTreaty = status => ['proposed','negotiating'].includes(status);
const treatyPending = status => ['awaiting-funding','awaiting-settlement'].includes(status);
const group = (field, values, markup) => `<div class="politics-fields" data-political-group="${field}" data-political-values="${values.join(' ')}">${markup}</div>`;
const hidden = (name,value) => `<input type="hidden" name="${html(name)}" value="${html(value)}">`;
const note = text => text ? `<p class="politics-note">${html(text)}</p>` : '';
const closed = status => ['cancelled','expired','rejected','breached','resolved','ended','refunded','released','lifted','broken'].includes(status);
const label = (options,value)=> options.find(([id])=>id===value)?.[1] ?? title(value);
const color = status => ['active','accepted','passed','settled','delivered','released'].includes(status) ? 'success' :
  ['breached','failed','rejected','blocked','refunded'].includes(status) ? 'danger' : 'quiet';
const badge = value => tag(title(value),color(value));
const dialogBtn = (label,id,glyph='flag') => btn(label,glyph,{modal:'political',id},'primary');
const chainLink = (txid,caption = shortId(txid)) => /^[a-f0-9]{64}$/i.test(txid ?? '') ?
  `<a class="politics-record" href="/verify/politics?txid=${encodeURIComponent(txid)}">${html(caption)}</a>` : '';
const timer = (when, now) => `<time data-until="${html(when)}">${duration(when-now)}</time>`;
const deadline = (time, ctx, activeText = 'Expires in') => time > ctx.gameNow ? `<p>${html(activeText)} ${timer(time,ctx.gameNow)}</p>` : '';
const choices = values => values.map(value => [value,title(value)]);
const foreignCities = ctx => ctx.cities.filter(city => city.id !== ctx.own.id && !city.npc).map(city => [city.id, city.name]);
const town = (ctx,id) => ctx.kingdom(id) ?? 'Kingdom';
const siteName = (ctx,id) => list(ctx.ui.state.territories).find(site => site.id === id)?.name ?? id;
const sitesOf = (ctx,id) => list(ctx.ui.state.territories).filter(site => (site.owner ?? site.controller) === id);

export function diplomacyViews({section,row,form,input,parties}) {
  function treatyFields(ctx,treaty) {
    const current = treaty?.proposal?.terms ?? treaty?.terms ?? {};
    const signatories = treaty ? parties(treaty) : [ctx.own.id, ...foreignCities(ctx).map(([id])=>id)];
    const sites = list(ctx.ui.state.territories).filter(site=>signatories.includes(site.owner ?? site.controller));
    const goods = current.compensation?.resources ?? {};
    const editableCompensation = treaty?.status !== 'active';
    const scope = sites.map(site => `<label class="political-consent"><input type="checkbox" data-political-holding data-owner="${html(site.owner ?? site.controller)}" name="holding-${html(site.id)}" value="${html(site.id)}"${current.territoryIds?.includes(site.id) ? ' checked' : ''}> ${html(site.name)}</label>`).join('');
    const payout = editableCompensation ? gameSelect('Compensation','payout',compensation,current.compensation?.kind) +
      group('payout',['bch','resources'],gameSelect('Payer','payer',[['self','My kingdom'],['other','Other kingdom']], current.compensation && current.compensation.payerId !== ctx.own.id ? 'other' : 'self')) +
      group('payout',['resources'],`<div class="politics-resource-fields">${resources.map(resource=>
        input(title(resource) + ' compensation units','compensation-' + resource,{type:'number',value:goods[resource] ?? '',min:0,max:500,optional:true})).join('')}</div>`) +
      group('payout',['bch'],input('BCH compensation in sats','satoshis',{type:'number',value:current.compensation?.satoshis ?? 1000,min:1000,max:250000})) : '';
    return input('Term in hours','hours',{type:'number',value:current.hours ?? 48,min:1,max:720}) +
      group('kind',['territory-sharing'],`<fieldset><legend>Holdings to share (up to five)</legend>${scope || '<p>No signatory controls a holding.</p>'}</fieldset>`) + payout;
  }

  function treatyAction(ctx,treaty) {
    const mine = ctx.own.id;
    const [from,to] = parties(treaty);
    if (![from,to].includes(mine)) return '';
    const status = treaty.status;
    const id = treaty.id;
    const principal = treaty.terms?.compensation;
    let buttons = '';
    if (openTreaty(status) || treatyPending(status)) {
      buttons += dialogBtn('Review terms','treaty-review:' + id,'journal');
    }
    if (status === 'awaiting-funding' && ctx.ui.state.chain?.enabled && principal?.payerId === mine) {
      buttons += dialogBtn('Fund compensation','escrow:' + id,'bch');
    }
    if (status === 'active') {
      buttons += dialogBtn('Manage treaty','treaty-review:' + id,'journal');
      const recorded = list(ctx.diplomacy.proofRecords).some(record => ['treaty-charter','treaty-compensation'].includes(record.kind) &&
        record.treaty === id && record.termsHash === treaty.termsHash);
      if (ctx.ui.state.chain?.enabled && !recorded) buttons += dialogBtn('Attest charter','attest:' + id,'bch');
    }
    return buttons;
  }
  function treatyTerms(ctx, terms = {}) {
    const payout = terms.compensation;
    return note(terms.note) + note(terms.hours ? number(terms.hours) + '-hour term' : '') +
      note(terms.territoryIds?.length ? 'Holdings · ' + terms.territoryIds.map(id=>siteName(ctx,id)).join(', ') : '') +
      note(payout ? 'Compensation · ' + town(ctx,payout.payerId) + ' → ' + town(ctx,payout.payeeId) : '') +
      note(payout?.kind === 'bch' ? bch(payout.satoshis) + ' BCH in escrow' : '') +
      costs(payout?.resources) +
      note(terms.permissions?.length ? 'Permissions · ' + terms.permissions.map(title).join(', ') : '') +
      note(terms.tribute ? number(terms.tribute*100) + '% production tribute' : '') +
      note(terms.cancellation ? 'Cancellation by mutual consent or six-hour notice' : '') +
      note(terms.breach ? 'A breach ends the agreement and carries a political penalty' : '');
  }
  function treatiesView(ctx) {
    const treaties = list(ctx.diplomacy.treaties);
    const actions = dialogBtn('Propose treaty','treaty-new','flag') + dialogBtn('Declare war','war-declare','war');
    const newDrafts = treaties.filter(treaty => !closed(treaty.status) && treaty.status !== 'active');
    const active = treaties.filter(treaty => treaty.status === 'active');
    const archive = treaties.filter(treaty => closed(treaty.status));
    const wars = list(ctx.diplomacy.wars).map(war=>row(town(ctx,war.from) + ' → ' + town(ctx,war.to),
      note(war.note) + deadline(war.expiresAt,ctx), '', badge(war.status)));
    return section('Kingdom treaties', `<div class="buttons">${actions}</div>`, 'Negotiate protections and trade permissions or declare an open war.') +
      section('Negotiations',newDrafts.length ? newDrafts.map(item=>treatyRow(ctx,item)).join('') : empty('No pending negotiations.')) +
      section('Active treaties',active.length ? active.map(item=>treatyRow(ctx,item)).join('') : empty('No active treaties.')) +
      section('War declarations',wars.length ? wars.join('') : empty('No public declarations.')) +
      section('Treaty archive',archive.length ? archive.map(item=>treatyRow(ctx,item)).join('') : empty('No expired or concluded treaties.'));
  }
  function treatyRow(ctx,treaty) {
    const id = treaty.id;
    const agreementName = label(types,treaty.kind);
    const kingdoms = parties(treaty).map(item=>town(ctx,item)).join(' · ');
    const expires = treaty.cancellationAt ?? treaty.expiresAt ?? treaty.acceptance?.fundingDueAt ?? treaty.respondBy;
    const records = list(ctx.diplomacy.proofRecords).filter(item=>item.treaty === id);
    const recordsList = records.map(item=>`<p><a class="politics-record" href="/verify/politics#${encodeURIComponent(item.id)}">${html(title(item.kind))}</a></p>`).join('');
    const charter = list(ctx.ui.state.politicalAssets).find(item => item.territoryId === id && item.version === treaty.version);
    return row(agreementName, note(kingdoms) + treatyTerms(ctx,treaty.terms ?? treaty.proposal?.terms) + deadline(expires,ctx) +
      recordsList + (charter ? `<p><a class="politics-record" href="/verify/politics#charter-${encodeURIComponent(charter.id)}">CashTokens charter · ${html(title(charter.status ?? charter.state))}</a></p>` : ''),
      treatyAction(ctx,treaty),badge(treaty.status));
  }
  function historyView(ctx) {
    const government = list(ctx.government.history);
    const diplomacy = list(ctx.diplomacy.history);
    const history = [...government,...diplomacy].sort((a,b) => (b.at || 0) - (a.at || 0));
    const entries = history.map(item => {
      const involved = [item.actor ?? item.kingdomId ?? item.proposerId, item.target ?? item.targetId].filter(Boolean).map(id=>town(ctx,id)).join(' · ');
      const txid = item.txid ?? item.receipt?.txid;
      const record = [item.category && label(types,item.category), (item.outcome || item.result) && title(item.outcome ?? item.result), item.winner && title(item.winner), formatDate(item.at)].filter(Boolean).join(' · ');
      return row(item.title ?? title(item.kind ?? item.type), note(item.text ?? item.message ?? involved) + note(record) +
        (item.eventHash ? `<p class="politics-record">${html(item.eventHash)}</p>` : '') + (txid ? `<p>${chainLink(txid)}</p>` : ''));
    });
    const chainRecords = list(ctx.diplomacy.proofRecords).map(item=>row(title(item.kind), note(town(ctx,item.treaty ?? item.conflict)) +
      (item.termsHash ? `<p class="politics-record">${html(item.termsHash)}</p>` : ''), `<a class="btn game-link" href="/verify/politics#${encodeURIComponent(item.id)}">Verify record</a>`)).join('');
    return section('Political chronicle', '<div class="buttons"><a class="btn game-link" href="/verify/politics">Verify ' + NETWORK_LABEL + ' records</a></div>' +
      (entries.length ? entries.join('') : empty('No political events have been recorded.'))) +
      section('On-chain commitments',chainRecords || empty('No political records have been anchored.'));
  }

  function tradeView(ctx) {
    const routes = list(ctx.diplomacy.routes ?? ctx.diplomacy.tradeRoutes);
    const actions = dialogBtn('Establish trade route','trade-open','market') + dialogBtn('Impose sanction','sanction-open','flag');
    const routeRows = routes.map(route => {
      const [from,to] = parties(route);
      const state = route.status ?? 'active';
      const action = [];
      if (from === ctx.own.id && state === 'active' && route.shipAfter <= ctx.gameNow) action.push(dialogBtn('Ship resources','trade-ship:' + route.id,'market'));
      if (route.blockadeId && route.shipAfter <= ctx.gameNow) action.push(dialogBtn('Smuggle cargo','trade-smuggle:' + route.id,'sword'));
      if (from === ctx.own.id && !closed(state) && route.rerouteAfter <= ctx.gameNow) action.push(dialogBtn('Reroute shipment','trade-reroute:' + route.id,'map'));
      return row(town(ctx,from) + ' → ' + town(ctx,to),note(list(route.territories).map(id=>siteName(ctx,id)).join(' → ')) +
        note([title(route.resource), route.capacity ? number(route.capacity) + ' units of cargo' : null].filter(Boolean).join(' · ')) + note(route.reason) +
        deadline(route.shipAfter,ctx,'Shipping resumes in') + deadline(route.endsAt,ctx), action.join(''),badge(state));
    });
    const pressureRows = list(ctx.diplomacy.sanctions).map(item => {
      const [from,to] = parties(item);
      const lift = item.status === 'active' && from === ctx.own.id ? command('Lift','flag',{type:'diplomacy-sanction-lift',id:item.id}) : '';
      const escort = item.canBreak ? dialogBtn('Plan blockade escort','sanction-break:' + item.id,'sword') : '';
      const action = lift + escort;
      return row(label(sanctions,item.kind),note(town(ctx,from) + ' → ' + town(ctx,to)) +
        note([item.territory && siteName(ctx,item.territory), item.resource && title(item.resource), item.rate && number(item.rate) + '%'].filter(Boolean).join(' · ')) +
        note(item.impact) + deadline(item.endsAt ?? item.expiresAt,ctx),action,badge(item.status));
    });
    const cargo = list(ctx.diplomacy.shipments).map(item=>row(number(item.amount) + ' ' + title(item.resource) + ' · ' +
      town(ctx,item.from) + ' → ' + town(ctx,item.to), deadline(item.arrivesAt,ctx,'Arrives in') +
      note([item.smuggle && 'Smuggled cargo', item.delivered > 0 && number(item.delivered) + ' delivered',item.refunded > 0 && number(item.refunded) + ' returned',
        item.lost > 0 && number(item.lost) + ' lost',item.tariffs?.length && number(item.tariffs.reduce((total, row)=> total + row.amount,0)) + ' tariff'].filter(Boolean).join(' · ')),
      '',badge(item.status)));
    return section('Trade operations',`<div class="buttons">${actions}</div>`,'Sanctions apply to routes and holdings the issuing kingdom controls.') +
      section('Trade routes',routeRows.length ? routeRows.join('') : empty('No registered trade routes.')) +
      section('Shipments',cargo.join('') || empty('No shipments dispatched.')) +
      section('Economic measures',pressureRows.length ? pressureRows.join('') : empty('No sanctions have been issued.'));
  }

  function councilView(ctx) {
    const federations = list(ctx.diplomacy.federations);
    const overview = council => {
      const proposals = list(council.proposals);
      const members = list(council.members).map(item=>row(town(ctx,item.id),note(title(item.role))));
      const ballots = proposals.map(proposal => {
      const yours = proposal.votes?.[ctx.own.id];
      const eligible = list(proposal.eligible ?? proposal.electorate).includes(ctx.own.id);
      const action = proposal.status === 'open' && eligible && yours == null ? dialogBtn('Cast vote','council-vote:' + proposal.id,'flag') : '';
      const count = Object.keys(proposal.votes ?? {}).length;
      return row(label(motions,proposal.kind),note(proposal.note) +
        note([proposal.payload?.target && town(ctx,proposal.payload.target), count + ' ballots', proposal.quorum && 'Quorum ' + number(proposal.quorum),
          proposal.threshold && number(proposal.threshold) + ' approvals required', yours && 'Your vote · ' + title(yours)].filter(Boolean).join(' · ')) + note(proposal.result?.reason) +
        deadline(proposal.endsAt ?? proposal.expiresAt ?? proposal.deadline,ctx,'Voting closes in'),action,badge(proposal.status));
      });
      return `<div class="buttons">${dialogBtn('Submit motion','council-open:' + council.id,'flag')}${dialogBtn('Contribute resources','council-contribute:' + council.id,'relief')}</div>` +
        row(title(council.policy) + ' treasury policy', costs(council.treasury) || note('No resources contributed.')) +
        members.join('') + (ballots.length ? ballots.join('') : empty('No council motions recorded.'));
    };
    const council = ctx.diplomacy.council;
    return section(council?.name ?? 'Alliance council', council ? overview(council) : empty('Join an alliance to take part in council votes.')) +
      section('Federations',federations.length ? federations.map(item=>row(item.name,note(item.members.map(id=>town(ctx,id)).join(' · ')),
        '',badge(item.status)) + (item.council ? '<div class="political-federation">' + overview(item.council) + '</div>' : '')).join('') :
        empty('Ratify a federation treaty to convene a shared council.'), 'Members vote on shared powers and retain separate assets.');
  }

  function renderDiplomaticDialog(ctx, mode, id) {
    const treaty = list(ctx.diplomacy.treaties).find(item=>item.id===id);
    const route = list(ctx.diplomacy.routes ?? ctx.diplomacy.tradeRoutes).find(item=>item.id===id);
    const kingdoms = foreignCities(ctx);
    const targetField = gameSelect('Kingdom','target',kingdoms,ctx.focused.id);
    const partnerStatus = new Set(list(ctx.diplomacy.treaties).filter(treaty => treaty.status === 'active' &&
      parties(treaty).includes(ctx.own.id) && treaty.terms?.permissions?.includes('trade')).flatMap(parties));
    const legacyPartners = list(ctx.ui.state.treaties).filter(treaty=>treaty.kind === 'trade' && treaty.status === 'active' &&
      [treaty.from,treaty.to].includes(ctx.own.alliance)).flatMap(treaty=>[treaty.from,treaty.to]);
    const partners = kingdoms.filter(([id])=>{
      const alliance = ctx.cities.find(city=>city.id===id)?.alliance;
      return partnerStatus.has(id) || Boolean(alliance && (alliance === ctx.own.alliance || legacyPartners.includes(alliance)));
    });
    const shared = new Set(list(ctx.diplomacy.treaties).filter(treaty => treaty.status === 'active' && parties(treaty).includes(ctx.own.id))
      .flatMap(treaty=>treaty.terms?.territoryIds ?? []));
    const waypoints = list(ctx.ui.state.territories).filter(site=>!site.protected && ((site.owner ?? site.controller) === ctx.own.id || shared.has(site.id)));
    const waypoint = gameSelect('Supply waypoint','territory',[['','Direct route'],...waypoints.map(site=>[site.id,site.name])]);
    const resourcesField = gameSelect('Resource','resource',choices(resources));
    const consent = words => `<label class="political-consent"><input name="consent" type="checkbox" value="true" required>${html(words)}</label>`;
    const description = input('Written terms','note',{maxlength:180,optional:true});
    const quantity = input('Quantity','amount',{type:'number',value:50,min:1,max:500});
    switch (mode) {
      case 'treaty-new':
        return ['Propose treaty',note('Sending a proposal costs 16 Food and 12 Wood.') +
          form('treaty-new',hidden('self',ctx.own.id) + targetField + gameSelect('Agreement','kind',types) + treatyFields(ctx) +
          description,'Send proposal','flag',!kingdoms.length)];
      case 'war-declare':
        return ['Declare war',note('Both kingdoms must be enrolled and outside protection. A declaration costs 65 Food and 40 Iron.') +
          form('war-declare',targetField + description,'Publish declaration','war',!kingdoms.length)];
      case 'treaty-review': {
        if (!treaty) return null;
        const current = treaty.proposal;
        const response = current && current.by !== ctx.own.id && current.respondBy > ctx.gameNow;
        const reply = {type:'diplomacy-treaty-respond',id,termsHash:current?.termsHash,version:current?.version};
        const action = response ? command(current.kind === 'cancel' ? 'Accept immediate cancellation' : 'Accept terms','flag',{...reply,accept:true},'primary') +
          command('Reject','x',{...reply,accept:false}) : '';
        const eligibleAmendment = !treaty.cancellationAt && (response && current.kind !== 'cancel' || !current && treaty.status === 'active');
        const amend = eligibleAmendment ? dialogBtn('Suggest amendment','treaty-amend:' + id,'journal') : '';
        const canCancel = treaty.status === 'active' && !treaty.cancellationAt || treaty.status === 'awaiting-funding';
        const withdrawal = openTreaty(treaty.status) && current?.by === ctx.own.id;
        const terminate = canCancel || withdrawal ? command(withdrawal ? 'Withdraw offer' : 'Request cancellation','x',{type:'diplomacy-treaty-cancel',id}) : '';
        const active = treaty.status === 'active' && current?.kind !== 'cancel' ? treatyTerms(ctx,treaty.terms) : '';
        const proposed = current?.kind !== 'cancel' && current ? section('Proposed terms · revision ' + current.version,
          treatyTerms(ctx,current.terms) + deadline(current.respondBy,ctx,'Response due in')) : '';
        const cancellation = current?.kind === 'cancel' ? deadline(treaty.cancellationAt,ctx,'Cancellation takes effect in') : '';
        return [label(types,treaty.kind),note(parties(treaty).map(value=>town(ctx,value)).join(' · ')) +
          (active || proposed ? active + proposed : treatyTerms(ctx,treaty.terms)) + cancellation +
          '<div class="buttons">' + action + amend + terminate + '</div>'];
      }
      case 'treaty-amend':
        return treaty ? ['Suggest amendment',form('treaty-amend',hidden('id',id) + hidden('self',ctx.own.id) +
          hidden('target',parties(treaty).find(party=>party !== ctx.own.id)) + hidden('kind',treaty.kind) +
          treatyFields(ctx,treaty) + input('Written terms','note',{maxlength:180,optional:true,value:(treaty.proposal?.terms ?? treaty.terms)?.note}),
          'Submit revised terms','flag')] : null;
      case 'escrow':
        return treaty ? ['Fund compensation escrow',treatyTerms(ctx,treaty.terms) +
          note('Checkout shows the agreed principal and the settlement fee. Your verified ' + NETWORK_LABEL + ' wallet must explicitly authorize funding.') +
          form('escrow',hidden('id',id) + consent('I authorize funding the agreed treaty compensation.'), 'Review escrow payment','bch')] : null;
      case 'attest':
        return treaty ? ['Attest treaty charter',note('' + NETWORK_LABEL + ' checkout shows the attestation fee and the four gameplay outputs.') +
          form('attest',hidden('id',id) + consent('I authorize a ' + NETWORK_LABEL + ' payment to record this charter.'), 'Review charter payment','bch')] : null;
      case 'trade-open':
        return ['Open trade route',note('A route costs 28 Food and 25 Wood. It requires a trade agreement or a shared alliance.') +
          form('trade-open',gameSelect('Trade partner','target',partners,ctx.focused.id) + resourcesField + waypoint,'Register route','market',!partners.length)];
      case 'trade-ship':
      case 'trade-smuggle':
      case 'trade-reroute':
        if (!route) return null;
        return [mode === 'trade-smuggle' ? 'Run a blockade' : mode === 'trade-reroute' ? 'Reroute shipment' : 'Ship resources',
          note(mode === 'trade-smuggle' ? 'Smuggling costs 18 Food and 12 Wood in addition to cargo. Part of the cargo may be lost.' :
            mode === 'trade-reroute' ? 'Changing waypoints costs 15 Wood and 20 Food.' : 'Shipping costs 4 Food in addition to cargo.') +
          form(mode,hidden('id',id) + (mode === 'trade-reroute' ? waypoint :
            hidden('resource',route.resource) + input('Units of ' + title(route.resource),'amount',{type:'number',value:10,min:10,
              max:mode === 'trade-smuggle' ? 50 : route.capacity})),
          mode === 'trade-smuggle' ? 'Commit supplies' : mode === 'trade-reroute' ? 'Change route' : 'Dispatch shipment','market')];
      case 'sanction-open':
        return ['Impose sanction',note('Measures cost 27 Food and 22 Wood. Border blockades require a strategic holding and cost 55 Food, 34 Iron and 30 Wood.') +
          form('sanction-open',targetField + gameSelect('Economic measure','kind',sanctions) +
          gameSelect('Affected cargo','resource',[['','All cargo'],...choices(resources)]) + input('Duration in hours','hours',{type:'number',value:6,min:1,max:24}) +
          gameSelect('Controlled holding','territory',[['','Routes through my market'], ...sitesOf(ctx,ctx.own.id).filter(site=>!site.protected).map(site=>[site.id,site.name])]),
          'Impose measure','flag',!kingdoms.length)];
      case 'sanction-break':
        return list(ctx.diplomacy.sanctions).some(item=>item.id === id && item.canBreak) ?
          ['Escort cargo through the blockade',note('The escort costs 35 Iron, 60 Food and 26 Wood. Its success depends on military strength and may cost troops.') +
            form('sanction-break',hidden('id',id),'Order escort','war')] : null;
      case 'council-open':
      case 'council-contribute': {
        const council = [ctx.diplomacy.council,...list(ctx.diplomacy.federations).map(federation=>federation.council)].find(item=>item?.id===id);
        if (!council) return null;
        const councilField = hidden('councilId',id);
        if (mode === 'council-contribute') return ['Contribute to ' + council.name,
          note('Contributions move earned resources from your warehouse to the council reserve.') +
          form(mode,councilField + resourcesField + quantity,'Contribute resources','relief')];
        const members = council.members.map(item=>[item.id,town(ctx,item.id)]);
        const foreign = kingdoms.filter(([key])=>!members.some(([id])=>id===key));
        return ['Submit a council motion',note('A motion costs the proposer 12 Food and 8 Wood. Foreign motions can also spend council reserves.') +
          form(mode,councilField + gameSelect('Motion','kind',motions) +
            group('kind',['election','appoint','spend'],gameSelect('Council member','member',members)) +
            group('kind',['war','alliance','peace','sanction'],gameSelect('Foreign kingdom','target',foreign,ctx.focused.id)) +
            group('kind',['appoint'],gameSelect('Council role','role',roles)) +
            group('kind',['policy'],gameSelect('Treasury policy','policy',policies,council.policy)) +
            group('kind',['spend'],resourcesField + quantity) +
            group('kind',['sanction'],gameSelect('Economic measure','measure',sanctions) +
              gameSelect('Affected cargo','sanctionResource',choices(resources)) + input('Duration in hours','hours',{type:'number',value:6,min:1,max:24}) +
              gameSelect('Controlled holding','territory',[['','Routes through my market'], ...sitesOf(ctx,ctx.own.id).filter(site=>!site.protected).map(site=>[site.id,site.name])])) +
            description,'Call vote','flag')];
      }
      case 'council-vote':
        return ['Cast council vote',form('council-vote',hidden('id',id) + gameSelect('Your ballot','vote',[['yes','Approve'],['no','Oppose'],['abstain','Abstain']]), 'Record ballot','flag')];
      default:
        return null;
    }
  }
  return {treatiesView, tradeView, councilView, historyView, renderDiplomaticDialog};
}

export function diplomaticFormAnswer(mode,data) {
  const {id,target,kind,note,resource,territory,vote} = data;
  const terms = {hours:Number(data.hours),note};
  if (kind === 'territory-sharing') terms.territoryIds = Object.keys(data).filter(key=>key.startsWith('holding-')).map(key=>data[key]);
  if (data.payout) {
    const {self,payer} = data;
    const same = payer !== 'other';
    const parties = {payerId:same ? self : target,payeeId:same ? target : self};
    terms.compensation = data.payout === 'bch' ? {kind:'bch',...parties,satoshis:Number(data.satoshis)} :
      data.payout === 'resources' ? {kind:'resources',...parties,resources:Object.fromEntries(
        resources.map(key=>[key,Number(data['compensation-' + key])]).filter(([,quantity])=>quantity > 0))} : null;
  }
  switch (mode) {
    case 'treaty-new': return {type:'diplomacy-treaty-propose',target,kind,terms};
    case 'treaty-amend': return {type:'diplomacy-treaty-amend',id,terms};
    case 'war-declare': return {type:'diplomacy-war-declare',target,note};
    case 'trade-open': return {type:'diplomacy-trade-open',target,resource,territory:territory || undefined};
    case 'trade-ship':
    case 'trade-smuggle': return {type:'diplomacy-' + mode,id,resource,amount:Number(data.amount)};
    case 'trade-reroute': return {type:'diplomacy-trade-reroute',id,territory:territory || undefined};
    case 'sanction-open': return {type:'diplomacy-sanction-impose',target,kind,resource:resource || undefined,territory:territory || undefined,hours:Number(data.hours)};
    case 'sanction-break': return {type:'diplomacy-sanction-break',id};
    case 'council-open': return {type:'diplomacy-council-propose',councilId:data.councilId,kind,target:data.member ?? target,note,
      resource:data.sanctionResource ?? resource,amount:data.amount ? Number(data.amount) : undefined,role:data.role,policy:data.policy,
      measure:data.measure,territory:territory || undefined,hours:data.hours ? Number(data.hours) : undefined};
    case 'council-contribute': return {type:'diplomacy-council-contribute',councilId:data.councilId,resource,amount:Number(data.amount)};
    case 'council-vote': return {type:'diplomacy-council-vote',id,vote};
    default: return null;
  }
}
