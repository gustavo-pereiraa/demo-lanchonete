// ------------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const money = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
// Escapa qualquer texto vindo do cliente/banco antes de colocar no HTML —
// sem isso, um nome, telefone, endereço ou observação de pedido poderia
// injetar script na tela de quem administra o painel (XSS armazenado).
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
const icon = (name, cls = 'icon icon--sm') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
const orderNumber = (id) => `#${String(id).padStart(3, '0')}`;
// Cliente de balcão sem telefone recebe um identificador interno (balcao-…)
// no cadastro; na tela mostramos só que o telefone não foi informado.
const phoneLabel = (phone) => (!phone || String(phone).startsWith('balcao-') ? 'Sem telefone' : phone);
const STATUS_LABELS = { novo: 'Novo', preparacao: 'Em preparação', pronto: 'Pronto', entrega: 'Em entrega', finalizado: 'Finalizado', cancelado: 'Cancelado' };
const PAYMENT_LABELS = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', outro: 'Outro' };
const STATUS_FLOW = ['novo', 'preparacao', 'pronto', 'entrega', 'finalizado'];

function toast(text, kind = '') {
  const e = $('#toast');
  e.classList.remove('show', 'is-error', 'is-success');
  // força reflow para reiniciar a animação mesmo em toasts consecutivos
  void e.offsetWidth;
  const ic = { success: 'check', error: 'alert', bell: 'bell' }[kind];
  e.innerHTML = (ic ? icon(ic, 'icon') : '') + `<span>${esc(text)}</span>`;
  if (kind === 'success' || kind === 'error') e.classList.add(`is-${kind}`);
  e.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => e.classList.remove('show'), kind === 'bell' ? 6000 : 3200);
}

// Beep curto de duas notas via Web Audio API — não depende de nenhum
// arquivo de áudio externo.
function playNewOrderSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    [880, 1108].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = now + i * 0.16;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.16);
    });
  } catch (err) {
    // navegador bloqueou áudio automático — sem problema, o toast já avisa
  }
}

// ------------------------------------------------------------------
// Modais: foco entra no modal, Tab fica preso nele, Esc fecha e o foco
// volta para o botão que abriu.
// ------------------------------------------------------------------
let modalOpener = null;
function openOverlayModal(modalEl) {
  if (!$('.modal.open')) modalOpener = document.activeElement;
  $$('.modal.open').forEach((m) => m.classList.remove('open'));
  modalEl.classList.add('open');
  $('#adminOverlay').classList.add('open');
  document.body.classList.add('is-locked');
  modalEl.scrollTop = 0;
  modalEl.focus({ preventScroll: true });
}
function closeAllModals() {
  const wasOpen = !!$('.modal.open');
  $$('.modal').forEach((m) => m.classList.remove('open'));
  $('#adminOverlay').classList.remove('open');
  document.body.classList.remove('is-locked');
  if (wasOpen && modalOpener && document.contains(modalOpener)) modalOpener.focus({ preventScroll: true });
  modalOpener = null;
}
$('#adminOverlay').onclick = closeAllModals;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeAllModals();
  const modal = $('.modal.open');
  if (e.key !== 'Tab' || !modal) return;
  const focusables = Array.from(modal.querySelectorAll('button:not([disabled]), [href], input:not([type=hidden]):not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Algo deu errado.');
  return data;
}

// Botão em estado de carregamento (desabilitado + indicador)
async function withBusy(btn, fn) {
  if (!btn || btn.disabled) return;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${btn.textContent.trim()}`;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.innerHTML = original;
  }
}

// ------------------------------------------------------------------
// Abas
// ------------------------------------------------------------------
const TAB_LOADERS = {
  orders: loadKanban,
  dashboard: loadDashboard,
  closing: () => loadClosing(currentPeriod),
  products: loadProducts,
  customers: loadCustomers,
  history: loadHistory,
  settings: loadSettings,
};
const TAB_IDS = Object.keys(TAB_LOADERS);

function runLoader(tab) {
  Promise.resolve(TAB_LOADERS[tab]?.()).catch((err) => toast(err.message || 'Não foi possível carregar os dados.', 'error'));
}

function selectTab(btn) {
  $$('.tab').forEach((b) => {
    const on = b === btn;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  const tab = btn.dataset.tab;
  TAB_IDS.forEach((t) =>
    $(`#${t}Tab`).classList.toggle('hidden', t !== tab)
  );
  const section = $(`#${tab}Tab`);
  section.classList.remove('tab-enter');
  void section.offsetWidth;
  section.classList.add('tab-enter');
  btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  runLoader(tab);
}

$$('.tab').forEach((btn) => btn.addEventListener('click', () => selectTab(btn)));
// Setas ← → navegam entre as abas (padrão de tablist acessível)
$('.admin-tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = $$('.tab');
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  selectTab(tabs[next]);
});

$('#refreshBtn').onclick = () => {
  withBusy($('#refreshBtn'), async () => {
    await Promise.all([loadDashboardMetrics(), Promise.resolve(TAB_LOADERS[$('.tab.active').dataset.tab]?.())]);
  }).catch((err) => toast(err.message, 'error'));
};

// ------------------------------------------------------------------
// Métricas do topo (sempre visíveis)
// ------------------------------------------------------------------
async function loadDashboardMetrics() {
  const d = await api('/api/dashboard');
  $('#mTotal').textContent = money(d.today.revenue);
  $('#mOrders').textContent = d.today.orders_count;
  $('#mTicket').textContent = money(d.today.average_ticket);
  $('#mOpen').textContent = d.open_orders;
  return d;
}

// ------------------------------------------------------------------
// Kanban
// ------------------------------------------------------------------
const KANBAN_COLUMNS = [
  ['novo', 'Novo', 'Recebidos'],
  ['preparacao', 'Em preparação', 'Na cozinha'],
  ['pronto', 'Pronto', 'Aguardando saída'],
  ['entrega', 'Em entrega', 'A caminho'],
  ['finalizado', 'Finalizado', 'Concluídos'],
];
// Tempo (em minutos) a partir do qual um pedido em aberto merece atenção
const WARN_MINUTES = 20;
const LATE_MINUTES = 40;
let orders = [];
let knownOrderIds = null; // null = ainda não inicializado (evita "beepar" no primeiro carregamento)
let kanbanLoadedOnce = false;

