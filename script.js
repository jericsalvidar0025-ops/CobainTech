/* script.js — CobainTech (merged: working ecom + upgraded chat + call system)
   Drop-in replacement. Uses Firebase compat SDK (auth(), firestore()).
*/

/* ---------- helpers ---------- */
function q(sel){ return document.querySelector(sel); }
function qAll(sel){ return Array.from(document.querySelectorAll(sel)); }
function escapeHtml(s){ return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function debounce(fn,d=200){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),d); }; }
function money(v){ return `₱${Number(v||0).toLocaleString()}`; }
function placeholderDataURL(text){
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='700'>
    <rect fill='#0b0c0e' width='100%' height='100%'/>
    <text x='50%' y='50%' font-size='48' font-family='Segoe UI, Roboto' fill='#fff' text-anchor='middle' alignment-baseline='middle'>${escapeHtml(text)}</text>
  </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function fmtTime(ts){
  if(!ts) return '';
  try { return ts.toDate().toLocaleString(); } catch(e){ return new Date(ts).toLocaleString(); }
}

/* ---------- Firestore refs ---------- */
const productsRef = () => db.collection('products');
const ordersRef = () => db.collection('orders');
const usersRef = () => db.collection('users');
const chatsRef = () => db.collection('chats');
const callsRef = () => db.collection('calls');

/* ---------- On load ---------- */
window.addEventListener('load', () => {
  setFooterYear();
  bindAuthState();
  initIndex();
  initAdmin();
  initChat();
  initCustomerOrders();
});

/* ---------------------- CHAT (compat SDK) ---------------------- */
/*
 Data model:
 - chats (collection)
   - {userId} doc: { userId, name, updatedAt, unreadForAdmin: bool, typing: bool }
     - messages (subcollection)
       - {autoId} { sender: 'customer'|'admin', message: string, timestamp: Timestamp, readByAdmin: bool, readByCustomer: bool }

 Features:
 - Customer -> chat messages stored under their UID
 - Admin -> sees list with username, last message preview, unread badge
 - Typing indicator (chats/{uid}.typing)
 - Browser notifications for incoming customer messages (admin)
 - Mark messages read when admin opens chat
 - Call system using Firestore signaling (basic WebRTC)
*/

/* ---------- Chat state ---------- */
const TYPING_DEBOUNCE_MS = 1200;
let typingTimer = null;
let customerChatUnsub = null;
let adminUsersUnsub = null;
let adminMessagesUnsub = null;
let currentAdminChatUser = null;
let chatUsersCache = {}; // cache of user metadata for quick search

/* ---------- WebRTC call state ---------- */
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // add TURN for production
let localStream = null;
let remoteStream = null;
let pc = null;
let currentCallId = null;

/* ------------------ initChat ------------------ */
function initChat(){
  // Auth state: start listeners depending on page (store / admin)
  auth.onAuthStateChanged(user => {
    // STORE (customer) view: show messages area
    if (document.getElementById('chat-messages')) {
      if (user) startCustomerChat(user.uid, user.displayName || null);
      else {
        const box = document.getElementById('chat-messages');
        if (box) box.innerHTML = `<div style="padding:12px;color:#ddd">Please login to chat with us.</div>`;
      }
    }

    // ADMIN view: load users + notification watcher + call requests
    if (document.getElementById('chat-users')) {
      loadChatUsersRealtime();
      if ("Notification" in window && Notification.permission !== 'granted') {
        Notification.requestPermission().catch(()=>{});
      }
      attachGlobalMessageWatcherForNotifications();
      listenForCallRequests();
    }
  });

  // Wire chat input for customer
  const chatInputEl = document.getElementById('chat-input');
  if (chatInputEl) {
    chatInputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    chatInputEl.addEventListener('input', debounceCustomerTyping);
  }

  // Wire admin input Enter key
  const adminInput = document.getElementById('admin-chat-input');
  if (adminInput) adminInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); adminSendChat(); }
  });
}

