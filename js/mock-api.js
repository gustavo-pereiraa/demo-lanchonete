// ------------------------------------------------------------------
// API simulada da versão de demonstração.
//
// Substitui window.fetch: toda chamada para /api/* é respondida aqui
// mesmo, no navegador, seguindo as regras do backend Flask original
// (mesmos formatos de JSON, cálculos e mensagens de erro). Qualquer outra
// requisição segue normalmente para a rede.
//
// Os dados ficam no localStorage (chave DB_KEY). Cada aba lê o estado na
// hora de responder, então duas abas abertas (cardápio + painel) enxergam
// sempre os mesmos pedidos. Quando outra aba grava, o evento `storage` é
// repassado às páginas como `demo:datachange`.
//
// Valores em dinheiro são guardados em centavos (inteiros) para não haver
// erro de arredondamento; nas respostas viram reais, como no Flask.
// ------------------------------------------------------------------
(function () {
  'use strict';

  const DB_KEY = 'grid-demo-lanchonete-v1';
  const SCHEMA = 1;
  const DELIVERY_FEE = 500; // R$ 5,00, como o DELIVERY_FEE padrão do app.py
  const OPERATIONAL_DAY_START_HOUR = 5;
  const STORE_NAME = 'Lanche da Esquina';

  const STATUS_FLOW = ['novo', 'preparacao', 'pronto', 'entrega', 'finalizado'];
  const ALL_STATUSES = STATUS_FLOW.concat('cancelado');
  const STATUS_LABELS = { novo: 'Novo', preparacao: 'Em preparação', pronto: 'Pronto', entrega: 'Em entrega', finalizado: 'Finalizado', cancelado: 'Cancelado' };
  const PAYMENT_LABELS = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', outro: 'Outro' };
  const PAYMENT_METHODS = Object.keys(PAYMENT_LABELS);
  const ORDER_TYPES = ['entrega', 'retirada'];
  const CHANNEL_LABELS = { online: 'Site', presencial: 'Balcão' };
  const STORE_MODES = ['auto', 'open', 'closed'];
  const WEEKDAY_LABELS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
  const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  // ----------------------------------------------------------------
  // Datas: sempre "ingênuas" no horário local, no formato do isoformat()
  // do Python (YYYY-MM-DDTHH:MM:SS), como o backend grava.
  // ----------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const dateKey = (d) => iso(d).slice(0, 10);
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
  const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);
  const weekday = (d) => (d.getDay() + 6) % 7; // 0 = segunda, como datetime.weekday()
  const businessDate = () => dateKey(new Date(Date.now() - OPERATIONAL_DAY_START_HOUR * 3600000));

  // Equivalente a datetime.fromisoformat para os formatos usados pelo app
  function parseISO(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?)?$/.exec(String(s ?? ''));
    if (!m) return null;
    const [y, mo, d, h = 0, mi = 0, se = 0] = m.slice(1).map((v) => (v === undefined ? undefined : +v));
    const date = new Date(y, mo - 1, d, h, mi, se);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || h > 23 || mi > 59 || se > 59) return null;
    return date;
  }

  const money = (cents) => (cents || 0) / 100;
  const str = (v) => (v === null || v === undefined || v === false ? '' : String(v)).trim();
  const ilike = (haystack, needle) => String(haystack || '').toLowerCase().includes(String(needle).toLowerCase());
  const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const round1 = (v) => Math.round(v * 10) / 10;

  class ApiError extends Error {
    constructor(message, status = 400, extra = {}) {
      super(message);
      this.status = status;
      this.extra = extra;
    }
  }

  // Decimal(str(value)) do Python: aceita número ou texto numérico
  function toCents(value, fieldName) {
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text))) {
      throw new ApiError(`Valor inválido para "${fieldName}".`);
    }
    return Math.round(Number(text) * 100);
  }

  // int() do Python para os campos de item
  function toInt(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) return parseInt(value, 10);
    throw new ApiError('Item de pedido inválido.');
  }

  // ----------------------------------------------------------------
  // Cardápio: mesmas categorias, produtos e preços do comando `seed`
  // ----------------------------------------------------------------
  const CATEGORY_SPECS = [['Lanche', 1], ['Pastel', 2], ['Porção', 3], ['Batata Recheada', 4], ['Bebidas', 5]];
  const BATATA = 'Todas as batatas vêm com opcional de cheddar ou catupiry.';
  const MENU = [
    ['X-Burguer', 'Pão de Hambúrguer, Hambúrguer, Presunto e Mussarela, Ketchup e maionese.', 14.5, 'Lanche'],
    ['X-Burguer Egg', 'Pão de hambúrguer, Hambúrguer, Ovo, Presunto e Mussarela, Ketchup e maionese.', 16, 'Lanche'],
    ['X-Salada Simples', 'Pão de Hambúrguer, Hambúrguer, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 17, 'Lanche'],
    ['X-Egg', 'Pão de Hambúrguer, Hambúrguer, Ovo, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 18, 'Lanche'],
    ['X-Salada Especial', 'Pão de Hambúrguer, Hambúrguer, Bacon e calabresa, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 23, 'Lanche'],
    ['X-Bacon', 'Pão de Hambúrguer, Hambúrguer, Bacon, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 22, 'Lanche'],
    ['X-Bacon Egg', 'Pão de Hambúrguer, Hambúrguer, Bacon, Ovo, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 23, 'Lanche'],
    ['X-Calabresa', 'Pão de Hambúrguer, Hambúrguer, Calabresa, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 20, 'Lanche'],
    ['X-Tudo', 'Pão de Hambúrguer, Hambúrguer, Bacon, Calabresa, Salsicha, Ovo, Frango, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 27, 'Lanche'],
    ['X-Esquina', 'Pão de Hambúrguer, Hambúrguer, Frango e Bacon, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 24, 'Lanche'],
    ['X-Power', 'Pão de hambúrguer, Duplo Hambúrguer, Cebola, Tomate, Mussarela, molho Barbecue, Ketchup e maionese.', 22, 'Lanche'],
    ['X-Frango', 'Pão de Hambúrguer, Frango, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 22, 'Lanche'],
    ['X-Frango Burguer', 'Pão de Hambúrguer, Hambúrguer, Frango, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 23.5, 'Lanche'],
    ['X-Americano', 'Pão de Hambúrguer, Ovo, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 16, 'Lanche'],
    ['Hot Dog Simples', 'Pão de hambúrguer, Salsicha, Calabresa, milho, cebola, tomate, Ketchup e maionese.', 17, 'Lanche'],
    ['Hot Dog Especial', 'Pão de hambúrguer, Salsicha, Bacon, Calabresa, milho, tomate, cebola, Ketchup e maionese.', 20, 'Lanche'],
    ['Super Hot Goes', 'Pão de hambúrguer, Duplo Salsicha, Bacon, Calabresa, Mussarela, Catupiry, cebola, tomate, Ketchup e maionese.', 24, 'Lanche'],
    ['Piscina de Cheddar Burger Bacon', 'Duplo Hambúrguer, Duplo Bacon, Mussarela, molho Barbecue e a famosa piscina de cheddar.', 30, 'Lanche'],
    ['Pastel de Carne', 'Carne.', 10, 'Pastel'],
    ['Pastel de Carne com Ovo', 'Carne com ovo.', 12, 'Pastel'],
    ['Pastel de Carne com Mussarela', 'Carne com mussarela.', 12, 'Pastel'],
    ['Pastel de Queijo', 'Queijo.', 12, 'Pastel'],
    ['Pastel Três Queijos', 'Três queijos.', 12, 'Pastel'],
    ['Pastel de Queijo com Tomate', 'Queijo com tomate.', 12, 'Pastel'],
    ['Pastel de Queijo com Milho', 'Queijo com milho.', 12, 'Pastel'],
    ['Pastel de Pizza', 'Pizza.', 12, 'Pastel'],
    ['Pastel de Calabresa com Mussarela', 'Calabresa com mussarela.', 12, 'Pastel'],
    ['Pastel de Calabresa', 'Calabresa.', 10, 'Pastel'],
    ['Pastel de Frango', 'Frango.', 10, 'Pastel'],
    ['Pastel de Frango com Mussarela', 'Frango com mussarela.', 12, 'Pastel'],
    ['Pastel de Frango com Catupiry', 'Frango com catupiry.', 12, 'Pastel'],
    ['Pastel de Frango com Cheddar', 'Frango com cheddar.', 12, 'Pastel'],
    ['Pastel de Strogonoff de Carne', 'Strogonoff de carne.', 13, 'Pastel'],
    ['Pastel de Strogonoff de Frango', 'Strogonoff de frango.', 13, 'Pastel'],
    ['Pastel Brócolis Especial', 'Brócolis, bacon, mussarela, presunto e catupiry.', 13, 'Pastel'],
    ['Pastel Goes', 'Mussarela, presunto, bacon, milho, tomate e orégano.', 13, 'Pastel'],
    ['Pastel Doce de Creme de Avelã', 'Creme de avelã.', 14, 'Pastel'],
    ['Pastel Doce de Leite Ninho', 'Leite Ninho.', 14, 'Pastel'],
    ['Batata Recheada Strogonoff de Carne', `Strogonoff de carne. ${BATATA}`, 30, 'Batata Recheada'],
    ['Batata Recheada Strogonoff de Frango', `Strogonoff de frango. ${BATATA}`, 30, 'Batata Recheada'],
    ['Batata Recheada Brócolis, Mussarela e Bacon', `Brócolis, mussarela e bacon. ${BATATA}`, 30, 'Batata Recheada'],
    ['Batata Recheada Bolonhesa', `Bolonhesa. ${BATATA}`, 25, 'Batata Recheada'],
    ['Batata Recheada Pizza', `Pizza. ${BATATA}`, 25, 'Batata Recheada'],
    ['Batata Recheada Mussarela, Bacon e Milho', `Mussarela, bacon e milho. ${BATATA}`, 25, 'Batata Recheada'],
    ['Batata Recheada Frango com Catupiry', `Frango com catupiry. ${BATATA}`, 25, 'Batata Recheada'],
    ['Batata Recheada Frango com Cheddar', `Frango com cheddar. ${BATATA}`, 25, 'Batata Recheada'],
  ];

  // ----------------------------------------------------------------
  // Dados fictícios (clientes e ~14 dias de pedidos, relativos a hoje)
  // ----------------------------------------------------------------
  const CUSTOMERS = [
    ['Ana Paula Ribeiro', 'Rua das Acácias, 120 - Jardim Primavera'],
    ['Bruno Carvalho', 'Av. Brasil, 845, ap 12 - Centro'],
    ['Camila Duarte', 'Rua dos Ipês, 58 - Vila Nova'],
    ['Diego Fernandes', 'Rua São Benedito, 301 - Jardim das Flores'],
    ['Eduarda Lima', 'Travessa Esperança, 14 - Vila Rica'],
    ['Felipe Moraes', 'Rua Sete de Setembro, 990 - Centro'],
    ['Gabriela Nunes', 'Rua das Palmeiras, 77, casa 2 - Parque Verde'],
    ['Henrique Alves', 'Av. das Nações, 1500, bloco B ap 34 - Jardim América'],
    ['Isabela Rocha', 'Rua Monte Alegre, 210 - Vila Nova'],
    ['João Pedro Martins', 'Rua Quinze de Novembro, 433 - Centro'],
    ['Juliana Costa', 'Rua dos Girassóis, 19 - Jardim Primavera'],
    ['Lucas Teixeira', 'Rua Pedro Álvares Cabral, 640 - Vila Rica'],
    ['Mariana Souza', 'Rua das Hortênsias, 85 - Parque Verde'],
    ['Matheus Pereira', 'Av. Santa Rita, 1120 - Jardim das Flores'],
    ['Natália Gomes', 'Rua Bela Vista, 302 - Alto da Colina'],
    ['Otávio Barros', 'Rua do Comércio, 51 - Centro'],
    ['Patrícia Mendes', 'Rua Tiradentes, 718 - Vila Nova'],
    ['Rafael Azevedo', 'Rua das Orquídeas, 240 - Jardim Primavera'],
    ['Renata Campos', 'Rua Boa Esperança, 66 - Alto da Colina'],
    ['Rodrigo Pinto', 'Av. Independência, 2010 - Jardim América'],
    ['Sabrina Cardoso', 'Rua Santa Luzia, 129 - Parque Verde'],
    ['Thiago Ramos', 'Rua dos Cravos, 37 - Jardim das Flores'],
    ['Vanessa Freitas', 'Rua Rio Branco, 515, ap 8 - Centro'],
    ['Vinícius Araújo', 'Rua das Magnólias, 88 - Vila Rica'],
    ['Larissa Monteiro', 'Rua Nova Aurora, 403 - Alto da Colina'],
    ['Gustavo Rezende', 'Rua São José, 156 - Vila Nova'],
    ['Beatriz Lopes', 'Rua Primavera, 22 - Jardim Primavera'],
    ['Caio Vieira', 'Av. Central, 780 - Centro'],
  ];
  // Volume por dia da semana (segunda … domingo) e peso por hora: picos no almoço e no jantar
  const ORDERS_PER_WEEKDAY = [15, 14, 17, 19, 26, 30, 25];
  const HOUR_WEIGHTS = [[10, 0.6], [11, 3], [12, 6], [13, 4.5], [14, 1.5], [15, 0.7], [16, 0.7], [17, 1.4], [18, 4], [19, 7], [20, 7.5], [21, 5], [22, 2.5], [23, 0.8]];
  const POPULAR = { 'X-Tudo': 6, 'X-Bacon': 5, 'X-Salada Simples': 5, 'X-Burguer': 5, 'Piscina de Cheddar Burger Bacon': 4, 'X-Egg': 3, 'X-Esquina': 3, 'Pastel de Carne': 5, 'Pastel de Queijo': 4, 'Pastel de Frango com Catupiry': 4, 'Pastel de Pizza': 3, 'Batata Recheada Strogonoff de Carne': 3, 'Batata Recheada Frango com Catupiry': 2.5 };
  const ITEM_NOTES = ['sem cebola', 'sem tomate', 'sem milho', 'bem passado', 'caprichar no molho', 'sem maionese'];
  const DELIVERY_NOTES = ['Tocar o interfone', 'Portão azul', 'Deixar na portaria', 'Casa dos fundos', 'Mandar ketchup extra'];
  const PICKUP_NOTES = ['Vou buscar em 20 minutos', 'Mandar ketchup extra', 'Embalar separado'];

  // Gerador pseudoaleatório com semente fixa por dia: duas abas que
  // recriarem os dados ao mesmo tempo chegam exatamente ao mesmo resultado.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function makeRandom(seed) {
    const next = mulberry32(seed);
    const R = {
      next,
      int: (a, b) => a + Math.floor(next() * (b - a + 1)),
      chance: (p) => next() < p,
      pick: (arr) => arr[Math.floor(next() * arr.length)],
      weighted(pairs) {
        const total = pairs.reduce((s, [, w]) => s + w, 0);
        let r = next() * total;
        for (const [v, w] of pairs) if ((r -= w) < 0) return v;
        return pairs[pairs.length - 1][0];
      },
      token: () => Array.from({ length: 24 }, () => TOKEN_CHARS[Math.floor(next() * 64)]).join(''),
    };
    return R;
  }

  // Token como secrets.token_urlsafe(18): 24 caracteres imprevisíveis
  function randomToken() {
    const bytes = new Uint8Array(24);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return Array.from(bytes, (b) => TOKEN_CHARS[b & 63]).join('');
  }

  function buildSeed(now = new Date()) {
    const R = makeRandom(hashStr(`lanche-da-esquina|${dateKey(now)}`));
    const db = {
      schema: SCHEMA,
      seeded_on: dateKey(now),
      seq: { category: 0, product: 0, customer: 0, order: 0 },
      categories: [],
      products: [],
      customers: [],
      orders: [],
      sold_out: [],
      store: { mode: 'auto', closed_message: '' },
      hours: {},
    };

    const catIds = {};
    for (const [name, sortOrder] of CATEGORY_SPECS) {
      const id = ++db.seq.category;
      catIds[name] = id;
      db.categories.push({ id, name, active: true, sort_order: sortOrder });
    }
    for (const [name, description, price, cat] of MENU) {
      db.products.push({ id: ++db.seq.product, name, description, category_id: catIds[cat], price: Math.round(price * 100), image_url: '', active: true });
    }
    const productWeights = db.products.map((p) => [p, POPULAR[p.name] || (p.category_id === catIds['Batata Recheada'] ? 1 : 1.6)]);

    // Clientes: os oito primeiros são "de casa" e pedem com mais frequência
    const people = CUSTOMERS.map(([name, address], i) => ({
      name,
      address,
      phone: `(11) 9${R.int(6000, 9999)}-${String(R.int(0, 9999)).padStart(4, '0')}`,
      weight: i < 8 ? 4 : 1,
    }));
    const customerByPhone = new Map();
    const raw = [];

    function customerFor(person) {
      if (!customerByPhone.has(person.phone)) customerByPhone.set(person.phone, { name: person.name, phone: person.phone, address: person.address, orders: [] });
      return customerByPhone.get(person.phone);
    }

    function randomTimeOn(day) {
      const hour = R.weighted(HOUR_WEIGHTS);
      return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, R.int(0, 59), R.int(0, 59));
    }

    function makeOrder(created, status, opts = {}) {
      const channel = opts.channel || (R.chance(0.2) ? 'presencial' : 'online');
      const orderType = opts.order_type || (channel === 'presencial' ? (R.chance(0.85) ? 'retirada' : 'entrega') : R.chance(0.62) ? 'entrega' : 'retirada');
      let customer;
      if (channel === 'presencial' && orderType === 'retirada' && R.chance(0.5)) {
        // Cliente de balcão que não informou telefone (como no app.py)
        customer = { name: 'Cliente Balcão', phone: `balcao-${created.getTime()}`, address: '', orders: [] };
        customerByPhone.set(customer.phone, customer);
      } else {
        customer = customerFor(R.weighted(people.map((p) => [p, p.weight])));
      }

      const items = [];
      const count = R.weighted([[1, 5], [2, 4], [3, 2], [4, 0.7]]);
      while (items.length < count) {
        const p = R.weighted(productWeights);
        if (items.some((i) => i.product_id === p.id)) continue;
        const quantity = R.chance(0.78) ? 1 : R.chance(0.85) ? 2 : 3;
        const notes = p.category_id === catIds.Lanche && R.chance(0.18) ? R.pick(ITEM_NOTES) : '';
        items.push({ product_id: p.id, name: p.name, quantity, unit_price: p.price, subtotal: p.price * quantity, notes });
      }
      const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
      const fee = orderType === 'entrega' ? DELIVERY_FEE : 0;
      const total = subtotal + fee;
      const payment = R.weighted([['pix', 45], ['cartao', 30], ['dinheiro', 20], ['outro', 5]]);
      const changeFor = payment === 'dinheiro' && R.chance(0.65) ? [2000, 3000, 5000, 10000, 20000].find((v) => v > total) || null : null;
      const notes = R.chance(0.16) ? R.pick(orderType === 'entrega' ? DELIVERY_NOTES : PICKUP_NOTES) : '';

      // Histórico de etapas com intervalos realistas, nunca no futuro
      const steps = orderType === 'entrega' ? STATUS_FLOW : ['novo', 'preparacao', 'pronto', 'finalizado'];
      const gaps = { preparacao: [2, 5], pronto: [10, 18], entrega: [2, 6], finalizado: orderType === 'entrega' ? [10, 22] : [4, 15] };
      const history = [{ old_status: null, new_status: 'novo', changed_at: created }];
      let t = created;
      if (status === 'cancelado') {
        history.push({ old_status: 'novo', new_status: 'cancelado', changed_at: addMinutes(created, R.int(3, 12)) });
      } else {
        const last = steps.indexOf(status);
        for (let i = 1; i <= last; i++) {
          const [a, b] = gaps[steps[i]];
          t = addMinutes(t, R.int(a, b));
          history.push({ old_status: steps[i - 1], new_status: steps[i], changed_at: t });
        }
      }
      const limit = addMinutes(now, -1);
      let floor = created;
      history.forEach((h) => {
        if (h.changed_at > limit) h.changed_at = limit < floor ? floor : limit;
        floor = h.changed_at;
      });
      const lastChange = history[history.length - 1].changed_at;

      const order = {
        customer,
        status,
        order_type: orderType,
        channel,
        address: orderType === 'entrega' ? customer.address : '',
        payment_method: payment,
        change_for: changeFor,
        subtotal,
        delivery_fee: fee,
        total,
        notes,
        created,
        updated_at: lastChange,
        completed_at: status === 'finalizado' ? lastChange : null,
        items,
        history,
      };
      customer.orders.push(order);
      raw.push(order);
      return order;
    }

    // Dias anteriores: tudo concluído, com alguns cancelamentos
    const today = startOfDay(now);
    for (let back = 13; back >= 1; back--) {
      const day = addDays(today, -back);
      const n = ORDERS_PER_WEEKDAY[weekday(day)] + R.int(-3, 3);
      for (let i = 0; i < n; i++) makeOrder(randomTimeOn(day), R.chance(0.04) ? 'cancelado' : 'finalizado');
    }

    // Hoje: o que já passou fica concluído…
    const cutoff = addMinutes(now, -50);
    const todayTimes = [];
    const todayCount = ORDERS_PER_WEEKDAY[weekday(today)] + R.int(-2, 2);
    for (let i = 0; i < todayCount; i++) {
      const t = randomTimeOn(today);
      if (t < cutoff) todayTimes.push(t);
    }
    // …e de manhã cedo, quando quase nada "aconteceu" ainda, completa com alguns pedidos
    const sixAm = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 6, 0, 0);
    if (todayTimes.length < 6 && cutoff - sixAm > 30 * 60000) {
      const missing = 6 - todayTimes.length;
      for (let i = 0; i < missing; i++) todayTimes.push(new Date(sixAm.getTime() + ((i + 0.5) / missing) * (cutoff - sixAm)));
    }
    todayTimes.sort((a, b) => a - b).forEach((t, i) => makeOrder(t, i === 2 ? 'cancelado' : 'finalizado'));

    // …e os últimos minutos preenchem as colunas do Kanban
    [
      [3, 'novo', 'entrega', 'online'],
      [8, 'novo', 'retirada', 'online'],
      [14, 'preparacao', 'entrega', 'online'],
      [19, 'preparacao', 'retirada', 'presencial'],
      [24, 'pronto', 'retirada', 'online'],
      [29, 'pronto', 'entrega', 'online'],
      [35, 'entrega', 'entrega', 'online'],
      [44, 'entrega', 'entrega', 'presencial'],
    ].forEach(([minsAgo, status, orderType, channel]) => {
      const created = addMinutes(now, -minsAgo);
      created.setSeconds(R.int(0, 59));
      makeOrder(created, status, { order_type: orderType, channel });
    });

    // Numeração sequencial por ordem de chegada, como no banco
    raw.sort((a, b) => a.created - b.created);
    raw.forEach((o) => {
      if (o.customer.id === undefined) {
        o.customer.id = ++db.seq.customer;
        db.customers.push({ id: o.customer.id, name: o.customer.name, phone: o.customer.phone, address: o.customer.address, created_at: iso(o.created) });
      }
      db.orders.push({
        id: ++db.seq.order,
        customer_id: o.customer.id,
        status: o.status,
        order_type: o.order_type,
        channel: o.channel,
        address: o.address,
        payment_method: o.payment_method,
        change_for: o.change_for,
        subtotal: o.subtotal,
        delivery_fee: o.delivery_fee,
        total: o.total,
        notes: o.notes,
        created_at: iso(o.created),
        updated_at: iso(o.updated_at),
        completed_at: o.completed_at ? iso(o.completed_at) : null,
        items: o.items,
        history: o.history.map((h) => ({ ...h, changed_at: iso(h.changed_at) })),
        token: R.token(),
      });
    });
    return db;
  }

  // ----------------------------------------------------------------
  // Armazenamento
  // ----------------------------------------------------------------
  let memory = null; // cópia em memória, usada se o localStorage falhar (aba anônima, cota cheia…)
  let storageBroken = false;

  function readDB() {
    let db = null;
    if (!storageBroken) {
      try {
        const raw = localStorage.getItem(DB_KEY);
        if (raw) db = JSON.parse(raw);
      } catch (err) {
        storageBroken = true;
      }
    }
    if (storageBroken) db = memory;
    // Sem dados, versão antiga ou dados de outro dia: recria tudo relativo a hoje,
    // para os gráficos de "hoje" e dos últimos 14 dias nunca ficarem vazios.
    if (!db || db.schema !== SCHEMA || db.seeded_on !== dateKey(new Date())) {
      db = buildSeed();
      writeDB(db);
    }
    memory = db;
    return db;
  }

  function writeDB(db) {
    memory = db;
    if (storageBroken) return;
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(db));
    } catch (err) {
      storageBroken = true;
    }
  }

  // ----------------------------------------------------------------
  // Regras de negócio (espelho do app.py)
  // ----------------------------------------------------------------
  const findCustomer = (db, id) => db.customers.find((c) => c.id === id);
  const findProduct = (db, id) => db.products.find((p) => p.id === id);
  const findCategory = (db, id) => db.categories.find((c) => c.id === id);
  const soldOutIds = (db) => new Set(db.sold_out.filter((s) => s.business_date === businessDate()).map((s) => s.product_id));

  function orderDict(db, o, detailed = false) {
    const c = findCustomer(db, o.customer_id) || { id: o.customer_id, name: '', phone: '', address: '' };
    const data = {
      id: o.id,
      status: o.status,
      status_label: STATUS_LABELS[o.status] || o.status,
      order_type: o.order_type,
      channel: o.channel,
      channel_label: CHANNEL_LABELS[o.channel] || o.channel,
      payment_method: o.payment_method,
      payment_label: PAYMENT_LABELS[o.payment_method] || o.payment_method,
      change_for: o.change_for ? money(o.change_for) : null,
      subtotal: money(o.subtotal),
      delivery_fee: money(o.delivery_fee),
      total: money(o.total),
      notes: o.notes || '',
      address: o.address || '',
      created_at: o.created_at,
      updated_at: o.updated_at || null,
      completed_at: o.completed_at || null,
      customer: { id: c.id, name: c.name, phone: c.phone, address: c.address || '' },
      items: o.items.map((i) => ({ product_id: i.product_id, name: i.name, quantity: i.quantity, unit_price: money(i.unit_price), subtotal: money(i.subtotal), notes: i.notes || '' })),
    };
    if (detailed) {
      data.history = sortedHistory(o).map((h) => ({
        old_status: h.old_status,
        new_status: h.new_status,
        new_status_label: STATUS_LABELS[h.new_status] || h.new_status,
        changed_at: h.changed_at,
      }));
    }
    return data;
  }
  const sortedHistory = (o) => o.history.slice().sort((a, b) => byCodepoint(a.changed_at, b.changed_at));

  // --- Loja aberta/fechada (compute_store_status) ---
  function at(day, hm) {
    const [h, m] = hm.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
  }
  function dayWindow(day, row) {
    if (!row || row.is_closed) return null;
    const start = at(day, row.open_time);
    let end = at(day, row.close_time);
    if (end <= start) end = addDays(end, 1); // atravessa a meia-noite
    return [start, end];
  }
  function whenLabel(moment, now) {
    const days = Math.round((startOfDay(moment) - startOfDay(now)) / 86400000);
    if (days === 0) return `hoje às ${hhmm(moment)}`;
    if (days === 1) return `amanhã às ${hhmm(moment)}`;
    return `${WEEKDAY_LABELS[weekday(moment)].toLowerCase()} às ${hhmm(moment)}`;
  }
  function computeStoreStatus(now, mode, hours) {
    const status = { mode, is_open: true, reason: 'not_configured', closes_at: null, closes_at_label: null, next_open: null, next_open_label: null };
    if (mode === 'open') return { ...status, reason: 'manual_open' };
    if (mode === 'closed') return { ...status, is_open: false, reason: 'manual_closed' };
    if (!Object.keys(hours).length) return status;
    const today = startOfDay(now);
    for (const day of [addDays(today, -1), today]) {
      const w = dayWindow(day, hours[weekday(day)]);
      if (w && w[0] <= now && now < w[1]) return { ...status, reason: 'schedule', closes_at: iso(w[1]), closes_at_label: hhmm(w[1]) };
    }
    Object.assign(status, { is_open: false, reason: 'schedule' });
    for (let offset = 0; offset < 8; offset++) {
      const day = addDays(today, offset);
      const w = dayWindow(day, hours[weekday(day)]);
      if (w && w[0] > now) {
        Object.assign(status, { next_open: iso(w[0]), next_open_label: whenLabel(w[0], now) });
        break;
      }
    }
    return status;
  }
  function storeStatus(db) {
    const mode = STORE_MODES.includes(db.store.mode) ? db.store.mode : 'auto';
    return { ...computeStoreStatus(new Date(), mode, db.hours), message: db.store.closed_message || '' };
  }
  function storeAdminPayload(db) {
    return {
      status: storeStatus(db),
      configured: Object.keys(db.hours).length > 0,
      hours: WEEKDAY_LABELS.map((label, wd) => {
        const h = db.hours[wd];
        return { weekday: wd, label, is_closed: h ? h.is_closed : false, open_time: h ? h.open_time : '18:00', close_time: h ? h.close_time : '23:00' };
      }),
    };
  }

  // --- Pedidos ---
  const joinNames = (names) => {
    const q = names.map((n) => `"${n}"`);
    return q.length === 1 ? q[0] : `${q.slice(0, -1).join(', ')} e ${q[q.length - 1]}`;
  };

  function processOrderItems(db, itemsIn) {
    if (!itemsIn || (Array.isArray(itemsIn) && !itemsIn.length)) throw new ApiError('Adicione pelo menos um produto ao pedido.');
    if (!Array.isArray(itemsIn) || itemsIn.length > 40) throw new ApiError('Pedido com número de itens inválido.');
    let subtotal = 0;
    const prepared = [];
    const unavailable = [];
    const soldOut = soldOutIds(db);
    for (const raw of itemsIn) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('Item de pedido inválido.');
      const product = findProduct(db, toInt(raw.product_id));
      const qty = toInt(raw.quantity);
      if (!product || qty < 1 || qty > 99) throw new ApiError(`Produto indisponível no pedido (id ${raw.product_id}).`);
      if (!product.active || soldOut.has(product.id)) {
        const reason = !product.active ? 'inactive' : 'sold_out';
        if (!unavailable.some((u) => u.product_id === product.id)) unavailable.push({ product_id: product.id, name: product.name, reason });
        continue;
      }
      const notes = str(raw.notes);
      if (notes.length > 255) throw new ApiError('Observação de item muito longa.');
      const itemSubtotal = product.price * qty;
      subtotal += itemSubtotal;
      prepared.push({ product, qty, itemSubtotal, notes });
    }
    if (unavailable.length) {
      const sold = unavailable.filter((i) => i.reason === 'sold_out').map((i) => i.name);
      const gone = unavailable.filter((i) => i.reason === 'inactive').map((i) => i.name);
      const parts = [];
      if (sold.length) parts.push(`${joinNames(sold)} ${sold.length === 1 ? 'esgotou' : 'esgotaram'} hoje`);
      if (gone.length) parts.push(`${joinNames(gone)} não ${gone.length === 1 ? 'está' : 'estão'} mais no cardápio`);
      throw new ApiError(`${parts.join('; ')}. Remova do pedido para continuar.`, 400, { code: 'products_unavailable', unavailable });
    }
    return { subtotal, prepared };
  }

  function parseChangeFor(data, paymentMethod) {
    if (paymentMethod !== 'dinheiro' || !data.change_for) return null;
    const cents = toCents(data.change_for, 'troco');
    if (cents < 0 || cents > 999900) throw new ApiError('Valor de troco inválido.');
    return cents;
  }

  // Valida os campos comuns aos dois tipos de pedido (site e balcão)
  function validateOrderFields({ name, phone, address, notes, orderType, paymentMethod }) {
    if (name.length > 120) throw new ApiError('Nome muito longo.');
    if (phone && phone.length > 30) throw new ApiError('Telefone inválido.');
    if (address.length > 255) throw new ApiError('Endereço muito longo.');
    if (notes.length > 500) throw new ApiError('Observação muito longa (máximo 500 caracteres).');
    if (!ORDER_TYPES.includes(orderType)) throw new ApiError('Tipo de pedido inválido.');
    if (orderType === 'entrega' && !address) throw new ApiError('Informe o endereço para entrega.');
    if (!PAYMENT_METHODS.includes(paymentMethod)) throw new ApiError('Forma de pagamento inválida.');
  }

  function upsertCustomer(db, name, phone, address) {
    const nowIso = iso(new Date());
    let c = db.customers.find((x) => x.phone === phone);
    if (!c) {
      c = { id: ++db.seq.customer, name, phone, address, created_at: nowIso };
      db.customers.push(c);
    } else {
      c.name = name;
      if (address) c.address = address;
    }
    return c;
  }

  function createOrderRecord(db, customer, f, subtotal, prepared, changeFor, channel) {
    const now = iso(new Date());
    const fee = f.orderType === 'entrega' ? DELIVERY_FEE : 0;
    const order = {
      id: ++db.seq.order,
      customer_id: customer.id,
      status: 'novo',
      order_type: f.orderType,
      channel,
      address: f.orderType === 'entrega' ? f.address : '',
      payment_method: f.paymentMethod,
      change_for: changeFor,
      subtotal,
      delivery_fee: fee,
      total: subtotal + fee,
      notes: f.notes,
      created_at: now,
      updated_at: now,
      completed_at: null,
      items: prepared.map(({ product, qty, itemSubtotal, notes }) => ({ product_id: product.id, name: product.name, quantity: qty, unit_price: product.price, subtotal: itemSubtotal, notes })),
      history: [{ old_status: null, new_status: 'novo', changed_at: now }],
      token: randomToken(),
    };
    db.orders.push(order);
    return order;
  }

  // --- Acompanhamento ---
  const TRACK_STEPS = { entrega: ['novo', 'preparacao', 'pronto', 'entrega', 'finalizado'], retirada: ['novo', 'preparacao', 'pronto', 'finalizado'] };
  const TRACK_LABELS = {
    novo: 'Recebemos seu pedido', preparacao: 'Seu pedido está sendo preparado', 'pronto|retirada': 'Pronto para retirada', 'pronto|entrega': 'Pedido pronto',
    entrega: 'Saiu para entrega', 'finalizado|retirada': 'Pedido retirado', 'finalizado|entrega': 'Pedido entregue', cancelado: 'Pedido cancelado',
  };
  const TRACK_HINTS = {
    novo: 'Ele já está na fila da cozinha.', preparacao: 'Estamos preparando tudo com carinho.', 'pronto|retirada': 'Pode vir buscar quando quiser.',
    'pronto|entrega': 'Já já ele sai para entrega.', entrega: 'Logo ele chega até você.', finalizado: 'Obrigado pela preferência. Bom apetite!', cancelado: 'Este pedido não será preparado.',
  };
  const trackText = (table, status, type) => table[`${status}|${type}`] || table[status] || '';
  const firstName = (name) => (name || '').split(/\s+/).filter(Boolean)[0] || '';
  const addressSummary = (address) => (address || '').trim().split(/[,\-–\d]/)[0].trim().slice(0, 60);

  function trackDict(db, o) {
    const status = o.status;
    const keys = TRACK_STEPS[o.order_type] || TRACK_STEPS.entrega;
    const current = status === 'entrega' && o.order_type === 'retirada' ? 'pronto' : status;
    const currentIdx = keys.indexOf(current);
    const reached = {};
    sortedHistory(o).forEach((h) => (reached[h.new_status] = h.changed_at));
    const customer = findCustomer(db, o.customer_id) || {};
    return {
      number: o.id,
      status,
      headline: trackText(TRACK_LABELS, status, o.order_type),
      hint: trackText(TRACK_HINTS, status, o.order_type),
      is_final: status === 'finalizado' || status === 'cancelado',
      is_cancelled: status === 'cancelado',
      cancelled_at: reached.cancelado || null,
      created_at: o.created_at,
      order_type: o.order_type,
      order_type_label: o.order_type === 'entrega' ? 'Entrega' : 'Retirada',
      payment_label: PAYMENT_LABELS[o.payment_method] || o.payment_method,
      change_for: o.change_for ? money(o.change_for) : null,
      customer_first_name: firstName(customer.name),
      address_summary: o.order_type === 'entrega' ? addressSummary(o.address) : '',
      items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: money(i.subtotal) })),
      subtotal: money(o.subtotal),
      delivery_fee: money(o.delivery_fee),
      total: money(o.total),
      steps: keys.map((key, i) => {
        const done = currentIdx >= 0 && i <= currentIdx;
        return { key, label: trackText(TRACK_LABELS, key, o.order_type), done, current: i === currentIdx, at: done ? reached[key] || null : null };
      }),
    };
  }

  // --- Relatórios ---
  function resolvePeriod(period, fromStr, toStr) {
    const today = startOfDay(new Date());
    let start;
    let end;
    if (period === 'hoje') [start, end] = [today, addDays(today, 1)];
    else if (period === 'ontem') [start, end] = [addDays(today, -1), today];
    else if (period === 'semana') {
      start = addDays(today, -(today.getDay())); // domingo como início
      end = addDays(start, 7);
    } else if (period === 'mes') {
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      end = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    } else if (period === 'personalizado') {
      if (!fromStr || !toStr) throw new ApiError('Período personalizado precisa de data inicial e final.');
      start = parseISO(fromStr);
      if (!start) throw new ApiError(`Invalid isoformat string: '${fromStr}'`);
      const to = parseISO(toStr);
      if (!to) throw new ApiError(`Invalid isoformat string: '${toStr}'`);
      end = addDays(to, 1);
    } else throw new ApiError('Período inválido.');
    return [start, end];
  }

  const inRange = (o, startIso, endIso) => o.created_at >= startIso && o.created_at < endIso;

  function summarizePeriod(db, start, end) {
    const [s, e] = [iso(start), iso(end)];
    const orders = db.orders.filter((o) => inRange(o, s, e) && o.status !== 'cancelado');
    const total = orders.reduce((sum, o) => sum + o.total, 0);
    const count = orders.length;
    const byPayment = new Map();
    const byChannel = new Map();
    const byProduct = new Map();
    for (const o of orders) {
      const pay = byPayment.get(o.payment_method) || byPayment.set(o.payment_method, { orders_count: 0, revenue: 0 }).get(o.payment_method);
      pay.orders_count++;
      pay.revenue += o.total;
      const ch = byChannel.get(o.channel) || byChannel.set(o.channel, { orders_count: 0, revenue: 0 }).get(o.channel);
      ch.orders_count++;
      ch.revenue += o.total;
      for (const item of o.items) {
        const prod = byProduct.get(item.name) || byProduct.set(item.name, { quantity: 0, revenue: 0 }).get(item.name);
        prod.quantity += item.quantity;
        prod.revenue += item.subtotal;
      }
    }
    return {
      orders_count: count,
      revenue: money(total),
      average_ticket: count ? Math.round(total / count) / 100 : 0,
      by_payment_method: [...byPayment].map(([k, v]) => ({ payment_method: k, payment_label: PAYMENT_LABELS[k] || k, orders_count: v.orders_count, revenue: money(v.revenue) })),
      by_channel: [...byChannel].map(([k, v]) => ({ channel: k, channel_label: CHANNEL_LABELS[k] || k, orders_count: v.orders_count, revenue: money(v.revenue) })),
      by_product: [...byProduct].map(([k, v]) => ({ product_name: k, quantity: v.quantity, revenue: money(v.revenue) })).sort((a, b) => b.revenue - a.revenue),
    };
  }

  function csvRow(cells) {
    return cells
      .map((c) => {
        const v = String(c ?? '');
        return /[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      })
      .join(';');
  }

  // ----------------------------------------------------------------
  // Rotas
  // ----------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/config$/, ({ db }) => {
    const s = storeStatus(db);
    // Demonstração: a loja aceita pedidos a qualquer hora, independente
    // do modo e do horário configurados no painel.
    return { delivery_fee: money(DELIVERY_FEE), store: { is_open: true, reason: s.reason, message: s.message, next_open: null, next_open_label: null } };
  });

  route('GET', /^\/api\/categories$/, ({ db, query }) => {
    const showAll = query.get('all') === 'true'; // na demo, quem pede "all" é sempre o painel
    return db.categories
      .filter((c) => showAll || c.active)
      .sort((a, b) => a.sort_order - b.sort_order || byCodepoint(a.name, b.name))
      .map((c) => ({ id: c.id, name: c.name, active: c.active, sort_order: c.sort_order }));
  });

  route('POST', /^\/api\/categories$/, ({ db, body }) => {
    const name = str(body.name);
    if (!name) throw new ApiError('Nome é obrigatório.');
    if (db.categories.some((c) => c.name === name)) throw new ApiError('Já existe uma categoria com esse nome.');
    const c = { id: ++db.seq.category, name, active: true, sort_order: Number(body.sort_order) || 0 };
    db.categories.push(c);
    return { status: 201, body: { id: c.id }, save: true };
  });

  route('PUT', /^\/api\/categories\/(\d+)$/, ({ db, body, params }) => {
    const c = findCategory(db, +params[0]);
    if (!c) throw new ApiError('Categoria não encontrada.', 404);
    if ('name' in body && str(body.name)) c.name = str(body.name);
    if ('active' in body) c.active = !!body.active;
    if ('sort_order' in body) c.sort_order = Number(body.sort_order) || 0;
    return { body: { ok: true }, save: true };
  });

  route('GET', /^\/api\/products$/, ({ db, query }) => {
    const showAll = query.get('all') === 'true';
    const soldOut = soldOutIds(db);
    return db.products
      .filter((p) => showAll || p.active)
      .sort((a, b) => (a.category_id ?? -1) - (b.category_id ?? -1) || byCodepoint(a.name, b.name))
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: money(p.price),
        category_id: p.category_id,
        category_name: findCategory(db, p.category_id)?.name ?? null,
        image_url: p.image_url || '',
        active: p.active,
        sold_out: soldOut.has(p.id),
      }));
  });

  route('POST', /^\/api\/products$/, ({ db, body }) => {
    if (!str(body.name)) throw new ApiError('Nome é obrigatório.');
    const price = toCents(body.price, 'preço');
    if (price < 0) throw new ApiError('Preço não pode ser negativo.');
    const p = { id: ++db.seq.product, name: str(body.name), description: str(body.description), price, category_id: Number(body.category_id) || null, image_url: str(body.image_url), active: true };
    db.products.push(p);
    return { status: 201, body: { id: p.id }, save: true };
  });

  route('PUT', /^\/api\/products\/(\d+)$/, ({ db, body, params }) => {
    const p = findProduct(db, +params[0]);
    if (!p) throw new ApiError('Produto não encontrado.', 404);
    if ('name' in body) {
      if (!str(body.name)) throw new ApiError('Nome não pode ficar vazio.');
      p.name = str(body.name);
    }
    if ('description' in body) p.description = str(body.description);
    if ('price' in body) p.price = toCents(body.price, 'preço');
    if ('category_id' in body) p.category_id = Number(body.category_id) || null;
    if ('image_url' in body) p.image_url = str(body.image_url);
    if ('active' in body) p.active = !!body.active;
    return { body: { ok: true }, save: true };
  });

  route('PUT', /^\/api\/products\/(\d+)\/sold-out$/, ({ db, body, params }) => {
    const pid = +params[0];
    if (!findProduct(db, pid)) throw new ApiError('Produto não encontrado.', 404);
    if (typeof body.sold_out !== 'boolean') throw new ApiError('Informe sold_out como true ou false.');
    const day = businessDate();
    const idx = db.sold_out.findIndex((s) => s.product_id === pid && s.business_date === day);
    if (body.sold_out && idx < 0) db.sold_out.push({ product_id: pid, business_date: day });
    else if (!body.sold_out && idx >= 0) db.sold_out.splice(idx, 1);
    // Marcações de dias anteriores não servem para mais nada
    db.sold_out = db.sold_out.filter((s) => s.business_date === day);
    return { body: { ok: true, sold_out: body.sold_out, business_date: day }, save: true };
  });

  route('POST', /^\/api\/orders$/, ({ db, body }) => {
    // Na demo a loja nunca recusa pedido por estar fechada (ver /api/config)
    const f = {
      name: str(body.name),
      phone: str(body.phone),
      orderType: body.order_type,
      paymentMethod: body.payment_method,
      address: str(body.address),
      notes: str(body.notes),
    };
    if (!f.name || !f.phone) throw new ApiError('Preencha seu nome e telefone.');
    validateOrderFields(f);
    const { subtotal, prepared } = processOrderItems(db, body.items || []);
    const changeFor = parseChangeFor(body, f.paymentMethod);
    const customer = upsertCustomer(db, f.name, f.phone, f.address);
    const order = createOrderRecord(db, customer, f, subtotal, prepared, changeFor, 'online');
    return {
      status: 201,
      body: { order: orderDict(db, order), message: 'Pedido recebido com sucesso!', tracking_token: order.token, tracking_url: `acompanhar?t=${encodeURIComponent(order.token)}` },
      save: true,
    };
  });

  route('POST', /^\/api\/orders\/presencial$/, ({ db, body }) => {
    const f = {
      name: str(body.name) || 'Cliente Balcão',
      phone: str(body.phone),
      orderType: body.order_type || 'retirada',
      paymentMethod: body.payment_method,
      address: str(body.address),
      notes: str(body.notes),
    };
    validateOrderFields(f);
    const { subtotal, prepared } = processOrderItems(db, body.items || []);
    const changeFor = parseChangeFor(body, f.paymentMethod);
    let customer;
    if (f.phone) customer = upsertCustomer(db, f.name, f.phone, f.address);
    else {
      // Balcão sem telefone: identificador interno, nunca um telefone de verdade
      customer = { id: ++db.seq.customer, name: f.name, phone: `balcao-${Date.now()}`, address: f.address, created_at: iso(new Date()) };
      db.customers.push(customer);
    }
    const order = createOrderRecord(db, customer, f, subtotal, prepared, changeFor, 'presencial');
    return { status: 201, body: { order: orderDict(db, order), message: 'Pedido registrado!' }, save: true };
  });

  route('GET', /^\/api\/orders$/, ({ db, query }) => {
    let list = db.orders.slice();
    const q = (k) => query.get(k);
    if (q('status')) list = list.filter((o) => o.status === q('status'));
    if (q('order_type')) list = list.filter((o) => o.order_type === q('order_type'));
    if (q('channel')) list = list.filter((o) => o.channel === q('channel'));
    if (q('payment_method')) list = list.filter((o) => o.payment_method === q('payment_method'));
    if (q('from')) {
      const d = parseISO(q('from'));
      if (!d) throw new ApiError('Data inicial inválida.');
      list = list.filter((o) => o.created_at >= iso(d));
    }
    if (q('to')) {
      const d = parseISO(q('to'));
      if (!d) throw new ApiError('Data final inválida.');
      list = list.filter((o) => o.created_at < iso(addDays(d, 1)));
    }
    const customerOf = (o) => findCustomer(db, o.customer_id) || {};
    if (q('customer')) list = list.filter((o) => ilike(customerOf(o).name, q('customer')) || ilike(customerOf(o).phone, q('customer')));
    if (q('q')) {
      const s = q('q');
      list = list.filter((o) => ilike(customerOf(o).name, s) || ilike(customerOf(o).phone, s) || (/^\d+$/.test(s) && o.id === parseInt(s, 10)));
    }
    if (q('product')) list = list.filter((o) => o.items.some((i) => ilike(i.name, q('product'))));
    return list
      .sort((a, b) => byCodepoint(b.created_at, a.created_at) || b.id - a.id)
      .slice(0, 500)
      .map((o) => orderDict(db, o));
  });

  route('GET', /^\/api\/orders\/(\d+)$/, ({ db, params }) => {
    const o = db.orders.find((x) => x.id === +params[0]);
    if (!o) throw new ApiError('Pedido não encontrado.', 404);
    return orderDict(db, o, true);
  });

  route('PUT', /^\/api\/orders\/(\d+)\/status$/, ({ db, body, params }) => {
    const newStatus = body.status;
    if (!ALL_STATUSES.includes(newStatus)) throw new ApiError('Status inválido.');
    const o = db.orders.find((x) => x.id === +params[0]);
    if (!o) throw new ApiError('Pedido não encontrado.', 404);
    if (o.status === newStatus) return orderDict(db, o, true);
    const now = iso(new Date());
    o.history.push({ old_status: o.status, new_status: newStatus, changed_at: now });
    o.status = newStatus;
    o.updated_at = now;
    if (newStatus === 'finalizado') o.completed_at = now;
    return { body: orderDict(db, o, true), save: true };
  });

  route('GET', /^\/api\/track\/([^/]*)$/, ({ db, params }) => {
    const token = decodeURIComponent(params[0]);
    const o = TOKEN_RE.test(token) ? db.orders.find((x) => x.token === token) : null;
    if (!o) throw new ApiError('Pedido não encontrado.', 404);
    return trackDict(db, o);
  });

  route('GET', /^\/api\/store$/, ({ db }) => storeAdminPayload(db));

  route('PUT', /^\/api\/store\/mode$/, ({ db, body }) => {
    if ('mode' in body) {
      if (!STORE_MODES.includes(body.mode)) throw new ApiError('Modo inválido.');
      db.store.mode = body.mode;
    }
    if ('message' in body) {
      const message = str(body.message);
      if (message.length > 160) throw new ApiError('Mensagem muito longa (máximo 160 caracteres).');
      db.store.closed_message = message;
    }
    return { body: storeAdminPayload(db), save: true };
  });

  route('PUT', /^\/api\/store\/hours$/, ({ db, body }) => {
    const days = body.hours;
    if (!Array.isArray(days) || days.length !== 7) throw new ApiError('Envie o horário dos 7 dias da semana.');
    const parsed = {};
    for (const day of days) {
      if (!day || typeof day !== 'object') throw new ApiError('Horário inválido.');
      const wd = day.weekday;
      if (!Number.isInteger(wd) || wd < 0 || wd > 6 || wd in parsed) throw new ApiError('Dia da semana inválido.');
      const isClosed = !!day.is_closed;
      let open = String(day.open_time || '');
      let close = String(day.close_time || '');
      if (!isClosed) {
        if (!HHMM.test(open) || !HHMM.test(close)) throw new ApiError(`${WEEKDAY_LABELS[wd]}: informe abertura e fechamento (HH:MM).`, 400, { weekday: wd });
        if (open === close) throw new ApiError(`${WEEKDAY_LABELS[wd]}: abertura e fechamento não podem ser iguais.`, 400, { weekday: wd });
      } else {
        open = HHMM.test(open) ? open : '18:00';
        close = HHMM.test(close) ? close : '23:00';
      }
      parsed[wd] = { is_closed: isClosed, open_time: open, close_time: close };
    }
    db.hours = parsed;
    return { body: storeAdminPayload(db), save: true };
  });

  route('POST', /^\/api\/account\/password$/, () => {
    throw new ApiError('Indisponível na versão de demonstração.', 403);
  });

  route('GET', /^\/api\/customers$/, ({ db, query }) => {
    const search = query.get('q');
    return db.customers
      .filter((c) => !search || ilike(c.name, search) || ilike(c.phone, search))
      .map((c) => {
        const orders = db.orders.filter((o) => o.customer_id === c.id);
        const dates = orders.map((o) => o.created_at).sort(byCodepoint);
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          address: c.address || '',
          orders_count: orders.length,
          total_spent: money(orders.filter((o) => o.status !== 'cancelado').reduce((s, o) => s + o.total, 0)),
          first_order_at: dates[0] || null,
          last_order_at: dates[dates.length - 1] || null,
        };
      })
      .sort((a, b) => byCodepoint(b.last_order_at || '', a.last_order_at || ''));
  });

  route('GET', /^\/api\/dashboard$/, ({ db }) => {
    const today = startOfDay(new Date());
    const [todayIso, tomorrowIso] = [iso(today), iso(addDays(today, 1))];
    const revenueByDay = [];
    for (let i = 13; i >= 0; i--) {
      const dayStart = addDays(today, -i);
      const dayOrders = db.orders.filter((o) => inRange(o, iso(dayStart), iso(addDays(dayStart, 1))) && o.status !== 'cancelado');
      revenueByDay.push({ day: `${pad(dayStart.getDate())}/${pad(dayStart.getMonth() + 1)}`, revenue: money(dayOrders.reduce((s, o) => s + o.total, 0)), orders_count: dayOrders.length });
    }
    const since = iso(addDays(today, -29));
    const productQty = new Map();
    db.orders
      .filter((o) => o.created_at >= since && o.status !== 'cancelado')
      .forEach((o) => o.items.forEach((i) => productQty.set(i.name, (productQty.get(i.name) || 0) + i.quantity)));
    const hours = Array.from({ length: 24 }, () => 0);
    db.orders.filter((o) => inRange(o, todayIso, tomorrowIso)).forEach((o) => hours[+o.created_at.slice(11, 13)]++);
    return {
      today: summarizePeriod(db, today, addDays(today, 1)),
      open_orders: db.orders.filter((o) => ['novo', 'preparacao', 'pronto', 'entrega'].includes(o.status)).length,
      revenue_by_day: revenueByDay,
      top_products: [...productQty].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, quantity]) => ({ name, quantity })),
      orders_by_hour: hours.map((count, hour) => ({ hour, orders_count: count })),
    };
  });

  route('GET', /^\/api\/closing$/, ({ db, query }) => {
    const period = query.get('period') || 'hoje';
    const [start, end] = resolvePeriod(period, query.get('from'), query.get('to'));
    const current = summarizePeriod(db, start, end);
    const duration = end - start;
    const previous = summarizePeriod(db, new Date(start.getTime() - duration), start);
    const pct = (curr, prior) => (prior === 0 ? null : round1(((curr - prior) / prior) * 100));
    return {
      period,
      range: { start: iso(start), end: iso(end) },
      current,
      previous,
      comparison: {
        revenue_change_pct: pct(current.revenue, previous.revenue),
        orders_change_pct: pct(current.orders_count, previous.orders_count),
        ticket_change_pct: pct(current.average_ticket, previous.average_ticket),
      },
    };
  });

  // CSV gerado no próprio navegador, no mesmo formato do Flask
  // (separador ";" e vírgula decimal, para abrir direto no Excel em português)
  route('GET', /^\/api\/closing\/export$/, ({ db, query }) => {
    const period = query.get('period') || 'hoje';
    const [start, end] = resolvePeriod(period, query.get('from'), query.get('to'));
    const current = summarizePeriod(db, start, end);
    const fmt = (v) => v.toFixed(2).replace('.', ',');
    const br = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    const rows = [
      [`Fechamento — ${STORE_NAME}`],
      ['Período', `${br(start)} a ${br(addDays(end, -1))}`],
      [],
      ['Faturamento total', fmt(current.revenue)],
      ['Quantidade de pedidos', current.orders_count],
      ['Ticket médio', fmt(current.average_ticket)],
      [],
      ['Forma de pagamento', 'Pedidos', 'Faturamento'],
      ...current.by_payment_method.map((p) => [p.payment_label, p.orders_count, fmt(p.revenue)]),
      [],
      ['Produto', 'Quantidade', 'Faturamento'],
      ...current.by_product.map((p) => [p.product_name, p.quantity, fmt(p.revenue)]),
    ];
    const csv = '﻿' + rows.map(csvRow).join('\r\n') + '\r\n';
    const n = new Date();
    const filename = `fechamento_${period}_${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}_${pad(n.getHours())}${pad(n.getMinutes())}.csv`;
    return { raw: csv, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename=${filename}` } };
  });

  // ----------------------------------------------------------------
  // Despacho
  // ----------------------------------------------------------------
  function jsonResponse(status, body, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
  }

  function parseBody(body) {
    if (typeof body !== 'string' || !body) return {};
    try {
      const data = JSON.parse(body);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (err) {
      return {}; // get_json(silent=True) or {}
    }
  }

  function handle(method, url, rawBody) {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const matching = routes.filter((r) => r.pattern.test(path));
    const r = matching.find((x) => x.method === method);
    if (!r) {
      return matching.length
        ? jsonResponse(405, { error: 'Método não permitido.' })
        : jsonResponse(404, { error: 'Não encontrado.' });
    }
    try {
      const db = readDB();
      const result = r.handler({ db, query: url.searchParams, body: parseBody(rawBody), params: r.pattern.exec(path).slice(1) });
      const wrapped = result && (result.body !== undefined || result.raw !== undefined) ? result : { body: result };
      if (wrapped.save) writeDB(db);
      if (wrapped.raw !== undefined) return new Response(wrapped.raw, { status: wrapped.status || 200, headers: wrapped.headers });
      return jsonResponse(wrapped.status || 200, wrapped.body);
    } catch (err) {
      if (err instanceof ApiError) return jsonResponse(err.status, { error: err.message, ...err.extra });
      console.error('[demo] erro na API simulada', err);
      return jsonResponse(500, { error: 'Algo deu errado na demonstração. Tente “Reiniciar demo”.' });
    }
  }

  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  const latency = () => 150 + Math.round(Math.random() * 150);

  window.fetch = function demoFetch(input, init) {
    let url;
    let method = 'GET';
    try {
      const isRequest = typeof Request !== 'undefined' && input instanceof Request;
      url = new URL(isRequest ? input.url : String(input), window.location.href);
      method = String((init && init.method) || (isRequest ? input.method : 'GET')).toUpperCase();
    } catch (err) {
      url = null;
    }
    if (!url || url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
      return realFetch ? realFetch(input, init) : Promise.reject(new TypeError('fetch indisponível'));
    }
    const body = init && init.body;
    return new Promise((resolve) => setTimeout(() => resolve(handle(method, url, body)), latency()));
  };

  // Outra aba alterou os dados (ou reiniciou a demo): avisa a página
  window.addEventListener('storage', (e) => {
    if (e.key !== DB_KEY && e.key !== null) return;
    memory = null;
    window.dispatchEvent(new CustomEvent('demo:datachange'));
  });

  window.DemoAPI = {
    storageKey: DB_KEY,
    reset() {
      memory = null;
      try {
        localStorage.clear();
      } catch (err) {
        // armazenamento indisponível: a recarga já recria os dados em memória
      }
    },
  };
})();
