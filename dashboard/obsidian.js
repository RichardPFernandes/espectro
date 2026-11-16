'use strict';
// Botão "Abrir no Obsidian" (PRI-373). Abre o vault gerado por scripts/obsidian-export.js e, se ele
// ainda não existe, gera. Atrás de PRISMA_OBSIDIAN=on: desligado (padrão), nenhuma rota é montada.
// O dashboard nunca grava no vault: quem grava é o exportador, por processo (como replay-cycle.js),
// que só escreve em pasta vazia ou em vault dele e recusa pasta dentro do repositório.
//
//   GET  /api/obsidian         → { vault, ready, uri }   (ready = a pasta tem o marcador do exportador)
//   POST /api/obsidian/export  → gera (ou atualiza) o vault em { vault? } e guarda a pasta nas prefs
//
// Rotas ficam atrás do filtro de localhost e do modo somente leitura do server.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MARKER = '.espectro-vault.json';
const defaultDir = () => path.join(os.homedir(), 'Vaults', 'espectro');
const isVault = (dir) => { try { return fs.statSync(path.join(dir, MARKER)).isFile(); } catch { return false; } };
const obsidianUri = (dir) => `obsidian://open?path=${encodeURIComponent(dir)}`;

function createObsidian({ env = {}, prefsFile, prismaRoot, exportFn, log = console }) {
    const flag = env.PRISMA_OBSIDIAN;
    if (flag !== undefined && flag !== '' && !['on', 'off'].includes(flag)) log.warn(`[obsidian] PRISMA_OBSIDIAN=${flag} não é on/off; tratado como off`);
    const enabled = flag === 'on';
    const readPrefs = () => { try { const p = JSON.parse(fs.readFileSync(prefsFile, 'utf8')); return p && typeof p === 'object' ? p : {}; } catch { return {}; } };
    const run = exportFn || ((out) => new Promise((resolve, reject) => execFile(
        process.execPath, [path.join(prismaRoot, 'scripts', 'obsidian-export.js'), '--out', out],
        { cwd: prismaRoot, timeout: 120000 },
        (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim())),
    )));
    const state = () => {
        const salvo = readPrefs().obsidian_vault;
        const vault = typeof salvo === 'string' && path.isAbsolute(salvo) ? salvo : defaultDir();
        const ready = isVault(vault);
        return { vault, ready, uri: ready ? obsidianUri(vault) : null };
    };
    let busy = false;

    function mount(app) {
        if (!enabled) return;
        app.get('/api/obsidian', (req, res) => res.json(state()));
        app.post('/api/obsidian/export', async (req, res) => {
            const vault = req.body?.vault ?? state().vault;
            if (typeof vault !== 'string' || !path.isAbsolute(vault)) return res.status(400).json({ error: 'vault deve ser um caminho absoluto' });
            if (busy) return res.status(409).json({ error: 'exportação em andamento' });
            busy = true;
            try {
                await run(path.resolve(vault));
                fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
                fs.writeFileSync(prefsFile, JSON.stringify({ ...readPrefs(), obsidian_vault: path.resolve(vault) }, null, 2));
                res.json(state());
            } catch (e) {
                res.status(422).json({ error: e.message });
            } finally {
                busy = false;
            }
        });
    }
    return { mount, state, enabled };
}

module.exports = { createObsidian, isVault, obsidianUri, MARKER };
