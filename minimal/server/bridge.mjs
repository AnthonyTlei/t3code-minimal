import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const MAX_FRAME = 1024 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export async function privateSocket(socketPath) {
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) throw new Error('Use a short absolute private socket path');
  const directory = path.dirname(socketPath);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Socket parent must be a private directory owned by this user');
  try { await fs.lstat(socketPath); throw new Error('Socket path already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export class HostBridge extends EventEmitter {
  static async listen(socketPath) {
    await privateSocket(socketPath);
    const bridge = new HostBridge();
    bridge.server = net.createServer(socket => bridge.attach(socket));
    await new Promise((resolve, reject) => { bridge.server.once('error', reject); bridge.server.listen(socketPath, resolve); });
    await fs.chmod(socketPath, 0o600);
    return bridge;
  }

  constructor() { super(); this.gateway = null; this.children = new Map(); this.closed = false; }
  get ready() { return Boolean(this.gateway && !this.gateway.destroyed && !this.closed); }
  send(message) {
    if (!this.ready) throw new Error('The local host bridge is not connected');
    const data = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(data) > MAX_FRAME || this.gateway.writableLength + Buffer.byteLength(data) > MAX_BUFFER) {
      // Disconnect also tells the host supervisor to stop its owned CLI sessions.
      this.gateway.destroy();
      throw new Error('The local host bridge exceeded its buffer limit');
    }
    this.gateway.write(data);
  }

  attach(socket) {
    if (this.closed || this.ready) { socket.destroy(); return; }
    this.gateway = socket; let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME * 2) { socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error('Frame limit');
          const message = JSON.parse(frame);
          if (!object(message) || typeof message.id !== 'string' || !['opened', 'stdout', 'exit', 'failure'].includes(message.type)) throw new Error('Invalid host response');
          const child = this.children.get(message.id); if (!child) continue;
          if (message.type === 'opened') child.opened();
          else if (message.type === 'stdout') {
            if (typeof message.data !== 'string' || message.data.length > MAX_CHUNK * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) throw new Error('Invalid host output');
            const data = Buffer.from(message.data, 'base64');
            if (data.length > MAX_CHUNK || child.stdout.readableLength + data.length > MAX_BUFFER) throw new Error('Output limit');
            child.stdout.write(data);
          } else if (message.type === 'exit') child.finish(Number.isInteger(message.code) ? message.code : null, typeof message.signal === 'string' ? message.signal : null);
          else child.finish(null, null, new Error('The host could not start or continue the approved CLI'));
        } catch { socket.destroy(); return; }
      }
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      if (this.gateway !== socket) return;
      this.gateway = null;
      for (const child of [...this.children.values()]) child.finish(null, null, new Error('The local host bridge disconnected; no work was retried'));
    });
    this.send({ type: 'ready' });
  }

  open({ cwd }) {
    if (!this.ready) return Promise.reject(new Error('Start the local host bridge before sending work'));
    if (this.children.size >= 32) return Promise.reject(new Error('Too many active CLI sessions'));
    const id = randomUUID(); const child = new EventEmitter();
    child.pid = `host-bridge:${id}`; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let settled = false; let ended = false; let timer;
    child.stdin = new Writable({
      write: (chunk, encoding, done) => {
        try {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
          for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK) this.send({ type: 'stdin', id, data: bytes.subarray(offset, offset + MAX_CHUNK).toString('base64') });
          done();
        } catch (error) { done(error); }
      },
      final: done => { try { this.send({ type: 'eof', id }); done(); } catch (error) { done(error); } },
    });
    child.kill = signal => { try { this.send({ type: 'signal', id, signal }); return true; } catch { child.finish(null, null); return false; } };
    const result = new Promise((resolve, reject) => {
      child.opened = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(child); } };
      child.finish = (code, signal, error) => {
        if (ended) return; ended = true; clearTimeout(timer); this.children.delete(id);
        if (!settled) { settled = true; reject(error || new Error('The host CLI exited before it opened')); }
        child.stdout.end(); child.stderr.end();
        queueMicrotask(() => { child.emit('exit', code, signal); child.emit('close', code, signal); });
      };
      timer = setTimeout(() => { child.kill('SIGTERM'); child.finish(null, null, new Error('The local host bridge did not start the CLI')); }, 30_000); timer.unref();
    });
    this.children.set(id, child);
    try { this.send({ type: 'open', id, cwd }); } catch (error) { child.finish(null, null, error); }
    return result;
  }

  async close() {
    if (this.closed) return;
    for (const child of this.children.values()) child.kill('SIGTERM');
    this.closed = true; this.gateway?.destroy();
    for (const child of [...this.children.values()]) child.finish(null, null);
    await new Promise(resolve => this.server.close(resolve));
  }
}
