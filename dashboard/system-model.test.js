// node --test system-model.test.js
// Regras da tela Sistema (public/system-model.js): o que cada elemento do artboard System mostra a
// partir das APIs. Sem leitura → UNKNOWN ou "—", nunca "ok" nem zero.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./public/system-model.js');

const NOW = Date.parse('2026-11-09T22:00:00Z');
const hhmm = iso => iso.slice(11, 16);
const base = { running: true, state: 'running', pid: null, uptime_ms: (6 * 60 + 12) * 60000, restarts: 0, restarts_last_hour: 0, max_restarts_per_hour: 3, error: null, phase: 'idle', tick_started_at: null, next_tick_at: new Date(NOW + 42000).toISOString(), interval_ms: 60000, ticks: 412, orphan_pid: null, last_run: null };

test('durLong e ago usam o formato do artboard', () => {
    assert.equal(M.durLong(45000), '45 s');
    assert.equal(M.durLong(12 * 60000), '12 min');
    assert.equal(M.durLong((6 * 60 + 12) * 60000), '6 h 12 min');
    assert.equal(M.durLong(50 * 3600000), '2 d 2 h');
    assert.equal(M.durLong(null), null);
    assert.equal(M.ago(new Date(NOW - 30000).toISOString(), NOW), 'agora');
    assert.equal(M.ago(new Date(NOW - 2 * 60000).toISOString(), NOW), 'há 2 min');
    assert.equal(M.ago(new Date(NOW - 2 * 3600000).toISOString(), NOW), 'há 2 h');
    assert.equal(M.ago(new Date(NOW - 30 * 3600000).toISOString(), NOW), 'ontem');
    assert.equal(M.ago(new Date(NOW - 3 * 86400000).toISOString(), NOW), 'há 3 dias');
    assert.equal(M.ago(undefined, NOW), null);
});

test('watcher ativo: cabeçalho, botões, fatos com fonte e ciclo do tick', () => {
    const w = M.watcher(base, {}, NOW, hhmm);
    assert.equal(w.label, 'ativo');
    assert.equal(w.tone, 'on');
    assert.equal(w.sub, 'PID entre ticks · uptime 6 h 12 min');
    assert.equal(w.startDisabled, true);
    assert.equal(w.stopDisabled, false);
    assert.deepEqual(w.facts.map(f => [f.k, f.v]), [['Ticks', '412'], ['Reinícios / hora', '0 de 3'], ['Intervalo', '60 s']]);
    assert.ok(w.facts.every(f => f.source === M.STATUS_SRC));
    assert.equal(w.crash, null);
    assert.match(w.note, /Até 3 reinícios automáticos por hora; no 4º crash/);
    assert.deepEqual(w.cycle, { pct: '30%', tone: 'on', left: 'tick 412 · 18 s · ocioso', right: 'próximo em 42 s', aria: 'Fase atual: ocioso, próximo tick em 42 segundos' });
    assert.equal(M.watcher({ ...base, pid: 4242 }, {}, NOW, hhmm).sub, 'PID 4242 · uptime 6 h 12 min');
});

test('watcher no meio de um tick', () => {
    const st = { ...base, phase: 'tick', pid: 99, tick_started_at: new Date(NOW - 15000).toISOString(), next_tick_at: null };
    const c = M.watcher(st, {}, NOW, hhmm).cycle;
    assert.equal(c.left, 'tick 412 · 15 s · lendo tasks e despachando');
    assert.equal(c.right, 'tick em andamento');
    assert.equal(c.pct, '100%', 'no tick a barra fica cheia; a legenda dá o tempo');
});

test('watcher parado e parado por crash', () => {
    const stopped = { ...base, running: false, state: 'stopped', uptime_ms: null, phase: null, next_tick_at: null, last_run: { ended_at: '2026-11-09T21:48:00Z', reason: 'stop' } };
    const w = M.watcher(stopped, {}, NOW, hhmm);
    assert.equal(w.label, 'parado');
    assert.equal(w.sub, 'parado às 21:48');
    assert.equal(w.startDisabled, false);
    assert.equal(w.stopDisabled, true);
    assert.equal(w.facts[0].v, '—', 'parado: ticks sem medição não viram 0');
    assert.deepEqual([w.cycle.left, w.cycle.right, w.cycle.tone], ['laço parado · último tick 412', 'sem próximo tick', 'off']);
    const crash = M.watcher({ ...stopped, error: 'restart_limit_reached', restarts_last_hour: 3, last_run: { ended_at: '2026-11-09T21:52:00Z', reason: 'restart_limit' } }, {}, NOW, hhmm);
    assert.equal(crash.label, 'parado por crash');
    assert.equal(crash.sub, 'parado às 21:52 · 4 crashes na última hora');
    assert.equal(crash.crash, 'Laço parado depois de 4 crashes em 1 hora.');
    assert.equal(crash.facts[1].v, '3 de 3');
});

