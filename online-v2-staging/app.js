'use strict';
/* 2K TAMBAYAN V2 CUSTOMER SITE — STAGING FRONTEND ONLY.
 * Existing isolated V2 online-order actions unchanged:
 * v2OnlineMenu, v2OnlineSubmit, v2OnlineStatus.
 * No access to V1, financial sync, Android Room or staff credentials.
 */
(() => {
  const $ = id => document.getElementById(id);
  const API_URL = String(window.V2_ORDER_API_URL || '').trim();
  const MAX_QTY_PER_ITEM = 30;
  const branch = $('branch');
  const cart = new Map();
  let products = [];
  let activeCategory = 'ALL';
  let currentBranch = 'CAM';
  let menuSeq = 0;
  let pendingRequestId = '';
  let acceptingOrders = false;
  let ownerBranchOpen = false;
  let statusKnown = false;
  let submitting = false;
  let orderTracking = null;
  let submissionUncertain = false;
  const isMobile = () => window.matchMedia('(max-width:760px)').matches;
  const price = n => '₱' + Number(n).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const safeStore = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} };
  const safeRead = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } };
  const el = (tag, cls, value) => { const n = document.createElement(tag); if (cls) n.className = cls; if (value != null) n.textContent = String(value); return n; };
  const cleanCategory = value => String(value || 'Others').trim().replace(/\s+/g, ' ');
  const keyCategory = value => cleanCategory(value).toLocaleUpperCase('en');
  const totalQty = () => [...cart.values()].reduce((sum, v) => sum + v.qty, 0);
  const totalPrice = () => [...cart.values()].reduce((sum, v) => sum + Number(v.product.sellingPrice) * v.qty, 0);
  const error = msg => { $('orderError').textContent = msg || ''; $('orderError').hidden = !msg; };
  const notice = (msg, isError = false) => {
    $('pageNotice').textContent = msg;
    $('pageNotice').classList.toggle('error', isError);
    $('pageNotice').hidden = !msg;
  };
  const validEndpoint = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/.test(API_URL);

  async function callV2(payload) {
    if (!validEndpoint) throw new Error('V2 API endpoint is not configured. Open config.js and paste your isolated V2 /exec URL.');
    let response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {'Content-Type': 'text/plain;charset=utf-8'},
        body: JSON.stringify(payload),
        redirect: 'follow'
      });
    } catch (_) {
      const e = new Error('Network connection failed. Check internet. If submitting, ask the cashier before retrying.');
      e.uncertain = true;
      throw e;
    }
    if (!response.ok) {
      const e = new Error('V2 server returned HTTP ' + response.status + '. Please try later.');
      e.uncertain = true;
      throw e;
    }
    let out;
    try { out = await response.json(); } catch (_) {
      const e = new Error('Unexpected V2 server response. Please contact the cashier before resubmitting.');
      e.uncertain = true;
      throw e;
    }
    if (!out || out.ok !== true) throw new Error(String(out?.error || 'Request was rejected by the V2 backend.'));
    return out;
  }

  function resolveCategories() {
    const map = new Map();
    products.forEach(p => {
      const raw = cleanCategory(p.category);
      const key = keyCategory(raw);
      // Present duplicate labels such as Coffee / COFFEE as one category in the UI.
      if (!map.has(key)) map.set(key, raw);
      else if (raw !== raw.toLocaleUpperCase('en')) map.set(key, raw);
    });
    return [...map.entries()].sort((a,b) => a[1].localeCompare(b[1], 'en'));
  }

  function refreshCategoryPicker() {
    const picker = $('category'); picker.replaceChildren();
    picker.add(new Option('All Categories', 'ALL'));
    for (const [key, display] of resolveCategories()) picker.add(new Option(display, key));
    if (![...picker.options].some(o => o.value === activeCategory)) activeCategory = 'ALL';
    picker.value = activeCategory;
  }

  function imageNode(product) {
    const fallback = el('div', 'product-image-fallback', '2K');
    fallback.setAttribute('aria-hidden', 'true');
    // CAB legacy Excel image URLs were observed to show unrelated product photos.
    // Suppress those URLs on the V2 staging site until verified by product key.
    if (currentBranch === 'CAB') return fallback;
    const imageUrl = String(product.imageUrl || '');
    if (!/^https:\/\//i.test(imageUrl)) return fallback;
    const img = el('img', 'product-image');
    img.src = imageUrl; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { img.replaceWith(fallback); };
    return img;
  }

  function renderMenu() {
    const list = $('products'); list.replaceChildren();
    const term = $('search').value.trim().toLocaleLowerCase('en');
    const visible = products.filter(p =>
      (activeCategory === 'ALL' || keyCategory(p.category) === activeCategory) &&
      (String(p.name).toLocaleLowerCase('en').includes(term) || String(p.category).toLocaleLowerCase('en').includes(term))
    );
    $('menuCount').textContent = String(visible.length);
    if (!visible.length) { list.append(el('div','page-notice','No products match this filter.')); return; }
    for (const p of visible) {
      const card = el('article', 'product-card');
      card.append(imageNode(p));
      const content = el('div', 'product-copy');
      content.append(el('h3', 'product-name', p.name), el('div', 'product-cat', p.category), el('div', 'product-price', price(p.sellingPrice)));
      card.append(content);
      const add = el('button', 'product-add', '+ ADD');
      add.type = 'button'; add.setAttribute('aria-label', 'Add ' + p.name + ' to your order');
      add.onclick = () => addItem(p);
      card.append(add); list.append(card);
    }
  }

  function addItem(product) {
    if (submitting || submissionUncertain) { error('Please resolve the pending checkout before changing the order.'); return; }
    const entry = cart.get(product.menuProductId) || {product,qty:0};
    if (entry.qty >= MAX_QTY_PER_ITEM) { error('Maximum ' + MAX_QTY_PER_ITEM + ' per item.'); return; }
    entry.qty += 1; cart.set(product.menuProductId, entry); error(''); renderCart();
  }

  function changeQty(id, change) {
    if (submitting || submissionUncertain) return;
    const entry = cart.get(id); if (!entry) return;
    const qty = entry.qty + change;
    if (qty < 1) cart.delete(id); else entry.qty = Math.min(MAX_QTY_PER_ITEM, qty);
    error(''); renderCart();
  }

  function renderCart() {
    const area = $('orderItems'); area.replaceChildren();
    if (!cart.size) {
      const empty = el('div', 'empty-cart'); empty.append(el('span','empty-icon','🛒'),el('div','','Your cart is empty.'),el('div','','Choose something delicious from the menu!')); area.append(empty);
      $('checkoutPanel').hidden = true;
    }
    for (const [id, entry] of cart) {
      const row = el('div','cart-line');
      const top = el('div','cart-top'); top.append(el('div','cart-name',entry.product.name),el('div','cart-lineprice',price(entry.product.sellingPrice * entry.qty))); row.append(top);
      const sub = el('div','cart-subline'); sub.append(el('span','cart-unit',price(entry.product.sellingPrice)+' each'));
      const qtyControls=el('div','qty-controls');
      const minus=el('button','qty-btn','−'); minus.type='button'; minus.setAttribute('aria-label','Remove one '+entry.product.name); minus.onclick=()=>changeQty(id,-1);
      const plus=el('button','qty-btn','+'); plus.type='button'; plus.setAttribute('aria-label','Add one '+entry.product.name); plus.onclick=()=>changeQty(id,1);
      qtyControls.append(minus,el('span','qty-num',entry.qty),plus); sub.append(qtyControls); row.append(sub); area.append(row);
    }
    const qty = totalQty(), amount = price(totalPrice());
    $('sidebarQty').textContent = String(qty); $('itemQty').textContent = String(qty);
    $('mobileQty').textContent = qty + (qty === 1 ? ' item' : ' items'); $('mobileTotal').textContent = amount;
    $('total').textContent=amount; $('checkoutTotal').textContent=amount;
    $('checkoutBranch').textContent=currentBranch;
    $('checkoutButton').disabled=qty===0 || submitting || submissionUncertain || !acceptingOrders || !statusKnown;
  }

  function openCart() {
    if (!isMobile()) { $('orderPane').scrollIntoView({behavior:'smooth',block:'nearest'}); return; }
    $('cartBackdrop').hidden=false; $('orderPane').classList.add('mobile-open');
    $('orderPane').setAttribute('aria-modal','true'); $('mobileCartButton').setAttribute('aria-expanded','true');
    document.body.style.overflow='hidden'; $('closeCart').focus();
  }
  function closeCart() {
    $('cartBackdrop').hidden=true; $('orderPane').classList.remove('mobile-open');
    $('orderPane').setAttribute('aria-modal','false'); $('mobileCartButton').setAttribute('aria-expanded','false');
    document.body.style.overflow='';
  }

  function updateOrderStatusBanner() {
    const n=$('onlineStatusBanner'); if(!n)return;
    n.textContent= !statusKnown ? 'Checking online ordering availability…' :
      acceptingOrders ? 'ONLINE ORDERING OPEN — Accepting orders' :
      ownerBranchOpen ? 'STAGING — Owner has opened this branch, but live submissions are still disabled.' :
      'ONLINE ORDERING TEMPORARILY CLOSED — You may browse the menu.';
    n.setAttribute('data-open',acceptingOrders?'true':'false');
  }
  async function loadMenu() {
    const seq=++menuSeq;
    products=[]; cart.clear(); pendingRequestId=''; submissionUncertain=false;
    activeCategory='ALL'; $('search').value=''; $('checkoutPanel').hidden=true; $('category').value='ALL';
    $('branchTag').textContent=currentBranch; $('checkoutBranch').textContent=currentBranch;
    acceptingOrders=false; ownerBranchOpen=false; statusKnown=false; updateOrderStatusBanner();
    renderCart(); renderMenu(); refreshCategoryPicker();
    notice('Loading ' + currentBranch + ' menu…'); error('');
    const requestBranch=currentBranch;
    try {
      const data=await callV2({action:'v2OnlineMenu',branchCode:requestBranch});
      if (seq!==menuSeq || currentBranch!==requestBranch) return;
      if (data.branchCode && data.branchCode!==requestBranch) throw new Error('Branch mismatch — wrong menu response.');
      if (!Array.isArray(data.products)) throw new Error('V2 server sent an invalid menu.');
      const ids=new Set();
      products = data.products.filter(p => {
        if (!p || typeof p.menuProductId!=='string' || !p.menuProductId || typeof p.name!=='string' || !p.name.trim() ||
            !Number.isFinite(Number(p.sellingPrice)) || Number(p.sellingPrice)<0 || ids.has(p.menuProductId)) return false;
        ids.add(p.menuProductId); return true;
      });
      const status=await callV2({action:'v2OnlineBranchStatus',branchCode:requestBranch});
      if(seq!==menuSeq || currentBranch!==requestBranch)return;
      ownerBranchOpen=status.acceptingOrders===true;
      acceptingOrders=ownerBranchOpen && status.onlineOrderWritesEnabled===true;
      statusKnown=true;updateOrderStatusBanner();
      refreshCategoryPicker(); renderMenu(); renderCart(); notice('');
    } catch (e) {
      if(seq!==menuSeq) return;
      products=[]; refreshCategoryPicker(); renderMenu();
      notice(e.message || 'Could not load the menu.',true);
    }
  }

  function newRequestId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g,'');
    const bytes = new Uint8Array(16);
    if (!globalThis.crypto?.getRandomValues) throw new Error('A secure browser is required to submit orders.');
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
  }

  function checkout() {
    if (!cart.size || submissionUncertain) return;
    $('checkoutPanel').hidden=false; error('');
    if (isMobile()) openCart();
    $('checkoutPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
  }

  async function submitOrder(event) {
    event.preventDefault(); if (submitting || submissionUncertain || cart.size===0) return;
    if(!acceptingOrders || !statusKnown)return error('Online ordering is currently closed for this branch.');
    const name=$('customerName').value.trim();
    if (!name) { error('Please enter your customer name.'); $('customerName').focus(); return; }
    if (name.length>90) { error('Customer name is too long.'); return; }
    if (!validEndpoint) { error('V2 API endpoint is not configured in config.js.'); return; }
    if (!pendingRequestId) { try { pendingRequestId=newRequestId(); } catch(e){ error(e.message);return; } }
    const data={action:'v2OnlineSubmit',branchCode:currentBranch,requestId:pendingRequestId,
      customerName:name,tableNo:$('tableNo').value.trim(),contactNumber:$('contact').value.trim(),
      orderNotes:$('orderNotes').value.trim(),paymentMethod:$('payment').value,
      items:[...cart.values()].map(x=>({menuProductId:x.product.menuProductId,quantity:x.qty}))};
    try { const latest=await callV2({action:'v2OnlineBranchStatus',branchCode:currentBranch});
      if(!latest.acceptingOrders || !latest.onlineOrderWritesEnabled)throw Error('Online ordering is currently closed.');
    }catch(e){error(e.message);return;}
    submitting=true; $('submitOrder').disabled=true; $('submitOrder').textContent='SENDING ORDER…';
    error(''); renderCart();
    try {
      const res=await callV2(data);
      if (!res.orderToken || !res.orderNo) {
        submissionUncertain=true;
        throw new Error('An order may already exist, but tracking cannot be confirmed. Ask the cashier before retrying.');
      }
      orderTracking={orderNo:res.orderNo,orderToken:res.orderToken,branchCode:currentBranch};
      safeStore('2k_v2_customer_last_order',orderTracking);
      cart.clear(); pendingRequestId=''; submissionUncertain=false;
      $('checkoutPanel').hidden=true;
      $('trackingPanel').hidden=false;
      $('trackingMessage').textContent='Order: '+res.orderNo+'\nBranch: '+currentBranch+'\nStatus: PENDING / UNPAID\nTotal: '+price(res.totalAmount);
      renderCart(); $('trackingPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
    } catch(e) {
      // A definite backend rejection (including disabled writes) never confirms an order.
      // An ambiguous network/server response needs staff verification before a new request.
      if(e.uncertain) submissionUncertain=true;
      error(e.message || 'Order could not be submitted.');
      if(submissionUncertain) error((e.message || 'Order status unknown.')+' Please ask the cashier before trying a different order.');
    } finally {
      submitting=false; $('submitOrder').disabled=submissionUncertain;
      $('submitOrder').textContent='SUBMIT ORDER'; renderCart();
    }
  }

  async function refreshStatus() {
    if (!orderTracking) return;
    $('refreshStatus').disabled=true; error('');
    try {
      const res=await callV2({action:'v2OnlineStatus',orderNo:orderTracking.orderNo,orderToken:orderTracking.orderToken});
      $('trackingMessage').textContent='Order: '+res.orderNo+'\nBranch: '+orderTracking.branchCode+'\nPayment: '+res.paymentStatus+'\nOrder: '+res.orderStatus+'\nTotal: '+price(res.totalAmount);
    } catch(e) { error(e.message || 'Unable to refresh order status.'); }
    finally { $('refreshStatus').disabled=false; }
  }

  branch.onchange=()=>{
    const chosen=branch.value;
    if(cart.size && !window.confirm('Changing branches will clear your current cart. Continue?')) {branch.value=currentBranch;return;}
    currentBranch=chosen; closeCart();
    const trackingOnThisBranch=orderTracking?.branchCode===currentBranch;
    $('trackingPanel').hidden=!trackingOnThisBranch;
    if(trackingOnThisBranch) $('trackingMessage').textContent='Last order: '+orderTracking.orderNo+'\nTap REFRESH ORDER STATUS.';
    safeStore('2k_v2_selected_branch',currentBranch); loadMenu();
  };
  $('search').oninput=renderMenu;
  $('category').onchange=()=>{activeCategory=$('category').value;renderMenu();};
  $('mobileCartButton').onclick=openCart; $('closeCart').onclick=closeCart; $('cartBackdrop').onclick=closeCart;
  document.addEventListener('keydown',e=>{if(e.key==='Escape' && $('orderPane').classList.contains('mobile-open'))closeCart();});
  window.addEventListener('resize',()=>{if(!isMobile())closeCart();});
  $('checkoutButton').onclick=checkout;
  $('backToCart').onclick=()=>{ $('checkoutPanel').hidden=true; error(''); };
  $('checkoutForm').onsubmit=submitOrder;
  $('refreshStatus').onclick=refreshStatus;
  const lastBranch=safeRead('2k_v2_selected_branch');
  if(lastBranch==='CAB' || lastBranch==='CAM') currentBranch=lastBranch;
  branch.value=currentBranch;
  const lastOrder=safeRead('2k_v2_customer_last_order');
  if(lastOrder?.orderNo?.startsWith('V2ONL-') && lastOrder?.orderToken && ['CAM','CAB'].includes(lastOrder.branchCode)) {
    orderTracking=lastOrder;
    if (lastOrder.branchCode===currentBranch) {
      $('trackingPanel').hidden=false;
      $('trackingMessage').textContent='Last order: '+lastOrder.orderNo+'\nTap REFRESH ORDER STATUS.';
    }
  }
  renderCart(); loadMenu();
})();
