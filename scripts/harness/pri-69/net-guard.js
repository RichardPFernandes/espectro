// Preload (NODE_OPTIONS=--require) de todo processo node da harness: watcher, agente
// falso, CLIs. Conexão de rede só para loopback; qualquer outra vira erro e uma linha em
// HARNESS_NET_LOG, que os testes exigem vazio. Redmine/Bitbucket/dashboard reais nunca
// são alcançáveis daqui, mesmo que alguma URL padrão (api.bitbucket.org) escape.
'use strict';
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const logFile = process.env.HARNESS_NET_LOG;

function blocked(where, host) {
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, where, host: String(host), argv: process.argv.slice(1, 3) });
    if (logFile) { try { fs.appendFileSync(logFile, line + '\n'); } catch {} }
    const err = new Error(`[harness net-guard] conexão bloqueada para ${host} (${where})`);
    err.code = 'HARNESS_NET_BLOCKED';
    return err;
}

function hostOfArgs(args) {
    const [a, b] = args;
    if (a && typeof a === 'object' && !Array.isArray(a)) {
        if (a.path && !a.host && !a.hostname) return null; // unix socket
        return a.hostname || a.host || 'localhost';
    }
    if (typeof a === 'number') return typeof b === 'string' ? b : 'localhost';
    if (typeof a === 'string' && !/^\d+$/.test(a)) return null; // unix socket path
    return 'localhost';
}

function guardConnect(mod, name) {
    const orig = mod[name];
    mod[name] = function guarded(...args) {
        const host = hostOfArgs(args);
        if (host !== null && !LOOPBACK.has(host)) throw blocked(`${mod === tls ? 'tls' : 'net'}.${name}`, host);
        return orig.apply(this, args);
    };
}
guardConnect(net, 'connect');
guardConnect(net, 'createConnection');
guardConnect(tls, 'connect');

function guardRequest(mod, label) {
    for (const name of ['request', 'get']) {
        const orig = mod[name];
        mod[name] = function guarded(input, ...rest) {
            let host = null;
            if (typeof input === 'string' || input instanceof URL) host = new URL(String(input)).hostname;
            else if (input && typeof input === 'object') host = input.hostname || input.host || 'localhost';
            if (host && !LOOPBACK.has(host.replace(/:\d+$/, ''))) throw blocked(`${label}.${name}`, host);
            return orig.call(this, input, ...rest);
        };
    }
}
guardRequest(http, 'http');
guardRequest(https, 'https');

if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async function guardedFetch(input, init) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        if (!LOOPBACK.has(url.hostname)) throw blocked('fetch', url.hostname);
        return origFetch(input, init);
    };
}
