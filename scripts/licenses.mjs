import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const frontend = ['react', 'react-dom', '@base-ui/react', 'class-variance-authority', 'tailwind-merge', 'lucide-react'];
const visited = new Set(); const notices = ['Third-party notices for bundled frontend code\nUpstream T3 code: see LICENSE and minimal/web/UPSTREAM.md.\n'];
async function locate(name, parent) {
  const require = createRequire(path.join(parent, 'package.json'));
  for (const modules of require.resolve.paths(name) || []) {
    const directory = path.join(modules, name);
    try { const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); if (metadata.name === name) return { directory, metadata }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let directory = path.dirname(require.resolve(name));
  for (;;) {
    try { const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); if (metadata.name === name) return { directory, metadata }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = path.dirname(directory); if (next === directory) throw new Error(`No license metadata for ${name}`); directory = next;
  }
}
async function include(name, parent) {
  const { directory, metadata } = await locate(name, parent); const key = `${metadata.name}@${metadata.version}`;
  if (visited.has(key)) return; visited.add(key);
  const files = (await fs.readdir(directory)).filter(file => /^(licen[cs]e|notice|copying)(\.|$)/i.test(file)).sort();
  if (!files.length) throw new Error(`Missing license notice for ${key}`);
  notices.push(`\n${'='.repeat(72)}\n${key}\nLicense: ${metadata.license || 'see notice'}\n`);
  for (const file of files) notices.push(await fs.readFile(path.join(directory, file), 'utf8'));
  for (const dependency of Object.keys(metadata.dependencies || {}).sort()) await include(dependency, directory);
}
for (const name of frontend) await include(name, root);
await fs.mkdir(path.join(root, 'dist'), { recursive: true });
await fs.writeFile(path.join(root, 'dist', 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
console.log(`Bundled frontend notices: ${visited.size} packages`);
