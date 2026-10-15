from datetime import datetime

from conftest import first_products, order_payload


def _sold_out(admin, pid, value=True):
    return admin.put(f'/api/products/{pid}/sold-out', json={'sold_out': value})


def _product(client, pid, all_=False):
    data = client.get('/api/products' + ('?all=true' if all_ else '')).get_json()
    return next((p for p in data if p['id'] == pid), None)


def test_dia_operacional_vai_ate_as_5h(appmod):
    f = appmod.business_date
    assert str(f(datetime(2026, 10, 16, 23, 59))) == '2026-10-16'
    assert str(f(datetime(2026, 10, 17, 0, 30))) == '2026-10-16'   # madrugada ainda é sexta
    assert str(f(datetime(2026, 10, 17, 4, 59))) == '2026-10-16'
    assert str(f(datetime(2026, 10, 17, 5, 0))) == '2026-10-17'


def test_exige_login(appmod, client):
    pid = first_products(appmod, 1)[0]
    assert _sold_out(client, pid).status_code == 401


def test_esgotado_continua_no_cardapio_mas_e_recusado(appmod, client, admin):
    a, b = first_products(appmod, 2)
    r = _sold_out(admin, a)
    assert r.status_code == 200 and r.get_json()['sold_out'] is True
    assert _sold_out(admin, a).status_code == 200            # marcar de novo não duplica nem falha

    p = _product(client, a)
    assert p is not None and p['sold_out'] is True             # continua aparecendo
    assert _product(client, b)['sold_out'] is False

    r = client.post('/api/orders', json=order_payload([a, b]))
    assert r.status_code == 400
    body = r.get_json()
    assert body['code'] == 'products_unavailable'
    assert p['name'] in body['error']                          # diz QUAL produto
    assert body['unavailable'] == [{'product_id': a, 'name': p['name'], 'reason': 'sold_out'}]

    # Balcão também bloqueia, para manter consistência
    r = admin.post('/api/orders/presencial', json={'payment_method': 'pix', 'items': [{'product_id': a, 'quantity': 1}]})
    assert r.status_code == 400 and r.get_json()['code'] == 'products_unavailable'

    # Sem o item esgotado o pedido passa; desmarcando, volta a ser aceito
    assert client.post('/api/orders', json=order_payload([b])).status_code == 201
    assert _sold_out(admin, a, False).get_json()['sold_out'] is False
    assert client.post('/api/orders', json=order_payload([a], phone='11911112222')).status_code == 201


def test_produto_inativo_recusado_com_nome(appmod, client, admin):
    a = first_products(appmod, 1)[0]
    name = _product(client, a)['name']
    admin.put(f'/api/products/{a}', json={'active': False})
    r = client.post('/api/orders', json=order_payload([a]))
    assert r.status_code == 400 and name in r.get_json()['error']
    assert r.get_json()['unavailable'][0]['reason'] == 'inactive'


def test_volta_sozinho_no_dia_seguinte(appmod, client, admin, monkeypatch):
    a = first_products(appmod, 1)[0]
    monkeypatch.setattr(appmod, 'now_local', lambda: datetime(2026, 10, 16, 22, 0))
    _sold_out(admin, a)
    assert _product(client, a)['sold_out'] is True
    monkeypatch.setattr(appmod, 'now_local', lambda: datetime(2026, 10, 17, 1, 0))   # madrugada: ainda esgotado
    assert _product(client, a)['sold_out'] is True
    monkeypatch.setattr(appmod, 'now_local', lambda: datetime(2026, 10, 17, 9, 0))   # dia seguinte
    assert _product(client, a)['sold_out'] is False
    assert _product(admin, a, all_=True)['sold_out'] is False
    r = client.post('/api/orders', json=order_payload([a]))
    assert r.status_code == 201


def test_relatorios_e_historico_nao_mudam(appmod, client, admin):
    a = first_products(appmod, 1)[0]
    assert client.post('/api/orders', json=order_payload([a])).status_code == 201
    before = (admin.get('/api/closing?period=hoje').get_json()['current'], admin.get('/api/orders').get_json())
    _sold_out(admin, a)
    after = (admin.get('/api/closing?period=hoje').get_json()['current'], admin.get('/api/orders').get_json())
    assert before == after
