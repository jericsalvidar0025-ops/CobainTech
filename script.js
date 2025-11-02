/* script.js — CobainTech Firebase edition
   Requires: firebase (compat), firebase-config.js (which initializes auth, db, storage)
   Features:
   - Signup/Login (creates users/{uid} doc)
   - Products: realtime list (products collection)
   - Admin: add/edit/delete products (upload images to Storage)
   - Cart: stored in localStorage, checkout creates orders in Firestore
   - Orders: customers view their orders; admin manages orders
*/

/* ---------- helpers ---------- */
function q(sel){ return document.querySelector(sel); }
function qAll(sel){ return document.querySelectorAll(sel); }
function money(v){ return `₱${Number(v).toLocaleString()}`; }
function escapeHtml(s){ return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function debounce(fn,d=200){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),d); }; }
function placeholderDataURL(text){ const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='700'><rect fill='#0b0c0e' width='100%' height='100%'/><text x='50%' y='50%' font-size='48' font-family='Segoe UI, Roboto' fill='#fff' text-anchor='middle' alignment-baseline='middle'>${escapeHtml(text)}</text></svg>`; return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }

/* ---------- Firestore refs (compat style) ---------- */
const productsRef = () => db.collection('products');
const ordersRef = () => db.collection('orders');
const usersRef = () => db.collection('users');

/* ---------- On load ---------- */
window.addEventListener('load', () => {
  setFooterYear();
  bindAuthState();
  initIndex();
  initAdmin();
  initOrdersPage();
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
    // create user profile doc
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
  try {
    await auth.signInWithEmailAndPassword(email, password);
    // onAuthStateChanged handler will redirect if admin
  } catch (err) { console.error(err); alert(err.message || 'Login failed'); }
  return false;
}

function logoutUser(){
  auth.signOut();
  // UI updates handled in listener
}

/* ---------- auth state & UI ---------- */
function bindAuthState(){
  auth.onAuthStateChanged(async user => {
    const welcome = q('#welcome-user-top');
    const loginLink = q('#login-link');
    const signupLink = q('#signup-link');
    const adminLink = q('#admin-link');
    if (user) {
      // fetch users/{uid}
      try {
        const doc = await usersRef().doc(user.uid).get();
        const username = doc.exists ? (doc.data().username || user.email.split('@')[0]) : user.email.split('@')[0];
        if (welcome) welcome.textContent = `Hi, ${username}`;
        if (loginLink) loginLink.style.display = 'none';
        if (signupLink) signupLink.style.display = 'none';
        // show admin link if role === admin
        if (doc.exists && doc.data().role === 'admin') {
          if (adminLink) adminLink.style.display = 'inline-block';
          // if currently on login page, redirect to admin
          if (location.pathname.endsWith('login.html')) window.location.href = 'admin.html';
        }
      } catch (err) {
        console.error('Failed to read user doc', err);
      }
    } else {
      if (welcome) welcome.textContent = '';
      if (loginLink) loginLink.style.display = 'inline-block';
      if (signupLink) signupLink.style.display = 'inline-block';
      if (adminLink) adminLink.style.display = 'none';
    }
  });
}

/* ---------- INDEX PAGE: products listing (realtime) ---------- */
let lastProducts = [];
function initIndex(){
  if (!q('#catalog')) return;
  // realtime listener for products
  productsRef().orderBy('createdAt','desc').onSnapshot(snapshot => {
    const arr = [];
    snapshot.forEach(doc => arr.push({ id: doc.id, ...doc.data() }));
    lastProducts = arr;
    renderProducts(arr);
    populateFilters(arr);
  }, err => {
    console.error('products listener error', err);
  });

  // search bindings
  const search = q('#search-input'); if (search) search.addEventListener('input', debounce(()=>applyFilters(),150));
  const cat = q('#category-filter'); if (cat) cat.addEventListener('change', applyFilters);
  const sort = q('#sort-select'); if (sort) sort.addEventListener('change', applyFilters);

  // cart button
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
  if (sort === 'price-asc') list.sort((a,b)=>a.price-b.price);
  if (sort === 'price-desc') list.sort((a,b)=>b.price-a.price);
  if (sort === 'newest') list.sort((a,b)=>b.createdAt?.seconds - a.createdAt?.seconds);
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

/* product modal */
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
function closeProductModal(){ const m = q('#product-modal'); if (m){ m.style.display = 'none'; m.setAttribute('aria-hidden','true'); } }

/* ---------- Cart (localStorage client-side) ---------- */
function getCart(){ try { return JSON.parse(localStorage.getItem('ct_cart')||'[]'); } catch(e){ return []; } }
function saveCart(c){ localStorage.setItem('ct_cart', JSON.stringify(c)); renderCartCount(); }
function renderCartCount(){ const el = q('#cart-count'); if (!el) return; const c = getCart().reduce((s,i)=>s + (i.qty||1),0); el.textContent = c; }
function addToCartById(id, qty=1){ const cart = getCart(); const ex = cart.find(i=>i.id===id); if (ex) ex.qty += qty; else cart.push({ id, qty }); saveCart(cart); toggleCart(true); renderCartUI(); }
function renderCartUI(){
  const container = q('#cart-items'); if(!container) return;
  const cart = getCart();
  if (cart.length === 0) { container.innerHTML = `<div style="padding:18px;color:var(--muted)">Your cart is empty.</div>`; q('#cart-total') && (q('#cart-total').textContent = money(0)); return; }
  Promise.all(cart.map(ci => productsRef().doc(ci.id).get())).then(docs => {
    const items = docs.map((doc, idx) => ({ id: doc.id, ...(doc.data()||{}), qty: cart[idx].qty }));
    container.innerHTML = items.map(it => `
      <div class="cart-item" data-id="${it.id}">
        <img src="${it.imgUrl || it.img || placeholderDataURL(it.title)}" alt="${escapeHtml(it.title)}" />
        <div class="info">
          <div style="display:flex;justify-content:space-between"><div>${escapeHtml(it.title)}</div><div class="muted">${money(it.price)}</div></div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
            <div style="display:flex;align-items:center;gap:8px">
              <button class="btn small" onclick="changeQty('${it.id}', -1)">−</button>
              <div style="padding:6px 10px;border-radius:6px;background:#111;color:#fff">${it.qty}</div>
              <button class="btn small" onclick="changeQty('${it.id}', 1)">+</button>
            </div>
            <button class="btn ghost" onclick="removeFromCart('${it.id}')">Remove</button>
          </div>
        </div>
      </div>
    `).join('');
    const total = items.reduce((s,i)=>s + i.price * i.qty, 0);
    q('#cart-total').textContent = money(total);
  }).catch(err => { console.error(err); container.innerHTML = `<div style="padding:18px;color:var(--muted)">Failed to load cart</div>`; });
}
function changeQty(id, delta){ const cart = getCart(); const it = cart.find(i=>i.id===id); if(!it) return; it.qty += delta; if (it.qty <= 0){ if (!confirm('Remove item?')) { it.qty = 1; } else { const idx = cart.findIndex(i=>i.id===id); if (idx>=0) cart.splice(idx,1); } } saveCart(cart); renderCartUI(); }
function removeFromCart(id){ let cart = getCart(); cart = cart.filter(i=>i.id!==id); saveCart(cart); renderCartUI(); }
function toggleCart(show){ const panel = q('#cart-panel'); if (!panel) return; panel.style.display = show ? 'flex' : 'none'; if (show) renderCartUI(); }

/* ---------- Checkout -> create order (Firestore) ---------- */
async function placeOrder(e){
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) { alert('Please login before placing order'); window.location.href = 'login.html'; return false; }
  const name = (q('#chk-name')||{}).value?.trim();
  const address = (q('#chk-address')||{}).value?.trim();
  const phone = (q('#chk-phone')||{}).value?.trim();
  const payment = (q('#chk-payment')||{}).value || 'COD';
  if (!name || !address || !phone) { alert('Complete shipping details'); return false; }
  const cart = getCart();
  if (cart.length === 0) return alert('Cart empty');
  try {
    const snaps = await Promise.all(cart.map(ci => productsRef().doc(ci.id).get()));
    const items = snaps.map((doc, idx) => ({ productId: doc.id, title: doc.data().title, price: doc.data().price, qty: cart[idx].qty }));
    const total = items.reduce((s,i)=>s + i.price * i.qty, 0);
    const doc = {
      userId: user.uid,
      userName: name,
      phone, address, payment,
      items, total,
      status: 'Pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    const odoc = await ordersRef().add(doc);
    saveCart([]); renderCartCount(); closeCheckout(); toggleCart(false);
    alert('Order placed! ID: ' + odoc.id);
    window.location.href = 'orders.html';
  } catch (err) { console.error(err); alert('Place order failed: ' + (err.message||err)); }
  return false;
}

/* ---------- Orders page (customer) ---------- */
function initOrdersPage(){
  if (!q('#orders-list')) return;
  auth.onAuthStateChanged(user => {
    if (!user) { q('#orders-list').innerHTML = `<div style="padding:18px;color:var(--muted)">Please <a href="login.html">login</a> to view orders.</div>`; return; }
    ordersRef().where('userId','==',user.uid).orderBy('createdAt','desc').onSnapshot(snap => {
      const arr = []; snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
      renderCustomerOrders(arr);
    });
  });
}
function renderCustomerOrders(list){
  const el = q('#orders-list'); if(!el) return;
  if (!list || list.length === 0) { el.innerHTML = `<div style="padding:18px;color:var(--muted)">No orders found.</div>`; return; }
  el.innerHTML = list.map(o => `
    <div class="order-card orders-list" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between">
        <div><strong>Order ${o.id}</strong><div class="muted small">${new Date(o.createdAt?.toDate?.() || o.createdAt).toLocaleString()}</div></div>
        <div class="order-status ${statusClassFor(o.status)}">${o.status}</div>
      </div>
      <div style="margin-top:8px" class="small muted">Items: ${o.items.length} • ${money(o.total)}</div>
      <div style="margin-top:8px">${o.items.map(it=>`<div style="display:flex;justify-content:space-between"><div>${escapeHtml(it.title)} x ${it.qty}</div><div>${money(it.price*it.qty)}</div></div>`).join('')}</div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn small" onclick="showOrderTrackingModal('${o.id}')">Track</button>
        <button class="btn small ghost" onclick="downloadOrder('${o.id}')">Receipt</button>
      </div>
    </div>
  `).join('');
}

/* ---------- Admin page (products & orders realtime) ---------- */
function initAdmin(){
  if (!q('#admin-product-list')) return;
  auth.onAuthStateChanged(async user => {
    if (!user) { window.location.href = 'login.html'; return; }
    const doc = await usersRef().doc(user.uid).get();
    if (!doc.exists || doc.data().role !== 'admin') { alert('Admin required'); window.location.href = 'login.html'; return; }
    productsRef().orderBy('createdAt','desc').onSnapshot(snap => {
      const arr = []; snap.forEach(d => arr.push({ id: d.id, ...d.data() })); renderAdminProducts(arr);
    });
    ordersRef().orderBy('createdAt','desc').onSnapshot(snap => {
      const arr = []; snap.forEach(d => arr.push({ id: d.id, ...d.data() })); renderAdminOrders(arr);
    });
  });
}

function renderAdminProducts(list){
  const el = q('#admin-product-list'); if(!el) return;
  el.innerHTML = (list || []).map(p => `
    <div class="admin-row">
      <div style="display:flex;align-items:center;gap:8px">
        <img src="${p.imgUrl || p.img || placeholderDataURL(p.title)}" style="width:48px;height:48px;object-fit:cover;border-radius:8px" />
        <div>
          <div style="font-weight:600">${escapeHtml(p.title)}</div>
          <div class="small muted">${escapeHtml(p.category)} • ${money(p.price)}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn small" onclick="editProduct('${p.id}')">Edit</button>
        <button class="btn small ghost" onclick="deleteProduct('${p.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

/* add/edit/delete products (image upload to Storage) */
function showAddProduct(){ if (!q('#product-form-area')) return; q('#product-form-area').style.display='block'; q('#product-form-title').textContent='Add Product'; q('#product-form').reset(); q('#p-id').value=''; q('#p-img-preview').innerHTML=''; }
function hideProductForm(){ if (q('#product-form-area')) q('#product-form-area').style.display='none'; }

function previewProductImage(evt){
  const file = evt.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e){ q('#p-img-preview').innerHTML = `<img src="${e.target.result}" />`; q('#p-image').dataset.base64 = e.target.result; };
  reader.readAsDataURL(file);
}

