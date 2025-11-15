/* script.js — CobainTech Firebase edition (updated full) */

/* ---------- helpers ---------- */
function escapeHtml(s){ return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function debounce(fn, delay=200){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),delay); }; }
function q(sel){ return document.querySelector(sel); }
function qAll(sel){ return document.querySelectorAll(sel); }
function money(v){ return `₱${Number(v).toLocaleString()}`; }
function placeholderDataURL(text){ 
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='700'>
    <rect fill='#0b0c0e' width='100%' height='100%'/>
    <text x='50%' y='50%' font-size='48' font-family='Segoe UI, Roboto' fill='#fff' text-anchor='middle' alignment-baseline='middle'>${escapeHtml(text)}</text>
  </svg>`; 
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); 
}

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
  initCustomerOrders(); // Customer orders listener
});
/* ---------------------- Chat (compat SDK) ---------------------- */

const TYPING_DEBOUNCE_MS = 1200;
let typingTimer = null;
let customerChatUnsub = null;
let adminUsersUnsub = null;
let adminMessagesUnsub = null;
let currentAdminChatUser = null;

// --- Init hook called from window load (keeps your original call) ---
function initChat() {
  // auth state: set up store & admin listeners when user changes
  auth.onAuthStateChanged(user => {
    // Customer view: start listening to own messages
    if (document.getElementById('chat-messages')) {
      if (user) startCustomerChat(user.uid, user.displayName || null);
      else {
        const box = document.getElementById('chat-messages');
        if (box) box.innerHTML = `<div style="padding:12px;color:#ddd">Please login to chat with us.</div>`;
      }
    }

    // Admin view: show list of chat users realtime
    if (document.getElementById('chat-users')) {
      loadChatUsersRealtime();
      // request notification permission for admin
      if ("Notification" in window && Notification.permission !== "granted") {
        Notification.requestPermission().catch(()=>{});
      }
    }
  });

  // Wire input -> send (customer store)
  const chatInputEl = document.getElementById('chat-input');
  if (chatInputEl) {
    chatInputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); sendChat();
      }
    });
    // typing indicator: send typing state to chats/{uid}.typing
    chatInputEl.addEventListener('input', debounceCustomerTyping);
  }

  // Wire admin input Enter key for convenience
  const adminInput = document.getElementById('admin-chat-input');
  if (adminInput) {
    adminInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); adminSendChat();
      }
    });
  }
}

// ------------------- CUSTOMER (store) side -------------------
function startCustomerChat(userId, displayName = null) {
  // detach previous
  if (customerChatUnsub) { try { customerChatUnsub(); } catch(e){} customerChatUnsub = null; }

  const messagesBox = document.getElementById('chat-messages');
  if (!messagesBox) return;

  // ensure parent chat doc exists (merge)
  db.collection('chats').doc(userId).set({
    userId,
    name: displayName || '',
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true }).catch(err => console.error('init chat doc failed', err));

  // subscribe to messages
  const colRef = db.collection('chats').doc(userId).collection('messages');
  const q = colRef.orderBy('timestamp', 'asc');

  customerChatUnsub = q.onSnapshot(snapshot => {
    messagesBox.innerHTML = '';
    if (snapshot.empty) {
      messagesBox.innerHTML = `<div style="padding:12px;color:#ddd">No messages yet. Say hi 👋</div>`;
      return;
    }

    snapshot.forEach(doc => {
      const m = doc.data();
      appendCustomerMessageToUI(messagesBox, m);
    });

    // mark customer's view read flags if needed (set readByCustomer true for admin messages)
    markMessagesReadForCustomer(userId)
      .catch(err => console.error('mark read for customer failed', err));

    messagesBox.scrollTo({ top: messagesBox.scrollHeight, behavior: 'smooth' });
  }, err => {
    console.error('customer messages listener error', err);
    messagesBox.innerHTML = `<div style="padding:12px;color:#f66">Failed to load messages.</div>`;
  });

  // clear typing state when navigating away
  window.addEventListener('beforeunload', () => {
    db.collection('chats').doc(userId).set({ typing: false }, { merge: true });
  });
  
}
// ✅ Customer Side Chat Toggle (fix for "toggleChatBox is not defined")
function toggleChatBox() {
  const chatBox = document.getElementById("chat-box");
  if (!chatBox) return;

  if (chatBox.style.display === "flex" || chatBox.style.display === "") {
    chatBox.style.display = "none";
  } else {
    chatBox.style.display = "flex";
  }
}

function appendCustomerMessageToUI(container, m) {
  const time = m.timestamp ? m.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const wrap = document.createElement('div');
  wrap.style.marginBottom = '8px';
  wrap.style.textAlign = (m.sender === 'customer') ? 'right' : 'left';

  const bubble = document.createElement('span');
  bubble.textContent = m.message;
  bubble.style.display = 'inline-block';
  bubble.style.padding = '8px 12px';
  bubble.style.borderRadius = '12px';
  bubble.style.maxWidth = '78%';
  bubble.style.wordBreak = 'break-word';
  bubble.style.background = (m.sender === 'customer') ? '#3498db' : '#444';
  bubble.style.color = '#fff';

  // optionally show "delivered/seen" icons if you extend read receipts later
  const timeEl = document.createElement('div');
  timeEl.textContent = time;
  timeEl.style.fontSize = '0.75rem';
  timeEl.style.opacity = '0.7';
  timeEl.style.marginTop = '4px';

  wrap.appendChild(bubble);
  wrap.appendChild(timeEl);
  container.appendChild(wrap);
}

async function markMessagesReadForCustomer(userId) {
  // mark admin->customer messages as readByCustomer = true
  const msgsSnap = await db.collection('chats').doc(userId).collection('messages')
    .where('sender', '==', 'admin')
    .where('readByCustomer', '==', false)
    .get();

  if (msgsSnap.empty) return;
  const batch = db.batch();
  msgsSnap.forEach(d => batch.update(d.ref, { readByCustomer: true }));
  await batch.commit();
}

// send chat from customer
function sendChat() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;

  const user = firebase.auth().currentUser;
  if (!user) { alert('Please login to chat.'); return; }

  const chatDocRef = db.collection('chats').doc(user.uid);
  const messagesRef = chatDocRef.collection('messages');

  // update parent doc (name, updatedAt, unread flag for admin)
  const nameToSave = user.displayName || (user.email ? user.email.split('@')[0] : 'Customer');

  chatDocRef.set({
    userId: user.uid,
    name: nameToSave,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    unreadForAdmin: true // flag admin UI to show badge
  }, { merge: true })
  .then(() => {
    // add message doc
    return messagesRef.add({
      sender: 'customer',
      message,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      readByAdmin: false,
      readByCustomer: true
    });
  })
  .then(() => {
    input.value = '';
    // optionally collapse typing state
    chatDocRef.set({ typing: false }, { merge: true }).catch(()=>{});
  })
  .catch(err => {
    console.error('sendChat error', err);
    alert('Failed to send message. Check console.');
  });
}

// typing indicator: debounce updates to chats/{uid}.typing
function debounceCustomerTyping() {
  const user = firebase.auth().currentUser;
  if (!user) return;
  const chatDocRef = db.collection('chats').doc(user.uid);

  // set typing true immediately
  chatDocRef.set({ typing: true }, { merge: true }).catch(()=>{});

  // reset previous timer
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    chatDocRef.set({ typing: false }, { merge: true }).catch(()=>{});
  }, TYPING_DEBOUNCE_MS);
}

/* ----------- Admin Chat: enhanced logic (paste into script.js - replaces older admin chat functions) ----------- */

let adminUsersUnsub = null;
let adminMessagesUnsub = null;
let currentAdminChatUser = null;
let chatUsersCache = {}; // cache for quick lookups

// Helper: format time
function fmtTime(ts) {
  if (!ts) return '';
  try { return ts.toDate().toLocaleString(); } catch(e) { return new Date(ts).toLocaleString(); }
}

// Build and render user list (called from snapshot)
async function renderAdminUserList(snapshot) {
  const listEl = document.getElementById('chat-users');
  if (!listEl) return;
  if (snapshot.empty) { listEl.innerHTML = '<div style="padding:12px;color:#ddd">No chat users yet.</div>'; return; }

  // Build an array with last message preview & unread counts
  const rows = [];
  const docs = [];
  snapshot.forEach(doc => docs.push({ id: doc.id, ...doc.data() }));

  // For performance, we'll fetch unread counts in parallel (limited to displayed docs)
  const unreadPromises = docs.map(d => {
    return db.collection('chats').doc(d.id).collection('messages')
      .where('sender', '==', 'customer')
      .where('readByAdmin', '==', false).get()
      .then(s => ({ id: d.id, unread: s.size }))
      .catch(() => ({ id: d.id, unread: 0 }));
  });

  const lastMsgPromises = docs.map(d => {
    return db.collection('chats').doc(d.id).collection('messages')
      .orderBy('timestamp', 'desc').limit(1).get()
      .then(s => ({ id: d.id, last: s.empty ? null : s.docs[0].data() }))
      .catch(()=>({ id:d.id, last: null }));
  });

  const unreadResults = await Promise.all(unreadPromises);
  const lastResults = await Promise.all(lastMsgPromises);
  const unreadMap = Object.fromEntries(unreadResults.map(x=>[x.id, x.unread]));
  const lastMap = Object.fromEntries(lastResults.map(x=>[x.id, x.last]));

  // Build HTML
  const html = docs.map(d => {
    const name = d.name || d.username || d.userId || d.id;
    const initials = (name.split(' ').map(p=>p[0]).join('').slice(0,2) || 'U').toUpperCase();
    const last = lastMap[d.id];
    const preview = last ? (last.message.length>40 ? last.message.slice(0,37)+'...' : last.message) : 'No messages';
    const ts = last && last.timestamp ? (last.timestamp.toDate ? last.timestamp.toDate().toLocaleString() : new Date(last.timestamp).toLocaleString()) : '';
    const unread = unreadMap[d.id] || 0;
    // cache some info
    chatUsersCache[d.id] = { name, initials, preview, ts, unread };
    // highlight if current user selected
    const activeClass = (currentAdminChatUser === d.id) ? 'background:#18314a;border:1px solid #234455;' : '';
    return `
      <button class="user-btn" data-uid="${d.id}" onclick="openAdminChat('${d.id}')"
        style="${activeClass};display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;">
        <div class="user-avatar" style="background:#2f80ed">${initials}</div>
        <div class="user-meta">
          <div class="user-name">${escapeHtml(name)}</div>
          <div class="user-sub">${escapeHtml(preview)} · <span style="color:#6d7880">${escapeHtml(ts)}</span></div>
        </div>
        ${unread>0?`<div class="user-unread">${unread}</div>`:''}
      </button>
    `;
  }).join('');
  listEl.innerHTML = html;

  // update global notif badge
  const totalUnread = Object.values(unreadMap).reduce((s,n)=>s+n,0);
  updateGlobalNotifBadge(totalUnread);
}

// Listen to chats collection and render users
function loadChatUsersRealtime() {
  const listEl = document.getElementById('chat-users');
  if (!listEl) return;

  if (adminUsersUnsub) { try { adminUsersUnsub(); } catch(e){} adminUsersUnsub = null; }

  adminUsersUnsub = db.collection('chats')
    .orderBy('updatedAt','desc')
    .onSnapshot(async snap => {
      try {
        await renderAdminUserList(snap);
      } catch (err) { console.error('renderAdminUserList error', err); }
    }, err => {
      console.error('loadChatUsersRealtime error', err);
      listEl.innerHTML = '<div style="padding:12px;color:#f66">Failed to load users.</div>';
    });

  // enable search
  const search = document.getElementById('chat-search');
  if (search) {
    search.addEventListener('input', debounce(()=> {
      // simple client-side filter using cache
      const q = search.value.trim().toLowerCase();
      const buttons = document.querySelectorAll('#chat-users .user-btn');
      buttons.forEach(btn => {
        const uid = btn.getAttribute('data-uid');
        const info = chatUsersCache[uid] || {};
        const match = (info.name||'').toLowerCase().includes(q) || (info.preview||'').toLowerCase().includes(q) || uid.includes(q);
        btn.style.display = match ? 'flex' : 'none';
      });
    }, 200));
  }
}

// Open a chat (admin)
async function openAdminChat(userId) {
  currentAdminChatUser = userId;
  document.getElementById('chat-admin-messages').innerHTML = '<div style="padding:12px;color:#ddd">Loading messages…</div>';
  const chatPanelName = document.getElementById('chat-panel-name');
  const chatPanelAvatar = document.getElementById('chat-panel-avatar');
  const chatPanelSub = document.getElementById('chat-panel-sub');

  try {
    const doc = await db.collection('chats').doc(userId).get();
    const data = doc.exists ? doc.data() : {};
    const name = data.name || 'Customer';
    chatPanelName.textContent = name;
    chatPanelAvatar.textContent = (name.split(' ').map(p=>p[0]).join('').slice(0,2) || 'U').toUpperCase();
    chatPanelSub.textContent = data.updatedAt ? fmtTime(data.updatedAt) : '';
  } catch (err) {
    console.error('openAdminChat fetch error', err);
  }

  // mark unread as read and start listening messages
  await markMessagesReadForAdmin(userId);
  attachAdminMessagesListener(userId);

  // wire mark-read button
  const markBtn = document.getElementById('mark-read-btn');
  if (markBtn) markBtn.onclick = () => markMessagesReadForAdmin(userId);
}

// Attach listener to messages subcollection
function attachAdminMessagesListener(userId) {
  if (adminMessagesUnsub) { try { adminMessagesUnsub(); } catch(e){} adminMessagesUnsub = null; }
  const box = document.getElementById('chat-admin-messages');
  if (!box) return;
  const q = db.collection('chats').doc(userId).collection('messages').orderBy('timestamp','asc');

  adminMessagesUnsub = q.onSnapshot(snapshot => {
    box.innerHTML = '';
    if (snapshot.empty) {
      box.innerHTML = '<div style="padding:12px;color:#ddd">No messages yet.</div>';
      return;
    }

    snapshot.forEach(doc => {
      const m = doc.data();
      const wrapper = document.createElement('div');
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      wrapper.style.alignItems = (m.sender === 'admin') ? 'flex-end' : 'flex-start';

      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + (m.sender === 'admin' ? 'admin' : 'customer');
      bubble.textContent = m.message;

      const t = document.createElement('div');
      t.className = 'msg-time';
      t.textContent = m.timestamp ? (m.timestamp.toDate ? m.timestamp.toDate().toLocaleString() : new Date(m.timestamp).toLocaleString()) : '';

      wrapper.appendChild(bubble);
      wrapper.appendChild(t);
      box.appendChild(wrapper);
    });

    // autoscroll
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  }, err => {
    console.error('attachAdminMessagesListener error', err);
    box.innerHTML = '<div style="padding:12px;color:#f66">Failed to load messages.</div>';
  });

  // when messages arrive, show browser notification for new customer messages
  // We'll use a collectionGroup watcher elsewhere for notifications; here we keep UI listening simple.
}

// Admin send message (hooked to Send button)
function adminSendChat() {
  const input = document.getElementById('admin-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const uid = currentAdminChatUser;
  if (!uid) { alert('Select a user first'); return; }

  const chatRef = db.collection('chats').doc(uid);
  const messagesRef = chatRef.collection('messages');

  messagesRef.add({
    sender: 'admin',
    message: text,
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    readByAdmin: true,
    readByCustomer: false
  }).then(() => {
    // mark parent doc updated
    chatRef.set({ unreadForAdmin: false, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    input.value = '';
  }).catch(err => {
    console.error('adminSendChat error', err);
    alert('Failed to send message. Check console.');
  });
}

// mark customer messages as read by admin
async function markMessagesReadForAdmin(userId) {
  if (!userId) return;
  try {
    const q = db.collection('chats').doc(userId).collection('messages')
      .where('sender','==','customer')
      .where('readByAdmin','==',false);
    const snap = await q.get();
    if (snap.empty) {
      await db.collection('chats').doc(userId).set({ unreadForAdmin: false }, { merge: true });
      return;
    }
    const batch = db.batch();
    snap.forEach(d => batch.update(d.ref, { readByAdmin: true }));
    batch.update(db.collection('chats').doc(userId), { unreadForAdmin: false });
    await batch.commit();
    // refresh list
    // small delay to allow backend index updates then re-render list by re-triggering load state
    setTimeout(() => {
      if (adminUsersUnsub) { /* nothing, snapshot already active */ }
      else loadChatUsersRealtime();
    }, 300);
  } catch (err) {
    console.error('markMessagesReadForAdmin error', err);
  }
}

// close chat panel
function closeChat() {
  currentAdminChatUser = null;
  if (adminMessagesUnsub) { try { adminMessagesUnsub(); } catch(e){} adminMessagesUnsub = null; }
  const boxWrap = document.getElementById('chat-admin-box');
  if (boxWrap) boxWrap.style.display = 'none';
  document.getElementById('chat-admin-messages').innerHTML = '';
  // re-render users to clear active class
  db.collection('chats').get().then(snap => renderAdminUserList(snap)).catch(()=>{});
}

// quick reply wiring
(function wireQuickReplyAndSend(){
  // Send button
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'admin-send-btn') adminSendChat();
  });
  // Quick reply selection
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'quick-reply') {
      const val = e.target.value;
      if (val) {
        const input = document.getElementById('admin-chat-input');
        input.value = val;
      }
      e.target.selectedIndex = 0;
    }
  });
})();

// global unread badge update helper (expects an element with id 'chat-notif')
function updateGlobalNotifBadge(count) {
  const badge = document.getElementById('chat-notif');
  if (!badge) return;
  if (count > 0) {
    badge.style.display = 'inline-block';
    badge.textContent = count > 99 ? '99+' : String(count);
  } else {
    badge.style.display = 'none';
    badge.textContent = '';
  }
}

/* Optional: collectionGroup listener for global notifications (customer messages)
   This is best-effort (may require Firestore indexes / billing); keeps admin alerted even when not on the page.
*/
function startGlobalNotificationWatcher() {
  try {
    db.collectionGroup('messages').orderBy('timestamp','desc').limit(50).onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        if (change.type !== 'added') return;
        const m = change.doc.data();
        if (m.sender !== 'customer') return;
        const pathParts = change.doc.ref.path.split('/');
        const uid = pathParts[1];
        // show browser notification
        try {
          if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== 'visible') {
            const n = new Notification(m.name || 'Customer', { body: m.message.length>100?m.message.slice(0,97)+'...':m.message, tag: 'chat-'+uid });
            n.onclick = () => { window.focus(); openAdminChat(uid); n.close(); };
          }
        } catch(e){}
      });
    }, err => console.warn('global watcher error', err));
  } catch(e) { console.warn('collectionGroup watcher not available', e); }
}

// start the global watcher when chat UI exists
window.addEventListener('load', () => {
  if (document.getElementById('chat-users')) {
    loadChatUsersRealtime();
    startGlobalNotificationWatcher();
    // wire send action on Enter inside message input
    const adminInput = document.getElementById('admin-chat-input');
    if (adminInput) adminInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); adminSendChat(); }
    });
  }
});


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
    const modal = q('#product-modal'); modal.style.display = 'flex'; modal.setAttribute('aria-hidden','false');
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
  if(!user){ 
    alert('Please login first'); 
    window.location.href='login.html'; 
    return false; 
  }

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
    if(!user){
      alert('Please login to view your orders');
      window.location.href = 'login.html';
      return;
    }

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

        if(!orders.length){
          container.innerHTML = '<p>You have no orders yet.</p>';
          return;
        }

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

function openOrderSummary(text){
  const modal = q('#order-summary-modal');
  if(modal){
    q('#summary-text').textContent = text;
    modal.style.display='flex';
    modal.setAttribute('aria-hidden','false');
  }
}
function closeOrderSummary(){
  const modal = q('#order-summary-modal');
  if(modal){
    modal.style.display='none';
    modal.setAttribute('aria-hidden','true');
  }
}
function goToOrders(){ window.location.href='orders.html'; }

/* ---------- Admin ---------- */
let adminProducts=[];
function initAdmin(){
  if(!q('#admin-product-list')) return;

  productsRef().orderBy('createdAt','desc').onSnapshot(snap=>{
    const arr=[]; snap.forEach(d=>arr.push({id:d.id,...d.data()})); adminProducts=arr;
    renderAdminProducts();
  });

  renderAdminProducts();
  initAdminOrders(); // load admin orders table
}

function renderAdminProducts(){
  const container = q('#admin-product-list'); 
  if(!container) return;
  const search = (q('#admin-search')||{}).value?.trim().toLowerCase();
  let list = adminProducts;
  if(search) list = list.filter(p => 
    p.title.toLowerCase().includes(search) || 
    (p.category || '').toLowerCase().includes(search)
  );

  container.innerHTML = list.map(p=>{
    const imgSrc = p.imgUrl || placeholderDataURL(p.title); // ensure imgUrl is used
    return `
      <div class="admin-item" style="
          display:flex; 
          align-items:center; 
          gap:12px; 
          padding:12px; 
          border-bottom:1px solid #333;
          background:#111;
          color:#eee;
          border-radius:8px;
        ">
        <div style="flex:0 0 100px;">
          <img src="${imgSrc}" alt="${escapeHtml(p.title)}" 
               style="width:100px;height:100px;object-fit:cover;border-radius:8px;border:1px solid #444;">
        </div>
        <div style="flex:1; display:flex; flex-direction:column; gap:4px;">
          <strong>${escapeHtml(p.title)}</strong>
          <div>${money(p.price)}</div>
          <div style="opacity:0.7">${escapeHtml(p.category)}</div>
        </div>
        <div style="flex:0 0 auto; display:flex; gap:8px;">
          <button class="btn small" onclick="editProduct('${p.id}')">Edit</button>
          <button class="btn ghost small" onclick="deleteProduct('${p.id}')">Delete</button>
        </div>
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

/* ---------- Admin Orders Management ---------- */
function initAdminOrders(){
  const tbody = q('#admin-orders'); if(!tbody) return;
  ordersRef().orderBy('createdAt','desc').onSnapshot(snapshot=>{
    const rows = [];
    snapshot.forEach(doc=>{
      const o = {id: doc.id, ...doc.data()};
      const items = o.items.map(i=>`${i.title} ×${i.qty}`).join('<br>');
      const statusColor = {
        'Pending':'orange',
        'Processing':'blue',
        'Shipped':'purple',
        'Delivered':'green'
      }[o.status] || 'gray';
      rows.push(`
        <tr>
          <td>${o.id}</td>
          <td>${escapeHtml(o.userName)}</td>
          <td>${items}</td>
          <td>${money(o.total)}</td>
          <td style="color:${statusColor};font-weight:bold">${o.status}</td>
          <td>
            ${o.status!=='Delivered'?`<button class="btn small" onclick="advanceOrder('${o.id}')">Next Stage</button>`:''}
          </td>
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







