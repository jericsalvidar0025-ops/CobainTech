/* script.js — CobainTech Firebase edition (updated full) */

/* ---------- helpers ---------- */
function q(sel){ return document.querySelector(sel); }
function qAll(sel){ return document.querySelectorAll(sel); }
function money(v){ return `₱${Number(v).toLocaleString()}`; }
function escapeHtml(s){ return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function debounce(fn,d=200){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),d); }; }
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
/*
  Consistent, compat-style chat:
  - Customer messages stored at: chats/{userId}/messages
  - Admin lists users from chats collection and opens chats at chats/{userId}/messages
  - Uses firebase.firestore.FieldValue.serverTimestamp()
  - Matches DOM ids in index.html and admin (1).html
*/

function initChat() {
  // Called on page load (already in your load listener)
  // Bind expected behavior for pages:
  // - If on store page (index.html) -> enable customer chat listener / send
  // - If on admin page (admin.html) -> load list of chat users and allow admin replies

  auth.onAuthStateChanged(user => {
    // Customer (store) view
    if (document.getElementById("chat-messages")) {
      // chat box exists (store)
      if (user) {
        startCustomerChat(user.uid);
      } else {
        // ensure chat messages area is empty / show prompt
        const box = document.getElementById("chat-messages");
        if (box) box.innerHTML = `<div style="padding:12px;color:#ddd">Please login to chat with us.</div>`;
      }
    }

    // Admin view: show chat users list
    if (document.getElementById("chat-users")) {
      // Only admin should access admin.html, but listen regardless
      loadChatUsersRealtime();
    }
  });

  // Wire up UI buttons (store)
  const chatToggle = document.getElementById('chat-toggle-btn');
  if (chatToggle) chatToggle.addEventListener('click', toggleChatBox);

  const chatSendBtn = document.querySelector('#chat-box .send-chat-btn') || document.querySelector('.send-chat-btn');
  if (chatSendBtn) chatSendBtn.addEventListener('click', sendChat);

  // Also allow Enter key in input
  const chatInputEl = document.getElementById('chat-input');
  if (chatInputEl) {
    chatInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
  }
}

function toggleChatBox() {
  const box = document.getElementById("chat-box");
  if (!box) return;
  box.style.display = box.style.display === "none" || box.style.display === "" ? "flex" : "none";
}

// -------- CUSTOMER (store) side --------
let customerChatUnsub = null;

