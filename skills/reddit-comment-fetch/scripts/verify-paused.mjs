#!/usr/bin/env node
/** Minimal independent offline checks for finalize-paused.mjs; no collector is started. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { finalizePaused } from './finalize-paused.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const text = value => `${JSON.stringify(value, null, 2)}\n`;
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function withCase(name, run) {
  const root = await mkdtemp(path.join(tmpdir(), `reddit-paused-${name}-`));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function fixture(root) {
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'batches'), { recursive: true });
  const value = { post_ids: ['abc123', 'def456'], sort: 'confidence' };
  const identity = { ...value, sha256: sha(JSON.stringify(value)) };
  const rootUrl = 'https://www.reddit.com/comments/abc123.json?raw_json=1&sort=confidence&limit=500';
  const records = [
    { sequence: 1, identity_sha256: identity.sha256, request: { kind: 'initial', post_id: 'abc123', children: [] }, url: rootUrl, status: 200, outcome: 'ok', payload: [], received_ms: 1 },
    { sequence: 2, identity_sha256: identity.sha256, request: { kind: 'thread', post_id: 'abc123', comment_id: 'aa', children: [] }, url: `${rootUrl}&comment=aa&context=0&depth=10`, status: 200, outcome: 'ok', payload: [], received_ms: 2 },
  ];
  const comments = {
    aa: { post_id: 'abc123', comment_id: 'aa', fullname: 't1_aa', parent_id: 't3_abc123', body: '=2+2\na,"b"', body_state: 'present', source_batch: '00000001.json' },
    bb: { post_id: 'abc123', comment_id: 'bb', fullname: 't1_bb', parent_id: 't1_aa', body: '[deleted]', body_state: 'deleted', source_batch: '00000002.json' },
  };
  const emptyMore = {
    first: { parent_id: 't1_aa', count: 0, children_empty: true, context: { more_id: '_', source_batch: '00000001.json' } },
    second: { parent_id: 't1_bb', count: 0, children_empty: true, context: { more_id: '_', source_batch: '00000002.json' } },
  };
  const emptyPost = id => ({ id, initial: false, metadata: null, comments: {}, queue: [], attempts: {}, missing_ids: {}, empty_more: {}, structural_gaps: [], thread_anchors: {}, resolved_empty_more: {} });
  const firstPost = { ...emptyPost('abc123'), initial: true, comments, empty_more: emptyMore,
    thread_anchors: { aa: { comment_id: 'aa', status: 'resolved', successful_reads: 1, attempts: 1 }, bb: { comment_id: 'bb', status: 'pending', successful_reads: 0, attempts: 0 } },
    resolved_empty_more: { first: { ...emptyMore.first, anchor_id: 'aa', resolved_by_batch: '00000002.json', direct_comment_ids: ['bb'], direct_more_ids: [] } },
  };
  const state = { schema: 1, method_revision: 'experimental-thread-anchors-v1', identity, created_at: '2000-01-01T00:00:00.000Z',
    next_sequence: 4, last_applied: 2, batch_hashes: Object.fromEntries(records.map(record => [record.sequence, sha(JSON.stringify(record))])),
    requests_total: 3, request_times: [1, 2, 3], pending: { sequence: 3, request: { kind: 'thread', post_id: 'abc123', comment_id: 'bb', children: [] }, started_ms: 3 },
    rate_limit_hits: 0, auth_hits: 0, transient_failures: {}, action: null, notices: [], posts: [firstPost, emptyPost('def456')],
  };
  await writeFile(path.join(source, 'checkpoint.json'), text({ schema: 1, state_sha256: sha(JSON.stringify(state)), state }));
  for (const record of records) await writeFile(path.join(source, 'batches', `${String(record.sequence).padStart(8, '0')}.json`), text({ schema: 1, record_sha256: sha(JSON.stringify(record)), record }));
  return { source, state, records, comments };
}

test('OFFLINE PAUSED: rebuilds counts and deep coverage while preserving pending state and every evidence byte', async () => {
  await withCase('valid', async root => {
    const data = await fixture(root), destination = path.join(root, 'final');
    const originalCheckpoint = await readFile(path.join(data.source, 'checkpoint.json'));
    const originalBatches = new Map();
    for (const name of await readdir(path.join(data.source, 'batches'))) originalBatches.set(name, await readFile(path.join(data.source, 'batches', name)));
    const result = await finalizePaused(data.source, destination);
    assert.equal(result.status, 'partial');
    assert.equal(result.reason, 'user_paused');
    assert.equal(result.derived_offline, true);
    assert.equal(result.comments, 2);
    assert.equal(result.requests_total, 3);
    assert.equal(result.requests_this_run, null);
    assert.equal(result.pending_without_durable_response, true);
    assert.deepEqual(await readFile(path.join(destination, 'checkpoint.json')), originalCheckpoint);
    assert.deepEqual(await readFile(path.join(data.source, 'checkpoint.json')), originalCheckpoint);
    const rows = (await readFile(path.join(destination, 'comments.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows, Object.values(data.comments));
    const coverage = await readJson(path.join(destination, 'coverage.json'));
    assert.deepEqual(coverage.thread_anchors, { total: 2, pending: 1, resolved: 1, unresolved: 0 });
    assert.equal(coverage.remaining_unresolved, 1);
    assert.equal(coverage.posts[0].empty_more.length, 1);
    assert.equal(coverage.posts[0].resolved_empty_more.length, 1);
    assert.equal(coverage.posts[1].initial_received, false);
    assert.equal(coverage.posts[1].skipped_unavailable, null, 'A never-visited post must not be relabeled skipped');
    for (const [name, bytes] of originalBatches) {
      assert.deepEqual(await readFile(path.join(destination, 'batches', name)), bytes);
      assert.deepEqual(await readFile(path.join(data.source, 'batches', name)), bytes);
    }
    const manifest = await readJson(path.join(destination, 'manifest.json'));
    assert.equal(manifest.derived_offline, true);
    assert.equal(manifest.checkpoint_preserved_byte_for_byte, true);
    assert.equal(manifest.source_checkpoint_sha256, sha(originalCheckpoint));
    for (const file of manifest.files) {
      const bytes = await readFile(path.join(destination, file.path));
      assert.equal(file.bytes, bytes.length);
      assert.equal(file.sha256, sha(bytes));
    }
  });
});

test('OFFLINE PAUSED: accepts a genuine null-revision schema-1 initial/more checkpoint', async () => {
  await withCase('legacy-initial-more', async root => {
    const data = await fixture(root);
    await rm(path.join(data.source, 'batches', '00000002.json'));
    const checkpointFile = path.join(data.source, 'checkpoint.json');
    const checkpoint = await readJson(checkpointFile);
    delete checkpoint.state.method_revision;
    checkpoint.state.last_applied = 1;
    checkpoint.state.next_sequence = 2;
    checkpoint.state.batch_hashes = { 1: sha(JSON.stringify(data.records[0])) };
    checkpoint.state.requests_total = 1;
    checkpoint.state.request_times = [1];
    checkpoint.state.pending = null;
    delete checkpoint.state.posts[0].comments.bb;
    checkpoint.state.posts[0].empty_more = { first: checkpoint.state.posts[0].empty_more.first };
    for (const post of checkpoint.state.posts) {
      delete post.thread_anchors;
      delete post.resolved_empty_more;
    }
    checkpoint.state_sha256 = sha(JSON.stringify(checkpoint.state));
    await writeFile(checkpointFile, text(checkpoint));
    const destination = path.join(root, 'delivery');
    const result = await finalizePaused(data.source, destination);
    assert.equal(result.status, 'partial');
    assert.equal(result.method_revision, null);
    assert.equal(result.comments, 1);
    const coverage = await readJson(path.join(destination, 'coverage.json'));
    assert.deepEqual(coverage.thread_anchors, { total: 0, pending: 0, resolved: 0, unresolved: 0 });
  });
});

test('OFFLINE PAUSED: rejects checkpoint tampering, altered applied batches, and missing earlier history', async () => {
  for (const mutation of ['checkpoint', 'envelope', 'rehash-envelope', 'missing-earlier']) await withCase(mutation, async root => {
    const { source } = await fixture(root), destination = path.join(root, 'final');
    if (mutation === 'checkpoint') {
      const checkpoint = await readJson(path.join(source, 'checkpoint.json'));
      checkpoint.state.posts[0].comments.aa.body = 'Changed outside the saved state digest';
      await writeFile(path.join(source, 'checkpoint.json'), text(checkpoint));
    } else if (mutation === 'missing-earlier') await rm(path.join(source, 'batches', '00000001.json'));
    else {
      const file = path.join(source, 'batches', '00000001.json');
      const envelope = await readJson(file);
      envelope.record.payload = ['rewritten response'];
      if (mutation === 'rehash-envelope') envelope.record_sha256 = sha(JSON.stringify(envelope.record));
      await writeFile(file, text(envelope));
    }
    await assert.rejects(finalizePaused(source, destination), /checksum|hash ledger|history|incomplete/i);
    await assert.rejects(readFile(path.join(destination, 'result.json')), { code: 'ENOENT' });
  });
});

test('OFFLINE PAUSED: rejects an unapplied durable response without discarding its journal', async () => {
  await withCase('unapplied', async root => {
    const { source, records } = await fixture(root), destination = path.join(root, 'final');
    const record = { ...records[1], sequence: 3, request: { ...records[1].request, comment_id: 'bb' }, url: records[1].url.replace('comment=aa', 'comment=bb') };
    const bytes = Buffer.from(text({ schema: 1, record_sha256: sha(JSON.stringify(record)), record }));
    const journal = path.join(source, 'batches', '00000003.json');
    await writeFile(journal, bytes);
    await assert.rejects(finalizePaused(source, destination), /Unapplied durable batch.*normal Pack resume/i);
    assert.deepEqual(await readFile(journal), bytes);
    await assert.rejects(readFile(path.join(destination, 'result.json')), { code: 'ENOENT' });
  });
});

test('OFFLINE PAUSED: rejects an existing destination without overwriting it', async () => {
  await withCase('existing-destination', async root => {
    const { source } = await fixture(root), destination = path.join(root, 'final');
    await mkdir(destination);
    const marker = path.join(destination, 'keep.txt');
    await writeFile(marker, 'Keep this existing content');
    await assert.rejects(finalizePaused(source, destination), /Destination already exists/i);
    assert.equal(await readFile(marker, 'utf8'), 'Keep this existing content');
  });
});

test('OFFLINE PAUSED: rejects an unknown method revision before deriving a delivery', async () => {
  await withCase('unknown-revision', async root => {
    const { source } = await fixture(root);
    const checkpointFile = path.join(source, 'checkpoint.json');
    const checkpoint = await readJson(checkpointFile);
    checkpoint.state.method_revision = 'unknown-fixture-revision';
    checkpoint.state_sha256 = sha(JSON.stringify(checkpoint.state));
    await writeFile(checkpointFile, text(checkpoint));
    await assert.rejects(finalizePaused(source, path.join(root, 'delivery')), /Unsupported checkpoint method revision/);
  });
});

test('OFFLINE PAUSED: a null legacy revision rejects focused state and thread batches before creating a delivery', async () => {
  for (const variant of ['focused-state', 'thread-batch-only']) await withCase(`legacy-${variant}`, async root => {
    const { source } = await fixture(root);
    const checkpointFile = path.join(source, 'checkpoint.json');
    const checkpoint = await readJson(checkpointFile);
    delete checkpoint.state.method_revision;
    if (variant === 'thread-batch-only') {
      for (const post of checkpoint.state.posts) {
        delete post.thread_anchors;
        delete post.resolved_empty_more;
      }
      checkpoint.state.pending = null;
    }
    checkpoint.state_sha256 = sha(JSON.stringify(checkpoint.state));
    await writeFile(checkpointFile, text(checkpoint));
    const destination = path.join(root, 'delivery');
    await assert.rejects(finalizePaused(source, destination), /Legacy checkpoint without method_revision contains focused-thread state or batches/);
    await assert.rejects(readFile(path.join(destination, 'result.json')), { code: 'ENOENT' });
  });
});
