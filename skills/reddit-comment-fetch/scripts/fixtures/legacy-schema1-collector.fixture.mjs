/** Synthetic legacy schema-1 producer used only for forward-migration regression tests. */
import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

// Method constants, not a promise of Reddit access or a safe API quota.
const SCHEMA = 1;
const SORT = 'confidence';
const GAP_MS = 7_000;
const WINDOW_MS = 600_000;
const WINDOW_REQUESTS = 80;
const MAX_MISSING_ATTEMPTS = 2;
const NON_GUARANTEE = 'Exhausts only the comment objects currently accessible to this Profile and endpoint. It does not guarantee historical, deleted, removed, restricted, or absolute full coverage. num_comments is not a coverage denominator.';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const abort = signal => { if (signal?.aborted) throw Object.assign(new Error('Collection cancelled'), { code: 'ABORTED' }); };

// 1. Input and endpoint construction: never navigate to an input URL directly.
export function normalizeInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be an object');
  for (const key of Object.keys(input)) if (!['posts', 'resumeFrom', 'maxRequests', 'skipUnavailable'].includes(key)) throw new Error(`Unknown input field: ${key}`);
  if (!Array.isArray(input.posts) || input.posts.length < 1 || input.posts.length > 10) throw new Error('posts must contain 1–10 post URLs or IDs');
  const posts = input.posts.map(value => {
    if (typeof value !== 'string') throw new Error('Each post must be a URL or ID string');
    const text = value.trim();
    if (/^(t3_)?[a-z0-9]+$/i.test(text)) return text.replace(/^t3_/i, '').toLowerCase();
    let url;
    try { url = new URL(text); } catch { throw new Error('Invalid Reddit post URL'); }
    if (url.protocol !== 'https:' || !['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Only HTTPS reddit.com post URLs are accepted');
    const match = url.pathname.match(/^\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)(?:\.json)?(?:\/|$)/i);
    if (!match) throw new Error('Use a canonical /comments/ post URL, not a share or listing URL');
    return match[1].toLowerCase();
  });
  const maxRequests = input.maxRequests ?? 300;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 100_000) throw new Error('maxRequests must be an integer from 1 to 100000');
  if (input.skipUnavailable !== undefined && typeof input.skipUnavailable !== 'boolean') throw new Error('skipUnavailable must be a boolean');
  if (input.resumeFrom !== undefined && (typeof input.resumeFrom !== 'string' || !path.isAbsolute(input.resumeFrom))) throw new Error('resumeFrom must be an absolute previous outputDir');
  return { posts: [...new Set(posts)], maxRequests, skipUnavailable: input.skipUnavailable ?? false, resumeFrom: input.resumeFrom ? path.resolve(input.resumeFrom) : null };
}

function endpoint(request) {
  const url = new URL(request.kind === 'initial' ? `/comments/${request.post_id}.json` : '/api/morechildren.json', 'https://www.reddit.com');
  url.searchParams.set('raw_json', '1');
  url.searchParams.set('sort', SORT);
  if (request.kind === 'initial') url.searchParams.set('limit', '500');
  else {
    url.searchParams.set('api_type', 'json');
    url.searchParams.set('link_id', `t3_${request.post_id}`);
    url.searchParams.set('children', request.children.join(','));
    url.searchParams.set('limit_children', 'false');
  }
  return url.href;
}

function identity(posts) {
  const value = { post_ids: [...posts].sort(), sort: SORT };
  return { ...value, sha256: hash(JSON.stringify(value)) };
}

function newState(posts, now) {
  return {
    schema: SCHEMA, identity: identity(posts), created_at: new Date(now).toISOString(),
    next_sequence: 1, last_applied: 0, batch_hashes: {}, requests_total: 0, request_times: [], pending: null,
    rate_limit_hits: 0, auth_hits: 0, transient_failures: {}, action: null, notices: [],
    posts: posts.map(id => ({ id, initial: false, metadata: null, comments: Object.create(null), queue: [],
      attempts: Object.create(null), missing_ids: Object.create(null), empty_more: {}, structural_gaps: [] }))
  };
}

// 2. Atomic journal and checkpoint. A batch commits before the derived state.
async function atomicText(target, text) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function saveState(outputDir, state) {
  await atomicText(path.join(outputDir, 'checkpoint.json'), json({ schema: SCHEMA, state_sha256: hash(JSON.stringify(state)), state }));
}

