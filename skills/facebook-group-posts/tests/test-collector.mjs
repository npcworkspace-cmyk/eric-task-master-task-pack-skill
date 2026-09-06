import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OPERATION, normalizeInput, normalizeStory, mergePost, parseFeedResponse, pageStatus,
  boundaryState, requestTemplate, loadResumeState, readInitialSeedFields, selectActiveHistory, atomicJson, run } from '../scripts/collect.mjs';

// Synthetic fixtures only. No browser, HTTP, real group IDs, or real cursors are used.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'facebook-collector-offline-'));
const GROUP = '12345', URL = 'https://www.facebook.com/groups/synthetic-group/';
const BASE = { groupUrl: URL, startTime: '2030-04-01T00:00:00+08:00', endTime: '2030-05-01T00:00:00+08:00', outputDir: root, maxPages: 2, paceMs: 250, timezone: 'Asia/Shanghai' };
const WHEN = Date.parse('2030-04-15T00:00:00Z') / 1000;
const read = file => fs.readFile(file, 'utf8').then(JSON.parse);
const passed = [];
async function test(name, fn) { await fn(); passed.push(name); }
function story(id, when = WHEN, overrides = {}) {
  const actions = [
    { __typename: 'UFIStoryReactActionRenderer', feedback: { reaction_count: { count: 0 } } },
    { __typename: 'UFICommentActionRenderer', feedback: { comment_rendering_instance: { comments: { total_count: 2 } } } },
    { __typename: 'XFBUFIAdaptiveShareActionRenderer', feedback: { share_count: { count: 1 } } }
  ];
  return { __typename: 'Story', post_id: String(id), creation_time: when, feedback: { associated_group: { id: GROUP } },
    permalink_url: `${URL}posts/${id}/`, message: { text: `Synthetic post ${id}\nSecond line 😀` },
    comet_sections: { feedback: { story: { story_ufi_container: { story: { feedback_context: {
      feedback_target_with_context: { comet_ufi_summary_and_actions_renderer: { feedback: { adaptive_ufi_action_renderers: actions } } }
    } } } } } }, ...overrides };
}
function stream(nodes, next, hasNext = true) {
  const records = [{ data: { node: { group_feed: { edges: nodes.slice(0, 1).map(node => ({ node })) } } } }];
  for (let index = 1; index < nodes.length; index++) records.push({ data: { node: nodes[index] }, path: ['node', 'group_feed', 'edges', index] });
  records.push({ data: { page_info: { end_cursor: next, has_next_page: hasNext } }, path: ['node', 'group_feed'], extensions: { is_final: true } });
  return 'for (;;);' + records.map(record => JSON.stringify(record)).join('\n');
}
const trio = (start, when = WHEN) => [0, 1, 2].map(n => story(start + n, when - n));
function mockPage(responses, { bootstrap = stream(trio(1), 'synthetic-page-1'), seeds = [], targetGroup = GROUP, failGoto = false, extraInitialResponse = false, firstResponseDelay = 0 } = {}) {
  const handlers = {}, requests = []; let current = 'about:blank', calls = 0, seedReads = 0;
  const request = { url: () => 'https://www.facebook.com/api/graphql/', postData: () => new URLSearchParams({
    fb_api_req_friendly_name: OPERATION, fb_dtsg: 'SYNTHETIC_AUTH_NEVER_SAVE',
    variables: JSON.stringify({ id: targetGroup, sortingSetting: 'CHRONOLOGICAL', count: 3, cursor: 'synthetic-bootstrap-request' }) }).toString() };
  return { requests, get calls() { return calls; }, get seedReads() { return seedReads; }, url: () => current,
    on: (name, fn) => { handlers[name] = fn; }, off: name => { delete handlers[name]; },
    goto: async url => { calls++; if (failGoto) throw new Error('synthetic navigation failure'); current = url;
      handlers.request(request);
      if (extraInitialResponse) { const second = { ...request, postData: () => { const form = new URLSearchParams(request.postData()); const vars = JSON.parse(form.get('variables')); vars.cursor = 'synthetic-page-1'; form.set('variables', JSON.stringify(vars)); return form.toString(); } };
        handlers.request(second); handlers.response({ request: () => second, text: async () => { await new Promise(resolve => setTimeout(resolve, firstResponseDelay ? 0 : 10)); return stream(trio(4), 'synthetic-page-2'); } }); }
      handlers.response({ request: () => request, text: async () => { if (firstResponseDelay) await new Promise(resolve => setTimeout(resolve, firstResponseDelay)); return bootstrap; } }); },
    waitForFunction: async () => {}, waitForTimeout: async () => {},
    evaluate: async (fn, args) => {
      if (args?.name === OPERATION) {
        const variables = JSON.parse(new URLSearchParams(args.body).get('variables'));
        requests.push(variables.cursor); assert.equal(variables.count, 3);
        assert.ok(responses.length, 'Unexpected additional pagination request');
        const result = responses.shift(); return typeof result === 'string' ? { status: 200, text: result } : result;
      }
      if (args?.groupId) { seedReads++; return seeds; }
      return undefined;
    }
  };
}
async function collect(name, responses, input = {}, mock = {}, signal = { aborted: false }) {
  const directory = path.join(root, name), page = mockPage(responses, mock);
  const result = await run({ page, input: { ...BASE, outputDir: directory, ...input }, outputDir: path.join(directory, 'task-artifacts'), signal, progress: async () => {} });
  return { result, page, directory, data: await read(path.join(directory, 'posts.json')), checkpoint: await read(path.join(directory, 'pagination-checkpoint.json')).catch(() => null) };
}
async function history(checkpoint) {
  const records = [];
  for (const file of checkpoint.history_files) for (const line of (await fs.readFile(file, 'utf8')).split('\n'))
    if (line.trim()) records.push(JSON.parse(line));
  return records;
}

