const classes=['infantry','shield','archer','cavalry','siege','mage'];
const sides=['attacker','defender'];
const colors=[['#4fbf8c','#dcfadf','#21473b'],['#db6c50','#ffe3b9','#65363a']];
const ranks={shield:.12,infantry:.078,cavalry:.14,archer:-.012,siege:-.084,mage:-.045};
const textures=new Map();
const clamp=(value,low=0,high=1)=>Math.max(low,Math.min(high,value));
const mix=(a,b,t)=>a+(b-a)*t;
const ease=value=>clamp(value)**2*(3-2*clamp(value));
const sum=roster=>Object.values(roster??{}).reduce((count,value)=>count+value,0);
const random=key=>Math.sin(key*73.136+39.1)*18153.453%1;

export const battleCampNames=battle=>battle.attacker===battle.defender && battle.kind==='political-front'
  ? {attacker:'Challenger',defender:'Government'} : {attacker:battle.attackerName,defender:battle.defenderName};

export function battleTimeline(battle,trace,{reducedMotion=false}={}) {
  const initial=Object.fromEntries(sides.map(side=>[side,{...battle.input?.[side]?.troops}]));
  const events=battle.events??battle.replay??[];
  const traced=events.length>0 && trace?.length===events.length && trace.every((row,index)=>
    sides.every(side=>sum(row[side]?.losses)===events[index][side+'Loss']));
  const intro=reducedMotion?250:1850;
  let cursor=intro;
  const rounds=events.map((event,index)=>{
    const length=reducedMotion?480:index<3?1900:index<6?2450:1650;
    const start=cursor;
    const impact=start+length*.57;
    cursor+=length;
    const before=Object.fromEntries(sides.map(side=>[side,index===0?(sum(initial[side]) || event[side+'Remaining']+event[side+'Loss']):events[index-1][side+'Remaining']]));
    return {event,start,length,impact,before,detail:traced?trace[index]:null};
  });
  const conclusion=cursor;
  const duration=conclusion+(reducedMotion?320:1300);
  const marks=[{at:0,cue:'battle-march'},...rounds.flatMap((round,index)=>{
    const prior=Object.fromEntries(sides.map(side=>[side,{...initial[side]}]));
    if (traced) for (const earlier of trace.slice(0,index))
      for (const side of sides) for (const unit of classes) prior[side][unit]=(prior[side][unit]??0)-(earlier[side].losses[unit]??0);
    const sounds=[];
    if (sides.some(side=>prior[side].archer>0)) sounds.push({at:round.start+round.length*.25,cue:'battle-volley'});
    if (index%3===0&&sides.some(side=>prior[side].mage>0)) sounds.push({at:round.start+round.length*.39,cue:'battle-spell'});
    if (round.event.attackerLoss || round.event.defenderLoss) sounds.push({at:round.impact,
      cue:sides.some(side=>round.detail?.[side].losses.shield>0 || round.detail?.[side].losses.siege>0)?'battle-heavy':'battle-clash'});
    return sounds;
  })];

  function at(value) {
    const elapsed=clamp(value,0,duration);
    const current=rounds.find(row=>elapsed>=row.start && elapsed<row.start+row.length) ??
      (elapsed>=conclusion?rounds.at(-1):null);
    const ending=elapsed>=conclusion;
    const progress=current?clamp((elapsed-current.start)/current.length):0;
    const hit=current && elapsed>=current.impact;
    const roundLosses=Object.fromEntries(sides.map(side=>[side,hit?current.event[side+'Loss']:0]));
    const remaining=Object.fromEntries(sides.map(side=>[side,current?(hit?current.event[side+'Remaining']:current.before[side]):sum(initial[side])]));
    const casualties=Object.fromEntries(sides.map(side=>[side,(sum(initial[side])||rounds[0]?.before[side]||0)-remaining[side]]));
    const alive=Object.fromEntries(sides.map(side=>[side,{...initial[side]}]));
    if (traced) for (const round of rounds) {
      if (round.impact>elapsed) break;
      for (const side of sides) for (const unit of classes)
        alive[side][unit]=(alive[side][unit]??0)-(round.detail[side].losses[unit]??0);
    }
    return {elapsed,round:current?.event.round??0,phase:current?.event.phase??'Muster',progress,
      current,ending,finished:elapsed===duration,hit:Boolean(hit),remaining,roundLosses,casualties,alive};
  }
  return {at,initial,rounds,marks,traced,intro,conclusion,duration};
}

