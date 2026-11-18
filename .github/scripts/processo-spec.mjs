// Leitura das SPECs alteradas no PR (HEAD). Separado do CLI para ser testável: processo-check.mjs roda main() ao ser importado.
import fs from 'node:fs';
import path from 'node:path';
import { matchesAny } from './processo-lib.mjs';

// Falha de leitura nunca derruba o check: vira linha de info em `skipped`.
// fetchJson(url, token) = GET na API do GitHub (gh, em processo-check.mjs).
export async function readSpecs(files, config, { local, root, repo, sha, token, fetchJson }) {
    const specs = [];
    const skipped = [];
    const globs = config.spec?.globs ?? [];
    for (const { filename } of files.filter((f) => f.status !== 'removed' && matchesAny(f.filename, globs, { ignoreCase: true }))) {
        try {
            if (local) {
                const full = path.join(root ?? process.cwd(), filename);
                if (!fs.existsSync(full)) throw new Error('arquivo não existe em --root');
                specs.push({ filename, content: fs.readFileSync(full, 'utf8') });
            } else {
                const enc = filename.split('/').map(encodeURIComponent).join('/');
                const res = await fetchJson(`/repos/${repo}/contents/${enc}?ref=${sha}`, token);
                if (res?.encoding !== 'base64') throw new Error(`encoding ${res?.encoding ?? 'ausente'} (arquivo grande demais?)`);
                specs.push({ filename, content: Buffer.from(res.content ?? '', 'base64').toString('utf8') });
            }
        } catch (e) {
            skipped.push(`não leu a SPEC ${filename} (${String(e.message).slice(0, 80)}); o aviso de AC ficou sem ela`);
        }
    }
    return { specs, skipped };
}