await test('Input contract, explicit task page budget, timezone requirement, aliases, and technical defaults', async () => {
  assert.throws(() => normalizeInput({ ...BASE, maxPages: undefined }), /explicit positive safe integer/);
  const config = normalizeInput(BASE); assert.equal(config.maxPages, 2); assert.equal(config.boundaryPages, 5);
  assert.equal(config.startTime, '2030-03-31T16:00:00.000Z');
  assert.equal(normalizeInput({ ...BASE, startTime: undefined, endTime: undefined, windowStart: BASE.startTime, windowEnd: BASE.endTime }).startTime, config.startTime);
  assert.throws(() => normalizeInput({ ...BASE, startTime: '2030-04-01T00:00:00' }), /timezone/);
  assert.throws(() => normalizeInput({ ...BASE, windowStart: '2030-04-02T00:00:00Z' }), /conflict/);
  assert.throws(() => normalizeInput({ ...BASE, outputDir: 'relative-directory' }), /absolute/);
  assert.throws(() => normalizeInput({ ...BASE, groupUrl: 'https://example.org/groups/fake/' }), /Facebook/);
  assert.throws(() => normalizeInput({ ...BASE, startTime: '2030-02-30T00:00:00Z' }), /calendar/);
  assert.throws(() => normalizeInput({ ...BASE, startTime: '2030-04-01T24:00:00Z' }), /clock/);
  assert.throws(() => normalizeInput({ ...BASE, groupUrl: 'https://www.facebook.com:444/groups/synthetic-group/' }), /Facebook/);
  assert.throws(() => normalizeInput({ ...BASE, timezone: 'Not/A_Timezone' }), /timezone/);
  assert.equal(normalizeInput(BASE).timezone, 'Asia/Shanghai');
});
await test('Original caption, shared caption, newlines, null and zero are distinct', async () => {
  const post = normalizeStory(story(10, WHEN, { attached_story: { message: { text: 'Shared original text' } } }), { groupId: GROUP, groupUrl: URL });
  assert.equal(post.body, 'Synthetic post 10\nSecond line 😀'); assert.equal(post.shared_body, 'Shared original text');
  assert.equal(post.reactions, 0); assert.equal(post.comments, 2); assert.equal(post.shares, 1);
  const empty = normalizeStory(story(11, WHEN, { comet_sections: {}, message: { text: '' }, attachments: [{ media: { __typename: 'Photo', uri: 'DO_NOT_KEEP_IMAGE_URL' } }] }), { groupId: GROUP, groupUrl: URL });
  assert.equal(empty.reactions, null); assert.equal(empty.status, '无文字媒体贴文'); assert.deepEqual(empty.media_types, ['Photo']); assert.ok(!JSON.stringify(empty).includes('DO_NOT_KEEP_IMAGE_URL'));
  assert.equal(normalizeStory(story(12, WHEN, { __typename: 'Comment' }), { groupId: GROUP, groupUrl: URL }), null);
  const unknown = normalizeStory(story(13, null, { permalink_url: 'https://example.org/wrong' }), { groupId: GROUP, groupUrl: URL });
  assert.equal(unknown.published_at, null); assert.equal(unknown.url, null);
  const map = new Map(); mergePost(map, post); mergePost(map, { ...post, reactions: null, collected_at: '2099-01-01T00:00:00Z' });
  assert.equal(map.get(post.post_id).reactions, 0); assert.equal(map.get(post.post_id).count_observed_at.reactions, post.collected_at);
  const missing = normalizeStory(story(10, null, { message: undefined, permalink_url: '' }), { groupId: GROUP, groupUrl: URL, observedAt: '2099-02-01T00:00:00Z' });
  mergePost(map, missing); assert.equal(map.get('10').body, post.body); assert.equal(map.get('10').url, post.url); assert.equal(map.get('10').published_at, post.published_at);
  assert.equal(map.get('10').retained_fields.length, 3);
  const explicitlyEmpty = normalizeStory(story(10, WHEN, { message: null }), { groupId: GROUP, groupUrl: URL, observedAt: '2099-03-01T00:00:00Z' });
  mergePost(map, explicitlyEmpty); assert.equal(map.get('10').body, '');
});
await test('All streamed root edges and the deferred final cursor are required', async () => {
  const raw = stream(trio(20), 'synthetic-next'), parsed = parseFeedResponse(raw, { groupId: GROUP, groupUrl: URL });
  assert.equal(parsed.posts.length, 3); assert.equal(parsed.frameCount, 4); assert.equal(pageStatus(parsed, 'synthetic-prior'), 'ok');
  const incomplete = parseFeedResponse(raw.split('\n').slice(0, -1).join('\n'), { groupId: GROUP, groupUrl: URL });
  assert.equal(pageStatus(incomplete, 'synthetic-prior'), 'pagination_incomplete');
  assert.equal(pageStatus(parseFeedResponse(raw + '\nINVALID_FRAME', { groupId: GROUP, groupUrl: URL }), 'prior'), 'pagination_incomplete');
  assert.equal(pageStatus(parseFeedResponse(stream(trio(20).slice(0, 2), 'next'), { groupId: GROUP, groupUrl: URL }), 'prior'), 'unexpected_story_count');
  assert.equal(pageStatus(parsed, 'synthetic-next'), 'cursor_not_advanced');
  const comment = JSON.stringify({ data: { node: story(99) }, path: ['node', 'feedback', 'comments', 0] });
  assert.equal(parseFeedResponse(comment, { groupId: GROUP, groupUrl: URL }).posts.length, 0);
});
await test('Group ID discovery requires target URL, operation, group hint, and page size', async () => {
  const config = normalizeInput(BASE), request = { url: () => 'https://www.facebook.com/api/graphql/', postData: () => new URLSearchParams({ fb_api_req_friendly_name: OPERATION, variables: JSON.stringify({ id: GROUP, sortingSetting: 'CHRONOLOGICAL', count: 3 }) }).toString() };
  assert.equal(requestTemplate(request, URL, config).groupId, GROUP);
  assert.equal(requestTemplate(request, 'https://www.facebook.com/groups/synthetic-another/', config), null);
  assert.equal(requestTemplate(request, URL, config, '99999'), null);
});
await test('Initial page JSON is reduced to whitelist fields without nested shared stories', async () => {
  const previous = { location: globalThis.location, document: globalThis.document };
  globalThis.location = new globalThis.URL(URL);
  globalThis.document = { querySelectorAll: () => [{ textContent: JSON.stringify({ secret: 'SYNTHETIC_AUTH_NEVER_SAVE', story: story(500, WHEN, { author: { name: 'DO_NOT_KEEP_AUTHOR' }, attached_story: story(501) }) }) }] };
  try {
    const seeds = readInitialSeedFields({ groupId: GROUP, groupUrl: URL }); assert.equal(seeds.length, 1);
    assert.ok(!JSON.stringify(seeds).includes('DO_NOT_KEEP_AUTHOR')); assert.ok(!JSON.stringify(seeds).includes('SYNTHETIC_AUTH_NEVER_SAVE'));
    const post = normalizeStory(seeds[0], { groupId: GROUP, groupUrl: URL, source: 'initial_page_seed' }); assert.equal(post.body, 'Synthetic post 500\nSecond line 😀'); assert.equal(post.comments, 2);
  } finally { globalThis.location = previous.location; globalThis.document = previous.document; }
});