function sprite(type,side) {
  const key=type+(side?'-crimson':'');
  if (!textures.has(key)) {
    const img=new Image();
    img.src='/art/unit-'+key+'.webp';
    textures.set(key,img);
  }
  return textures.get(key);
}

function texture(ctx,img,x,y,w,h) {
  if (img?.complete&&img.naturalWidth) {
    const k=img.naturalWidth/img.naturalHeight;
    ctx.drawImage(img,x-h*k/2,y-h,h*k,h);
  } else if (w>0) {
    ctx.beginPath(); ctx.roundRect(x-w/2,y-h*.65,w,h*.65,[w*.4,w*.4,2,2]); ctx.fill();
  }
}

function banner(ctx,x,y,color,clock,direction) {
  ctx.save();
  ctx.translate(x,y);
  ctx.strokeStyle='#d4ac68'; ctx.lineWidth=1.6;
  ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,-43);ctx.stroke();
  ctx.fillStyle=color;
  const curl=Math.sin(clock*3+x*.03)*4;
  ctx.beginPath();ctx.moveTo(1,-42);ctx.quadraticCurveTo(direction*17,-46,direction*33,-38+curl);
  ctx.lineTo(direction*23,-32+curl*.6);ctx.lineTo(direction*31,-25+curl);
  ctx.quadraticCurveTo(direction*14,-29,1,-25);ctx.closePath();ctx.fill();
  ctx.restore();
}

function badge(ctx,x,y,text,color,hollow=false) {
  ctx.font='700 10px system-ui';
  const width=ctx.measureText(text).width+8;
  ctx.fillStyle=hollow?'#1b1815cb':'#111c18e8';
  ctx.beginPath();ctx.roundRect(x-width/2,y,width,13,3);ctx.fill();
  ctx.fillStyle=color;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,x,y+6.8);
}

const depictRoster=(initial,side)=>classes.flatMap((type,index)=>{
  const count=initial[type]??0;
  const slots=count>=12?3:count>=4?2:count?1:0;
  return Array.from({length:slots},(_,i)=>({type,slot:i,order:index,image:sprite(type,side),
    seed:(index*7+i*11+side*13)%43/43}));
});
function pullFormation(formation,type,lane) {
  if (formation==='wedge') return .042*(1-Math.abs(lane))*(type==='infantry'||type==='cavalry'?1:0);
  if (formation==='screen') return .014*Math.abs(lane)*(type==='archer'||type==='mage'?1:0);
  return 0;
}

