"""Configuração dos testes: SEMPRE em um SQLite temporário.

As variáveis abaixo são definidas antes de importar o app. Como o
load_dotenv não sobrescreve variáveis já existentes, o DATABASE_URL do
.env (banco de produção no Supabase) nunca é usado aqui.
"""
import os
import sys
import tempfile

import pytest

_TMP = tempfile.mkdtemp(prefix='cantinho_testes_')
_DB_PATH = os.path.join(_TMP, 'teste.db').replace('\\', '/')
os.environ['DATABASE_URL'] = f'sqlite:///{_DB_PATH}'
os.environ['ADMIN_EMAIL'] = 'dona@teste.local'
os.environ['ADMIN_PASSWORD'] = 'senha-de-teste-123'
os.environ['ADMIN_NAME'] = 'Dona Teste'
os.environ['DELIVERY_FEE'] = '5.00'
os.environ['FLASK_DEBUG'] = 'true'

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app as app_module  # noqa: E402

# Trava de segurança: se por qualquer motivo o banco não for o SQLite
# temporário, os testes param antes de tocar em qualquer dado.
assert app_module.DB_URL == f'sqlite:///{_DB_PATH}', 'Os testes só podem rodar no SQLite temporário.'

# Os marcadores das migrações antigas ficam na pasta temporária, nunca em instance/
app_module._TIMEZONE_MIGRATION_MARKER = os.path.join(_TMP, '.v5_timezone_fixed')
app_module._CHANNEL_MIGRATION_MARKER = os.path.join(_TMP, '.v7_channel_added')
app_module.app.config['TESTING'] = True
app_module.app.config['SESSION_COOKIE_SECURE'] = False

ADMIN_EMAIL = os.environ['ADMIN_EMAIL']
ADMIN_PASSWORD = os.environ['ADMIN_PASSWORD']


@pytest.fixture()
def appmod():
    """Banco zerado + seed a cada teste."""
    a = app_module
    with a.app.app_context():
        a.db.session.remove()
        a.db.drop_all()
    a._new_tables_ready = False
    a._timezone_migration_checked = False
    a._channel_migration_checked = False
    result = a.app.test_cli_runner().invoke(args=['seed'])
    assert result.exit_code == 0, result.output
    a.limiter.reset()
    yield a
    with a.app.app_context():
        a.db.session.remove()


@pytest.fixture()
def client(appmod):
    return appmod.app.test_client()


@pytest.fixture()
def admin(appmod):
    c = appmod.app.test_client()
    r = c.post('/admin/login', data={'email': ADMIN_EMAIL, 'password': ADMIN_PASSWORD})
    assert r.status_code == 302 and r.headers['Location'].endswith('/admin')
    return c


def first_products(appmod, n=2):
    with appmod.app.app_context():
        return [p.id for p in appmod.Product.query.filter_by(active=True).order_by(appmod.Product.id).limit(n)]


def order_payload(product_ids, **extra):
    data = {
        'name': 'Maria Teste',
        'phone': '11999990000',
        'order_type': 'entrega',
        'address': 'Rua das Flores, 123, Centro',
        'payment_method': 'pix',
        'items': [{'product_id': pid, 'quantity': 1} for pid in product_ids],
    }
    data.update(extra)
    return data
