#!/usr/bin/env node
/**
 * Independent, offline behavior checks for the focused-thread continuation pack.
 * Runs on Node builtins, uses fake Reddit responses and a virtual clock, and
 * never starts Task Master, a browser, or a network connection.
 * Usage: node scripts/verify-pack.mjs [/absolute/path/to/actual-collect.mjs]
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const requestedModule = process.argv[2];
if (process.argv.length > 3) throw new Error('Usage: node scripts/verify-pack.mjs [/absolute/path/to/actual-collect.mjs]');
if (requestedModule && !path.isAbsolute(requestedModule)) throw new Error('The explicit collect.mjs path must be absolute');
const moduleUrl = requestedModule ? pathToFileURL(requestedModule) : new URL('../assets/reddit-comment-tree-pack/collect.mjs', import.meta.url);
const { collect, normalizeInput } = await import(moduleUrl.href);
assert.equal(typeof collect, 'function', 'The tested module must export collect(runtime, adapters)');
assert.equal(typeof normalizeInput, 'function', 'The tested module must export normalizeInput(input)');
console.log(`# OFFLINE module under test: ${fileURLToPath(moduleUrl)}`);

const POST = 'abc123';
const POST_URL = `https://www.reddit.com/r/fixture/comments/${POST}/offline_fixture/`;

function comment(id, replies = '', parent = `t3_${POST}`, overrides = {}) {
  return { kind: 't1', data: {
    id, name: `t1_${id}`, parent_id: parent, link_id: `t3_${POST}`,
    body: `Offline fixture ${id}`, author: 'offline_fixture',
    created_utc: 1700000000, score: 1, replies, ...overrides,
  } };
}

function listing(children) { return { kind: 'Listing', data: { children } }; }
function more(ids, parent = `t3_${POST}`, count = ids.length) {
  return { kind: 'more', data: { id: ids[0] || '_', name: `more_${ids[0] || '_'}`, parent_id: parent, children: ids, count } };
}
function seed(children, postId = POST) {
  return [listing([{ kind: 't3', data: { id: postId, name: `t3_${postId}`, num_comments: 999 } }]), listing(children)];
}
function expanded(things) { return { json: { errors: [], data: { things } } }; }
function childrenRequested(url) { return new URL(url).searchParams.get('children')?.split(',').filter(Boolean) || []; }
function isMore(url) { return new URL(url).pathname.includes('morechildren'); }
async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function rows(dir) {
  const text = await readFile(path.join(dir, 'comments.jsonl'), 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
function ids(comments) { return comments.map(row => row.id || row.comment_id || row.data?.id).sort(); }

async function withCase(label, body) {
  const root = await mkdtemp(path.join(tmpdir(), `reddit-pack-offline-${label}-`));
  try { await body(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function harness(root, name, responder, input = {}, hooks = {}) {
  const outputDir = path.join(root, name);
  await mkdir(outputDir, { recursive: true });
  let now = 1700000000000;
  let body = '';
  let currentUrl = '';
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const sleeps = [];
  const waits = [];
  const updates = [];
  const page = {
    async goto(url) {
      active++;
      maxActive = Math.max(active, maxActive);
      calls.push({ url, at: now });
      currentUrl = url;
      try {
        await new Promise(resolve => setImmediate(resolve));
        const response = await responder(url, calls.length);
        body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
        const reply = { status: () => response.status ?? 200, headers: () => response.headers || {}, url: () => url };
        if (response.useResponseText) reply.text = async () => body;
        return reply;
      } finally { active--; }
    },
    locator(selector) {
      assert.equal(selector, 'body', 'Collector must read the structured response body');
      return { innerText: async () => body };
    },
    url() { return currentUrl; },
  };
  const runtime = {
    input: { posts: [POST_URL], maxRequests: 30, ...input }, outputDir, page,
    signal: new AbortController().signal,
    progress: async value => { updates.push(value); },
    wait: async value => {
      waits.push(value);
      if (Number.isFinite(value?.resumeAfterMs)) now += value.resumeAfterMs;
      return { resumed: true };
    },
  };
  const adapters = {
    now: () => now,
    sleep: async milliseconds => {
      assert.ok(Number.isFinite(milliseconds) && milliseconds >= 0);
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    ...hooks,
  };
  return { outputDir, runtime, adapters, calls, waits, sleeps, updates,
    maxActive: () => maxActive, now: () => now,
    run: () => collect(runtime, adapters),
  };
}

test('OFFLINE: nested comments, recursive more IDs, and duplicate comments are merged', async () => {
  await withCase('recursive', async root => {
    const h = await harness(root, 'run', url => {
      if (!isMore(url)) return { body: seed([
        comment('aa', listing([comment('bb', '', 't1_aa'), more(['cc', 'aa'], 't1_aa')])),
      ]) };
      const requested = childrenRequested(url);
      if (requested.includes('cc')) return { body: expanded([
        comment('cc', listing([comment('dd', '', 't1_cc'), more(['ee'], 't1_cc')]), 't1_aa'),
        comment('bb', '', 't1_aa'),
      ]) };
      assert.deepEqual(requested, ['ee']);
      return { body: expanded([comment('ee', '', 't1_cc')]) };
    });
    const result = await h.run();
    assert.equal(result.status, 'exhausted_accessible');
    assert.deepEqual(ids(await rows(h.outputDir)), ['aa', 'bb', 'cc', 'dd', 'ee']);
    assert.equal(h.calls.length, 3);
    assert.ok(h.calls.filter(call => isMore(call.url)).every(call => !childrenRequested(call.url).includes('aa')));
  });
});

test('OFFLINE: morechildren batches never exceed 100 and requests remain serial', async () => {
  await withCase('batching', async root => {
    const wanted = Array.from({ length: 205 }, (_, index) => `c${index.toString(36)}`);
    const h = await harness(root, 'run', url => ({ body: isMore(url)
      ? expanded(childrenRequested(url).map(id => comment(id)))
      : seed([more(wanted)]) }));
    const result = await h.run();
    const batches = h.calls.filter(call => isMore(call.url)).map(call => childrenRequested(call.url));
    assert.equal(result.status, 'exhausted_accessible');
    assert.deepEqual(batches.map(batch => batch.length), [100, 100, 5]);
    assert.equal(h.maxActive(), 1);
    assert.deepEqual(ids(await rows(h.outputDir)), [...wanted].sort());
  });
});

test('OFFLINE: IDs absent from responses have bounded retries and an explicit gap', async () => {
  await withCase('missing', async root => {
    const h = await harness(root, 'run', url => ({ body: isMore(url) ? expanded([]) : seed([more(['zz'])]) }));
    const result = await h.run();
    const coverage = await json(path.join(h.outputDir, 'coverage.json'));
    assert.equal(h.calls.filter(call => isMore(call.url)).length, 2);
    assert.equal(result.status, 'partial', 'Unreturned IDs are a known unresolved gap');
    assert.deepEqual(coverage.posts[0].missing_ids.map(item => item.id), ['zz']);
    assert.equal(coverage.posts[0].missing_ids[0].attempts, 2);
    assert.ok(coverage.non_guarantee, 'Exhausted accessible must not claim all platform comments were collected');
  });
});

test('OFFLINE: a more node with no children stays an unresolved coverage gap', async () => {
  await withCase('empty-more', async root => {
    const h = await harness(root, 'run', () => ({ body: seed([comment('aa'), more([], 't1_aa', 5)]) }));
    const result = await h.run();
    assert.equal(result.status, 'partial', 'An empty-children more node remains unresolved');
    const coverage = await json(path.join(h.outputDir, 'coverage.json'));
    assert.equal(coverage.posts[0].empty_more.length, 1);
    assert.equal(coverage.posts[0].empty_more[0].parent_id, 't1_aa');
    assert.equal(coverage.posts[0].empty_more[0].count, 5);
    assert.equal(h.calls.length, 1, 'An ordinary empty-more gap without a continue-thread marker is not a focused anchor');
  });
});

test('OFFLINE: a request budget produces partial output and resumes explicitly into a new directory', async () => {
  await withCase('budget-resume', async root => {
    const first = await harness(root, 'first', () => ({ body: seed([comment('aa'), more(['bb'])]) }), { maxRequests: 1 });
    const firstResult = await first.run();
    assert.equal(firstResult.status, 'partial');
    assert.deepEqual(ids(await rows(first.outputDir)), ['aa']);
    const second = await harness(root, 'second', url => {
      assert.ok(isMore(url), 'Resume must not refetch an already saved initial tree');
      assert.deepEqual(childrenRequested(url), ['bb']);
      return { body: expanded([comment('bb')]) };
    }, { resumeFrom: first.outputDir });
    const secondResult = await second.run();
    assert.equal(secondResult.status, 'exhausted_accessible');
    assert.equal(second.calls.length, 1);
    assert.deepEqual(ids(await rows(second.outputDir)), ['aa', 'bb']);
    assert.deepEqual(ids(await rows(first.outputDir)), ['aa'], 'Resume source artifacts stay unchanged');
  });
});

test('OFFLINE: a batch durable before checkpoint application is replayed after a simulated crash', async () => {
  await withCase('journal-replay', async root => {
    let batchesWritten = 0;
    const first = await harness(root, 'first', url => ({ body: isMore(url)
      ? expanded([comment('bb')]) : seed([comment('aa'), more(['bb'])]) }), {}, {
      afterBatchWrite: async () => { if (++batchesWritten === 2) throw new Error('OFFLINE_SIMULATED_CRASH_AFTER_DURABLE_BATCH'); },
    });
    const firstResult = await first.run();
    assert.equal(firstResult.status, 'partial');
    assert.equal(batchesWritten, 2);
    assert.deepEqual(ids(await rows(first.outputDir)), ['aa'], 'Crash occurs before the second batch is applied to collected rows');
    const second = await harness(root, 'second', () => { throw new Error('Unexpected network request during durable journal replay'); }, { resumeFrom: first.outputDir });
    const secondResult = await second.run();
    assert.equal(secondResult.status, 'exhausted_accessible');
    assert.equal(second.calls.length, 0);
    assert.deepEqual(ids(await rows(second.outputDir)), ['aa', 'bb']);
  });
});

test('OFFLINE: HTTP 401 and 403 allow one human wait and then block repeated failures', async () => {
  for (const status of [401, 403]) await withCase(`http-${status}`, async root => {
    const h = await harness(root, 'run', () => ({ status, body: '<html>Access unavailable</html>' }));
    const result = await h.run();
    assert.equal(result.status, 'blocked');
    assert.equal(h.waits.length, 1);
    assert.ok(h.calls.length >= 1 && h.calls.length <= 3, 'Access failures must stop without unlimited retry');
    assert.equal((await rows(h.outputDir)).length, 0);
  });
});

test('OFFLINE: a failed human handoff wait is blocked with an explicit runtime diagnostic', async () => {
  await withCase('handoff-wait-failure', async root => {
    const h = await harness(root, 'run', () => ({ status: 403, body: '<html>Access unavailable</html>' }));
    h.runtime.wait = async value => {
      h.waits.push(value);
      throw Object.assign(new Error('offline adapter failure'), { code: 'EPIPE' });
    };
    const result = await h.run();
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'runtime_wait_failed');
    assert.equal(h.calls.length, 1, 'A failed handoff adapter must not trigger another network read');
    assert.equal(h.waits.length, 1);
    const coverage = await json(path.join(h.outputDir, 'coverage.json'));
    assert.ok(coverage.notices.some(notice => notice.type === 'runtime_wait_failed' && notice.collector_stage === 'wait_handoff' && notice.error_code === 'EPIPE'));
  });
});

test('OFFLINE: HTTP 429 observes Retry-After and recovers with virtual time', async () => {
  await withCase('429-recover', async root => {
    const h = await harness(root, 'run', (_url, index) => index === 1
      ? { status: 429, headers: { 'retry-after': '120' }, body: 'Rate limited' }
      : { body: seed([comment('aa')]) });
    const result = await h.run();
    assert.equal(result.status, 'exhausted_accessible');
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[1].at - h.calls[0].at >= 120000, 'Retry-After is a minimum delay');
    assert.deepEqual(ids(await rows(h.outputDir)), ['aa']);
  });
});

test('OFFLINE: a failed 429 timed-wait adapter falls back to local sleep and records the degradation', async () => {
  await withCase('429-wait-failure', async root => {
    const h = await harness(root, 'run', (_url, index) => index === 1
      ? { status: 429, headers: { 'retry-after': '60' }, body: 'Rate limited' }
      : { body: seed([comment('aa')]) });
    h.runtime.wait = async value => {
      h.waits.push(value);
      throw Object.assign(new Error('offline adapter failure'), { code: 'EPIPE' });
    };
    const result = await h.run();
    assert.equal(result.status, 'exhausted_accessible');
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[1].at - h.calls[0].at >= 600000, 'Local fallback preserves the conservative 429 deadline');
    assert.equal(h.waits.length, 1);
    assert.ok(h.sleeps.length > 0, 'The fallback must use the injected local sleep adapter');
    const coverage = await json(path.join(h.outputDir, 'coverage.json'));
    assert.ok(coverage.notices.some(notice => notice.type === 'runtime_timed_wait_failed' && notice.collector_stage === 'wait_cooldown' && notice.error_code === 'EPIPE'));
    const review = await json(path.join(h.outputDir, 'run-retrospective.json'));
    assert.ok(review.observations.some(item => item.id === 'timed_wait_adapter_failed' && item.iterationEligibility === 'review_required' && item.suggestedTarget === 'runtime_adapter'));
  });
});

test('OFFLINE: repeated HTTP 429 is bounded and emits blocked output', async () => {
  await withCase('429-stop', async root => {
    const h = await harness(root, 'run', () => ({ status: 429, headers: { 'retry-after': '2' }, body: 'Rate limited' }));
    const result = await h.run();
    assert.equal(result.status, 'blocked');
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[1].at - h.calls[0].at >= 2000);
  });
});

test('OFFLINE: browser read failures keep bounded diagnostic codes without leaking error text', async () => {
  for (const stage of ['goto', 'body']) await withCase(`read-failure-${stage}`, async root => {
    const secret = 'OFFLINE_FAKE_SECRET_a94f';
    const fakeUrl = `https://fake-user:${secret}@example.invalid/private?token=${secret}`;
    const errorText = stage === 'goto'
      ? `Navigation failed: net::ERR_CONNECTION_CLOSED while visiting ${fakeUrl}`
      : `Reading body timed out; previous location was ${fakeUrl}`;
    const error = Object.assign(new Error(errorText), { name: stage === 'goto' ? 'Error' : 'TimeoutError' });
    const h = await harness(root, 'run', () => {
      if (stage === 'goto') throw error;
      return { body: seed([comment('aa')]) };
    });
    if (stage === 'body') h.runtime.page.locator = selector => {
      assert.equal(selector, 'body');
      return { innerText: async () => { throw error; } };
    };
    const result = await h.run();
    assert.equal(result.status, 'partial');
    assert.ok(h.calls.length >= 1 && h.calls.length <= 3, 'Navigation/body failures must have a bounded request count');
    assert.equal((await rows(h.outputDir)).length, 0);
    const batchNames = (await readdir(path.join(h.outputDir, 'batches'))).filter(name => name.endsWith('.json'));
    assert.equal(batchNames.length, h.calls.length, 'Each failed request retains a diagnostic batch');
    for (const name of batchNames) {
      const batch = await json(path.join(h.outputDir, 'batches', name));
      assert.equal(batch.record.error_stage, stage);
      assert.equal(batch.record.error_code, stage === 'goto' ? 'net::ERR_CONNECTION_CLOSED' : 'TimeoutError');
    }
    const artifactPaths = ['checkpoint.json', 'comments.jsonl', 'coverage.json', 'result.json', 'run-retrospective.json', 'run-retrospective.md', 'manifest.json',
      ...batchNames.map(name => path.join('batches', name))];
    const savedText = (await Promise.all(artifactPaths.map(file => readFile(path.join(h.outputDir, file), 'utf8')))).join('\n');
    const visibleText = `${savedText}\n${JSON.stringify({ result, waits: h.waits, updates: h.updates })}`;
    for (const forbidden of [errorText, fakeUrl, secret, 'fake-user', 'example.invalid']) {
      assert.equal(visibleText.includes(forbidden), false, 'Original browser error text and embedded credentials must not be emitted');
    }
  });
});

test('OFFLINE: non-JSON and malformed response shapes cannot report exhaustion', async () => {
  for (const [label, body, expectsParserReview] of [
    ['html', '<html>Unexpected consent page</html>', false],
    ['invalid-json', 'not a structured response', true],
    ['shape', { json: { data: {} } }, true]
  ]) {
    await withCase(`invalid-${label}`, async root => {
      const h = await harness(root, 'run', () => ({ body }));
      const result = await h.run();
      assert.ok(['partial', 'blocked'].includes(result.status));
      assert.notEqual(result.status, 'exhausted_accessible');
      assert.equal((await rows(h.outputDir)).length, 0);
      assert.ok(h.calls.length <= 3);
      if (expectsParserReview) {
        const coverage = await json(path.join(h.outputDir, 'coverage.json'));
        assert.ok(coverage.posts[0].structural_gaps.some(item => item.type === 'parser_contract_mismatch'));
        const review = await json(path.join(h.outputDir, 'run-retrospective.json'));
        assert.ok(review.observations.some(item => item.id === 'unparsed_response_shape' &&
          item.iterationEligibility === 'review_required' && item.suggestedTarget === 'executor_and_docs'));
      }
    });
  }
});

test('OFFLINE: resume source with a different requested post fails before any request', async () => {
  await withCase('resume-mismatch', async root => {
    const first = await harness(root, 'first', () => ({ body: seed([comment('aa'), more(['bb'])]) }), { maxRequests: 1 });
    await first.run();
    const second = await harness(root, 'second', () => { throw new Error('Unexpected request for mismatched resume'); }, {
      posts: ['def456'], resumeFrom: first.outputDir,
    });
    await assert.rejects(second.run(), /resume|match|source|post/i);
    assert.equal(second.calls.length, 0);
  });
});

test('OFFLINE: resume rejects missing or rewritten earlier applied evidence before any request', async () => {
  for (const mutation of ['delete-earlier-batch', 'rewrite-earlier-batch']) {
    await withCase(mutation, async root => {
      const first = await harness(root, 'first', url => ({ body: isMore(url)
        ? expanded([comment('bb')]) : seed([comment('aa'), more(['bb'])]) }));
      assert.equal((await first.run()).status, 'exhausted_accessible');
      const batchNames = (await readdir(path.join(first.outputDir, 'batches'))).filter(name => name.endsWith('.json')).sort();
      assert.equal(batchNames.length, 2, 'The fixture includes an older and a latest applied batch');
      const earlierFile = path.join(first.outputDir, 'batches', batchNames[0]);
      if (mutation === 'delete-earlier-batch') {
        await rm(earlierFile);
      } else {
        const envelope = await json(earlierFile);
        envelope.record.payload[1].data.children[0].data.body = 'Rewritten offline evidence';
        // Recompute the envelope checksum so a check of this file alone passes;
        // the checkpoint must still bind the already-applied original evidence.
        envelope.record_sha256 = createHash('sha256').update(JSON.stringify(envelope.record)).digest('hex');
        await writeFile(earlierFile, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
      }
      const second = await harness(root, 'second', () => { throw new Error('Unexpected network request after damaged history'); }, {
        resumeFrom: first.outputDir,
      });
      await assert.rejects(second.run(), /checksum|missing|changed|journal|manifest/i);
      assert.equal(second.calls.length, 0);
    });
  }
});

test('OFFLINE: manifest SHA-256 values are independently recomputed from emitted file bytes', async () => {
  await withCase('manifest', async root => {
    const h = await harness(root, 'run', () => ({ body: seed([comment('aa')]) }));
    await h.run();
    const manifest = await json(path.join(h.outputDir, 'manifest.json'));
    assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 4, 'Manifest must list emitted artifacts');
    const claimedPaths = new Set();
    for (const file of manifest.files) {
      const relative = file.path;
      assert.equal(typeof relative, 'string');
      const absolute = path.resolve(h.outputDir, relative);
      assert.ok(absolute.startsWith(path.resolve(h.outputDir) + path.sep), 'Manifest paths remain inside outputDir');
      const bytes = await readFile(absolute);
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
      claimedPaths.add(relative.replaceAll('\\', '/'));
    }
    for (const required of ['comments.jsonl', 'coverage.json', 'checkpoint.json', 'result.json']) {
      assert.ok(claimedPaths.has(required), `Manifest covers ${required}`);
    }
    const batches = (await readdir(path.join(h.outputDir, 'batches'))).filter(name => name.endsWith('.json'));
    assert.ok(batches.length >= 1);
    for (const batch of batches) assert.ok(claimedPaths.has(`batches/${batch}`));
  });
});

test('OFFLINE: skipUnavailable skips a first inaccessible post once and collects the next without a human wait', async () => {
  const secondPost = 'def456';
  for (const failure of ['connection-closed', 'http-403']) await withCase(`skip-${failure}`, async root => {
    const h = await harness(root, 'run', url => {
      const pathname = new URL(url).pathname;
      if (pathname === `/comments/${POST}.json`) {
        if (failure === 'connection-closed') throw new Error('net::ERR_CONNECTION_CLOSED');
        return { status: 403, body: '<html>Access unavailable</html>' };
      }
      assert.equal(pathname, `/comments/${secondPost}.json`);
      return { body: seed([comment('cc', '', `t3_${secondPost}`, { link_id: `t3_${secondPost}` })], secondPost) };
    }, { posts: [POST, secondPost], skipUnavailable: true });
    const result = await h.run();
    assert.equal(result.status, 'partial', 'A skipped post is an unresolved coverage gap');
    assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), [`/comments/${POST}.json`, `/comments/${secondPost}.json`]);
    assert.equal(h.waits.filter(wait => wait.resumeAfterMs == null).length, 0, 'Skip mode must not request a human handoff');
    assert.deepEqual(ids(await rows(h.outputDir)), ['cc']);
    const coverage = await json(path.join(h.outputDir, 'coverage.json'));
    const skipped = coverage.posts.find(post => post.post_id === POST).skipped_unavailable;
    assert.ok(skipped && typeof skipped.reason === 'string' && skipped.reason.length > 0);
    assert.equal(skipped.http_status, failure === 'connection-closed' ? 0 : 403);
    if (failure === 'connection-closed') {
      assert.equal(skipped.error_stage, 'goto');
      assert.equal(skipped.error_code, 'net::ERR_CONNECTION_CLOSED');
    }
    assert.equal(typeof skipped.last_source_batch, 'string');
    const source = await json(path.join(h.outputDir, 'batches', skipped.last_source_batch));
    assert.equal(source.record.request.post_id, POST);
    assert.ok(!coverage.posts.find(post => post.post_id === secondPost).skipped_unavailable);
  });
});

test('OFFLINE: enabling skipUnavailable on resume skips an already failed post before networking and preserves failure evidence', async () => {
  await withCase('skip-on-resume', async root => {
    const secondPost = 'def456';
    const first = await harness(root, 'first', url => {
      assert.equal(new URL(url).pathname, `/comments/${POST}.json`);
      throw new Error('net::ERR_CONNECTION_CLOSED');
    }, { posts: [POST, secondPost] });
    assert.equal((await first.run()).status, 'partial');
    assert.equal(first.calls.length, 3, 'Default mode retains bounded retry behavior');
    const originalNames = (await readdir(path.join(first.outputDir, 'batches'))).filter(name => name.endsWith('.json')).sort();
    assert.equal(originalNames.length, 3);
    const originalBytes = new Map(await Promise.all(originalNames.map(async name => [name, await readFile(path.join(first.outputDir, 'batches', name))])));
    const second = await harness(root, 'second', async url => {
      assert.equal(new URL(url).pathname, `/comments/${secondPost}.json`, 'Resume must directly request the second post');
      const checkpoint = await json(path.join(root, 'second', 'checkpoint.json'));
      assert.ok(checkpoint.state.posts.find(post => post.id === POST).skipped_unavailable, 'The old failure must be marked skipped before any new network request');
      return { body: seed([comment('cc', '', `t3_${secondPost}`, { link_id: `t3_${secondPost}` })], secondPost) };
    }, { posts: [POST, secondPost], resumeFrom: first.outputDir, skipUnavailable: true });
    assert.equal((await second.run()).status, 'partial');
    assert.equal(second.calls.length, 1);
    assert.equal(second.waits.filter(wait => wait.resumeAfterMs == null).length, 0);
    assert.deepEqual(ids(await rows(second.outputDir)), ['cc']);
    const coverage = await json(path.join(second.outputDir, 'coverage.json'));
    const skipped = coverage.posts.find(post => post.post_id === POST).skipped_unavailable;
    assert.ok(skipped && typeof skipped.reason === 'string' && skipped.reason.length > 0);
    assert.equal(skipped.error_code, 'net::ERR_CONNECTION_CLOSED');
    assert.equal(skipped.last_source_batch, originalNames.at(-1));
    for (const [name, bytes] of originalBytes) {
      assert.deepEqual(await readFile(path.join(second.outputDir, 'batches', name)), bytes, 'Resume preserves each original failed-response batch');
      assert.deepEqual(await readFile(path.join(first.outputDir, 'batches', name)), bytes, 'Resume does not change the source evidence');
    }
  });
});

function threadAnchor(url) { return new URL(url).searchParams.get('comment'); }
function continuation(parent) { return more([], `t1_${parent}`, 0); }
function focused(anchor, children = []) { return seed([comment(anchor, children.length ? listing(children) : '')]); }

test('OFFLINE DEEP: a valid focused subtree resolves its original continuation gap and deduplicates comments', async () => {
  await withCase('focused-resolve', async root => {
    const h = await harness(root, 'run', url => {
      if (!threadAnchor(url)) return { body: seed([comment('aa', listing([continuation('aa')]))]) };
      assert.equal(threadAnchor(url), 'aa');
      assert.equal(new URL(url).searchParams.get('context'), '0');
      assert.equal(new URL(url).searchParams.get('depth'), '10');
      return { body: focused('aa', [comment('bb', '', 't1_aa'), comment('bb', '', 't1_aa')]) };
    });
    assert.equal((await h.run()).status, 'exhausted_accessible');
    assert.deepEqual(ids(await rows(h.outputDir)), ['aa', 'bb']);
    assert.equal(h.calls.length, 2);
    const post = (await json(path.join(h.outputDir, 'coverage.json'))).posts[0];
    assert.equal(post.empty_more.length, 0);
    assert.equal(post.resolved_empty_more.length, 1);
    assert.equal(post.resolved_empty_more[0].anchor_id, 'aa');
    assert.ok(post.resolved_empty_more[0].direct_comment_ids.includes('bb'));
    assert.equal(post.thread_anchors.find(anchor => anchor.comment_id === 'aa').status, 'resolved');
    const batch = await json(path.join(h.outputDir, 'batches', post.resolved_empty_more[0].resolved_by_batch));
    assert.equal(batch.record.request.kind, 'thread');
    assert.equal(batch.record.request.comment_id, 'aa');
  });
});

test('OFFLINE DEEP: deeper continuation anchors are discovered and expanded recursively', async () => {
  await withCase('focused-recursive', async root => {
    const h = await harness(root, 'run', url => {
      const anchor = threadAnchor(url);
      if (!anchor) return { body: seed([comment('aa', listing([continuation('aa')]))]) };
      if (anchor === 'aa') return { body: focused('aa', [comment('bb', listing([continuation('bb')]), 't1_aa')]) };
      assert.equal(anchor, 'bb');
      return { body: seed([comment('bb', listing([comment('cc', '', 't1_bb')]), 't1_aa')]) };
    });
    assert.equal((await h.run()).status, 'exhausted_accessible');
    assert.deepEqual(ids(await rows(h.outputDir)), ['aa', 'bb', 'cc']);
    assert.deepEqual(h.calls.map(call => threadAnchor(call.url)), [null, 'aa', 'bb']);
    const post = (await json(path.join(h.outputDir, 'coverage.json'))).posts[0];
    assert.equal(post.empty_more.length, 0);
    assert.deepEqual(post.resolved_empty_more.map(entry => entry.anchor_id).sort(), ['aa', 'bb']);
    assert.ok(post.thread_anchors.every(anchor => anchor.status === 'resolved'));
  });
});

test('OFFLINE DEEP: repeating the same continuation or returning only its parent preserves the gap and stops', async () => {
  for (const mode of ['same-anchor-again', 'parent-only']) await withCase(mode, async root => {
    const h = await harness(root, 'run', url => ({ body: !threadAnchor(url) || mode === 'same-anchor-again'
      ? focused('aa', [continuation('aa')]) : focused('aa') }));
    assert.equal((await h.run()).status, 'partial');
    assert.deepEqual(ids(await rows(h.outputDir)), ['aa']);
    assert.equal(h.calls.length, 2, 'One successful but unresolved focused lookup must not loop');
    const post = (await json(path.join(h.outputDir, 'coverage.json'))).posts[0];
    assert.equal(post.empty_more.length, 1);
    assert.equal(post.resolved_empty_more.length, 0);
    assert.equal(post.thread_anchors.find(anchor => anchor.comment_id === 'aa').status, 'unresolved');
  });
});

test('OFFLINE DEEP: a response missing the requested focus cannot resolve its gap or ingest an unrelated subtree', async () => {
  await withCase('focused-missing', async root => {
    const h = await harness(root, 'run', url => ({ body: threadAnchor(url) ? seed([comment('zz')]) : focused('aa', [continuation('aa')]) }));
    assert.equal((await h.run()).status, 'partial');
    assert.deepEqual(ids(await rows(h.outputDir)), ['aa']);
    assert.ok(h.calls.length >= 2 && h.calls.length <= 4);
    const post = (await json(path.join(h.outputDir, 'coverage.json'))).posts[0];
    assert.equal(post.empty_more.length, 1);
    assert.equal(post.resolved_empty_more.length, 0);
    assert.equal(post.thread_anchors.find(anchor => anchor.comment_id === 'aa').status, 'unresolved');
  });
});

test('OFFLINE DEEP: a genuine schema-1 checkpoint resumes continuation gaps without refetching saved initial or more batches', async () => {
  await withCase('legacy-to-focused', async root => {
    const { collect: legacyCollect } = await import('./fixtures/legacy-schema1-collector.fixture.mjs');
    const first = await harness(root, 'legacy', url => ({ body: isMore(url)
      ? expanded([comment('bb')]) : seed([comment('aa', listing([continuation('aa')])), more(['bb'])]) }));
    assert.equal((await legacyCollect(first.runtime, first.adapters)).status, 'partial');
    assert.equal((await json(path.join(first.outputDir, 'checkpoint.json'))).schema, 1);
    assert.equal(first.calls.length, 2);
    const originals = new Map();
    for (const name of (await readdir(path.join(first.outputDir, 'batches'))).filter(name => name.endsWith('.json'))) {
      originals.set(name, await readFile(path.join(first.outputDir, 'batches', name)));
    }
    const second = await harness(root, 'deep', url => {
      assert.equal(threadAnchor(url), 'aa', 'Only a new focused lookup is needed');
      assert.equal(isMore(url), false);
      return { body: focused('aa', [comment('cc', '', 't1_aa')]) };
    }, { resumeFrom: first.outputDir });
    assert.equal((await second.run()).status, 'exhausted_accessible');
    assert.equal(second.calls.length, 1);
    assert.deepEqual(ids(await rows(second.outputDir)), ['aa', 'bb', 'cc']);
    for (const [name, bytes] of originals) {
      assert.deepEqual(await readFile(path.join(second.outputDir, 'batches', name)), bytes);
      assert.deepEqual(await readFile(path.join(first.outputDir, 'batches', name)), bytes);
    }
    const manifest = await json(path.join(second.outputDir, 'manifest.json'));
    for (const file of manifest.files) {
      const bytes = await readFile(path.join(second.outputDir, file.path));
      assert.equal(file.bytes, bytes.length);
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
    const post = (await json(path.join(second.outputDir, 'coverage.json'))).posts[0];
    assert.equal(post.empty_more.length, 0);
    assert.equal(post.resolved_empty_more.length, 1);
  });
});

test('OFFLINE DEEP: a thread HTTP 429 uses the shared wait and retries the same anchor before continuing', async () => {
  await withCase('thread-429', async root => {
    let focusRequests = 0;
    const h = await harness(root, 'run', url => {
      const anchor = threadAnchor(url);
      if (!anchor) return { body: seed([comment('aa', listing([continuation('aa')])), comment('bb', listing([continuation('bb')]))]) };
      if (anchor === 'aa' && ++focusRequests === 1) return { status: 429, headers: { 'retry-after': '900' }, body: 'Rate limited' };
      if (anchor === 'aa') return { body: focused('aa', [comment('cc', '', 't1_aa')]) };
      assert.equal(anchor, 'bb');
      return { body: focused('bb', [comment('dd', '', 't1_bb')]) };
    }, { skipUnavailable: true });
    assert.equal((await h.run()).status, 'exhausted_accessible');
    assert.deepEqual(h.calls.map(call => threadAnchor(call.url)), [null, 'aa', 'aa', 'bb']);
    assert.ok(h.calls[2].at - h.calls[1].at >= 900000, '429 delay is shared across regular and focused requests');
    assert.ok(h.waits.some(wait => wait.resumeAfterMs >= 900000));
    assert.deepEqual(ids(await rows(h.outputDir)), ['aa', 'bb', 'cc', 'dd']);
    const post = (await json(path.join(h.outputDir, 'coverage.json'))).posts[0];
    assert.ok(!post.skipped_unavailable);
    assert.equal(post.empty_more.length, 0);
    assert.equal(post.resolved_empty_more.length, 2);
  });
});

test('OFFLINE DEEP: skipUnavailable skips only a failed focused anchor and preserves the post and other anchors', async () => {
  await withCase('thread-skip-anchor', async root => {
    const h = await harness(root, 'run', url => {
      const anchor = threadAnchor(url);
      if (!anchor) return { body: seed([comment('aa', listing([continuation('aa')])), comment('bb', listing([continuation('bb')]))]) };
      if (anchor === 'aa') return { status: 403, body: '<html>Unavailable focused thread</html>' };
      assert.equal(anchor, 'bb');
      return { body: focused('bb', [comment('cc', '', 't1_bb')]) };
    }, { skipUnavailable: true });
    assert.equal((await h.run()).status, 'partial');
    assert.deepEqual(h.calls.map(call => threadAnchor(call.url)), [null, 'aa', 'bb']);
    assert.equal(h.waits.filter(wait => wait.resumeAfterMs == null).length, 0);
    assert.deepEqual(ids(await rows(h.outputDir)), ['aa', 'bb', 'cc']);
    const post = (await json(path.join(h.outputDir, 'coverage.json'))).posts[0];
    assert.ok(!post.skipped_unavailable, 'A failed focused anchor must not skip the entire post');
    assert.equal(post.empty_more.length, 1);
    assert.equal(post.resolved_empty_more.length, 1);
    const failed = post.thread_anchors.find(anchor => anchor.comment_id === 'aa');
    assert.equal(failed.status, 'unresolved');
    assert.equal(failed.http_status, 403);
    assert.ok(typeof failed.reason === 'string' && failed.reason.length > 0);
    assert.equal(post.thread_anchors.find(anchor => anchor.comment_id === 'bb').status, 'resolved');
    const batch = await json(path.join(h.outputDir, 'batches', failed.last_source_batch));
    assert.equal(batch.record.request.comment_id, 'aa');
  });
});

test('OFFLINE PORTABLE: input accepts more than ten posts with an implementation safety cap', () => {
  const posts = Array.from({ length: 12 }, (_, index) => `fixture${index.toString(36)}`);
  assert.deepEqual(normalizeInput({ posts }).posts, posts);
  assert.throws(() => normalizeInput({ posts: Array.from({ length: 1001 }, (_, index) => `p${index.toString(36)}`) }), /1–1000/);
});

test('OFFLINE PORTABLE: response.text is preferred over DOM rendering when available', async () => {
  await withCase('response-text', async root => {
    const h = await harness(root, 'run', () => ({ body: seed([comment('aa')]), useResponseText: true }));
    delete h.runtime.page.locator;
    assert.equal((await h.run()).status, 'exhausted_accessible');
    assert.deepEqual(ids(await rows(h.outputDir)), ['aa']);
  });
});

test('OFFLINE PORTABLE: missing both body readers blocks after one durable diagnostic batch', async () => {
  await withCase('missing-body-readers', async root => {
    const h = await harness(root, 'run', () => ({ body: seed([comment('aa')]) }));
    delete h.runtime.page.locator;
    const result = await h.run();
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'runtime_body_capability_missing');
    assert.equal(h.calls.length, 1, 'A runtime capability defect must not be retried as a transient network failure');
    const batchNames = (await readdir(path.join(h.outputDir, 'batches'))).sort();
    assert.deepEqual(batchNames, ['00000001.json']);
    const batch = await json(path.join(h.outputDir, 'batches', batchNames[0]));
    assert.equal(batch.record.outcome, 'navigation_error');
    assert.equal(batch.record.error_stage, 'body');
    assert.equal(batch.record.error_code, 'RUNTIME_BODY_CAPABILITY_MISSING');
    const coverage = await json(path.join(h.outputDir, 'coverage.json'));
    assert.ok(coverage.notices.some(notice => notice.type === 'runtime_body_capability_missing' &&
      notice.collector_stage === 'read' && notice.error_code === 'RUNTIME_BODY_CAPABILITY_MISSING'));
    const review = await json(path.join(h.outputDir, 'run-retrospective.json'));
    assert.ok(review.observations.some(observation => observation.id === 'missing_body_reader_capability' &&
      observation.iterationEligibility === 'review_required' && observation.suggestedTarget === 'runtime_adapter'));
  });
});

test('OFFLINE PORTABLE: progress callback failure is recorded and collection continues', async () => {
  await withCase('progress-degrade', async root => {
    const h = await harness(root, 'run', url => ({ body: isMore(url) ? expanded([comment('bb')]) : seed([more(['bb'])]) }));
    let attempts = 0;
    h.runtime.progress = async () => { attempts += 1; throw Object.assign(new Error('fixture'), { code: 'EPIPE' }); };
    const result = await h.run();
    assert.equal(result.status, 'exhausted_accessible');
    assert.equal(attempts, 1);
    const coverage = await json(path.join(h.outputDir, 'coverage.json'));
    assert.ok(coverage.notices.some(notice => notice.type === 'runtime_progress_disabled' && notice.error_code === 'EPIPE'));
  });
});

test('OFFLINE PORTABLE: unknown method revisions are refused before a network read', async () => {
  await withCase('unknown-revision', async root => {
    const first = await harness(root, 'first', () => ({ body: seed([]) }));
    await first.run();
    const checkpointFile = path.join(first.outputDir, 'checkpoint.json');
    const checkpoint = await json(checkpointFile);
    checkpoint.state.method_revision = 'unknown-fixture-revision';
    checkpoint.state_sha256 = createHash('sha256').update(JSON.stringify(checkpoint.state)).digest('hex');
    await writeFile(checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const second = await harness(root, 'second', () => { throw new Error('Network must not run'); }, { resumeFrom: first.outputDir });
    await assert.rejects(second.run(), /Unsupported checkpoint method revision/);
    assert.equal(second.calls.length, 0);
  });
});

test('OFFLINE PORTABLE: a null legacy revision rejects focused state or thread batches before networking or copying evidence', async () => {
  for (const variant of ['focused-state', 'thread-batch-only']) await withCase(`legacy-${variant}`, async root => {
    const first = await harness(root, 'first', url => ({ body: threadAnchor(url)
      ? focused('aa', [comment('bb', '', 't1_aa')])
      : seed([comment('aa', listing([continuation('aa')]))]) }));
    assert.equal((await first.run()).status, 'exhausted_accessible');
    const checkpointFile = path.join(first.outputDir, 'checkpoint.json');
    const checkpoint = await json(checkpointFile);
    delete checkpoint.state.method_revision;
    if (variant === 'thread-batch-only') {
      for (const post of checkpoint.state.posts) {
        delete post.thread_anchors;
        delete post.resolved_empty_more;
      }
      checkpoint.state.pending = null;
    }
    checkpoint.state_sha256 = createHash('sha256').update(JSON.stringify(checkpoint.state)).digest('hex');
    await writeFile(checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const second = await harness(root, 'second', () => { throw new Error('Network must not run'); }, { resumeFrom: first.outputDir });
    await assert.rejects(second.run(), /Legacy checkpoint without method_revision contains focused-thread state or batches/);
    assert.equal(second.calls.length, 0);
    await assert.rejects(readFile(path.join(second.outputDir, 'checkpoint.json')), { code: 'ENOENT' });
    await assert.rejects(readdir(path.join(second.outputDir, 'batches')), { code: 'ENOENT' });
  });
});

test('OFFLINE REVIEW: every graceful delivery includes review artifacts in the manifest', async () => {
  await withCase('automatic-review', async root => {
    const h = await harness(root, 'run', () => ({ body: seed([comment('aa')]) }));
    const result = await h.run();
    assert.equal(result.retrospective_file, 'run-retrospective.md');
    const review = await json(path.join(h.outputDir, 'run-retrospective.json'));
    assert.equal(review.sourcePolicy.autoMutationAllowed, false);
    assert.equal(review.sourcePolicy.reviewMode, 'in_run');
    const schema = JSON.parse(await readFile(new URL('../schemas/run-review.schema.json', import.meta.url), 'utf8'));
    for (const key of schema.required) assert.ok(Object.hasOwn(review, key), `Automatic review is missing schema field ${key}`);
    for (const key of Object.keys(review)) assert.ok(Object.hasOwn(schema.properties, key), `Automatic review has undocumented field ${key}`);
    for (const key of schema.properties.facts.properties.gaps.required) assert.ok(Object.hasOwn(review.facts.gaps, key), `Automatic review gap is missing ${key}`);
    for (const key of schema.properties.observations.items.required) assert.ok(Object.hasOwn(review.observations[0], key), `Automatic review observation is missing ${key}`);
    const manifest = await json(path.join(h.outputDir, 'manifest.json'));
    assert.ok(manifest.files.some(file => file.path === 'run-retrospective.json'));
    assert.ok(manifest.files.some(file => file.path === 'run-retrospective.md'));
  });
});

test('OFFLINE PORTABLE: relative output and resume paths work with spaces and Unicode', async () => {
  await withCase('portable-path', async root => {
    const h = await harness(root, 'unused', () => ({ body: seed([comment('aa')]) }));
    const portable = path.join(root, '资料 space', '运行');
    await mkdir(portable, { recursive: true });
    const previousCwd = process.cwd();
    try {
      // Keep the relative-path fixture on the current drive, including CI.
      process.chdir(root);
      const relative = path.relative(process.cwd(), portable);
      assert.equal(path.isAbsolute(relative), false);
      h.runtime.outputDir = relative;
      assert.equal((await h.run()).status, 'exhausted_accessible');
      assert.deepEqual(ids(await rows(portable)), ['aa']);
      const normalized = normalizeInput({ posts: [POST], resumeFrom: relative });
      assert.equal(normalized.resumeFrom, path.resolve(relative));
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test('OFFLINE PORTABLE: missing page capability fails before creating output state', async () => {
  await withCase('runtime-preflight', async root => {
    const outputDir = path.join(root, 'output');
    const runtime = { input: { posts: [POST] }, outputDir, page: {}, signal: new AbortController().signal };
    await assert.rejects(collect(runtime), error => error?.code === 'RUNTIME_PAGE_CAPABILITY_MISSING');
    await assert.rejects(readFile(path.join(outputDir, 'checkpoint.json')), { code: 'ENOENT' });
  });
});
