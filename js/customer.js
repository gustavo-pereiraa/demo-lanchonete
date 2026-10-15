// ------------------------------------------------------------------
// Cardápio do cliente: categorias, carrinho e finalização do pedido.
// Preço, taxa de entrega e total são SEMPRE recalculados no servidor;
// os valores daqui servem apenas para o cliente acompanhar o pedido.
// ------------------------------------------------------------------
const state = { products: [], categories: [], cart: [], config: { delivery_fee: 0 }, feeKnown: false, store: { is_open: true } };
const MAX_QTY = 99; // mesmo limite validado no servidor

const money = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
const desktopQuery = window.matchMedia('(min-width: 1024px)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Escapa texto antes de inserir no HTML — protege contra injeção de script
// via nome/descrição de produto ou observação digitada pelo próprio cliente.
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

function toast(text, kind = '') {
  const el = $('#toast');
  el.classList.remove('show', 'is-error', 'is-success');
  void el.offsetWidth; // reinicia a animação em toasts consecutivos
  el.innerHTML = (kind === 'success' ? icon('check') : kind === 'error' ? icon('alert') : '') + `<span>${esc(text)}</span>`;
  if (kind) el.classList.add(`is-${kind}`);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

// Ordem oficial do cardápio informada pela proprietária
const MENU_ORDER = {
  'Lanche': ['X-Burguer', 'X-Burguer Egg', 'X-Salada Simples', 'X-Egg', 'X-Salada Especial', 'X-Bacon', 'X-Bacon Egg', 'X-Calabresa', 'X-Tudo', 'X-Esquina', 'X-Power', 'X-Frango', 'X-Frango Burguer', 'X-Americano', 'Hot Dog Simples', 'Hot Dog Especial', 'Super Hot Goes', 'Piscina de Cheddar Burger Bacon'],
  'Pastel': ['Pastel de Carne', 'Pastel de Carne com Ovo', 'Pastel de Carne com Mussarela', 'Pastel de Queijo', 'Pastel Três Queijos', 'Pastel de Queijo com Tomate', 'Pastel de Queijo com Milho', 'Pastel de Pizza', 'Pastel de Calabresa com Mussarela', 'Pastel de Calabresa', 'Pastel de Frango', 'Pastel de Frango com Mussarela', 'Pastel de Frango com Catupiry', 'Pastel de Frango com Cheddar', 'Pastel de Strogonoff de Carne', 'Pastel de Strogonoff de Frango', 'Pastel Brócolis Especial', 'Pastel Goes', 'Pastel Doce de Creme de Avelã', 'Pastel Doce de Leite Ninho'],
  'Batata Recheada': ['Batata Recheada Strogonoff de Carne', 'Batata Recheada Strogonoff de Frango', 'Batata Recheada Brócolis, Mussarela e Bacon', 'Batata Recheada Bolonhesa', 'Batata Recheada Pizza', 'Batata Recheada Mussarela, Bacon e Milho', 'Batata Recheada Frango com Catupiry', 'Batata Recheada Frango com Cheddar'],
};
function sortForMenu(list, catName) {
  const order = MENU_ORDER[catName] || [];
  const pos = (p) => (order.indexOf(p.name) < 0 ? 999 : order.indexOf(p.name));
  return list.slice().sort((a, b) => pos(a) - pos(b));
}

const productById = (id) => state.products.find((p) => p.id === id);
const cartQty = (id) => state.cart.find((i) => i.id === id)?.quantity || 0;
const cartCount = () => state.cart.reduce((a, i) => a + i.quantity, 0);
const cartSubtotal = () => state.cart.reduce((s, i) => s + (productById(i.id)?.price || 0) * i.quantity, 0);
const unavailableInCart = () => state.cart.filter((i) => isUnavailable(productById(i.id)));
// Loja fechada: o cardápio continua visível, mas não dá para adicionar nem enviar.
// O servidor recusa o pedido de qualquer forma; aqui é só para o cliente entender.
const storeOpen = () => state.store?.is_open !== false;

// ------------------------------------------------------------------
// Carregamento do cardápio
// ------------------------------------------------------------------
async function fetchJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function renderMenuSkeleton() {
  $('#categoryTabs').innerHTML = '';
  $('#productGrid').innerHTML = `<div class="menu-skeleton" aria-hidden="true"><div class="skeleton skeleton--title"></div><div class="product-grid">${'<div class="skeleton"></div>'.repeat(6)}</div></div><span class="sr-only">Carregando cardápio…</span>`;
}

function renderMenuError() {
  $('#productGrid').setAttribute('aria-busy', 'false');
  $('#productGrid').innerHTML = `<div class="menu-error" role="alert">${icon('wifi-off')}<strong>Não foi possível carregar o cardápio</strong><p>Verifique sua conexão com a internet e tente novamente.</p><button class="btn btn--primary" type="button" id="retryMenu">${icon('refresh')}Tentar novamente</button></div>`;
  $('#retryMenu').onclick = init;
}

async function init() {
  renderMenuSkeleton();
  try {
    const [products, categories] = await Promise.all([fetchJSON('/api/products'), fetchJSON('/api/categories')]);
    state.products = products;
    state.categories = categories;
  } catch (err) {
    renderMenuError();
    return;
  }
  try {
    state.config = await fetchJSON('/api/config');
    state.feeKnown = true;
    if (state.config.store) state.store = state.config.store;
  } catch (err) {
    state.config = { delivery_fee: 0 };
    state.feeKnown = false; // o servidor aplica a taxa correta de qualquer forma
  }
  renderStoreBanner();
  renderMenu();
  renderCart();
  updateFeeLabel();
}

// ------------------------------------------------------------------
// Loja aberta/fechada
// ------------------------------------------------------------------
function renderStoreBanner() {
  const s = state.store || {};
  const closed = s.is_open === false;
  $('#storeClosed').hidden = !closed;
  document.body.classList.toggle('store-is-closed', closed);
  if (!closed) return;
  $('#storeClosedText').textContent = s.next_open_label
    ? `Abrimos ${s.next_open_label}. Você pode ver o cardápio, mas os pedidos pelo site estão pausados.`
    : 'Você pode ver o cardápio, mas os pedidos pelo site estão pausados.';
  $('#storeClosedMsg').textContent = s.message || '';
  $('#storeClosedMsg').hidden = !s.message;
}

function applyStore(store) {
  if (!store) return;
  const changed = store.is_open !== state.store?.is_open || store.message !== state.store?.message || store.next_open_label !== state.store?.next_open_label;
  state.store = store;
  if (!changed) return;
  renderStoreBanner();
  syncProductControls(true);
  renderCart();
  $('#submitOrder').disabled = !storeOpen();
  if (storeOpen() && $('#checkoutModal').classList.contains('open')) hideCheckoutError();
}

// Confere de tempos em tempos se a loja abriu/fechou (só com a aba visível)
async function refreshStore() {
  if (document.hidden) return;
  try {
    const [cfg, products] = await Promise.all([fetchJSON('/api/config'), fetchJSON('/api/products')]);
    applyStore(cfg.store);
    applyProducts(products);
  } catch (err) {
    // sem conexão: mantém o último estado conhecido; o servidor decide no envio
  }
}
setInterval(refreshStore, 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshStore();
});

// Categorias que têm ao menos um produto ativo, na ordem do servidor
function visibleCategories() {
  return state.categories
    .map((c) => ({ ...c, products: sortForMenu(state.products.filter((p) => p.category_id === c.id), c.name) }))
    .filter((c) => c.products.length);
}

function productCard(p) {
  const qty = cartQty(p.id);
  const img = p.image_url ? `<img class="product-card__img" src="${esc(p.image_url)}" alt="" loading="lazy" decoding="async" width="88" height="88">` : '';
  return `<article class="product-card${qty ? ' in-cart' : ''}${isUnavailable(p) ? ' is-sold-out' : ''}" data-product="${p.id}" aria-labelledby="p-${p.id}-name">
    ${img}
    <div class="product-card__body">
      <h3 class="product-card__name" id="p-${p.id}-name">${esc(p.name)}</h3>
      <span class="sold-badge" id="p-${p.id}-so"${isUnavailable(p) ? '' : ' hidden'}>Esgotado hoje</span>
      ${p.description ? `<p class="product-card__desc">${esc(p.description)}</p>` : ''}
      <div class="product-card__foot">
        <span class="price">${money(p.price)}</span>
        <div class="product-card__ctrl" data-ctrl="${p.id}">${productControl(p, qty)}</div>
      </div>
    </div>
  </article>`;
}

// Produto esgotado hoje (ou que saiu do cardápio depois que entrou no carrinho)
const isUnavailable = (p) => !!(p && (p.sold_out || p.unavailable));

// Motivo pelo qual um produto não pode ser adicionado agora ('' = pode)
function blockReason(p) {
  if (isUnavailable(p)) return 'sold_out';
  return storeOpen() ? '' : 'closed';
}

function productControl(p, qty) {
  const blocked = blockReason(p);
  const why = blocked === 'sold_out' ? ` aria-describedby="p-${p.id}-so"` : blocked ? ' aria-describedby="storeClosed"' : '';
  if (!qty) {
    return `<button class="add-btn" type="button" data-add="${p.id}" aria-label="Adicionar ${esc(p.name)} ao pedido"${blocked ? ` disabled${why}` : ''}>${icon('plus', 'icon icon--sm')}Adicionar</button>`;
  }
  return `<div class="stepper" role="group" aria-label="Quantidade de ${esc(p.name)}">
    <button class="stepper__btn" type="button" data-qty-minus="${p.id}" aria-label="${qty === 1 ? 'Remover' : 'Diminuir'} ${esc(p.name)}">${icon(qty === 1 ? 'trash' : 'minus', 'icon icon--sm')}</button>
    <span class="stepper__value">${qty}</span>
    <button class="stepper__btn" type="button" data-qty-plus="${p.id}" aria-label="Adicionar mais um ${esc(p.name)}"${blocked ? ` disabled${why}` : ''}>${icon('plus', 'icon icon--sm')}</button>
  </div>`;
}

function renderMenu() {
  const cats = visibleCategories();
  const grid = $('#productGrid');
  grid.setAttribute('aria-busy', 'false');
  if (!cats.length) {
    $('#categoryNav').hidden = true;
    grid.innerHTML = `<div class="empty-state">${icon('bag')}<strong>Cardápio indisponível no momento</strong><span>Nenhum produto está disponível agora. Tente novamente mais tarde.</span></div>`;
    return;
  }
  $('#categoryNav').hidden = false;
  $('#categoryTabs').innerHTML = cats
    .map((c, i) => `<a class="chip${i === 0 ? ' active' : ''}" href="#cat-${c.id}" data-cat="${c.id}"${i === 0 ? ' aria-current="true"' : ''}>${esc(c.name)}</a>`)
    .join('');

  grid.innerHTML = cats
    .map((c) => {
      let body;
      if (c.name === 'Pastel') {
        // Pastéis doces ficam separados visualmente no fim da categoria
        const sweet = c.products.filter((p) => p.name.startsWith('Pastel Doce'));
        const savory = c.products.filter((p) => !p.name.startsWith('Pastel Doce'));
        body = `<div class="product-grid">${savory.map(productCard).join('')}</div>` +
          (sweet.length ? `<div class="menu-subhead"><h3>Pastéis doces</h3><p>Para fechar com chave de ouro</p></div><div class="product-grid">${sweet.map(productCard).join('')}</div>` : '');
      } else {
        body = `<div class="product-grid">${c.products.map(productCard).join('')}</div>`;
      }
      const n = c.products.length;
      return `<section class="menu-category" id="cat-${c.id}" aria-labelledby="cat-${c.id}-title">
        <header class="menu-category__head"><h2 id="cat-${c.id}-title">${esc(c.name)}</h2><span>${n} ${n === 1 ? 'opção' : 'opções'}</span></header>
        ${body}
      </section>`;
    })
    .join('');
  setupScrollSpy();
}

// ------------------------------------------------------------------
// Navegação por categorias: rola até a seção e acompanha a rolagem
// ------------------------------------------------------------------
let spyObserver = null;
let spyPausedUntil = 0;

function setActiveTab(catId, scrollTab = true) {
  const tabs = $('#categoryTabs');
  $$('.chip', tabs).forEach((t) => {
    const on = t.dataset.cat === String(catId);
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'true');
    else t.removeAttribute('aria-current');
    if (on && scrollTab) tabs.scrollTo({ left: t.offsetLeft - 16, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  });
}

function setupScrollSpy() {
  if (spyObserver) spyObserver.disconnect();
  if (!('IntersectionObserver' in window)) return;
  spyObserver = new IntersectionObserver(
    (entries) => {
      if (Date.now() < spyPausedUntil) return;
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActiveTab(visible[0].target.id.replace('cat-', ''));
    },
    { rootMargin: `-${130 + demoBarHeight()}px 0px -55% 0px` }
  );
  $$('.menu-category').forEach((s) => spyObserver.observe(s));
}

$('#categoryTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-cat]');
  if (!tab) return;
  e.preventDefault();
  const section = document.getElementById(`cat-${tab.dataset.cat}`);
  if (!section) return;
  spyPausedUntil = Date.now() + 700;
  setActiveTab(tab.dataset.cat);
  section.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
});

