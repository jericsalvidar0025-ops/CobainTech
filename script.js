/* script.js — CobainTech Firebase edition (merged & fixed) */

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

/* ---------- INDEX PAGE: products listing (realtime) ---------- */
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

  if(!name || !address || !phone){
    alert('Complete all fields');
    return false;
  }

  const cart = getCart();
  if(!cart.length){ alert('Cart is empty'); return false; }

  try {
    // Fetch latest product info
    const snaps = await Promise.all(cart.map(ci=>productsRef().doc(ci.id).get()));
    const invalid = snaps.filter(s=>!s.exists);
    if(invalid.length){
      alert('Some items are no longer available. Refresh cart.');
      return false;
    }

    const items = snaps.map((doc, idx)=>({
      productId: doc.id,
      title: doc.data().title,
      price: doc.data().price,
      qty: cart[idx].qty
    }));

    const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);

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

    await ordersRef().add(orderObj);

    // Clear cart
    saveCart([]);
    renderCartCount();
    toggleCart(false);
    closeCheckout();

    // Redirect to My Orders page
    alert('Order placed successfully! You will be redirected to My Orders.');
    window.location.href = 'orders.html';

  } catch(err){
    console.error(err);
    alert('Checkout failed: ' + (err.message || err));
  }

  return false;
}


function openCheckout(){ const modal = q('#checkout-modal'); if(modal) modal.style.display='flex'; modal.setAttribute('aria-hidden','false'); }
function closeCheckout(){ const modal = q('#checkout-modal'); if(modal) modal.style.display='none'; modal.setAttribute('aria-hidden','true'); }

/* ---------- Orders page ---------- */
function initOrdersPage(){
  const table = q('#orders-table'); if(!table) return;
  const user = auth.currentUser;
  if(!user) return;
  ordersRef().where('userId','==',user.uid).orderBy('createdAt','desc').onSnapshot(snap=>{
    const arr=[]; snap.forEach(d=>arr.push({id:d.id,...d.data()}));
    table.innerHTML = arr.map(o=>`
      <tr>
        <td>${o.id}</td>
        <td>${escapeHtml(o.userName)}</td>
        <td>${o.items.map(i=>escapeHtml(i.title)+' ×'+i.qty).join('<br/>')}</td>
        <td>${money(o.total)}</td>
        <td>${escapeHtml(o.status)}</td>
      </tr>
    `).join('');
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

/* ---------- Admin helpers (add/edit/delete products & manage orders) ---------- */
let adminProducts=[];
function initAdmin(){
  if(!q('#admin-product-list')) return;

  productsRef().orderBy('createdAt','desc').onSnapshot(snap=>{
    const arr=[]; snap.forEach(d=>arr.push({id:d.id,...d.data()})); adminProducts=arr;
    renderAdminProducts();
  });

  renderAdminProducts();
  initAdminOrders(); // load orders table
}

function renderAdminProducts(){
  const container = q('#admin-product-list'); if(!container) return;
  const search = (q('#admin-search')||{}).value?.trim().toLowerCase();
  let list = adminProducts;
  if(search) list = list.filter(p=>p.title.toLowerCase().includes(search)||p.category.toLowerCase().includes(search));
  container.innerHTML = list.map(p=>`
    <div class="admin-item">
      <div>${escapeHtml(p.title)}</div>
      <div>${money(p.price)}</div>
      <div>${escapeHtml(p.category)}</div>
      <div>
        <button class="btn small" onclick="editProduct('${p.id}')">Edit</button>
        <button class="btn ghost small" onclick="deleteProduct('${p.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function showAddProduct(){ q('#product-form-area').style.display='block'; q('#product-form-title').textContent='Add Product'; q('#product-form').reset(); q('#p-id').value=''; }
function hideProductForm(){ q('#product-form-area').style.display='none'; }

/* ---------- Admin: Add/Edit Products ---------- */
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