function startCustomerChat(userId) {
  // detach previous listener if any
  if (customerChatUnsub) {
    try { customerChatUnsub(); } catch (e) { /* ignore */ }
    customerChatUnsub = null;
  }

  listenToCustomerMessages(userId);
}
function sendChat() {
  const input = document.getElementById("chat-input");
  const message = input.value.trim();

  if (!message) {
    console.log("🚫 Empty message.");
    return;
  }

  const user = firebase.auth().currentUser; // <- FORCE AUTH REFERENCE

  if (!user) {
    alert("Please login to chat.");
    console.log("❌ No auth user found.");
    return;
  }

  console.log("✅ Auth user detected:", user.uid);

  const chatRef = firebase.firestore().collection("chats").doc(user.uid);

  // ✅ STEP A: Create / Update parent chat doc with userId
  chatRef
    .set(
      {
        userId: user.uid,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    .then(() => {
      console.log("✅ Successfully wrote chat doc:", user.uid);

      // ✅ STEP B: Now save the actual message
      return chatRef.collection("messages").add({
        sender: "customer",
        message: message,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      });
    })
    .then(() => {
      console.log("✅ Message saved successfully.");
      input.value = "";
    })
    .catch((error) => {
      console.error("❌ ERROR saving chat:", error);
    });
}




function listenToCustomerMessages(userId) {
  const box = document.getElementById("chat-messages");
  if (!box) return;

  // ensure UI cleared then listen
  box.innerHTML = `<div style="padding:12px;color:#ddd">Loading messages…</div>`;

  const colRef = db.collection('chats').doc(userId).collection('messages');
  const q = colRef.orderBy('timestamp', 'asc');

  customerChatUnsub = q.onSnapshot(snapshot => {
    // If no docs, show initial message
    if (snapshot.empty) {
      box.innerHTML = `<div style="padding:12px;color:#ddd">No messages yet. Say hi 👋</div>`;
      return;
    }

    // Render messages
    box.innerHTML = '';
    snapshot.forEach(doc => {
      const data = doc.data();
      const when = data.timestamp ? (data.timestamp.toDate().toLocaleTimeString()) : '';
      const wrapper = document.createElement('div');
      wrapper.style.marginBottom = '8px';
      wrapper.style.textAlign = (data.sender === 'customer') ? 'right' : 'left';

      const bubble = document.createElement('span');
      bubble.textContent = data.message;
      bubble.style.display = 'inline-block';
      bubble.style.padding = '8px 12px';
      bubble.style.borderRadius = '12px';
      bubble.style.maxWidth = '78%';
      bubble.style.wordBreak = 'break-word';
      bubble.style.background = (data.sender === 'customer') ? '#3498db' : '#444';
      bubble.style.color = '#fff';

      const timeEl = document.createElement('div');
      timeEl.textContent = when;
      timeEl.style.fontSize = '0.75rem';
      timeEl.style.opacity = '0.7';
      timeEl.style.marginTop = '4px';

      wrapper.appendChild(bubble);
      wrapper.appendChild(timeEl);
      box.appendChild(wrapper);
    });

    box.scrollTop = box.scrollHeight;
  }, err => {
    console.error('Customer chat listener error', err);
    box.innerHTML = `<div style="padding:12px;color:#f66">Failed to load messages.</div>`;
  });
}


// -------- ADMIN side --------
let adminUsersUnsub = null;
let adminMessagesUnsub = null;
let currentAdminChatUser = null;

function loadChatUsersRealtime() {
  const listEl = document.getElementById('chat-users');
  if (!listEl) return;

  // detach previous
  if (adminUsersUnsub) {
    try { adminUsersUnsub(); } catch(e) {}
    adminUsersUnsub = null;
  }

  // Listen to top-level 'chats' collection to show users who have docs
  adminUsersUnsub = db.collection('chats').onSnapshot(snapshot => {
    // Each doc ID is a userId that has a 'messages' subcollection (or had one)
    if (snapshot.empty) {
      listEl.innerHTML = '<div style="padding:8px;color:#ddd">No chat users yet.</div>';
      return;
    }

    // Build button list
    const html = [];
    snapshot.forEach(doc => {
      const uid = doc.id;
      html.push(`<button class="btn small" style="margin-bottom:6px;display:block;width:100%;text-align:left" onclick="openAdminChat('${uid}')">User: ${uid}</button>`);
    });
    listEl.innerHTML = html.join('');
  }, err => {
    console.error('Failed to load chat users', err);
    listEl.innerHTML = `<div style="padding:8px;color:#f66">Failed to load users.</div>`;
  });
}

function openAdminChat(userId) {
  currentAdminChatUser = userId;

  // show UI
  const boxWrap = document.getElementById('chat-admin-box');
  if (boxWrap) boxWrap.style.display = 'block';
  const withEl = document.getElementById('chat-with');
  if (withEl) withEl.textContent = `Chat with: ${userId}`;

  // attach the message listener
  listenAdminMessages(userId);

  // wire admin send button
  const sendBtn = document.querySelector('#chat-admin-box button') || document.querySelector('#chat-admin-box .btn');
  // we already have adminSendChat button in HTML (onclick)
}

function listenAdminMessages(userId) {
  // cleanup previous
  if (adminMessagesUnsub) {
    try { adminMessagesUnsub(); } catch(e){ }
    adminMessagesUnsub = null;
  }

  const messagesBox = document.getElementById('chat-admin-messages');
  if (!messagesBox) return;

  messagesBox.innerHTML = '<div style="padding:8px;color:#ddd">Loading messages…</div>';

  const colRef = db.collection('chats').doc(userId).collection('messages');
  const q = colRef.orderBy('timestamp', 'asc');

  adminMessagesUnsub = q.onSnapshot(snapshot => {
    messagesBox.innerHTML = '';
    if (snapshot.empty) {
      messagesBox.innerHTML = '<div style="padding:8px;color:#ddd">No messages yet.</div>';
      return;
    }

    snapshot.forEach(doc => {
      const data = doc.data();
      const isAdmin = data.sender === 'admin';
      const wrap = document.createElement('div');
      wrap.style.marginBottom = '8px';
      wrap.style.textAlign = isAdmin ? 'right' : 'left';

      const bubble = document.createElement('span');
      bubble.textContent = data.message;
      bubble.style.display = 'inline-block';
      bubble.style.padding = '8px 12px';
      bubble.style.borderRadius = '10px';
      bubble.style.background = isAdmin ? '#3498db' : '#444';
      bubble.style.color = '#fff';
      bubble.style.maxWidth = '78%';
      bubble.style.wordBreak = 'break-word';

      wrap.appendChild(bubble);

      const timeEl = document.createElement('div');
      timeEl.textContent = data.timestamp ? data.timestamp.toDate().toLocaleString() : '';
      timeEl.style.fontSize = '0.75rem';
      timeEl.style.opacity = '0.7';
      timeEl.style.marginTop = '4px';
      wrap.appendChild(timeEl);

      messagesBox.appendChild(wrap);
    });

    messagesBox.scrollTop = messagesBox.scrollHeight;
  }, err => {
    console.error('Admin messages listener error', err);
    messagesBox.innerHTML = '<div style="padding:8px;color:#f66">Failed to load messages.</div>';
  });
}

function adminSendChat() {
  const input = document.getElementById('admin-chat-input');
  if (!input) return alert('No message input');

  const msg = input.value.trim();
  if (!msg) return;

  const userId = currentAdminChatUser || (document.getElementById('chat-with')?.textContent || '').replace('Chat with: ','').trim();
  if (!userId) return alert('No user selected');

  db.collection('chats').doc(userId).collection('messages').add({
    sender: "admin",
    message: msg,
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  }).then(() => {
    input.value = '';
  }).catch(err => {
    console.error('Failed to send admin message', err);
    alert('Failed to send message. Check console.');
  });
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
function toggleChatBox() {
  const box = document.getElementById("chat-box");
  box.style.display = box.style.display === "none" ? "flex" : "none";
}

function listenChat() {
  const user = auth.currentUser;
  if (!user) return;

  db.collection("chats")
    .doc(user.uid)
    .collection("messages")
    .orderBy("timestamp", "asc")
    .onSnapshot(snapshot => {
      const box = document.getElementById("chat-messages");
      box.innerHTML = "";
      snapshot.forEach(doc => {
        const data = doc.data();
        box.innerHTML += `
          <div style="margin-bottom:8px;text-align:${data.sender === "customer" ? "right" : "left"}">
            <span style="background:${data.sender === "customer" ? "#3498db" : "#444"};padding:6px 12px;border-radius:6px;display:inline-block;">
              ${data.message}
            </span>
          </div>
        `;
      });
      box.scrollTop = box.scrollHeight;
    });
}

auth.onAuthStateChanged(user => {
  if (user) listenChat();
});
function initChat() {
  db.collection("chats").onSnapshot(snapshot => {
    let list = "";
    snapshot.forEach(doc => {
      list += `<button onclick="openAdminChat('${doc.id}')">${doc.id}</button><br>`;
    });
    document.getElementById("chat-users").innerHTML = list;
  });
}

function openAdminChat(userId) {
  document.getElementById("chat-admin-box").style.display = "block";
  document.getElementById("chat-with").textContent = "Chat with: " + userId;

  db.collection("chats")
    .doc(userId)
    .collection("messages")
    .orderBy("timestamp")
    .onSnapshot(snapshot => {
      const box = document.getElementById("chat-admin-messages");
      box.innerHTML = "";

      snapshot.forEach(doc => {
        const msg = doc.data();
        const isAdmin = msg.sender === "admin";

        box.innerHTML += `
          <div style="text-align:${isAdmin ? "right" : "left"};">
            <p style="background:${isAdmin ? "#3498db" : "#444"}; display:inline-block; padding:6px 12px; border-radius:10px;">
              ${msg.message}
            </p>
          </div>
        `;
      });

      box.scrollTop = box.scrollHeight;
    });
}

function adminSendChat() {
  const msg = document.getElementById("admin-chat-input").value;
  const userId = document.getElementById("chat-with").textContent.replace("Chat with: ", "");

  db.collection("chats")
    .doc(userId)
    .collection("messages")
    .add({
      sender: "admin",
      message: msg,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });

  document.getElementById("admin-chat-input").value = "";
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
