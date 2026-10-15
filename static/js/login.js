// Feedback de envio no login: desabilita o botão para evitar cliques
// repetidos (o limite é de 10 tentativas por minuto) e mostra que está entrando.
document.getElementById('loginForm').addEventListener('submit', () => {
  const btn = document.getElementById('loginBtn');
  // Desabilita no próximo ciclo: desabilitar já no evento poderia cancelar o envio em alguns navegadores
  setTimeout(() => {
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Entrando…';
  }, 0);
});
