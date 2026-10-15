"""
Lanchonete MVP — backend Flask + SQLAlchemy (SQLite por padrão).

Este arquivo concentra: modelos de dados, autenticação do painel,
rotas públicas (cardápio + criação de pedido) e rotas administrativas
(pedidos/kanban, produtos, categorias, clientes, histórico e relatórios).

Pensado para ser simples de rodar localmente e, ao mesmo tempo, manter
uma estrutura de dados que sirva de base para análises de Ciência de
Dados no futuro (ver README.md).
"""
import os
import re
import secrets
import csv
import io
import logging
from datetime import datetime, timedelta, timezone
try:
    from zoneinfo import ZoneInfo
except ImportError:
    ZoneInfo = None
from decimal import Decimal, InvalidOperation
from functools import wraps

from dotenv import load_dotenv
from flask import Flask, render_template, request, jsonify, session, redirect, url_for, Response
from flask_sqlalchemy import SQLAlchemy
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import generate_password_hash, check_password_hash

load_dotenv()

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger('cantinho_santos')

# Horário oficial do sistema: Brasil (São Paulo). Mantemos os datetimes
# sem timezone no banco para preservar compatibilidade com o SQLite/MySQL
# atual, mas sempre geramos/consultamos usando o horário local correto.
# São Paulo usa UTC-3 atualmente. O fallback evita depender do pacote
# tzdata, que pode não vir instalado em algumas instalações do Windows/Python.
try:
    LOCAL_TZ = ZoneInfo('America/Sao_Paulo') if ZoneInfo else timezone(timedelta(hours=-3))
except Exception:
    LOCAL_TZ = timezone(timedelta(hours=-3))

def now_local():
    return datetime.now(LOCAL_TZ).replace(tzinfo=None)

# ---------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------
app = Flask(__name__)
# No Render, toda requisição passa por exatamente um proxy (o balanceador
# deles), que acrescenta o IP real do cliente ao fim do X-Forwarded-For e
# informa o protocolo original em X-Forwarded-Proto. Confiamos em apenas
# UM salto: o ProxyFix lê só a última entrada do cabeçalho (a que o Render
# acrescentou), então um cliente não consegue falsificar o próprio IP
# enviando um X-Forwarded-For forjado. Sem isso, o Flask-Limiter veria o
# IP do proxy e todos os clientes dividiriam o mesmo limite.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-secret-change-me')

# Modo produção é o PADRÃO: só é desenvolvimento quando FLASK_DEBUG=true for
# definido explicitamente (como no .env local). Se a variável estiver ausente,
# as proteções continuam ligadas. Dentro do Render (que define a variável
# RENDER automaticamente) é sempre produção, mesmo que FLASK_DEBUG=true tenha
# sido cadastrado por engano. Em produção: cookie de sessão só trafega por
# HTTPS, HSTS ligado, e alertamos no log se alguém esqueceu de trocar os
# valores padrão de segredo/senha antes de publicar o site de verdade.
DEBUG_REQUESTED = os.getenv('FLASK_DEBUG', 'false').strip().lower() == 'true'
IS_PRODUCTION = bool(os.getenv('RENDER')) or not DEBUG_REQUESTED
app.config['SESSION_COOKIE_SECURE'] = IS_PRODUCTION
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['MAX_CONTENT_LENGTH'] = 512 * 1024  # 512 KB — nenhuma rota deste app precisa de mais que isso

if IS_PRODUCTION:
    if app.config['SECRET_KEY'] == 'dev-secret-change-me':
        logger.warning(
            'ATENÇÃO: SECRET_KEY ainda é o valor de exemplo. Defina uma chave própria no .env antes de expor o site.'
        )
    if os.getenv('ADMIN_PASSWORD', 'lanchonete123') == 'lanchonete123':
        logger.warning(
            'ATENÇÃO: ADMIN_PASSWORD ainda é o valor de exemplo. Troque a senha do painel antes de expor o site.'
        )

# Taxa de entrega: decidida pela loja, nunca pelo cliente. O formulário
# público nunca deve conseguir alterar quanto o pedido custa além do
# valor real dos produtos.
DELIVERY_FEE = Decimal(os.getenv('DELIVERY_FEE', '5.00'))

limiter = Limiter(
    get_remote_address,
    app=app,
    storage_uri='memory://',
    default_limits=[],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, 'instance')
os.makedirs(INSTANCE_DIR, exist_ok=True)

DB_URL = os.getenv('DATABASE_URL') or 'sqlite:///' + os.path.join(
    INSTANCE_DIR, 'lanchonete.db'
).replace('\\', '/')
# Supabase normalmente fornece uma URL iniciada por postgresql://.
# Com Psycopg 3, SQLAlchemy usa explicitamente o driver postgresql+psycopg.
if DB_URL.startswith('postgres://'):
    DB_URL = 'postgresql+psycopg://' + DB_URL[len('postgres://'):]
elif DB_URL.startswith('postgresql://'):
    DB_URL = 'postgresql+psycopg://' + DB_URL[len('postgresql://'):]
app.config['SQLALCHEMY_DATABASE_URI'] = DB_URL
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# O pooler do Supabase (e qualquer firewall no caminho) derruba conexões
# ociosas. pool_pre_ping testa a conexão antes de usá-la e reconecta se ela
# tiver caído; pool_recycle descarta conexões com mais de 5 minutos antes que
# o servidor as feche. Ambas as opções funcionam também com SQLite local.
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'pool_pre_ping': True, 'pool_recycle': 300}

db = SQLAlchemy(app)

_TIMEZONE_MIGRATION_MARKER = os.path.join(INSTANCE_DIR, '.v5_timezone_fixed')
_timezone_migration_checked = False

def migrate_v4_utc_timestamps_once():
    """Corrige uma vez os horários gravados em UTC pelo v4 para o horário local de São Paulo.

    O v4 usava datetime.utcnow() em campos sem timezone. O v5 passa a gravar
    diretamente no horário de São Paulo; por isso, somente os registros
    existentes antes desta migração precisam voltar 3 horas.

    Só existe banco v4 em SQLite local. Em qualquer outro banco (PostgreSQL
    no Supabase) ela NUNCA roda: o marcador fica em disco, e o disco do
    Render é apagado a cada deploy/reinício — sem esta trava, cada subida
    do servidor voltaria todas as datas de produção mais 3 horas.
    """
    global _timezone_migration_checked
    if _timezone_migration_checked or os.path.exists(_TIMEZONE_MIGRATION_MARKER):
        _timezone_migration_checked = True
        return
    if db.engine.dialect.name != 'sqlite':
        _timezone_migration_checked = True
        return
    try:
        db.create_all()
        delta = timedelta(hours=3)
        for model, fields in [
            (Admin, ['created_at']),
            (Customer, ['created_at', 'updated_at']),
            (Product, ['created_at', 'updated_at']),
            (Order, ['created_at', 'updated_at', 'completed_at']),
            (OrderStatusHistory, ['changed_at']),
        ]:
            for row in model.query.all():
                changed = False
                for field in fields:
                    value = getattr(row, field, None)
                    if value is not None:
                        setattr(row, field, value - delta)
                        changed = True
                if changed:
                    db.session.add(row)
        db.session.commit()
        with open(_TIMEZONE_MIGRATION_MARKER, 'w', encoding='utf-8') as f:
            f.write('v5 timezone migration completed')
    except Exception:
        db.session.rollback()
        raise
    finally:
        _timezone_migration_checked = True


_CHANNEL_MIGRATION_MARKER = os.path.join(INSTANCE_DIR, '.v7_channel_added')
_channel_migration_checked = False

def migrate_v6_add_channel_column_once():
    """Adiciona a coluna 'channel' em bancos criados antes desta versão,
    SEM apagar nenhum pedido existente. Pedidos já gravados são marcados
    como 'online', já que até aqui só existia o pedido pelo site."""
    global _channel_migration_checked
    if _channel_migration_checked or os.path.exists(_CHANNEL_MIGRATION_MARKER):
        _channel_migration_checked = True
        return
    try:
        db.create_all()
        with db.engine.begin() as conn:
            inspector = inspect(db.engine)
            columns = {c['name'] for c in inspector.get_columns('order')}
            if 'channel' not in columns:
                conn.exec_driver_sql("ALTER TABLE \"order\" ADD COLUMN channel VARCHAR(20) DEFAULT 'online'")
                conn.exec_driver_sql("UPDATE \"order\" SET channel = 'online' WHERE channel IS NULL")
        with open(_CHANNEL_MIGRATION_MARKER, 'w', encoding='utf-8') as f:
            f.write('v7 channel migration completed')
    except Exception:
        raise
    finally:
        _channel_migration_checked = True

@app.before_request
def ensure_timezone_migration():
    # Ordem importa: as tabelas novas são criadas primeiro, com trava no
    # PostgreSQL (ver ensure_new_tables); a migração de canal usa SQL puro
    # (funciona mesmo sem a coluna existir ainda); a migração de fuso usa o
    # ORM, que já espera todas as colunas do modelo atual presentes na tabela.
    ensure_new_tables()
    migrate_v6_add_channel_column_once()
    migrate_v4_utc_timestamps_once()