/* ----------------- toggleChatBox (index) ----------------- */
function toggleChatBox(){
  const box = document.getElementById("chat-box");
  if(!box) return;
  box.style.display = (box.style.display === "flex" || box.style.display === "") ? "none" : "flex";
  if (box.style.display === "flex") {
    const messages = document.getElementById('chat-messages');
    setTimeout(()=> { if(messages) messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' }); }, 150);
  }
}

/* ----------------- CUSTOMER SIDE ----------------- */

function startCustomerChat(userId, displayName = null){
  if (customerChatUnsub) { try{ customerChatUnsub(); }catch(e){} customerChatUnsub = null; }
  const messagesBox = document.getElementById('chat-messages');
  if (!messagesBox) return;

  // ensure parent doc exists and store name
  const chatDocRef = chatsRef().doc(userId);
  chatDocRef.set({ userId, name: displayName || '', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});

  const colRef = chatsRef().doc(userId).collection('messages');
  const q = colRef.orderBy('timestamp','asc');

  messagesBox.innerHTML = `<div style="padding:12px;color:#ddd">Loading messages…</div>`;

  customerChatUnsub = q.onSnapshot(snapshot => {
    messagesBox.innerHTML = '';
    if (snapshot.empty) {
      messagesBox.innerHTML = `<div style="padding:12px;color:#ddd">No messages yet. Say hi 👋</div>`;
      return;
    }
    snapshot.forEach(doc => {
      const data = doc.data();
      appendCustomerMessageToUI(messagesBox, data);
    });

    // mark admin->customer messages as read
    markMessagesReadForCustomer(userId).catch(()=>{});
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }, err => {
    console.error('customer listener error', err);
    messagesBox.innerHTML = `<div style="padding:12px;color:#f66">Failed to load messages.</div>`;
  });
}

function appendCustomerMessageToUI(container, m){
  const time = m.timestamp ? m.timestamp.toDate().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';
  const wrap = document.createElement('div');
  wrap.style.marginBottom = '8px';
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.alignItems = (m.sender === 'customer') ? 'flex-end' : 'flex-start';

  const bubble = document.createElement('div');
  bubble.className = (m.sender === 'customer') ? 'bubble customer' : 'bubble admin';
  bubble.textContent = m.message;

  const timeEl = document.createElement('div');
  timeEl.className = 'msg-time';
  timeEl.textContent = time;

  wrap.appendChild(bubble);
  wrap.appendChild(timeEl);
  container.appendChild(wrap);
}

async function markMessagesReadForCustomer(userId){
  const q = chatsRef().doc(userId).collection('messages').where('sender','==','admin').where('readByCustomer','==',false);
  const snap = await q.get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.forEach(d => batch.update(d.ref, { readByCustomer: true }));
  await batch.commit();
}

function sendChat(){
  const input = document.getElementById('chat-input');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;
  const user = firebase.auth().currentUser;
  if (!user) return alert('Please login to chat.');

  const chatRef = chatsRef().doc(user.uid);
  const nameToSave = user.displayName || (user.email ? user.email.split('@')[0] : 'Customer');

  chatRef.set({
    userId: user.uid,
    name: nameToSave,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    unreadForAdmin: true
  }, { merge: true })
  .then(() => chatRef.collection('messages').add({
    sender: 'customer',
    message,
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    readByAdmin: false,
    readByCustomer: true
  }))
  .then(() => {
    input.value = '';
    // turn off typing flag
    chatRef.set({ typing: false }, { merge: true }).catch(()=>{});
  })
  .catch(err => {
    console.error('sendChat error', err);
    alert('Failed to send message.');
  });
}

function debounceCustomerTyping(){
  const user = firebase.auth().currentUser;
  if (!user) return;
  const chatDocRef = chatsRef().doc(user.uid);
  chatDocRef.set({ typing: true }, { merge: true }).catch(()=>{});
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(()=>{ chatDocRef.set({ typing: false }, { merge: true }).catch(()=>{}); }, TYPING_DEBOUNCE_MS);
}

/* ----------------- ADMIN SIDE (upgraded UI) ----------------- */

async function renderAdminUserList(snapshot){
  const listEl = document.getElementById('chat-users');
  if (!listEl) return;
  if (snapshot.empty) {
    listEl.innerHTML = '<div style="padding:12px;color:#ddd">No chat users yet.</div>';
    updateGlobalNotifBadge(0);
    return;
  }

  const docs = [];
  snapshot.forEach(d => docs.push({ id: d.id, ...(d.data()||{}) }));

  // fetch unread counts & last message previews in parallel
  const unreadPromises = docs.map(doc =>
    chatsRef().doc(doc.id).collection('messages')
      .where('sender','==','customer').where('readByAdmin','==',false).get()
      .then(s => ({ id: doc.id, unread: s.size })).catch(()=>({ id: doc.id, unread: 0 }))
  );
  const lastPromises = docs.map(doc =>
    chatsRef().doc(doc.id).collection('messages').orderBy('timestamp','desc').limit(1).get()
      .then(s => ({ id: doc.id, last: s.empty ? null : s.docs[0].data() })).catch(()=>({ id: doc.id, last: null }))
  );

  const unreadResults = await Promise.all(unreadPromises);
  const lastResults = await Promise.all(lastPromises);
  const unreadMap = Object.fromEntries(unreadResults.map(x => [x.id, x.unread]));
  const lastMap = Object.fromEntries(lastResults.map(x => [x.id, x.last]));

  // build HTML
  const html = docs.map(doc => {
    const uid = doc.id;
    const name = doc.name || doc.username || uid;
    const initials = (name.split(' ').map(p=>p[0]).join('').slice(0,2) || 'U').toUpperCase();
    const last = lastMap[uid];
    const preview = last ? (String(last.message).length > 40 ? String(last.message).slice(0,37)+'...' : last.message) : 'No messages';
    const ts = last && last.timestamp ? (last.timestamp.toDate ? last.timestamp.toDate().toLocaleString() : new Date(last.timestamp).toLocaleString()) : '';
    const unread = unreadMap[uid] || 0;
    chatUsersCache[uid] = { name, initials, preview, ts, unread };
    return `
      <button class="user-btn" data-uid="${uid}" onclick="openAdminChat('${uid}')">
        <div class="user-avatar">${initials}</div>
        <div class="user-meta">
          <div class="user-name">${escapeHtml(name)}</div>
          <div class="user-last">${escapeHtml(preview)} · <span style="color:#6d7880">${escapeHtml(ts)}</span></div>
        </div>
        ${unread>0?`<div class="user-badge">${unread}</div>`:''}
      </button>
    `;
  }).join('');

  listEl.innerHTML = html;

  // wire search filter if exists
  const search = document.getElementById('chat-search');
  if (search) {
    search.addEventListener('input', debounce(() => {
      const qv = (search.value || '').trim().toLowerCase();
      qAll('#chat-users .user-btn').forEach(btn => {
        const uid = btn.getAttribute('data-uid');
        const info = chatUsersCache[uid] || {};
        const match = (info.name||'').toLowerCase().includes(qv) || (info.preview||'').toLowerCase().includes(qv) || uid.includes(qv);
        btn.style.display = match ? 'flex' : 'none';
      });
    }, 150));
  }
}

function loadChatUsersRealtime(){
  const listEl = document.getElementById('chat-users');
  if (!listEl) return;
  if (adminUsersUnsub) { try{ adminUsersUnsub(); } catch(e){} adminUsersUnsub = null; }

  adminUsersUnsub = chatsRef().orderBy('updatedAt','desc').onSnapshot(async snap => {
    try { await renderAdminUserList(snap); } catch(err) { console.error('renderAdminUserList error', err); }
  }, err => {
    console.error('loadChatUsersRealtime error', err);
    listEl.innerHTML = '<div style="padding:12px;color:#f66">Failed to load users.</div>';
  });
}

async function openAdminChat(userId){
  currentAdminChatUser = userId;
  // show header
  const nameEl = document.getElementById('chat-with');
  const avatarEl = document.getElementById('chat-avatar');
  const lastSeen = document.getElementById('chat-last-seen');
  try {
    const doc = await chatsRef().doc(userId).get();
    const data = doc.exists ? doc.data() : {};
    const name = data.name || userId;
    nameEl.textContent = name;
    avatarEl.textContent = (name.split(' ').map(p=>p[0]).join('').slice(0,2) || 'U').toUpperCase();
    lastSeen.textContent = data.updatedAt ? fmtTime(data.updatedAt) : '';
  } catch(e) { console.error('openAdminChat header fetch error', e); }

  // mark unread -> read
  await markMessagesReadForAdmin(userId);

  // show messages box
  attachAdminMessagesListener(userId);
  // reveal hangup/call button states reset
  q('#btn-hangup') && (q('#btn-hangup').style.display = 'none');
  q('#btn-call') && (q('#btn-call').style.display = 'inline-block');
}

function attachAdminMessagesListener(userId){
  if (adminMessagesUnsub) { try{ adminMessagesUnsub(); } catch(e){} adminMessagesUnsub = null; }
  const box = document.getElementById('chat-admin-messages');
  if (!box) return;
  box.innerHTML = '<div style="padding:12px;color:#ddd">Loading messages…</div>';

  const qref = chatsRef().doc(userId).collection('messages').orderBy('timestamp','asc');
  adminMessagesUnsub = qref.onSnapshot(snapshot => {
    box.innerHTML = '';
    if (snapshot.empty) { box.innerHTML = '<div style="padding:12px;color:#ddd">No messages yet.</div>'; return; }
    snapshot.forEach(doc => {
      const m = doc.data();
      const wrapper = document.createElement('div');
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      wrapper.style.alignItems = (m.sender === 'admin') ? 'flex-end' : 'flex-start';

      const bubble = document.createElement('div');
      bubble.className = (m.sender === 'admin') ? 'bubble-admin' : 'bubble-customer';
      bubble.textContent = m.message;

      const t = document.createElement('div');
      t.className = 'msg-time';
      t.textContent = m.timestamp ? (m.timestamp.toDate ? m.timestamp.toDate().toLocaleString() : new Date(m.timestamp).toLocaleString()) : '';

      wrapper.appendChild(bubble);
      wrapper.appendChild(t);
      box.appendChild(wrapper);
    });

    // typing indicator: show customer typing flag if set
    chatsRef().doc(userId).get().then(doc => {
      const typing = doc.exists ? doc.data().typing : false;
      const typingEl = document.getElementById('chat-typing');
      if (typing) typingEl.textContent = 'Customer is typing…';
      else typingEl.textContent = '';
    }).catch(()=>{});

    box.scrollTop = box.scrollHeight;
  }, err => {
    console.error('attachAdminMessagesListener error', err);
    box.innerHTML = '<div style="padding:12px;color:#f66">Failed to load messages.</div>';
  });
}

function adminSendChat(){
  const input = document.getElementById('admin-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const uid = currentAdminChatUser;
  if (!uid) return alert('Select a user first');

  const chatRef = chatsRef().doc(uid);
  const msgs = chatRef.collection('messages');

  msgs.add({
    sender: 'admin',
    message: text,
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    readByAdmin: true,
    readByCustomer: false
  }).then(() => {
    chatRef.set({ unreadForAdmin: false, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    input.value = '';
  }).catch(err => {
    console.error('adminSendChat error', err);
    alert('Failed to send message.');
  });
}

async function markMessagesReadForAdmin(userId){
  if (!userId) return;
  try {
    const q = chatsRef().doc(userId).collection('messages').where('sender','==','customer').where('readByAdmin','==',false);
    const snap = await q.get();
    if (snap.empty) {
      await chatsRef().doc(userId).set({ unreadForAdmin: false }, { merge: true });
      return;
    }
    const batch = db.batch();
    snap.forEach(d => batch.update(d.ref, { readByAdmin: true }));
    batch.update(chatsRef().doc(userId), { unreadForAdmin: false });
    await batch.commit();
  } catch (err) {
    console.error('markMessagesReadForAdmin error', err);
  }
}

/* ----------------- Global Notifications & watcher ----------------- */

// update global badge element (you can add a badge element with id="chat-notif" if you want)
function updateGlobalNotifBadge(count){
  const badge = document.getElementById('chat-notif');
  if (!badge) return;
  if (count > 0) { badge.style.display = 'inline-block'; badge.textContent = count > 99 ? '99+' : String(count); }
  else { badge.style.display = 'none'; badge.textContent = ''; }
}

// collectionGroup watcher to get new customer messages (used for notifications)
function attachGlobalMessageWatcherForNotifications(){
  try {
    db.collectionGroup('messages').orderBy('timestamp','desc').limit(50).onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        if (change.type !== 'added') return;
        const m = change.doc.data();
        if (!m || m.sender !== 'customer') return;
        const pathParts = change.doc.ref.path.split('/'); // ['chats','{uid}','messages','{msgId}']
        const uid = pathParts[1];
        notifyAdminOfIncomingMessage(uid, m.name || '', m.message);
        // small instant badge bump (real unread recalculated by list render)
        const badge = document.getElementById('chat-notif');
        if (badge) {
          const curr = badge.style.display === 'inline-block' ? (Number(badge.textContent.replace('+','')) || 0) : 0;
          updateGlobalNotifBadge(curr + 1);
        }
      });
    }, err => { console.warn('global message watcher error', err); });
  } catch(e) {
    // collectionGroup might be restricted by rules/plans; ignore
    console.warn('collectionGroup watcher unavailable', e);
  }
}

function notifyAdminOfIncomingMessage(userId, name, message){
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission !== 'granted') return;
    const isActive = (document.visibilityState === 'visible') && (currentAdminChatUser === userId);
    if (isActive) return;
    const n = new Notification(name || 'Customer', {
      body: message && message.length > 100 ? message.slice(0,97) + '...' : message,
      tag: `chat-${userId}`,
      renotify: true
    });
    n.onclick = () => { window.focus(); openAdminChat(userId); n.close(); };
  } catch(e) { /* ignore */ }
}

