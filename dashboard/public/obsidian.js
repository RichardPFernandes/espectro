// Botão "Abrir no Obsidian" (PRI-373), no pé do rail (#navFoot). Só aparece com PRISMA_OBSIDIAN=on:
// com a flag desligada GET /api/obsidian dá 404 e nada é desenhado. Sem vault, o botão mostra a pasta
// que vai criar (via POST /api/obsidian/export) antes de gravar. Script clássico; usa api, esc, $, toast.
(() => {
  let st = null, busy = false;
  const row = document.createElement('div');
  row.className = 'cfg-foot-row';
  row.hidden = true;
  $('navFoot').appendChild(row);

  function paint() {
    const label = busy ? 'Gerando o vault…' : st.ready ? 'Abrir no Obsidian' : 'Criar vault e abrir no Obsidian';
    row.innerHTML = `<button id="obsBtn" class="cfg-btn" type="button" ${busy ? 'disabled' : ''}
        title="${esc(st.ready ? st.vault : `Gera o vault em ${st.vault} e abre no Obsidian`)}">
        <span class="cfg-btn-label">${esc(label)}</span></button>`;
    $('obsBtn').addEventListener('click', go);
  }

  async function go() {
    try {
      if (!st.ready) {
        busy = true; paint();
        st = await api('/api/obsidian/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      }
      toast('Abrindo no Obsidian…');
      location.href = st.uri;
    } catch (e) {
      toast(`Obsidian: ${e.message}`);
    } finally {
      busy = false; paint();
    }
  }

  fetch('/api/obsidian').then(r => (r.ok ? r.json() : null)).then(s => { if (s) { st = s; row.hidden = false; paint(); } }).catch(() => {});
})();
