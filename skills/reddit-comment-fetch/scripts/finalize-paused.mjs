#!/usr/bin/env node
/** Offline only: preserve a paused checkpoint and journal, then rebuild partial deliverables. */
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACK_CONTRACT, buildEndpoint } from '../assets/reddit-comment-tree-pack/collect.mjs';

const SCHEMA = PACK_CONTRACT.stateSchema;
const SUPPORTED_SOURCE_REVISIONS = new Set(PACK_CONTRACT.supportedSourceRevisions);
const NON_GUARANTEE = 'This offline snapshot contains only comment objects already saved in the paused checkpoint. It does not guarantee historical, deleted, removed, restricted, or absolute full coverage. num_comments is not a coverage denominator.';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const batchName = sequence => `${String(sequence).padStart(8, '0')}.json`;
const inside = (base, file) => { const relative = path.relative(base, file); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

async function requireNew(directory) {
  try { await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Destination already exists; choose a new directory');
}
async function regularFile(file, root) {
  check((await lstat(file)).isFile(), 'Evidence must be a regular, non-symlink file');
  check(inside(root, await realpath(file)), 'Evidence resolves outside the source directory');
}
async function fileHash(file) {
  let bytes = 0;
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) { bytes += chunk.length; digest.update(chunk); }
  return { bytes, sha256: digest.digest('hex') };
}
function parse(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`${label} is not valid JSON`); }
}
function validateRequest(request, identity) {
  check(object(request) && identity.post_ids.includes(request.post_id), 'Batch request post is outside the checkpoint identity');
  check(['initial', 'more', 'thread'].includes(request.kind), 'Unsupported batch request kind');
  check(Array.isArray(request.children) && request.children.length <= 100 && request.children.every(id => typeof id === 'string' && /^[a-z0-9]+$/.test(id)), 'Invalid batch children');
  check(request.kind === 'more' || request.children.length === 0, 'Only more requests can contain child IDs');
  if (request.kind === 'thread') check(typeof request.comment_id === 'string' && /^[a-z0-9]+$/.test(request.comment_id), 'Invalid focused-thread anchor');
}
function buildCoverage(state) {
  const posts = state.posts.map(post => {
    const resolved = post.resolved_empty_more ?? {};
    const anchors = Object.values(post.thread_anchors ?? {});
    return {
      post_id: post.id, initial_received: post.initial, comments: Object.keys(post.comments).length,
      skipped_unavailable: post.skipped_unavailable ?? null,
      advertised_num_comments: post.metadata?.advertised_num_comments ?? null,
      queue_count: post.queue.length, queued_ids: post.queue,
      missing_ids: Object.values(post.missing_ids),
      empty_more: Object.entries(post.empty_more).filter(([key]) => !Object.hasOwn(resolved, key)).map(([, entry]) => entry),
      resolved_empty_more: Object.values(resolved), thread_anchors: anchors,
      remaining_unresolved: anchors.filter(anchor => anchor.status !== 'resolved').length,
      structural_gaps: post.structural_gaps,
      missing_parent_ids: [...new Set(Object.values(post.comments).map(comment => comment.parent_id).filter(id => /^t1_/.test(id ?? '') && !Object.hasOwn(post.comments, id.slice(3))))],
    };
  });
  const anchors = posts.flatMap(post => post.thread_anchors);
  const threadStats = {
    total: anchors.length, pending: anchors.filter(anchor => anchor.status === 'pending').length,
    resolved: anchors.filter(anchor => anchor.status === 'resolved').length,
    unresolved: anchors.filter(anchor => anchor.status === 'unresolved').length,
  };
  return {
    schema: SCHEMA, method_revision: state.method_revision ?? null,
    status: 'partial', reason: 'user_paused', derived_offline: true,
    sort: state.identity.sort, thread_anchors: threadStats,
    remaining_unresolved: threadStats.pending + threadStats.unresolved,
    non_guarantee: NON_GUARANTEE, posts, notices: state.notices ?? [],
  };
}

