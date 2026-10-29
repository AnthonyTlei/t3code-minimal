#!/usr/bin/env node
// Private IPC for the local host controller. Never used by logs or health checks.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';

if (process.argv.length !== 2) process.exitCode = 2;
else {
  let handle;
  try {
    handle = await fs.open('/data/private/connection.json', constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4096) throw new Error('Unsafe private connection file');
    const value = JSON.parse(await handle.readFile('utf8'));
    if (Object.keys(value).length !== 1 || typeof value.url !== 'string') throw new Error('Invalid private connection file');
    process.stdout.write(JSON.stringify(value) + '\n');
  } catch { console.error('Private wrapper connection is unavailable.'); process.exitCode = 1; }
  finally { await handle?.close(); }
}