// Altura da faixa "Versão de demonstração" (medida pelo js/demo-bar.js)
function demoBarHeight() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--demo-bar-h')) || 0;
}

// Sombra sutil na barra de categorias quando ela "gruda" no topo
const navSentinel = document.createElement('div');
$('#categoryNav').before(navSentinel);
if ('IntersectionObserver' in window) {
  new IntersectionObserver(([e]) => $('#categoryNav').classList.toggle('is-stuck', !e.isIntersecting), {
    rootMargin: `-${61 + demoBarHeight()}px 0px 0px 0px`,
  }).observe(navSentinel);
}

// Imagens de produto quebradas são simplesmente removidas do card
$('#productGrid').addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') e.target.remove();
}, true);

// ------------------------------------------------------------------
// Carrinho
// ------------------------------------------------------------------
function add(id) {
  const p = productById(id);
  if (!p || blockReason(p)) return;
  const item = state.cart.find((x) => x.id === id);
  if (item) {
    if (item.quantity >= MAX_QTY) return toast(`Máximo de ${MAX_QTY} unidades por item.`, 'error');
    item.quantity++;
  } else {
    state.cart.push({ id, quantity: 1, notes: '' });
  }
  renderCart();
  toast(`${p.name} adicionado`, 'success');
  const bar = $('#cartBar');
  bar.classList.remove('bump');
  void bar.offsetWidth;
  bar.classList.add('bump');
}

