import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Writers publish complete siblings by rename; readers never inspect temporary names. */
export function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { flag: 'wx' });
  renameSync(temporary, path);
}

export function assertFreshRun(runDir) {
  for (const name of ['state.json', 'rounds', 'moderator', 'veto', 'synthesis.md', 'final.md', 'events.log', 'result.json']) {
    if (existsSync(join(runDir, name))) throw new Error(`Refusing a reused run directory: it was already used (${name} exists)`);
  }
}

// A moderator file is read only once its size has stopped changing, as a second
// guard behind the atomic tmp + mv the moderator is asked to use.
export async function waitForFile(path, timeoutMs, { signal, pollMs = 100, settleMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    let size = null;
    try { size = statSync(path).size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (size !== null) {
      await delay(Math.min(settleMs, Math.max(0, deadline - Date.now())), undefined, { signal });
      try {
        if (statSync(path).size === size) return readFileSync(path, 'utf8');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await delay(Math.min(pollMs, remaining), undefined, { signal });
  }
}

function contains(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
const digest = value => createHash('sha256').update(value).digest('hex');
export function fingerprint(cwd, runDir) {
  cwd = resolve(cwd);
  const excluded = runDir ? resolve(runDir) : null;
  const coverage = { status: 'complete', tracked: true, untracked: true, ignoredExcluded: true,
    exclusions: ['Gitignored files', ...(excluded ? [excluded] : [])] };
  const errors = [];
  const git = args => execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let staged, unstaged, names;
  try {
    git(['rev-parse', '--verify', 'HEAD']);
    const scope = ['--', '.'];
    if (excluded && contains(cwd, excluded)) scope.push(`:(exclude,literal)${relative(cwd, excluded) || '.'}`);
    // Keep index and working-tree changes separate: a staged edit followed by
    // restoring HEAD in the working tree must still change the fingerprint.
    const diffFlags = ['--binary', '--no-ext-diff', '--no-textconv'];
    staged = git(['diff', ...diffFlags, '--cached', 'HEAD', ...scope]);
    unstaged = git(['diff', ...diffFlags, ...scope]);
    names = git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.']).toString().split('\0').filter(Boolean).sort();
  } catch (error) {
    coverage.status = 'unavailable'; coverage.tracked = false; coverage.untracked = false;
    errors.push(`Git/HEAD scan unavailable: ${error.message}`);
    return { hash: null, coverage, errors };
  }
  const manifest = [];
  for (const name of names) {
    const path = resolve(cwd, name);
    if (excluded && contains(excluded, path)) continue;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) manifest.push([name, 'symlink', digest(readlinkSync(path))]);
      else if (stat.isFile()) manifest.push([name, 'file', stat.mode & 0o777, digest(readFileSync(path))]);
      else throw new Error('unsupported file type');
    } catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  if (errors.length) coverage.status = 'partial';
  return { hash: digest(JSON.stringify([staged.toString('base64'), unstaged.toString('base64'), manifest])), coverage, errors };
}
