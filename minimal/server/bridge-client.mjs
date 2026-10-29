#!/usr/bin/env node
import net from 'node:net';
import { pipeline } from 'node:stream';

const mode = process.argv[2];
if (!['http', 'broker'].includes(mode) || process.argv.length !== 3) {
  console.error('Select the http or broker local bridge.'); process.exitCode = 2;
} else {
  const socket = net.connect({ path: `/run/t3/${mode === 'http' ? 'http' : 'broker'}.sock` });
  const fail = () => { process.exitCode = 1; socket.destroy(); process.stdin.destroy(); };
  socket.on('error', fail); process.stdout.on('error', fail);
  socket.once('connect', () => {
    pipeline(process.stdin, socket, error => { if (error) fail(); });
    socket.pipe(process.stdout);
  });
  socket.once('close', () => { process.stdin.destroy(); });
}
