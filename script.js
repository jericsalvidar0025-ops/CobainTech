
/* ---------- helpers ---------- */
function escapeHtml(s){ return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function debounce(fn, delay=200){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),delay); }; }
function q(sel){ return document.querySelector(sel); }
function qAll(sel){ return document.querySelectorAll(sel); }
function money(v){ return `₱${Number(v).toLocaleString()}`; }
function placeholderDataURL(text){ const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='700'><rect fill='#0b0c0e' width='100%' height='100%'/><text x='50%' y='50%' font-size='48' font-family='Segoe UI, Roboto' fill='#fff' text-anchor='middle' alignment-baseline='middle'>${escapeHtml(text)}</text></svg>`; return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }

/* ---------- Firestore refs ---------- */
const productsRef = () => db.collection('products');
const ordersRef = () => db.collection('orders');
const usersRef = () => db.collection('users');

/* ---------- On load ---------- */
window.addEventListener('load', () => {
  setFooterYear();
  bindAuthState();
  initIndex();
  initAdmin();
  initChat();
  initCustomerOrders();
});

/* ---------------------- Chat (compat SDK) ---------------------- */
const TYPING_DEBOUNCE_MS = 1200;
let typingTimer = null;
let customerChatUnsub = null;
let adminUsersUnsub = null;
let adminMessagesUnsub = null;
let currentAdminChatUser = null;
let chatUsersCache = {}; // cache for quick lookup

/* ---------------------- WebRTC CALL state ---------------------- */
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
    // For production add TURN servers
  ]
};
let localStream = null;
let remoteStream = null;
let pc = null;
let currentCallId = null;

// ------------------ initChat ------------------
function initChat(){
  auth.onAuthStateChanged(user => {
    if (document.getElementById('chat-messages')) {
      if (user) startCustomerChat(user.uid, user.displayName || null);
      else {
        const box = document.getElementById('chat-messages');
        if (box) box.innerHTML = `<div style="padding:12px;color:#ddd">Please login to chat with us.</div>`;
      }
    }

    if (document.getElementById('chat-users')) {
      loadChatUsersRealtime();
      if ("Notification" in window && Notification.permission !== 'granted') Notification.requestPermission().catch(()=>{});
      startGlobalNotificationWatcher();
      // admin incoming call watcher
      listenForCallRequests();
    }
  });

  // customer input wiring
  const chatInputEl = document.getElementById('chat-input');
  if (chatInputEl) {
    chatInputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
    chatInputEl.addEventListener('input', debounceCustomerTyping);
  }

  // admin send enter
  const adminInput = document.getElementById('admin-chat-input');
  if (adminInput) adminInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); adminSendChat(); } });
}

/* ------------------- CUSTOMER SIDE ------------------- */
function startCustomerChat(userId, displayName = null){
  if (customerChatUnsub) { try { customerChatUnsub(); } catch(e){} customerChatUnsub = null; }
  const messagesBox = document.getElementById('chat-messages'); if (!messagesBox) return;
  db.collection('chats').doc(userId).set({ userId, name: displayName||'', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(err=>console.error(err));

  const colRef = db.collection('chats').doc(userId).collection('messages');
  const q = colRef.orderBy('timestamp','asc');
  customerChatUnsub = q.onSnapshot(snapshot => {
    messagesBox.innerHTML = '';
    if (snapshot.empty) { messagesBox.innerHTML = `<div style="padding:12px;color:#ddd">No messages yet. Say hi 👋</div>`; return; }
    snapshot.forEach(doc => appendCustomerMessageToUI(messagesBox, doc.data()));
    markMessagesReadForCustomer(userId).catch(()=>{});
    messagesBox.scrollTo({ top: messagesBox.scrollHeight, behavior: 'smooth' });
  }, err => { console.error('customer listener', err); messagesBox.innerHTML = `<div style="padding:12px;color:#f66">Failed to load messages.</div>`; });

  window.addEventListener('beforeunload', ()=>{ db.collection('chats').doc(userId).set({ typing: false }, { merge: true }); });
}

function appendCustomerMessageToUI(container, m){
  const time = m.timestamp ? m.timestamp.toDate().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
  const wrap = document.createElement('div'); wrap.style.marginBottom='8px'; wrap.style.textAlign = (m.sender==='customer') ? 'right':'left';
  const bubble = document.createElement('span'); bubble.textContent = m.message; bubble.style.display='inline-block'; bubble.style.padding='8px 12px'; bubble.style.borderRadius='12px'; bubble.style.maxWidth='78%'; bubble.style.wordBreak='break-word'; bubble.style.background = (m.sender==='customer')?'#3498db':'#444'; bubble.style.color='#fff';
  const timeEl = document.createElement('div'); timeEl.textContent = time; timeEl.style.fontSize='0.75rem'; timeEl.style.opacity='0.7'; timeEl.style.marginTop='4px';
  wrap.appendChild(bubble); wrap.appendChild(timeEl); container.appendChild(wrap);
}

async function markMessagesReadForCustomer(userId){
  const msgsSnap = await db.collection('chats').doc(userId).collection('messages').where('sender','==','admin').where('readByCustomer','==',false).get();
  if (msgsSnap.empty) return; const batch = db.batch(); msgsSnap.forEach(d=>batch.update(d.ref,{ readByCustomer:true })); await batch.commit();
}

function sendChat(){
  const input = document.getElementById('chat-input'); if(!input) return; const message = input.value.trim(); if(!message) return;
  const user = firebase.auth().currentUser; if(!user){ alert('Please login to chat.'); return; }
  const chatDocRef = db.collection('chats').doc(user.uid); const messagesRef = chatDocRef.collection('messages');
  const nameToSave = user.displayName || (user.email?user.email.split('@')[0]:'Customer');
  chatDocRef.set({ userId: user.uid, name: nameToSave, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), unreadForAdmin: true }, { merge: true })
    .then(()=> messagesRef.add({ sender:'customer', message, timestamp: firebase.firestore.FieldValue.serverTimestamp(), readByAdmin:false, readByCustomer:true }))
    .then(()=>{ input.value=''; chatDocRef.set({ typing:false }, { merge:true }).catch(()=>{}); })
    .catch(err=>{ console.error('sendChat', err); alert('Failed to send message.'); });
}

function debounceCustomerTyping(){
  const user = firebase.auth().currentUser; if(!user) return; const chatDocRef = db.collection('chats').doc(user.uid);
  chatDocRef.set({ typing:true }, { merge:true }).catch(()=>{});
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(()=>{ chatDocRef.set({ typing:false }, { merge:true }).catch(()=>{}); }, TYPING_DEBOUNCE_MS);
}

/* ------------------- ADMIN CHAT (upgraded UI + functions) ------------------- */
function fmtTime(ts){ if(!ts) return ''; try{ return ts.toDate().toLocaleString(); } catch(e){ return new Date(ts).toLocaleString(); } }

async function renderAdminUserList(snapshot){
  const listEl = document.getElementById('chat-users'); if(!listEl) return; if(snapshot.empty){ listEl.innerHTML = '<div style="padding:12px;color:#ddd">No chat users yet.</div>'; updateGlobalNotifBadge(0); return; }
  const docs = []; snapshot.forEach(d=>docs.push({ id:d.id, ...d.data() }));
  const unreadPromises = docs.map(d=> db.collection('chats').doc(d.id).collection('messages').where('sender','==','customer').where('readByAdmin','==',false).get().then(s=>({id:d.id, unread:s.size})).catch(()=>({id:d.id, unread:0})));
  const lastPromises = docs.map(d=> db.collection('chats').doc(d.id).collection('messages').orderBy('timestamp','desc').limit(1).get().then(s=>({id:d.id, last: s.empty?null:s.docs[0].data()})).catch(()=>({id:d.id,last:null})));
  const unreadResults = await Promise.all(unreadPromises);
  const lastResults = await Promise.all(lastPromises);
  const unreadMap = Object.fromEntries(unreadResults.map(x=>[x.id,x.unread]));
  const lastMap = Object.fromEntries(lastResults.map(x=>[x.id,x.last]));
  const html = docs.map(d=>{
    const name = d.name || d.username || d.userId || d.id; const initials = (name.split(' ').map(p=>p[0]).join('').slice(0,2)||'U').toUpperCase();
    const last = lastMap[d.id]; const preview = last ? (last.message.length>40?last.message.slice(0,37)+'...':last.message) : 'No messages';
    const ts = last && last.timestamp ? (last.timestamp.toDate?last.timestamp.toDate().toLocaleString():new Date(last.timestamp).toLocaleString()) : '';
    const unread = unreadMap[d.id]||0; chatUsersCache[d.id] = { name, initials, preview, ts, unread };
    const activeStyle = (currentAdminChatUser===d.id)?'background:#18314a;border:1px solid #234455;':'';
    return `\n      <div class="chat-user-row" style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;${activeStyle}" data-uid="${d.id}">\n        <div style="width:44px;height:44px;border-radius:50%;background:#2f80ed;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff">${initials}</div>\n        <div style="flex:1;min-width:0">\n          <div style="font-weight:700;color:#eee">${escapeHtml(name)}</div>\n          <div style="font-size:0.85rem;color:#9aa0a6">${escapeHtml(preview)} · <span style="color:#6d7880">${escapeHtml(ts)}</span></div>\n        </div>\n        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">\n          ${unread>0?`<div class=\"user-unread\" style=\"background:#e74c3c;color:#fff;padding:4px 8px;border-radius:999px;font-weight:700\">${unread}</div>`:''}\n          <div style=\"display:flex;gap:6px\">\n            <button class=\"btn small\" onclick=\"openAdminChat('${d.id}')\">Open</button>\n            <button class=\"btn small ghost\" onclick=\"startCallAsAdmin('${d.id}')\">Call</button>\n          </div>\n        </div>\n      </div>`;
  }).join('');
  listEl.innerHTML = html;
  const totalUnread = Object.values(unreadMap).reduce((s,n)=>s+n,0); updateGlobalNotifBadge(totalUnread);
  // wire click on rows for opening
  listEl.querySelectorAll('[data-uid]').forEach(el=>{ el.addEventListener('click', (ev)=>{ if(ev.target.tagName.toLowerCase()==='button') return; const uid = el.getAttribute('data-uid'); openAdminChat(uid); }); });
}

