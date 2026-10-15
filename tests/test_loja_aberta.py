from datetime import datetime

from conftest import first_products, order_payload

# 2026-10-16 é uma sexta-feira (weekday 4)
FRI, SAT, SUN = 4, 5, 6


def hours(**days):
    return {wd: {'is_closed': False, 'open_time': o, 'close_time': c} for wd, (o, c) in days.items()}


def every_day(o, c, closed=()):
    return {wd: {'is_closed': wd in closed, 'open_time': o, 'close_time': c} for wd in range(7)}


def test_sem_configuracao_fica_aberta(appmod):
    s = appmod.compute_store_status(datetime(2026, 10, 16, 3, 0), 'auto', {})
    assert s['is_open'] and s['reason'] == 'not_configured'


def test_modos_manuais_ignoram_o_horario(appmod):
    h = every_day('18:00', '23:00')
    noon = datetime(2026, 10, 16, 12, 0)
    assert appmod.compute_store_status(noon, 'open', h)['is_open'] is True
    late = datetime(2026, 10, 16, 20, 0)
    s = appmod.compute_store_status(late, 'closed', h)
    assert s['is_open'] is False and s['reason'] == 'manual_closed'


def test_horario_normal(appmod):
    h = every_day('18:00', '23:00')
    f = appmod.compute_store_status
    assert f(datetime(2026, 10, 16, 17, 59), 'auto', h)['is_open'] is False
    assert f(datetime(2026, 10, 16, 18, 0), 'auto', h)['is_open'] is True
    assert f(datetime(2026, 10, 16, 22, 59), 'auto', h)['is_open'] is True
    assert f(datetime(2026, 10, 16, 23, 0), 'auto', h)['is_open'] is False


def test_horario_atravessa_meia_noite(appmod):
    # Sexta 18:00 às 00:30; sábado FECHADO. Às 00:15 de sábado ainda vale a sexta.
    h = every_day('18:00', '00:30', closed=(SAT,))
    f = appmod.compute_store_status
    s = f(datetime(2026, 10, 17, 0, 15), 'auto', h)
    assert s['is_open'] is True and s['closes_at_label'] == '00:30'
    s = f(datetime(2026, 10, 17, 0, 31), 'auto', h)
    assert s['is_open'] is False
    # Sábado fechado: a próxima abertura é domingo às 18:00
    assert s['next_open'] == '2026-10-18T18:00:00'
    assert s['next_open_label'] == 'amanhã às 18:00'
    # Sexta 23:50 ainda aberta
    assert f(datetime(2026, 10, 16, 23, 50), 'auto', h)['is_open'] is True


def test_dia_fechado_e_rotulo_da_proxima_abertura(appmod):
    h = every_day('18:00', '23:00', closed=(SAT, SUN))
    f = appmod.compute_store_status
    s = f(datetime(2026, 10, 16, 10, 0), 'auto', h)          # sexta de manhã
    assert s['is_open'] is False and s['next_open_label'] == 'hoje às 18:00'
    s = f(datetime(2026, 10, 17, 20, 0), 'auto', h)          # sábado (fechado)
    assert s['is_open'] is False and s['next_open_label'] == 'segunda às 18:00'


def test_todos_os_dias_fechados_nao_tem_proxima_abertura(appmod):
    h = every_day('18:00', '23:00', closed=range(7))
    s = appmod.compute_store_status(datetime(2026, 10, 16, 20, 0), 'auto', h)
    assert s['is_open'] is False and s['next_open'] is None


def test_api_config_informa_loja_aberta_por_padrao(client):
    r = client.get('/api/config')
    assert r.status_code == 200
    data = r.get_json()
    assert data['delivery_fee'] == 5.0
    assert data['store']['is_open'] is True


def test_rotas_da_loja_exigem_login(client):
    assert client.get('/api/store').status_code == 401
    assert client.put('/api/store/mode', json={'mode': 'closed'}).status_code == 401
    assert client.put('/api/store/hours', json={'hours': []}).status_code == 401


def test_pedido_no_site_recusado_com_loja_fechada_e_balcao_aceito(appmod, client, admin):
    ids = first_products(appmod)
    r = admin.put('/api/store/mode', json={'mode': 'closed', 'message': 'Falta de gás hoje'})
    assert r.status_code == 200 and r.get_json()['status']['is_open'] is False

    r = client.post('/api/orders', json=order_payload(ids))
    assert r.status_code == 409
    body = r.get_json()
    assert body['code'] == 'store_closed' and 'fechados' in body['error']
    assert body['store']['message'] == 'Falta de gás hoje'
    with appmod.app.app_context():
        assert appmod.Order.query.count() == 0

    r = admin.post('/api/orders/presencial', json={'payment_method': 'pix', 'items': [{'product_id': ids[0], 'quantity': 1}]})
    assert r.status_code == 201

    # Reabrindo manualmente, o site volta a aceitar
    admin.put('/api/store/mode', json={'mode': 'open'})
    r = client.post('/api/orders', json=order_payload(ids))
    assert r.status_code == 201


def test_salvar_horarios_valida_e_persiste(appmod, admin):
    week = [{'weekday': wd, 'is_closed': wd == SUN, 'open_time': '18:00', 'close_time': '00:30'} for wd in range(7)]
    r = admin.put('/api/store/hours', json={'hours': week})
    assert r.status_code == 200
    data = r.get_json()
    assert data['configured'] is True
    assert data['hours'][SUN]['is_closed'] is True and data['hours'][FRI]['close_time'] == '00:30'

    bad = [dict(d) for d in week]
    bad[0]['close_time'] = '18:00'
    r = admin.put('/api/store/hours', json={'hours': bad})
    assert r.status_code == 400 and 'iguais' in r.get_json()['error']

    bad[0]['close_time'] = '25:00'
    assert admin.put('/api/store/hours', json={'hours': bad}).status_code == 400
    assert admin.put('/api/store/hours', json={'hours': week[:6]}).status_code == 400
    assert admin.put('/api/store/mode', json={'mode': 'talvez'}).status_code == 400
    assert admin.put('/api/store/mode', json={'message': 'x' * 161}).status_code == 400