async function loadKanban() {
  if (!kanbanLoadedOnce) {
    $('#kanban').innerHTML = KANBAN_COLUMNS.map(() => `<div class="kanban-col skeleton skeleton-col"></div>`).join('');
  }
  await refreshOrders();
  renderKanban();
  kanbanLoadedOnce = true;
}

// Busca os pedidos e avisa (som + toast) quando aparece algum pedido novo,
// mesmo se o admin estiver em outra aba no momento.
async function refreshOrders() {
  const fresh = await api('/api/orders');
  const activeIds = new Set(fresh.filter((o) => o.status !== 'cancelado').map((o) => o.id));

  if (knownOrderIds !== null) {
    const newCount = [...activeIds].filter((id) => !knownOrderIds.has(id)).length;
    if (newCount > 0) {
      playNewOrderSound();
      toast(`${newCount} pedido${newCount > 1 ? 's' : ''} novo${newCount > 1 ? 's' : ''} recebido${newCount > 1 ? 's' : ''}!`, 'bell');
    }
  }
  knownOrderIds = activeIds;
  orders = fresh;
}

function renderKanban() {
  const k = $('#kanban');
  k.innerHTML = KANBAN_COLUMNS.map(([s, l, sub]) => {
    const count = orders.filter((o) => o.status === s).length;
    return `<div class="kanban-col" data-status="${s}" role="region" aria-label="${l}: ${count} pedido${count === 1 ? '' : 's'}"><div class="kanban-head"><div><h3>${l}</h3><span>${sub}</span></div><b class="${count ? 'has-items' : ''}">${count}</b></div><div class="dropzone"></div></div>`;
  }).join('');

  orders
    .filter((o) => o.status !== 'cancelado')
    .forEach((o) => {
      const zone = document.querySelector(`[data-status="${o.status}"] .dropzone`);
      if (zone) zone.insertAdjacentHTML('beforeend', orderCard(o));
    });
  $$('.dropzone').forEach((z) => {
    if (!z.children.length) z.innerHTML = '<div class="dropzone-empty">Nenhum pedido</div>';
  });

  $$('.order-card').forEach((c) => {
    c.draggable = true;
    c.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', c.dataset.id);
      c.classList.add('dragging');
    };
    c.ondragend = () => c.classList.remove('dragging');
    c.onclick = () => openOrder(+c.dataset.id);
    c.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openOrder(+c.dataset.id);
      }
    };
  });

  $$('.kanban-col').forEach((col) => {
    col.ondragover = (e) => {
      e.preventDefault();
      col.classList.add('drag-over');
    };
    col.ondragleave = (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    };
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = +e.dataTransfer.getData('text/plain');
      const current = orders.find((o) => o.id === id);
      if (!id || current?.status === col.dataset.status) return;
      if (await changeStatus(id, col.dataset.status)) toast(`Pedido ${orderNumber(id)} movido para ${STATUS_LABELS[col.dataset.status]}.`, 'success');
      loadKanban();
      loadDashboardMetrics();
    };
  });
}

function minutesSince(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));
}
function elapsedLabel(mins) {
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h} h ${mins % 60} min` : `${Math.floor(h / 24)} d`;
}

function orderCard(o) {
  const items = o.items.map((i) => `${i.quantity}× ${esc(i.name)}`).join(', ');
  const mins = minutesSince(o.created_at);
  const open = o.status !== 'finalizado';
  const timeCls = open && mins >= LATE_MINUTES ? 'is-late' : open && mins >= WARN_MINUTES ? 'is-warn' : '';
  const isDelivery = o.order_type === 'entrega';
  const channel = o.channel === 'presencial' ? '<span class="channel-pill presencial">Balcão</span>' : '<span class="channel-pill">Site</span>';
  const label = `Pedido ${orderNumber(o.id)}, ${esc(o.customer.name)}, ${isDelivery ? 'entrega' : 'retirada'}, ${money(o.total)}, há ${elapsedLabel(mins)}`;
  return `<div class="order-card${o.status === 'novo' ? ' is-new' : ''}" data-id="${o.id}" role="button" tabindex="0" aria-label="${label}">
    <div class="order-meta"><span class="order-number">${orderNumber(o.id)}</span><span class="order-time ${timeCls}">${icon('clock')}${elapsedLabel(mins)}</span></div>
    <div class="order-main"><h4>${esc(o.customer.name)}</h4><span class="order-type">${icon(isDelivery ? 'pin' : 'store')}${isDelivery ? 'Entrega' : 'Retirada'}</span></div>
    <div class="order-items">${items}</div>
    <div class="order-footer"><span>${esc(o.payment_label)} ${channel}</span><strong>${money(o.total)}</strong></div>
  </div>`;
}

// Devolve true quando o status foi alterado com sucesso
async function changeStatus(id, status) {
  try {
    await api(`/api/orders/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

