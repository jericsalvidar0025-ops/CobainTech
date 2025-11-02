/* script.js
   Firebase (compat) backed checkout + realtime order tracking
   Expects global variables from firebase-config.js:
     - auth  (firebase.auth())
     - db    (firebase.firestore())
     - storage (firebase.storage())
*/

/* --------- Utilities --------- */
function $(sel){ return document.querySelector(sel); }
function $all(sel){ return Array.from(document.querySelectorAll(sel)); }
function money(v){ 
  // digit-by-digit safe formatting
  const n = Number(v) || 0;
  return '₱' + n.toLocaleString('en-PH');
}
function nowISO(){ return new Date().toISOString(); }
function escapeHtml(s){ return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function placeholderDataURL(text){ const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='700'><rect fill='#0b0c0e' width='100%' height='100%'/><text x='50%' y='50%' font-size='48' font-family='Segoe UI, Roboto' fill='#fff' text-anchor='middle' alignment-baseline='middle'>${escapeHtml(text)}</text></svg>`; return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }
function debounce(fn, t=200){ let id; return (...a)=>{ clearTimeout(id); id=setTimeout(()=>fn(...a), t); }; }

/* --------- LocalStorage Cart --------- */
const CART_KEY = 'ct_cart_v2';
function getCart(){
  try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); }
  catch(e){ return []; }
}
function saveCart(arr){
  localStorage.setItem(CART_KEY, JSON.stringify(arr));
  renderCartCount();
}
function clearCart(){ saveCart([]); }

/* Cart helpers (id + qty) */
function addToCartById(id, qty=1){
  const cart = getCart();
  const ex = cart.find(i=>i.id === id);
  if (ex) ex.qty = Number(ex.qty || 0) + Number(qty);
  else cart.push({ id, qty: Number(qty) });
  saveCart(cart);
  toggleCart(true);
  renderCartUI();
}
function changeQty(id, delta){
  const cart = getCart();
  const it = cart.find(i=>i.id === id);
  if (!it) return;
  it.qty = Number(it.qty) + Number(delta);
  if (it.qty <= 0){
    // remove
    const idx = cart.findIndex(c=>c.id===id);
    if (idx !== -1) cart.splice(idx,1);
  }
  saveCart(cart);
  renderCartUI();
}
function removeFromCart(id){
  const cart = getCart().filter(i=>i.id !== id);
  saveCart(cart);
  renderCartUI();
}
function getCartCount(){
  return getCart().reduce((s,i)=>s + (Number(i.qty)||0), 0);
}
function renderCartCount(){
  const el = $('#cart-count');
  if (el) el.textContent = getCartCount();
}

/* --------- Cart UI (renders product details via Firestore) --------- */
async function renderCartUI(){
  const container = $('#cart-items');
  if (!container) return;
  const cart = getCart();
  if (!cart.length){
    container.innerHTML = `<div style="padding:18px;color:var(--muted)">Your cart is empty.</div>`;
    const totEl = $('#cart-total'); if (totEl) totEl.textContent = money(0);
    return;
  }

  // fetch product docs for items
  try {
    const docs = await Promise.all(cart.map(ci => db.collection('products').doc(ci.id).get()));
    const items = docs.map((d, idx) => {
      const data = d.exists ? d.data() : {};
      return {
        id: d.id,
        title: data.title || 'Unknown',
        price: Number(data.price || 0),
        img: data.imgUrl || data.img || placeholderDataURL(data.title || 'Product'),
        qty: Number(cart[idx].qty || 1)
      };
    });

    container.innerHTML = items.map(it => `
      <div class="cart-item" data-id="${it.id}">
        <img src="${it.img}" alt="${escapeHtml(it.title)}" />
        <div class="info">
          <div style="display:flex;justify-content:space-between">
            <div>${escapeHtml(it.title)}</div>
            <div class="muted">${money(it.price)}</div>
          </div>
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

    // compute total safely
    let total = 0;
    for (const it of items){
      // multiply digit by digit (JS safe enough when numbers small)
      total = total + (it.price * it.qty);
    }
    $('#cart-total').textContent = money(total);
  } catch (err) {
    console.error('Cart render error', err);
    container.innerHTML = `<div style="padding:18px;color:var(--muted)">Failed to load cart.</div>`;
  }
}

/* --------- Cart panel controls --------- */
function toggleCart(show){
  const panel = $('#cart-panel');
  if (!panel) return;
  panel.style.display = show ? 'flex' : 'none';
  if (show) renderCartUI();
}
function openCheckout(){ 
  const cart = getCart();
  if (!cart.length) return alert('Cart is empty');
  $('#checkout-modal').style.display = 'flex';
}
function closeCheckout(){ const m = $('#checkout-modal'); if (m) m.style.display = 'none'; }