async function saveProduct(e){
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return alert('Login as admin to save products');
  const userDoc = await usersRef().doc(user.uid).get();
  if (!userDoc.exists || userDoc.data().role !== 'admin') return alert('Admin required');
  try {
    const id = (q('#p-id')||{}).value || undefined;
    const title = (q('#p-title')||{}).value?.trim();
    const price = parseFloat((q('#p-price')||{}).value) || 0;
    const stock = parseInt((q('#p-stock')||{}).value) || 0;
    const category = (q('#p-category')||{}).value?.trim() || 'General';
    const desc = (q('#p-desc')||{}).value?.trim() || '';
    const fileInput = q('#p-image');

    let imgUrl = null;
    if (fileInput && fileInput.files && fileInput.files[0]) {
      const file = fileInput.files[0];
      const ref = storage.ref().child(`product_images/${Date.now()}_${file.name}`);
      const snap = await ref.put(file);
      imgUrl = await snap.ref.getDownloadURL();
    } else if (fileInput && fileInput.dataset && fileInput.dataset.base64) {
      imgUrl = fileInput.dataset.base64;
    } else {
      imgUrl = placeholderDataURL(title);
    }

    const obj = {
      title, price, stock, category, desc, imgUrl,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    if (!id) await productsRef().add(obj);
    else await productsRef().doc(id).set(obj, { merge: true });

    hideProductForm(); alert('Product saved.');
  } catch (err) { console.error(err); alert('Save product failed: ' + (err.message||err)); }
}

async function editProduct(id){
  const doc = await productsRef().doc(id).get();
  if (!doc.exists) return alert('Not found');
  const p = doc.data();
  q('#product-form-area').style.display='block';
  q('#product-form-title').textContent='Edit Product';
  q('#p-id').value = id;
  q('#p-title').value = p.title || '';
  q('#p-price').value = p.price || 0;
  q('#p-stock').value = p.stock || 0;
  q('#p-category').value = p.category || '';
  q('#p-desc').value = p.desc || '';
  q('#p-img-preview').innerHTML = `<img src="${p.imgUrl || p.img || placeholderDataURL(p.title)}" />`;
  if (q('#p-image')) q('#p-image').dataset.base64 = p.imgUrl || p.img || '';
}

async function deleteProduct(id){
  if (!confirm('Delete product?')) return;
  await productsRef().doc(id).delete();
  alert('Deleted');
}

/* Admin orders */
function renderAdminOrders(list){
  const el = q('#admin-orders'); if(!el) return;
  el.innerHTML = (list || []).map(o => `
    <div style="padding:8px;border-bottom:1px dashed rgba(255,255,255,0.03);margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><strong>${escapeHtml(o.userName || o.name)}</strong> • ${new Date(o.createdAt?.toDate?.() || o.createdAt).toLocaleString()}</div>
        <div class="small muted">${o.status}</div>
      </div>
      <div style="margin-top:6px" class="small muted">Items: ${o.items.length} • ${money(o.total)}</div>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="btn small" onclick="viewOrderAdmin('${o.id}')">View</button>
        <button class="btn small ghost" onclick="updateOrderStatus('${o.id}','Processing')">Processing</button>
        <button class="btn small ghost" onclick="updateOrderStatus('${o.id}','Shipped')">Shipped</button>
        <button class="btn small ghost" onclick="updateOrderStatus('${o.id}','Delivered')">Delivered</button>
      </div>
    </div>
  `).join('');
}

function viewOrderAdmin(id){
  ordersRef().doc(id).get().then(doc => {
    if (!doc.exists) return alert('Not found');
    const o = { id: doc.id, ...doc.data() };
    const html = `
      <h3>Order ${o.id}</h3>
      <div class="muted small">${new Date(o.createdAt?.toDate?.() || o.createdAt).toLocaleString()}</div>
      <div style="margin-top:8px">${o.items.map(it=>`<div>${escapeHtml(it.title)} x ${it.qty} — ${money(it.price*it.qty)}</div>`).join('')}</div>
      <div style="margin-top:12px"><strong>Total: ${money(o.total)}</strong></div>
      <div style="margin-top:10px"><strong>Customer:</strong> ${escapeHtml(o.userName || o.name)} • ${escapeHtml(o.phone)}</div>
      <div style="margin-top:8px"><strong>Address:</strong> ${escapeHtml(o.address)}</div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn primary" onclick="updateOrderStatus('${o.id}','Processing')">Processing</button>
        <button class="btn" onclick="updateOrderStatus('${o.id}','Shipped')">Shipped</button>
        <button class="btn" onclick="updateOrderStatus('${o.id}','Delivered')">Delivered</button>
      </div>
    `;
    showModal(html);
  });
}

async function updateOrderStatus(id, status){
  await ordersRef().doc(id).update({ status });
  alert('Order updated to ' + status);
}

/* ---------- small utilities ---------- */
function showModal(html){
  const modal = document.createElement('div'); modal.style.position='fixed'; modal.style.left=0; modal.style.top=0; modal.style.width='100%'; modal.style.height='100%'; modal.style.background='rgba(0,0,0,0.6)'; modal.style.display='flex'; modal.style.alignItems='center'; modal.style.justifyContent='center'; modal.style.zIndex=9999;
  modal.innerHTML = `<div style="background:#0b0c0e;padding:18px;border-radius:12px;min-width:320px;max-width:760px;color:#fff">${html}</div>`;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}
function closeModal(){ document.querySelectorAll('body > div[style]').forEach(d=>d.remove()); }
function statusClassFor(s){ if (s==='Pending') return 'status-pending'; if (s==='Processing') return 'status-processing'; if (s==='Shipped') return 'status-shipped'; if (s==='Delivered') return 'status-delivered'; return 'status-pending'; }
function setFooterYear(){ const y = q('#year'); if (y) y.textContent = new Date().getFullYear(); const y2 = q('#year2'); if (y2) y2.textContent = new Date().getFullYear(); }

/* ---------- admin/customer helpers ---------- */
function showOrderTrackingModal(id){
  ordersRef().doc(id).get().then(doc => {
    if (!doc.exists) return alert('Order not found');
    const o = { id: doc.id, ...doc.data() };
    showModal(`<h3>Order ${o.id}</h3><div class="muted small">${new Date(o.createdAt?.toDate?.() || o.createdAt).toLocaleString()}</div><div style="margin-top:10px">${o.items.map(it=>`<div>${escapeHtml(it.title)} x ${it.qty} — ${money(it.price*it.qty)}</div>`).join('')}</div><div style="margin-top:12px"><strong>Total: ${money(o.total)}</strong></div><div style="margin-top:12px">Status: <span class="${statusClassFor(o.status)}">${o.status}</span></div><div style="margin-top:12px"><button class="btn" onclick="closeModal()">Close</button></div>`);
  });
}

async function downloadOrder(id){
  const doc = await ordersRef().doc(id).get();
  if (!doc.exists) return alert('Order not found');
  const o = doc.data();
  const text = `CobainTech Receipt\nOrder: ${id}\nDate: ${new Date(o.createdAt?.toDate?.() || o.createdAt).toLocaleString()}\n\nItems:\n` + (o.items||[]).map(it=>`${it.title} x${it.qty} — ${money(it.price*it.qty)}`).join('\n') + `\n\nTotal: ${money(o.total)}\n\nShip to: ${o.userName || o.name}, ${o.address}, ${o.phone}`;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${id}_receipt.txt`; a.click(); URL.revokeObjectURL(url);
}

/* ---------- simple init: cart UI + filters ---------- */
(function smallInit(){
  if (q('#catalog')) {
    renderCartCount();
    // initial empty cart UI
    if (q('#cart-items')) q('#cart-items').innerHTML = `<div style="padding:18px;color:var(--muted)">Cart is empty.</div>`;
  }
  // admin search binding
  if (q('#admin-search')) q('#admin-search').addEventListener('input', debounce(()=>{ /* snapshot updates handle filtering automatically */ },200));
})();