function changeQty(id, d) {
  const item = state.cart.find((x) => x.id === id);
  if (!item) return;
  if (d > 0 && blockReason(productById(id))) return;
  if (d > 0 && item.quantity >= MAX_QTY) return toast(`Máximo de ${MAX_QTY} unidades por item.`, 'error');
  item.quantity += d;
  if (item.quantity <= 0) removeItem(id);
  else renderCart();
}

function removeItem(id) {
  state.cart = state.cart.filter((x) => x.id !== id);
  renderCart();
}

function setNotes(idx, value) {
  if (state.cart[idx]) state.cart[idx].notes = value;
}

// Atualiza os controles (Adicionar / − n +) dos cards sem redesenhar o
// cardápio inteiro, preservando o foco do teclado no card em uso.
// force = redesenha mesmo sem mudar a quantidade (ex.: a loja fechou).
function syncProductControls(force = false) {
  const active = document.activeElement;
  const activeCtrl = active?.closest?.('[data-ctrl]');
  const focusId = activeCtrl ? activeCtrl.dataset.ctrl : null;
  const focusKind = active?.hasAttribute?.('data-qty-minus') ? 'minus' : 'plus';

  $$('[data-ctrl]').forEach((ctrl) => {
    const id = +ctrl.dataset.ctrl;
    const qty = cartQty(id);
    const shown = ctrl.querySelector('.stepper__value');
    if (!force && (shown ? +shown.textContent : 0) === qty) return;
    const p = productById(id);
    ctrl.innerHTML = productControl(p, qty);
    const card = ctrl.closest('.product-card');
    card?.classList.toggle('in-cart', qty > 0);
    card?.classList.toggle('is-sold-out', isUnavailable(p));
    const badge = document.getElementById(`p-${id}-so`);
    if (badge) badge.hidden = !isUnavailable(p);
  });

  if (focusId) {
    const ctrl = document.querySelector(`[data-ctrl="${focusId}"]`);
    const target = ctrl?.querySelector(focusKind === 'minus' ? '[data-qty-minus]' : '[data-qty-plus]') || ctrl?.querySelector('button');
    if (target && document.activeElement !== target) target.focus();
  }
}