function loadChatUsersRealtime(){
  const listEl = document.getElementById('chat-users'); if(!listEl) return;
  if (adminUsersUnsub) { try { adminUsersUnsub(); } catch(e){} adminUsersUnsub = null; }
  adminUsersUnsub = db.collection('chats').orderBy('updatedAt','desc').onSnapshot(async snap => { try { await renderAdminUserList(snap); } catch(err){ console.error(err); } }, err=>{ console.error('loadChatUsersRealtime', err); listEl.innerHTML = '<div style="padding:12px;color:#f66">Failed to load users.</div>'; });
  const search = document.getElementById('chat-search'); if(search) search.addEventListener('input', debounce(()=>{ const qv = search.value.trim().toLowerCase(); document.querySelectorAll('#chat-users .chat-user-row').forEach(btn=>{ const uid = btn.getAttribute('data-uid'); const info = chatUsersCache[uid]||{}; const match = (info.name||'').toLowerCase().includes(qv) || (info.preview||'').toLowerCase().includes(qv) || uid.includes(qv); btn.style.display = match? 'flex':'none'; }); }, 200));
}

async function openAdminChat(userId){
  currentAdminChatUser = userId; document.getElementById('chat-admin-messages').innerHTML = '<div style="padding:12px;color:#ddd">Loading messages…</div>';
  const chatPanelName = document.getElementById('chat-panel-name'); const chatPanelAvatar = document.getElementById('chat-panel-avatar'); const chatPanelSub = document.getElementById('chat-panel-sub');
  try{ const doc = await db.collection('chats').doc(userId).get(); const data = doc.exists?doc.data():{}; const name = data.name||'Customer'; chatPanelName.textContent = name; chatPanelAvatar.textContent = (name.split(' ').map(p=>p[0]).join('').slice(0,2)||'U').toUpperCase(); chatPanelSub.textContent = data.updatedAt?fmtTime(data.updatedAt):''; }catch(err){ console.error(err); }
  await markMessagesReadForAdmin(userId);
  attachAdminMessagesListener(userId);
}

