// =====================================================================
//  Fantasy Worlds 2026 — passerelle Firebase
//  Fournit à l'appli les mêmes services que sur claude.ai :
//  base partagée (Firestore), identité (connexion Google), présence en direct.
// =====================================================================
(function(){
  const configured = window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey && !/REMPLACE/.test(window.FIREBASE_CONFIG.apiKey);
  let fs = null, auth = null;
  let resolveUser; const userReady = new Promise(r => resolveUser = r);

  // ---------- Login screen ----------
  const css = `
  #fw-login{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:24px;
    background:radial-gradient(ellipse 90% 60% at 50% -10%, #0B2236 0%, #010A13 70%);color:#CDBE91;font-family:"Barlow",system-ui,sans-serif}
  #fw-login .box{display:grid;gap:16px;justify-items:center;text-align:center;max-width:420px}
  #fw-login .t{font-family:"Cinzel",Georgia,serif;font-weight:800;font-size:clamp(28px,7vw,44px);letter-spacing:.06em;text-transform:uppercase;color:#F0E6D2;line-height:1.05}
  #fw-login .t span{color:#C8AA6E}
  #fw-login p{margin:0;color:#7B8794;line-height:1.5}
  #fw-login button{font-family:"Cinzel",Georgia,serif;font-weight:800;font-size:16px;letter-spacing:.1em;text-transform:uppercase;padding:13px 30px;border:2px solid #C8AA6E;background:linear-gradient(180deg,#0E1A2C,#091428);color:#F0E6D2;cursor:pointer}
  #fw-login button:hover{box-shadow:0 0 16px rgba(200,170,110,.45)}
  #fw-login .err{color:#E84057;font-size:14px}
  #fw-logout{position:fixed;right:max(12px,env(safe-area-inset-right,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:30;font:600 12px "Barlow",system-ui,sans-serif;padding:6px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:rgba(20,27,43,.85);color:#EEF2FA;cursor:pointer}`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  function loginScreen(message){
    let el = document.getElementById('fw-login');
    if(!el){ el = document.createElement('div'); el.id = 'fw-login'; document.body.appendChild(el); }
    el.innerHTML = `<div class="box">
      <div class="t">Fantasy <span>Worlds</span> 2026</div>
      <p>Draft, duels quotidiens et mercato sur les Worlds de League of Legends, entre amis.</p>
      ${configured ? '<button id="fw-google">Se connecter avec Google</button>' : ''}
      <div class="err" id="fw-err">${message||''}</div></div>`;
    const b = document.getElementById('fw-google');
    if(b) b.onclick = async () => {
      try{ await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
      catch(e){
        if(e && (e.code==='auth/popup-blocked' || e.code==='auth/operation-not-supported-in-this-environment')){ auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider()); return; }
        document.getElementById('fw-err').textContent = 'Connexion impossible : ' + (e && e.message || e);
      }
    };
  }
  function hideLogin(){ const el = document.getElementById('fw-login'); if(el) el.remove(); }
  function logoutButton(){
    if(document.getElementById('fw-logout')) return;
    const b = document.createElement('button'); b.id = 'fw-logout'; b.textContent = 'Se déconnecter';
    b.onclick = async () => { try{ await presenceCol?.doc(meId).delete(); }catch(_){}; await auth.signOut(); location.reload(); };
    document.body.appendChild(b);
  }

  // ---------- Firestore wrappers (same API as the claude.ai db capability) ----------
  const mapErr = e => { const c = e && e.code; const out = new Error(e && e.message || 'Erreur'); out.code = c==='permission-denied' ? 'invalid_argument' : (c==='resource-exhausted' ? 'resource_exhausted' : (c==='unavailable' ? 'unavailable' : (c || 'unavailable'))); return out; };
  const guard = p => p.catch(e => { throw mapErr(e); });
  function wrapDoc(ref){
    return {
      id: ref.id, path: ref.path,
      get: () => guard(ref.get()),
      set: data => guard(ref.set(data)),
      update: data => guard(ref.set(data, {merge:true})),   // nested maps merge, like the claude.ai store
      delete: () => guard(ref.delete()),
      onSnapshot: (next, err) => ref.onSnapshot(next, e => err && err(mapErr(e))),
      collection: p => wrapColl(ref.collection(p)),
      acquire: async ({holder, ttlMs=30000}) => {
        const lref = fs.collection('_leases').doc(ref.path.replace(/\//g,'__'));
        try{
          return await fs.runTransaction(async tx => {
            const s = await tx.get(lref); const now = Date.now(); const d = s.exists ? s.data() : null;
            if(d && d.until > now && d.holder !== holder) return {acquired:false, expiresAt:new Date(d.until).toISOString()};
            tx.set(lref, {holder, until: now + Math.min(Math.max(ttlMs,1000),600000)});
            return {acquired:true, holder};
          });
        }catch(e){ return {acquired:true, holder}; }
      }
    };
  }
  function wrapColl(ref){
    return {
      path: ref.path,
      doc: id => wrapDoc(id ? ref.doc(id) : ref.doc()),
      add: async data => { const r = ref.doc(); await guard(r.set(data)); return wrapDoc(r); },
      where: (...a) => ref.where(...a),
      orderBy: (...a) => ref.orderBy(...a),
      limit: n => ref.limit(n),
      get: () => guard(ref.get()),
      onSnapshot: (next, err) => ref.onSnapshot(next, e => err && err(mapErr(e)))
    };
  }
  const db = { doc: p => wrapDoc(fs.doc(p)), collection: p => wrapColl(fs.collection(p)) };

  // ---------- Identity ----------
  let meId = null, meName = '';
  const user = {
    id: async () => (await userReady).uid,
    isOwner: async () => false,
    canEdit: async () => true,
    can: async () => true,
    name: async () => (await userReady).displayName || '',
    me: async () => { const u = await userReady; return {id:u.uid, name:u.displayName||'', email:u.email||null, avatarUrl:u.photoURL||'', color:'#C8AA6E', isOwner:false, canEdit:true}; },
    profiles: async ids => Object.fromEntries((Array.isArray(ids)?ids:[ids]).map(id => [id, {id, name: id===meId?meName:'', avatarUrl:'', color:'#888', email:null, isMe:id===meId, guest:false}]))
  };

  // ---------- Live presence (who is online, what they hover) ----------
  let presenceCol = null, mine = {}, pushTimer = null, beat = null;
  const push = () => { clearTimeout(pushTimer); pushTimer = setTimeout(() => presenceCol.doc(meId).set({...mine, at: Date.now()}).catch(()=>{}), 150); };
  const room = {
    presence: async patch => { Object.entries(patch||{}).forEach(([k,v]) => { if(v===null) delete mine[k]; else mine[k] = v; }); push(); },
    peers: () => [],
    onPeers: (handler, onErr) => {
      push(); if(!beat) beat = setInterval(push, 60000);
      addEventListener('pagehide', () => { try{ presenceCol.doc(meId).delete(); }catch(_){} });
      return presenceCol.onSnapshot(qs => {
        const now = Date.now();
        const peers = qs.docs.map(d => ({d, v:d.data()})).filter(x => now - (x.v.at||0) < 150000)
          .map(({d,v}) => { const {at, ...rest} = v; return {peer:d.id, by:d.id, isMe:d.id===meId, sameTab:d.id===meId, kind:'viewer', guest:false, presence:rest, updatedAt:at}; });
        handler({peers, joined:[], left:[], updated:[]});
      }, e => onErr && onErr(mapErr(e)));
    },
    emit: async () => {}, on: () => () => {}
  };

  // ---------- Boot ----------
  if(!configured){
    document.addEventListener('DOMContentLoaded', () => loginScreen('Le site n’est pas encore configuré : remplis le fichier config.js avec les informations de ton projet Firebase (voir LISEZMOI.md).'));
  } else {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    auth = firebase.auth(); fs = firebase.firestore();
    try{ fs.settings({ignoreUndefinedProperties:true, merge:true}); }catch(_){}
    presenceCol = fs.collection('presence');
    auth.getRedirectResult().catch(()=>{});
    auth.onAuthStateChanged(u => {
      if(u){ meId = u.uid; meName = u.displayName||''; hideLogin(); logoutButton(); resolveUser(u); }
      else { const show = () => loginScreen(); document.body ? show() : document.addEventListener('DOMContentLoaded', show); }
    });
  }
  const services = {db, user, room};
  window.claude = { use: async name => { if(!configured) return new Promise(()=>{}); await userReady; return services[name] || null; } };
})();
