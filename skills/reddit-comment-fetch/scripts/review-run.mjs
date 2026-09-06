#!/usr/bin/env node
/**
 * Offline, read-only fact extraction for a completed, paused, or blocked run.
 *
 * Usage:
 *   node review-run.mjs RUN_OUTPUT_DIR NEW_REVIEW_DIR
 *
 * The review deliberately contains aggregate facts and evidence hashes only.
 * It never edits the run, the collector, an installed Skill, or a release ZIP.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REVIEW_SCHEMA = 1;
const ALLOWED_FILES = ['checkpoint.json', 'coverage.json', 'manifest.json', 'result.json'];
const REQUIRED_MANIFEST_FILES = ['checkpoint.json', 'coverage.json', 'result.json', 'comments.jsonl'];
const REVIEW_OUTPUT_FILES = ['run-retrospective.json', 'run-retrospective.md', 'iteration-proposal.json'];
const NUMERIC_BATCH_PATTERN = /^batches\/\d{8}\.json$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const check = (condition, message) => { if (!condition) throw new Error(message); };

function isInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function requireSameSet(diskFiles, manifestFiles, label) {
  const onlyOnDisk = [...diskFiles].filter(name => !manifestFiles.has(name)).sort(compareText);
  const onlyInManifest = [...manifestFiles].filter(name => !diskFiles.has(name)).sort(compareText);
  check(onlyOnDisk.length === 0 && onlyInManifest.length === 0,
    `Manifest ${label} set mismatch; disk-only: ${onlyOnDisk.join(', ') || 'none'}; manifest-only: ${onlyInManifest.join(', ') || 'none'}`);
}

async function numericBatchFiles(source) {
  const directory = path.join(source, 'batches');
  let directoryStat;
  try { directoryStat = await lstat(directory); }
  catch (error) { if (error?.code === 'ENOENT') return new Set(); throw error; }
  check(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'batches must be a regular non-symlink directory');
  const resolvedDirectory = await realpath(directory);
  check(isInside(source, resolvedDirectory), 'batches resolves outside the run directory');
  const files = new Set();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `batches/${entry.name}`;
    if (!NUMERIC_BATCH_PATTERN.test(relative)) continue;
    check(entry.isFile() && !entry.isSymbolicLink(), `${relative} must be a regular non-symlink file`);
    const resolved = await realpath(path.join(directory, entry.name));
    check(isInside(source, resolved), `${relative} resolves outside the run directory`);
    files.add(relative);
  }
  return files;
}

async function existingReviewFiles(source) {
  const files = new Set();
  for (const name of REVIEW_OUTPUT_FILES) {
    const file = path.join(source, name);
    let fileStat;
    try { fileStat = await lstat(file); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    check(fileStat.isFile() && !fileStat.isSymbolicLink(), `${name} must be a regular non-symlink file`);
    const resolved = await realpath(file);
    check(isInside(source, resolved), `${name} resolves outside the run directory`);
    files.add(name);
  }
  return files;
}

async function requireNew(directory) {
  try { await lstat(directory); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  throw new Error('Review destination already exists; choose a new directory');
}

async function atomicJson(file, value) {
  const temporary = `${file}.tmp`;
  try {
    await writeFile(temporary, json(value), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicText(file, value) {
  const temporary = `${file}.tmp`;
  try {
    await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

async function readEvidence(source, name) {
  const file = path.join(source, name);
  let fileStat;
  try { fileStat = await lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  check(fileStat.isFile() && !fileStat.isSymbolicLink(), `${name} must be a regular non-symlink file`);
  const resolved = await realpath(file);
  check(isInside(source, resolved), `${name} resolves outside the run directory`);
  const bytes = await readFile(file);
  return { name, bytes, sha256: sha256(bytes), value: parseJson(bytes, name) };
}

function countArray(value) { return Array.isArray(value) ? value.length : 0; }
function countMap(value) { return isObject(value) ? Object.keys(value).length : 0; }
function firstInteger(...values) { return values.find(nonNegativeInteger) ?? null; }

function sourcePosts(coverage, checkpoint) {
  if (Array.isArray(coverage?.posts)) return coverage.posts;
  if (Array.isArray(checkpoint?.state?.posts)) return checkpoint.state.posts;
  return [];
}

function commentCount(posts) {
  let seen = false;
  let total = 0;
  for (const post of posts) {
    if (nonNegativeInteger(post?.comments)) { total += post.comments; seen = true; }
    else if (isObject(post?.comments)) { total += Object.keys(post.comments).length; seen = true; }
  }
  return seen ? total : null;
}

function aggregateDiagnostics(coverage, checkpoint) {
  const notices = Array.isArray(coverage?.notices)
    ? coverage.notices
    : Array.isArray(checkpoint?.state?.notices) ? checkpoint.state.notices : [];
  const counts = new Map();
  for (const notice of notices) {
    if (!isObject(notice)) continue;
    const item = {
      type: typeof notice.type === 'string' ? notice.type : null,
      stage: typeof notice.collector_stage === 'string' ? notice.collector_stage : null,
      code: typeof notice.error_code === 'string' ? notice.error_code : null,
      name: typeof notice.error_name === 'string' ? notice.error_name : null,
    };
    const key = JSON.stringify(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ ...JSON.parse(key), count }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function aggregateFacts(result, coverage, checkpoint) {
  const posts = sourcePosts(coverage, checkpoint);
  const status = typeof result?.status === 'string' ? result.status
    : typeof coverage?.status === 'string' ? coverage.status : null;
  const reason = typeof result?.reason === 'string' ? result.reason
    : typeof coverage?.reason === 'string' ? coverage.reason : null;
  let missingIds = 0;
  let queuedIds = 0;
  let emptyMore = 0;
  let pendingAnchors = 0;
  let unresolvedAnchors = 0;
  let structural = 0;
  let started = 0;
  let skipped = 0;
  for (const post of posts) {
    if (post?.initial_received === true || post?.initial === true) started += 1;
    if (post?.skipped === true || post?.skipped_unavailable) skipped += 1;
    missingIds += countArray(post?.missing_ids) || countMap(post?.missing_ids);
    queuedIds += firstInteger(post?.queue_count, countArray(post?.queued_ids), countArray(post?.queue)) ?? 0;
    emptyMore += countArray(post?.empty_more) || countMap(post?.empty_more);
    structural += countArray(post?.structural_gaps) || countMap(post?.structural_gaps);
    const anchors = Array.isArray(post?.thread_anchors)
      ? post.thread_anchors
      : isObject(post?.thread_anchors) ? Object.values(post.thread_anchors) : [];
    pendingAnchors += anchors.filter(anchor => anchor?.status === 'pending').length;
    unresolvedAnchors += anchors.filter(anchor => anchor?.status === 'unresolved').length;
  }
  return {
    status,
    reason,
    comments: firstInteger(result?.comments, coverage?.comments, commentCount(posts)),
    requests: firstInteger(result?.requests_total, coverage?.requests_total, checkpoint?.state?.requests_total),
    posts: { total: posts.length, started, skipped },
    gaps: { queuedIds, missingIds, emptyMore, pendingAnchors, unresolvedAnchors, structural },
    diagnostics: aggregateDiagnostics(coverage, checkpoint),
  };
}

function reference(evidence, pointer) {
  return { file: evidence.name, pointer, sha256: evidence.sha256 };
}

async function verifyManifest(source, manifestEvidence, evidenceByName) {
  if (!manifestEvidence) return { status: 'missing', filesVerified: 0, trustedForIteration: false };
  const manifest = manifestEvidence.value;
  check(isObject(manifest), 'manifest.json must be an object');
  check(Array.isArray(manifest.files), 'manifest.json files must be an array');
  const seen = new Set();
  for (const record of manifest.files) {
    check(isObject(record) && typeof record.path === 'string' && Number.isSafeInteger(record.bytes) && /^[a-f0-9]{64}$/.test(record.sha256), 'Manifest file record is malformed');
    check(record.path && !record.path.includes('\\') && !path.posix.isAbsolute(record.path) && !record.path.split('/').includes('..'), 'Manifest path must be a safe relative POSIX path');
    check(!seen.has(record.path), 'Manifest contains a duplicate path');
    seen.add(record.path);
    const loadedSnapshot = evidenceByName.get(record.path);
    if (loadedSnapshot) {
      check(loadedSnapshot.bytes.length === record.bytes && loadedSnapshot.sha256 === record.sha256,
        `Loaded ${record.path} snapshot does not match the manifest`);
    }
    const file = path.resolve(source, ...record.path.split('/'));
    check(isInside(source, file), 'Manifest path escapes the run directory');
    const fileStat = await lstat(file);
    check(fileStat.isFile() && !fileStat.isSymbolicLink(), 'Manifest entry must be a regular non-symlink file');
    const resolved = await realpath(file);
    check(isInside(source, resolved), 'Manifest entry resolves outside the run directory');
    const bytes = await readFile(file);
    check(bytes.length === record.bytes && sha256(bytes) === record.sha256, 'Manifest entry bytes or SHA-256 mismatch');
  }
  const omittedCore = REQUIRED_MANIFEST_FILES.filter(name => !seen.has(name));
  check(omittedCore.length === 0, `Manifest omits required core evidence: ${omittedCore.join(', ')}`);
  const diskBatches = await numericBatchFiles(source);
  const manifestBatches = new Set([...seen].filter(name => NUMERIC_BATCH_PATTERN.test(name)));
  requireSameSet(diskBatches, manifestBatches, 'numeric batch');
  const diskReviewFiles = await existingReviewFiles(source);
  const manifestReviewFiles = new Set([...seen].filter(name => REVIEW_OUTPUT_FILES.includes(name)));
  requireSameSet(diskReviewFiles, manifestReviewFiles, 'review file');
  return { status: 'verified', filesVerified: seen.size, trustedForIteration: true };
}

function markdown(review) {
  const facts = review.facts;
  const lines = [
    '# Run retrospective', '',
    `- Business outcome: ${facts.status ?? 'unknown'} / ${facts.reason ?? 'unknown'}`,
    `- Saved comments: ${facts.comments ?? 'unknown'}`,
    `- Requests in lineage: ${facts.requests ?? 'unknown'}`,
    `- Posts initialized: ${facts.posts.started}/${facts.posts.total}; skipped: ${facts.posts.skipped}`,
    `- Missing IDs: ${facts.gaps.missingIds}; empty more: ${facts.gaps.emptyMore}`,
    `- Pending anchors: ${facts.gaps.pendingAnchors}; unresolved anchors: ${facts.gaps.unresolvedAnchors}`,
    `- Structural gaps: ${facts.gaps.structural}`,
    `- Manifest: ${review.integrity.manifest.status}; files checked: ${review.integrity.manifest.filesVerified}`,
    '', '## Observations', ''
  ];
  for (const item of review.observations) lines.push(`- ${item.id} [${item.severity}]: ${item.statement}`);
  lines.push('', '## Iteration boundary', '',
    'This review contains aggregate facts and evidence hashes. An Agent must classify any proposed change, reproduce a general defect, update a staged copy, and pass the release gates. No source was changed automatically.', '');
  return lines.join('\n');
}

function proposal(reviewBytes, review) {
  const trusted = review.integrity.manifest.trustedForIteration === true;
  const targets = [...new Set(review.observations.filter(item => item.iterationEligibility === 'review_required').map(item => item.suggestedTarget))];
  const hasChangeCandidate = targets.length > 0;
  return {
    schemaVersion: 1,
    state: trusted ? 'draft' : 'rejected',
    mutationPolicy: { autoApply: false, target: 'staged-copy-only' },
    sourceReviewSha256: sha256(reviewBytes),
    classification: trusted && hasChangeCandidate ? 'pending_agent_review' : 'no_change',
    candidateTargets: trusted && hasChangeCandidate ? targets : ['no_change'],
    evidenceRule: trusted
      ? 'Task-specific outcomes stay in the run directory. Promote only a reproducible general defect or repeated independent evidence.'
      : 'Manifest-backed evidence is missing or untrusted. Repair or finalize the run evidence before considering any Skill or Pack change.',
    requiredAgentFields: ['hypothesis', 'reproduction', 'invariant', 'minimal_changes', 'regressions', 'compatibility', 'versioning', 'rollback'],
    promotionChecks: ['exact_candidate_behavior_tests', 'pause_and_review_tests', 'release_cleanliness', 'portable_paths', 'independent_review', 'rollback_archive']
  };
}

function observations(facts, byName) {
  const resultEvidence = byName.get('result.json') ?? byName.get('coverage.json') ?? byName.get('checkpoint.json');
  const coverageEvidence = byName.get('coverage.json') ?? byName.get('checkpoint.json') ?? resultEvidence;
  const items = [];
  const runtimeAdapterReasons = new Set(['access_challenge_requires_wait_adapter', 'runtime_wait_failed', 'runtime_body_capability_missing']);
  const reviewReasons = new Set(['collector_error', ...runtimeAdapterReasons]);
  if (reviewReasons.has(facts.reason)) {
    items.push({
      id: 'nonterminal_business_status', kind: 'run_outcome', severity: 'review',
      statement: `Business status is ${facts.status}; this is a run fact, not a software root cause.`,
      evidence: [reference(resultEvidence, '/status')], iterationEligibility: 'review_required',
      suggestedTarget: runtimeAdapterReasons.has(facts.reason) ? 'runtime_adapter' : 'executor_and_docs',
    });
  }
  const gapTotal = Object.values(facts.gaps).reduce((sum, value) => sum + value, 0);
  if (gapTotal > 0) {
    items.push({
      id: 'coverage_gaps_present', kind: 'coverage', severity: 'info',
      statement: 'The run retained one or more explicit coverage gaps.',
      evidence: [reference(coverageEvidence, '/posts')], iterationEligibility: 'task_outcome_only',
      suggestedTarget: 'no_change',
    });
  }
  if (facts.gaps.structural > 0) {
    items.push({
      id: 'unparsed_response_shape', kind: 'coverage', severity: 'review',
      statement: 'One or more response nodes did not match the known parser contract.',
      evidence: [reference(coverageEvidence, '/posts')], iterationEligibility: 'review_required',
      suggestedTarget: 'executor_and_docs',
    });
  }
  if (facts.posts.skipped > 0) {
    items.push({
      id: 'posts_skipped', kind: 'run_outcome', severity: 'info',
      statement: 'One or more inputs were skipped under the run policy.',
      evidence: [reference(coverageEvidence, '/posts')], iterationEligibility: 'task_outcome_only',
      suggestedTarget: 'no_change',
    });
  }
  const executorDiagnostics = facts.diagnostics.filter(item => item.type === 'collector_error');
  if (executorDiagnostics.length > 0) {
    items.push({
      id: 'diagnostics_present', kind: 'diagnostic', severity: 'review',
      statement: 'The run contains bounded collector diagnostics that require Agent classification.',
      evidence: [reference(coverageEvidence, '/notices')], iterationEligibility: 'review_required',
      suggestedTarget: 'executor_and_docs',
    });
  }
  const runtimeDiagnostics = facts.diagnostics.filter(item => ['runtime_progress_disabled', 'runtime_timed_wait_failed', 'runtime_body_capability_missing'].includes(item.type));
  if (runtimeDiagnostics.length > 0) {
    items.push({
      id: 'runtime_adapter_diagnostics_present', kind: 'diagnostic', severity: 'review',
      statement: 'The run contains bounded runtime adapter diagnostics that require Agent classification.',
      evidence: [reference(coverageEvidence, '/notices')], iterationEligibility: 'review_required',
      suggestedTarget: 'runtime_adapter',
    });
  }
  if (!byName.has('manifest.json')) {
    items.push({
      id: 'manifest_missing', kind: 'integrity', severity: 'high',
      statement: 'No manifest.json was present; the evidence is untrusted for Skill or Pack iteration.',
      evidence: [reference(resultEvidence, '/')], iterationEligibility: 'task_outcome_only',
      suggestedTarget: 'no_change',
    });
  }
  if (items.length === 0) {
    items.push({
      id: 'no_automatic_change_signal', kind: 'run_outcome', severity: 'info',
      statement: 'No aggregate signal justifies an automatic Skill or Pack change.',
      evidence: [reference(resultEvidence, '/')], iterationEligibility: 'task_outcome_only',
      suggestedTarget: 'no_change',
    });
  }
  return items;
}

function suppressUntrustedCandidates(items) {
  return items.map(item => ({
    ...item,
    iterationEligibility: 'task_outcome_only',
    suggestedTarget: 'no_change',
  }));
}

export async function buildRunReview(runDirectory, newReviewDirectory, options = {}) {
  check(typeof runDirectory === 'string' && typeof newReviewDirectory === 'string', 'RUN_OUTPUT_DIR and NEW_REVIEW_DIR are required');
  const source = await realpath(path.resolve(runDirectory));
  check((await lstat(source)).isDirectory(), 'Run source must be a directory');
  const requestedDestination = path.resolve(newReviewDirectory);
  // mkdir below requires an existing parent; compare its physical identity.
  const destination = path.join(await realpath(path.dirname(requestedDestination)), path.basename(requestedDestination));
  check(source !== destination && !isInside(source, destination) && !isInside(destination, source), 'Run and review directories must not overlap');
  await requireNew(destination);

  const loaded = (await Promise.all(ALLOWED_FILES.map(name => readEvidence(source, name)))).filter(Boolean);
  check(loaded.length > 0, 'No supported run evidence files were found');
  const byName = new Map(loaded.map(item => [item.name, item]));
  const result = byName.get('result.json')?.value;
  const coverage = byName.get('coverage.json')?.value;
  const checkpoint = byName.get('checkpoint.json')?.value;
  check(result || coverage || checkpoint, 'A result, coverage, or checkpoint file is required');
  const facts = aggregateFacts(result, coverage, checkpoint);
  // Test-only race hook. CLI execution never supplies it and it is not part of the Pack contract.
  if (typeof options.__testAfterEvidenceRead === 'function') await options.__testAfterEvidenceRead();
  const manifestIntegrity = await verifyManifest(source, byName.get('manifest.json'), byName);
  const reviewObservations = observations(facts, byName);
  const review = {
    schemaVersion: REVIEW_SCHEMA,
    methodRevision: result?.method_revision ?? coverage?.method_revision ?? checkpoint?.state?.method_revision ?? null,
    createdAt: (options.now ? new Date(options.now()) : new Date()).toISOString(),
    sourcePolicy: { reviewMode: 'offline_audit', reviewNetworkAccess: false, autoMutationAllowed: false },
    facts,
    evidenceFiles: loaded
      .map(item => ({ path: item.name, bytes: item.bytes.length, sha256: item.sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    observations: manifestIntegrity.trustedForIteration ? reviewObservations : suppressUntrustedCandidates(reviewObservations),
    integrity: { manifest: manifestIntegrity },
    decision: manifestIntegrity.trustedForIteration
      ? {
          status: 'pending_agent_review',
          reason: 'Facts do not authorize source or documentation changes.',
          proposalRequired: true,
        }
      : {
          status: 'evidence_untrusted',
          reason: 'Manifest-backed evidence is required before proposing source or documentation changes.',
          proposalRequired: false,
        },
    nonGuarantee: 'This review contains aggregate facts from saved run evidence; it neither proves absolute coverage nor authorizes automatic source changes.',
  };

  await mkdir(destination, { recursive: false });
  try {
    const reviewBytes = Buffer.from(json(review));
    await atomicText(path.join(destination, 'run-retrospective.json'), reviewBytes.toString('utf8'));
    await atomicText(path.join(destination, 'run-retrospective.md'), markdown(review));
    await atomicJson(path.join(destination, 'iteration-proposal.json'), proposal(reviewBytes, review));
  }
  catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
  return review;
}

const invoked = process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => '') === await realpath(fileURLToPath(import.meta.url)).catch(() => '');
if (invoked) {
  if (process.argv.length !== 4) throw new Error('Usage: node review-run.mjs RUN_OUTPUT_DIR NEW_REVIEW_DIR');
  const review = await buildRunReview(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify({ review: 'run-retrospective.json', proposal: 'iteration-proposal.json', facts: review.facts, observations: review.observations.map(item => item.id) })}\n`);
}
