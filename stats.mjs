// =====================================================================
//  Fantasy Worlds 2026 — récupération des stats depuis Leaguepedia
//  et écriture dans Firestore (sans aucune dépendance npm).
//
//  Variables d'environnement Netlify :
//    FIREBASE_SERVICE_ACCOUNT  (obligatoire) contenu JSON de la clé du compte de service Firebase
//    LEAGUEPEDIA_PAGE          (facultatif) préfixe de la page du tournoi, par défaut
//                              "2026 Season World Championship"
// =====================================================================
import crypto from 'node:crypto';

export const DAYS = [
  ['d01','2026-10-23'],['d02','2026-10-24'],['d03','2026-10-25'],['d04','2026-10-26'],
  ['d05','2026-10-28'],['d06','2026-10-29'],['d07','2026-10-30'],['d08','2026-10-31'],
  ['d09','2026-11-03'],['d10','2026-11-04'],['d11','2026-11-05'],['d12','2026-11-06'],
  ['d13','2026-11-07'],['d14','2026-11-08'],['d15','2026-11-14'],
];
// A Worlds "day" (US time) = from 12:00 UTC that day to 12:00 UTC the next day.
const windowOf = date => { const s = new Date(date+'T12:00:00Z'); return [s, new Date(s.getTime()+86400000)]; };
const cargoDate = d => d.toISOString().slice(0,19).replace('T',' ');

// Team codes used by the app, with the names Leaguepedia may use.
export const TEAMS = [
  ['GEN',['gen.g','geng','gen.g esports']],
  ['HLE',['hanwha life esports','hanwha life']],
  ['T1',['t1']],
  ['DK',['dplus kia','dplus','dk']],
  ['AL',["anyone's legend",'anyones legend']],
  ['BLG',['bilibili gaming','blg']],
  ['TES',['top esports','tes']],
  ['IG',['invictus gaming','shanghai invictus gaming','ig']],
  ['G2',['g2 esports','g2']],
  ['MKOI',['movistar koi','koi','mkoi']],
  ['KC',['karmine corp','kc']],
  ['TL',['team liquid','team liquid alienware','tl']],
  ['LYON',['lyon','lyon gaming']],
  ['TSW',['team secret whales','secret whales','tsw']],
  ['CFO',['ctbc flying oyster','flying oyster','cfo']],
  ['LOS',['los','løs']],
];
const norm = s => String(s||'').toLowerCase().replace(/\(.*?\)/g,'').trim();
export function teamCode(name){
  const n = norm(name);
  for(const [code, names] of TEAMS) if(names.includes(n)) return code;
  for(const [code, names] of TEAMS) if(names.some(x => x.length > 4 && n.includes(x))) return code;
  return null;
}
const ROLE = {top:'TOP', jungle:'JNG', jungler:'JNG', mid:'MID', middle:'MID', bot:'ADC', adc:'ADC', bottom:'ADC', support:'SUP'};

// ---------- Leaguepedia (Cargo API) ----------
async function cargo(params){
  const url = 'https://lol.fandom.com/api.php?' + new URLSearchParams({action:'cargoquery', format:'json', limit:'500', ...params});
  for(let attempt=0; attempt<3; attempt++){
    const r = await fetch(url, {headers:{'User-Agent':'FantasyWorlds2026/1.0 (projet entre amis)'}});
    const j = await r.json().catch(() => ({}));
    if(j.cargoquery) return j.cargoquery.map(x => x.title);
    if(j.error && /ratelimit/i.test(JSON.stringify(j.error))){ await new Promise(r => setTimeout(r, 4000*(attempt+1))); continue; }
    throw new Error('Leaguepedia : ' + JSON.stringify(j.error || j).slice(0,300));
  }
  throw new Error('Leaguepedia : trop de requêtes, réessaie plus tard');
}
const pageFilter = () => `OverviewPage LIKE "${(process.env.LEAGUEPEDIA_PAGE || '2026 Season World Championship').replace(/"/g,'')}%"`;

