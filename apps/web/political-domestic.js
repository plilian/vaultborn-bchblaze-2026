import { gameSelect } from './game-select.js';
import { btn, command, costs, duration, empty, formatDate, html, list, number, tag, title } from './view.js';
import { NETWORK, NETWORK_LABEL } from './network.js';

const taxes = [['exempt', 'Exempt · 0%'], ['balanced', 'Balanced · 8%'], ['heavy', 'Heavy · 15%']];
const stances = [
  ['civic', 'Civic Stewardship'], ['commerce', 'Merchant Charter · +6% production'],
  ['mobilization', 'Military Mobilization · +3% morale, −5% production'],
];
const decisions = [
  ['relief', 'Emergency relief', {food:90, wood:35}, 'Loyalty +9 · Legitimacy +2 · Unrest −7 · +4% production for four hours'],
  ['public-works', 'Public works', {wood:90, stone:90, iron:22}, 'Legitimacy +5 · Loyalty +5 · Unrest −4 · +4% production for four hours'],
  ['audit', 'Investigate corruption', {iron:28, crystal:13}, 'Legitimacy +7 · Loyalty +2 · Unrest −3'],
  ['outreach', 'Diplomatic outreach', {food:45, crystal:12}, 'Diplomatic Influence +7 · Unrest −2'],
  ['levy', 'Requisition civic reserves', {food:25}, 'Legitimacy −2 · Loyalty −6 · Unrest +6 · Move up to 80 of each civic resource into your warehouse'],
];
const kinds = [
  ['coup', 'Coup d’État', 'Requires 28 unrest or loyalty below 50 and 10 influence.'],
  ['civil-war', 'Civil War', 'Requires 35 unrest, 15 influence and an owned frontier holding.'],
  ['independence', 'Independence Movement', 'Requires a protectorate or an occupied former holding, and 10 influence.'],
  ['coalition', 'Coalition War', 'Requires 18 influence and a kingdom eligible for combat.'],
];
const supportModes = [['troops', 'Troops'], ['resources', 'Resources'], ['intel', 'Intelligence'], ['equipment', 'Equipment'], ['logistics', 'Logistics']];
const sides = [['challenger', 'Challenger'], ['government', 'Government']];
const configuredOptions = definitions => Object.entries(definitions ?? {}).map(([key,def]) => [key, def.name ?? def.label ?? title(key)]);
const nowTime = (value, now) => `<time data-until="${html(value)}">${duration(value-now)}</time>`;
const hidden = (name, value) => `<input type="hidden" name="${html(name)}" value="${html(value)}">`;
const note = text => `<p class="politics-note">${html(text)}</p>`;
const statusTone = value => ['active','resolved','success'].includes(value) ? 'success' : value === 'cancelled' ? 'danger' : 'quiet';
const status = value => tag(title(value), statusTone(value));
const territorialOwner = site => site.owner ?? site.controller ?? site.claim?.owner;
const conflictName = value => kinds.find(([key]) => value === key)?.[1] ?? title(value);
const total = values => Object.values(values ?? {}).reduce((sum, num) => sum + Number(num || 0), 0);
const percent = value => useful(value) ? number((value - 1) * 100) + '%' : '—';
const useful = value => typeof value === 'number' && Number.isFinite(value);
const dialogBtn = (label,id,glyph='flag') => btn(label,glyph,{modal:'political',id},'primary');
const townName = (ctx,id) => ctx.kingdom(id) ?? 'Unknown kingdom';
const findSite = (ctx,id) => list(ctx.ui.state.territories).find(site => site.id === id);

