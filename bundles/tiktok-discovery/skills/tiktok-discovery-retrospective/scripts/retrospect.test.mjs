// All fixtures in this file are synthetic. Temporary policy publications test file mechanics only.
// A mocked source:'live' below exercises the live validation branch; it is not real business evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildReport, metrics, validatePolicy, loadValidatedPolicy, evaluateExperiment, promote, rollback } from './retrospect.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tk-retrospect-synthetic-'));
const json = v => JSON.stringify(v, null, 2);
const write = async (name, v) => { const file = path.join(tmp, name); await fs.writeFile(file, json(v)); return file; };
const policy = (version = 'v1') => ({ schemaVersion: 1, version, scope: { platform: 'tiktok', stages: ['seed', 'expansion'] }, strategy: { actionDedup: true,
  routePriority: { hashtag: 1, identity_location: 1, scenario: 1, brand_product: 1, profile_recommendation: 1 },
  referenceQueryPriority: { topic: 1, scenario: 1, brand_product: 1, identity_location: 1, hashtag: 1 } } });
let checks = 0;

try {
  assert.equal(metrics({ newUniqueAccounts: 10, reviewedAccounts: 5, passedAccounts: 3, activeMs: 1000 }).passedPerHour, null);
  assert.equal(metrics({ newUniqueAccounts: 10, reviewedAccounts: 5, passedAccounts: 3, activeMs: 1000, waitMs: 2000 }).elapsedMs, 3000);
  assert.throws(() => metrics({ newUniqueAccounts: 3, reviewedAccounts: 4 }), /reviewed exceeds/);
  checks += 3;

  const report = buildReport({ schemaVersion: 1, stage: 'seed', taskStatus: 'blocked', coverage: { planned: 10, completed: 2, unknown: 8 }, routes: [
    { route: 'scenario', actions: 2, blockedActions: 2, newUniqueAccounts: 0, reviewedAccounts: 0, passedAccounts: 0, failureClasses: ['platform_block'] }
  ] });
  assert.equal(report.routes[0].newUniquePerHour, null);
  assert.equal(report.routes[0].reviewedPassRate, null);
  assert.equal(report.defects.length, 0);
  assert.equal(report.recommendations.adoptable.length, 0);
  assert.equal(report.coverage.unknown, 8);
  checks += 5;

  const invalid = policy(); invalid.strategy.skipVerification = true;
  assert.throws(() => validatePolicy(invalid), /accepts exactly/);
  const nondedup = policy(); nondedup.strategy.actionDedup = false;
  assert.throws(() => validatePolicy(nondedup), /must remain enabled/);
  const unbounded = policy(); unbounded.strategy.routePriority.scenario = 10;
  assert.throws(() => validatePolicy(unbounded), /0.5-2/);
  checks += 3;

  const candidateFile = await write('candidate.json', policy());
  const loaded = await loadValidatedPolicy(candidateFile);
  assert.equal(loaded.strategy.routePriority.scenario, 1);
  checks++;
  const evidenceBytes = Buffer.from('SYNTHETIC TEST EVIDENCE ONLY; no browser or real campaign was used.');
  await fs.writeFile(path.join(tmp, 'evidence.txt'), evidenceBytes);
  const group = { actions: 20, blockedActions: 0, newUniqueAccounts: 60, reviewedAccounts: 40, passedAccounts: 20, activeMs: 120000, waitMs: 60000, coverage: { planned: 20, completed: 20 } };
  const experiment = {
    schemaVersion: 1, source: 'synthetic', completed: true, isolated: true, comparisonMatched: true,
    scope: policy().scope, baselinePolicyHash: null, candidatePolicyHash: hash(await fs.readFile(candidateFile)),
    checks: { sameQualificationRules: true, authorizationUnchanged: true, noGuardChanges: true, independentReview: true },
    baseline: group, candidate: { ...group, passedAccounts: 24 }, evidence: [{ path: 'evidence.txt', sha256: hash(evidenceBytes) }]
  };
  let experimentFile = await write('experiment.json', experiment);
  let evaluated = await evaluateExperiment(candidateFile, experimentFile);
  assert.equal(evaluated.passed, false);
  assert.ok(evaluated.reasons.some(x => x.includes('Synthetic/offline')));
  checks += 2;

  // The test harness deliberately mocks a live experiment in an isolated temporary directory.
  experiment.source = 'live';
  experimentFile = await write('experiment.json', experiment);
  evaluated = await evaluateExperiment(candidateFile, experimentFile);
  assert.equal(evaluated.passed, true);
  const validationFile = await write('validation.json', evaluated);
  const policyDir = path.join(tmp, 'mock-policy-store');
  const receipt = await promote({ candidateFile, experimentFile, validationFile, policyDir });
  assert.equal(receipt.version, 'v1');
  assert.equal(await fs.readFile(path.join(policyDir, 'current.json'), 'utf8'), await fs.readFile(candidateFile, 'utf8'));
  checks += 3;

  const p2 = policy('v2'); p2.strategy.routePriority.scenario = 1.2;
  const candidate2 = await write('candidate-v2.json', p2);
  experiment.baselinePolicyHash = hash(await fs.readFile(candidateFile));
  experiment.candidatePolicyHash = hash(await fs.readFile(candidate2));
  experimentFile = await write('experiment-v2.json', experiment);
  const validation2 = await write('validation-v2.json', await evaluateExperiment(candidate2, experimentFile));
  await promote({ candidateFile: candidate2, experimentFile, validationFile: validation2, policyDir });
  assert.equal((await loadValidatedPolicy(path.join(policyDir, 'current.json'))).version, 'v2');
  await rollback({ policyDir, version: 'v1' });
  assert.equal((await loadValidatedPolicy(path.join(policyDir, 'current.json'))).version, 'v1');
  assert.equal((await loadValidatedPolicy(path.join(policyDir, 'versions', 'v2.json'))).version, 'v2');
  await assert.rejects(rollback({ policyDir, version: '../escape' }), /Invalid rollback/);
  checks += 4;

  await fs.writeFile(path.join(tmp, 'evidence.txt'), 'SYNTHETIC MODIFIED EVIDENCE');
  await assert.rejects(promote({ candidateFile: candidate2, experimentFile, validationFile: validation2, policyDir }), /Evidence hash mismatch/);
  assert.equal((await loadValidatedPolicy(path.join(policyDir, 'current.json'))).version, 'v1');
  checks += 2;
  await fs.writeFile(path.join(tmp, 'evidence.txt'), evidenceBytes);

  // Forging passed:true cannot bypass recomputation of a regressed cost/quality experiment.
  const regressed = structuredClone(experiment); regressed.candidate.waitMs = 10000000;
  const badExperiment = await write('regressed.json', regressed);
  const forged = await evaluateExperiment(candidate2, badExperiment); forged.passed = true; forged.reasons = [];
  const forgedValidation = await write('forged-validation.json', forged);
  await assert.rejects(promote({ candidateFile: candidate2, experimentFile: badExperiment, validationFile: forgedValidation, policyDir }), /throughput/);
  checks++;

  // A stale baseline cannot overwrite a concurrent publisher, even if its experiment once passed.
  experiment.baselinePolicyHash = null;
  const staleExperiment = await write('stale.json', experiment);
  const staleValidation = await write('stale-validation.json', await evaluateExperiment(candidate2, staleExperiment));
  await assert.rejects(promote({ candidateFile: candidate2, experimentFile: staleExperiment, validationFile: staleValidation, policyDir }), /Current policy changed/);
  assert.equal((await loadValidatedPolicy(path.join(policyDir, 'current.json'))).version, 'v1');
  checks += 2;

  process.stdout.write(`${JSON.stringify({ status: 'passed', synthetic: true, checks, browserAccessed: false, realPolicyChanged: false })}\n`);
} finally {
  // Delete only the absolute directory returned by mkdtemp under the task-specific OS-temp prefix.
  const resolved = path.resolve(tmp), root = path.resolve(os.tmpdir());
  if (path.dirname(resolved) === root && path.basename(resolved).startsWith('tk-retrospect-synthetic-')) await fs.rm(resolved, { recursive: true, force: true });
}