function renderCart() {
  const count = cartCount();
  const total = cartSubtotal();
  const el = $('#cartItems');

  el.innerHTML =
    state.cart
      .map((i, idx) => {
        const p = productById(i.id);
        if (!p) return '';
        const gone = isUnavailable(p);
        return `<li class="cart-item${gone ? ' is-unavailable' : ''}">
          <div class="cart-item__top">
            <div class="cart-item__info"><strong>${esc(p.name)}</strong><small>${money(p.price)} cada</small></div>
            <strong class="cart-item__sub">${money(p.price * i.quantity)}</strong>
          </div>
          ${gone ? `<p class="cart-item__warn">${icon('alert', 'icon icon--sm')}<span>${p.unavailable === 'inactive' ? 'Saiu do cardápio' : 'Esgotou hoje'} — remova este item para enviar o pedido.</span></p>` : ''}
          <div class="cart-item__actions">
            <div class="stepper" role="group" aria-label="Quantidade de ${esc(p.name)}">
              <button class="stepper__btn" type="button" data-qty-minus="${i.id}" aria-label="Diminuir ${esc(p.name)}">${icon('minus', 'icon icon--sm')}</button>
              <span class="stepper__value">${i.quantity}</span>
              <button class="stepper__btn" type="button" data-qty-plus="${i.id}" aria-label="Aumentar ${esc(p.name)}"${blockReason(p) ? ' disabled' : ''}>${icon('plus', 'icon icon--sm')}</button>
            </div>
            <button class="link-btn" type="button" data-remove="${i.id}">Remover</button>
          </div>
          <label class="sr-only" for="note-${idx}">Observação para ${esc(p.name)}</label>
          <input class="notes-input" id="note-${idx}" maxlength="255" placeholder="Observação (ex.: sem cebola)" value="${esc(i.notes)}" data-notes-idx="${idx}">
        </li>`;
      })
      .join('') ||
    `<li class="cart-empty">${icon('bag')}<strong>Seu pedido está vazio</strong><span>Toque em “Adicionar” em um item do cardápio para começar.</span></li>`;

  $('#cartTotal').textContent = money(total);
  const goneCount = unavailableInCart().length;
  $('#checkoutBtn').disabled = !state.cart.length || !storeOpen() || goneCount > 0;
  $('#cartClosedNote').hidden = storeOpen() || !state.cart.length;
  $('#cartGoneNote').hidden = !goneCount;

  const badge = $('#cartCount');
  badge.textContent = count;
  badge.classList.toggle('is-empty', !count);
  $('#openCart').setAttribute('aria-label', `Abrir meu pedido, ${count} ${count === 1 ? 'item' : 'itens'}`);

  $('#cartBarCount').textContent = count;
  $('#cartBarTotal').textContent = money(total);
  $('#cartBar').hidden = !count;
  document.body.classList.toggle('has-cart-bar', count > 0);

  syncProductControls();
  if ($('#checkoutModal').classList.contains('open')) updateCheckoutSummary();
}