export function domesticViews({section, row, form, input, record}) {
  function governmentView(ctx) {
    const kingdom = record(ctx, ctx.own);
    const cooldowns = ctx.government.cooldowns ?? kingdom.cooldowns ?? {};
    const policy = form('government-policy',
      gameSelect('Resource taxation', 'tax', taxes, kingdom.tax) + gameSelect('Government stance', 'stance', stances, kingdom.stance) +
      (kingdom.policyAt > ctx.gameNow ? `<p>Policy review in ${nowTime(kingdom.policyAt,ctx.gameNow)}</p>` : '') +
      note('Raising the tax rate costs loyalty and increases unrest. Civic reserves fund political decisions.'),
      'Adopt policy','crown',kingdom.policyAt > ctx.gameNow);
    const reserve = row('Civic resource reserves', costs(kingdom.civic) || note('No civic resources collected.'));
    const modifiers = kingdom.production != null || kingdom.morale != null ?
      row('Kingdom modifiers', note('Production ' + percent(kingdom.production) + ' · Military morale ' + percent(kingdom.morale))) : '';
    const interventions = kingdom.recoveryUntil > ctx.gameNow ? row('Political recovery', `<p>Conflicts reopen in ${nowTime(kingdom.recoveryUntil,ctx.gameNow)}</p>`) : '';
    const decisionCooldown = cooldowns.decision ?? kingdom.decisionAt;
    const civicRows = decisions.map(([decision,label,cost,consequence]) => row(label,note(consequence) + costs(cost),
      command('Enact', 'flag', {type:'government-decision',decision}, '', decisionCooldown > ctx.gameNow))).join('');
    return `<div class="politics-split">${section('Government policy', policy + reserve + modifiers + interventions)}
      ${section('Civic decisions', (decisionCooldown > ctx.gameNow ? `<p>Next decree available in ${nowTime(decisionCooldown,ctx.gameNow)}</p>` : '') + civicRows)}</div>` +
      section('Political crises', renderCrises(ctx) + dialogBtn('Raise political issue','event-open','flag'));
  }

  function renderCrises(ctx) {
    const crises = list(ctx.government.crises).filter(item => item.canRespond || [item.target,item.actor].includes(ctx.own.id));
    return crises.length ? crises.map(crisis => {
      const state = crisis.status ?? 'open';
      const options = list(crisis.choices ?? crisis.options);
      const buttons = crisis.canRespond ? options.map(choice => `<div class="political-event-choice">
        ${command(choice.label, 'flag', {type:'political-event-respond',event:crisis.id,choice:choice.id})}${costs(choice.cost)}</div>`).join('') : '';
      const deadline = crisis.deadline ?? crisis.endsAt;
      return row(crisis.title ?? title(crisis.kind), note([crisis.actor && townName(ctx,crisis.actor), crisis.target && crisis.target !== crisis.actor && townName(ctx,crisis.target), title(crisis.result?.outcome)].filter(Boolean).join(' · ')) +
        (deadline > ctx.gameNow ? `<p>Response due in ${nowTime(deadline,ctx.gameNow)}</p>` : ''), buttons, status(state));
    }).join('') : empty('No crises require a response.');
  }

  function conflictsView(ctx) {
    const battles = list(ctx.government.conflicts);
    const active = battles.filter(battle => !['resolved','cancelled'].includes(battle.status));
    const past = battles.filter(battle => !active.includes(battle));
    const requests = list(ctx.government.requests).map(request => {
      const incoming = request.to === ctx.own.id;
      const pending = request.status === 'open' && request.expiresAt > ctx.gameNow;
      const conflict = battles.find(item=>item.id===request.conflict);
      const detail = [title(request.side) + ' faction', conflict && conflictName(conflict.kind)].filter(Boolean).join(' · ');
      return row((incoming ? 'From ' : 'To ') + townName(ctx,incoming ? request.from : request.to), note(detail) +
        (pending ? `<p>Respond in ${nowTime(request.expiresAt,ctx.gameNow)}</p>` : ''),
        incoming && pending && conflict ? dialogBtn('Answer request','conflict-support:' + request.id,'relief') : '', status(request.status));
    });
    return section('Open a conflict', '<div class="politics-split">' + kinds.map(([key,label,requirements]) => row(label,note(requirements),
      dialogBtn('Plan', 'conflict-open:' + key, 'war'))).join('') + '</div>', 'Mobilization requires at least 24 available troops, seasonal enrollment and an exposed kingdom.') +
      section('Active conflicts', active.length ? active.map(item => conflictRow(ctx,item)).join('') : empty('No conflicts are mobilizing.')) +
      section('Intervention requests', requests.length ? requests.join('') : empty('No private requests for military aid.')) +
      section('Resolved conflicts', past.length ? past.map(item => conflictRow(ctx,item)).join('') : empty('No completed conflicts.'));
  }

  function conflictRow(ctx, item) {
    const isLocal = [item.initiator, item.target].includes(ctx.own.id);
    const isActive = !['resolved','cancelled'].includes(item.status);
    const title = conflictName(item.kind) + ' · ' + townName(ctx, item.initiator);
    const location = [item.target !== item.initiator ? townName(ctx,item.target) : null, findSite(ctx,item.territory)?.name].filter(Boolean).join(' · ');
    const lead = item.winner ? note('Victory for ' + (item.winner === 'challenger' ? 'Challenger' : item.winner === 'government' ? 'Government' : item.winner)) :
      item.nextAt > ctx.gameNow ? `<p>Stage ${Number(item.stage ?? 0) + 1} begins in ${nowTime(item.nextAt,ctx.gameNow)}</p>` : '';
    const score = item.score ? note('Challenger ' + number(item.score.challenger) + ' · Government ' + number(item.score.government)) : '';
    let buttons = dialogBtn('Campaign record','conflict-record:' + item.id, 'journal');
    if (isActive && isLocal) buttons += dialogBtn('Set faction orders','conflict-order:' + item.id,'shield');
    const open = item.status === 'organizing' && item.nextAt > ctx.gameNow;
    const canSupport = open && sides.some(([key]) => item.sides?.[key]?.canSupport);
    const covert = open && !isLocal && item.kind !== 'coalition' && ctx.ui.state.intel?.[item.target]?.expiresAt > ctx.gameNow &&
      ctx.ui.state.intel[item.target].confidence >= .55;
    if (canSupport || covert) buttons += dialogBtn(isLocal ? 'Reinforce' : 'Offer support','conflict-support:' + item.id, 'relief');
    if (canSupport && ctx.ui.state.chain?.enabled) buttons += dialogBtn('BCH contribution','paid-support:' + item.id, 'bch');
    for (const [key,label] of sides) if (open && item.sides?.[key]?.requestTargets?.length) {
      buttons += dialogBtn('Request ' + label.toLowerCase() + ' aid','conflict-request-' + key + ':' + item.id,'relief');
    }
    return row(title,note(location) + lead + score,buttons,status(item.status));
  }

  function renderConflictDialog(ctx, name, id) {
    const request = list(ctx.government.requests).find(item=>item.id===id && item.to===ctx.own.id && item.status==='open');
    const conflict = list(ctx.government.conflicts).find(item => item.id === (request?.conflict ?? id));
    switch (name) {
      case 'conflict-open': {
        const kind = kinds.find(([key]) => key === id);
        if (!kind) return null;
        const all = list(ctx.ui.state.territories).filter(site => !site.protected);
        const targets = ctx.cities.filter(city => city.id !== ctx.own.id && city.eligibility?.ok).map(city => [city.id, city.name]);
        const sites = all.filter(site => id === 'independence' ?
          site.owner !== ctx.own.id && list(site.history).some(entry => entry.previousOwner === ctx.own.id && entry.kind === 'conquered') : territorialOwner(site) === ctx.own.id);
        const siteOptions = sites.map(site => [site.id, site.name]);
        if (id === 'coup' || id === 'independence') siteOptions.unshift(['', id === 'coup' ? 'Capital' : 'Active protectorate']);
        const field = id === 'coalition' ? gameSelect('Rival kingdom','target',targets,ctx.focused.id) : gameSelect('Frontier holding','territory',siteOptions);
        return [kind[1], note(kind[2]) + note('Mobilization spends 100 Food, 50 Wood, 24 Iron and 9 Crystal. Available soldiers deploy to both local factions or to opposing kingdoms.') +
          form('conflict-open', hidden('kind',id) + field, 'Order mobilization','war', id === 'coalition' ? !targets.length : !siteOptions.length)];
      }
      case 'event-open': {
        const events = ctx.government.rules?.events ?? {};
        const options = Array.isArray(events) ? events.map(item => typeof item === 'string' ? [item,title(item)] : [item.kind ?? item.id,item.label ?? item.name]) : configuredOptions(events);
        const kingdoms = [['','Your kingdom'],...ctx.cities.filter(city=> !city.npc && city.id !== ctx.own.id).map(city=>[city.id,city.name])];
        const territory = [['','No holding'],...list(ctx.ui.state.territories).filter(site=>!site.protected).map(site=>[site.id,site.name])];
        return ['Raise a political issue', note('Opening an issue uses civic resources or warehouse supplies. Choosing a response may have a separate cost.') + form('event-open', gameSelect('Issue','kind',options) + gameSelect('Kingdom','target',kingdoms) +
          gameSelect('Frontier holding','territory',territory), 'Open proceedings','flag',!options.length)];
      }
      case 'conflict-support': {
        if (!conflict) return null;
        const units = configuredOptions(ctx.ui.state.config.units).filter(([key])=>ctx.own.troops?.[key] > 0);
        const eligibleSides = request ? sides.filter(([key])=>key===request.side) : sides;
        const available = eligibleSides.filter(([key])=>conflict.sides?.[key]?.canSupport);
        const packages = ctx.government.rules?.modeCosts ?? {};
        const modes = available.length ? (units.length ? supportModes : supportModes.slice(1)) : supportModes.filter(([key])=>key === 'intel');
        const fees = modes.filter(([key])=>packages[key]).map(([key,label])=>row(label,costs(packages[key]))).join('');
        return ['Support a faction', note('Commit troops or supplies to an eligible faction. Deployed troops can take casualties.') +
          form('conflict-support', hidden('id',conflict.id) + gameSelect('Faction','side',available.length ? available : eligibleSides.slice(0,1)) +
            gameSelect('Contribution','mode',modes) + (units.length ? gameSelect('Unit for troop commitment','unit',units) +
            input('Troops to send if selected','count',{type:'number', value:1, min:1, max:12}) : ''), 'Commit support','relief') + fees];
      }
      case 'conflict-request-challenger':
      case 'conflict-request-government': {
        const side = name.endsWith('challenger') ? 'challenger' : 'government';
        const options = list(conflict?.sides?.[side]?.requestTargets).map(id=>[id,townName(ctx,id)]);
        if (!conflict || !options.length) return null;
        return ['Request military aid', note('Only this kingdom can answer. Contributions use the normal military and resource limits.') +
          form('conflict-request', hidden('id',conflict.id) + hidden('side',side) + gameSelect('Allied kingdom','target',options), 'Send aid request','relief')];
      }
      case 'conflict-order': {
        if (!conflict) return null;
        const eligibleSides = sides.filter(([key]) => conflict.sides?.[key]?.captain === ctx.own.id ||
          (key === 'challenger' ? conflict.initiator : conflict.target) === ctx.own.id);
        return ['Set faction orders', form('conflict-order', hidden('id',id) + gameSelect('Faction','side',eligibleSides) +
          gameSelect('Tactic','tactic',configuredOptions(ctx.ui.state.config.tactics),ctx.own.tactic) +
          gameSelect('Formation','formation',configuredOptions(ctx.ui.state.config.formations),ctx.own.formation), 'Issue orders','shield',!eligibleSides.length)];
      }
      case 'paid-support': {
        if (!conflict) return null;
        const consent = '<label class="political-consent"><input type="checkbox" name="consent" value="true" required> I authorize a ' + NETWORK_LABEL + ' payment for this faction’s support operation.</label>';
        return ['Authorize BCH contribution', note('The price is split by your own transaction: 50% into your War Chest, 20% season prizes, 20% Development, 10% burned. The ' + NETWORK_LABEL + ' checkout shows the amount and every output before approval.') +
          form('paid-support',hidden('id',id) + gameSelect('Faction','side',sides.filter(([key])=>conflict.sides?.[key]?.canSupport)) + consent, 'Review wallet payment','bch')];
      }
      case 'conflict-record': {
        if (!conflict) return null;
        const casualties = Object.entries(conflict.casualties ?? {});
        const seed = conflict.seedCommitment ? `<p class="politics-record">Conflict commitment ${html(conflict.seedCommitment)}</p>` : '';
        const reports = list(conflict.rounds);
        const receipts = list(conflict.receipts).filter(item => item.txid);
        const concluded = ['resolved','cancelled'].includes(conflict.status);
        const replayIds = new Set(list(ctx.ui.state.battles).map(report=>report.id));
        return ['Campaign record', note(conflictName(conflict.kind) + ' · ' + townName(ctx,conflict.initiator)) + seed +
          (reports.length ? reports.map((report,index) => row(report.name ?? ('Stage ' + (report.stage ?? index+1)),
            note([title(report.winner), report.at && formatDate(report.at)].filter(Boolean).join(' · ')),
            concluded && replayIds.has(report.battleId) ? btn('View battle','journal',{modal:'battle',id:report.battleId}) : '')).join('') : empty('No battles resolved in this conflict.')) +
          (!concluded && reports.length ? note('Front replays are sealed until this conflict ends.') : '') +
          (casualties.length ? section('Recorded casualties',casualties.map(([city,losses]) => row(townName(ctx,city),note(number(total(losses)) + ' deployed troops lost'))).join('')) : '') +
          (receipts.length ? section('Verified contributions',receipts.map(item => row('' + NETWORK_LABEL + ' transaction', `<a class="politics-record" href="/verify/politics?txid=${encodeURIComponent(item.txid)}">${html(item.txid)}</a>`)).join('')) : '')];
      }
      default: return null;
    }
  }

  return {governmentView, conflictsView, renderConflictDialog};
}

export function domesticFormAnswer(mode, data) {
  switch (mode) {
    case 'government-policy': return {type:mode,tax:data.tax,stance:data.stance};
    case 'event-open':
    case 'conflict-open': return {type:'political-' + mode,kind:data.kind,target:data.target || undefined,territory:data.territory || undefined};
    case 'conflict-support': return {type:'political-conflict-support',conflict:data.id,side:data.side,mode:data.mode,unit:data.unit || undefined,count:Number(data.count)};
    case 'conflict-order': return {type:'political-conflict-order',conflict:data.id,side:data.side,tactic:data.tactic,formation:data.formation};
    case 'conflict-request': return {type:'political-conflict-request',conflict:data.id,side:data.side,target:data.target};
    default: return null;
  }
}
