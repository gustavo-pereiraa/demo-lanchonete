// ------------------------------------------------------------------
// Faixa "Versão de demonstração" no topo de todas as páginas.
// A altura real da faixa (que pode quebrar em duas linhas no celular)
// vai para a variável --demo-bar-h, usada pelo CSS para empurrar o
// conteúdo e os cabeçalhos fixos para baixo — assim ela nunca cobre nada.
// ------------------------------------------------------------------
(function () {
  const bar = document.getElementById('demoBar');
  if (!bar) return;

  const root = document.documentElement;
  const sync = () => root.style.setProperty('--demo-bar-h', `${bar.offsetHeight}px`);
  sync();
  if ('ResizeObserver' in window) new ResizeObserver(sync).observe(bar);
  else window.addEventListener('resize', sync);
  document.fonts?.ready.then(sync);

  document.getElementById('demoReset')?.addEventListener('click', () => {
    if (!confirm('Reiniciar a demonstração? Tudo o que você fez aqui será apagado e os dados iniciais voltam.')) return;
    window.DemoAPI?.reset();
    // A página de acompanhamento aponta para um pedido que deixa de existir
    if (document.body.classList.contains('track-page')) window.location.replace('/');
    else window.location.reload();
  });
})();
