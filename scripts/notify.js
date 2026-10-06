// Notificação proativa ao dev via webhook (NOTIFY_WEBHOOK_URL): PR aberto, PR draft
// HIGH-RISK e escalação pra humano — ver scripts/lib/cycle-notifications.js, que é quem
// decide QUANDO notificar. Payload no formato Slack Incoming Webhook (attachments), que
// qualquer endpoint que aceite POST JSON também recebe.
//
// Garantias (o watcher depende delas):
// - sem NOTIFY_WEBHOOK_URL: não faz nada e não loga nada;
// - nunca rejeita: erro de rede, timeout, URL inválida ou HTTP >= 400 viram um
//   console.warn e resolvem normalmente — notificação nunca derruba o ciclo;
// - teto de NOTIFY_TIMEOUT_MS (5 s) do início ao fim da chamada, não só inatividade;
// - a URL nunca é logada (o token do Slack/Discord mora no caminho dela).
//
// Resolve com { sent, status?, skipped?, error? } — o dashboard (POST /api/notify/test)
// mostra o status HTTP; o watcher ignora o retorno.
const https = require('https');
const http = require('http');

const NOTIFY_TIMEOUT_MS = 5000;

// Valor vazio ou só comentário ("#..." — o loadDotEnv do watcher não corta comentário
// na mesma linha) conta como não configurado.
function webhookUrlFromEnv(env = process.env) {
    const v = (env.NOTIFY_WEBHOOK_URL || '').trim();
    return v && !v.startsWith('#') ? v : null;
}

async function sendNotification(payload, { webhookUrl = webhookUrlFromEnv(), timeoutMs = NOTIFY_TIMEOUT_MS } = {}) {
    if (!webhookUrl) return { sent: false, skipped: true }; // silenciosamente ignorar se não configurado

    let url;
    try {
        url = new URL(webhookUrl);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`protocolo ${url.protocol} não suportado`);
    } catch (e) {
        console.warn(`[notify] NOTIFY_WEBHOOK_URL inválida (${e.message}) — notificação não enviada.`);
        return { sent: false, error: 'url_invalida' };
    }

    const body = JSON.stringify(payload);
    const mod = url.protocol === 'https:' ? https : http;

    return new Promise((resolve) => {
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(result);
        };
        // Teto total: req.setTimeout só mede inatividade do socket.
        const timer = setTimeout(() => {
            console.warn(`[notify] Falha ao enviar notificação: timeout após ${timeoutMs} ms.`);
            finish({ sent: false, error: 'timeout' });
            req.destroy();
        }, timeoutMs);
        timer.unref?.();

        let req;
        try {
            req = mod.request(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (res) => {
                res.resume();
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                if (!ok) console.warn(`[notify] Falha ao enviar notificação: HTTP ${res.statusCode}.`);
                finish({ sent: ok, status: res.statusCode });
            });
        } catch (err) {
            console.warn(`[notify] Falha ao enviar notificação: ${err.message}`);
            return finish({ sent: false, error: err.message });
        }
        req.on('error', (err) => {
            if (!done) console.warn(`[notify] Falha ao enviar notificação: ${err.message}`);
            finish({ sent: false, error: err.message }); // nunca falhar o ciclo por causa de notificação
        });
        req.write(body);
        req.end();
    });
}

// Formatos prontos para serviços comuns
function slackPayload({ title, message, color = 'good', url = null }) {
    const attachment = {
        fallback: `${title} — ${message}`,
        color,
        title,
        text: message,
        mrkdwn_in: ['text'],
        footer: 'Graph Engineering',
        ts: Math.floor(Date.now() / 1000),
    };
    if (url) attachment.title_link = url;
    return { attachments: [attachment] };
}

function genericPayload({ title, message, url = null, status }) {
    return { title, message, url, status, ts: new Date().toISOString() };
}

module.exports = { sendNotification, slackPayload, genericPayload, webhookUrlFromEnv, NOTIFY_TIMEOUT_MS };
