// ------------------------------------------------------------------
// Acompanhamento do pedido pelo cliente. O link usa um token aleatório
// (nunca o número do pedido) e a página se atualiza sozinha até o pedido
// ser finalizado ou cancelado.
// ------------------------------------------------------------------
const POLL_MS = 25000;
const STORAGE_KEY = 'cs_pedidos';
const $ = (s) => document.querySelector(s);
const token = $('#trackMain').dataset.token;
const money = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const hhmm = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateTime = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${hhmm(iso)}`;
};
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
const icon = (name, cls = 'icon icon--sm') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

// Pedidos recentes guardados no aparelho (para o atalho no cardápio)
function forgetOrder() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]').filter((o) => o.t !== token);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    // armazenamento indisponível (aba anônima, bloqueado): sem problema
  }
}

let timer = null;
let finished = false;
let loading = false;

function render(d) {
  $('#tHero').dataset.status = d.status;
  $('#tNumber').textContent = `#${String(d.number).padStart(3, '0')}`;
  $('#tHeadline').textContent = d.headline;
  $('#tHint').textContent = d.hint;
  $('#tCancelled').hidden = !d.is_cancelled;
  document.title = `${d.headline} · Pedido #${String(d.number).padStart(3, '0')} | Cantinho Santos`;

  const steps = $('#tSteps');
  steps.setAttribute('aria-busy', 'false');
  steps.classList.toggle('is-cancelled', d.is_cancelled);
  steps.innerHTML = d.steps
    .map((s) => {
      const cls = s.current && !d.is_cancelled ? 'is-current' : s.done ? 'is-done' : '';
      const state = s.current && !d.is_cancelled ? ' (etapa atual)' : s.done ? ' (concluída)' : '';
      return `<li class="timeline__step ${cls}"${s.current && !d.is_cancelled ? ' aria-current="step"' : ''}>
        <span class="timeline__dot" aria-hidden="true">${s.done ? icon('check') : ''}</span>
        <span class="timeline__text"><strong>${esc(s.label)}<span class="sr-only">${state}</span></strong>${s.at ? `<small>${hhmm(s.at)}</small>` : ''}</span>
      </li>`;
    })
    .join('') + (d.is_cancelled ? `<li class="timeline__step is-cancel" aria-current="step"><span class="timeline__dot" aria-hidden="true">${icon('x')}</span><span class="timeline__text"><strong>Pedido cancelado</strong>${d.cancelled_at ? `<small>${hhmm(d.cancelled_at)}</small>` : ''}</span></li>` : '');

  const facts = [
    ['Feito em', dateTime(d.created_at)],
    ['Para', d.customer_first_name || '—'],
    [d.order_type_label, d.order_type === 'entrega' ? d.address_summary || 'Endereço informado no pedido' : 'Retirar na lanchonete'],
    ['Pagamento', `${d.payment_label}${d.change_for ? ` · troco para ${money(d.change_for)}` : ''}`],
  ];
  $('#tFacts').innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  $('#tItems').innerHTML = d.items.map((i) => `<li><span>${i.quantity}× ${esc(i.name)}</span><span>${money(i.subtotal)}</span></li>`).join('');
  $('#tTotals').innerHTML =
    (d.delivery_fee > 0 ? `<div class="summary-row"><span>Subtotal</span><span>${money(d.subtotal)}</span></div><div class="summary-row"><span>Taxa de entrega</span><span>${money(d.delivery_fee)}</span></div>` : '') +
    `<div class="summary-row summary-row--total"><span>Total</span><strong>${money(d.total)}</strong></div>`;
}

function setUpdated(text) {
  $('#tUpdated').textContent = text;
}

function schedule() {
  clearTimeout(timer);
  if (!finished && !document.hidden) timer = setTimeout(load, POLL_MS);
}

async function load() {
  if (loading) return;
  loading = true;
  clearTimeout(timer);
  try {
    const r = await fetch(`/api/track/${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (r.status === 404) {
      finished = true;
      forgetOrder();
      $('#tHeadline').textContent = 'Pedido não encontrado';
      $('#tHint').textContent = 'Confira se o link está completo.';
      setUpdated('');
      return;
    }
    if (r.status === 429) throw new Error('rate');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    render(d);
    $('#tError').hidden = true;
    finished = d.is_final;
    if (finished) {
      forgetOrder();
      setUpdated(d.is_cancelled ? 'Pedido encerrado.' : 'Pedido concluído — não é mais preciso acompanhar.');
      $('#tRefresh').hidden = true;
    } else {
      setUpdated(`Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · atualiza sozinho a cada ${POLL_MS / 1000} s`);
    }
  } catch (err) {
    $('#tError').innerHTML = `${icon('wifi-off', 'icon')}<span>${err.message === 'rate' ? 'Muitas atualizações seguidas. Vamos tentar de novo em instantes.' : 'Não foi possível atualizar agora. Verifique sua conexão — tentaremos de novo automaticamente.'}</span>`;
    $('#tError').hidden = false;
  } finally {
    loading = false;
    schedule();
  }
}

// Aba oculta: para de consultar; ao voltar, atualiza na hora
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else if (!finished) load();
});
$('#tRefresh').onclick = load;

load();
