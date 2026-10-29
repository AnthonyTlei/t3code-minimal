#!/usr/bin/env node
import http from 'node:http';

const args = process.argv.slice(2);
const socketPath = args[0] === '--socket' ? args[1] : null;
const port = Number(process.env.T3_PORT || 3777);
if (!socketPath || args.length !== 2 || !Number.isInteger(port) || port < 1 || port > 65535) process.exitCode = 2;
else {
  const request = http.get({ socketPath, path: '/healthz', headers: { Host: `127.0.0.1:${port}` }, timeout: 3000 }, response => {
    let buffer = ''; response.setEncoding('utf8');
    response.on('data', chunk => { buffer += chunk; if (buffer.length > 4096) response.destroy(); });
    response.on('end', () => { try { const value = JSON.parse(buffer); process.exitCode = response.statusCode === 200 && value.status === 'ok' ? 0 : 1; } catch { process.exitCode = 1; } });
    response.on('error', () => { process.exitCode = 1; });
  });
  request.on('timeout', () => request.destroy()); request.on('error', () => { process.exitCode = 1; });
}