async function openOrder(id) {
  let o;
  try {
    o = await api(`/api/orders/${id}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  const isDelivery = o.order_type === 'entrega';
  $('#orderTitle').innerHTML = `Pedido ${orderNumber(o.id)} <span class="status-pill status-${esc(o.status)}">${esc(STATUS_LABELS[o.status] || o.status)}</span> ${o.channel === 'presencial' ? '<span class="channel-pill presencial">Balcão</span>' : '<span class="channel-pill">Site</span>'}`;
  $('#orderDetail').innerHTML = `
    <div class="detail-highlight">
      <div><span>Cliente</span><strong>${esc(o.customer.name)}</strong><small>${esc(phoneLabel(o.customer.phone))}</small></div>
      <div><span>Total</span><strong>${money(o.total)}</strong>${o.delivery_fee > 0 ? `<small>inclui entrega ${money(o.delivery_fee)}</small>` : ''}</div>
    </div>
    <div class="detail-grid">
      <div><span>Tipo</span><strong>${isDelivery ? 'Entrega' : 'Retirada'}</strong></div>
      <div><span>Pagamento</span><strong>${esc(o.payment_label)}${o.change_for ? ' · troco p/ ' + money(o.change_for) : ''}</strong></div>
    </div>
    ${isDelivery ? `<div class="detail-address"><span>Endereço</span><strong>${esc(o.address) || 'Não informado'}</strong></div>` : ''}
    <div class="detail-items">${o.items.map((i) => `<div class="data-row"><span>${i.quantity}× ${esc(i.name)}${i.notes ? `<small>Obs.: ${esc(i.notes)}</small>` : ''}</span><strong>${money(i.subtotal)}</strong></div>`).join('')}</div>
    ${o.notes ? `<div class="detail-note"><span>Observação do pedido</span><p>${esc(o.notes)}</p></div>` : ''}
    <div class="history"><h3>Histórico do pedido</h3>${o.history.map((h) => `<div class="history-row"><i></i><div><strong>${esc(h.new_status_label)}</strong><small>${new Date(h.changed_at).toLocaleString('pt-BR')}</small></div></div>`).join('')}</div>
  `;

  const idx = STATUS_FLOW.indexOf(o.status);
  const next = idx >= 0 && idx < STATUS_FLOW.length - 1 ? STATUS_FLOW[idx + 1] : null;
  const canCancel = !['finalizado', 'cancelado'].includes(o.status);
  let actions = '';
  if (next) actions += `<button class="btn btn--primary btn--lg" id="nextStatusBtn" type="button">Marcar como ${STATUS_LABELS[next]} ${icon('arrow-right')}</button>`;
  actions += `<button class="btn btn--ghost" id="printOrderBtn" type="button">${icon('printer')}Imprimir comanda</button>`;
  if (canCancel) actions += `<button class="btn btn--danger" id="cancelOrderBtn" type="button">${icon('x')}Cancelar pedido</button>`;
  $('#orderActions').innerHTML = actions;
  $('#printOrderBtn').onclick = () => printOrder(o);
  if (next) {
    $('#nextStatusBtn').onclick = () =>
      withBusy($('#nextStatusBtn'), async () => {
        if (await changeStatus(o.id, next)) {
          toast(`Pedido ${orderNumber(o.id)}: ${STATUS_LABELS[next]}.`, 'success');
          closeAllModals();
          refreshCurrentView();
        }
      });
  }
  if (canCancel) {
    $('#cancelOrderBtn').onclick = async () => {
      if (!confirm(`Cancelar o pedido ${orderNumber(o.id)}? Ele continua no histórico.`)) return;
      if (await changeStatus(o.id, 'cancelado')) {
        toast(`Pedido ${orderNumber(o.id)} cancelado.`);
        closeAllModals();
        refreshCurrentView();
      }
    };
  }

  openOverlayModal($('#orderModal'));
}
$('#closeOrder').onclick = closeAllModals;

// Monta e imprime a comanda de cozinha para o pedido (via impressão do navegador)
function printOrder(o) {
  const itemsHtml = o.items
    .map(
      (i) =>
        `<div class="ticket-row"><span>${i.quantity}x ${esc(i.name)}${i.notes ? ' (obs: ' + esc(i.notes) + ')' : ''}</span><span>${money(i.subtotal)}</span></div>`
    )
    .join('');
  $('#printTicket').innerHTML = `
    <h2>Cantinho Santos</h2>
    <div>Pedido ${orderNumber(o.id)}</div>
    <div>${new Date(o.created_at).toLocaleString('pt-BR')}</div>
    <div class="ticket-line"></div>
    <div>Cliente: ${esc(o.customer.name)} — ${esc(phoneLabel(o.customer.phone))}</div>
    <div>${o.order_type === 'entrega' ? 'ENTREGA · ' + esc(o.address || o.customer.address || 'endereço não informado') : 'RETIRADA NO LOCAL'}</div>
    <div class="ticket-line"></div>
    ${itemsHtml}
    <div class="ticket-line"></div>
    <div class="ticket-row"><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
    ${o.delivery_fee > 0 ? `<div class="ticket-row"><span>Taxa de entrega</span><span>${money(o.delivery_fee)}</span></div>` : ''}
    <div class="ticket-row ticket-total"><span>TOTAL</span><span>${money(o.total)}</span></div>
    <div>Pagamento: ${esc(o.payment_label)}${o.change_for ? ' (troco para ' + money(o.change_for) + ')' : ''}</div>
    ${o.notes ? `<div class="ticket-line"></div><div>Obs: ${esc(o.notes)}</div>` : ''}
  `;
  window.print();
}

// ------------------------------------------------------------------
// Novo pedido presencial (balcão/telefone) — para nenhum pedido feito
// fora do site ficar de fora do Kanban e dos relatórios.
// ------------------------------------------------------------------
let noCategories = [];
let noProducts = [];
let noCart = [];

async function openNewOrderModal() {
  noCart = [];
  $('#noName').value = '';
  $('#noPhone').value = '';
  $('#noAddress').value = '';
  $('#noChangeFor').value = '';
  $('#noNotes').value = '';
  $('#noOrderType').value = 'retirada';
  $('#noPayment').value = 'pix';
  $('#noAddressField').style.display = 'none';
  $('#noChangeField').style.display = 'none';
  try {
    [noCategories, noProducts] = await Promise.all([api('/api/categories'), api('/api/products')]);
    noCategories = noCategories.filter((c) => noProducts.some((p) => p.category_id === c.id));
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  renderNoCategoryTabs();
  renderNoCart();
  openOverlayModal($('#newOrderModal'));
}
$('#newOrderBtn').onclick = openNewOrderModal;
$('#closeNewOrder').onclick = closeAllModals;

function renderNoCategoryTabs() {
  $('#noCategoryTabs').innerHTML = noCategories
    .map((c, i) => `<button type="button" class="chip ${i === 0 ? 'active' : ''}" aria-pressed="${i === 0}" data-cat="${c.id}">${esc(c.name)}</button>`)
    .join('');
  $$('#noCategoryTabs .chip').forEach((btn) =>
    btn.addEventListener('click', () => {
      $$('#noCategoryTabs .chip').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      renderNoProductList(+btn.dataset.cat);
    })
  );
  if (noCategories.length) renderNoProductList(noCategories[0].id);
  else $('#noProductList').innerHTML = '<div class="empty-data">Nenhum produto ativo no cardápio.</div>';
}

function renderNoProductList(catId) {
  const list = noProducts.filter((p) => p.category_id === catId);
  $('#noProductList').innerHTML =
    list
      .map(
        (p) => p.sold_out
          ? `<div class="list-row is-sold-out"><div class="lr-main"><strong>${esc(p.name)} <span class="sold-pill">Esgotado hoje</span></strong><small>${money(p.price)}</small></div><button type="button" class="btn btn--ghost btn--sm" disabled aria-label="${esc(p.name)} está esgotado hoje">${icon('plus')}Adicionar</button></div>`
          : `<div class="list-row"><div class="lr-main"><strong>${esc(p.name)}</strong><small>${money(p.price)}</small></div><button type="button" class="btn btn--ghost btn--sm" data-no-add="${p.id}" aria-label="Adicionar ${esc(p.name)}">${icon('plus')}Adicionar</button></div>`
      )
      .join('') || '<div class="empty-data">Sem produtos nesta categoria.</div>';
}
$('#noProductList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-no-add]');
  if (!btn) return;
  const id = +btn.dataset.noAdd;
  const existing = noCart.find((i) => i.id === id);
  if (existing) existing.quantity++;
  else noCart.push({ id, quantity: 1 });
  renderNoCart();
});

function renderNoCart() {
  const el = $('#noCart');
  if (!noCart.length) {
    el.innerHTML = '<div class="empty-data">Nenhum item ainda — use “Adicionar” na lista de produtos.</div>';
    return;
  }
  let total = 0;
  el.innerHTML =
    noCart
      .map((i, idx) => {
        const p = noProducts.find((x) => x.id === i.id);
        const sub = p.price * i.quantity;
        total += sub;
        return `<div class="data-row"><span>${esc(p.name)}</span><div class="stepper" role="group" aria-label="Quantidade de ${esc(p.name)}"><button type="button" class="stepper__btn" data-no-minus="${idx}" aria-label="Diminuir">${icon(i.quantity === 1 ? 'trash' : 'minus')}</button><span class="stepper__value">${i.quantity}</span><button type="button" class="stepper__btn" data-no-plus="${idx}" aria-label="Aumentar">${icon('plus')}</button></div><strong>${money(sub)}</strong></div>`;
      })
      .join('') + `<div class="data-row no-cart-total"><span>Total dos itens</span><strong>${money(total)}</strong></div>`;
}
$('#noCart').addEventListener('click', (e) => {
  const plus = e.target.closest('[data-no-plus]');
  const minus = e.target.closest('[data-no-minus]');
  if (plus) {
    noCart[+plus.dataset.noPlus].quantity++;
    renderNoCart();
  }
  if (minus) {
    const idx = +minus.dataset.noMinus;
    noCart[idx].quantity--;
    if (noCart[idx].quantity <= 0) noCart.splice(idx, 1);
    renderNoCart();
  }
});

$('#noOrderType').onchange = (e) => {
  $('#noAddressField').style.display = e.target.value === 'entrega' ? 'grid' : 'none';
};
$('#noPayment').onchange = (e) => {
  $('#noChangeField').style.display = e.target.value === 'dinheiro' ? 'grid' : 'none';
};

$('#submitNewOrder').onclick = async () => {
  if (!noCart.length) return toast('Adicione ao menos um item ao pedido.', 'error');
  const orderType = $('#noOrderType').value;
  const address = $('#noAddress').value.trim();
  if (orderType === 'entrega' && !address) {
    $('#noAddress').focus();
    return toast('Informe o endereço para entrega.', 'error');
  }

  const payload = {
    name: $('#noName').value.trim(),
    phone: $('#noPhone').value.trim(),
    order_type: orderType,
    address,
    payment_method: $('#noPayment').value,
    change_for: $('#noChangeFor').value || undefined,
    notes: $('#noNotes').value.trim(),
    items: noCart.map((i) => ({ product_id: i.id, quantity: i.quantity })),
  };

  await withBusy($('#submitNewOrder'), async () => {
    try {
      const res = await api('/api/orders/presencial', { method: 'POST', body: JSON.stringify(payload) });
      toast(`Pedido ${orderNumber(res.order.id)} registrado!`, 'success');
      closeAllModals();
      refreshCurrentView();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
};

function refreshCurrentView() {
  loadDashboardMetrics().catch(() => {});
  runLoader($('.tab.active').dataset.tab);
}

// ------------------------------------------------------------------
// Painel (dashboard com gráficos simples em CSS)
// ------------------------------------------------------------------
function barChart(container, items, valueKey, labelKey, formatter, titleFormatter) {
  const max = Math.max(1, ...items.map((i) => i[valueKey]));
  const allZero = items.every((i) => !i[valueKey]);
  container.innerHTML =
    items
      .map((i, idx) => {
        const v = i[valueKey];
        const pct = Math.max(2, Math.round((v / max) * 100));
        return `<div class="bar${v ? '' : ' is-zero'}" style="height:${pct}%;animation-delay:${idx * 20}ms" title="${esc(i[labelKey])}: ${esc(titleFormatter ? titleFormatter(v) : v)}"><span>${formatter ? formatter(v) : v}</span><em>${esc(i[labelKey])}</em></div>`;
      })
      .join('') + (allZero ? '<div class="chart-empty">Sem movimento no período</div>' : '');
}

async function loadDashboard() {
  const d = await api('/api/dashboard');
  barChart($('#revenueChart'), d.revenue_by_day, 'revenue', 'day', (v) => (v > 0 ? Math.round(v) : ''), money);
  barChart(
    $('#hoursChart'),
    d.orders_by_hour.filter((h) => h.hour >= 6).map((h) => ({ ...h, label: `${h.hour}h` })),
    'orders_count',
    'label',
    (v) => (v > 0 ? v : ''),
    (v) => `${v} pedido${v === 1 ? '' : 's'}`
  );
  $('#topProducts').innerHTML =
    d.top_products.map((p, i) => `<div class="data-row rank-row"><span><b>${i + 1}</b>${esc(p.name)}</span><strong>${p.quantity} un.</strong></div>`).join('') ||
    '<div class="empty-data">Sem vendas nos últimos 30 dias.</div>';

  const today = d.today;
  $('#dashPayments').innerHTML =
    today.by_payment_method
      .map((p) => `<div class="data-row"><span><i class="pay-dot"></i>${esc(p.payment_label)}</span><strong>${money(p.revenue)}</strong></div>`)
      .join('') || '<div class="empty-data">Sem pedidos hoje ainda.</div>';
}

// ------------------------------------------------------------------
// Fechamento
// ------------------------------------------------------------------
let currentPeriod = 'hoje';

function changeBadge(elId, pct) {
  const el = $(elId);
  if (pct == null) {
    el.textContent = 'Sem dados do período anterior';
    el.className = '';
    return;
  }
  const positive = pct >= 0;
  el.textContent = `${positive ? '▲' : '▼'} ${Math.abs(pct).toLocaleString('pt-BR')}% vs. período anterior`;
  el.className = positive ? 'change-positive' : 'change-negative';
}

async function loadClosing(period, from, to) {
  currentPeriod = period;
  let url = `/api/closing?period=${period}`;
  if (period === 'personalizado' && from && to) url += `&from=${from}&to=${to}`;
  let d;
  try {
    d = await api(url);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  $('#cTotal').textContent = money(d.current.revenue);
  $('#cOrders').textContent = d.current.orders_count;
  $('#cTicket').textContent = money(d.current.average_ticket);
  changeBadge('#cTotalChange', d.comparison.revenue_change_pct);
  changeBadge('#cOrdersChange', d.comparison.orders_change_pct);
  changeBadge('#cTicketChange', d.comparison.ticket_change_pct);

  $('#payments').innerHTML =
    d.current.by_payment_method
      .map((p) => `<div class="data-row"><span><i class="pay-dot"></i><span>${esc(p.payment_label)}<small>${p.orders_count} pedido${p.orders_count === 1 ? '' : 's'}</small></span></span><strong>${money(p.revenue)}</strong></div>`)
      .join('') || '<div class="empty-data">Nenhum dado no período.</div>';
  $('#closingChannel').innerHTML =
    (d.current.by_channel || [])
      .map((c) => `<div class="data-row"><span><i class="pay-dot"></i><span>${esc(c.channel_label)}<small>${c.orders_count} pedido${c.orders_count === 1 ? '' : 's'}</small></span></span><strong>${money(c.revenue)}</strong></div>`)
      .join('') || '<div class="empty-data">Nenhum dado no período.</div>';
  $('#closingProducts').innerHTML =
    d.current.by_product
      .map((p, i) => `<div class="data-row rank-row"><span><b>${i + 1}</b><span>${esc(p.product_name)}<small>${p.quantity} un.</small></span></span><strong>${money(p.revenue)}</strong></div>`)
      .join('') || '<div class="empty-data">Nenhum dado no período.</div>';
}

$$('.period').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.period').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    });
    $('#customRange').classList.toggle('hidden', b.dataset.period !== 'personalizado');
    if (b.dataset.period !== 'personalizado') loadClosing(b.dataset.period);
    else $('#rangeFrom').focus();
  })
);
$('#applyRange').onclick = () => {
  if (!$('#rangeFrom').value || !$('#rangeTo').value) return toast('Escolha as duas datas.', 'error');
  loadClosing('personalizado', $('#rangeFrom').value, $('#rangeTo').value);
};
$('#exportClosing').onclick = () => {
  let url = `/api/closing/export?period=${currentPeriod}`;
  if (currentPeriod === 'personalizado') {
    const from = $('#rangeFrom').value;
    const to = $('#rangeTo').value;
    if (!from || !to) return toast('Escolha as duas datas antes de exportar.', 'error');
    url += `&from=${from}&to=${to}`;
  }
  window.location.href = url;
};

// ------------------------------------------------------------------
// Produtos + categorias
// ------------------------------------------------------------------
let categories = [];
let products = [];

async function loadProducts() {
  [categories, products] = await Promise.all([api('/api/categories?all=true'), api('/api/products?all=true')]);
  renderCategoryChips();
  renderProductList();
}

function renderCategoryChips() {
  $('#categoryChips').innerHTML = categories
    .map((c) => `<button type="button" class="category-chip ${c.active ? '' : 'inactive'}" data-id="${c.id}" aria-pressed="${c.active}" title="${c.active ? 'Ativa — toque para desativar' : 'Inativa — toque para ativar'}">${esc(c.name)}</button>`)
    .join('');
  $$('#categoryChips .category-chip').forEach((chip) =>
    chip.addEventListener('click', async () => {
      const cat = categories.find((c) => c.id === +chip.dataset.id);
      if (!confirm(`${cat.active ? 'Desativar' : 'Ativar'} a categoria "${cat.name}"?`)) return;
      try {
        await api(`/api/categories/${cat.id}`, { method: 'PUT', body: JSON.stringify({ active: !cat.active }) });
        toast(cat.active ? 'Categoria desativada.' : 'Categoria ativada.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
      loadProducts();
    })
  );
}

let productFilter = 'all';
const PRODUCT_FILTERS = {
  all: () => true,
  soldout: (p) => p.sold_out && p.active,
  inactive: (p) => !p.active,
};
const PRODUCT_EMPTY = {
  all: 'Nenhum produto cadastrado.',
  soldout: 'Nenhum produto esgotado hoje.',
  inactive: 'Nenhum produto inativo.',
};

$$('[data-pfilter]').forEach((b) =>
  b.addEventListener('click', () => {
    productFilter = b.dataset.pfilter;
    $$('[data-pfilter]').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    });
    renderProductList();
  })
);

function soldOutButton(p) {
  if (!p.active) return '';
  return `<button type="button" class="btn btn--sm sold-toggle" data-soldout="${p.id}" aria-pressed="${p.sold_out}" aria-label="${esc(p.name)}: esgotado hoje">${p.sold_out ? icon('check') : ''}Esgotado hoje</button>`;
}

function renderProductList() {
  $('#soldOutCount').textContent = products.filter(PRODUCT_FILTERS.soldout).length;
  $('#productAdmin').innerHTML =
    products
      .filter(PRODUCT_FILTERS[productFilter])
      .map(
        (p) => `<div class="list-row${p.active ? '' : ' is-inactive'}${p.sold_out && p.active ? ' is-sold-out' : ''}" data-id="${p.id}">
      <div class="lr-main"><strong>${esc(p.name)}${!p.active ? ' <span class="status-pill status-cancelado">Inativo</span>' : ''}${p.sold_out && p.active ? ' <span class="sold-pill">Esgotado hoje</span>' : ''}</strong><small>${esc(p.category_name || 'Sem categoria')} · ${esc(p.description || 'Sem descrição')}</small></div>
      <div class="lr-side"><strong>${money(p.price)}</strong><div class="lr-actions">${soldOutButton(p)}<button type="button" class="btn btn--ghost btn--sm" data-edit="${p.id}">${icon('edit')}Editar</button><button type="button" class="btn btn--quiet btn--sm" data-toggle="${p.id}">${icon('power')}${p.active ? 'Desativar' : 'Ativar'}</button></div></div>
    </div>`
      )
      .join('') || `<div class="empty-data">${PRODUCT_EMPTY[productFilter]}</div>`;

  // Um toque, sem confirmação: é reversível e volta sozinho no dia seguinte
  $$('[data-soldout]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const p = products.find((x) => x.id === +btn.dataset.soldout);
      const value = !p.sold_out;
      btn.disabled = true;
      try {
        await api(`/api/products/${p.id}/sold-out`, { method: 'PUT', body: JSON.stringify({ sold_out: value }) });
        p.sold_out = value;
        toast(value ? `${p.name}: esgotado hoje.` : `${p.name} disponível de novo.`, 'success');
        renderProductList();
        $(`[data-soldout="${p.id}"]`)?.focus();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    })
  );

  $$('[data-edit]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openProductForm(products.find((p) => p.id === +a.dataset.edit));
    })
  );
  $$('[data-toggle]').forEach((a) =>
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const p = products.find((x) => x.id === +a.dataset.toggle);
      if (p.active && !confirm(`Desativar "${p.name}"? Ele some do cardápio, mas o histórico é mantido.`)) return;
      try {
        await api(`/api/products/${p.id}`, { method: 'PUT', body: JSON.stringify({ active: !p.active }) });
        toast(p.active ? 'Produto desativado.' : 'Produto ativado.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
      loadProducts();
    })
  );
}

function openProductForm(product) {
  $('#productModalTitle').textContent = product ? 'Editar produto' : 'Novo produto';
  const form = $('#productForm');
  form.reset();
  form.id.value = product ? product.id : '';
  if (product) {
    form.name.value = product.name;
    form.description.value = product.description || '';
    form.price.value = product.price;
    form.image_url.value = product.image_url || '';
  }
  $('#productCategory').innerHTML =
    '<option value="">Sem categoria</option>' +
    categories.map((c) => `<option value="${c.id}" ${product?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  openOverlayModal($('#productModal'));
}
$('#newProduct').onclick = () => openProductForm(null);
$('#closeProduct').onclick = closeAllModals;
$('#productForm').onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  d.price = Number(d.price);
  d.category_id = d.category_id ? Number(d.category_id) : null;
  await withBusy(e.target.querySelector('[type=submit]'), async () => {
    try {
      if (d.id) {
        await api(`/api/products/${d.id}`, { method: 'PUT', body: JSON.stringify(d) });
        toast('Produto atualizado.', 'success');
      } else {
        await api('/api/products', { method: 'POST', body: JSON.stringify(d) });
        toast('Produto criado com sucesso.', 'success');
      }
      closeAllModals();
      loadProducts();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
};

$('#newCategory').onclick = () => openOverlayModal($('#categoryModal'));
$('#closeCategory').onclick = closeAllModals;
$('#categoryForm').onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  await withBusy(e.target.querySelector('[type=submit]'), async () => {
    try {
      await api('/api/categories', { method: 'POST', body: JSON.stringify(d) });
      toast('Categoria criada.', 'success');
      e.target.reset();
      closeAllModals();
      loadProducts();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
};

// ------------------------------------------------------------------
// Clientes
// ------------------------------------------------------------------
async function loadCustomers(q) {
  const list = await api(`/api/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('#customerList').innerHTML =
    list
      .map(
        (c) => `<div class="list-row">
      <div class="lr-main"><strong>${esc(c.name)}</strong><small>${esc(phoneLabel(c.phone))}${c.address ? ' · ' + esc(c.address) : ''}</small></div>
      <div class="lr-side"><strong>${money(c.total_spent)}</strong><small>${c.orders_count} pedido${c.orders_count === 1 ? '' : 's'} · último em ${c.last_order_at ? new Date(c.last_order_at).toLocaleDateString('pt-BR') : '—'}</small></div>
    </div>`
      )
      .join('') || `<div class="empty-data">${q ? 'Nenhum cliente encontrado com essa busca.' : 'Nenhum cliente ainda.'}</div>`;
}
let customerSearchTimer;
$('#customerSearch').oninput = (e) => {
  clearTimeout(customerSearchTimer);
  customerSearchTimer = setTimeout(() => loadCustomers(e.target.value).catch((err) => toast(err.message, 'error')), 300);
};

// ------------------------------------------------------------------
// Histórico
// ------------------------------------------------------------------
function statusPill(status) {
  return `<span class="status-pill status-${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;
}

async function loadHistory() {
  const params = new URLSearchParams();
  const q = $('#hSearch').value.trim();
  if (q) params.set('q', q);
  if ($('#hStatus').value) params.set('status', $('#hStatus').value);
  if ($('#hType').value) params.set('order_type', $('#hType').value);
  if ($('#hPayment').value) params.set('payment_method', $('#hPayment').value);
  if ($('#hChannel').value) params.set('channel', $('#hChannel').value);
  if ($('#hProduct').value.trim()) params.set('product', $('#hProduct').value.trim());
  if ($('#hFrom').value) params.set('from', $('#hFrom').value);
  if ($('#hTo').value) params.set('to', $('#hTo').value);

  const list = await api(`/api/orders?${params.toString()}`);
  $('#historyList').innerHTML =
    list
      .map(
        (o) => `<div class="list-row is-clickable" data-id="${o.id}" role="button" tabindex="0" aria-label="Abrir pedido ${orderNumber(o.id)} de ${esc(o.customer.name)}">
      <div class="lr-main"><strong>${orderNumber(o.id)} · ${esc(o.customer.name)} ${o.channel === 'presencial' ? '<span class="channel-pill presencial">Balcão</span>' : '<span class="channel-pill">Site</span>'}</strong><small>${o.items.map((i) => `${i.quantity}× ${esc(i.name)}`).join(', ')}</small></div>
      <div class="lr-side">${statusPill(o.status)}<strong>${money(o.total)}</strong><small>${new Date(o.created_at).toLocaleString('pt-BR')}</small></div>
    </div>`
      )
      .join('') || '<div class="empty-data">Nenhum pedido encontrado com esses filtros.</div>';

  $$('#historyList .list-row').forEach((row) => {
    row.onclick = () => openOrder(+row.dataset.id);
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openOrder(+row.dataset.id);
      }
    };
  });
}
$('#historyFilters').onsubmit = (e) => {
  e.preventDefault();
  withBusy($('#hApply'), loadHistory).catch((err) => toast(err.message, 'error'));
};
$('#hClear').onclick = () => {
  ['hSearch', 'hProduct', 'hFrom', 'hTo'].forEach((id) => ($(`#${id}`).value = ''));
  $('#hStatus').value = '';
  $('#hType').value = '';
  $('#hPayment').value = '';
  $('#hChannel').value = '';
  loadHistory().catch((err) => toast(err.message, 'error'));
};

// ------------------------------------------------------------------
// Loja aberta/fechada + horário de funcionamento
// ------------------------------------------------------------------
let store = null; // último retorno de /api/store

function storeStatusText(s) {
  if (s.reason === 'manual_open') return 'Aberta manualmente — aceita pedidos até você mudar.';
  if (s.reason === 'manual_closed') return 'Fechada manualmente — o site não aceita pedidos até você reabrir.';
  if (s.reason === 'not_configured') return 'Aberta — nenhum horário configurado, então o site aceita pedidos o tempo todo.';
  if (s.is_open) return `Aberta pelo horário${s.closes_at_label ? ` — fecha às ${s.closes_at_label}` : ''}.`;
  return `Fechada pelo horário${s.next_open_label ? ` — abre ${s.next_open_label}` : ''}.`;
}

function renderStore() {
  if (!store) return;
  const s = store.status;
  const btn = $('#storeStatusBtn');
  btn.dataset.open = s.is_open ? 'true' : 'false';
  $('#storeStatusText').textContent = s.is_open ? 'Aberta' : 'Fechada';
  $('#storeStatusMode').textContent = s.mode === 'auto' ? '' : 'manual';
  btn.setAttribute('aria-label', `Loja ${s.is_open ? 'aberta' : 'fechada'}${s.mode === 'auto' ? '' : ' manualmente'}. Mudar`);

  $('#storeNow').innerHTML = `<i class="dot ${s.is_open ? 'is-open' : ''}" aria-hidden="true"></i><span>${esc(storeStatusText(s))}</span>`;
  $$('.mode-option').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === s.mode ? 'true' : 'false'));
  if (document.activeElement !== $('#storeMessage')) $('#storeMessage').value = s.message || '';

  $('#storeSummary').innerHTML = `<div class="store-summary__state ${s.is_open ? 'is-open' : ''}"><i class="dot ${s.is_open ? 'is-open' : ''}" aria-hidden="true"></i><strong>${s.is_open ? 'Aberta' : 'Fechada'}</strong>${s.mode !== 'auto' ? '<span class="channel-pill">Manual</span>' : ''}</div><p>${esc(storeStatusText(s))}</p>${s.message ? `<p class="store-summary__msg">Recado: “${esc(s.message)}”</p>` : ''}`;
}

async function loadStore() {
  store = await api('/api/store');
  renderStore();
  return store;
}

function openStoreModal() {
  renderStore();
  openOverlayModal($('#storeModal'));
  loadStore().catch((err) => toast(err.message, 'error'));
}
$('#storeStatusBtn').onclick = openStoreModal;
$('#openStoreModal').onclick = openStoreModal;
$('#closeStore').onclick = closeAllModals;

const MODE_TOASTS = { closed: 'Loja fechada. O site não aceita pedidos.', open: 'Loja aberta. O site aceita pedidos.', auto: 'Loja seguindo o horário da semana.' };
$$('.mode-option').forEach((b) =>
  b.addEventListener('click', async () => {
    const all = $$('.mode-option');
    if (all.some((x) => x.disabled)) return;
    all.forEach((x) => (x.disabled = true));
    b.setAttribute('aria-busy', 'true');
    try {
      store = await api('/api/store/mode', { method: 'PUT', body: JSON.stringify({ mode: b.dataset.mode }) });
      renderStore();
      toast(MODE_TOASTS[b.dataset.mode], 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      all.forEach((x) => (x.disabled = false));
      b.removeAttribute('aria-busy');
    }
  })
);

$('#storeMessageForm').onsubmit = (e) => {
  e.preventDefault();
  withBusy($('#saveStoreMessage'), async () => {
    try {
      store = await api('/api/store/mode', { method: 'PUT', body: JSON.stringify({ message: $('#storeMessage').value.trim() }) });
      renderStore();
      toast($('#storeMessage').value.trim() ? 'Recado salvo.' : 'Recado removido.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
};
$('#goToHours').onclick = () => {
  closeAllModals();
  selectTab($('.tab[data-tab=settings]'));
  $('#hoursTitle').scrollIntoView({ block: 'start' });
};

// Próximo dia da semana (0 = segunda … 6 = domingo), para explicar o "fecha na madrugada de…"
const WEEKDAYS = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];

function hoursNote(row) {
  const open = row.querySelector('[data-open-day]').checked;
  const o = row.querySelector('[data-time=open]').value;
  const c = row.querySelector('[data-time=close]').value;
  const note = row.querySelector('.hours-note');
  if (!open) note.textContent = 'Fechado o dia todo.';
  else if (o && c && c <= o) note.textContent = `Fecha na madrugada de ${WEEKDAYS[(+row.dataset.weekday + 1) % 7]}.`;
  else note.textContent = '';
}

function renderHours() {
  if (!store) return;
  $('#hoursList').innerHTML = store.hours
    .map(
      (h) => `<div class="hours-row${h.is_closed ? ' is-closed' : ''}" data-weekday="${h.weekday}">
      <div class="hours-day">
        <strong id="hrDay${h.weekday}">${esc(h.label)}</strong>
        <label class="switch"><input type="checkbox" role="switch" data-open-day ${h.is_closed ? '' : 'checked'} aria-labelledby="hrDay${h.weekday} hrState${h.weekday}"><span class="switch__track" aria-hidden="true"></span><span class="switch__label" id="hrState${h.weekday}">${h.is_closed ? 'Fechado' : 'Aberto'}</span></label>
      </div>
      <div class="hours-times">
        <div class="field"><label for="hrOpen${h.weekday}">Abre</label><input type="time" id="hrOpen${h.weekday}" data-time="open" value="${esc(h.open_time)}" ${h.is_closed ? 'disabled' : ''} required></div>
        <div class="field"><label for="hrClose${h.weekday}">Fecha</label><input type="time" id="hrClose${h.weekday}" data-time="close" value="${esc(h.close_time)}" ${h.is_closed ? 'disabled' : ''} required></div>
      </div>
      <p class="hours-note" aria-live="polite"></p>
    </div>`
    )
    .join('');
  $$('.hours-row').forEach(hoursNote);
}

$('#hoursList').addEventListener('change', (e) => {
  const row = e.target.closest('.hours-row');
  if (!row) return;
  if (e.target.matches('[data-open-day]')) {
    const open = e.target.checked;
    row.classList.toggle('is-closed', !open);
    row.querySelector('.switch__label').textContent = open ? 'Aberto' : 'Fechado';
    row.querySelectorAll('[data-time]').forEach((i) => (i.disabled = !open));
  }
  hoursNote(row);
});
$('#hoursList').addEventListener('input', (e) => {
  const row = e.target.closest('.hours-row');
  if (row) hoursNote(row);
});

$('#hoursForm').onsubmit = (e) => {
  e.preventDefault();
  const box = $('#hoursError');
  box.hidden = true;
  $$('#hoursList input[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
  const hours = $$('.hours-row').map((row) => ({
    weekday: +row.dataset.weekday,
    is_closed: !row.querySelector('[data-open-day]').checked,
    open_time: row.querySelector('[data-time=open]').value,
    close_time: row.querySelector('[data-time=close]').value,
  }));
  const bad = hours.find((h) => !h.is_closed && (!h.open_time || !h.close_time || h.open_time === h.close_time));
  if (bad) {
    const row = $(`.hours-row[data-weekday="${bad.weekday}"]`);
    const input = !bad.open_time ? row.querySelector('[data-time=open]') : row.querySelector('[data-time=close]');
    input.setAttribute('aria-invalid', 'true');
    box.innerHTML = `${icon('alert', 'icon')}<span>${esc(WEEKDAYS[bad.weekday][0].toUpperCase() + WEEKDAYS[bad.weekday].slice(1))}: ${bad.open_time && bad.close_time ? 'abertura e fechamento não podem ser iguais.' : 'informe a abertura e o fechamento.'}</span>`;
    box.hidden = false;
    input.focus();
    return;
  }
  withBusy($('#saveHours'), async () => {
    try {
      store = await api('/api/store/hours', { method: 'PUT', body: JSON.stringify({ hours }) });
      renderStore();
      renderHours();
      toast('Horários salvos.', 'success');
    } catch (err) {
      box.innerHTML = `${icon('alert', 'icon')}<span>${esc(err.message)}</span>`;
      box.hidden = false;
    }
  });
};

async function loadSettings() {
  await loadStore();
  renderHours();
}

// ------------------------------------------------------------------
// Minha conta: troca de senha
// ------------------------------------------------------------------
const PW_FIELDS = { current_password: '#pwCurrent', new_password: '#pwNew', confirm_password: '#pwConfirm' };

function setPwError(input, message) {
  const err = $(`#${input.id}Err`);
  err.innerHTML = message ? `${icon('alert')}<span>${esc(message)}</span>` : '';
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

// Mostrar/ocultar senha
$('#passwordForm').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-reveal]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.reveal);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  btn.innerHTML = icon(show ? 'eye-off' : 'eye');
});
$('#passwordForm').addEventListener('input', (e) => {
  if (e.target.getAttribute('aria-invalid') === 'true') setPwError(e.target, '');
  $('#pwSuccess').hidden = true;
});

$('#passwordForm').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  $('#pwError').hidden = true;
  $('#pwSuccess').hidden = true;
  const values = Object.fromEntries(Object.entries(PW_FIELDS).map(([k, sel]) => [k, $(sel).value]));
  const checks = [
    ['#pwCurrent', !values.current_password ? 'Informe a senha atual.' : ''],
    ['#pwNew', !values.new_password ? 'Informe a nova senha.' : values.new_password.length < 8 ? 'A nova senha precisa ter pelo menos 8 caracteres.' : values.new_password === values.current_password ? 'A nova senha precisa ser diferente da atual.' : ''],
    ['#pwConfirm', values.confirm_password !== values.new_password ? 'A confirmação não é igual à nova senha.' : ''],
  ];
  let first = null;
  checks.forEach(([sel, msg]) => {
    setPwError($(sel), msg);
    if (msg && !first) first = $(sel);
  });
  if (first) return first.focus();

  await withBusy($('#savePassword'), async () => {
    let res;
    let data = {};
    try {
      res = await fetch('/api/account/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      $('#pwError').innerHTML = `${icon('wifi-off', 'icon')}<span>Sem conexão. A senha NÃO foi trocada — tente novamente.</span>`;
      $('#pwError').hidden = false;
      return;
    }
    if (res.ok) {
      form.reset();
      $$('#passwordForm [data-reveal]').forEach((b) => {
        document.getElementById(b.dataset.reveal).type = 'password';
        b.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-label', 'Mostrar senha');
        b.innerHTML = icon('eye');
      });
      $('#pwSuccess').innerHTML = `${icon('check', 'icon')}<span>Senha alterada. Use a nova senha no próximo login.</span>`;
      $('#pwSuccess').hidden = false;
      toast('Senha alterada com sucesso.', 'success');
      return;
    }
    if (res.status === 429) {
      $('#pwError').innerHTML = `${icon('alert', 'icon')}<span>Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.</span>`;
      $('#pwError').hidden = false;
      return;
    }
    if (res.status === 401) {
      window.location.href = '/admin/login';
      return;
    }
    const input = data.field && $(PW_FIELDS[data.field]);
    if (input) {
      setPwError(input, data.error);
      input.focus();
    } else {
      $('#pwError').innerHTML = `${icon('alert', 'icon')}<span>${esc(data.error || 'Não foi possível trocar a senha.')}</span>`;
      $('#pwError').hidden = false;
    }
  });
};

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
loadDashboardMetrics().catch((err) => toast(err.message, 'error'));
loadStore().catch(() => {});
runLoader('orders');
let pollFailed = false;
setInterval(async () => {
  try {
    await loadDashboardMetrics();
    // O modo automático muda sozinho com o relógio: mantém o indicador em dia
    await loadStore();
    // Sempre verifica pedidos novos (som/aviso), mesmo em outra aba
    await refreshOrders();
    if ($('.tab.active').dataset.tab === 'orders') renderKanban();
    if (pollFailed) toast('Conexão restabelecida.', 'success');
    pollFailed = false;
  } catch (err) {
    if (!pollFailed) toast('Sem conexão com o servidor. Tentando novamente…', 'error');
    pollFailed = true;
  }
}, 15000);
