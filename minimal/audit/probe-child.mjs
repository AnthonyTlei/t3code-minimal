import net from 'node:net';
import { Resolver } from 'node:dns/promises';

const { httpPort, dnsPort } = JSON.parse(process.argv[2]);
const results = { pid: process.pid, role: 'positive-control-descendant' };
const localResolver = new Resolver({ timeout: 200, tries: 1 });
localResolver.setServers([`127.0.0.1:${dnsPort}`]);
results.successfulDns = await localResolver.resolve4('local.t3-audit.invalid');
const blockedResolver = new Resolver({ timeout: 200, tries: 1 });
blockedResolver.setServers(['198.51.100.53']);
try { await blockedResolver.resolve4('blocked.t3-audit.invalid'); results.blockedDns = 'UNEXPECTED_SUCCESS'; }
catch (error) { results.blockedDns = error.code; }
results.blockedTcp = await new Promise(resolve => {
  const socket = net.createConnection({ host: '198.51.100.42', port: 443 });
  socket.once('error', error => resolve(error.code));
  socket.once('connect', () => { resolve('UNEXPECTED_SUCCESS'); socket.destroy(); });
  socket.setTimeout(1000, () => { resolve('ETIMEDOUT'); socket.destroy(); });
});
const response = await fetch(`http://127.0.0.1:${httpPort}/redirect`);
results.redirect = { status: response.status, redirected: response.redirected, text: await response.text() };
results.websocket = await new Promise(resolve => {
  const socket = new WebSocket(`ws://127.0.0.1:${httpPort}/ws`);
  socket.addEventListener('open', () => { resolve('opened'); socket.close(1000); }, { once: true });
  socket.addEventListener('error', () => resolve('error'), { once: true });
});
try { await fetch(`http://127.0.0.1:${httpPort}/redirect-blocked`); results.blockedRedirect = 'UNEXPECTED_SUCCESS'; }
catch (error) { results.blockedRedirect = error.cause?.code || error.name; }
results.blockedWebsocket = await new Promise(resolve => {
  const socket = new WebSocket('ws://198.51.100.44:8080/ws');
  socket.addEventListener('open', () => { resolve('UNEXPECTED_SUCCESS'); socket.close(); }, { once: true });
  socket.addEventListener('error', () => resolve('error'), { once: true });
});
process.send(results, () => process.disconnect());