@app.after_request
def apply_security_headers(response):
    """Cabeçalhos que reduzem o estrago mesmo se algum outro problema passar
    despercebido: impedem que o site seja carregado dentro de um iframe de
    outro domínio (clickjacking), impedem que o navegador "adivinhe" tipos
    de arquivo perigosos, e restringem de onde scripts podem ser carregados."""
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'geolocation=(), microphone=(), camera=()'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src https://fonts.gstatic.com; "
        "img-src 'self' data: https:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'"
    )
    if IS_PRODUCTION:
        response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    return response

STATUS_FLOW = ['novo', 'preparacao', 'pronto', 'entrega', 'finalizado']
ALL_STATUSES = STATUS_FLOW + ['cancelado']
STATUS_LABELS = {
    'novo': 'Novo',
    'preparacao': 'Em preparação',
    'pronto': 'Pronto',
    'entrega': 'Em entrega',
    'finalizado': 'Finalizado',
    'cancelado': 'Cancelado',
}
PAYMENT_LABELS = {'pix': 'Pix', 'dinheiro': 'Dinheiro', 'cartao': 'Cartão', 'outro': 'Outro'}
PAYMENT_METHODS = list(PAYMENT_LABELS.keys())
ORDER_TYPES = ['entrega', 'retirada']
CHANNEL_LABELS = {'online': 'Site', 'presencial': 'Balcão'}


# ---------------------------------------------------------------------
# Modelos
#
# Cada entidade tem sua própria tabela (nada de campos genéricos tipo
# JSON solto), pensando na futura análise de dados. order_items guarda
# um "retrato" do nome e do preço do produto no momento da venda, para
# que renomear ou reprecificar um produto não altere pedidos antigos.
# ---------------------------------------------------------------------
class Admin(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(120), nullable=False, unique=True)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=now_local)


