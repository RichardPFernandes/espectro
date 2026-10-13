'use strict';
// Preload da receita de testes (NODE_OPTIONS=--require=…, docs/runbook.md).
// Controle bounded de rede Node: conexões TCP apenas em loopback; não cobre
// subprocessos shell (curl, git) nem é sandbox universal.
const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const normalized = net._normalizeArgs(args)[0];
    const host = normalized.host || 'localhost';
    if (!normalized.path && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
        throw new Error('PRI-92: rede externa recusada pelo controle loopback');
    }
    return original.apply(this, args);
};