// Optional fields (void grubs, vision score, best-of) are asked first; if Leaguepedia refuses one,
// the query is retried without it and the run report says so.
async function cargoWithOptional(base, optional, where, warn){
  try{ return await cargo({...base, fields: [base.fields, ...optional.map(o=>o.f)].join(','), where}); }
  catch(e){
    if(!optional.length) throw e;
    warn.push('champs indisponibles sur Leaguepedia : ' + optional.map(o=>o.label).join(', '));
    return await cargo({...base, where});
  }
}
export async function fetchDay(date){
  const [from, to] = windowOf(date);
  const range = (alias) => `${alias}.${pageFilter()} AND ${alias}.DateTime_UTC >= "${cargoDate(from)}" AND ${alias}.DateTime_UTC < "${cargoDate(to)}"`;
  const warn = [];
  const games = await cargoWithOptional({
    tables:'ScoreboardGames=SG',
    fields:'SG.GameId=GameId,SG.MatchId=MatchId,SG.Team1=Team1,SG.Team2=Team2,SG.Winner=Winner,SG.Team1Dragons=D1,SG.Team2Dragons=D2,SG.Team1Barons=B1,SG.Team2Barons=B2,SG.DateTime_UTC=Date',
  }, [{f:'SG.Team1VoidGrubs=G1,SG.Team2VoidGrubs=G2', label:'larves du Néant (grubs)'}], range('SG'), warn);
  const players = games.length ? await cargoWithOptional({
    tables:'ScoreboardPlayers=SP',
    fields:'SP.GameId=GameId,SP.Link=Link,SP.Team=Team,SP.Role=Role,SP.Kills=Kills,SP.Deaths=Deaths,SP.Assists=Assists,SP.CS=CS,SP.DamageToChampions=Dmg,SP.PlayerWin=Win',
  }, [{f:'SP.VisionScore=Vis', label:'score de vision'}], range('SP'), warn) : [];
  let bestOf = {};
  if(games.length){
    try{
      const rows = await cargo({tables:'MatchSchedule=MS', fields:'MS.MatchId=MatchId,MS.BestOf=BestOf', where: range('MS')});
      rows.forEach(r => { const n = Number(r.BestOf); if(r.MatchId && n) bestOf[r.MatchId] = n; });
    }catch(e){ warn.push('format des séries (Bo1/Bo3/Bo5) déduit des scores'); }
  }
  return {games, players, bestOf, warn};
}

// ---------- Turn raw rows into the app's stats document ----------
export function buildStats({games, players, bestOf={}, warn=[]}, {final=false, knockout=false}={}){
  const num = v => Number(String(v ?? '').replace(/[^0-9.\-]/g,'')) || 0;
  const out = {players:{}, teams:{}, final, updatedAt:new Date().toISOString(), source:'Leaguepedia', note:''};
  const notes = [...warn];
  // s3 / s5 = Bo3 / Bo5 series won that day (Bo1 series count in sw/sl but give no series bonus)
  const team = code => out.teams[code] ||= {gw:0, gl:0, sw:0, sl:0, s3:0, s5:0, dr:0, bn:0, gr:0};
  // Team side, per game
  for(const g of games){
    const c1 = teamCode(g.Team1), c2 = teamCode(g.Team2);
    if(!c1 || !c2){ notes.push(`équipe inconnue : ${g.Team1} / ${g.Team2}`); continue; }
    const w = String(g.Winner).trim();
    const win1 = w==='1' || norm(w)===norm(g.Team1), win2 = w==='2' || norm(w)===norm(g.Team2);
    const a = team(c1), b = team(c2);
    a.dr += num(g.D1); a.bn += num(g.B1); a.gr += num(g.G1);
    b.dr += num(g.D2); b.bn += num(g.B2); b.gr += num(g.G2);
    if(win1){ a.gw++; b.gl++; } else if(win2){ b.gw++; a.gl++; } else notes.push(`vainqueur inconnu pour ${g.GameId}`);
  }
  // Series: games grouped by match, majority wins
  const byMatch = {};
  for(const g of games){ const c1 = teamCode(g.Team1), c2 = teamCode(g.Team2); if(!c1||!c2) continue;
    const m = byMatch[g.MatchId || g.GameId] ||= {c1, c2, w1:0, w2:0, n:0, id:g.MatchId};
    const w = String(g.Winner).trim(); m.n++;
    if(w==='1' || norm(w)===norm(g.Team1)) m.w1++; else m.w2++; }
  for(const m of Object.values(byMatch)){
    // Format: Leaguepedia's BestOf, else knockout days are Bo5, else 2 wins = Bo3, otherwise Bo1
    const top = Math.max(m.w1, m.w2);
    const bo = bestOf[m.id] || (knockout ? 5 : (top>=2 ? 3 : 1));
    if(top < Math.ceil(bo/2)){ notes.push(`série ${m.c1}-${m.c2} pas terminée (${m.w1}-${m.w2}, Bo${bo})`); out.final = false; continue; }
    const [win, lose] = m.w1>m.w2 ? [m.c1, m.c2] : [m.c2, m.c1];
    team(win).sw++; team(lose).sl++;
    if(bo===3) team(win).s3++; else if(bo>=5) team(win).s5++;
  }
  // Damage share per game and team
  const teamDmg = {};
  for(const p of players){ const key = p.GameId+'|'+teamCode(p.Team); teamDmg[key] = (teamDmg[key]||0) + num(p.Dmg); }
  for(const p of players){
    const code = teamCode(p.Team), role = ROLE[norm(p.Role)];
    if(!code || !role){ notes.push(`joueur ignoré : ${p.Link} (${p.Team}, ${p.Role})`); continue; }
    // gl = one line per game {k, a, cs, v (vision), p (% team damage), w (1 = win)}: the multipliers apply game by game
    const id = code+'-'+role; const s = out.players[id] ||= {g:0, w:0, k:0, d:0, a:0, cs:0, vis:0, dmg:0, gl:[], names:[]};
    const k = num(p.Kills), d = num(p.Deaths), a = num(p.Assists), cs = num(p.CS), v = num(p.Vis);
    const tot = teamDmg[p.GameId+'|'+code] || 0;
    const pct = tot ? Math.round(num(p.Dmg)/tot*1000)/10 : 0;
    const won = /^(yes|1|true)$/i.test(String(p.Win).trim());
    s.g++; s.k += k; s.d += d; s.a += a; s.cs += cs; s.vis += v; s.dmg += pct;
    if(won) s.w++;
    s.gl.push({k, a, cs, v, p:pct, w: won?1:0});
    const nm = String(p.Link||'').replace(/\s*\(.*\)$/,''); if(nm && !s.names.includes(nm)) s.names.push(nm);
  }
  for(const s of Object.values(out.players)){ s.dmg = Math.round(s.dmg*10)/10; s.names = s.names.join(', '); }
  if(!games.length){ out.final = false; notes.push('aucune partie trouvée sur Leaguepedia pour cette journée'); }
  out.note = notes.slice(0,20).join(' · ');
  return out;
}