export function mountBattleMotion(scene,battle,timeline,{reducedMotion=false}={}) {
  const canvas=scene.querySelector('canvas')??document.createElement('canvas');
  canvas.className='battle-canvas';canvas.setAttribute('aria-hidden','true');
  if(!canvas.isConnected) scene.prepend(canvas);
  const ctx=canvas.getContext('2d');
  if (!ctx) return {draw:()=>{},destroy:()=>{}};
  scene.classList.add('has-sprites');
  const banners=sides.map((side,i)=>depictRoster(timeline.initial[side],i));
  let last=0;
  let bounds=scene.getBoundingClientRect();
  let disposed=false;
  const observer=new ResizeObserver(entries=>{bounds=entries[0].contentRect;draw(last);});
  observer.observe(scene);
  for (const group of banners.flat()) if (!group.image.complete)
    group.image.addEventListener('load',()=>{if(!disposed) draw(last);},{once:true});

  function draw(milliseconds) {
    last=milliseconds;
    const {width,height}=bounds;
    if (!(width>0 && height>0)) return;
    const ratio=Math.min(2,devicePixelRatio||1);
    const px=Math.round(width*ratio), py=Math.round(height*ratio);
    if (canvas.width!==px||canvas.height!==py) {canvas.width=px;canvas.height=py;}
    const frame=timeline.at(milliseconds);
    const t=reducedMotion?0:milliseconds/1000;
    const {current,progress}=frame;
    const impact=frame.hit && current ? clamp((frame.elapsed-current.impact)/570) : 0;
    const tookLoss=sum(frame.roundLosses)>0;
    const shake=tookLoss&&!reducedMotion&&frame.hit&&impact<.65?(1-impact)*Math.sin(impact*37)*3.2:0;
    const opening=ease(milliseconds/(timeline.intro+900));
    const relief=ease((milliseconds-timeline.conclusion)/(timeline.duration-timeline.conclusion));
    ctx.setTransform(ratio,0,0,ratio,0,0);
    ctx.clearRect(0,0,width,height);
    ctx.save();ctx.translate(shake,shake*.25);
    if(!reducedMotion) {
      for(let i=0;i<27;i++) {
        const x=(i*.139+t*(.012+i%3*.006))%1.05*width;
        const y=(.47- .27*((i*.13+t*.19)%1))*height;
        ctx.globalAlpha=.1+ .28*(Math.sin(t*2+i)*.5+.5);
        ctx.fillStyle=i%4?'#c49362':'#f7d698';
        ctx.beginPath();ctx.arc(x,y,i%4?1:1.6,0,Math.PI*2);ctx.fill();
      }
      ctx.globalAlpha=1;
    }
    const size=clamp(width*.089,30,70);
    const units=[];
    for (const [i,side] of sides.entries()) {
      const direction=i?-1:1;
      const orders=battle.input?.[side]??{};
      const guard=current?.detail?.earlyGuard<1 && i===1;
      const charge=!reducedMotion&&current&&!frame.ending?Math.sin(Math.PI*ease((progress-.17)*2.15)):0;
      const retreat=battle.winner===side?.017:-.112;
      const push=width*(.152*opening+retreat*relief);
      const base=width*(i?.82:.18)+direction*push;
      const palette=colors[i];
      banner(ctx,base-direction*width*.095,height*.65,palette[0],t,direction);
      if (!timeline.traced) {
        badge(ctx,base,height*.64,String(frame.remaining[side]),palette[1]);
      }
      const activeRoster=timeline.traced?frame.alive[side]:frame.round?{}:timeline.initial[side];
      for (const group of banners[i]) {
        const lane=((group.order*3+group.slot*3)%9-4)/4;
        const formation=pullFormation(orders.formation,group.type,lane);
        const x=base+direction*width*(ranks[group.type]+formation-.024*group.slot-.019*Math.abs(lane));
        const y=height*(.682+.178*lane+.009*group.slot);
        const actual=activeRoster[group.type]??0;
        const count=Math.floor(actual/3)+(group.slot<actual%3?1:0);
        // Small classes use fewer display groups; allocate the full count to those groups.
        const slots=timeline.initial[side][group.type]>=12?3:timeline.initial[side][group.type]>=4?2:1;
        const displayed=slots===3?count:Math.floor(actual/slots)+(group.slot<actual%slots?1:0);
        if(displayed) units.push({x:x+direction*charge*size*(group.type==='cavalry'?.46:.19),y,group,direction,palette,
          size:size*(group.type==='cavalry'?1.26:group.type==='siege'?1.16:group.type==='mage'?1.08:1),
          label:timeline.traced&&displayed>1?'×'+displayed:'',charge,guard,hurt:current?.detail?.[side].losses[group.type]>0&&frame.hit&&impact<.48});
        const fallen=frame.hit&&current?.detail?.[side].losses[group.type];
        if(fallen&&group.slot===0) {
          const fall=reducedMotion?1:ease(impact/.84);
          units.push({x:x+direction*(size*.17+fall*size*.28),y:y+8,group,direction,palette,
            size:size*.91,label:fallen>1?'−'+fallen:'',fall,charge:0});
        }
      }
      if (current && !reducedMotion && !frame.ending && progress>.17 && progress<.59) {
        const ahead=current.before[side]>0;
        const archer=frame.alive[side].archer>0;
        const magic=frame.alive[side].mage>0 && (frame.round-1)%3===0;
        const siege=frame.alive[side].siege>0;
        if(ahead&&(archer||magic||siege)) {
          for(let n=0;n<(archer?5:0)+(magic?2:0)+(siege?1:0);n++) {
            const p=clamp((progress-.19-n*.021)*3.65);
            if(p<=0||p>=1)continue;
            const glyph=n>=(archer?5:0),spell=magic&&glyph&&n<(archer?7:2);
            const x=mix(base,width*.54-direction*width*.28,p);
            const y=height*(.56-p*(1-p)*(glyph?1.26:.78)+((n%3)-1)*.042);
            ctx.globalAlpha=.84*Math.sin(p*Math.PI);
            ctx.strokeStyle=spell?'#d9b2ff':glyph?'#ffb875':palette[1];ctx.lineWidth=glyph?2.8:1.3;
            ctx.beginPath();ctx.moveTo(x-direction*(glyph?22:14),y-1);ctx.lineTo(x,y);ctx.stroke();
            if(glyph) {ctx.fillStyle=ctx.strokeStyle;ctx.beginPath();ctx.arc(x,y,spell?3.5:2.6,0,Math.PI*2);ctx.fill();}
          }
          ctx.globalAlpha=1;
        }
      }
    }
    for(const unit of units.sort((a,b)=>a.y-b.y)) {
      const {x,y,group,direction,palette,size:height,label,charge,guard}=unit;
      const down=typeof unit.fall==='number';
      const stride=down||reducedMotion||frame.ending?0:Math.sin(t*11+group.seed*13)*charge*2.4;
      ctx.fillStyle='#110e0e87';
      ctx.beginPath();ctx.ellipse(x,y+2,height*.21,2.4,0,0,Math.PI*2);ctx.fill();
      ctx.save();ctx.translate(x,y+stride+(unit.fall??0)*3);
      if(down) {
        ctx.rotate(direction*(.19+unit.fall*1.32));ctx.globalAlpha=1-unit.fall*.31;
      } else if(!reducedMotion) {
        ctx.rotate(direction*(charge*.12-(unit.hurt?.135:0)));
        if(guard&&group.type==='shield'){
          ctx.strokeStyle='#bbefdd72';ctx.lineWidth=1.25;ctx.beginPath();
          ctx.ellipse(0,-height*.33,height*.19,height*.32,0,-Math.PI*.41,Math.PI*.84);ctx.stroke();
        }
      }
      ctx.scale(direction,1);ctx.fillStyle=palette[0];texture(ctx,group.image,0,0,height*.34,height);
      ctx.restore();
      if(label) badge(ctx,x,y+(down?7:2),label,down?'#ffbca3':palette[1],down);
    }
    if(tookLoss&&frame.hit&&!reducedMotion&&impact<1) {
      for (const [index,side] of sides.entries()) {
        if (!frame.roundLosses[side]) continue;
        for(let i=0;i<Math.min(20,6+frame.roundLosses[side]);i++) {
          const theta=i*2.39;
          const r=(10+Math.abs(random(i))*56)*ease(impact);
          const x=width*(index?.604:.396)+Math.cos(theta)*r;
          const y=height*.57+Math.sin(theta)*r*.63+impact*impact*9;
          ctx.strokeStyle=i%4?'#ffc383':'#fff2ba';ctx.lineWidth=i%3?1:2;ctx.globalAlpha=(1-impact)*.77;
          ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+Math.cos(theta)*6,y+Math.sin(theta)*6);ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
  return {draw,destroy:()=>{disposed=true;observer.disconnect();}};
}