test('watcher sem leitura: UNKNOWN, tudo desabilitado, fatos "—"', () => {
    for (const w of [M.watcher(null, {}, NOW), M.watcher(base, { reachable: false }, NOW)]) {
        assert.equal(w.label, 'UNKNOWN');
        assert.equal(w.tone, 'unknown');
        assert.equal(w.known, false);
        assert.ok(w.stopDisabled && w.restartDisabled);
        assert.ok(w.facts.every(f => f.v === '—'));
        assert.match(w.cycle.left, /^UNKNOWN/);
        assert.doesNotMatch(w.note, /Até/);
    }
    assert.match(M.watcher(base, { reachable: false }, NOW).sub, /sem resposta de GET \/api\/watcher\/status/);
    // Mesma regra do rail: sem resposta, tudo travado; antes do primeiro poll, Start liberado.
    assert.equal(M.watcher(base, { reachable: false }, NOW).startDisabled, true);
    assert.equal(M.watcher(null, {}, NOW).startDisabled, false);
});

test('watcher mudando de estado: botões travados enquanto a chamada não volta', () => {
    const w = M.watcher(base, { busy: 'restart' }, NOW);
    assert.equal(w.label, 'iniciando');
    assert.ok(w.startDisabled && w.stopDisabled && w.restartDisabled);
    assert.equal(M.watcher({ ...base, state: 'stopping', running: false }, {}, NOW).label, 'parando');
    const r = M.watcher({ ...base, state: 'restarting', restarts_last_hour: 2, next_tick_at: new Date(NOW + 5000).toISOString() }, {}, NOW);
    assert.equal(r.label, 'reiniciando');
    assert.equal(r.sub, 'reinício automático 2 de 3');
    assert.equal(r.cycle.right, 'reinício em 5 s');
});

test('log: níveis, Limpar e textos de vazio', () => {
    const lines = [{ seq: 1, level: 'INFO' }, { seq: 2, level: 'WARN' }, { seq: 3, level: 'ERROR' }];
    assert.deepEqual(M.logLines(lines, { WARN: false }).map(l => l.seq), [1, 3]);
    assert.deepEqual(M.logLines(lines, {}, 2).map(l => l.seq), [3]);
    assert.equal(M.logEmpty([], [], false), 'Sem linhas de log ainda.');
    assert.equal(M.logEmpty(lines, [], false), 'Nenhuma linha com os níveis selecionados.');
    assert.match(M.logEmpty(lines, [], true), /^Log limpo nesta tela/);
});

test('configuração: cards, filtro, ordem, contador da aba; sem relatório nada de zero', () => {
    const report = {
        contractVersion: 3, generatedAt: new Date(NOW - 2 * 60000).toISOString(), exitCode: 0,
        results: [
            { rule: 'graph.edges-valid', severity: 'error', passed: true, message: 'arestas válidas' },
            { rule: 'env.example-covers-keys', severity: 'warning', passed: false, message: 'PREVIEW_FRONT_PORT ausente' },
            { rule: 'hooks.registered', severity: 'warning', passed: true, message: 'hooks ok' },
        ],
    };
    const c = M.config(report, null, NOW);
    assert.equal(c.meta, 'contrato v3 · há 2 min');
    assert.deepEqual(c.counts, { ok: 2, warn: 1, err: 0 });
    assert.equal(c.tabCount, '1 aviso');
    assert.equal(c.tone, 'warn');
    assert.equal(c.rules[0].rule, 'env.example-covers-keys', 'falhas primeiro');
    assert.deepEqual(c.cards.map(k => [k.value, k.label, k.hint]), [[2, 'regras passaram', 'ver 2 regras →'], [1, 'aviso', 'ver 1 regra →'], [0, 'erros', 'ver 0 regras →']]);
    assert.ok(c.cards.every(k => k.source === M.CONFIG_SRC && !k.pressed));
    const f = M.config(report, 'warn', NOW);
    assert.equal(f.filterLabel, 'Avisos');
    assert.deepEqual(f.rules.map(r => r.tone), ['warn']);
    assert.equal(f.cards[1].pressed, true);
    assert.equal(f.cards[1].hint, 'filtrando · clique para limpar');
    assert.equal(M.config({ ...report, results: [{ rule: 'x', severity: 'error', passed: false, message: '' }, { rule: 'y', severity: 'error', passed: false, message: '' }] }, null, NOW).tabCount, '2 erros');
    assert.deepEqual(M.config(null), { known: false, tabCount: '' });
    assert.equal(M.config(report, 'bogus', NOW).filter, null);
});

test('abas e teclas: J/K presos às pontas; dígitos ficam com o atalho global', () => {
    const t = M.tabs('config', '1 aviso');
    assert.equal(t.pos, 'aba 2 de 2');
    assert.deepEqual(t.list.map(x => [x.id, x.key, x.selected, x.count]), [['watch', '1', false, ''], ['config', '2', true, '1 aviso']]);
    assert.equal(M.tabs('inexistente').id, 'watch');
    assert.equal(M.tabForKey('2', 'watch'), null);
    assert.equal(M.tabForKey('j', 'watch'), 'config');
    assert.equal(M.tabForKey('j', 'config'), 'config');
    assert.equal(M.tabForKey('k', 'watch'), 'watch');
    assert.equal(M.tabForKey('x', 'watch'), null);
});

test('sha ausente vira UNKNOWN', () => {
    assert.equal(M.short('a50ff9f0123'), 'a50ff9f');
    assert.equal(M.short(null), 'UNKNOWN');
});