function attachAdminMessagesListener(userId){
  if (adminMessagesUnsub) { try { adminMessagesUnsub(); } catch(e){} adminMessagesUnsub = null; }
  const box = document.getElementById('chat-admin-messages'); if(!box) return;
  const q = db.collection('chats').doc(userId).collection('messages').orderBy('timestamp','asc');
  adminMessagesUnsub = q.onSnapshot(snapshot => { box.innerHTML=''; if(snapshot.empty){ box.innerHTML = '<div style="padding:12px;color:#ddd">No messages yet.</div>'; return; } snapshot.forEach(doc=>{ const m = doc.data(); const wrapper = document.createElement('div'); wrapper.style.display='flex'; wrapper.style.flexDirection='column'; wrapper.style.alignItems = (m.sender==='admin')?'flex-end':'flex-start'; const bubble = document.createElement('div'); bubble.className = 'bubble '+(m.sender==='admin'?'admin':'customer'); bubble.textContent = m.message; const t = document.createElement('div'); t.className='msg-time'; t.textContent = m.timestamp? (m.timestamp.toDate?m.timestamp.toDate().toLocaleString():new Date(m.timestamp).toLocaleString()) : ''; wrapper.appendChild(bubble); wrapper.appendChild(t); box.appendChild(wrapper); }); box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); }, err => { console.error('attachAdminMessagesListener', err); box.innerHTML = '<div style="padding:12px;color:#f66">Failed to load messages.</div>'; }); }