$('#productGrid').addEventListener('click', (e) => {
  const addBtn = e.target.closest('[data-add]');
  if (addBtn) return add(+addBtn.dataset.add);
  const plus = e.target.closest('[data-qty-plus]');
  if (plus) return changeQty(+plus.dataset.qtyPlus, 1);
  const minus = e.target.closest('[data-qty-minus]');
  if (minus) return changeQty(+minus.dataset.qtyMinus, -1);
});

$('#cartItems').addEventListener('click', (e) => {
  const plus = e.target.closest('[data-qty-plus]');
  if (plus) return changeQty(+plus.dataset.qtyPlus, 1);
  const minus = e.target.closest('[data-qty-minus]');
  if (minus) return changeQty(+minus.dataset.qtyMinus, -1);
  const rem = e.target.closest('[data-remove]');
  if (rem) {
    removeItem(+rem.dataset.remove);
    $('#cartPanel').focus();
  }
});
$('#cartItems').addEventListener('input', (e) => {
  const input = e.target.closest('[data-notes-idx]');
  if (input) setNotes(+input.dataset.notesIdx, input.value);
});

// ------------------------------------------------------------------
// Camadas (painel do carrinho, finalização, sucesso)
// ------------------------------------------------------------------
let lastFocus = null;

function lockScroll(on) {
  document.body.classList.toggle('is-locked', on);
}

function anyLayerOpen() {
  return ['#checkoutModal', '#successModal'].some((s) => $(s).classList.contains('open')) ||
    (!desktopQuery.matches && $('#cartPanel').classList.contains('open'));
}

function syncOverlay() {
  const open = anyLayerOpen();
  if (open) $('#toast').classList.remove('show'); // não cobrir o painel que acabou de abrir
  $('#overlay').classList.toggle('open', open);
  lockScroll(open);
}

function openCart() {
  if (desktopQuery.matches) {
    $('#cartPanel').scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest' });
    $('#cartPanel').focus({ preventScroll: true });
    return;
  }
  lastFocus = document.activeElement;
  $('#cartPanel').classList.add('open');
  syncOverlay();
  $('#closeCart').focus();
}

