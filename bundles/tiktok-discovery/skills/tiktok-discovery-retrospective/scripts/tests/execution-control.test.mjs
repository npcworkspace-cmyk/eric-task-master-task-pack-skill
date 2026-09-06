import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run, nativeResponseDiagnostic } from '../../../tiktok-seed-discovery/scripts/runtime/browser.mjs';
// Synthetic offline tests; throwing fake page proves no browser operations occur.
test('business error in HTTP 200 search remains an error, with secrets redacted', () => {
  const failed = nativeResponseDiagnostic({ status_code: 9876, status_msg: 'failed token=synthetic-secret https://example.invalid/?cookie=hidden' }, '/api/search/general/full/', 200);
  assert.equal(failed.searchBusinessError, true);
  assert.ok(!failed.payloadStatusMessage.includes('synthetic-secret'));
  assert.ok(!failed.payloadStatusMessage.includes('example.invalid'));
  assert.equal(nativeResponseDiagnostic({ statusCode: 0 }, '/api/search/general/full/', 200).searchBusinessError, false);
});
test('search task preserves paused and future cooldown controls without touching browser', async t => {
  const tempRoot = os.tmpdir(), dir = await fs.mkdtemp(path.join(tempRoot, 'tk-control-'));
  t.after(async () => { if (path.dirname(dir) !== path.resolve(tempRoot) || !path.basename(dir).startsWith('tk-control-')) throw Error('Unsafe test cleanup'); await fs.rm(dir, { recursive: true, force: true }); });
  let browserCalls = 0;
  const page = { on() {}, off() {}, evaluate() { browserCalls++; throw Error('Browser must remain untouched'); } };
  for (const [i, control] of [{ status: 'paused_user_cooldown' }, { status: 'ready', notBefore: '2099-01-01T00:00:00Z' }].entries()) {
    const outputDir = path.join(dir, String(i)), controlFile = path.join(dir, `control-${i}.json`);
    await fs.writeFile(controlFile, JSON.stringify(control));
    const result = await run({ page, input: { briefId: 'synthetic', phase: 'expand', seeds: [], actions: [], controlFile, limits: { maxWallMs: 1000 } }, outputDir, progress: async () => {}, wait: async () => {} });
    assert.equal(result.stopReason, i === 0 ? 'USER_PAUSED' : 'COOLDOWN_ACTIVE');
  }
  assert.equal(browserCalls, 0);
});
test('seed search cannot run while reference analysis is not ready', async t => {
  const base = os.tmpdir(), outputDir = await fs.mkdtemp(path.join(base, 'tk-readiness-'));
  t.after(async () => { if (path.dirname(outputDir) !== path.resolve(base) || !path.basename(outputDir).startsWith('tk-readiness-')) throw Error('Unsafe test cleanup'); await fs.rm(outputDir, { recursive: true, force: true }); });
  const page = { on() {}, off() {}, evaluate() { throw Error('No browser call authorized by this fixture'); } };
  const result = await run({ page, input: { briefId: 'synthetic', phase: 'expand', stage: 'seed', seeds: [], actions: [], compilation: { status: 'needs_ai_review' }, limits: { maxWallMs: 1000 } }, outputDir, progress: async () => {}, wait: async () => {} });
  assert.equal(result.stopReason, 'REFERENCE_ANALYSIS_NOT_READY');
});