function adminSendChat(){ const input = document.getElementById('admin-chat-input'); if(!input) return; const text = input.value.trim(); if(!text) return; const uid = currentAdminChatUser; if(!uid) { alert('Select a user first'); return; } const chatRef = db.collection('chats').doc(uid); const messagesRef = chatRef.collection('messages'); messagesRef.add({ sender:'admin', message:text, timestamp: firebase.firestore.FieldValue.serverTimestamp(), readByAdmin:true, readByCustomer:false }).then(()=>{ chatRef.set({ unreadForAdmin:false, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },{ merge:true }); input.value=''; }).catch(err=>{ console.error('adminSendChat', err); alert('Failed to send message.'); }); }

async function markMessagesReadForAdmin(userId){ if(!userId) return; try{ const q = db.collection('chats').doc(userId).collection('messages').where('sender','==','customer').where('readByAdmin','==',false); const snap = await q.get(); if(snap.empty){ await db.collection('chats').doc(userId).set({ unreadForAdmin:false },{ merge:true }); return; } const batch = db.batch(); snap.forEach(d=> batch.update(d.ref, { readByAdmin:true })); batch.update(db.collection('chats').doc(userId), { unreadForAdmin:false }); await batch.commit(); setTimeout(()=>{},300); }catch(err){ console.error('markMessagesReadForAdmin', err); } }

function closeChat(){ currentAdminChatUser = null; if(adminMessagesUnsub){ try{ adminMessagesUnsub(); }catch(e){} adminMessagesUnsub = null; } const boxWrap = document.getElementById('chat-admin-box'); if(boxWrap) boxWrap.style.display = 'none'; const cam = document.getElementById('chat-admin-messages'); if(cam) cam.innerHTML=''; db.collection('chats').get().then(snap=>renderAdminUserList(snap)).catch(()=>{}); }

