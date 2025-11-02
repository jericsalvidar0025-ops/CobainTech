// ---------- Firebase Setup ----------
const app = firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
const storage = firebase.storage();

// ---------- Utilities ----------
function $(sel){ return document.querySelector(sel); }
function $all(sel){ return Array.from(document.querySelectorAll(sel)); }
function money(v){ return '₱' + (Number(v)||0).toLocaleString('en-PH'); }
function escapeHtml(s){ return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function placeholderDataURL(text){ 
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='700'><rect fill='#0b0c0e' width='100%' height='100%'/><text x='50%' y='50%' font-size='48' font-family='Segoe UI, Roboto' fill='#fff' text-anchor='middle' alignment-baseline='middle'>${escapeHtml(text)}</text></svg>`; 
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); 
}

// ---------- Cart ----------
const CART_KEY = 'ct_cart_v2';
function getCart(){ try { return JSON.parse(localStorage.getItem(CART_KEY)||'[]'); } catch(e){ return []; } }
function saveCart(arr){ localStorage.setItem(CART_KEY, JSON.stringify(arr)); renderCartCount(); }
function clearCart(){ saveCart([]); }
function addToCartById(id, qty=1){ 
    const cart=getCart(); 
    const ex=cart.find(i=>i.id===id); 
    if(ex) ex.qty+=Number(qty); 
    else cart.push({id,qty:Number(qty)}); 
    saveCart(cart); 
    toggleCart(true); 
    renderCartUI(); 
}
function changeQty(id, delta){ 
    const cart=getCart(); 
    const it=cart.find(i=>i.id===id); 
    if(!it)return; 
    it.qty+=Number(delta); 
    if(it.qty<=0){ 
        const idx=cart.findIndex(c=>c.id===id); 
        if(idx!==-1) cart.splice(idx,1); 
    } 
    saveCart(cart); 
    renderCartUI(); 
}
function removeFromCart(id){ 
    const cart=getCart().filter(i=>i.id!==id); 
    saveCart(cart); 
    renderCartUI(); 
}
function getCartCount(){ return getCart().reduce((s,i)=>s+(Number(i.qty)||0),0); }
function renderCartCount(){ const el=$('#cart-count'); if(el) el.textContent=getCartCount(); }

// ---------- Cart UI ----------
async function renderCartUI(){
    const container=$('#cart-items'); if(!container) return;
    const cart=getCart();
    if(!cart.length){ 
        container.innerHTML=`<div style="padding:18px;color:var(--muted)">Your cart is empty.</div>`; 
        $('#cart-total').textContent=money(0); 
        return; 
    }
    try{
        const docs=await Promise.all(cart.map(ci=>db.collection('products').doc(ci.id).get()));
        const items=docs.map((d,idx)=>{ 
            const data=d.exists?d.data():{}; 
            return {id:d.id,title:data.title||'Unknown',price:Number(data.price||0),img:data.imgUrl||data.img||placeholderDataURL(data.title||'Product'),qty:Number(cart[idx].qty||1)}; 
        });
        container.innerHTML=items.map(it=>`
            <div class="cart-item" data-id="${it.id}">
                <img src="${it.img}" alt="${escapeHtml(it.title)}"/>
                <div class="info">
                    <div style="display:flex;justify-content:space-between">
                        <div>${escapeHtml(it.title)}</div>
                        <div class="muted">${money(it.price)}</div>
                    </div>
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
        let total=0; 
        for(const it of items) total+=it.price*it.qty; 
        $('#cart-total').textContent=money(total);
    }catch(err){ 
        console.error(err); 
        container.innerHTML=`<div style="padding:18px;color:var(--muted)">Failed to load cart.</div>`; 
    }
}

// ---------- Cart Panel ----------
function toggleCart(show){ const panel=$('#cart-panel'); if(!panel) return; panel.style.display=show?'flex':'none'; if(show) renderCartUI(); }

// ---------- Checkout ----------
function openCheckout(){
    const cart=getCart();
    if(!cart.length) return alert('Cart is empty');
    auth.onAuthStateChanged(user=>{
        if(!user){ alert('Please login before placing an order.'); window.location.href='login.html'; return; }
        // autofill user info if exists
        db.collection('users').doc(user.uid).get().then(doc=>{
            if(doc.exists){
                $('#chk-name').value = doc.data().username || '';
                $('#chk-address').value = doc.data().address || '';
                $('#chk-phone').value = doc.data().phone || '';
            }
        }).catch(()=>{});
        $('#checkout-modal').style.display='flex';
    });
}
function closeCheckout(){ const m=$('#checkout-modal'); if(m) m.style.display='none'; }

