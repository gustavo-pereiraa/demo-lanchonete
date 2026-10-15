"""Simula o primeiro deploy em um banco que já tem dados da versão anterior:
as tabelas novas não existem, há pedidos reais, e a aplicação sobe."""
from sqlalchemy import inspect, text

from conftest import first_products, order_payload


def _snapshot(a):
    with a.app.app_context():
        tables = {}
        for name in ('admin', 'customer', 'category', 'product', 'order', 'order_item', 'order_status_history'):
            rows = a.db.session.execute(text(f'SELECT * FROM "{name}" ORDER BY id')).all()
            tables[name] = [tuple(r) for r in rows]
        cols = {t: [c['name'] for c in inspect(a.db.engine).get_columns(t)] for t in tables}
        return tables, cols


def test_tabelas_novas_criadas_sem_alterar_dados_existentes(appmod, client, admin):
    a = appmod
    ids = first_products(a, 3)
    for n in range(3):
        r = client.post('/api/orders', json=order_payload(ids[: n + 1], phone=f'1190000000{n}'))
        assert r.status_code == 201
    admin.put('/api/orders/1/status', json={'status': 'preparacao'})
    admin.post('/api/orders/presencial', json={'payment_method': 'dinheiro', 'items': [{'product_id': ids[0], 'quantity': 2}]})

    # Volta o banco ao "formato da versão anterior": sem as tabelas novas
    new_names = [t.name for t in a.new_tables()]
    with a.app.app_context():
        with a.db.engine.begin() as conn:
            for t in reversed(a.new_tables()):
                t.drop(conn, checkfirst=True)
        assert not set(new_names) & set(inspect(a.db.engine).get_table_names())
    before, cols_before = _snapshot(a)
    assert len(before['order']) == 4

    # "Deploy": worker novo (flag zerada) recebe a primeira requisição
    a._new_tables_ready = False
    a._channel_migration_checked = False
    r = client.get('/api/config')
    assert r.status_code == 200 and r.get_json()['store']['is_open'] is True

    with a.app.app_context():
        assert set(new_names) <= set(inspect(a.db.engine).get_table_names())
    after, cols_after = _snapshot(a)
    assert after == before            # nenhum dado existente mudou
    assert cols_after == cols_before  # nenhuma coluna existente mudou

    # Rodar de novo (outro worker) não falha nem duplica nada
    a._new_tables_ready = False
    assert client.get('/api/config').status_code == 200
    assert _snapshot(a)[0] == before