function closeCart({ restoreFocus = true } = {}) {
  if (!$('#cartPanel').classList.contains('open')) return;
  $('#cartPanel').classList.remove('open');
  syncOverlay();
  if (restoreFocus && lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

function openCheckout() {
  if (!state.cart.length || !storeOpen()) return;
  const opener = $('#cartPanel').classList.contains('open') ? lastFocus : document.activeElement;
  closeCart({ restoreFocus: false });
  lastFocus = opener;
  hideCheckoutError();
  updateCheckoutSummary();
  syncDeliveryFields();
  $('#checkoutModal').classList.add('open');
  syncOverlay();
  $('.modal-body', $('#checkoutModal')).scrollTop = 0;
  // Foco no diálogo (e não no 1º campo) para o teclado do celular não
  // abrir sozinho cobrindo o resumo; no teclado físico, Tab entra nos campos.
  $('#checkoutModal').focus({ preventScroll: true });
}

function closeCheckout() {
  if (!$('#checkoutModal').classList.contains('open')) return;
  $('#checkoutModal').classList.remove('open');
  syncOverlay();
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

function closeSuccess() {
  $('#successModal').classList.remove('open');
  syncOverlay();
  $('#menu').focus({ preventScroll: true });
}

$('#openCart').onclick = openCart;
$('#cartBarBtn').onclick = openCart;
$('#closeCart').onclick = () => closeCart();
$('#overlay').onclick = () => {
  if ($('#successModal').classList.contains('open')) return closeSuccess();
  if ($('#checkoutModal').classList.contains('open')) return closeCheckout();
  closeCart();
};
$('#checkoutBtn').onclick = openCheckout;
$('#closeCheckout').onclick = closeCheckout;
$('#closeSuccess').onclick = closeSuccess;

// Se a tela mudar de tamanho com o painel aberto (ex.: girar o tablet)
desktopQuery.addEventListener?.('change', () => {
  $('#cartPanel').classList.remove('open');
  syncOverlay();
});

// Teclado: Esc fecha a camada do topo; Tab fica preso dentro dela
function topLayer() {
  if ($('#successModal').classList.contains('open')) return $('#successModal');
  if ($('#checkoutModal').classList.contains('open')) return $('#checkoutModal');
  if (!desktopQuery.matches && $('#cartPanel').classList.contains('open')) return $('#cartPanel');
  return null;
}
document.addEventListener('keydown', (e) => {
  const layer = topLayer();
  if (!layer) return;
  if (e.key === 'Escape') {
    if (layer.id === 'successModal') closeSuccess();
    else if (layer.id === 'checkoutModal') closeCheckout();
    else closeCart();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusables = $$('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])', layer)
    .filter((el) => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && (document.activeElement === first || !layer.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// ------------------------------------------------------------------
// Finalização
// ------------------------------------------------------------------
const form = $('#checkoutForm');
const orderType = () => form.querySelector('input[name=order_type]:checked')?.value || 'entrega';
const paymentMethod = () => form.querySelector('input[name=payment_method]:checked')?.value || 'pix';

function updateFeeLabel() {
  $('#feeLabel').textContent = state.feeKnown
    ? state.config.delivery_fee > 0 ? `Taxa de ${money(state.config.delivery_fee)}` : 'Sem taxa'
    : 'Taxa calculada no envio';
}

function updateCheckoutSummary() {
  const subtotal = cartSubtotal();
  const isDelivery = orderType() === 'entrega';
  const fee = isDelivery ? state.config.delivery_fee || 0 : 0;
  const items = state.cart
    .map((i) => {
      const p = productById(i.id);
      return p ? `<li><span>${i.quantity}× ${esc(p.name)}</span><span>${money(p.price * i.quantity)}</span></li>` : '';
    })
    .join('');
  let rows = `<div class="summary-row"><span>Subtotal</span><span>${money(subtotal)}</span></div>`;
  if (isDelivery) {
    rows += `<div class="summary-row"><span>Taxa de entrega</span><span>${state.feeKnown ? money(fee) : 'calculada no envio'}</span></div>`;
  }
  rows += `<div class="summary-row summary-row--total"><span>Total</span><strong>${money(subtotal + fee)}</strong></div>`;
  $('#checkoutSummary').innerHTML = `<ul>${items}</ul>${rows}`;
  $('#submitOrder').textContent = `Enviar pedido · ${money(subtotal + fee)}`;
}

function syncDeliveryFields() {
  const isDelivery = orderType() === 'entrega';
  $('#addressField').hidden = !isDelivery;
  $('#fAddress').required = isDelivery;
  if (!isDelivery) setFieldError($('#fAddress'), '');
  $('#changeField').hidden = paymentMethod() !== 'dinheiro';
  if (paymentMethod() !== 'dinheiro') setFieldError($('#fChange'), '');
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'order_type' || e.target.name === 'payment_method') {
    syncDeliveryFields();
    updateCheckoutSummary();
  }
});
form.addEventListener('input', (e) => {
  if (e.target.getAttribute('aria-invalid') === 'true') setFieldError(e.target, '');
});

function setFieldError(input, message) {
  const err = document.getElementById(`${input.id}Err`);
  if (err) err.innerHTML = message ? `${icon('alert', 'icon icon--sm')}<span>${esc(message)}</span>` : '';
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function validateCheckout() {
  const checks = [
    [$('#fName'), !$('#fName').value.trim() ? 'Informe seu nome.' : ''],
    [$('#fPhone'), (() => {
      const v = $('#fPhone').value.trim();
      if (!v) return 'Informe um telefone para contato.';
      if (v.replace(/\D/g, '').length < 8) return 'Confira o telefone — inclua o DDD.';
      return '';
    })()],
  ];
  if (orderType() === 'entrega') {
    checks.push([$('#fAddress'), !$('#fAddress').value.trim() ? 'Informe o endereço para entrega.' : '']);
  }
  if (paymentMethod() === 'dinheiro') {
    const input = $('#fChange');
    const bad = input.validity.badInput || (input.value !== '' && (Number(input.value) < 0 || Number(input.value) > 9999));
    checks.push([input, bad ? 'Informe um valor válido, por exemplo 50.' : '']);
  }
  let firstInvalid = null;
  checks.forEach(([input, msg]) => {
    setFieldError(input, msg);
    if (msg && !firstInvalid) firstInvalid = input;
  });
  if (firstInvalid) {
    firstInvalid.focus();
    firstInvalid.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    return false;
  }
  return true;
}

function showCheckoutError(message, action) {
  const box = $('#checkoutError');
  box.innerHTML = `${icon('alert')}<div class="form-alert__body"><span>${esc(message)}</span>${action ? `<button class="btn btn--danger btn--sm" type="button" id="checkoutErrorAction">${esc(action.label)}</button>` : ''}</div>`;
  box.hidden = false;
  if (action) $('#checkoutErrorAction').onclick = action.run;
  box.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

// ------------------------------------------------------------------
// Produtos esgotados
// ------------------------------------------------------------------
function markUnavailable(list) {
  list.forEach((u) => {
    const p = productById(u.product_id);
    if (!p) return;
    if (u.reason === 'sold_out') p.sold_out = true;
    else p.unavailable = 'inactive';
  });
  syncProductControls(true);
  renderCart();
}

function removeUnavailable() {
  const gone = unavailableInCart().map((i) => productById(i.id)?.name).filter(Boolean);
  state.cart = state.cart.filter((i) => !isUnavailable(productById(i.id)));
  renderCart();
  hideCheckoutError();
  if (!state.cart.length) {
    closeCheckout();
    toast('Removemos os itens indisponíveis. Seu pedido ficou vazio.', 'error');
    return;
  }
  updateCheckoutSummary();
  toast(`Removido: ${gone.join(', ')}. Confira o resumo e envie de novo.`, 'success');
  $('#checkoutSummary').scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

// Atualiza "esgotado hoje" sem redesenhar o cardápio (mantém rolagem e foco)
function applyProducts(fresh) {
  const byId = new Map(fresh.map((p) => [p.id, p]));
  let changed = false;
  state.products.forEach((p) => {
    const f = byId.get(p.id);
    const soldOut = f ? !!f.sold_out : p.sold_out;
    const gone = f ? null : 'inactive'; // sumiu da lista pública = desativado
    if (soldOut !== !!p.sold_out || gone !== (p.unavailable || null)) {
      p.sold_out = soldOut;
      p.unavailable = gone;
      changed = true;
    }
  });
  if (changed) {
    syncProductControls(true);
    renderCart();
  }
}
function hideCheckoutError() {
  $('#checkoutError').hidden = true;
}

function setSubmitting(on) {
  const btn = $('#submitOrder');
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
  if (on) btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Enviando pedido…';
  else updateCheckoutSummary();
}

form.onsubmit = async (e) => {
  e.preventDefault();
  if ($('#submitOrder').disabled) return; // evita envio duplicado
  hideCheckoutError();
  if (!state.cart.length) return showCheckoutError('Seu pedido está vazio. Adicione um item do cardápio.');
  if (!validateCheckout()) return;

  const payload = Object.fromEntries(new FormData(form).entries());
  payload.items = state.cart.map((i) => ({ product_id: i.id, quantity: i.quantity, notes: i.notes }));

  setSubmitting(true);
  let res;
  try {
    res = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (err) {
    setSubmitting(false);
    return showCheckoutError('Sem conexão com a internet: não recebemos a confirmação do pedido. Verifique sua conexão e toque em “Enviar pedido” novamente.');
  }
  const data = await res.json().catch(() => ({}));
  setSubmitting(false);

  if (res.status === 429) {
    return showCheckoutError('Muitas tentativas em pouco tempo. Seu pedido NÃO foi enviado — aguarde um minuto e tente novamente.');
  }
  if (data.code === 'store_closed') {
    // A loja fechou enquanto o cliente montava o pedido: o carrinho fica intacto
    applyStore(data.store);
    $('#submitOrder').disabled = true;
    return showCheckoutError(`${data.error} Seu pedido NÃO foi enviado, mas continua salvo aqui.`);
  }
  if (data.code === 'products_unavailable' && Array.isArray(data.unavailable)) {
    // Algum item esgotou/saiu do cardápio: marca no carrinho e oferece remover só ele
    markUnavailable(data.unavailable);
    return showCheckoutError(`${data.error} Seu pedido NÃO foi enviado.`, {
      label: data.unavailable.length === 1 ? 'Remover este item' : 'Remover itens indisponíveis',
      run: removeUnavailable,
    });
  }
  if (!res.ok || !data.order) {
    return showCheckoutError(`${data.error || 'Não foi possível enviar o pedido.'} Seu pedido NÃO foi enviado — confira e tente novamente.`);
  }

  // Sucesso
  state.cart = [];
  renderCart();
  form.reset();
  syncDeliveryFields();
  $('#checkoutModal').classList.remove('open');
  $('#successNumber').textContent = `#${String(data.order.id).padStart(3, '0')}`;
  const tracking = data.tracking_url && data.tracking_token;
  $('#successText').textContent = `Recebemos seu pedido (${data.order.order_type === 'entrega' ? 'entrega' : 'retirada'}, total ${money(data.order.total)}) e ele já entrou na fila da cozinha. ${tracking ? 'Acompanhe cada etapa pelo link abaixo.' : 'Guarde o número acima caso precise falar com a gente.'}`;
  $('#trackLink').hidden = !tracking;
  if (tracking) {
    $('#trackLink').href = data.tracking_url;
    rememberOrder(data.tracking_token, data.order.id);
    showActiveOrder({ t: data.tracking_token, n: data.order.id });
  }
  $('#successModal').classList.add('open');
  syncOverlay();
  (tracking ? $('#trackLink') : $('#closeSuccess')).focus();
};

// ------------------------------------------------------------------
// Pedidos em andamento guardados neste aparelho (atalho "acompanhar")
// ------------------------------------------------------------------
const ORDERS_KEY = 'cs_pedidos';
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;

function readOrders() {
  try {
    const list = JSON.parse(localStorage.getItem(ORDERS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((o) => o && typeof o.t === 'string' && Date.now() - o.at < ORDER_TTL_MS) : [];
  } catch (err) {
    return [];
  }
}
function writeOrders(list) {
  try {
    localStorage.setItem(ORDERS_KEY, JSON.stringify(list.slice(0, 5)));
  } catch (err) {
    // aba anônima ou armazenamento bloqueado: o atalho apenas não aparece
  }
}
function rememberOrder(t, n) {
  writeOrders([{ t, n, at: Date.now() }, ...readOrders().filter((o) => o.t !== t)]);
}

function showActiveOrder(o) {
  const el = $('#activeOrder');
  if (!o) {
    el.hidden = true;
    return;
  }
  el.href = `/acompanhar?t=${encodeURIComponent(o.t)}`;
  $('#activeOrderText').textContent = o.label || `Pedido #${String(o.n).padStart(3, '0')} — toque para acompanhar`;
  el.hidden = false;
}

// Confere no servidor quais pedidos guardados ainda estão em andamento
async function checkActiveOrders() {
  const list = readOrders();
  if (!list.length) return writeOrders([]);
  const alive = [];
  for (const o of list.slice(0, 3)) {
    try {
      const r = await fetch(`/api/track/${encodeURIComponent(o.t)}`, { headers: { Accept: 'application/json' } });
      if (r.status === 404) continue;
      if (!r.ok) {
        alive.push(o); // erro passageiro: mantém, mas não mostra um status que não sabemos
        continue;
      }
      const d = await r.json();
      if (!d.is_final) alive.push({ ...o, label: `Pedido #${String(d.number).padStart(3, '0')} · ${d.headline}` });
    } catch (err) {
      alive.push(o);
    }
  }
  writeOrders(alive.map(({ t, n, at }) => ({ t, n, at })));
  showActiveOrder(alive.find((o) => o.label));
}

// Demonstração: o painel (em outra aba) marcou um produto como esgotado,
// mudou a etapa de um pedido ou a demo foi reiniciada — atualiza na hora.
window.addEventListener('demo:datachange', () => {
  refreshStore();
  checkActiveOrders();
});

init();
checkActiveOrders();
