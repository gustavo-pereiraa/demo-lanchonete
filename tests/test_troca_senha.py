import logging

from conftest import ADMIN_EMAIL, ADMIN_PASSWORD

URL = '/api/account/password'


def _change(c, current, new, confirm=None):
    return c.post(URL, json={'current_password': current, 'new_password': new,
                             'confirm_password': new if confirm is None else confirm})


def test_exige_login(client):
    assert _change(client, ADMIN_PASSWORD, 'nova-senha-123').status_code == 401


def test_validacoes(admin):
    r = _change(admin, 'errada-123', 'nova-senha-123')
    assert r.status_code == 400 and r.get_json()['field'] == 'current_password'
    r = _change(admin, ADMIN_PASSWORD, 'curta')
    assert r.status_code == 400 and r.get_json()['field'] == 'new_password'
    r = _change(admin, ADMIN_PASSWORD, ADMIN_PASSWORD)
    assert r.status_code == 400 and 'diferente' in r.get_json()['error']
    r = _change(admin, ADMIN_PASSWORD, 'nova-senha-123', 'outra-coisa-123')
    assert r.status_code == 400 and r.get_json()['field'] == 'confirm_password'


def test_sucesso_troca_hash_e_login(appmod, admin, caplog):
    caplog.set_level(logging.INFO, logger='cantinho_santos')
    r = _change(admin, ADMIN_PASSWORD, 'Nova Senha Forte 2026')
    assert r.status_code == 200 and r.get_json()['ok'] is True

    with appmod.app.app_context():
        h = appmod.Admin.query.filter_by(email=ADMIN_EMAIL).first().password_hash
        assert 'Nova Senha Forte 2026' not in h and h.startswith(('scrypt:', 'pbkdf2:'))

    # Nenhuma senha aparece nos logs; a troca é registrada
    assert 'Nova Senha Forte 2026' not in caplog.text and ADMIN_PASSWORD not in caplog.text
    assert 'Senha alterada' in caplog.text

    c = appmod.app.test_client()
    assert c.post('/admin/login', data={'email': ADMIN_EMAIL, 'password': ADMIN_PASSWORD}).status_code == 200  # senha antiga recusada
    r = c.post('/admin/login', data={'email': ADMIN_EMAIL, 'password': 'Nova Senha Forte 2026'})
    assert r.status_code == 302


def test_falha_registrada_sem_senha_no_log(admin, caplog):
    caplog.set_level(logging.INFO, logger='cantinho_santos')
    _change(admin, 'tentativa-secreta-1', 'nova-senha-123')
    assert 'Troca de senha falhou' in caplog.text and 'tentativa-secreta-1' not in caplog.text


def test_limite_de_tentativas(admin):
    codes = [_change(admin, 'errada-123', 'nova-senha-123').status_code for _ in range(6)]
    assert codes[:5] == [400] * 5 and codes[5] == 429