function updateGlobalNotifBadge(count){ const badge = document.getElementById('chat-notif'); if(!badge) return; if(count>0){ badge.style.display='inline-block'; badge.textContent = count>99? '99+' : String(count); } else { badge.style.display='none'; badge.textContent = ''; } }

/* ------------------- Notifications & watchers ------------------- */
function startGlobalNotificationWatcher(){ try{ db.collectionGroup('messages').orderBy('timestamp','desc').limit(50).onSnapshot(snap=>{ snap.docChanges().forEach(change=>{ if(change.type!=='added') return; const m = change.doc.data(); if(!m || m.sender!=='customer') return; const pathParts = change.doc.ref.path.split('/'); const uid = pathParts[1]; notifyAdminOfIncomingMessage(uid, m.name||'Customer', m.message); // bump badge quickly const badge = document.getElementById('chat-notif'); if(badge){ const curr = badge.style.display==='inline-block'? (Number(badge.textContent.replace('+',''))||0) : 0; updateGlobalNotifBadge(curr+1); } }); }, err=>console.warn('global watcher err', err)); }catch(e){ console.warn('collectionGroup not supported', e); } }

function notifyAdminOfIncomingMessage(userId, name, message){ try{ if(!('Notification' in window)) return; if(Notification.permission !== 'granted') return; const isActive = (document.visibilityState==='visible') && (currentAdminChatUser===userId); if(isActive) return; const n = new Notification(name||'Customer', { body: message.length>100? message.slice(0,97)+'...':message, tag:`chat-${userId}`, renotify:true }); n.onclick = ()=>{ window.focus(); openAdminChat(userId); n.close(); }; }catch(e){} }

/* ------------------- CALL SYSTEM (WebRTC using Firestore signaling) ------------------- */
// Data model: collection 'calls', docId = auto; fields: callerId, calleeId, state: 'requested'|'accepted'|'ended', createdAt
// subcollections: offerCandidates, answerCandidates

async function startCallAsCustomer(){
  const user = firebase.auth().currentUser; if(!user) return alert('Please login to start a call');
  // choose a callee: simple strategy -> pick first admin from users collection with role 'admin'
  const adminSnap = await usersRef().where('role','==','admin').limit(1).get(); if(adminSnap.empty) return alert('No admin available for calls');
  const adminDoc = adminSnap.docs[0]; const calleeId = adminDoc.id;
  // create call doc
  const callRef = db.collection('calls').doc(); currentCallId = callRef.id;
  await callRef.set({ callerId: user.uid, calleeId, state:'requested', createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  // show local preview & create peer connection
  await prepareLocalMedia();
  await createPeerConnection(callRef);

  // create offer
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  await callRef.set({ offer: { type: offer.type, sdp: offer.sdp }, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });

  // listen for answer
  callRef.onSnapshot(async snap => {
    const data = snap.data(); if(!data) return;
    if(data.answer && !pc.currentRemoteDescription){ const answer = new RTCSessionDescription(data.answer); await pc.setRemoteDescription(answer); }
    if(data.state === 'accepted'){ /* accepted */ }
    if(data.state === 'ended'){ hangupCall(); }
  });

  // candidates
  callRef.collection('answerCandidates').onSnapshot(snap=>{ snap.docChanges().forEach(async change=>{ if(change.type==='added'){ const c = change.doc.data(); try{ await pc.addIceCandidate(new RTCIceCandidate(c)); }catch(e){ console.warn('addIce', e); } } }); });

  // update UI as needed
  alert('Calling admin...');
}

async function listenForCallRequests(){
  // admin listens for calls where calleeId == admin uid and state == 'requested'
  const user = firebase.auth().currentUser; if(!user) return; // only while admin logged in
  const q = db.collection('calls').where('calleeId','==', user.uid).where('state','==','requested');
  q.onSnapshot(snap => { snap.docChanges().forEach(change=>{ if(change.type==='added'){ const c = change.doc.data(); const callId = change.doc.id; // notify admin
      if(confirm(`Incoming call from ${c.callerId}. Accept?`)) answerCallAsAdmin(callId); else { db.collection('calls').doc(callId).update({ state:'ended' }); }
    } }); });
}

async function answerCallAsAdmin(callId){
  try{
    // prepare local media
    await prepareLocalMedia();
    const callRef = db.collection('calls').doc(callId);
    const callDoc = await callRef.get(); if(!callDoc.exists) return; const data = callDoc.data();
    // set state accepted
    await callRef.update({ state:'accepted', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

    // create peer connection and set remote/answer
    await createPeerConnection(callRef);

    // set remote description from offer
    if(data.offer){ const offer = new RTCSessionDescription(data.offer); await pc.setRemoteDescription(offer); }
    const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
    await callRef.update({ answer: { type: answer.type, sdp: answer.sdp }, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

    // listen for offer candidates
    callRef.collection('offerCandidates').onSnapshot(snap=>{ snap.docChanges().forEach(async change=>{ if(change.type==='added'){ const c = change.doc.data(); try{ await pc.addIceCandidate(new RTCIceCandidate(c)); }catch(e){ console.warn('addIce', e); } } }); });

    // write answer candidates when generated (handled in createPeerConnection)
  }catch(err){ console.error('answerCallAsAdmin', err); }
}

async function createPeerConnection(callRef){
  pc = new RTCPeerConnection(rtcConfig);
  // create remote stream element
  remoteStream = new MediaStream();
  const remoteEl = document.getElementById('remote-video'); if(remoteEl) remoteEl.srcObject = remoteStream;
  // add local tracks
  if(localStream){ localStream.getTracks().forEach(t=>pc.addTrack(t, localStream)); }
  // ontrack
  pc.ontrack = event => { event.streams[0].getTracks().forEach(track=> remoteStream.addTrack(track)); };
  // icecandidate -> save to firestore
  pc.onicecandidate = event => { if(!event.candidate) return; const cand = event.candidate.toJSON(); // determine collection based on role
    const me = firebase.auth().currentUser; if(!me) return; const amICaller = (callRef && callRef.id && (callRef.get?false:true));
    // simpler: add candidate to 'offerCandidates' if local is caller (we set in caller flow), otherwise 'answerCandidates'
    // We detect by checking if callRef has offer already
    callRef.get().then(doc=>{ const data = doc.data()||{}; if(!data.offer){ // we created offer? if no offer exists, we are caller creating offer earlier - push to offerCandidates
        callRef.collection('offerCandidates').add(cand).catch(()=>{});
      } else {
        callRef.collection('answerCandidates').add(cand).catch(()=>{});
      } }).catch(()=>{});
  };
}

async function prepareLocalMedia(){
  if(localStream) return; try{ localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:true }); const localEl = document.getElementById('local-video'); if(localEl) localEl.srcObject = localStream; }catch(err){ alert('Unable to access camera/microphone: '+(err.message||err)); throw err; }
}

async function hangupCall(){
  try{ if(pc){ pc.close(); pc = null; } if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; } if(remoteStream){ remoteStream.getTracks().forEach(t=>t.stop()); remoteStream=null; } if(currentCallId){ await db.collection('calls').doc(currentCallId).update({ state:'ended' }).catch(()=>{}); currentCallId = null; } // clear video elements
    const localEl = document.getElementById('local-video'); if(localEl) localEl.srcObject = null; const remoteEl = document.getElementById('remote-video'); if(remoteEl) remoteEl.srcObject = null; }catch(e){ console.warn('hangup', e); }
}

// Admin initiated call to user (creates call doc with callee = userId)
async function startCallAsAdmin(userId){
  const me = firebase.auth().currentUser; if(!me) return alert('Login as admin to start calls');
  const callRef = db.collection('calls').doc(); currentCallId = callRef.id;
  await callRef.set({ callerId: me.uid, calleeId: userId, state:'requested', createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  // prepare local
  await prepareLocalMedia();
  await createPeerConnection(callRef);
  // as caller for admin, create offer
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  await callRef.set({ offer:{type:offer.type, sdp:offer.sdp}, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
  // listen for answer
  callRef.onSnapshot(async snap=>{ const data = snap.data(); if(!data) return; if(data.answer && !pc.currentRemoteDescription){ const ans = new RTCSessionDescription(data.answer); await pc.setRemoteDescription(ans); } if(data.state==='ended'){ hangupCall(); } });
  callRef.collection('answerCandidates').onSnapshot(snap=>{ snap.docChanges().forEach(async ch=>{ if(ch.type==='added'){ const c = ch.doc.data(); try{ await pc.addIceCandidate(new RTCIceCandidate(c)); }catch(e){ console.warn('addIce', e); } } }); });
}

// ------------------ Call request watcher for admin ------------------
function listenForCallRequests(){
  const me = firebase.auth().currentUser; if(!me) return;
  db.collection('calls').where('calleeId','==', me.uid).where('state','==','requested').onSnapshot(snap=>{ snap.docChanges().forEach(change=>{ if(change.type==='added'){ const id = change.doc.id; const data = change.doc.data(); const caller = data.callerId || data.callerName || 'Customer'; if(confirm(`Incoming call from ${caller}. Accept?`)){ answerCallAsAdmin(id); } else { db.collection('calls').doc(id).update({ state:'ended' }).catch(()=>{}); } } }); });
}

/* ---------- Auth: signup/login/logout etc... (kept from your file) ---------- */
async function signupUser(e){ e.preventDefault(); const username = (q('#signup-username')||{}).value?.trim(); const email = (q('#signup-email')||{}).value?.trim(); const password = (q('#signup-password')||{}).value; if (!username || !email || !password) { alert('Complete all fields'); return false; } try { const cred = await auth.createUserWithEmailAndPassword(email, password); const uid = cred.user.uid; await usersRef().doc(uid).set({ username, email, role: 'customer', createdAt: firebase.firestore.FieldValue.serverTimestamp() }); alert('Account created. Redirecting to store...'); window.location.href = 'index.html'; } catch (err) { console.error(err); alert(err.message || 'Signup failed'); } return false; }

async function loginUser(e){ e.preventDefault(); const email = (q('#login-username')||{}).value?.trim(); const password = (q('#login-password')||{}).value; if (!email || !password) { alert('Complete fields'); return false; } try { await auth.signInWithEmailAndPassword(email, password); } catch (err) { console.error(err); alert(err.message || 'Login failed'); } return false; }
function logoutUser(){ auth.signOut(); }

/* ---------- auth state & UI ---------- */
function bindAuthState(){ auth.onAuthStateChanged(async user => { const welcome = q('#welcome-user-top'); const loginLink = q('#login-link'); const signupLink = q('#signup-link'); const adminLink = q('#admin-link'); if (user) { try { const doc = await usersRef().doc(user.uid).get(); const username = doc.exists ? (doc.data().username || user.email.split('@')[0]) : user.email.split('@')[0]; if (welcome) welcome.textContent = `Hi, ${username}`; if (loginLink) loginLink.style.display = 'none'; if (signupLink) signupLink.style.display = 'none'; if (doc.exists && doc.data().role === 'admin') { if (adminLink) adminLink.style.display = 'inline-block'; if (location.pathname.endsWith('login.html')) window.location.href = 'admin.html'; } } catch (err) { console.error('Failed to read user doc', err); } } else { if (welcome) welcome.textContent = ''; if (loginLink) loginLink.style.display = 'inline-block'; if (signupLink) signupLink.style.display = 'inline-block'; if (adminLink) adminLink.style.display = 'none'; } }); }

/* ---------- INDEX PAGE: products listing, cart, orders, admin etc... (kept from your file) ---------- */
// --- The rest of your previous code remains unchanged (products, cart, orders, admin product list, etc.)

/* ---------- Footer ---------- */
function setFooterYear(){ const f=q('footer'); if(f) f.innerHTML=f.innerHTML.replace('{year}', new Date().getFullYear()); }

/* ---------- End of file ---------- */