let first, second;
await test('Only the first qualifying initialization request can advance the bootstrap cursor', async () => {
  for (const delay of [0, 10]) {
    const result = await collect(`initial-race-${delay}`, [stream(trio(4), 'synthetic-page-2')], { maxPages: 1 }, { extraInitialResponse: true, firstResponseDelay: delay });
    assert.deepEqual(result.page.requests, ['synthetic-page-1']); assert.equal(result.data.metadata.initial_pagination_responses_accepted, 1);
    const anchor = JSON.parse((await fs.readFile(result.checkpoint.history_files[0], 'utf8')).split('\n')[0]);
    assert.equal(anchor.request_cursor, 'synthetic-bootstrap-request'); assert.equal(anchor.next_cursor, 'synthetic-page-1'); assert.equal(anchor.posts.length, 3);
  }
  await assert.rejects(collect('initial-invalid-first', [], {}, { bootstrap: stream(trio(1).slice(0, 2), 'bad-next'), extraInitialResponse: true }), /No complete/);
});
await test('Two batches continue at the exact recorded cursor with cumulative page numbers', async () => {
  first = await collect('first', [stream(trio(4), 'synthetic-page-2'), stream(trio(7), 'synthetic-page-3')], {}, { seeds: [story(100, WHEN - 10 * 86400)] });
  assert.deepEqual(first.page.requests, ['synthetic-page-1', 'synthetic-page-2']); assert.equal(first.result.pages, 2); assert.equal(first.data.posts.length, 10);
  const anchor = JSON.parse((await fs.readFile(first.checkpoint.history_files[0], 'utf8')).split('\n')[0]);
  assert.equal(anchor.request_cursor, 'synthetic-bootstrap-request'); assert.equal(anchor.posts.length, 4);
  assert.equal(anchor.posts.find(post => post.post_id === '100').source, 'initial_page_seed');
  assert.equal(anchor.posts.find(post => post.post_id === '1').source, 'browser_feed_response');
  assert.equal(first.data.metadata.current_page_earliest, new Date((WHEN - 2) * 1000).toISOString());
  assert.notEqual(first.data.metadata.current_page_earliest, first.data.posts.map(post => post.published_at).sort()[0]);
  second = await collect('second', [stream(trio(10), 'synthetic-page-4'), stream(trio(13), 'synthetic-page-5')],
    { resumeCheckpointPath: path.join(first.directory, 'pagination-checkpoint.json') },
    { bootstrap: stream([story(1, WHEN, { message: { text: 'UNJOURNALED_HEAD_EDIT' } }), story(900), story(901)], 'synthetic-fresh-head'), seeds: [story(902)] });
  assert.deepEqual(second.page.requests, ['synthetic-page-3', 'synthetic-page-4']); assert.equal(second.result.pages, 4); assert.equal(second.data.posts.length, 16);
  assert.equal(second.data.metadata.group_id, GROUP); assert.equal(second.data.metadata.resumed_from_page, 3); assert.equal(second.data.metadata.coverage_complete, false);
  assert.equal(second.data.metadata.timezone, 'Asia/Shanghai'); assert.equal(second.checkpoint.required_boundary_pages, 5);
  assert.equal(second.data.metadata.current_page_earliest, new Date((WHEN - 2) * 1000).toISOString());
  assert.equal(second.page.seedReads, 0); assert.equal(second.data.metadata.initial_seed_scan_succeeded, true);
  assert.equal(second.data.metadata.initial_page_seed_count, 1); assert.equal(second.data.metadata.initial_evidence_origin, 'retained_checkpoint_bootstrap');
  assert.equal(second.data.posts.find(post => post.post_id === '1').body, first.data.posts.find(post => post.post_id === '1').body);
  assert.ok(!second.data.posts.some(post => ['900', '901', '902'].includes(post.post_id)));
  const journalIds = new Set();
  for (const file of second.checkpoint.history_files) for (const line of (await fs.readFile(file, 'utf8')).split('\n'))
    if (line.trim()) for (const post of JSON.parse(line).posts || []) journalIds.add(post.post_id);
  assert.ok(second.data.posts.every(post => journalIds.has(post.post_id)), 'Every final in-range ID, including initial seeds, has journal evidence.');
});
await test('Terminal null and HTTP errors preserve a usable continuation', async () => {
  const resumeCheckpointPath = path.join(second.directory, 'pagination-checkpoint.json');
  const terminal = await collect('terminal', [stream([], null, false)], { resumeCheckpointPath });
  assert.equal(terminal.result.reason, 'feed_end'); assert.equal(terminal.checkpoint.cursor, 'synthetic-page-5'); assert.equal(terminal.checkpoint.pages, 4);
  const record = JSON.parse((await fs.readFile(terminal.checkpoint.history_files.at(-1), 'utf8')).trim());
  assert.equal(record.request_cursor, 'synthetic-page-5'); assert.equal(record.next_cursor, null);
  const failed = await collect('http-failure', [{ status: 503, text: '' }], { resumeCheckpointPath });
  assert.equal(failed.result.reason, 'http_error'); assert.equal(failed.checkpoint.cursor, 'synthetic-page-5'); assert.equal(failed.result.pages, 4);
  assert.equal(failed.data.metadata.coverage_complete, false);
  assert.equal(failed.data.metadata.current_page_earliest, second.data.metadata.current_page_earliest);
});
await test('Bad or incomplete pages preserve evidence and never advance the checkpoint', async () => {
  const incomplete = stream(trio(40), 'ignored').split('\n').slice(0, -1).join('\n');
  const result = await collect('incomplete', [incomplete]); assert.equal(result.result.reason, 'pagination_incomplete'); assert.equal(result.checkpoint.pages, 0);
  assert.equal(result.checkpoint.cursor, 'synthetic-page-1');
  assert.equal(result.data.metadata.current_page_earliest, new Date((WHEN - 2) * 1000).toISOString());
  const history = (await fs.readFile(result.checkpoint.history_files.at(-1), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(history.at(-1).status, 'pagination_incomplete'); assert.equal(history.at(-1).posts.length, 3);
  assert.ok(!result.data.posts.some(post => ['40', '41', '42'].includes(post.post_id)), 'Failed observations remain evidence only.');
});
await test('A complete terminal retry can be superseded only by the same request boundary', async () => {
  const terminal = await collect('terminal-for-retry', [stream([], null, false)], { resumeCheckpointPath: path.join(second.directory, 'pagination-checkpoint.json') });
  const resumed = await collect('after-terminal', [stream(trio(16), 'synthetic-page-6'), stream(trio(19), 'synthetic-page-7')], { resumeCheckpointPath: path.join(terminal.directory, 'pagination-checkpoint.json') });
  assert.deepEqual(resumed.page.requests, ['synthetic-page-5', 'synthetic-page-6']); assert.equal(resumed.result.pages, 6);
  const recovered = await loadResumeState(normalizeInput({ ...BASE, outputDir: root, resumeCheckpointPath: path.join(resumed.directory, 'pagination-checkpoint.json') }));
  assert.equal(recovered.supersededTerminals.length, 1); assert.equal(recovered.audit.length, 6);
  const next = await collect('next-after-terminal', [stream(trio(22), 'synthetic-page-8')], { maxPages: 1, resumeCheckpointPath: path.join(resumed.directory, 'pagination-checkpoint.json') });
  assert.equal(next.result.pages, 7); assert.equal(next.data.metadata.superseded_terminal_attempts.length, 1);
  const records = [];
  for (const file of resumed.checkpoint.history_files) for (const line of (await fs.readFile(file, 'utf8')).split('\n')) if (line.trim()) records.push(JSON.parse(line));
  const bad = structuredClone(records); const oldTerminal = bad.find(row => row.page === 5 && row.has_next === false); oldTerminal.request_cursor = 'different-boundary';
  assert.throws(() => selectActiveHistory(bad, resumed.checkpoint), /conflicting retry/);
  const duplicateSuccess = [...records, structuredClone(records.find(row => row.page === 5 && row.has_next === true))];
  assert.throws(() => selectActiveHistory(duplicateSuccess, resumed.checkpoint), /repeats a successful page/);
});
let incompleteRetry, incompleteRecords;
await test('An ordinary incomplete attempt recovers at its exact cursor without promoting failed fields', async () => {
  const failedBody = stream([story(13, WHEN, { message: { text: 'FAILED_ONLY_EDIT' } }), story(700)], 'ignored-next').split('\n').slice(0, -1).join('\n');
  const failed = await collect('ordinary-incomplete', [failedBody], { resumeCheckpointPath: path.join(second.directory, 'pagination-checkpoint.json') });
  assert.equal(failed.result.reason, 'pagination_incomplete'); assert.equal(failed.checkpoint.pages, 4);
  assert.equal(failed.data.posts.find(post => post.post_id === '13').body, second.data.posts.find(post => post.post_id === '13').body);
  assert.ok(!failed.data.posts.some(post => post.post_id === '700'));
  const raw = (await history(failed.checkpoint)).at(-1);
  assert.equal(raw.posts[0].body, 'FAILED_ONLY_EDIT'); assert.equal(raw.posts[1].post_id, '700');
  // A pre-fix snapshot may contain a partial-only row. Recovery derives official
  // fields from the successful journal and leaves the original snapshot intact.
  const contaminated = structuredClone(failed.data); contaminated.posts.push(raw.posts[1]);
  contaminated.posts.find(post => post.post_id === '13').body = 'FAILED_ONLY_EDIT';
  await atomicJson(path.join(failed.directory, 'posts.json'), contaminated);
  incompleteRetry = await collect('after-ordinary-incomplete', [stream(trio(16), 'synthetic-page-6'), stream(trio(19), 'synthetic-page-7')],
    { resumeCheckpointPath: path.join(failed.directory, 'pagination-checkpoint.json') });
  assert.deepEqual(incompleteRetry.page.requests, ['synthetic-page-5', 'synthetic-page-6']); assert.equal(incompleteRetry.result.pages, 6);
  assert.ok(!incompleteRetry.data.posts.some(post => post.post_id === '700'));
  assert.equal(incompleteRetry.data.posts.find(post => post.post_id === '13').body, second.data.posts.find(post => post.post_id === '13').body);
  const recovered = await loadResumeState(normalizeInput({ ...BASE, resumeCheckpointPath: path.join(incompleteRetry.directory, 'pagination-checkpoint.json') }));
  assert.equal(recovered.supersededIncomplete.length, 1); assert.equal(recovered.supersededIncomplete[0].classification, 'INCOMPLETE_RETRY_SUPERSEDED');
  assert.equal(recovered.audit.length, 6); assert.ok(!recovered.posts.has('700'));
  incompleteRecords = await history(incompleteRetry.checkpoint);
  assert.equal(incompleteRecords.filter(row => row.page === 5).length, 2, 'The failed raw attempt remains in the journal chain.');
  const next = await collect('next-after-incomplete', [stream(trio(22), 'synthetic-page-8')], { maxPages: 1, resumeCheckpointPath: path.join(incompleteRetry.directory, 'pagination-checkpoint.json') });
  assert.equal(next.data.metadata.superseded_incomplete_attempts.length, 1); assert.equal(next.result.pages, 7);
});
await test('Incomplete retry selection rejects cursor conflicts, successful duplicates, and failures after success', async () => {
  const oldIndex = incompleteRecords.findIndex(row => row.status === 'pagination_incomplete');
  const wrongCursor = structuredClone(incompleteRecords); wrongCursor[oldIndex].request_cursor = 'synthetic-unrelated-cursor';
  assert.throws(() => selectActiveHistory(wrongCursor, incompleteRetry.checkpoint), /conflicting retry/);
  const duplicate = [...incompleteRecords, structuredClone(incompleteRecords.find(row => row.page === 5 && row.status === 'ok'))];
  assert.throws(() => selectActiveHistory(duplicate, incompleteRetry.checkpoint), /repeats a successful page/);
  const afterSuccess = [...incompleteRecords.filter((_, index) => index !== oldIndex), structuredClone(incompleteRecords[oldIndex])];
  assert.throws(() => selectActiveHistory(afterSuccess, incompleteRetry.checkpoint), /conflicting retry/);
});
await test('Incomplete retry eligibility requires clean complete diagnostic evidence and consistent observations', async () => {
  const mutations = [
    row => { row.status = row.audit.status = 'response_error'; },
    row => { row.status = row.audit.status = 'http_error'; },
    row => { row.audit.http_status = 401; },
    row => { row.audit.http_status = 429; },
    row => { row.audit.errors = [{ code: 401, severity: 'ERROR' }]; },
    row => { row.audit.malformed_frames = 1; },
    row => { row.audit.rejected_stories = 1; },
    row => { row.audit.frame_count = 0; },
    row => { delete row.audit.errors; },
    row => { delete row.audit; },
    row => { row.audit.count++; },
    row => { row.audit.ids[0] = '999999'; },
    row => { row.audit.dates[0] = '2030-01-01T00:00:00Z'; },
    row => { row.posts = []; row.audit.count = 0; row.audit.ids = []; row.audit.dates = []; },
    row => { row.posts.push(row.posts[0]); row.audit.count++; row.audit.ids.push(row.audit.ids[0]); row.audit.dates.push(row.audit.dates[0]); },
    row => { row.has_next = row.audit.has_next = true; },
    row => { row.stream_final = row.audit.stream_final = true; },
    row => { row.next_cursor = 'synthetic-unverified-next'; }
  ];
  for (const mutate of mutations) {
    const records = structuredClone(incompleteRecords); mutate(records.find(row => row.status === 'pagination_incomplete'));
    assert.throws(() => selectActiveHistory(records, incompleteRetry.checkpoint), /ordinary incomplete|discontinuous/);
  }
  const incompleteWinner = structuredClone(incompleteRecords);
  incompleteWinner.find(row => row.page === 5 && row.status === 'ok').audit.malformed_frames = 1;
  assert.throws(() => selectActiveHistory(incompleteWinner, incompleteRetry.checkpoint), /discontinuous/);
});
await test('A nonempty terminal remains official data and cannot be silently superseded on resume', async () => {
  const terminal = await collect('nonempty-terminal', [stream(trio(16), null, false)], { resumeCheckpointPath: path.join(second.directory, 'pagination-checkpoint.json') });
  assert.equal(terminal.result.reason, 'feed_end'); assert.equal(terminal.result.pages, 5); assert.equal(terminal.checkpoint.pages, 4);
  assert.ok(terminal.data.posts.some(post => post.post_id === '16'));
  await assert.rejects(loadResumeState(normalizeInput({ ...BASE, resumeCheckpointPath: path.join(terminal.directory, 'pagination-checkpoint.json') })), /requires review before retry/);
  const records = structuredClone(incompleteRecords), old = records.find(row => row.status === 'pagination_incomplete');
  old.status = old.audit.status = 'ok'; old.stream_final = old.audit.stream_final = true; old.has_next = old.audit.has_next = false;
  assert.throws(() => selectActiveHistory(records, incompleteRetry.checkpoint), /empty terminal/);
});
await test('Authentication, response-error, and HTTP failures cannot become an ordinary retry by resume', async () => {
  const resumeCheckpointPath = path.join(second.directory, 'pagination-checkpoint.json');
  for (const [name, response] of [
    ['access-denied', { status: 401, text: '' }],
    ['server-failure', { status: 503, text: '' }],
    ['response-error', stream(trio(16), 'ignored') + '\n' + JSON.stringify({ errors: [{ code: 401, severity: 'ERROR' }] })]
  ]) {
    const failed = await collect(name, [response], { resumeCheckpointPath });
    assert.equal(failed.checkpoint.pages, 4); assert.ok(!failed.data.posts.some(post => post.post_id === '16'));
    await assert.rejects(loadResumeState(normalizeInput({ ...BASE, resumeCheckpointPath: path.join(failed.directory, 'pagination-checkpoint.json') })), /requires review before retry/);
  }
});
await test('Explicit resume refuses missing, mismatched, or tampered state before browser use', async () => {
  const checkpoint = path.join(second.directory, 'pagination-checkpoint.json');
  await assert.rejects(loadResumeState(normalizeInput({ ...BASE, resumeCheckpointPath: path.join(root, 'absent.json') })), /refusing to restart/);
  await assert.rejects(loadResumeState(normalizeInput({ ...BASE, resumeCheckpointPath: checkpoint, groupId: '77777' })), /mismatch/);
  await assert.rejects(loadResumeState(normalizeInput({ ...BASE, resumeCheckpointPath: checkpoint, startTime: '2030-04-02T00:00:00Z' })), /mismatch/);
  const tampered = path.join(root, 'tampered.json'); await atomicJson(tampered, { ...second.checkpoint, cursor: 'invented-cursor' });
  await assert.rejects(loadResumeState(normalizeInput({ ...BASE, resumeCheckpointPath: tampered })), /discontinuous/);
  const stale = path.join(root, 'stale-committed-checkpoint.json'); await atomicJson(stale, { ...second.checkpoint, pages: 3, next_page: 4, cursor: 'synthetic-page-4' });
  await assert.rejects(loadResumeState(normalizeInput({ ...BASE, resumeCheckpointPath: stale })), /advanced beyond/);
  await assert.rejects(loadResumeState(normalizeInput({ ...BASE, outputDir: first.directory })), /already contains/);
});
await test('Synced journals recover a lagging aggregate snapshot, including a torn final line', async () => {
  const directory = path.join(root, 'recovery'); await fs.mkdir(directory);
  const source = path.join(directory, 'lagging-posts.json'); await atomicJson(source, { ...second.data, posts: [] });
  const checkpoint = path.join(directory, 'checkpoint.json'); await atomicJson(checkpoint, { ...second.checkpoint, source_file: source });
  const recovered = await loadResumeState(normalizeInput({ ...BASE, outputDir: directory, resumeCheckpointPath: checkpoint }));
  assert.ok(recovered.posts.has('15')); assert.equal(recovered.audit.length, 4);
  const journal = path.join(directory, 'torn.jsonl'); await fs.writeFile(journal, '{"unfinished":');
  await atomicJson(checkpoint, { ...second.checkpoint, source_file: source, history_files: [...second.checkpoint.history_files, journal] });
  assert.equal((await loadResumeState(normalizeInput({ ...BASE, outputDir: directory, resumeCheckpointPath: checkpoint }))).audit.length, 4);
});
await test('Five complete old pages are evidence, not proof that an unordered feed has no later posts', async () => {
  const oldWhen = Date.parse('2030-03-31T00:00:00Z') / 1000;
  const oldPages = Array.from({ length: 5 }, (_, index) => stream(trio(200 + index * 3, oldWhen - index * 10), `synthetic-old-${index + 1}`));
  const ordered = await collect('old-boundary', [...oldPages], { maxPages: 10 });
  assert.equal(ordered.result.pages, 5); assert.equal(ordered.result.reason, 'date_boundary_reached'); assert.equal(ordered.data.metadata.boundary_verified, true);
  assert.equal(ordered.data.metadata.coverage_complete, false); assert.equal(ordered.checkpoint.pages, 5);
  const rows = Array.from({ length: 5 }, (_, index) => ({ kind: 'page', status: 'ok', page: index + 1, count: 3, ids: trio(index * 3 + 200).map(x => x.post_id), dates: [0, 1, 2].map(j => new Date((oldWhen - index * 10 - j) * 1000).toISOString()), stream_final: true }));
  rows[1].dates[0] = new Date((oldWhen + 100) * 1000).toISOString();
  const state = boundaryState(rows, BASE.startTime, 5); assert.equal(state.reached, true); assert.equal(state.reason, 'date_boundary_needs_review'); assert.ok(state.dateOrderRegressions > 0);
  rows[4].ids = rows[3].ids; assert.equal(boundaryState(rows, BASE.startTime, 5).reached, false);
});
await test('An explicit stop keeps prior records and the last usable checkpoint', async () => {
  const result = await collect('stopped', [], { resumeCheckpointPath: path.join(second.directory, 'pagination-checkpoint.json') }, {}, { aborted: true });
  assert.equal(result.result.reason, 'stopped'); assert.equal(result.result.pages, 4); assert.equal(result.data.posts.length, 16);
});
await test('Atomic rename retries transient Windows locks and preserves files on persistent failure', async () => {
  const original = fs.rename; let calls = 0, retained;
  const file = path.join(root, 'atomic.json'); await fs.writeFile(file, '{"old":true}');
  try {
    fs.rename = async (from, to) => { calls++; if (calls < 3) throw Object.assign(new Error('synthetic lock'), { code: 'EPERM' }); return original(from, to); };
    await atomicJson(file, { new: true }); assert.equal(calls, 3); assert.deepEqual(await read(file), { new: true });
    const old = await fs.readFile(file); calls = 0;
    fs.rename = async from => { calls++; retained = from; throw Object.assign(new Error('synthetic lock'), { code: 'EBUSY' }); };
    const started = Date.now(); await assert.rejects(atomicJson(file, { uncommitted: true }), { code: 'EBUSY' });
    assert.equal(calls, 8); assert.ok(Date.now() - started < 10000); assert.deepEqual(await fs.readFile(file), old); assert.deepEqual(await read(retained), { uncommitted: true });
  } finally { fs.rename = original; }
});
await test('Authentication never reaches files; task artifacts omit raw cursors', async () => {
  async function scan(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await scan(file);
      else { const text = await fs.readFile(file, 'utf8'); assert.ok(!text.includes('SYNTHETIC_AUTH_NEVER_SAVE'));
        if (directory.endsWith('task-artifacts')) { assert.equal(item.name, 'posts.json'); assert.ok(!text.includes('synthetic-page-')); }
      }
    }
  }
  await scan(root);
});
console.log(JSON.stringify({ passed: true, tests: passed.length, cases: passed, temporary_fixture_directory: root }, null, 2));