/** Does not launch a browser, contact a server, modify source state, or replay journal entries. */
export async function finalizePaused(sourceDir, newDestinationDir) {
  check(typeof sourceDir === 'string' && typeof newDestinationDir === 'string', 'Both SOURCE_DIR and NEW_DEST_DIR are required');
  const source = await realpath(path.resolve(sourceDir));
  check((await lstat(source)).isDirectory(), 'Source must be a directory');
  const requestedDestination = path.resolve(newDestinationDir);
  check(source !== requestedDestination && !inside(source, requestedDestination) && !inside(requestedDestination, source), 'Source and destination must not overlap');
  await requireNew(requestedDestination);

  const checkpointPath = path.join(source, 'checkpoint.json');
  await regularFile(checkpointPath, source);
  const checkpointBytes = await readFile(checkpointPath);
  const checkpoint = parse(checkpointBytes, 'Checkpoint');
  const state = checkpoint.state;
  check(checkpoint.schema === SCHEMA && object(state) && state.schema === SCHEMA, 'Unsupported checkpoint schema');
  check(checkpoint.state_sha256 === hash(JSON.stringify(state)), 'Checkpoint state checksum mismatch');
  const sourceRevision = state.method_revision ?? null;
  check(SUPPORTED_SOURCE_REVISIONS.has(sourceRevision), 'Unsupported checkpoint method revision');
  check(Array.isArray(state.posts) && state.posts.length >= 1 && state.posts.length <= PACK_CONTRACT.maxPosts, 'Checkpoint posts are invalid');
  if (sourceRevision === null) {
    const hasFocusedState = state.posts.some(post => Object.hasOwn(post, 'thread_anchors') || Object.hasOwn(post, 'resolved_empty_more'));
    const hasFocusedPending = state.pending?.request?.kind === 'thread';
    check(!hasFocusedState && !hasFocusedPending, 'Legacy checkpoint without method_revision contains focused-thread state or batches');
  }
  const postIds = state.posts.map(post => post.id);
  check(postIds.every(id => typeof id === 'string' && /^[a-z0-9]+$/.test(id)) && new Set(postIds).size === postIds.length, 'Checkpoint post IDs are invalid or duplicated');
  const expectedIdentity = { post_ids: [...postIds].sort(), sort: PACK_CONTRACT.sort };
  check(object(state.identity) && JSON.stringify(state.identity.post_ids) === JSON.stringify(expectedIdentity.post_ids) && state.identity.sort === expectedIdentity.sort && state.identity.sha256 === hash(JSON.stringify(expectedIdentity)), 'Checkpoint identity checksum or post set mismatch');
  check(integer(state.last_applied) && Number.isSafeInteger(state.next_sequence) && state.next_sequence > state.last_applied, 'Checkpoint sequence positions are invalid');
  check(integer(state.requests_total), 'Checkpoint requests_total is invalid');
  check(object(state.batch_hashes), 'Checkpoint has no complete applied-batch hash ledger');

  const batchesDir = path.join(source, 'batches');
  let names = [];
  try {
    check((await lstat(batchesDir)).isDirectory(), 'batches must be a regular, non-symlink directory');
    names = (await readdir(batchesDir)).sort();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  check(names.every(name => /^\d{8}\.json$/.test(name)), 'Unexpected or unfinished file in batches; refuse to discard journal evidence');
  const verifiedBatches = [];
  let maximum = 0;
  for (const name of names) {
    const sourceFile = path.join(batchesDir, name);
    await regularFile(sourceFile, source);
    const bytes = await readFile(sourceFile);
    const envelope = parse(bytes, `Batch ${name}`);
    const record = envelope.record;
    check(envelope.schema === SCHEMA && object(record), `Batch ${name} has an unsupported schema`);
    const recordHash = hash(JSON.stringify(record));
    check(envelope.record_sha256 === recordHash, `Batch ${name} envelope checksum mismatch`);
    check(Number.isSafeInteger(record.sequence) && record.sequence > 0 && name === batchName(record.sequence), `Batch ${name} sequence mismatch`);
    check(record.identity_sha256 === state.identity.sha256, `Batch ${name} identity mismatch`);
    validateRequest(record.request, state.identity);
    if (sourceRevision === null) check(record.request.kind !== 'thread', 'Legacy checkpoint without method_revision contains focused-thread state or batches');
    check(record.url === buildEndpoint(record.request, state.identity.sort), `Batch ${name} endpoint mismatch`);
    check(record.sequence <= state.last_applied, `Unapplied durable batch ${name} exists; use normal Pack resume to replay it before offline finalization`);
    check(Object.hasOwn(state.batch_hashes, String(record.sequence)) && state.batch_hashes[String(record.sequence)] === recordHash, `Applied batch ${name} differs from the checkpoint hash ledger`);
    maximum = Math.max(maximum, record.sequence);
    verifiedBatches.push({ name, sequence: record.sequence, bytes: bytes.length, sha256: hash(bytes) });
  }
  check(maximum === state.last_applied, 'Maximum durable batch is not last_applied; applied history is incomplete');
  const bySequence = new Map(verifiedBatches.map(batch => [String(batch.sequence), batch]));
  for (const [sequence, digest] of Object.entries(state.batch_hashes)) {
    check(/^[1-9]\d*$/.test(sequence) && bySequence.has(sequence) && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'Applied checkpoint history is missing or malformed');
  }
  check(Object.keys(state.batch_hashes).length === verifiedBatches.length, 'Checkpoint and durable journal history differ');
  check(state.requests_total >= verifiedBatches.length, 'Request total is below its durable batch count');
  if (state.pending != null) {
    check(object(state.pending) && Number.isSafeInteger(state.pending.sequence) && state.pending.sequence > state.last_applied && state.pending.sequence < state.next_sequence && !bySequence.has(String(state.pending.sequence)), 'Pending request conflicts with durable or applied journal state');
    validateRequest(state.pending.request, state.identity);
  }

  const commentIds = new Set();
  for (const post of state.posts) {
    check(typeof post.initial === 'boolean' && object(post.comments) && Array.isArray(post.queue) && object(post.missing_ids) && object(post.empty_more) && Array.isArray(post.structural_gaps), 'Checkpoint post state cannot be rebuilt safely');
    check(post.resolved_empty_more === undefined || object(post.resolved_empty_more), 'Invalid resolved empty-more state');
    check(post.thread_anchors === undefined || object(post.thread_anchors), 'Invalid focused-anchor state');
    for (const anchor of Object.values(post.thread_anchors ?? {})) check(object(anchor) && ['pending', 'resolved', 'unresolved'].includes(anchor.status), 'Unsupported focused-anchor status');
    for (const [id, comment] of Object.entries(post.comments)) {
      check(object(comment) && comment.comment_id === id && /^[a-z0-9]+$/.test(id) && comment.post_id === post.id && !commentIds.has(id), 'Checkpoint comment identity is invalid or duplicated');
      check(typeof comment.body === 'string', 'Checkpoint contains a non-string comment body');
      check(typeof comment.source_batch === 'string' && names.includes(comment.source_batch), 'Checkpoint comment refers to missing raw evidence');
      commentIds.add(id);
    }
  }
  const coverage = buildCoverage(state);

  await mkdir(path.dirname(requestedDestination), { recursive: true });
  const parent = await realpath(path.dirname(requestedDestination));
  const destination = path.join(parent, path.basename(requestedDestination));
  check(source !== destination && !inside(source, destination) && !inside(destination, source), 'Resolved source and destination overlap');
  await requireNew(destination);
  const stagePrefix = `${path.basename(destination)}.offline-`;
  const staging = path.join(parent, `${stagePrefix}${randomUUID()}`);
  await mkdir(staging);
  try {
    await mkdir(path.join(staging, 'batches'));
    await writeFile(path.join(staging, 'checkpoint.json'), checkpointBytes, { flag: 'wx' });
    for (const batch of verifiedBatches) {
      const target = path.join(staging, 'batches', batch.name);
      await copyFile(path.join(batchesDir, batch.name), target);
      const actual = await fileHash(target);
      check(actual.bytes === batch.bytes && actual.sha256 === batch.sha256, `Source batch changed while copying: ${batch.name}`);
    }
    check((await readFile(checkpointPath)).equals(checkpointBytes), 'Source checkpoint changed during finalization');
    let latestNames = [];
    try { latestNames = (await readdir(batchesDir)).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    check(JSON.stringify(latestNames) === JSON.stringify(names), 'Source journal changed during finalization');

    const result = {
      status: 'partial', reason: 'user_paused', derived_offline: true,
      comments: commentIds.size, requests_this_run: null, requests_total: state.requests_total,
      output_dir: '.', coverage_file: 'coverage.json', comments_file: 'comments.jsonl', checkpoint_file: 'checkpoint.json',
      method_revision: state.method_revision ?? null, thread_anchors: coverage.thread_anchors,
      remaining_unresolved: coverage.remaining_unresolved, pending_without_durable_response: state.pending != null,
      non_guarantee: NON_GUARANTEE,
    };
    async function* lines() { for (const post of state.posts) for (const comment of Object.values(post.comments)) yield `${JSON.stringify(comment)}\n`; }
    await pipeline(Readable.from(lines()), createWriteStream(path.join(staging, 'comments.jsonl'), { flags: 'wx', encoding: 'utf8' }));
    await writeFile(path.join(staging, 'coverage.json'), json(coverage), { flag: 'wx' });
    await writeFile(path.join(staging, 'result.json'), json(result), { flag: 'wx' });
    const files = [];
    for (const relative of ['checkpoint.json', 'comments.jsonl', 'coverage.json', 'result.json', ...names.map(name => `batches/${name}`)]) files.push({ path: relative, ...await fileHash(path.join(staging, relative)) });
    await writeFile(path.join(staging, 'manifest.json'), json({
      schema: SCHEMA, identity: state.identity, status: 'partial', reason: 'user_paused', derived_offline: true,
      generated_at_utc: new Date().toISOString(), checkpoint_preserved_byte_for_byte: true,
      source_checkpoint_sha256: hash(checkpointBytes), files, non_guarantee: NON_GUARANTEE,
    }), { flag: 'wx' });
    await rename(staging, destination);
    return result;
  } catch (error) {
    check(inside(parent, staging) && path.basename(staging).startsWith(stagePrefix), 'Refusing to clean an unexpected staging path');
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

const invoked = process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => '') === await realpath(fileURLToPath(import.meta.url)).catch(() => '');
if (invoked) {
  if (process.argv.length !== 4) { console.error('Usage: node finalize-paused.mjs SOURCE_DIR NEW_DEST_DIR'); process.exitCode = 1; }
  else finalizePaused(process.argv[2], process.argv[3]).then(result => console.log(json(result))).catch(error => { console.error(`Offline finalization refused: ${error.message}`); process.exitCode = 1; });
}