async function placeOrder(e){
    if(e && e.preventDefault) e.preventDefault();
    const btn=$('#checkout-btn'); if(btn) btn.disabled=true;

    const user=auth.currentUser;
    if(!user){ alert('Please login.'); window.location.href='login.html'; return false; }

    const name=($('#chk-name')?.value||'').trim();
    const address=($('#chk-address')?.value||'').trim();
    const phone=($('#chk-phone')?.value||'').trim();
    const payment=($('#chk-payment')?.value||'Cash on Delivery');
    if(!name||!address||!phone) { alert('Please complete shipping info.'); btn.disabled=false; return false; }
    if(!/^\d{10,11}$/.test(phone)){ alert('Enter valid phone number.'); btn.disabled=false; return false; }

    const cart=getCart(); if(!cart.length){ alert('Cart empty'); btn.disabled=false; return false; }
    try{
        const snaps=await Promise.all(cart.map(ci=>db.collection('products').doc(ci.id).get()));
        const items=[]; let total=0;
        for(let i=0;i<snaps.length;i++){ 
            const doc=snaps[i]; if(!doc.exists) continue; 
            const data=doc.data(); 
            const qty=Number(cart[i].qty||1); 
            const price=Number(data.price||0); 
            items.push({productId:doc.id,title:data.title||'Unknown',price,qty}); 
            total+=price*qty; 
        }
        const orderObj={userId:user.uid,userEmail:user.email||'',userName:name,phone,address,payment,items,total,status:'Pending',createdAt:firebase.firestore.FieldValue.serverTimestamp()};
        const ref=await db.collection('orders').add(orderObj);
        clearCart(); renderCartUI(); renderCartCount(); closeCheckout();
        alert('Order placed! ID: '+ref.id);
        window.location.href='orders.html';
    }catch(err){ console.error(err); alert('Failed to place order: '+(err.message||err)); }
    if(btn) btn.disabled=false;
}

// ---------- Product Catalog ----------
async function loadProducts(){
    const catalog=$('#catalog'); if(!catalog) return;
    try{
        const snapshot = await db.collection('products').get();
        const products = snapshot.docs.map(doc=>({id:doc.id, ...doc.data()}));
        renderProducts(products);
    }catch(err){ console.error(err); catalog.innerHTML='<p>Failed to load products.</p>'; }
}
function renderProducts(products){
    const catalog=$('#catalog'); if(!catalog) return;
    catalog.innerHTML = products.map(p=>`
        <div class="product-card">
            <img src="${p.imgUrl||placeholderDataURL(p.title||'Product')}" alt="${escapeHtml(p.title)}">
            <div class="product-info">
                <h4>${escapeHtml(p.title)}</h4>
                <p class="price">${money(p.price)}</p>
                <button class="btn primary" onclick="addToCartById('${p.id}')">Add to cart</button>
            </div>
        </div>
    `).join('');
}

// ---------- Auth / Admin UI ----------
auth.onAuthStateChanged(user=>{
    const login=$('#login-link'), signup=$('#signup-link'), welcome=$('#welcome-user-top'), admin=$('#admin-link');
    if(user){
        if(login) login.style.display='none';
        if(signup) signup.style.display='none';
        if(welcome) welcome.textContent = `Welcome, ${user.displayName||user.email}`;
        if(admin) {
            db.collection('admins').doc(user.uid).get().then(doc=>{ if(doc.exists) admin.style.display='inline-block'; });
        }
    } else {
        if(login) login.style.display='inline-block';
        if(signup) signup.style.display='inline-block';
        if(welcome) welcome.textContent='';
        if(admin) admin.style.display='none';
    }
});

// ---------- Footer year ----------
window.addEventListener('load',()=>{
    const y=$('#year'); if(y) y.textContent=new Date().getFullYear();
    renderCartCount();

    // cart toggle
    const cartBtn=$('#cart-btn'); if(cartBtn) cartBtn.addEventListener('click',()=>toggleCart(true));

    // expose globally
    window.addToCartById=addToCartById;
    window.toggleCart=toggleCart;
    window.openCheckout=openCheckout;
    window.closeCheckout=closeCheckout;
    window.placeOrder=placeOrder;
    window.renderCartUI=renderCartUI;
    window.changeQty=changeQty;
    window.removeFromCart=removeFromCart;

    loadProducts();
});
