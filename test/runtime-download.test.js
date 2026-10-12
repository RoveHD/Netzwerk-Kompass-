import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('runtime downloads decode official checksum responses and reject invalid verification', { skip: process.platform !== 'win32' }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nk-download-'));
  try {
    const { stdout } = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'test/runtime-download.ps1'), '-Root', root, '-Temporary', temporary], { windowsHide: true, timeout: 30_000 });
    const results = JSON.parse(stdout.trim());
    assert.deepEqual(results.passed, ['text', 'github-binary', 'bom-crlf', 'node-path', 'duplicate', 'missing', 'wrong-hash', 'invalid-utf8', 'unexpected-response']);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
