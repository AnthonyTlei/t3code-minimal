import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const startupDirectory = process.cwd();

export async function resolveExecutable(command, searchPath = process.env.PATH ?? '') {
  if (typeof command !== 'string' || !command || command.includes('\0')) throw new Error('Invalid executable');
  const explicit = path.isAbsolute(command) || command.includes(path.sep);
  const candidates = explicit ? [path.resolve(startupDirectory, command)] : searchPath.split(path.delimiter).filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      const canonical = await fs.realpath(candidate);
      if (!(await fs.stat(canonical)).isFile()) continue;
      await fs.access(canonical, constants.X_OK);
      return canonical;
    } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  const error = new Error('The configured executable was not found in an absolute PATH directory. Select its approved absolute path.');
  error.code = 'EXECUTABLE_UNAVAILABLE'; throw error;
}