/* ------------------- CALL SYSTEM (WebRTC using Firestore signaling) ------------------- */
/* Basic flows provided for testing:
   - startCallAsCustomer() creates call doc with callerId = user.uid and calleeId chosen (simple admin pick)
   - startCallAsAdmin(userId) creates call doc with callerId = admin.uid and calleeId = userId
   - answerCallAsAdmin(callId) and the customer flow listen for answer
   - Uses collections: calls/{callId} with fields offer/answer and subcollections offerCandidates/answerCandidates
*/

async function prepareLocalMedia(){
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:true });
    const localEl = document.getElementById('local-video');
    if (localEl) localEl.srcObject = localStream;
  } catch (err) {
    console.error('prepareLocalMedia error', err);
    alert('Unable to access camera/microphone. Check permissions.');
    throw err;
  }
}

async function createPeerConnection(callRef, amICaller = false){
  pc = new RTCPeerConnection(rtcConfig);

  // remote element
  remoteStream = new MediaStream();
  const remoteEl = document.getElementById('remote-video');
  if (remoteEl) remoteEl.srcObject = remoteStream;

  // add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.ontrack = event => {
    event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
  };

  // add ICE candidate -> write to appropriate subcollection depending on role
  pc.onicecandidate = event => {
    if (!event.candidate) return;
    const cand = event.candidate.toJSON();
    if (!callRef || !callRef.id) return;
    // we determine where to put candidate by reading call doc's offer/answer presence
    callRef.get().then(doc => {
      const data = doc.data()||{};
      // If offer exists and amICaller true -> add to offerCandidates, else use answerCandidates for answer side.
      // Simpler detection: if amICaller true -> offerCandidates, else answerCandidates
      const colName = amICaller ? 'offerCandidates' : 'answerCandidates';
      callRef.collection(colName).add(cand).catch(()=>{});
    }).catch(()=>{});
  };

  // listen for remote ICE candidates inline is handled in caller/answer flows
  return pc;
}