class Customer(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    phone = db.Column(db.String(30), nullable=False, unique=True)
    address = db.Column(db.String(255), default='')
    created_at = db.Column(db.DateTime, default=now_local)
    updated_at = db.Column(db.DateTime, default=now_local, onupdate=now_local)


class Category(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False, unique=True)
    active = db.Column(db.Boolean, default=True, nullable=False)
    sort_order = db.Column(db.Integer, default=0)


class Product(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    description = db.Column(db.String(255), default='')
    category_id = db.Column(db.Integer, db.ForeignKey('category.id'))
    price = db.Column(db.Numeric(10, 2), nullable=False)
    image_url = db.Column(db.String(500), default='')
    active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=now_local)
    updated_at = db.Column(db.DateTime, default=now_local, onupdate=now_local)
    category = db.relationship('Category')


class Order(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    customer_id = db.Column(db.Integer, db.ForeignKey('customer.id'), nullable=False)
    status = db.Column(db.String(30), default='novo', nullable=False)
    order_type = db.Column(db.String(20), nullable=False)          # entrega | retirada
    channel = db.Column(db.String(20), default='online', nullable=False)  # online (site) | presencial (balcão/telefone)
    address = db.Column(db.String(255), default='')                # retrato do endereço usado
    payment_method = db.Column(db.String(30), nullable=False)
    change_for = db.Column(db.Numeric(10, 2))                       # troco para, se dinheiro
    subtotal = db.Column(db.Numeric(10, 2), nullable=False)
    delivery_fee = db.Column(db.Numeric(10, 2), default=0)
    total = db.Column(db.Numeric(10, 2), nullable=False)
    notes = db.Column(db.Text, default='')
    created_at = db.Column(db.DateTime, default=now_local, nullable=False)
    updated_at = db.Column(db.DateTime, default=now_local, onupdate=now_local)
    completed_at = db.Column(db.DateTime)
    customer = db.relationship('Customer')
    items = db.relationship('OrderItem', backref='order', cascade='all, delete-orphan')


class OrderItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.Integer, db.ForeignKey('order.id'), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey('product.id'))
    product_name_snapshot = db.Column(db.String(120), nullable=False)
    quantity = db.Column(db.Integer, nullable=False)
    unit_price = db.Column(db.Numeric(10, 2), nullable=False)
    subtotal = db.Column(db.Numeric(10, 2), nullable=False)
    notes = db.Column(db.String(255), default='')
    product = db.relationship('Product')


class OrderStatusHistory(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.Integer, db.ForeignKey('order.id'), nullable=False)
    old_status = db.Column(db.String(30))
    new_status = db.Column(db.String(30), nullable=False)
    changed_at = db.Column(db.DateTime, default=now_local, nullable=False)


# Tabelas novas (v10). Nenhuma delas altera as tabelas acima: são criadas
# à parte, para não arriscar os dados de produção.
class StoreSettings(db.Model):
    """Linha única (id = 1) com o modo da loja. Sem linha = modo automático."""
    __tablename__ = 'store_settings'
    id = db.Column(db.Integer, primary_key=True)
    mode = db.Column(db.String(20), default='auto', nullable=False)       # auto | open | closed
    closed_message = db.Column(db.String(160), default='', nullable=False)
    updated_at = db.Column(db.DateTime, default=now_local, onupdate=now_local)


class StoreHours(db.Model):
    """Horário de um dia da semana (0 = segunda … 6 = domingo, como em
    datetime.weekday()). Horários no formato HH:MM, no fuso de São Paulo.
    Fechamento menor ou igual à abertura = fecha na madrugada seguinte."""
    __tablename__ = 'store_hours'
    weekday = db.Column(db.Integer, primary_key=True, autoincrement=False)
    is_closed = db.Column(db.Boolean, default=False, nullable=False)
    open_time = db.Column(db.String(5), default='18:00', nullable=False)
    close_time = db.Column(db.String(5), default='23:00', nullable=False)


class OrderTracking(db.Model):
    """Token público e impossível de adivinhar para o cliente acompanhar o
    pedido (/acompanhar/<token>). O ID sequencial nunca é usado na URL.
    Pedidos anteriores a esta tabela simplesmente não têm acompanhamento."""
    __tablename__ = 'order_tracking'
    order_id = db.Column(db.Integer, db.ForeignKey('order.id'), primary_key=True, autoincrement=False)
    token = db.Column(db.String(64), nullable=False, unique=True, index=True)
    created_at = db.Column(db.DateTime, default=now_local, nullable=False)


class ProductSoldOut(db.Model):
    """Produto esgotado em um dia operacional. Guardar a data (e não um
    booleano no produto) faz o esgotado "voltar sozinho" no dia seguinte."""
    __tablename__ = 'product_sold_out'
    __table_args__ = (db.UniqueConstraint('product_id', 'business_date', name='uq_product_sold_out_day'),)
    id = db.Column(db.Integer, primary_key=True)
    product_id = db.Column(db.Integer, db.ForeignKey('product.id'), nullable=False, index=True)
    business_date = db.Column(db.Date, nullable=False)
    created_at = db.Column(db.DateTime, default=now_local, nullable=False)


NEW_TABLES_LOCK_ID = 727274010  # identificador arbitrário da trava no PostgreSQL
_new_tables_ready = False


def new_tables():
    return [StoreSettings.__table__, StoreHours.__table__, OrderTracking.__table__, ProductSoldOut.__table__]


def ensure_new_tables():
    """Cria as tabelas novas que ainda não existem, sem tocar nas existentes.

    Roda na primeira requisição de cada worker (o disco do Render é
    efêmero, então nada de marcador em arquivo). No PostgreSQL, uma trava
    de transação (pg_advisory_xact_lock) faz os workers do Gunicorn que
    sobem ao mesmo tempo criarem as tabelas um de cada vez: o segundo
    espera o primeiro terminar e então encontra tudo pronto."""
    global _new_tables_ready
    if _new_tables_ready:
        return
    with db.engine.begin() as conn:
        if conn.dialect.name == 'postgresql':
            conn.exec_driver_sql(f'SELECT pg_advisory_xact_lock({NEW_TABLES_LOCK_ID})')
        db.metadata.create_all(bind=conn, tables=new_tables(), checkfirst=True)
    _new_tables_ready = True


# ---------------------------------------------------------------------
# Loja aberta/fechada
# ---------------------------------------------------------------------
STORE_MODES = ['auto', 'open', 'closed']
WEEKDAY_LABELS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo']
_HHMM = re.compile(r'^([01]\d|2[0-3]):[0-5]\d$')


def _at(day, hhmm):
    h, m = hhmm.split(':')
    return datetime(day.year, day.month, day.day, int(h), int(m))


def _day_window(day, row):
    """(início, fim) do expediente que COMEÇA no dia `day`, ou None se fechado."""
    if not row or row['is_closed']:
        return None
    start, end = _at(day, row['open_time']), _at(day, row['close_time'])
    if end <= start:  # atravessa a meia-noite (ex.: 18:00 às 00:30)
        end += timedelta(days=1)
    return start, end


def _when_label(moment, now):
    days = (moment.date() - now.date()).days
    hhmm = moment.strftime('%H:%M')
    if days == 0:
        return f'hoje às {hhmm}'
    if days == 1:
        return f'amanhã às {hhmm}'
    return f'{WEEKDAY_LABELS[moment.weekday()].lower()} às {hhmm}'


def compute_store_status(now, mode, hours):
    """Função pura (sem banco) que decide se a loja está aberta.

    `hours` é {weekday: {'is_closed', 'open_time', 'close_time'}}; vazio
    significa horário nunca configurado — nesse caso a loja fica aberta,
    exatamente como o sistema funcionava antes desta funcionalidade."""
    status = {'mode': mode, 'is_open': True, 'reason': 'not_configured',
              'closes_at': None, 'closes_at_label': None, 'next_open': None, 'next_open_label': None}
    if mode == 'open':
        status['reason'] = 'manual_open'
        return status
    if mode == 'closed':
        status.update(is_open=False, reason='manual_closed')
        return status
    if not hours:
        return status

    today = now.date()
    # O expediente de ontem pode ainda estar valendo (madrugada); o de hoje também.
    for day in (today - timedelta(days=1), today):
        window = _day_window(day, hours.get(day.weekday()))
        if window and window[0] <= now < window[1]:
            status.update(reason='schedule', closes_at=window[1].isoformat(),
                          closes_at_label=window[1].strftime('%H:%M'))
            return status

    status.update(is_open=False, reason='schedule')
    for offset in range(0, 8):
        day = today + timedelta(days=offset)
        window = _day_window(day, hours.get(day.weekday()))
        if window and window[0] > now:
            status.update(next_open=window[0].isoformat(), next_open_label=_when_label(window[0], now))
            break
    return status


def _store_hours_map():
    return {
        h.weekday: {'is_closed': h.is_closed, 'open_time': h.open_time, 'close_time': h.close_time}
        for h in StoreHours.query.all()
    }


def get_store_status():
    settings = db.session.get(StoreSettings, 1)
    mode = settings.mode if settings and settings.mode in STORE_MODES else 'auto'
    status = compute_store_status(now_local(), mode, _store_hours_map())
    status['message'] = settings.closed_message if settings else ''
    return status


# ---------------------------------------------------------------------
# Produto esgotado (só no dia operacional atual)
# ---------------------------------------------------------------------
# O dia operacional vai das 05:00 às 04:59 do dia seguinte: um produto
# marcado como esgotado na sexta às 23h continua esgotado na madrugada de
# sábado (loja aberta até 00:30) e volta sozinho às 5h. Uma hora fixa é
# mais previsível para a dona do que depender do horário de fechamento.
OPERATIONAL_DAY_START_HOUR = 5


def business_date(now=None):
    now = now or now_local()
    return (now - timedelta(hours=OPERATIONAL_DAY_START_HOUR)).date()


def sold_out_product_ids():
    rows = ProductSoldOut.query.filter_by(business_date=business_date()).all()
    return {r.product_id for r in rows}


def _store_closed_error(status):
    text = 'Estamos fechados agora e não estamos recebendo pedidos pelo site.'
    if status.get('next_open_label'):
        text += f' Abrimos {status["next_open_label"]}.'
    return jsonify({'error': text, 'code': 'store_closed', 'store': status}), 409


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
def money(v):
    return float(v or 0)


def to_decimal(value, field_name):
    try:
        d = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError(f'Valor inválido para "{field_name}".')
    return d


def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get('admin_id'):
            return jsonify({'error': 'Faça login para acessar o painel.'}), 401
        return fn(*args, **kwargs)
    return wrapper


def order_dict(o, detailed=False):
    data = {
        'id': o.id,
        'status': o.status,
        'status_label': STATUS_LABELS.get(o.status, o.status),
        'order_type': o.order_type,
        'channel': o.channel,
        'channel_label': CHANNEL_LABELS.get(o.channel, o.channel),
        'payment_method': o.payment_method,
        'payment_label': PAYMENT_LABELS.get(o.payment_method, o.payment_method),
        'change_for': money(o.change_for) if o.change_for else None,
        'subtotal': money(o.subtotal),
        'delivery_fee': money(o.delivery_fee),
        'total': money(o.total),
        'notes': o.notes or '',
        'address': o.address or '',
        'created_at': o.created_at.isoformat(),
        'updated_at': o.updated_at.isoformat() if o.updated_at else None,
        'completed_at': o.completed_at.isoformat() if o.completed_at else None,
        'customer': {
            'id': o.customer.id,
            'name': o.customer.name,
            'phone': o.customer.phone,
            'address': o.customer.address or '',
        },
        'items': [
            {
                'product_id': i.product_id,
                'name': i.product_name_snapshot,
                'quantity': i.quantity,
                'unit_price': money(i.unit_price),
                'subtotal': money(i.subtotal),
                'notes': i.notes or '',
            }
            for i in o.items
        ],
    }
    if detailed:
        history = (
            OrderStatusHistory.query.filter_by(order_id=o.id)
            .order_by(OrderStatusHistory.changed_at)
            .all()
        )
        data['history'] = [
            {
                'old_status': h.old_status,
                'new_status': h.new_status,
                'new_status_label': STATUS_LABELS.get(h.new_status, h.new_status),
                'changed_at': h.changed_at.isoformat(),
            }
            for h in history
        ]
    return data


def resolve_period(period, from_str, to_str):
    """Devolve (start, end) como datetime, no formato usado pelo fechamento."""
    now = now_local()
    today_start = datetime(now.year, now.month, now.day)

    if period == 'hoje':
        start, end = today_start, today_start + timedelta(days=1)
    elif period == 'ontem':
        start, end = today_start - timedelta(days=1), today_start
    elif period == 'semana':
        start = today_start - timedelta(days=(today_start.isoweekday() % 7))  # domingo como início
        end = start + timedelta(days=7)
    elif period == 'mes':
        start = datetime(now.year, now.month, 1)
        end = datetime(now.year + (1 if now.month == 12 else 0), 1 if now.month == 12 else now.month + 1, 1)
    elif period == 'personalizado':
        if not from_str or not to_str:
            raise ValueError('Período personalizado precisa de data inicial e final.')
        start = datetime.fromisoformat(from_str)
        end = datetime.fromisoformat(to_str) + timedelta(days=1)
    else:
        raise ValueError('Período inválido.')
    return start, end


def previous_period(start, end):
    duration = end - start
    return start - duration, start


def summarize_period(start, end):
    orders = (
        Order.query.filter(Order.created_at >= start, Order.created_at < end, Order.status != 'cancelado')
        .all()
    )
    total = sum((money(o.total) for o in orders), 0.0)
    count = len(orders)
    ticket = total / count if count else 0.0

    by_payment = {}
    by_product = {}
    by_channel = {}
    for o in orders:
        pay = by_payment.setdefault(o.payment_method, {'orders_count': 0, 'revenue': 0.0})
        pay['orders_count'] += 1
        pay['revenue'] += money(o.total)
        ch = by_channel.setdefault(o.channel, {'orders_count': 0, 'revenue': 0.0})
        ch['orders_count'] += 1
        ch['revenue'] += money(o.total)
        for item in o.items:
            prod = by_product.setdefault(item.product_name_snapshot, {'quantity': 0, 'revenue': 0.0})
            prod['quantity'] += item.quantity
            prod['revenue'] += money(item.subtotal)

    return {
        'orders_count': count,
        'revenue': round(total, 2),
        'average_ticket': round(ticket, 2),
        'by_payment_method': [
            {'payment_method': k, 'payment_label': PAYMENT_LABELS.get(k, k), **v} for k, v in by_payment.items()
        ],
        'by_channel': [
            {'channel': k, 'channel_label': CHANNEL_LABELS.get(k, k), **v} for k, v in by_channel.items()
        ],
        'by_product': sorted(
            [{'product_name': k, **v} for k, v in by_product.items()], key=lambda x: x['revenue'], reverse=True
        ),
    }


# ---------------------------------------------------------------------
# Páginas (server-rendered)
# ---------------------------------------------------------------------
@app.route('/')
def customer_page():
    return render_template('customer.html')


@app.route('/admin')
def admin_page():
    if not session.get('admin_id'):
        return redirect(url_for('login_page'))
    return render_template('admin.html', admin_name=session.get('admin_name', ''))


@app.route('/admin/login', methods=['GET', 'POST'])
@limiter.limit('10 per minute')
def login_page():
    if request.method == 'POST':
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        admin = Admin.query.filter_by(email=email).first()
        if admin and check_password_hash(admin.password_hash, password):
            session.clear()
            session.permanent = False
            session['admin_id'] = admin.id
            session['admin_name'] = admin.name
            logger.info('Login bem-sucedido: %s (%s)', email, get_remote_address())
            return redirect(url_for('admin_page'))
        logger.warning('Tentativa de login falhou: %s (%s)', email, get_remote_address())
        return render_template('login.html', error='E-mail ou senha inválidos.')
    if session.get('admin_id'):
        return redirect(url_for('admin_page'))
    return render_template('login.html')


@app.route('/admin/logout')
def logout():
    session.clear()
    return redirect(url_for('login_page'))


# ---------------------------------------------------------------------
# API pública — cardápio e criação de pedido
# ---------------------------------------------------------------------
@app.route('/api/config')
def api_config():
    """Configuração pública e somente leitura usada pela tela do cliente.
    A taxa de entrega é sempre a mesma vinda daqui — o cliente nunca a define.
    `store` informa se a loja está aberta (a decisão final é sempre do
    servidor, na criação do pedido)."""
    s = get_store_status()
    store = {k: s[k] for k in ('is_open', 'reason', 'message', 'next_open', 'next_open_label')}
    return jsonify({'delivery_fee': money(DELIVERY_FEE), 'store': store})


@app.route('/api/categories')
def api_categories():
    show_all = request.args.get('all') == 'true' and session.get('admin_id')
    q = Category.query if show_all else Category.query.filter_by(active=True)
    cats = q.order_by(Category.sort_order, Category.name).all()
    return jsonify([{'id': c.id, 'name': c.name, 'active': c.active, 'sort_order': c.sort_order} for c in cats])


@app.route('/api/products')
def api_products():
    show_all = request.args.get('all') == 'true' and session.get('admin_id')
    q = Product.query if show_all else Product.query.filter_by(active=True)
    products = q.order_by(Product.category_id, Product.name).all()
    sold_out = sold_out_product_ids()
    return jsonify(
        [
            {
                'id': p.id,
                'name': p.name,
                'description': p.description,
                'price': money(p.price),
                'category_id': p.category_id,
                'category_name': p.category.name if p.category else None,
                'image_url': p.image_url or '',
                'active': p.active,
                'sold_out': p.id in sold_out,
            }
            for p in products
        ]
    )


class UnavailableProducts(ValueError):
    """Itens do pedido que existem, mas não podem ser pedidos agora."""

    def __init__(self, items):
        self.items = items
        sold = [i['name'] for i in items if i['reason'] == 'sold_out']
        gone = [i['name'] for i in items if i['reason'] == 'inactive']
        parts = []
        if sold:
            parts.append(f'{_join_names(sold)} {"esgotou" if len(sold) == 1 else "esgotaram"} hoje')
        if gone:
            parts.append(f'{_join_names(gone)} não {"está" if len(gone) == 1 else "estão"} mais no cardápio')
        super().__init__('; '.join(parts) + '. Remova do pedido para continuar.')

    def response(self):
        return jsonify({'error': str(self), 'code': 'products_unavailable', 'unavailable': self.items}), 400


def _join_names(names):
    quoted = [f'"{n}"' for n in names]
    return quoted[0] if len(quoted) == 1 else ', '.join(quoted[:-1]) + ' e ' + quoted[-1]


def _process_order_items(items_in):
    """Valida os itens de um pedido e recalcula os preços a partir do
    catálogo atual (nunca confia em preço vindo do cliente/atendente).
    Devolve (subtotal, prepared_items) ou levanta ValueError."""
    if not items_in:
        raise ValueError('Adicione pelo menos um produto ao pedido.')
    if not isinstance(items_in, list) or len(items_in) > 40:
        raise ValueError('Pedido com número de itens inválido.')

    subtotal = Decimal('0')
    prepared_items = []
    unavailable = []
    sold_out = sold_out_product_ids()
    for raw in items_in:
        if not isinstance(raw, dict):
            raise ValueError('Item de pedido inválido.')
        try:
            product = db.session.get(Product, int(raw.get('product_id')))
            qty = int(raw.get('quantity'))
        except (ValueError, TypeError):
            raise ValueError('Item de pedido inválido.')
        if not product or qty < 1 or qty > 99:
            raise ValueError(f'Produto indisponível no pedido (id {raw.get("product_id")}).')
        # Inativo ou esgotado hoje: junta todos para avisar de uma vez, pelo nome
        if not product.active or product.id in sold_out:
            reason = 'inactive' if not product.active else 'sold_out'
            if not any(u['product_id'] == product.id for u in unavailable):
                unavailable.append({'product_id': product.id, 'name': product.name, 'reason': reason})
            continue
        item_notes = (raw.get('notes') or '').strip()
        if len(item_notes) > 255:
            raise ValueError('Observação de item muito longa.')
        item_subtotal = product.price * qty
        subtotal += item_subtotal
        prepared_items.append((product, qty, item_subtotal, item_notes))
    if unavailable:
        raise UnavailableProducts(unavailable)
    return subtotal, prepared_items


def _parse_change_for(data, payment_method):
    """Lê e valida o troco (só faz sentido para pagamento em dinheiro)."""
    if payment_method != 'dinheiro' or not data.get('change_for'):
        return None
    change_for = to_decimal(data['change_for'], 'troco')
    if change_for < 0 or change_for > 9999:
        raise ValueError('Valor de troco inválido.')
    return change_for


def _create_order_record(customer, order_type, address, payment_method, change_for, subtotal, delivery_fee, notes, prepared_items, channel):
    total = subtotal + delivery_fee
    order = Order(
        customer=customer,
        status='novo',
        order_type=order_type,
        channel=channel,
        address=address if order_type == 'entrega' else '',
        payment_method=payment_method,
        change_for=change_for,
        subtotal=subtotal,
        delivery_fee=delivery_fee,
        total=total,
        notes=notes,
    )
    db.session.add(order)
    db.session.flush()  # gera order.id sem commitar ainda

    for product, qty, item_subtotal, item_notes in prepared_items:
        db.session.add(
            OrderItem(
                order_id=order.id,
                product_id=product.id,
                product_name_snapshot=product.name,
                quantity=qty,
                unit_price=product.price,
                subtotal=item_subtotal,
                notes=item_notes,
            )
        )
    db.session.add(OrderStatusHistory(order_id=order.id, old_status=None, new_status='novo'))
    # 18 bytes aleatórios = 24 caracteres; gravado na mesma transação do pedido
    db.session.add(OrderTracking(order_id=order.id, token=secrets.token_urlsafe(18)))
    db.session.commit()
    return order


def _tracking_fields(order):
    """Campos aditivos na resposta de criação do pedido."""
    t = db.session.get(OrderTracking, order.id)
    if not t:
        return {}
    return {'tracking_token': t.token, 'tracking_url': url_for('track_page', token=t.token)}


@app.route('/api/orders', methods=['POST'])
@limiter.limit('12 per minute')
def create_order():
    """Criação pública de pedido (cardápio do site). Recalcula tudo no
    servidor — nunca confia em preço, taxa de entrega ou total vindo do cliente."""
    store = get_store_status()
    if not store['is_open']:
        return _store_closed_error(store)

    data = request.get_json(silent=True) or {}

    name = (data.get('name') or '').strip()
    phone = (data.get('phone') or '').strip()
    order_type = data.get('order_type')
    payment_method = data.get('payment_method')
    address = (data.get('address') or '').strip()
    notes = (data.get('notes') or '').strip()
    items_in = data.get('items') or []

    # Limites de tamanho: além de proteger o banco de lixo/abuso, evita que
    # alguém envie payloads gigantes propositalmente para sobrecarregar o servidor.
    if not name or not phone:
        return jsonify({'error': 'Preencha seu nome e telefone.'}), 400
    if len(name) > 120:
        return jsonify({'error': 'Nome muito longo.'}), 400
    if len(phone) > 30:
        return jsonify({'error': 'Telefone inválido.'}), 400
    if len(address) > 255:
        return jsonify({'error': 'Endereço muito longo.'}), 400
    if len(notes) > 500:
        return jsonify({'error': 'Observação muito longa (máximo 500 caracteres).'}), 400
    if order_type not in ORDER_TYPES:
        return jsonify({'error': 'Tipo de pedido inválido.'}), 400
    if order_type == 'entrega' and not address:
        return jsonify({'error': 'Informe o endereço para entrega.'}), 400
    if payment_method not in PAYMENT_METHODS:
        return jsonify({'error': 'Forma de pagamento inválida.'}), 400

    customer = Customer.query.filter_by(phone=phone).first()
    if not customer:
        customer = Customer(name=name, phone=phone, address=address)
        db.session.add(customer)
    else:
        customer.name = name
        if address:
            customer.address = address

    try:
        subtotal, prepared_items = _process_order_items(items_in)
        delivery_fee = DELIVERY_FEE if order_type == 'entrega' else Decimal('0')
        change_for = _parse_change_for(data, payment_method)
    except UnavailableProducts as err:
        return err.response()
    except ValueError as err:
        return jsonify({'error': str(err)}), 400

    order = _create_order_record(
        customer, order_type, address, payment_method, change_for,
        subtotal, delivery_fee, notes, prepared_items, channel='online'
    )
    return jsonify({'order': order_dict(order), 'message': 'Pedido recebido com sucesso!', **_tracking_fields(order)}), 201


@app.route('/api/orders/presencial', methods=['POST'])
@require_admin
def create_order_presencial():
    """Pedido anotado pelo atendente (balcão ou telefone) — entra no sistema
    exatamente como um pedido do site (conta para Kanban, fechamento,
    histórico e cliente), só que o telefone do cliente é opcional: nem todo
    mundo no balcão quer informar. O objetivo é nenhum pedido real ficar de
    fora dos dados só por ter sido feito na hora, presencialmente."""
    data = request.get_json(silent=True) or {}

    name = (data.get('name') or '').strip() or 'Cliente Balcão'
    phone = (data.get('phone') or '').strip()
    order_type = data.get('order_type') or 'retirada'
    payment_method = data.get('payment_method')
    address = (data.get('address') or '').strip()
    notes = (data.get('notes') or '').strip()
    items_in = data.get('items') or []

    if len(name) > 120:
        return jsonify({'error': 'Nome muito longo.'}), 400
    if phone and len(phone) > 30:
        return jsonify({'error': 'Telefone inválido.'}), 400
    if len(address) > 255:
        return jsonify({'error': 'Endereço muito longo.'}), 400
    if len(notes) > 500:
        return jsonify({'error': 'Observação muito longa (máximo 500 caracteres).'}), 400
    if order_type not in ORDER_TYPES:
        return jsonify({'error': 'Tipo de pedido inválido.'}), 400
    if order_type == 'entrega' and not address:
        return jsonify({'error': 'Informe o endereço para entrega.'}), 400
    if payment_method not in PAYMENT_METHODS:
        return jsonify({'error': 'Forma de pagamento inválida.'}), 400

    if phone:
        customer = Customer.query.filter_by(phone=phone).first()
        if not customer:
            customer = Customer(name=name, phone=phone, address=address)
            db.session.add(customer)
        else:
            customer.name = name
            if address:
                customer.address = address
    else:
        # Cliente do balcão que não quis informar telefone: gera um
        # identificador interno só para satisfazer o cadastro (nunca um
        # telefone de verdade), sem tentar "adivinhar" quem é a pessoa.
        placeholder_phone = f'balcao-{int(now_local().timestamp() * 1000)}'
        customer = Customer(name=name, phone=placeholder_phone, address=address)
        db.session.add(customer)

    try:
        subtotal, prepared_items = _process_order_items(items_in)
        delivery_fee = DELIVERY_FEE if order_type == 'entrega' else Decimal('0')
        change_for = _parse_change_for(data, payment_method)
    except UnavailableProducts as err:
        return err.response()
    except ValueError as err:
        return jsonify({'error': str(err)}), 400

    order = _create_order_record(
        customer, order_type, address, payment_method, change_for,
        subtotal, delivery_fee, notes, prepared_items, channel='presencial'
    )
    logger.info('Pedido presencial #%s registrado por %s', order.id, session.get('admin_name'))
    return jsonify({'order': order_dict(order), 'message': 'Pedido registrado!'}), 201


# ---------------------------------------------------------------------
# Acompanhamento público do pedido (por token, nunca pelo ID)
# ---------------------------------------------------------------------
_TOKEN_RE = re.compile(r'^[A-Za-z0-9_-]{16,64}$')

# Etapas mostradas ao cliente. Retirada não tem "Em entrega".
TRACK_STEPS = {
    'entrega': ['novo', 'preparacao', 'pronto', 'entrega', 'finalizado'],
    'retirada': ['novo', 'preparacao', 'pronto', 'finalizado'],
}
TRACK_LABELS = {
    'novo': 'Recebemos seu pedido',
    'preparacao': 'Seu pedido está sendo preparado',
    ('pronto', 'retirada'): 'Pronto para retirada',
    ('pronto', 'entrega'): 'Pedido pronto',
    'entrega': 'Saiu para entrega',
    ('finalizado', 'retirada'): 'Pedido retirado',
    ('finalizado', 'entrega'): 'Pedido entregue',
    'cancelado': 'Pedido cancelado',
}
TRACK_HINTS = {
    'novo': 'Ele já está na fila da cozinha.',
    'preparacao': 'Estamos preparando tudo com carinho.',
    ('pronto', 'retirada'): 'Pode vir buscar quando quiser.',
    ('pronto', 'entrega'): 'Já já ele sai para entrega.',
    'entrega': 'Logo ele chega até você.',
    'finalizado': 'Obrigado pela preferência. Bom apetite!',
    'cancelado': 'Este pedido não será preparado.',
}


def _track_text(table, status, order_type):
    return table.get((status, order_type)) or table.get(status, '')


def first_name(name):
    parts = (name or '').split()
    return parts[0] if parts else ''


def address_summary(address):
    """Só a rua, sem número nem complemento: 'Rua das Flores, 123, ap 4' → 'Rua das Flores'."""
    text = (address or '').strip()
    text = re.split(r'[,\-–\d]', text, maxsplit=1)[0].strip()
    return text[:60]


def _find_tracking(token):
    if not token or not _TOKEN_RE.match(token):
        return None
    t = OrderTracking.query.filter_by(token=token).first()
    return db.session.get(Order, t.order_id) if t else None


def track_dict(o):
    status = o.status
    steps_keys = TRACK_STEPS.get(o.order_type, TRACK_STEPS['entrega'])
    # Pedido de retirada marcado "em entrega" por engano conta como "pronto"
    current = 'pronto' if (status == 'entrega' and o.order_type == 'retirada') else status
    current_idx = steps_keys.index(current) if current in steps_keys else -1

    reached = {}
    for h in OrderStatusHistory.query.filter_by(order_id=o.id).order_by(OrderStatusHistory.changed_at).all():
        reached[h.new_status] = h.changed_at  # o último registro de cada etapa vale

    steps = []
    for i, key in enumerate(steps_keys):
        done = current_idx >= 0 and i <= current_idx
        at = reached.get(key) if done else None
        steps.append({
            'key': key,
            'label': _track_text(TRACK_LABELS, key, o.order_type),
            'done': done,
            'current': i == current_idx,
            'at': at.isoformat() if at else None,
        })

    return {
        'number': o.id,
        'status': status,
        'headline': _track_text(TRACK_LABELS, status, o.order_type),
        'hint': _track_text(TRACK_HINTS, status, o.order_type),
        'is_final': status in ('finalizado', 'cancelado'),
        'is_cancelled': status == 'cancelado',
        'cancelled_at': reached['cancelado'].isoformat() if 'cancelado' in reached else None,
        'created_at': o.created_at.isoformat(),
        'order_type': o.order_type,
        'order_type_label': 'Entrega' if o.order_type == 'entrega' else 'Retirada',
        'payment_label': PAYMENT_LABELS.get(o.payment_method, o.payment_method),
        'change_for': money(o.change_for) if o.change_for else None,
        'customer_first_name': first_name(o.customer.name),
        'address_summary': address_summary(o.address) if o.order_type == 'entrega' else '',
        'items': [{'name': i.product_name_snapshot, 'quantity': i.quantity, 'subtotal': money(i.subtotal)} for i in o.items],
        'subtotal': money(o.subtotal),
        'delivery_fee': money(o.delivery_fee),
        'total': money(o.total),
        'steps': steps,
    }


@app.route('/acompanhar/<token>')
@limiter.limit('30 per minute')
def track_page(token):
    o = _find_tracking(token)
    if not o:
        return render_template('track.html', token=None), 404
    return render_template('track.html', token=token, number=o.id)


@app.route('/api/track/<token>')
@limiter.limit('30 per minute')
def api_track(token):
    o = _find_tracking(token)
    if not o:
        return jsonify({'error': 'Pedido não encontrado.'}), 404
    resp = jsonify(track_dict(o))
    resp.headers['Cache-Control'] = 'no-store'
    return resp


# ---------------------------------------------------------------------
# API administrativa — pedidos / kanban / histórico
# ---------------------------------------------------------------------
@app.route('/api/orders')
@require_admin
def api_orders():
    """Listagem usada pelo Kanban (sem filtros) e pelo Histórico (com filtros)."""
    q = Order.query

    status = request.args.get('status')
    order_type = request.args.get('order_type')
    channel = request.args.get('channel')
    payment_method = request.args.get('payment_method')
    product = request.args.get('product')
    customer_q = request.args.get('customer')
    search = request.args.get('q')
    date_from = request.args.get('from')
    date_to = request.args.get('to')

    if status:
        q = q.filter(Order.status == status)
    if order_type:
        q = q.filter(Order.order_type == order_type)
    if channel:
        q = q.filter(Order.channel == channel)
    if payment_method:
        q = q.filter(Order.payment_method == payment_method)
    if date_from:
        try:
            q = q.filter(Order.created_at >= datetime.fromisoformat(date_from))
        except ValueError:
            return jsonify({'error': 'Data inicial inválida.'}), 400
    if date_to:
        try:
            q = q.filter(Order.created_at < datetime.fromisoformat(date_to) + timedelta(days=1))
        except ValueError:
            return jsonify({'error': 'Data final inválida.'}), 400
    if customer_q:
        like = f'%{customer_q}%'
        q = q.join(Customer).filter(db.or_(Customer.name.ilike(like), Customer.phone.ilike(like)))
    if search:
        like = f'%{search}%'
        conditions = [Customer.name.ilike(like), Customer.phone.ilike(like)]
        if search.isdigit():
            conditions.append(Order.id == int(search))
        q = q.join(Customer).filter(db.or_(*conditions))
    if product:
        like = f'%{product}%'
        q = q.filter(Order.items.any(OrderItem.product_name_snapshot.ilike(like)))

    orders = q.order_by(Order.created_at.desc()).limit(500).all()
    return jsonify([order_dict(o) for o in orders])


@app.route('/api/orders/<int:order_id>')
@require_admin
def api_order_detail(order_id):
    o = db.session.get(Order, order_id)
    if not o:
        return jsonify({'error': 'Pedido não encontrado.'}), 404
    return jsonify(order_dict(o, detailed=True))


@app.route('/api/orders/<int:order_id>/status', methods=['PUT'])
@require_admin
def update_status(order_id):
    data = request.get_json(silent=True) or {}
    new_status = data.get('status')
    if new_status not in ALL_STATUSES:
        return jsonify({'error': 'Status inválido.'}), 400

    o = db.session.get(Order, order_id)
    if not o:
        return jsonify({'error': 'Pedido não encontrado.'}), 404

    old_status = o.status
    if old_status == new_status:
        return jsonify(order_dict(o, detailed=True))

    o.status = new_status
    if new_status == 'finalizado':
        o.completed_at = now_local()
    db.session.add(OrderStatusHistory(order_id=o.id, old_status=old_status, new_status=new_status))
    db.session.commit()
    return jsonify(order_dict(o, detailed=True))


# ---------------------------------------------------------------------
# API administrativa — produtos e categorias
# ---------------------------------------------------------------------
@app.route('/api/products', methods=['POST'])
@require_admin
def create_product():
    d = request.get_json(silent=True) or {}
    if not (d.get('name') or '').strip():
        return jsonify({'error': 'Nome é obrigatório.'}), 400
    try:
        price = to_decimal(d.get('price'), 'preço')
    except ValueError as err:
        return jsonify({'error': str(err)}), 400
    if price < 0:
        return jsonify({'error': 'Preço não pode ser negativo.'}), 400

    p = Product(
        name=d['name'].strip(),
        description=(d.get('description') or '').strip(),
        price=price,
        category_id=d.get('category_id') or None,
        image_url=(d.get('image_url') or '').strip(),
        active=True,
    )
    db.session.add(p)
    db.session.commit()
    return jsonify({'id': p.id}), 201


@app.route('/api/products/<int:pid>', methods=['PUT'])
@require_admin
def edit_product(pid):
    p = db.session.get(Product, pid)
    if not p:
        return jsonify({'error': 'Produto não encontrado.'}), 404
    d = request.get_json(silent=True) or {}

    if 'name' in d:
        if not d['name'].strip():
            return jsonify({'error': 'Nome não pode ficar vazio.'}), 400
        p.name = d['name'].strip()
    if 'description' in d:
        p.description = (d['description'] or '').strip()
    if 'price' in d:
        try:
            p.price = to_decimal(d['price'], 'preço')
        except ValueError as err:
            return jsonify({'error': str(err)}), 400
    if 'category_id' in d:
        p.category_id = d['category_id'] or None
    if 'image_url' in d:
        p.image_url = (d['image_url'] or '').strip()
    if 'active' in d:
        p.active = bool(d['active'])

    db.session.commit()
    return jsonify({'ok': True})


@app.route('/api/products/<int:pid>/sold-out', methods=['PUT'])
@require_admin
def toggle_sold_out(pid):
    """Marca/desmarca o produto como esgotado no dia operacional atual."""
    p = db.session.get(Product, pid)
    if not p:
        return jsonify({'error': 'Produto não encontrado.'}), 404
    d = request.get_json(silent=True) or {}
    if not isinstance(d.get('sold_out'), bool):
        return jsonify({'error': 'Informe sold_out como true ou false.'}), 400
    day = business_date()
    row = ProductSoldOut.query.filter_by(product_id=pid, business_date=day).first()
    if d['sold_out'] and not row:
        db.session.add(ProductSoldOut(product_id=pid, business_date=day))
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()  # dois toques ao mesmo tempo: já está marcado
    elif not d['sold_out'] and row:
        db.session.delete(row)
        db.session.commit()
    logger.info('Produto #%s %s por %s', pid, 'esgotado hoje' if d['sold_out'] else 'disponível de novo', session.get('admin_name'))
    return jsonify({'ok': True, 'sold_out': d['sold_out'], 'business_date': day.isoformat()})


@app.route('/api/categories', methods=['POST'])
@require_admin
def create_category():
    d = request.get_json(silent=True) or {}
    name = (d.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Nome é obrigatório.'}), 400
    if Category.query.filter_by(name=name).first():
        return jsonify({'error': 'Já existe uma categoria com esse nome.'}), 400
    c = Category(name=name, sort_order=d.get('sort_order', 0))
    db.session.add(c)
    db.session.commit()
    return jsonify({'id': c.id}), 201


@app.route('/api/categories/<int:cid>', methods=['PUT'])
@require_admin
def edit_category(cid):
    c = db.session.get(Category, cid)
    if not c:
        return jsonify({'error': 'Categoria não encontrada.'}), 404
    d = request.get_json(silent=True) or {}
    if 'name' in d and d['name'].strip():
        c.name = d['name'].strip()
    if 'active' in d:
        c.active = bool(d['active'])
    if 'sort_order' in d:
        c.sort_order = d['sort_order']
    db.session.commit()
    return jsonify({'ok': True})


# ---------------------------------------------------------------------
# API administrativa — loja aberta/fechada e horário de funcionamento
# ---------------------------------------------------------------------
def _store_admin_payload():
    hours = _store_hours_map()
    return {
        'status': get_store_status(),
        'configured': bool(hours),
        'hours': [
            {
                'weekday': wd,
                'label': WEEKDAY_LABELS[wd],
                'is_closed': hours[wd]['is_closed'] if wd in hours else False,
                'open_time': hours[wd]['open_time'] if wd in hours else '18:00',
                'close_time': hours[wd]['close_time'] if wd in hours else '23:00',
            }
            for wd in range(7)
        ],
    }


def _get_or_create_settings():
    settings = db.session.get(StoreSettings, 1)
    if not settings:
        settings = StoreSettings(id=1, mode='auto', closed_message='')
        db.session.add(settings)
    return settings


@app.route('/api/store')
@require_admin
def api_store():
    return jsonify(_store_admin_payload())


@app.route('/api/store/mode', methods=['PUT'])
@require_admin
def api_store_mode():
    d = request.get_json(silent=True) or {}
    settings = _get_or_create_settings()
    if 'mode' in d:
        if d['mode'] not in STORE_MODES:
            return jsonify({'error': 'Modo inválido.'}), 400
        settings.mode = d['mode']
    if 'message' in d:
        message = (d['message'] or '').strip()
        if len(message) > 160:
            return jsonify({'error': 'Mensagem muito longa (máximo 160 caracteres).'}), 400
        settings.closed_message = message
    db.session.commit()
    logger.info('Modo da loja: %s (por %s)', settings.mode, session.get('admin_name'))
    return jsonify(_store_admin_payload())


@app.route('/api/store/hours', methods=['PUT'])
@require_admin
def api_store_hours():
    d = request.get_json(silent=True) or {}
    days = d.get('hours')
    if not isinstance(days, list) or len(days) != 7:
        return jsonify({'error': 'Envie o horário dos 7 dias da semana.'}), 400
    parsed = {}
    for day in days:
        if not isinstance(day, dict):
            return jsonify({'error': 'Horário inválido.'}), 400
        wd = day.get('weekday')
        if not isinstance(wd, int) or not 0 <= wd <= 6 or wd in parsed:
            return jsonify({'error': 'Dia da semana inválido.'}), 400
        is_closed = bool(day.get('is_closed'))
        open_time = str(day.get('open_time') or '')
        close_time = str(day.get('close_time') or '')
        if not is_closed:
            if not _HHMM.match(open_time) or not _HHMM.match(close_time):
                return jsonify({'error': f'{WEEKDAY_LABELS[wd]}: informe abertura e fechamento (HH:MM).', 'weekday': wd}), 400
            if open_time == close_time:
                return jsonify({'error': f'{WEEKDAY_LABELS[wd]}: abertura e fechamento não podem ser iguais.', 'weekday': wd}), 400
        else:
            # Dia fechado guarda o último horário válido, para facilitar reabrir
            open_time = open_time if _HHMM.match(open_time) else '18:00'
            close_time = close_time if _HHMM.match(close_time) else '23:00'
        parsed[wd] = (is_closed, open_time, close_time)

    for wd, (is_closed, open_time, close_time) in parsed.items():
        row = db.session.get(StoreHours, wd) or StoreHours(weekday=wd)
        row.is_closed, row.open_time, row.close_time = is_closed, open_time, close_time
        db.session.add(row)
    db.session.commit()
    logger.info('Horário de funcionamento atualizado por %s', session.get('admin_name'))
    return jsonify(_store_admin_payload())


# ---------------------------------------------------------------------
# API administrativa — minha conta (troca de senha)
# ---------------------------------------------------------------------
MIN_PASSWORD_LENGTH = 8


@app.route('/api/account/password', methods=['POST'])
@require_admin
@limiter.limit('5 per minute')
@limiter.limit('20 per hour')
def change_password():
    """Troca a senha de quem está logado. Exige a senha atual; nunca registra
    senhas em log (só o resultado, o e-mail e o IP, como no login)."""
    d = request.get_json(silent=True) or {}
    current = d.get('current_password') or ''
    new = d.get('new_password') or ''
    confirm = d.get('confirm_password') or ''
    admin = db.session.get(Admin, session.get('admin_id'))
    if not admin:
        session.clear()
        return jsonify({'error': 'Sessão expirada. Faça login novamente.'}), 401

    def fail(field, message, reason):
        logger.warning('Troca de senha falhou (%s): %s (%s)', reason, admin.email, get_remote_address())
        return jsonify({'error': message, 'field': field}), 400

    if not current:
        return fail('current_password', 'Informe a senha atual.', 'senha atual vazia')
    if not check_password_hash(admin.password_hash, current):
        return fail('current_password', 'Senha atual incorreta.', 'senha atual incorreta')
    if len(new) < MIN_PASSWORD_LENGTH:
        return fail('new_password', f'A nova senha precisa ter pelo menos {MIN_PASSWORD_LENGTH} caracteres.', 'senha curta')
    if len(new) > 128:
        return fail('new_password', 'A nova senha pode ter no máximo 128 caracteres.', 'senha longa')
    if new == current:
        return fail('new_password', 'A nova senha precisa ser diferente da atual.', 'senha igual à atual')
    if new != confirm:
        return fail('confirm_password', 'A confirmação não é igual à nova senha.', 'confirmação diferente')

    admin.password_hash = generate_password_hash(new)
    db.session.commit()
    logger.info('Senha alterada: %s (%s)', admin.email, get_remote_address())
    return jsonify({'ok': True, 'message': 'Senha alterada com sucesso.'})


# ---------------------------------------------------------------------
# API administrativa — clientes
# ---------------------------------------------------------------------
@app.route('/api/customers')
@require_admin
def api_customers():
    search = request.args.get('q')
    q = Customer.query
    if search:
        like = f'%{search}%'
        q = q.filter(db.or_(Customer.name.ilike(like), Customer.phone.ilike(like)))
    customers = q.all()

    result = []
    for c in customers:
        orders = Order.query.filter_by(customer_id=c.id).all()
        non_cancelled = [o for o in orders if o.status != 'cancelado']
        first_at = min((o.created_at for o in orders), default=None)
        last_at = max((o.created_at for o in orders), default=None)
        result.append(
            {
                'id': c.id,
                'name': c.name,
                'phone': c.phone,
                'address': c.address or '',
                'orders_count': len(orders),
                'total_spent': round(sum(money(o.total) for o in non_cancelled), 2),
                'first_order_at': first_at.isoformat() if first_at else None,
                'last_order_at': last_at.isoformat() if last_at else None,
            }
        )

    result.sort(key=lambda c: c['last_order_at'] or '', reverse=True)
    return jsonify(result)


# ---------------------------------------------------------------------
# API administrativa — relatórios (dashboard + fechamento)
# ---------------------------------------------------------------------
@app.route('/api/dashboard')
@require_admin
def dashboard():
    now = now_local()
    today_start = datetime(now.year, now.month, now.day)
    today = summarize_period(today_start, today_start + timedelta(days=1))

    open_orders = Order.query.filter(Order.status.in_(['novo', 'preparacao', 'pronto', 'entrega'])).count()

    revenue_by_day = []
    for i in range(13, -1, -1):
        day_start = today_start - timedelta(days=i)
        day_end = day_start + timedelta(days=1)
        day_orders = Order.query.filter(
            Order.created_at >= day_start, Order.created_at < day_end, Order.status != 'cancelado'
        ).all()
        revenue_by_day.append(
            {
                'day': day_start.strftime('%d/%m'),
                'revenue': round(sum(money(o.total) for o in day_orders), 2),
                'orders_count': len(day_orders),
            }
        )

    thirty_days_ago = today_start - timedelta(days=29)
    recent_orders = Order.query.filter(Order.created_at >= thirty_days_ago, Order.status != 'cancelado').all()
    product_qty = {}
    for o in recent_orders:
        for item in o.items:
            product_qty[item.product_name_snapshot] = product_qty.get(item.product_name_snapshot, 0) + item.quantity
    top_products = sorted(product_qty.items(), key=lambda x: x[1], reverse=True)[:8]

    orders_today = Order.query.filter(
        Order.created_at >= today_start, Order.created_at < today_start + timedelta(days=1)
    ).all()
    hours = {h: 0 for h in range(24)}
    for o in orders_today:
        hours[o.created_at.hour] += 1

    return jsonify(
        {
            'today': today,
            'open_orders': open_orders,
            'revenue_by_day': revenue_by_day,
            'top_products': [{'name': k, 'quantity': v} for k, v in top_products],
            'orders_by_hour': [{'hour': h, 'orders_count': c} for h, c in hours.items()],
        }
    )


@app.route('/api/closing')
@require_admin
def closing():
    period = request.args.get('period', 'hoje')
    try:
        start, end = resolve_period(period, request.args.get('from'), request.args.get('to'))
    except ValueError as err:
        return jsonify({'error': str(err)}), 400

    current = summarize_period(start, end)
    prev_start, prev_end = previous_period(start, end)
    previous = summarize_period(prev_start, prev_end)

    def pct_change(curr, prior):
        if prior == 0:
            return None
        return round(((curr - prior) / prior) * 100, 1)

    return jsonify(
        {
            'period': period,
            'range': {'start': start.isoformat(), 'end': end.isoformat()},
            'current': current,
            'previous': previous,
            'comparison': {
                'revenue_change_pct': pct_change(current['revenue'], previous['revenue']),
                'orders_change_pct': pct_change(current['orders_count'], previous['orders_count']),
                'ticket_change_pct': pct_change(current['average_ticket'], previous['average_ticket']),
            },
        }
    )


@app.route('/api/closing/export')
@require_admin
def closing_export():
    """Exporta o fechamento do período em CSV, já formatado para abrir
    corretamente no Excel em português (separador ; e vírgula decimal)."""
    period = request.args.get('period', 'hoje')
    try:
        start, end = resolve_period(period, request.args.get('from'), request.args.get('to'))
    except ValueError as err:
        return jsonify({'error': str(err)}), 400

    current = summarize_period(start, end)

    def fmt(v):
        return f'{v:.2f}'.replace('.', ',')

    output = io.StringIO()
    writer = csv.writer(output, delimiter=';')
    writer.writerow(['Fechamento — Cantinho Santos'])
    writer.writerow(['Período', f'{start.strftime("%d/%m/%Y")} a {(end - timedelta(days=1)).strftime("%d/%m/%Y")}'])
    writer.writerow([])
    writer.writerow(['Faturamento total', fmt(current['revenue'])])
    writer.writerow(['Quantidade de pedidos', current['orders_count']])
    writer.writerow(['Ticket médio', fmt(current['average_ticket'])])
    writer.writerow([])
    writer.writerow(['Forma de pagamento', 'Pedidos', 'Faturamento'])
    for p in current['by_payment_method']:
        writer.writerow([p['payment_label'], p['orders_count'], fmt(p['revenue'])])
    writer.writerow([])
    writer.writerow(['Produto', 'Quantidade', 'Faturamento'])
    for p in current['by_product']:
        writer.writerow([p['product_name'], p['quantity'], fmt(p['revenue'])])

    csv_bytes = ('\ufeff' + output.getvalue()).encode('utf-8')  # BOM: acentos corretos no Excel
    filename = f'fechamento_{period}_{now_local().strftime("%Y%m%d_%H%M")}.csv'
    return Response(
        csv_bytes,
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename={filename}'},
    )


# ---------------------------------------------------------------------
# Inicialização do banco + comando de seed
#
#   flask --app app.py seed
#
# Cria as tabelas (se não existirem) e, apenas se o banco estiver vazio,
# popula com um administrador e alguns dados de demonstração.
# ---------------------------------------------------------------------
@app.cli.command('seed')
def seed():
    """Cria/atualiza a estrutura inicial e sincroniza o cardápio.

    O comando pode ser executado novamente em uma instalação que já possui
    pedidos: produtos antigos são apenas desativados, nunca apagados, para
    preservar o histórico das vendas.
    """
    db.create_all()

    admin_exists = Admin.query.count() > 0
    if admin_exists:
        # O banco já existia antes do v5: corrige os timestamps UTC do v4 uma única vez.
        # (A função não faz nada fora do SQLite — ver docstring.)
        migrate_v4_utc_timestamps_once()
    if not admin_exists:
        admin_name = os.getenv('ADMIN_NAME', 'Dona da Lanchonete')
        admin_email = os.getenv('ADMIN_EMAIL', 'dona@lanchonete.com')
        admin_password = os.getenv('ADMIN_PASSWORD', 'lanchonete123')
        db.session.add(
            Admin(name=admin_name, email=admin_email, password_hash=generate_password_hash(admin_password))
        )

    category_specs = [
        ('Lanche', 1),
        ('Pastel', 2),
        ('Porção', 3),
        ('Batata Recheada', 4),
        ('Bebidas', 5),
    ]
    categories = {}
    for name, sort_order in category_specs:
        c = Category.query.filter_by(name=name).first()
        if not c:
            c = Category(name=name, sort_order=sort_order)
            db.session.add(c)
        else:
            c.sort_order = sort_order
            c.active = True
        categories[name] = c
    db.session.flush()

    # Cardápio informado pela proprietária. Os textos são mantidos próximos
    # ao material original para não inventar ingredientes.
    menu = [
        # Lanches
        ('X-Burguer', 'Pão de Hambúrguer, Hambúrguer, Presunto e Mussarela, Ketchup e maionese.', 14.50, 'Lanche'),
        ('X-Burguer Egg', 'Pão de hambúrguer, Hambúrguer, Ovo, Presunto e Mussarela, Ketchup e maionese.', 16.00, 'Lanche'),
        ('X-Salada Simples', 'Pão de Hambúrguer, Hambúrguer, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 17.00, 'Lanche'),
        ('X-Egg', 'Pão de Hambúrguer, Hambúrguer, Ovo, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 18.00, 'Lanche'),
        ('X-Salada Especial', 'Pão de Hambúrguer, Hambúrguer, Bacon e calabresa, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 23.00, 'Lanche'),
        ('X-Bacon', 'Pão de Hambúrguer, Hambúrguer, Bacon, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 22.00, 'Lanche'),
        ('X-Bacon Egg', 'Pão de Hambúrguer, Hambúrguer, Bacon, Ovo, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 23.00, 'Lanche'),
        ('X-Calabresa', 'Pão de Hambúrguer, Hambúrguer, Calabresa, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 20.00, 'Lanche'),
        ('X-Tudo', 'Pão de Hambúrguer, Hambúrguer, Bacon, Calabresa, Salsicha, Ovo, Frango, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 27.00, 'Lanche'),
        ('X-Santos', 'Pão de Hambúrguer, Hambúrguer, Frango e Bacon, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 24.00, 'Lanche'),
        ('X-Power', 'Pão de hambúrguer, Duplo Hambúrguer, Cebola, Tomate, Mussarela, molho Barbecue, Ketchup e maionese.', 22.00, 'Lanche'),
        ('X-Frango', 'Pão de Hambúrguer, Frango, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 22.00, 'Lanche'),
        ('X-Frango Burguer', 'Pão de Hambúrguer, Hambúrguer, Frango, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 23.50, 'Lanche'),
        ('X-Americano', 'Pão de Hambúrguer, Ovo, Presunto e Mussarela, milho, Alface e tomate, Ketchup e maionese.', 16.00, 'Lanche'),
        ('Hot Dog Simples', 'Pão de hambúrguer, Salsicha, Calabresa, milho, cebola, tomate, Ketchup e maionese.', 17.00, 'Lanche'),
        ('Hot Dog Especial', 'Pão de hambúrguer, Salsicha, Bacon, Calabresa, milho, tomate, cebola, Ketchup e maionese.', 20.00, 'Lanche'),
        ('Super Hot Goes', 'Pão de hambúrguer, Duplo Salsicha, Bacon, Calabresa, Mussarela, Catupiry, cebola, tomate, Ketchup e maionese.', 24.00, 'Lanche'),
        ('Piscina de Cheddar Burger Bacon', 'Duplo Hambúrguer, Duplo Bacon, Mussarela, molho Barbecue e a famosa piscina de cheddar.', 30.00, 'Lanche'),

        # Pastéis salgados
        ('Pastel de Carne', 'Carne.', 10.00, 'Pastel'),
        ('Pastel de Carne com Ovo', 'Carne com ovo.', 12.00, 'Pastel'),
        ('Pastel de Carne com Mussarela', 'Carne com mussarela.', 12.00, 'Pastel'),
        ('Pastel de Queijo', 'Queijo.', 12.00, 'Pastel'),
        ('Pastel Três Queijos', 'Três queijos.', 12.00, 'Pastel'),
        ('Pastel de Queijo com Tomate', 'Queijo com tomate.', 12.00, 'Pastel'),
        ('Pastel de Queijo com Milho', 'Queijo com milho.', 12.00, 'Pastel'),
        ('Pastel de Pizza', 'Pizza.', 12.00, 'Pastel'),
        ('Pastel de Calabresa com Mussarela', 'Calabresa com mussarela.', 12.00, 'Pastel'),
        ('Pastel de Calabresa', 'Calabresa.', 10.00, 'Pastel'),
        ('Pastel de Frango', 'Frango.', 10.00, 'Pastel'),
        ('Pastel de Frango com Mussarela', 'Frango com mussarela.', 12.00, 'Pastel'),
        ('Pastel de Frango com Catupiry', 'Frango com catupiry.', 12.00, 'Pastel'),
        ('Pastel de Frango com Cheddar', 'Frango com cheddar.', 12.00, 'Pastel'),
        ('Pastel de Strogonoff de Carne', 'Strogonoff de carne.', 13.00, 'Pastel'),
        ('Pastel de Strogonoff de Frango', 'Strogonoff de frango.', 13.00, 'Pastel'),
        ('Pastel Brócolis Especial', 'Brócolis, bacon, mussarela, presunto e catupiry.', 13.00, 'Pastel'),
        ('Pastel Goes', 'Mussarela, presunto, bacon, milho, tomate e orégano.', 13.00, 'Pastel'),
        # Pastéis doces — ficam separados visualmente no mesmo setor
        ('Pastel Doce de Creme de Avelã', 'Creme de avelã.', 14.00, 'Pastel'),
        ('Pastel Doce de Leite Ninho', 'Leite Ninho.', 14.00, 'Pastel'),

        # Batatas recheadas
        ('Batata Recheada Strogonoff de Carne', 'Strogonoff de carne. Todas as batatas vêm com opcional de cheddar ou catupiry.', 30.00, 'Batata Recheada'),
        ('Batata Recheada Strogonoff de Frango', 'Strogonoff de frango. Todas as batatas vêm com opcional de cheddar ou catupiry.', 30.00, 'Batata Recheada'),
        ('Batata Recheada Brócolis, Mussarela e Bacon', 'Brócolis, mussarela e bacon. Todas as batatas vêm com opcional de cheddar ou catupiry.', 30.00, 'Batata Recheada'),
        ('Batata Recheada Bolonhesa', 'Bolonhesa. Todas as batatas vêm com opcional de cheddar ou catupiry.', 25.00, 'Batata Recheada'),
        ('Batata Recheada Pizza', 'Pizza. Todas as batatas vêm com opcional de cheddar ou catupiry.', 25.00, 'Batata Recheada'),
        ('Batata Recheada Mussarela, Bacon e Milho', 'Mussarela, bacon e milho. Todas as batatas vêm com opcional de cheddar ou catupiry.', 25.00, 'Batata Recheada'),
        ('Batata Recheada Frango com Catupiry', 'Frango com catupiry. Todas as batatas vêm com opcional de cheddar ou catupiry.', 25.00, 'Batata Recheada'),
        ('Batata Recheada Frango com Cheddar', 'Frango com cheddar. Todas as batatas vêm com opcional de cheddar ou catupiry.', 25.00, 'Batata Recheada'),
    ]

    desired_names = set()
    for name, description, price, category_name in menu:
        desired_names.add(name)
        p = Product.query.filter_by(name=name).first()
        if not p:
            p = Product(name=name, category=categories[category_name])
            db.session.add(p)
        p.description = description
        p.price = Decimal(str(price))
        p.category = categories[category_name]
        p.active = True
        p.image_url = p.image_url or ''

    # Produtos antigos que não pertencem ao cardápio atual ficam inativos.
    # Isso preserva pedidos históricos sem exibi-los ao cliente.
    for p in Product.query.all():
        if p.name not in desired_names:
            p.active = False

    db.session.commit()

        # Banco recém-criado: os dados já nascem no horário de São Paulo.
    if not os.path.exists(_TIMEZONE_MIGRATION_MARKER):
        with open(_TIMEZONE_MIGRATION_MARKER, 'w', encoding='utf-8') as f:
            f.write('v5 timezone migration completed')

    print('Seed concluído com administrador e cardápio. Nenhum dado de demonstração foi criado.')


if __name__ == '__main__':
    debug_mode = not IS_PRODUCTION
    host = os.getenv('HOST', '127.0.0.1')
    port = int(os.getenv('PORT', 5000))
    print('\n' + '=' * 58)
    print('  Lanchonete MVP iniciado com sucesso!')
    print(f'  Acesse no navegador: http://{"127.0.0.1" if host == "0.0.0.0" else host}:{port}')
    if host == '0.0.0.0':
        print('  Também acessível por outros dispositivos na mesma rede.')
    if debug_mode:
        print('  ⚠ Modo DEBUG ligado — nunca use assim em produção (defina FLASK_DEBUG=false).')
    print('  Para encerrar: CTRL+C')
    print('=' * 58 + '\n')
    app.run(host=host, port=port, debug=debug_mode)
