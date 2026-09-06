// Synthetic, isolated HOME-like directories only; never touches the real user's strategy state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { defaultPolicyDir, resolvePolicyFile, loadValidatedPolicy } from './retrospect.mjs';

async function withTemp(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tk-policy-resolution-synthetic-'));
  try { await fn(root); }
  finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('tk-policy-resolution-synthetic-')) await fs.rm(resolved, { recursive: true, force: true });
  }
}

test('independent homes have isolated defaults; absent published state returns null and creates nothing', async () => withTemp(async root => {
  const homeA = { homeDir: path.join(root, 'home-a'), readEnv: () => undefined };
  const homeB = { homeDir: path.join(root, 'home-b'), readEnv: () => undefined };
  assert.notEqual(defaultPolicyDir(homeA), defaultPolicyDir(homeB));
  assert.equal(defaultPolicyDir(homeA), path.join(homeA.homeDir, '.tiktok-discovery', 'policies'));
  assert.equal(await resolvePolicyFile(undefined, homeA), null);
  assert.equal(await resolvePolicyFile(undefined, homeB), null);
  await assert.rejects(fs.access(homeA.homeDir), { code: 'ENOENT' });
  await assert.rejects(fs.access(homeB.homeDir), { code: 'ENOENT' });
  assert.throws(() => defaultPolicyDir({ ...homeA, readEnv: () => 'relative-state' }), /absolute path/);
  const state = path.join(root, 'custom-state');
  assert.equal(defaultPolicyDir({ ...homeA, readEnv: () => state }), path.join(state, 'policies'));
}));

test('explicit missing or invalid policy never falls back to an existing default', async () => withTemp(async root => {
  const options = { homeDir: path.join(root, 'home'), readEnv: () => undefined };
  const policyDir = defaultPolicyDir(options);
  await fs.mkdir(policyDir, { recursive: true });
  const current = path.join(policyDir, 'current.json');
  const policy = { schemaVersion: 1, version: 'synthetic-test', scope: { platform: 'tiktok', stages: ['seed', 'expansion'] }, strategy: {
    actionDedup: true,
    routePriority: { hashtag: 1, identity_location: 1, scenario: 1, brand_product: 1, profile_recommendation: 1 },
    referenceQueryPriority: { topic: 1, scenario: 1, brand_product: 1, identity_location: 1, hashtag: 1 }
  } };
  await fs.writeFile(current, JSON.stringify(policy));
  assert.equal(await resolvePolicyFile(undefined, options), current);
  assert.equal((await loadValidatedPolicy(await resolvePolicyFile(undefined, options))).version, 'synthetic-test');
  const missing = path.join(root, 'missing-explicit.json');
  assert.equal(await resolvePolicyFile(missing, options), missing);
  await assert.rejects(loadValidatedPolicy(await resolvePolicyFile(missing, options)), { code: 'ENOENT' });
  const invalid = path.join(root, 'invalid-explicit.json');
  await fs.writeFile(invalid, '{}');
  assert.equal(await resolvePolicyFile(invalid, options), invalid);
  await assert.rejects(loadValidatedPolicy(await resolvePolicyFile(invalid, options)), /accepts exactly/);
  await assert.rejects(resolvePolicyFile('relative.json', options), /absolute path/);
}));
