# Lanchonete MVP

Sistema de pedidos para uma lanchonete de bairro: cardápio público para o
cliente + painel administrativo (Kanban de pedidos, produtos, categorias,
clientes, histórico e relatórios de faturamento).

**Stack:** HTML + CSS + JavaScript puro no front-end, Python (Flask +
SQLAlchemy) no back-end, banco SQLite por padrão (arquivo local, zero
configuração).

---

## 1. Instalação

### Pré-requisito
Python 3.10 ou mais recente.

### Passo a passo

```bash
# 1. Entre na pasta do projeto
cd lanchonete_mvp

# 2. Crie um ambiente virtual
python -m venv .venv

# 3. Ative o ambiente virtual
source .venv/bin/activate        # Linux/Mac
.venv\Scripts\activate           # Windows

# 4. Instale as dependências
pip install -r requirements.txt

# 5. Copie o arquivo de variáveis de ambiente
cp .env.example .env             # Windows: copy .env.example .env

# 6. Crie o banco com dados de demonstração (categorias, produtos,
#    clientes e pedidos de exemplo)
flask --app app.py seed

# 7. Rode o servidor
python app.py
```

Acesse:
- **Cliente:** http://localhost:5000
- **Painel administrativo:** http://localhost:5000/admin

Login do painel (criado pelo seed, definido no `.env`):
```
E-mail: dona@lanchonete.com
Senha:  lanchonete123
```

> Troque a senha em produção editando `ADMIN_PASSWORD` no `.env` **antes**
> de rodar o `seed` (o seed só cria o administrador na primeira vez).
> Para recomeçar do zero, apague o arquivo `instance/lanchonete.db` e
> rode o `seed` novamente.

---

## 2. Estrutura de pastas

```
lanchonete_mvp/
├── app.py                 # Backend: modelos, rotas da API, autenticação, seed
├── requirements.txt        # Dependências Python
├── .env.example             # Modelo de variáveis de ambiente
├── instance/
│   └── lanchonete.db        # Banco SQLite (criado automaticamente, não versionar)
├── templates/                # Páginas HTML renderizadas pelo Flask
│   ├── customer.html          # Cardápio + carrinho + checkout (tela do cliente)
│   ├── admin.html              # Painel: Kanban, Painel, Fechamento, Produtos, Clientes, Histórico
│   └── login.html               # Login do painel
└── static/
    ├── css/style.css          # Estilo de todo o sistema
    └── js/
        ├── customer.js         # Lógica da tela do cliente (carrinho, checkout)
        └── admin.js             # Lógica do painel (todas as abas)
```

Tudo roda em um único processo Flask: as rotas que começam com `/api/`
devolvem JSON (consumido pelo JavaScript do front-end); as demais rotas
devolvem HTML renderizado pelo servidor.

---

## 3. Cardápio (dados de demonstração)

O `seed` cria 5 categorias, nesta ordem:

| Categoria         | Exemplos de itens                                              |
|-------------------|------------------------------------------------------------------|
| Lanche             | X-Burger, X-Salada, X-Bacon, X-Egg, X-Tudo, Misto Quente         |
| Pastel             | Carne, Queijo, Frango c/ Catupiry, Pizza, Doce de Chocolate      |
| Porção             | Batata Frita (P/G), Frango a Passarinho, Calabresa, Anéis de Cebola |
| Batata Recheada    | Bacon e Cheddar, Calabresa, Frango c/ Catupiry, Completa          |
| Bebidas            | Refrigerante, Suco Natural, Água Mineral                          |

Você pode editar, desativar ou criar novos produtos e categorias direto
pelo painel (aba **Produtos**) — nenhuma edição de código é necessária
no dia a dia.

---

## 4. Funcionalidades

**Cliente**
- Cardápio por categoria, carrinho com observações por item
- Checkout com entrega ou retirada, 4 formas de pagamento (Pix, dinheiro
  com opção de troco, cartão, outro)
- Endereço obrigatório apenas quando o pedido é para entrega
- **Acompanhamento do pedido** em `/acompanhar/<token>` (link aleatório,
  nunca o número do pedido), com linha do tempo que se atualiza sozinha
  a cada 25 s. O cardápio mostra um atalho para pedidos em andamento
- **Loja fechada:** o cardápio continua visível, com aviso do próximo
  horário de abertura; adicionar e enviar ficam bloqueados
- **Esgotado hoje:** o produto aparece atenuado, com selo, e não pode ser
  pedido

**Painel administrativo**
- **Loja aberta/fechada:** indicador no cabeçalho; dois toques fecham a
  loja. Modos: seguir o horário, aberta ou fechada manualmente, com
  recado opcional. Pedidos de balcão continuam liberados com a loja
  fechada. Sem horário configurado, a loja fica sempre aberta
- **Ajustes:** horário de funcionamento por dia da semana (pode passar da
  meia-noite, ex.: 18:00 às 00:30) e **Minha conta** (troca de senha)
- **Esgotado hoje:** botão de um toque na lista de produtos e filtro
  "Esgotados hoje". Vale até as 5h do dia seguinte e volta sozinho
- **Pedidos:** Kanban (Novo → Em preparação → Pronto → Em entrega →
  Finalizado), arraste para mudar de coluna ou toque no card para ver
  detalhes e mudar o status pelos botões
- **Novo pedido (balcão/telefone):** botão "+ Novo pedido" na aba
  Pedidos — para quem atende no balcão ou por telefone registrar o
  pedido na hora, com o mesmo cardápio e cálculo de preço do site.
  Telefone do cliente é opcional aqui. Esses pedidos entram no Kanban,
  no histórico e nos relatórios normalmente, marcados como "Balcão"
  para diferenciar dos pedidos feitos pelo próprio cliente ("Site")
