from conftest import first_products, order_payload


def _create(client, appmod, **extra):
    r = client.post('/api/orders', json=order_payload(first_products(appmod), **extra))
    assert r.status_code == 201
    return r.get_json()


def test_criacao_devolve_token_aditivo(appmod, client):
    data = _create(client, appmod)
    assert 'order' in data and data['order']['id'] == 1          # contrato antigo intacto
    assert len(data['tracking_token']) >= 22                      # 18 bytes em base64
    assert data['tracking_url'] == f"/acompanhar/{data['tracking_token']}"


def test_token_valido_mostra_somente_o_necessario(appmod, client):
    data = _create(client, appmod, name='Maria da Silva Souza', phone='11987654321',
                   address='Rua das Flores, 123, apto 45, Jardim Paulista')
    token = data['tracking_token']
    assert client.get(f'/acompanhar/{token}').status_code == 200
    r = client.get(f'/api/track/{token}')
    assert r.status_code == 200
    d = r.get_json()
    assert d['number'] == 1 and d['headline'] == 'Recebemos seu pedido'
    assert d['customer_first_name'] == 'Maria'
    assert d['address_summary'] == 'Rua das Flores'
    body = r.get_data(as_text=True)
    for secret in ('987654321', 'Silva', '123', 'apto', 'Jardim'):
        assert secret not in body
    assert [s['key'] for s in d['steps']] == ['novo', 'preparacao', 'pronto', 'entrega', 'finalizado']
    assert d['steps'][0]['current'] and d['steps'][0]['at']


def test_token_invalido_ou_id_da_404(appmod, client):
    _create(client, appmod)
    for bad in ('1', '00000000000000000000000', 'x' * 30, '%3Cscript%3E'):
        assert client.get(f'/acompanhar/{bad}').status_code == 404
        assert client.get(f'/api/track/{bad}').status_code == 404


def test_retirada_nao_tem_etapa_de_entrega_e_linha_do_tempo(appmod, client, admin):
    data = _create(client, appmod, order_type='retirada', address='')
    oid, token = data['order']['id'], data['tracking_token']
    admin.put(f'/api/orders/{oid}/status', json={'status': 'preparacao'})
    admin.put(f'/api/orders/{oid}/status', json={'status': 'pronto'})
    d = client.get(f'/api/track/{token}').get_json()
    assert [s['key'] for s in d['steps']] == ['novo', 'preparacao', 'pronto', 'finalizado']
    assert d['headline'] == 'Pronto para retirada' and d['address_summary'] == ''
    assert [s['done'] for s in d['steps']] == [True, True, True, False]
    assert all(s['at'] for s in d['steps'][:3]) and d['is_final'] is False

    admin.put(f'/api/orders/{oid}/status', json={'status': 'finalizado'})
    d = client.get(f'/api/track/{token}').get_json()
    assert d['is_final'] and d['headline'] == 'Pedido retirado'


def test_cancelado_orienta_contato(appmod, client, admin):
    data = _create(client, appmod)
    admin.put(f"/api/orders/{data['order']['id']}/status", json={'status': 'cancelado'})
    d = client.get(f"/api/track/{data['tracking_token']}").get_json()
    assert d['is_cancelled'] and d['is_final'] and d['headline'] == 'Pedido cancelado'
    page = client.get(f"/acompanhar/{data['tracking_token']}").get_data(as_text=True)
    assert 'entre em contato com a lanchonete' in page


def test_pedido_antigo_sem_token_nao_quebra(appmod, client, admin):
    data = _create(client, appmod)
    with appmod.app.app_context():
        appmod.db.session.delete(appmod.db.session.get(appmod.OrderTracking, data['order']['id']))
        appmod.db.session.commit()
    assert client.get(f"/api/track/{data['tracking_token']}").status_code == 404
    assert admin.get(f"/api/orders/{data['order']['id']}").status_code == 200


def test_limite_de_requisicoes_no_acompanhamento(appmod, client):
    token = _create(client, appmod)['tracking_token']
    codes = [client.get(f'/api/track/{token}').status_code for _ in range(31)]
    assert codes[:30] == [200] * 30 and codes[30] == 429
