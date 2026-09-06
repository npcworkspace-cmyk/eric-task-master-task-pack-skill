#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRunReview } from './review-run.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const CORE_FILES = ['checkpoint.json', 'coverage.json', 'result.json', 'comments.jsonl'];
function validateSchema(value, schema, label = '$') {
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${label} const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${label} enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    assert.ok(types.includes(actual) || (actual === 'integer' && types.includes('number')), `${label} type ${actual}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${label} minLength`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${label} pattern`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${label} minItems`);
    if (schema.uniqueItems) assert.equal(new Set(value.map(item => JSON.stringify(item))).size, value.length, `${label} uniqueItems`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${label}/${index}`));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${label}/${key} required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${label}/${key} is not in schema`);
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) validateSchema(value[key], childSchema, `${label}/${key}`);
  }
}

async function withRoot(name, fn) {
  const root = await mkdtemp(path.join(tmpdir(), `iteration-design-${name}-`));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function inventory(directory) {
  const result = {};
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name);
    if ((await lstat(file)).isFile()) result[name] = digest(await readFile(file));
  }
  return result;
}

async function writeRelative(directory, relative, value) {
  const file = path.join(directory, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

async function writeCore(directory, options = {}) {
  await mkdir(directory, { recursive: true });
  await writeRelative(directory, 'checkpoint.json', json(options.checkpoint ?? { state: { requests_total: 0, notices: [], posts: [] } }));
  await writeRelative(directory, 'coverage.json', json(options.coverage ?? { status: 'exhausted_accessible', reason: 'frontier_exhausted', requests_total: 0, posts: [], notices: [] }));
  await writeRelative(directory, 'result.json', json(options.result ?? { status: 'exhausted_accessible', reason: 'frontier_exhausted', comments: 0, requests_total: 0 }));
  await writeRelative(directory, 'comments.jsonl', options.comments ?? '');
}

async function writeManifest(directory, relativeFiles) {
  const files = [];
  for (const relative of [...relativeFiles].sort()) {
    const bytes = await readFile(path.join(directory, ...relative.split('/')));
    files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
  }
  await writeFile(path.join(directory, 'manifest.json'), json({ files }));
}

test('extracts aggregate facts without copying task identity or mutating source', async () => withRoot('facts', async root => {
  const run = path.join(root, 'run');
  const reviewDir = path.join(root, 'review');
  await mkdir(run);
  await writeFile(path.join(run, 'result.json'), json({ status: 'partial', reason: 'request_budget_exhausted', comments: 7, requests_total: 3, task_id: 'task_should_not_escape' }));
  await writeFile(path.join(run, 'coverage.json'), json({
    status: 'partial', notices: [{ type: 'collector_error', collector_stage: 'persist_checkpoint', error_code: 'EIO', error_name: 'Error', note: 'do not copy this message' }],
    posts: [
      { post_id: 'secret_post', initial_received: true, comments: 7, skipped_unavailable: null, missing_ids: [{ id: 'secret_comment' }], empty_more: [], structural_gaps: [], thread_anchors: [{ status: 'pending', comment_id: 'secret_anchor' }] },
      { post_id: 'other_secret_post', initial_received: false, comments: 0, skipped_unavailable: { reason: 'secret' }, missing_ids: [], empty_more: [], structural_gaps: [], thread_anchors: [] }
    ]
  }));
  await writeFile(path.join(run, 'checkpoint.json'), json({ state: { requests_total: 3, notices: [], posts: [] } }));
  await writeFile(path.join(run, 'comments.jsonl'), '');
  await writeManifest(run, CORE_FILES);
  const before = await inventory(run);
  const review = await buildRunReview(run, reviewDir, { now: () => 1700000000000 });
  const after = await inventory(run);
  assert.deepEqual(after, before);
  assert.deepEqual(review.facts.posts, { total: 2, started: 1, skipped: 1 });
  assert.deepEqual(review.facts.gaps, { queuedIds: 0, missingIds: 1, emptyMore: 0, pendingAnchors: 1, unresolvedAnchors: 0, structural: 0 });
  assert.equal(review.facts.diagnostics[0].count, 1);
  assert.equal(review.sourcePolicy.reviewMode, 'offline_audit');
  assert.equal(review.sourcePolicy.reviewNetworkAccess, false);
  assert.equal(review.sourcePolicy.autoMutationAllowed, false);
  const serialized = await readFile(path.join(reviewDir, 'run-retrospective.json'), 'utf8');
  const proposal = JSON.parse(await readFile(path.join(reviewDir, 'iteration-proposal.json'), 'utf8'));
  assert.equal(proposal.classification, 'pending_agent_review');
  assert.deepEqual(proposal.candidateTargets, ['executor_and_docs']);
  for (const forbidden of ['task_should_not_escape', 'secret_post', 'secret_comment', 'secret_anchor', 'other_secret_post', 'do not copy this message', path.resolve(run)]) {
    assert.equal(serialized.includes(forbidden), false, `review leaked ${forbidden}`);
  }
}));

test('writes human review and a non-applying iteration proposal', async () => withRoot('outputs', async root => {
  const run = path.join(root, 'run');
  const reviewDir = path.join(root, 'review');
  await writeCore(run, { result: { status: 'exhausted_accessible', reason: 'frontier_exhausted', comments: 0, requests_total: 1 } });
  await writeRelative(run, 'batches/00000001.json', json({ response: { status: 200 } }));
  await writeRelative(run, 'run-retrospective.json', json({ schemaVersion: 1 }));
  await writeRelative(run, 'run-retrospective.md', '# Run retrospective\n');
  await writeManifest(run, [...CORE_FILES, 'batches/00000001.json', 'run-retrospective.json', 'run-retrospective.md']);
  await buildRunReview(run, reviewDir, { now: () => 1700000000000 });
  const markdown = await readFile(path.join(reviewDir, 'run-retrospective.md'), 'utf8');
  const review = JSON.parse(await readFile(path.join(reviewDir, 'run-retrospective.json'), 'utf8'));
  const proposal = JSON.parse(await readFile(path.join(reviewDir, 'iteration-proposal.json'), 'utf8'));
  const reviewSchema = JSON.parse(await readFile(new URL('../schemas/run-review.schema.json', import.meta.url), 'utf8'));
  const proposalSchema = JSON.parse(await readFile(new URL('../schemas/iteration-proposal.schema.json', import.meta.url), 'utf8'));
  validateSchema(review, reviewSchema);
  validateSchema(proposal, proposalSchema);
  assert.match(markdown, /Run retrospective/);
  assert.equal(review.integrity.manifest.trustedForIteration, true);
  assert.equal(proposal.mutationPolicy.autoApply, false);
  assert.equal(proposal.mutationPolicy.target, 'staged-copy-only');
  assert.equal(proposal.classification, 'no_change');
  assert.deepEqual(proposal.candidateTargets, ['no_change']);
}));

test('missing final manifest is untrusted and cannot produce a change candidate', async () => withRoot('missing-manifest', async root => {
  const run = path.join(root, 'run');
  const reviewDir = path.join(root, 'review');
  await mkdir(run);
  await writeFile(path.join(run, 'checkpoint.json'), json({ state: { requests_total: 4, notices: [{ type: 'collector_error', collector_stage: 'request', error_code: 'EIO', error_name: 'Error' }], posts: [{ id: 'abc', initial: true, comments: { x: {} }, missing_ids: {}, empty_more: {}, structural_gaps: [], thread_anchors: {} }] } }));
  const review = await buildRunReview(run, reviewDir, { now: () => 1700000000000 });
  const proposal = JSON.parse(await readFile(path.join(reviewDir, 'iteration-proposal.json'), 'utf8'));
  const reviewSchema = JSON.parse(await readFile(new URL('../schemas/run-review.schema.json', import.meta.url), 'utf8'));
  const proposalSchema = JSON.parse(await readFile(new URL('../schemas/iteration-proposal.schema.json', import.meta.url), 'utf8'));
  validateSchema(review, reviewSchema);
  validateSchema(proposal, proposalSchema);
  assert.ok(review.observations.some(item => item.id === 'manifest_missing'));
  assert.equal(review.integrity.manifest.trustedForIteration, false);
  assert.equal(review.decision.status, 'evidence_untrusted');
  assert.equal(review.decision.proposalRequired, false);
  assert.ok(review.observations.every(item => item.iterationEligibility === 'task_outcome_only'));
  assert.ok(review.observations.every(item => item.suggestedTarget === 'no_change'));
  assert.equal(proposal.state, 'rejected');
  assert.equal(proposal.classification, 'no_change');
  assert.deepEqual(proposal.candidateTargets, ['no_change']);
}));

test('trusted runtime wait failures remain runtime-adapter review signals', async () => {
  const cases = [
    { variant: 'human-handoff', noticeType: 'runtime_wait_failed', reason: 'runtime_wait_failed', status: 'blocked', stage: 'wait_handoff' },
    { variant: 'timed-wait', noticeType: 'runtime_timed_wait_failed', reason: 'frontier_exhausted', status: 'exhausted_accessible', stage: 'wait_cooldown' },
    { variant: 'body-capability', noticeType: 'runtime_body_capability_missing', reason: 'runtime_body_capability_missing', status: 'blocked', stage: 'apply' },
  ];
  for (const scenario of cases) await withRoot(`runtime-${scenario.variant}`, async root => {
    const run = path.join(root, 'run');
    const reviewDir = path.join(root, 'review');
    await writeCore(run, {
      checkpoint: { state: { requests_total: 1, notices: [{ type: scenario.noticeType, collector_stage: scenario.stage, error_code: 'EPIPE', error_name: 'Error' }], posts: [] } },
      coverage: { status: scenario.status, reason: scenario.reason, requests_total: 1, posts: [], notices: [{ type: scenario.noticeType, collector_stage: scenario.stage, error_code: 'EPIPE', error_name: 'Error' }] },
      result: { status: scenario.status, reason: scenario.reason, comments: 0, requests_total: 1 },
    });
    await writeManifest(run, CORE_FILES);
    const review = await buildRunReview(run, reviewDir, { now: () => 1700000000000 });
    const proposal = JSON.parse(await readFile(path.join(reviewDir, 'iteration-proposal.json'), 'utf8'));
    assert.equal(review.integrity.manifest.trustedForIteration, true);
    assert.ok(review.observations.some(item => item.iterationEligibility === 'review_required' && item.suggestedTarget === 'runtime_adapter'));
    assert.equal(proposal.classification, 'pending_agent_review');
    assert.deepEqual(proposal.candidateTargets, ['runtime_adapter']);
  });
});

test('trusted structural gaps remain executor-and-docs review signals', async () => withRoot('structural-gap', async root => {
  const run = path.join(root, 'run');
  const reviewDir = path.join(root, 'review');
  await writeCore(run, {
    coverage: {
      status: 'partial', reason: 'known_coverage_gaps', requests_total: 1, notices: [],
      posts: [{ initial_received: true, comments: 0, missing_ids: [], empty_more: [], structural_gaps: [{ kind: 'unknown_node' }], thread_anchors: [] }],
    },
    result: { status: 'partial', reason: 'known_coverage_gaps', comments: 0, requests_total: 1 },
  });
  await writeManifest(run, CORE_FILES);
  const review = await buildRunReview(run, reviewDir, { now: () => 1700000000000 });
  const proposal = JSON.parse(await readFile(path.join(reviewDir, 'iteration-proposal.json'), 'utf8'));
  assert.equal(review.integrity.manifest.trustedForIteration, true);
      assert.ok(review.observations.some(item => item.iterationEligibility === 'review_required' && item.suggestedTarget === 'executor_and_docs'));
  assert.equal(proposal.classification, 'pending_agent_review');
  assert.deepEqual(proposal.candidateTargets, ['executor_and_docs']);
}));

test('trusted mixed diagnostics retain both executor and runtime-adapter targets', async () => withRoot('mixed-diagnostics', async root => {
  const run = path.join(root, 'run');
  const reviewDir = path.join(root, 'review');
  const notices = [
    { type: 'runtime_progress_disabled', collector_stage: 'report_progress', error_code: 'EPIPE', error_name: 'Error' },
    { type: 'collector_error', collector_stage: 'persist_checkpoint', error_code: 'EIO', error_name: 'Error' },
  ];
  await writeCore(run, {
    checkpoint: { state: { requests_total: 1, notices, posts: [] } },
    coverage: { status: 'partial', reason: 'collector_error', requests_total: 1, posts: [], notices },
    result: { status: 'partial', reason: 'collector_error', comments: 0, requests_total: 1 },
  });
  await writeManifest(run, CORE_FILES);
  const review = await buildRunReview(run, reviewDir, { now: () => 1700000000000 });
  const proposal = JSON.parse(await readFile(path.join(reviewDir, 'iteration-proposal.json'), 'utf8'));
  assert.ok(review.observations.some(item => item.suggestedTarget === 'executor_and_docs'));
  assert.ok(review.observations.some(item => item.suggestedTarget === 'runtime_adapter'));
  assert.deepEqual(proposal.candidateTargets, ['executor_and_docs', 'runtime_adapter']);
  assert.equal(proposal.classification, 'pending_agent_review');
}));

test('rejects a manifest that omits required core evidence', async () => withRoot('core-omission', async root => {
  const run = path.join(root, 'run');
  const reviewDir = path.join(root, 'review');
  await writeCore(run);
  await writeManifest(run, CORE_FILES.filter(name => name !== 'result.json'));
  await assert.rejects(() => buildRunReview(run, reviewDir), /Manifest omits required core evidence: result\.json/);
  await assert.rejects(() => lstat(reviewDir), error => error?.code === 'ENOENT');
}));

test('rejects post-manifest evidence tampering', async () => withRoot('tamper', async root => {
  const run = path.join(root, 'run');
  const reviewDir = path.join(root, 'review');
  await writeCore(run);
  await writeManifest(run, CORE_FILES);
  await writeFile(path.join(run, 'result.json'), json({ status: 'partial', reason: 'tampered', comments: 999999, requests_total: 0 }));
  await assert.rejects(() => buildRunReview(run, reviewDir), /Loaded result\.json snapshot does not match the manifest|Manifest entry bytes or SHA-256 mismatch/);
  await assert.rejects(() => lstat(reviewDir), error => error?.code === 'ENOENT');
}));

test('rejects an evidence swap between fact extraction and manifest verification', async () => withRoot('snapshot-swap', async root => {
  const run = path.join(root, 'run');
  const reviewDir = path.join(root, 'review');
  const manifestVersion = json({ status: 'blocked', reason: 'runtime_wait_failed', comments: 2, requests_total: 2 });
  const loadedVersion = json({ status: 'partial', reason: 'request_budget_exhausted', comments: 1, requests_total: 1 });
  await writeCore(run, { result: JSON.parse(manifestVersion) });
  await writeManifest(run, CORE_FILES);
  await writeFile(path.join(run, 'result.json'), loadedVersion);
  await assert.rejects(
    () => buildRunReview(run, reviewDir, { __testAfterEvidenceRead: () => writeFile(path.join(run, 'result.json'), manifestVersion) }),
    /Loaded result\.json snapshot does not match the manifest/
  );
  await assert.rejects(() => lstat(reviewDir), error => error?.code === 'ENOENT');
}));

test('rejects a numeric batch omitted from the manifest', async () => withRoot('batch-omission', async root => {
  const run = path.join(root, 'run');
  await writeCore(run);
  await writeRelative(run, 'batches/00000001.json', json({ response: { status: 200 } }));
  await writeManifest(run, CORE_FILES);
  await assert.rejects(() => buildRunReview(run, path.join(root, 'review')), /Manifest numeric batch set mismatch; disk-only: batches\/00000001\.json/);
}));

test('rejects an existing review file omitted from the manifest', async () => withRoot('review-omission', async root => {
  const run = path.join(root, 'run');
  await writeCore(run);
  await writeRelative(run, 'run-retrospective.json', json({ schemaVersion: 1 }));
  await writeManifest(run, CORE_FILES);
  await assert.rejects(() => buildRunReview(run, path.join(root, 'review')), /Manifest review file set mismatch; disk-only: run-retrospective\.json/);
}));

test('rejects overlapping or pre-existing destinations', async () => withRoot('paths', async root => {
  const run = path.join(root, 'run');
  await mkdir(run);
  await writeFile(path.join(run, 'result.json'), json({ status: 'completed', comments: 0, requests_total: 0 }));
  await assert.rejects(() => buildRunReview(run, path.join(run, 'review')), /must not overlap/);
  const existing = path.join(root, 'existing');
  await mkdir(existing);
  await assert.rejects(() => buildRunReview(run, existing), /already exists/);
}));

test('rejects symlinked evidence', async () => withRoot('symlink', async root => {
  const run = path.join(root, 'run');
  await mkdir(run);
  const external = path.join(root, 'external.json');
  await writeFile(external, json({ status: 'completed' }));
  try { await symlink(external, path.join(run, 'result.json'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return;
    throw error;
  }
  await assert.rejects(() => buildRunReview(run, path.join(root, 'review')), /regular non-symlink/);
}));