async function startCallAsCustomer(){
  const user = firebase.auth().currentUser;
  if (!user) return alert('Please login to start a call.');

  // simple selection: choose any admin user (first)
  const adminSnap = await usersRef().where('role','==','admin').limit(1).get();
  if (adminSnap.empty) return alert('No admin available for calls.');
  const adminDoc = adminSnap.docs[0];
  const calleeId = adminDoc.id;

  const callRef = callsRef().doc();
  currentCallId = callRef.id;

  await callRef.set({ callerId: user.uid, calleeId, state: 'requested', createdAt: firebase.firestore.FieldValue.serverTimestamp() });

  await prepareLocalMedia();
  await createPeerConnection(callRef, true);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await callRef.set({ offer: { type: offer.type, sdp: offer.sdp }, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });

  // listen for answer
  callRef.onSnapshot(async snap => {
    const data = snap.data();
    if (!data) return;
    if (data.answer && pc && !pc.currentRemoteDescription) {
      const answer = new RTCSessionDescription(data.answer);
      await pc.setRemoteDescription(answer);
    }
    if (data.state === 'ended') hangupCall();
  });

  // listen for answer candidates
  callRef.collection('answerCandidates').onSnapshot(snap => {
    snap.docChanges().forEach(async change => {
      if (change.type === 'added' && change.doc.exists) {
        try { await pc.addIceCandidate(new RTCIceCandidate(change.doc.data())); } catch(e){ console.warn('addIceCandidate', e); }
      }
    });
  });

  // write offerCandidates handled in createPeerConnection by amICaller flag
  alert('Calling admin...');
}