function batchName(sequence) { return `${String(sequence).padStart(8, '0')}.json`; }

function validateBatch(envelope, expected) {
  if (envelope.schema !== SCHEMA || envelope.record_sha256 !== hash(JSON.stringify(envelope.record))) throw new Error('Batch checksum or schema mismatch');
  const record = envelope.record;
  const request = record?.request;
  if (record.identity_sha256 !== expected.sha256 || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || !request || !expected.post_ids.includes(request.post_id)) throw new Error('Batch identity mismatch');
  if (!['initial', 'more'].includes(request.kind) || !Array.isArray(request.children) || request.children.length > 100 || request.children.some(id => !/^[a-z0-9]+$/.test(id))) throw new Error('Invalid batch request');
  if (record.url !== endpoint(request)) throw new Error('Batch endpoint mismatch');
  return record;
}

async function loadState(config, outputDir, now) {
  await mkdir(outputDir, { recursive: true });
  if (!config.resumeFrom) {
    try { await stat(path.join(outputDir, 'checkpoint.json')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const state = newState(config.posts, now);
      await saveState(outputDir, state);
      return state;
    }
    throw new Error('outputDir already contains a checkpoint; explicitly supply resumeFrom');
  }
  const checkpoint = JSON.parse(await readFile(path.join(config.resumeFrom, 'checkpoint.json'), 'utf8'));
  const state = checkpoint.state;
  const expected = identity(config.posts);
  if (checkpoint.schema !== SCHEMA || state?.schema !== SCHEMA || checkpoint.state_sha256 !== hash(JSON.stringify(state))) throw new Error('Checkpoint checksum or schema mismatch');
  if (state.identity?.sha256 !== expected.sha256 || JSON.stringify(state.identity) !== JSON.stringify(expected) || identity(state.posts.map(post => post.id)).sha256 !== expected.sha256) throw new Error('resumeFrom post set or sort does not match input');
  const sameDir = path.resolve(config.resumeFrom) === path.resolve(outputDir);
  if (!sameDir) {
    try { await stat(path.join(outputDir, 'checkpoint.json')); throw new Error('New outputDir must not contain another checkpoint'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let files = [];
  try { files = await readdir(path.join(config.resumeFrom, 'batches')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = [];
  for (const filename of files.filter(name => /^\d{8}\.json$/.test(name)).sort()) {
    const source = path.join(config.resumeFrom, 'batches', filename);
    if (!(await lstat(source)).isFile()) throw new Error('Batch must be a regular, non-symlink file');
    const text = await readFile(source, 'utf8');
    const record = validateBatch(JSON.parse(text), expected);
    if (filename !== batchName(record.sequence)) throw new Error('Batch filename mismatch');
    records.push(record);
    if (!sameDir) await atomicText(path.join(outputDir, 'batches', filename), text);
  }
  for (const [sequence, expectedHash] of Object.entries(state.batch_hashes)) {
    const record = records.find(item => item.sequence === Number(sequence));
    if (!record || hash(JSON.stringify(record)) !== expectedHash) throw new Error('Checkpoint journal history is missing or changed');
  }
  if (state.last_applied > 0 && !records.some(record => record.sequence === state.last_applied)) throw new Error('Checkpoint references a missing batch');
  for (const post of state.posts) for (const field of ['comments', 'attempts', 'missing_ids']) post[field] = Object.assign(Object.create(null), post[field]);
  // A stopped run is explicitly retried by resumeFrom; retry counters remain bounded.
  if (state.action?.kind === 'stop') state.action = null;
  for (const record of records.filter(record => record.sequence > state.last_applied)) {
    if (record.sequence >= state.next_sequence) {
      state.next_sequence = record.sequence + 1;
      state.requests_total++;
      state.request_times.push(record.started_ms);
    }
    applyBatch(state, record, config.skipUnavailable);
  }
  // A newly selected skip policy also applies to the last durable failure.
  // Do not repeat a known unavailable read merely because the Worker restarted.
  const lastRecord = records.find(record => record.sequence === state.last_applied);
  if (config.skipUnavailable && lastRecord && lastRecord.outcome !== 'ok' && lastRecord.status !== 429) markUnavailable(state, lastRecord);
  if (state.pending) {
    state.notices.push({ type: 'interrupted_read', sequence: state.pending.sequence, note: 'No durable response was found; a read-only retry is safe but reserved request pacing remains counted.' });
    state.pending = null;
  }
  await saveState(outputDir, state);
  return state;
}

// 3. Comment-tree reducer. IDs, not scroll positions, define the frontier.
function gap(post, type, data) {
  const record = { type, ...data };
  if (!post.structural_gaps.some(existing => JSON.stringify(existing) === JSON.stringify(record))) post.structural_gaps.push(record);
}

function ingest(post, things, source) {
  const stack = [...things].reverse();
  const queued = new Set(post.queue);
  while (stack.length) {
    const thing = stack.pop();
    if (!thing || typeof thing !== 'object' || !thing.data) { gap(post, 'invalid_thing', { source }); continue; }
    const data = thing.data;
    if (thing.kind === 't1') {
      const id = String(data.id || '');
      if (!/^[a-z0-9]+$/.test(id) || (data.link_id && data.link_id !== `t3_${post.id}`)) { gap(post, 'invalid_comment_identity', { source }); continue; }
      if (!post.comments[id]) post.comments[id] = {
        post_id: post.id, comment_id: id, fullname: `t1_${id}`, parent_id: data.parent_id ?? null,
        author: data.author ?? null, body: typeof data.body === 'string' ? data.body : '',
        score: data.score ?? null, created_utc: data.created_utc ?? null, edited: data.edited ?? null,
        depth_reported: data.depth ?? null, collapsed: data.collapsed ?? null,
        body_state: data.body === '[deleted]' ? 'deleted' : data.body === '[removed]' ? 'removed' : 'present',
        source_batch: source
      };
      if (!/^t[13]_[a-z0-9]+$/.test(String(data.parent_id || ''))) gap(post, 'missing_parent_identity', { comment_id: id, source });
      if (typeof data.body !== 'string') gap(post, 'missing_comment_body', { comment_id: id, source });
      delete post.missing_ids[id];
      if (data.replies && typeof data.replies === 'object' && Array.isArray(data.replies.data?.children)) stack.push(...[...data.replies.data.children].reverse());
      else if (data.replies && data.replies !== '') gap(post, 'invalid_replies', { comment_id: id, source });
    } else if (thing.kind === 'more') {
      const children = data.children;
      const context = { source_batch: source, more_id: data.id ?? null, name: data.name ?? null };
      if (!Array.isArray(children) || children.length === 0) {
        const entry = { parent_id: data.parent_id ?? null, count: data.count ?? null, context };
        const key = JSON.stringify([entry.parent_id, data.id ?? null, entry.count]);
        post.empty_more[key] ??= entry;
      } else for (const child of children) {
        const id = String(child);
        if (!/^[a-z0-9]+$/.test(id)) { gap(post, 'invalid_more_child_id', { parent_id: data.parent_id ?? null, source }); continue; }
        if (!post.comments[id] && !queued.has(id) && (post.attempts[id] ?? 0) < MAX_MISSING_ATTEMPTS) { post.queue.push(id); queued.add(id); }
      }
    } else gap(post, 'unknown_thing_kind', { kind: String(thing.kind ?? ''), source });
  }
  post.queue = post.queue.filter(id => !post.comments[id]);
}

function payloadThings(record) {
  const payload = record.payload;
  if (record.request.kind === 'initial') {
    if (!Array.isArray(payload) || payload[0]?.kind !== 'Listing' || payload[1]?.kind !== 'Listing' || !Array.isArray(payload[0]?.data?.children) || !Array.isArray(payload[1]?.data?.children)) throw new Error('invalid_initial_shape');
    const post = payload[0].data.children.find(thing => thing.kind === 't3' && thing.data?.id === record.request.post_id);
    if (!post) throw new Error('initial_post_identity_mismatch');
    return { things: payload[1].data.children, post: post.data };
  }
  if (!payload?.json || !Array.isArray(payload.json.errors) || payload.json.errors.length || !Array.isArray(payload.json.data?.things)) throw new Error('invalid_morechildren_shape_or_api_error');
  return { things: payload.json.data.things };
}

function requestKey(request) { return `${request.post_id}:${request.kind}:${request.children.join(',')}`; }

function markUnavailable(state, record) {
  const post = state.posts.find(item => item.id === record.request.post_id);
  post.skipped_unavailable ??= {
    reason: record.outcome, http_status: record.status, error_stage: record.error_stage ?? null,
    error_code: record.error_code ?? null, last_source_batch: batchName(record.sequence)
  };
  state.action = null;
}

function applyBatch(state, record, skipUnavailable = false) {
  if (record.sequence <= state.last_applied) return;
  const post = state.posts.find(item => item.id === record.request.post_id);
  const key = requestKey(record.request);
  state.pending = null;
  state.last_applied = record.sequence;
  state.batch_hashes[record.sequence] = hash(JSON.stringify(record));
  if (record.outcome === 'ok') {
    const parsed = payloadThings(record);
    if (parsed.post) {
      post.metadata = { title: parsed.post.title ?? null, subreddit: parsed.post.subreddit ?? null, advertised_num_comments: parsed.post.num_comments ?? null, retrieved_at: record.received_at };
      post.initial = true;
    }
    ingest(post, parsed.things, batchName(record.sequence));
    const requested = new Set(record.request.children);
    post.queue = post.queue.filter(id => !requested.has(id) && !post.comments[id]);
    for (const id of requested) {
      post.attempts[id] = (post.attempts[id] ?? 0) + 1;
      if (post.comments[id]) { delete post.missing_ids[id]; continue; }
      if (post.attempts[id] < MAX_MISSING_ATTEMPTS) post.queue.push(id);
      else post.missing_ids[id] = { id, attempts: post.attempts[id], last_source_batch: batchName(record.sequence) };
    }
    delete state.transient_failures[key];
    state.action = null;
  } else if (record.status === 429) {
    state.rate_limit_hits++;
    state.action = state.rate_limit_hits === 1
      ? { kind: 'timed', reason: 'reddit_rate_limit', until_ms: record.received_ms + Math.max(WINDOW_MS, record.retry_after_ms ?? 0) }
      : { kind: 'stop', status: 'blocked', reason: 'repeated_rate_limit' };
  } else if (skipUnavailable) {
    markUnavailable(state, record);
  } else if ([401, 403].includes(record.status) || record.outcome === 'interstitial') {
    state.auth_hits++;
    state.action = state.auth_hits === 1
      ? { kind: 'handoff', reason: 'Reddit access challenge. Inspect the current page, resolve only through normal authorized access, then resume.' }
      : { kind: 'stop', status: 'blocked', reason: 'access_challenge_repeated' };
  } else if (record.status >= 500 || record.outcome === 'navigation_error') {
    state.transient_failures[key] = (state.transient_failures[key] ?? 0) + 1;
    const attempt = state.transient_failures[key];
    state.action = attempt < 3
      ? { kind: 'timed', reason: 'temporary_read_failure', until_ms: record.received_ms + 10_000 * 2 ** (attempt - 1) }
      : { kind: 'stop', status: 'partial', reason: 'temporary_read_failures_exhausted' };
  } else state.action = { kind: 'stop', status: record.outcome === 'external_redirect' ? 'blocked' : 'partial', reason: record.outcome };
}

// 4. Current Task Master adapter. Keep version-dependent APIs in this section.
function sleep(ms, signal) {
  abort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('Cancelled while waiting'), { code: 'ABORTED' })); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfter(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now);
  return Number.isFinite(milliseconds) ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(milliseconds)) : null;
}

async function readPage(page, request, now) {
  const url = endpoint(request);
  let response, body = '', status = 0, headers = {}, outcome = 'navigation_error';
  let stage = 'goto', errorCode = null;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    status = response?.status() ?? 0;
    headers = await response?.headers() ?? {};
    const final = new URL(typeof page.url === 'function' ? page.url() : url);
    if (final.protocol !== 'https:' || !['www.reddit.com', 'reddit.com', 'old.reddit.com', 'new.reddit.com'].includes(final.hostname) || final.username || final.password || final.port) return { url, status, outcome: 'external_redirect', payload: null, received_ms: now(), received_at: new Date(now()).toISOString() };
    stage = 'body';
    body = await page.locator('body').innerText({ timeout: 15_000 });
    outcome = status >= 200 && status < 300 ? 'ok' : 'http_error';
  } catch (error) {
    outcome = 'navigation_error';
    // Persist only a bounded diagnostic code; never browser error text or URLs.
    const networkCode = String(error?.message ?? '').match(/\bnet::ERR_[A-Z_]{1,64}\b/)?.[0];
    errorCode = networkCode ?? (['TimeoutError', 'AbortError', 'TargetClosedError'].includes(error?.name) ? error.name : 'BrowserReadError');
  }
  const received = now();
  const result = { url, status, outcome, payload: null, received_ms: received, received_at: new Date(received).toISOString(),
    content_type: headers['content-type'] ?? null, retry_after_ms: retryAfter(headers['retry-after'], received),
    body_sha256: hash(body), body_characters: body.length,
    ...(errorCode ? { error_stage: stage, error_code: errorCode } : {}) };
  if (outcome !== 'ok') return result;
  try { result.payload = JSON.parse(body); } catch {
    result.outcome = /<html|<!doctype|captcha|log in|sign in|blocked|verify you|security check/i.test(body) ? 'interstitial' : 'invalid_json';
    return result;
  }
  try { payloadThings({ request, payload: result.payload }); } catch (error) {
    result.outcome = error.message;
  }
  return result;
}

async function pauseUntil(deadline, runtime, adapters, reason) {
  abort(runtime.signal);
  let remaining = Math.max(0, Math.ceil(deadline - adapters.now()));
  if (!remaining) return;
  if (typeof runtime.wait === 'function' && remaining >= 30_000) await runtime.wait({ reason, resumeAfterMs: Math.min(remaining, 2_147_000_000), data: { not_before: new Date(deadline).toISOString() } });
  // A user can resume wait() early. Never thereby bypass Retry-After/pacing.
  while ((remaining = deadline - adapters.now()) > 0) {
    abort(runtime.signal);
    await adapters.sleep(Math.min(remaining, 30_000), runtime.signal);
  }
}

async function pace(state, runtime, adapters) {
  const now = adapters.now();
  state.request_times = state.request_times.filter(time => time > now - WINDOW_MS);
  const last = state.request_times.at(-1);
  let deadline = last === undefined ? now : last + GAP_MS;
  if (state.request_times.length >= WINDOW_REQUESTS) deadline = Math.max(deadline, state.request_times[state.request_times.length - WINDOW_REQUESTS] + WINDOW_MS);
  await pauseUntil(deadline, runtime, adapters, 'Conservative Reddit request pacing');
}

function nextRequest(state) {
  for (const post of state.posts) {
    if (post.skipped_unavailable) continue;
    if (!post.initial) return { kind: 'initial', post_id: post.id, children: [] };
    if (post.queue.length) return { kind: 'more', post_id: post.id, children: post.queue.slice(0, 100) };
  }
  return null;
}

// 5. Deliverables. A finished Worker is not evidence of complete data coverage.
async function deliver(state, outputDir, status, reason, requestsThisRun) {
  const posts = state.posts.map(post => ({
    post_id: post.id, initial_received: post.initial, comments: Object.keys(post.comments).length,
    skipped_unavailable: post.skipped_unavailable ?? null,
    advertised_num_comments: post.metadata?.advertised_num_comments ?? null,
    queue_count: post.queue.length, queued_ids: post.queue,
    missing_ids: Object.values(post.missing_ids), empty_more: Object.values(post.empty_more),
    structural_gaps: post.structural_gaps,
    missing_parent_ids: [...new Set(Object.values(post.comments).map(comment => comment.parent_id).filter(id => /^t1_/.test(id ?? '') && !post.comments[id.slice(3)]))]
  }));
  const hasGaps = posts.some(post => post.skipped_unavailable || !post.initial_received || post.queue_count || post.missing_ids.length || post.empty_more.length || post.structural_gaps.length || post.missing_parent_ids.length);
  if (status === 'exhausted_accessible' && hasGaps) { status = 'partial'; reason = 'known_coverage_gaps'; }
  if (posts.some(post => post.skipped_unavailable)) status = 'partial';
  const comments = posts.reduce((total, post) => total + post.comments, 0);
  const coverage = { schema: SCHEMA, status, reason, sort: SORT, non_guarantee: NON_GUARANTEE, posts, notices: state.notices };
  const result = { status, reason, comments, requests_this_run: requestsThisRun, requests_total: state.requests_total,
    output_dir: outputDir, coverage_file: 'coverage.json', comments_file: 'comments.jsonl', checkpoint_file: 'checkpoint.json', non_guarantee: NON_GUARANTEE };
  await saveState(outputDir, state);
  const lines = state.posts.flatMap(post => Object.values(post.comments)).map(comment => JSON.stringify(comment));
  await atomicText(path.join(outputDir, 'comments.jsonl'), lines.length ? `${lines.join('\n')}\n` : '');
  await atomicText(path.join(outputDir, 'coverage.json'), json(coverage));
  await atomicText(path.join(outputDir, 'result.json'), json(result));
  const files = ['checkpoint.json', 'comments.jsonl', 'coverage.json', 'result.json'];
  let batchFiles = [];
  try { batchFiles = await readdir(path.join(outputDir, 'batches')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  files.push(...batchFiles.filter(name => /^\d{8}\.json$/.test(name)).sort().map(name => `batches/${name}`));
  const entries = [];
  for (const file of files) { const bytes = await readFile(path.join(outputDir, file)); entries.push({ path: file, bytes: bytes.length, sha256: hash(bytes) }); }
  await atomicText(path.join(outputDir, 'manifest.json'), json({ schema: SCHEMA, identity: state.identity, status, files: entries, non_guarantee: NON_GUARANTEE }));
  return result;
}

export async function collect(runtime, injected = {}) {
  const config = normalizeInput(runtime.input);
  if (!path.isAbsolute(runtime.outputDir)) throw new Error('runtime.outputDir must be absolute');
  const outputDir = path.resolve(runtime.outputDir);
  const adapters = { now: Date.now, sleep, ...injected };
  const state = await loadState(config, outputDir, adapters.now());
  let requestsThisRun = 0;
  let status = 'partial';
  let reason = 'not_started';
  try {
    for (;;) {
      abort(runtime.signal);
      if (state.action?.kind === 'stop') { status = state.action.status; reason = state.action.reason; break; }
      const request = nextRequest(state);
      if (!request) { status = 'exhausted_accessible'; reason = 'frontier_exhausted'; break; }
      if (requestsThisRun >= config.maxRequests) { reason = 'request_budget_exhausted'; break; }
      if (state.action?.kind === 'handoff') {
        await deliver(state, outputDir, 'partial', 'awaiting_access_resolution', requestsThisRun);
        if (typeof runtime.wait !== 'function') { status = 'blocked'; reason = 'access_challenge_requires_wait_adapter'; break; }
        await runtime.wait({ reason: state.action.reason, resumeAfterMs: null, data: { evidence: `batches/${batchName(state.last_applied)}`, outputDir } });
        abort(runtime.signal);
        state.action = null;
        await saveState(outputDir, state);
      } else if (state.action?.kind === 'timed') {
        await deliver(state, outputDir, 'partial', state.action.reason, requestsThisRun);
        await pauseUntil(state.action.until_ms, runtime, adapters, state.action.reason);
        state.action = null;
        await saveState(outputDir, state);
      }
      await pace(state, runtime, adapters);
      abort(runtime.signal);
      const sequence = state.next_sequence++;
      const started = adapters.now();
      state.requests_total++;
      requestsThisRun++;
      state.request_times.push(started);
      state.pending = { sequence, request, started_ms: started };
      await saveState(outputDir, state);
      const response = await readPage(runtime.page, request, adapters.now);
      const record = { sequence, identity_sha256: state.identity.sha256, started_ms: started, request, ...response };
      const envelope = { schema: SCHEMA, record_sha256: hash(JSON.stringify(record)), record };
      await atomicText(path.join(outputDir, 'batches', batchName(sequence)), json(envelope));
      if (adapters.afterBatchWrite) await adapters.afterBatchWrite(record, state);
      applyBatch(state, record, config.skipUnavailable);
      await saveState(outputDir, state);
      if (typeof runtime.progress === 'function') await runtime.progress({ current: requestsThisRun, total: config.maxRequests,
        message: `Post ${request.post_id}; ${state.posts.filter(post => post.skipped_unavailable).length}/${state.posts.length} posts skipped; ${state.posts.reduce((sum, post) => sum + Object.keys(post.comments).length, 0)} unique comments; ${state.posts.reduce((sum, post) => sum + post.queue.length, 0)} queued IDs; request ${requestsThisRun}/${config.maxRequests}` });
    }
  } catch (error) {
    reason = runtime.signal?.aborted || error.code === 'ABORTED' ? 'cancelled' : 'collector_error';
    state.notices.push({ type: reason, note: error.code === 'ABORTED' ? 'Read interrupted; resume explicitly with this outputDir.' : 'Unexpected local error; inspect durable batches and checkpoint. Error messages are omitted to avoid leaking browser session data.' });
  }
  return deliver(state, outputDir, status, reason, requestsThisRun);
}

export async function run(runtime) { return collect(runtime); }
