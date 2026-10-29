import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The OS opener sees only a private file URI, never the bearer capability.
export async function createBrowserLaunchFile(directory, url) {
  const match = typeof url === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/#token=([A-Za-z0-9_-]{43,128})$/.exec(url);
  if (!match || match[0] !== url || Number(match[1]) > 65535) throw new Error('Invalid private browser destination');
  const before = await fs.lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077) || (process.getuid && before.uid !== process.getuid())) throw new Error('Browser launch needs a private owned directory');
  const filename = path.join(directory, 'launch.html');
  const checkFile = async () => {
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe private browser launch file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  await checkFile();
  const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    // The strict URL grammar excludes HTML metacharacters; no script is needed.
    await handle.writeFile(`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><meta http-equiv="refresh" content="0;url=${url}"><title>T3 Code Local</title><p>Opening your local workspace.</p>\n`);
    await handle.sync();
  } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  finally { await handle.close(); }
  try {
    const after = await fs.lstat(directory);
    if (after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev || (after.mode & 0o077)) throw new Error('Private browser directory changed');
    await checkFile();
    await fs.rename(temporary, filename);
  } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  return { path: filename, uri: pathToFileURL(filename).href };
}