export async function fetchSchedule(date){
  const [from, to] = windowOf(date);
  const rows = await cargo({
    tables:'MatchSchedule=MS', fields:'MS.Team1=Team1,MS.Team2=Team2,MS.DateTime_UTC=Date',
    where:`MS.${pageFilter()} AND MS.DateTime_UTC >= "${cargoDate(from)}" AND MS.DateTime_UTC < "${cargoDate(to)}"`,
  });
  return rows.map(r => [teamCode(r.Team1), teamCode(r.Team2)]).filter(([a,b]) => a && b);
}

// ---------- Firestore REST (service account, no SDK) ----------
let tokenCache = null;
async function googleToken(sa){
  if(tokenCache && tokenCache.exp > Date.now()+60000) return tokenCache.token;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now()/1000);
  const unsigned = b64({alg:'RS256', typ:'JWT'}) + '.' + b64({iss:sa.client_email, scope:'https://www.googleapis.com/auth/datastore', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now+3600});
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned+'.'+sig})});
  const j = await r.json(); if(!j.access_token) throw new Error('Firebase : clé du compte de service refusée ' + JSON.stringify(j).slice(0,200));
  tokenCache = {token:j.access_token, exp:Date.now()+3500*1000}; return j.access_token;
}
const toValue = v => {
  if(v===null || v===undefined) return {nullValue:null};
  if(typeof v==='boolean') return {booleanValue:v};
  if(typeof v==='number') return Number.isInteger(v) ? {integerValue:String(v)} : {doubleValue:v};
  if(typeof v==='string') return {stringValue:v};
  if(Array.isArray(v)) return {arrayValue:{values:v.map(toValue)}};
  return {mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,x]) => [k, toValue(x)]))}};
};
export async function writeDoc(path, data){
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if(!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('Variable FIREBASE_SERVICE_ACCOUNT absente ou incomplète');
  const token = await googleToken(sa);
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const r = await fetch(url, {method:'PATCH', headers:{authorization:'Bearer '+token, 'content-type':'application/json'}, body:JSON.stringify({fields: toValue(data).mapValue.fields})});
  if(!r.ok) throw new Error('Firestore ' + r.status + ' : ' + (await r.text()).slice(0,300));
}

// ---------- One run: refresh the last days and the next schedule ----------
export async function runUpdate({days=3, now=new Date()}={}){
  const log = [];
  const past = DAYS.filter(([, date]) => windowOf(date)[0] <= now).slice(-days);
  for(const [id, date] of past){
    try{
      const raw = await fetchDay(date);
      const final = now.getTime() > windowOf(date)[1].getTime() + 2*3600000;
      const knockout = DAYS.findIndex(([d]) => d===id) >= 8; // d09+ = quarts, demis, finale (Bo5)
      const doc = buildStats(raw, {final, knockout});
      if(!raw.games.length && !final){ log.push(`${id} : pas encore de partie`); continue; }
      await writeDoc('stats/'+id, doc);
      log.push(`${id} : ${raw.games.length} parties, ${Object.keys(doc.players).length} joueurs${doc.final?' (final)':''}${doc.note?' · '+doc.note:''}`);
    }catch(e){ log.push(`${id} : erreur ${e.message}`); }
  }
  // Schedule for today and tomorrow (US day)
  for(const [id, date] of DAYS.filter(([, date]) => windowOf(date)[1] > now).slice(0,2)){
    try{ const matches = await fetchSchedule(date); if(matches.length){ await writeDoc('schedule/'+id, {matches, updatedAt:new Date().toISOString(), note:'Leaguepedia'}); log.push(`${id} programme : ${matches.length} matchs`); } }
    catch(e){ log.push(`${id} programme : erreur ${e.message}`); }
  }
  return log;
}