async function startCallAsAdmin(userId){
  const me = firebase.auth().currentUser;
  if (!me) return alert('Login as admin to start a call.');
  if (!userId) return alert('Select a user to call.');

  const callRef = callsRef().doc();
  currentCallId = callRef.id;

  await callRef.set({ callerId: me.uid, calleeId: userId, state: 'requested', createdAt: firebase.firestore.FieldValue.serverTimestamp() });

  await prepareLocalMedia();
  await createPeerConnection(callRef, true);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await callRef.set({ offer: { type: offer.type, sdp: offer.sdp }, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });

  // listen for answer
  callRef.onSnapshot(async snap => {
    const data = snap.data();
    if (!data) return;
    if (data.answer && pc && !pc.currentRemoteDescription) {
      const answer = new RTCSessionDescription(data.answer);
      await pc.setRemoteDescription(answer);
    }
    if (data.state === 'ended') hangupCall();
  });

  // accept incoming candidate answers
  callRef.collection('answerCandidates').onSnapshot(snap => {
    snap.docChanges().forEach(async ch => {
      if (ch.type === 'added') {
        try { await pc.addIceCandidate(new RTCIceCandidate(ch.doc.data())); } catch(e){ console.warn('addIceCandidate', e); }
      }
    });
  });
}

async function answerCallAsAdmin(callId){
  try {
    if (!callId) return;
    await prepareLocalMedia();
    const callRef = callsRef().doc(callId);
    const callDoc = await callRef.get();
    if (!callDoc.exists) return;
    const data = callDoc.data();

    // create peer connection as answerer
    await createPeerConnection(callRef, false);

    // set remote description from offer
    if (data.offer) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await callRef.update({ answer: { type: answer.type, sdp: answer.sdp }, state: 'accepted', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

    // listen for offerCandidates
    callRef.collection('offerCandidates').onSnapshot(snap => {
      snap.docChanges().forEach(async change => {
        if (change.type === 'added') {
          try { await pc.addIceCandidate(new RTCIceCandidate(change.doc.data())); } catch(e){ console.warn('addIceCandidate', e); }
        }
      });
    });

    // write answerCandidates from pc.onicecandidate created by createPeerConnection
  } catch(e){ console.error('answerCallAsAdmin error', e); }
}

async function listenForCallRequests(){
  const me = firebase.auth().currentUser;
  if (!me) return;
  callsRef().where('calleeId','==',me.uid).where('state','==','requested').onSnapshot(snap => {
    snap.docChanges().forEach(change => {
      if (change.type === 'added') {
        const data = change.doc.data();
        const callId = change.doc.id;
        // simple prompt - you can build custom UI instead
        if (confirm(`Incoming call from ${data.callerId || 'Customer'}. Accept?`)) {
          answerCallAsAdmin(callId);
        } else {
          callsRef().doc(callId).update({ state: 'ended' }).catch(()=>{});
        }
      }
    });
  });
}

async function hangupCall(){
  try {
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (remoteStream) { remoteStream.getTracks().forEach(t => t.stop()); remoteStream = null; }
    if (currentCallId) {
      await callsRef().doc(currentCallId).update({ state: 'ended' }).catch(()=>{});
      currentCallId = null;
    }
    const localEl = document.getElementById('local-video'); if (localEl) localEl.srcObject = null;
    const remoteEl = document.getElementById('remote-video'); if (remoteEl) remoteEl.srcObject = null;
    q('#btn-hangup') && (q('#btn-hangup').style.display = 'none');
    q('#btn-call') && (q('#btn-call').style.display = 'inline-block');
  } catch(e) { console.warn('hangupCall', e); }
}

/* ---------- Auth: signup/login/logout ---------- */
async function signupUser(e){
  e.preventDefault();
  const username = (q('#signup-username')||{}).value?.trim();
  const email = (q('#signup-email')||{}).value?.trim();
  const password = (q('#signup-password')||{}).value;
  if (!username || !email || !password) { alert('Complete all fields'); return false; }
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;
    await usersRef().doc(uid).set({
      username,
      email,
      role: 'customer',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    alert('Account created. Redirecting to store...');
    window.location.href = 'index.html';
  } catch (err) { console.error(err); alert(err.message || 'Signup failed'); }
  return false;
}

async function loginUser(e){
  e.preventDefault();
  const email = (q('#login-username')||{}).value?.trim();
  const password = (q('#login-password')||{}).value;
  if (!email || !password) { alert('Complete fields'); return false; }
  try { await auth.signInWithEmailAndPassword(email, password); }
  catch (err) { console.error(err); alert(err.message || 'Login failed'); }
  return false;
}

function logoutUser(){ auth.signOut(); }

/* ---------- auth state & UI ---------- */
function bindAuthState(){
  auth.onAuthStateChanged(async user => {
    const welcome = q('#welcome-user-top');
    const loginLink = q('#login-link');
    const signupLink = q('#signup-link');
    const adminLink = q('#admin-link');
    if (user) {
      try {
        const doc = await usersRef().doc(user.uid).get();
        const username = doc.exists ? (doc.data().username || user.email.split('@')[0]) : user.email.split('@')[0];
        if (welcome) welcome.textContent = `Hi, ${username}`;
        if (loginLink) loginLink.style.display = 'none';
        if (signupLink) signupLink.style.display = 'none';
        if (doc.exists && doc.data().role === 'admin') {
          if (adminLink) adminLink.style.display = 'inline-block';
          if (location.pathname.endsWith('login.html')) window.location.href = 'admin.html';
        }
      } catch (err) { console.error('Failed to read user doc', err); }
    } else {
      if (welcome) welcome.textContent = '';
      if (loginLink) loginLink.style.display = 'inline-block';
      if (signupLink) signupLink.style.display = 'inline-block';
      if (adminLink) adminLink.style.display = 'none';
    }
  });
}

/* ---------- INDEX PAGE: products listing ---------- */
let lastProducts = [];
function initIndex(){
  if (!q('#catalog')) return;

  productsRef().orderBy('createdAt','desc').onSnapshot(snapshot => {
    const arr = [];
    snapshot.forEach(doc => arr.push({ id: doc.id, ...doc.data() }));
    lastProducts = arr;
    renderProducts(arr);
    populateFilters(arr);
  }, err => console.error('products listener error', err));

  const search = q('#search-input'); if (search) search.addEventListener('input', debounce(applyFilters,150));
  const cat = q('#category-filter'); if (cat) cat.addEventListener('change', applyFilters);
  const sort = q('#sort-select'); if (sort) sort.addEventListener('change', applyFilters);

  const cartBtn = q('#cart-btn'); if (cartBtn) cartBtn.addEventListener('click', ()=>toggleCart(true));

  renderCartCount();
}

function renderProducts(list){
  const container = q('#catalog'); if (!container) return;
  container.innerHTML = list.map(p => `
    <article class="card-product" data-id="${p.id}">
      <img src="${p.imgUrl || p.img || placeholderDataURL(p.title)}" alt="${escapeHtml(p.title)}" onclick="openProductModal('${p.id}')" />
      <h4>${escapeHtml(p.title)}</h4>
      <div class="meta"><div class="price">${money(p.price)}</div><div class="muted small">${escapeHtml(p.category)}</div></div>
      <div class="muted small">${escapeHtml(p.desc||'')}</div>
      <div class="card-actions">
        <button class="btn" onclick="openProductModal('${p.id}')">View</button>
        <button class="btn primary" onclick="addToCartById('${p.id}',1)">Add to cart</button>
      </div>
    </article>
  `).join('');
  applyFilters();
}

function populateFilters(list){
  list = list || lastProducts || [];
  const categories = Array.from(new Set(list.map(x=>x.category).filter(Boolean)));
  const sel = q('#category-filter'); if (!sel) return;
  sel.innerHTML = `<option value="">All categories</option>` + categories.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}

function applyFilters(){
  const qv = (q('#search-input')||{}).value?.trim().toLowerCase() || '';
  const cat = (q('#category-filter')||{}).value || '';
  const sort = (q('#sort-select')||{}).value || 'popular';
  let list = lastProducts.slice();
  if (qv) list = list.filter(p => (p.title||'').toLowerCase().includes(qv) || (p.desc||'').toLowerCase().includes(qv));
  if (cat) list = list.filter(p => p.category === cat);
  if (sort==='price-asc') list.sort((a,b)=>a.price-b.price);
  if (sort==='price-desc') list.sort((a,b)=>b.price-a.price);
  if (sort==='newest') list.sort((a,b)=>b.createdAt?.seconds - a.createdAt?.seconds);
  const container = q('#catalog'); if (!container) return;
  container.innerHTML = list.map(p => `
    <article class="card-product" data-id="${p.id}">
      <img src="${p.imgUrl || p.img || placeholderDataURL(p.title)}" alt="${escapeHtml(p.title)}" onclick="openProductModal('${p.id}')" />
      <h4>${escapeHtml(p.title)}</h4>
      <div class="meta"><div class="price">${money(p.price)}</div><div class="muted small">${escapeHtml(p.category)}</div></div>
      <div class="muted small">${escapeHtml(p.desc||'')}</div>
      <div class="card-actions">
        <button class="btn" onclick="openProductModal('${p.id}')">View</button>
        <button class="btn primary" onclick="addToCartById('${p.id}',1)">Add to cart</button>
      </div>
    </article>
  `).join('');
}

/* ---------- Product modal ---------- */
async function openProductModal(id){
  try {
    const doc = await productsRef().doc(id).get();
    if (!doc.exists) return alert('Product not found');
    const p = { id: doc.id, ...doc.data() };
    const el = q('#product-detail');
    if (!el) return;
    el.innerHTML = `
      <div style="display:flex;gap:18px;flex-wrap:wrap">
        <div style="flex:1;min-width:260px"><img src="${p.imgUrl || p.img || placeholderDataURL(p.title)}" style="width:100%;border-radius:10px;object-fit:cover"/></div>
        <div style="flex:1;min-width:260px">
          <h2>${escapeHtml(p.title)}</h2>
          <div class="muted">${escapeHtml(p.category)}</div>
          <p style="margin:12px 0;color:#ddd">${escapeHtml(p.desc||'')}</p>
          <div style="font-size:1.2rem;font-weight:700">${money(p.price)}</div>
          <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn primary" onclick="addToCartById('${p.id}',1);closeProductModal()">Add to cart</button>
            <button class="btn ghost" onclick="closeProductModal()">Close</button>
          </div>
        </div>
      </div>
    `;
    const modal = q('#product-modal'); if(modal){ modal.style.display = 'flex'; modal.setAttribute('aria-hidden','false'); }
  } catch (err) { console.error(err); alert('Open product failed'); }
}
function closeProductModal(){ const m = q('#product-modal'); if (m){ m.style.display='none'; m.setAttribute('aria-hidden','true'); } }

/* ---------- Cart ---------- */
function getCart(){ try { return JSON.parse(localStorage.getItem('ct_cart')||'[]'); } catch(e){ return []; } }
function saveCart(c){ localStorage.setItem('ct_cart', JSON.stringify(c)); renderCartCount(); }
function renderCartCount(){ const el = q('#cart-count'); if (!el) return; const c = getCart().reduce((s,i)=>s+(i.qty||1),0); el.textContent = c; }
function addToCartById(id, qty=1){ const cart = getCart(); const ex = cart.find(i=>i.id===id); if (ex) ex.qty+=qty; else cart.push({id, qty}); saveCart(cart); toggleCart(true); renderCartUI(); }
function changeQty(id, delta){ const cart = getCart(); const it = cart.find(i=>i.id===id); if(!it) return; it.qty+=delta; if(it.qty<=0){ if(!confirm('Remove item?')){ it.qty=1; }else{ cart.splice(cart.findIndex(i=>i.id===id),1); } } saveCart(cart); renderCartUI(); }
function removeFromCart(id){ const cart=getCart().filter(i=>i.id!==id); saveCart(cart); renderCartUI(); }
function toggleCart(show){ const panel = q('#cart-panel'); if(!panel) return; panel.style.display=show?'flex':'none'; if(show) renderCartUI(); }

function renderCartUI(){
  const container = q('#cart-items'); if(!container) return;
  const cart = getCart();
  if(cart.length===0){ container.innerHTML=`<div style="padding:18px;color:var(--muted)">Your cart is empty.</div>`; q('#cart-total')&&(q('#cart-total').textContent=money(0)); return; }
  Promise.all(cart.map(ci=>productsRef().doc(ci.id).get())).then(docs=>{
    const items = docs.map((doc,idx)=>({id:doc.id, ...(doc.data()||{}), qty: cart[idx].qty}));
    container.innerHTML = items.map(it=>`
      <div class="cart-item" data-id="${it.id}">
        <img src="${it.imgUrl || it.img || placeholderDataURL(it.title)}" alt="${escapeHtml(it.title)}" />
        <div class="info">
          <div style="display:flex;justify-content:space-between"><div>${escapeHtml(it.title)}</div><div class="muted">${money(it.price)}</div></div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
            <div style="display:flex;align-items:center;gap:8px">
              <button class="btn small" onclick="changeQty('${it.id}',-1)">−</button>
              <div style="padding:6px 10px;border-radius:6px;background:#111;color:#fff">${it.qty}</div>
              <button class="btn small" onclick="changeQty('${it.id}',1)">+</button>
            </div>
            <button class="btn ghost" onclick="removeFromCart('${it.id}')">Remove</button>
          </div>
        </div>
      </div>
    `).join('');
    const total = items.reduce((s,i)=>s+i.price*i.qty,0);
    q('#cart-total').textContent = money(total);
  });
}

/* ---------- Checkout ---------- */
async function placeOrder(e){
  e.preventDefault();
  const user = auth.currentUser;
  if(!user){ alert('Please login first'); window.location.href='login.html'; return false; }

  const name = (q('#chk-name')||{}).value?.trim();
  const address = (q('#chk-address')||{}).value?.trim();
  const phone = (q('#chk-phone')||{}).value?.trim();
  const payment = (q('#chk-payment')||{}).value || 'COD';
  if(!name || !address || !phone){ alert('Complete all fields'); return false; }

  const cart = getCart();
  if(!cart.length){ alert('Cart is empty'); return false; }

  try{
    const snaps = await Promise.all(cart.map(ci=>productsRef().doc(ci.id).get()));
    const invalid = snaps.filter(s=>!s.exists);
    if(invalid.length){ alert('Some items are no longer available. Refresh cart.'); return false; }

    const items = snaps.map((doc, idx)=>({
      productId: doc.id,
      title: doc.data().title,
      price: doc.data().price,
      qty: cart[idx].qty
    }));
    const total = items.reduce((sum, i)=>sum + i.price * i.qty, 0);

    const orderObj = {
      userId: user.uid,
      userName: name,
      phone,
      address,
      payment,
      items,
      total,
      status: 'Pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    const orderRef = await ordersRef().add(orderObj);

    saveCart([]);
    renderCartCount();
    toggleCart(false);
    closeCheckout();

    openOrderSummary(`Your order ID is ${orderRef.id}. You can track its status in "My Orders".`);

  } catch(err){
    console.error(err);
    alert('Checkout failed: ' + (err.message || err));
  }

  return false;
}

function openCheckout(){ const modal = q('#checkout-modal'); if(modal) modal.style.display='flex'; modal.setAttribute('aria-hidden','false'); }
function closeCheckout(){ const modal = q('#checkout-modal'); if(modal) modal.style.display='none'; modal.setAttribute('aria-hidden','true'); }

/* ---------- Customer Orders ---------- */
function initCustomerOrders(){
  const container = q('#orders-table');
  if(!container) return;

  auth.onAuthStateChanged(user => {
    if(!user){ alert('Please login to view your orders'); window.location.href = 'login.html'; return; }

    ordersRef()
      .where('userId', '==', user.uid)
      .orderBy('createdAt', 'desc')
      .onSnapshot(snapshot => {
        const orders = [];
        snapshot.forEach(doc => {
          const data = doc.data();
          orders.push({
            id: doc.id,
            items: data.items || [],
            total: data.total || 0,
            status: data.status || 'Pending',
            createdAt: data.createdAt ? data.createdAt.toDate() : new Date()
          });
        });

        if(!orders.length){ container.innerHTML = '<p>You have no orders yet.</p>'; return; }

        container.innerHTML = orders.map(o => `
          <div class="order-card">
            <div><strong>Order ID:</strong> ${o.id}</div>
            <div><strong>Date:</strong> ${o.createdAt.toLocaleString()}</div>
            <div><strong>Total:</strong> ₱${o.total.toLocaleString()}</div>
            <div><strong>Status:</strong> <span class="order-status">${o.status}</span></div>
            <div><strong>Items:</strong><br/>${o.items.map(i => `${i.title} ×${i.qty}`).join('<br/>')}</div>
            <hr/>
          </div>
        `).join('');
      }, err => {
        console.error('Orders listener error', err);
        container.innerHTML = '<p>Failed to load orders, please refresh the page.</p>';
      });
  });
}

/* ---------- Admin ---------- */
let adminProducts=[];
function initAdmin(){
  if(!q('#admin-product-list')) return;

  productsRef().orderBy('createdAt','desc').onSnapshot(snap=>{ const arr=[]; snap.forEach(d=>arr.push({id:d.id,...d.data()})); adminProducts=arr; renderAdminProducts(); });
  renderAdminProducts();
  initAdminOrders();
}

function renderAdminProducts(){
  const container = q('#admin-product-list'); if(!container) return;
  const search = (q('#admin-search')||{}).value?.trim().toLowerCase();
  let list = adminProducts;
  if(search) list = list.filter(p => p.title.toLowerCase().includes(search) || (p.category || '').toLowerCase().includes(search));
  container.innerHTML = list.map(p=>{
    const imgSrc = p.imgUrl || placeholderDataURL(p.title);
    return `
      <div class="admin-item" style="display:flex; align-items:center; gap:12px; padding:12px; border-bottom:1px solid #333; background:#111; color:#eee; border-radius:8px;">
        <div style="flex:0 0 100px;"><img src="${imgSrc}" alt="${escapeHtml(p.title)}" style="width:100px;height:100px;object-fit:cover;border-radius:8px;border:1px solid #444;"></div>
        <div style="flex:1; display:flex; flex-direction:column; gap:4px;"><strong>${escapeHtml(p.title)}</strong><div>${money(p.price)}</div><div style="opacity:0.7">${escapeHtml(p.category)}</div></div>
        <div style="flex:0 0 auto; display:flex; gap:8px;"><button class="btn small" onclick="editProduct('${p.id}')">Edit</button><button class="btn ghost small" onclick="deleteProduct('${p.id}')">Delete</button></div>
      </div>
    `;
  }).join('');
}

function showAddProduct(){ q('#product-form-area').style.display='block'; q('#product-form-title').textContent='Add Product'; q('#product-form').reset(); q('#p-id').value=''; }
function hideProductForm(){ q('#product-form-area').style.display='none'; }

async function saveProduct(e){
  e.preventDefault();
  const id = q('#p-id').value;
  const title = q('#p-title').value.trim();
  const price = Number(q('#p-price').value);
  const stock = Number(q('#p-stock').value);
  const category = q('#p-category').value.trim();
  const desc = q('#p-desc').value.trim();
  const imgUrl = (q('#p-image-url')||{}).value.trim();
  if(!title || isNaN(price)) return alert('Invalid input');
  try{
    const data = {title, price, stock, category, desc};
    if(imgUrl) data.imgUrl = imgUrl;
    if(id) await productsRef().doc(id).update(data);
    else await productsRef().add({...data, createdAt: firebase.firestore.FieldValue.serverTimestamp()});
    hideProductForm();
  }catch(err){ console.error(err); alert('Failed to save product: '+(err.message||err)); }
}

async function editProduct(id){
  const doc = await productsRef().doc(id).get();
  if(!doc.exists) return alert('Product not found');
  const p = doc.data();
  q('#p-id').value=doc.id;
  q('#p-title').value=p.title;
  q('#p-price').value=p.price;
  q('#p-stock').value=p.stock||0;
  q('#p-category').value=p.category;
  q('#p-desc').value=p.desc||'';
  q('#p-image-url').value=p.imgUrl||'';
  q('#product-form-area').style.display='block';
  q('#product-form-title').textContent='Edit Product';
}

async function deleteProduct(id){ if(!confirm('Delete this product?')) return; try{ await productsRef().doc(id).delete(); } catch(err){ console.error(err); alert('Delete failed'); } }

function initAdminOrders(){
  const tbody = q('#admin-orders'); if(!tbody) return;
  ordersRef().orderBy('createdAt','desc').onSnapshot(snapshot=>{
    const rows = [];
    snapshot.forEach(doc=>{
      const o = {id: doc.id, ...doc.data()};
      const items = o.items.map(i=>`${i.title} ×${i.qty}`).join('<br>');
      const statusColor = { 'Pending':'orange','Processing':'blue','Shipped':'purple','Delivered':'green' }[o.status] || 'gray';
      rows.push(`
        <tr>
          <td>${o.id}</td>
          <td>${escapeHtml(o.userName)}</td>
          <td>${items}</td>
          <td>${money(o.total)}</td>
          <td style="color:${statusColor};font-weight:bold">${o.status}</td>
          <td>${o.status!=='Delivered'?`<button class="btn small" onclick="advanceOrder('${o.id}')">Next Stage</button>`:''}</td>
        </tr>
      `);
    });
    tbody.innerHTML = rows.join('');
  });
}

async function advanceOrder(id){
  const doc = await ordersRef().doc(id).get();
  if(!doc.exists) return alert('Order not found');
  const statusFlow = ['Pending','Processing','Shipped','Delivered'];
  const current = doc.data().status;
  const next = statusFlow[statusFlow.indexOf(current)+1];
  if(!next) return;
  await ordersRef().doc(id).update({status: next});
}

/* ---------- Footer ---------- */
function setFooterYear(){ const f=q('footer'); if(f) f.innerHTML=f.innerHTML.replace('{year}', new Date().getFullYear()); }

/* ---------- Small helper for quick-replies in admin UI ---------- */
function insertQuickReply(text){
  const el = document.getElementById('admin-chat-input');
  if (!el) return;
  el.value = text;
  el.focus();
}

/* ---------- Start global init for admin page (recalculate notifications) ---------- */
window.addEventListener('load', () => {
  // nothing extra here — page load logic lives above
});