- **Painel:** faturamento dos últimos 14 dias, produtos mais vendidos,
  pedidos por horário, formas de pagamento do dia
- **Fechamento:** hoje / ontem / semana / mês / período personalizado,
  com comparação percentual em relação ao período anterior, e
  faturamento separado por canal (Site vs Balcão)
- **Produtos:** criar, editar, ativar/desativar (o histórico de pedidos
  antigos nunca é afetado) e gerenciar categorias
- **Clientes:** identificados automaticamente pelo telefone, com total
  gasto e histórico de pedidos
- **Histórico:** todos os pedidos (inclusive cancelados), com filtros por
  status, tipo, pagamento, produto, cliente, canal e período

## 5. Segurança

Este projeto passou por uma revisão de segurança completa. O que já está
implementado:

- **Senhas com hash** (nunca em texto puro) usando `werkzeug.security`
- **Proteção contra XSS armazenado:** todo texto vindo de clientes (nome,
  telefone, endereço, observações) é escapado antes de aparecer no painel
- **Taxa de entrega definida só pelo servidor** (variável `DELIVERY_FEE`)
  — o cliente nunca pode alterar esse valor pela requisição
- **Limite de tentativas de login** (10/min por IP) contra força bruta
- **Limite de pedidos por IP** (12/min) contra spam/flood no cardápio público
- **Limite de tamanho de campos e de itens por pedido**, e limite de
  tamanho de requisição (512 KB), contra abuso e sobrecarga
- **Cabeçalhos de segurança HTTP** (CSP, X-Frame-Options, nosniff, HSTS
  em produção) e **cookie de sessão protegido** (Secure/HttpOnly/SameSite)
- **Aviso de uso de dados** exibido ao cliente no checkout
- **Log de tentativas de login** (sucesso e falha, com IP) para auditoria
- **Produção por padrão:** só é modo de desenvolvimento quando
  `FLASK_DEBUG=true` estiver definido explicitamente. Sem a variável, o
  sistema assume produção (cookie `Secure`, HSTS, avisos de senha padrão).
  No Render (variável `RENDER`, definida automaticamente) é sempre produção
- **IP real do cliente atrás do proxy do Render** (`ProxyFix` com um único
  salto confiável), para que os limites de requisição sejam por cliente
- **Conexões resistentes a ociosidade** (`pool_pre_ping` e `pool_recycle`)
  com o pooler do Supabase
- Aviso automático no console se `SECRET_KEY` ou `ADMIN_PASSWORD` ainda
  estiverem com o valor de exemplo em produção

**Antes de publicar o site de verdade, você ainda precisa:**
1. Definir `FLASK_DEBUG=false` no `.env` de produção (nunca deixe `true`
   fora do seu computador — o modo debug expõe um console que permite
   rodar código no servidor)
2. Trocar `SECRET_KEY` e `ADMIN_PASSWORD` por valores próprios
3. Rodar atrás de HTTPS (qualquer serviço de hospedagem moderno oferece
   isso de graça — Railway, Render, PythonAnywhere, etc.)
4. Usar um servidor de produção em vez do `python app.py`:
   ```bash
   gunicorn -w 2 -b 0.0.0.0:5000 app:app
   ```
   (o `gunicorn` já está no `requirements.txt`)
5. Fazer backup periódico do arquivo `instance/lanchonete.db`

## 6. Estrutura de dados

Tabelas: `customer`, `category`, `product`, `order`, `order_item` e
`order_status_history`. Cada item de pedido guarda uma "fotografia" do
nome e do preço do produto no momento da venda (`product_name_snapshot`,
`unit_price`), então renomear ou reprecificar um produto nunca altera
pedidos antigos — importante para relatórios e para uma futura análise
de dados.

Tabelas da v10 (criadas automaticamente na primeira requisição depois do
deploy, sem tocar nas tabelas acima): `store_settings` (modo da loja e
recado), `store_hours` (horário por dia da semana), `order_tracking`
(token público de acompanhamento por pedido) e `product_sold_out`
(produto esgotado por dia operacional). No PostgreSQL, uma trava
(`pg_advisory_xact_lock`) evita que dois workers criem as tabelas ao
mesmo tempo.

## Testes

Os testes usam sempre um SQLite temporário (nunca o `DATABASE_URL` do
`.env`):

```bash
pip install -r requirements-dev.txt
python -m pytest tests
```

## 7. Próximos passos sugeridos

- Trocar o SQLite por PostgreSQL/MySQL quando o volume de pedidos crescer
  (basta definir `DATABASE_URL` no `.env`)
- Adicionar fotos reais dos produtos (campo `image_url` já existe)
- Exportar relatórios de fechamento em PDF além do CSV atual
- Taxa de entrega por bairro (hoje é um valor fixo em `DELIVERY_FEE`)
- Integração futura com WhatsApp/iFood (fora do escopo deste MVP)

## v5 — Cardápio e horário

- Cardápio atualizado com os lanches do Cantinho Santos.
- Pastéis atualizados conforme o cardápio informado, com pastéis doces separados visualmente no fim da categoria.
- Batatas recheadas atualizadas com preços e descrições.
- Horários do sistema ajustados para o fuso `America/Sao_Paulo`.
- Em bancos SQLite existentes do v4, a primeira execução do v5 corrige uma única vez os horários antigos gravados em UTC. Essa correção **nunca roda em PostgreSQL** (Supabase): o marcador dela fica em disco, e o disco do Render é apagado a cada deploy.
- O comando `seed` agora sincroniza o cardápio sem apagar pedidos existentes; produtos antigos ficam inativos para preservar o histórico.