/* --------- Checkout -> create order in Firestore --------- */
async function placeOrder(e){
  if (e && e.preventDefault) e.preventDefault();

  const user = auth.currentUser;
  if (!user) {
    alert('Please login before placing an order.');
    window.location.href = 'login.html';
    return false;
  }

  // collect checkout fields
  const name = ($('#chk-name') && $('#chk-name').value.trim()) || '';
  const address = ($('#chk-address') && $('#chk-address').value.trim()) || '';
  const phone = ($('#chk-phone') && $('#chk-phone').value.trim()) || '';
  const payment = ($('#chk-payment') && $('#chk-payment').value) || 'Cash on Delivery';

  if (!name || !address || !phone) {
    alert('Please complete shipping information.');
    return false;
  }

  const cart = getCart();
  if (!cart.length) return alert('Cart is empty.');

  try {
    // fetch product info for each cart item (to freeze price/title)
    const snaps = await Promise.all(cart.map(ci => db.collection('products').doc(ci.id).get()));
    const items = [];
    let total = 0;
    for (let i=0;i<snaps.length;i++){
      const doc = snaps[i];
      if (!doc.exists) continue;
      const data = doc.data();
      const qty = Number(cart[i].qty || 1);
      const price = Number(data.price || 0);
      items.push({
        productId: doc.id,
        title: data.title || 'Unknown',
        price,
        qty
      });
      total = total + (price * qty);
    }

    // create order object
    const orderObj = {
      userId: user.uid,
      userEmail: user.email || '',
      userName: name,
      phone,
      address,
      payment,
      items,
      total,
      status: 'Pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('orders').add(orderObj);

    // clear cart
    clearCart();
    renderCartUI();
    renderCartCount();
    closeCheckout();
    alert('Order placed! Order ID: ' + ref.id);

    // redirect to orders page which listens in realtime
    window.location.href = 'orders.html';
    return true;
  } catch (err) {
    console.error('placeOrder error', err);
    alert('Failed to place order: ' + (err.message || err));
    return false;
  }
}

/* --------- Orders: customer page realtime listener + render --------- */
function initCustomerOrdersListener(){
  // called on load if orders.html present
  if (!$('#orders-list')) return;
  auth.onAuthStateChanged(user => {
    if (!user){
      $('#orders-list').innerHTML = `<div style="padding:18px;color:var(--muted)">Please <a href="login.html">login</a> to view your orders.</div>`;
      return;
    }
    // listen to orders for this user
    db.collection('orders')
      .where('userId', '==', user.uid)
      .orderBy('createdAt', 'desc')
      .onSnapshot(snapshot => {
        const arr = [];
        snapshot.forEach(doc => arr.push({ id: doc.id, ...doc.data() }));
        renderCustomerOrders(arr);
      }, err => {
        console.error('customer orders listener error', err);
      });
  });
}

function renderCustomerOrders(list){
  const el = $('#orders-list');
  if (!el) return;
  if (!list || !list.length){
    el.innerHTML = `<div style="padding:18px;color:var(--muted)">No orders found.</div>`;
    return;
  }
  el.innerHTML = list.map(o => {
    const date = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toLocaleString() : (o.createdAt || '');
    return `
      <div class="order-card orders-list" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between">
          <div><strong>Order ${o.id}</strong><div class="muted small">${date}</div></div>
          <div class="order-status ${statusClassFor(o.status)}">${escapeHtml(o.status)}</div>
        </div>
        <div style="margin-top:8px" class="small muted">Items: ${o.items.length} • ${money(o.total)}</div>
        <div style="margin-top:8px">${o.items.map(it=>`<div style="display:flex;justify-content:space-between"><div>${escapeHtml(it.title)} x ${it.qty}</div><div>${money(it.price * it.qty)}</div></div>`).join('')}</div>
        <div style="margin-top:10px;display:flex;gap:8px">
          <button class="btn small" onclick="showOrderTrackingModal('${o.id}')">Track</button>
          <button class="btn small ghost" onclick="downloadOrder('${o.id}')">Receipt</button>
        </div>
      </div>
    `;
  }).join('');
}

/* --------- Admin: realtime orders listener + render --------- */
function initAdminOrdersListener(){
  if (!$('#admin-orders')) return;
  auth.onAuthStateChanged(async user => {
    if (!user) { window.location.href = 'login.html'; return; }

    // ensure user has admin privilege in users collection
    try {
      const udoc = await db.collection('users').doc(user.uid).get();
      if (!udoc.exists || udoc.data().role !== 'admin'){
        alert('Admin access required.');
        window.location.href = 'login.html';
        return;
      }
    } catch(err){
      console.error('admin check error', err);
      alert('Admin check failed.');
      return;
    }

    // listen to all orders
    db.collection('orders')
      .orderBy('createdAt', 'desc')
      .onSnapshot(snapshot => {
        const arr = [];
        snapshot.forEach(doc => arr.push({ id: doc.id, ...doc.data() }));
        renderAdminOrders(arr);
      }, err => console.error('admin orders listener error', err));
  });
}

function renderAdminOrders(list){
  const el = $('#admin-orders');
  if (!el) return;
  if (!list || !list.length){
    el.innerHTML = '<div class="muted">No orders yet.</div>';
    return;
  }
  el.innerHTML = list.map(o => {
    const date = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toLocaleString() : (o.createdAt || '');
    return `
      <div style="padding:8px;border-bottom:1px dashed rgba(255,255,255,0.03);margin-bottom:6px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><strong>${escapeHtml(o.userName || o.userEmail || 'Customer')}</strong> • ${date}</div>
          <div class="small muted">${escapeHtml(o.status)}</div>
        </div>
        <div style="margin-top:6px" class="small muted">Items: ${o.items.length} • ${money(o.total)}</div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button class="btn small" onclick="viewOrderAdmin('${o.id}')">View</button>
          <button class="btn small ghost" onclick="updateOrderStatus('${o.id}','Processing')">Processing</button>
          <button class="btn small ghost" onclick="updateOrderStatus('${o.id}','Shipped')">Shipped</button>
          <button class="btn small ghost" onclick="updateOrderStatus('${o.id}','Delivered')">Delivered</button>
        </div>
      </div>
    `;
  }).join('');
}

/* --------- Admin: view single order modal --------- */
async function viewOrderAdmin(id){
  try {
    const doc = await db.collection('orders').doc(id).get();
    if (!doc.exists) return alert('Order not found');
    const o = { id: doc.id, ...doc.data() };
    const date = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toLocaleString() : (o.createdAt || '');
    const html = `
      <h3>Order ${o.id}</h3>
      <div class="muted small">${date}</div>
      <div style="margin-top:8px">${o.items.map(it=>`<div>${escapeHtml(it.title)} x ${it.qty} — ${money(it.price * it.qty)}</div>`).join('')}</div>
      <div style="margin-top:12px"><strong>Total: ${money(o.total)}</strong></div>
      <div style="margin-top:10px"><strong>Customer:</strong> ${escapeHtml(o.userName || o.userEmail)} • ${escapeHtml(o.phone || '')}</div>
      <div style="margin-top:8px"><strong>Address:</strong> ${escapeHtml(o.address || '')}</div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn primary" onclick="updateOrderStatus('${o.id}','Processing')">Processing</button>
        <button class="btn" onclick="updateOrderStatus('${o.id}','Shipped')">Shipped</button>
        <button class="btn" onclick="updateOrderStatus('${o.id}','Delivered')">Delivered</button>
      </div>
    `;
    showModal(html);
  } catch (err) {
    console.error('viewOrderAdmin error', err);
    alert('Failed to load order');
  }
}

/* --------- Update order status (admin) --------- */
async function updateOrderStatus(id, status){
  try {
    await db.collection('orders').doc(id).update({ status });
    alert('Order ' + id + ' updated to ' + status);
  } catch (err) {
    console.error('updateOrderStatus error', err);
    alert('Failed to update order: ' + (err.message || err));
  }
}

/* --------- Customer track modal (reuse admin view but read-only) --------- */
async function showOrderTrackingModal(id){
  try {
    const doc = await db.collection('orders').doc(id).get();
    if (!doc.exists) return alert('Order not found');
    const o = { id: doc.id, ...doc.data() };
    const date = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toLocaleString() : (o.createdAt || '');
    const html = `
      <h3>Order ${o.id}</h3>
      <div class="muted small">${date}</div>
      <div style="margin-top:8px">${o.items.map(it=>`<div>${escapeHtml(it.title)} x ${it.qty} — ${money(it.price * it.qty)}</div>`).join('')}</div>
      <div style="margin-top:12px"><strong>Total: ${money(o.total)}</strong></div>
      <div style="margin-top:12px">Status: <span class="${statusClassFor(o.status)}">${escapeHtml(o.status)}</span></div>
      <div style="margin-top:12px"><button class="btn" onclick="closeModal()">Close</button></div>
    `;
    showModal(html);
  } catch (err) {
    console.error('showOrderTrackingModal error', err);
    alert('Failed to load order tracking');
  }
}

/* --------- Download receipt (text) --------- */
async function downloadOrder(id){
  try {
    const doc = await db.collection('orders').doc(id).get();
    if (!doc.exists) return alert('Order not found');
    const o = doc.data();
    const date = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toLocaleString() : (o.createdAt || '');
    const itemsText = (o.items || []).map(it => `${it.title} x${it.qty} — ${money(it.price * it.qty)}`).join('\n');
    const text = `CobainTech Receipt\nOrder: ${id}\nDate: ${date}\n\nItems:\n${itemsText}\n\nTotal: ${money(o.total)}\n\nShip to: ${o.userName || o.userEmail}, ${o.address || ''}, ${o.phone || ''}`;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${id}_receipt.txt`; a.click(); URL.revokeObjectURL(url);
  } catch (err) {
    console.error('downloadOrder error', err);
    alert('Failed to generate receipt');
  }
}

/* --------- small UI helpers --------- */
function statusClassFor(s){
  if (!s) return 'status-pending';
  if (s === 'Pending') return 'status-pending';
  if (s === 'Processing') return 'status-processing';
  if (s === 'Shipped') return 'status-shipped';
  if (s === 'Delivered') return 'status-delivered';
  return 'status-pending';
}
function showModal(html){
  const modal = document.createElement('div');
  modal.style.position='fixed'; modal.style.left=0; modal.style.top=0; modal.style.width='100%'; modal.style.height='100%';
  modal.style.background='rgba(0,0,0,0.6)'; modal.style.display='flex'; modal.style.alignItems='center'; modal.style.justifyContent='center'; modal.style.zIndex=9999;
  modal.innerHTML = `<div style="background:#0b0c0e;padding:18px;border-radius:12px;min-width:320px;max-width:760px;color:#fff">${html}</div>`;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}
function closeModal(){ document.querySelectorAll('body > div[style]').forEach(d=>d.remove()); }

/* --------- Bindings & initialization (on load) --------- */
window.addEventListener('load', () => {
  // footer years
  const y = $('#year'); if (y) y.textContent = new Date().getFullYear();
  const y2 = $('#year2'); if (y2) y2.textContent = new Date().getFullYear();

  // header user display
  auth.onAuthStateChanged(async user => {
    const welcome = $('#welcome-user-top');
    const loginLink = $('#login-link');
    const signupLink = $('#signup-link');
    const adminLink = $('#admin-link');

    if (user){
      // try to read username from users collection
      try {
        const doc = await db.collection('users').doc(user.uid).get();
        const username = (doc.exists && doc.data().username) ? doc.data().username : (user.email ? user.email.split('@')[0] : user.uid);
        if (welcome) welcome.textContent = `Hi, ${username}`;
        if (loginLink) loginLink.style.display = 'none';
        if (signupLink) signupLink.style.display = 'none';
        if (adminLink){
          if (doc.exists && doc.data().role === 'admin') adminLink.style.display = 'inline-block';
          else adminLink.style.display = 'none';
        }
      } catch (err) {
        console.error('Auth state user doc fetch error', err);
      }
    } else {
      if (welcome) welcome.textContent = '';
      if (loginLink) loginLink.style.display = 'inline-block';
      if (signupLink) signupLink.style.display = 'inline-block';
      if (adminLink) adminLink.style.display = 'none';
    }
  });

  // index page bindings
  if ($('#catalog')){
    renderCartCount();
    // cart button already present in HTML; ensure it toggles
    const cartBtn = $('#cart-btn'); if (cartBtn) cartBtn.addEventListener('click', ()=>toggleCart(true));
  }

  // orders page binds
  if ($('#orders-list')) initCustomerOrdersListener();

  // admin page binds
  if ($('#admin-orders')) initAdminOrdersListener();

  // checkout form binding (if present)
  const checkoutForm = $('#checkout-form');
  if (checkoutForm) checkoutForm.addEventListener('submit', placeOrder);

  // global functions exposed for HTML onclick handlers:
  window.addToCartById = addToCartById;
  window.toggleCart = toggleCart;
  window.openCheckout = openCheckout;
  window.closeCheckout = closeCheckout;
  window.placeOrder = placeOrder;
  window.showOrderTrackingModal = showOrderTrackingModal;
  window.downloadOrder = downloadOrder;
  window.updateOrderStatus = updateOrderStatus;
  window.renderCartUI = renderCartUI;
  window.changeQty = changeQty;
  window.removeFromCart = removeFromCart;
});

/* expose small helper to render cart count externally */
window.renderCartCount = renderCartCount;
