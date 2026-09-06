import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const OPERATION = 'GroupsCometFeedRegularStoriesPaginationQuery';
export const SCHEMA_VERSION = 3;
export const PAGE_SIZE = 3;
const now = () => new Date().toISOString();

export function canonicalGroupUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('groupUrl must be an HTTPS Facebook group URL.'); }
  const match = url.pathname.match(/^\/groups\/([^/]+)\/?$/);
  if (url.protocol !== 'https:' || !['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(url.hostname)
      || url.username || url.password || url.port || !match || !/^[A-Za-z0-9._-]+$/.test(match[1])) {
    throw new Error('groupUrl must identify a single Facebook group, without a post or search path.');
  }
  return `https://www.facebook.com/groups/${match[1]}/`;
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp with an explicit timezone.`);
  const parts = value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/);
  const [, year, month, day, hour, minute, second = '0'] = parts.map(x => x === undefined ? x : Number(x));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
      || hour > 23 || minute > 59 || Number(second) > 59) throw new Error(`${name} has an invalid calendar date or clock time.`);
  return new Date(value).toISOString();
}

export function normalizeInput(input) {
  const start = timestamp(input.startTime ?? input.windowStart, 'startTime');
  const end = timestamp(input.endTime ?? input.windowEnd, 'endTime');
  if (input.startTime !== undefined && input.windowStart !== undefined && timestamp(input.windowStart, 'windowStart') !== start)
    throw new Error('startTime and windowStart conflict.');
  if (input.endTime !== undefined && input.windowEnd !== undefined && timestamp(input.windowEnd, 'windowEnd') !== end)
    throw new Error('endTime and windowEnd conflict.');
  if (Date.parse(start) > Date.parse(end)) throw new Error('startTime must not exceed endTime.');
  if (typeof input.outputDir !== 'string' || !path.isAbsolute(input.outputDir)) throw new Error('outputDir must be an absolute local path.');
  if (input.resumeCheckpointPath !== undefined && (typeof input.resumeCheckpointPath !== 'string' || !path.isAbsolute(input.resumeCheckpointPath)))
    throw new Error('resumeCheckpointPath must be an absolute path.');
  const groupUrl = canonicalGroupUrl(input.groupUrl);
  const groupId = input.groupId === undefined ? null : String(input.groupId);
  if (groupId !== null && !/^\d+$/.test(groupId)) throw new Error('groupId must be a numeric string when supplied.');
  const urlGroup = new URL(groupUrl).pathname.split('/')[2];
  if (groupId && /^\d+$/.test(urlGroup) && urlGroup !== groupId) throw new Error('groupId conflicts with numeric groupUrl.');
  const maxPages = input.maxPages, boundaryPages = input.boundaryPages ?? 5, paceMs = input.paceMs ?? 500;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('maxPages must be an explicit positive safe integer.');
  if (!Number.isInteger(boundaryPages) || boundaryPages < 5 || boundaryPages > 100) throw new Error('boundaryPages must be an integer from 5 to 100.');
  if (!Number.isInteger(paceMs) || paceMs < 250 || paceMs > 60000) throw new Error('paceMs must be an integer from 250 to 60000.');
  const timezone = input.timezone || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new Error('timezone must be a valid IANA timezone.'); }
  return { groupUrl, groupId, startTime: start, endTime: end, outputDir: path.resolve(input.outputDir),
    resumeCheckpointPath: input.resumeCheckpointPath, maxPages, boundaryPages, paceMs, timezone };
}

export function checkpointScope(config, groupId = config.groupId) {
  if (!groupId || !/^\d+$/.test(String(groupId))) throw new Error('A verified group ID is required before creating a checkpoint.');
  return { group_url: config.groupUrl, group_id: String(groupId), start: config.startTime, end: config.endTime,
    operation: OPERATION, sorting_setting: 'CHRONOLOGICAL', page_size: PAGE_SIZE, required_boundary_pages: config.boundaryPages };
}

function assertScope(value, expected, label) {
  if (value?.group_url !== expected.group_url || String(value?.group_id) !== expected.group_id
      || Date.parse(value?.start) !== Date.parse(expected.start) || Date.parse(value?.end) !== Date.parse(expected.end)
      || value?.operation !== OPERATION || value?.sorting_setting !== 'CHRONOLOGICAL' || value?.page_size !== PAGE_SIZE
      || value?.required_boundary_pages !== expected.required_boundary_pages)
    throw new Error(`${label}: checkpoint group, URL, time window, or operation mismatch.`);
}

export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  const delays = [50, 100, 200, 400, 800, 1000, 1000]; // Total backoff 3.55 s; target is never deleted.
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temp, file); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= delays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function exists(file) { try { await fs.stat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

export function normalizeStory(node, { groupId, groupUrl, source = 'browser_authenticated_pagination', observedAt = now() }) {
  const seed = source === 'initial_page_seed' ? node?._seed_fields : null;
  const story = node?.comet_sections?.content?.story;
  const group = String(seed?.group_id ?? node?.feedback?.associated_group?.id ?? story?.target_group?.id ?? '');
  if (!node?.post_id || !/^\d+$/.test(String(node.post_id)) || group !== String(groupId)
      || (node.__typename && node.__typename !== 'Story')) return null;
  const issues = [], id = String(node.post_id);
  const target = node.comet_sections?.feedback?.story?.story_ufi_container?.story?.feedback_context?.feedback_target_with_context;
  const renderers = target?.comet_ufi_summary_and_actions_renderer?.feedback?.adaptive_ufi_action_renderers || [];
  const feedback = type => renderers.find(x => x.__typename === type)?.feedback;
  const reaction = feedback('UFIStoryReactActionRenderer'), comment = feedback('UFICommentActionRenderer'), share = feedback('XFBUFIAdaptiveShareActionRenderer');
  const message = seed ? { text: seed.body } : story?.message || story?.comet_sections?.message?.story?.message || node.message;
  const attached = story?.attached_story || node.attached_story;
  const attachments = story?.attachments || node.attachments || [];
  const mediaTypes = new Set(seed?.media_types || []);
  function media(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 7) return;
    if (typeof value.media?.__typename === 'string') mediaTypes.add(value.media.__typename);
    if (Array.isArray(value)) for (const entry of value) media(entry, depth + 1);
    else for (const key of ['styles', 'attachment', 'all_subattachments', 'subattachments', 'nodes', 'edges', 'node']) media(value[key], depth + 1);
  }
  if (!seed) media(attachments);
  const body = typeof message?.text === 'string' ? message.text : '';
  const bodyKnown = seed ? seed.body_known === true : typeof message?.text === 'string'
    || story?.message === null || story?.comet_sections?.message?.story?.message === null || node.message === null;
  const isShared = seed ? seed.is_shared === true : !!attached;
  const sharedBody = seed ? seed.shared_body : attached?.message?.text;
  const count = (value, key) => { if (value === undefined || value === null) return null; if (!Number.isInteger(value) || value < 0) { issues.push(`invalid_${key}`); return null; } return value; };
  const epoch = seed?.creation_time ?? node.creation_time;
  const published = typeof epoch === 'number' && Number.isFinite(epoch) && Number.isFinite(new Date(epoch * 1000).getTime()) ? new Date(epoch * 1000).toISOString() : null;
  if (!published) issues.push('unknown_publication_time');
  let url = null;
  try {
    const candidate = new URL(seed?.url || node.permalink_url || node.comet_sections?.timestamp?.story?.url || story?.wwwURL || '');
    const match = candidate.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)\/?$/);
    const targetSlug = new URL(groupUrl).pathname.split('/')[2];
    if (candidate.protocol === 'https:' && ['www.facebook.com', 'facebook.com'].includes(candidate.hostname)
        && match && [targetSlug, String(groupId)].includes(match[1]) && match[2] === id) { candidate.search = ''; candidate.hash = ''; url = candidate.href; }
  } catch { /* Missing URLs remain missing and reviewable; they are never fabricated. */ }
  if (!url) issues.push('missing_or_invalid_permalink');
  const attachmentCount = seed ? seed.attachment_count : attachments.length;
  const post = { post_id: id, url, published_at: published, published_at_raw: published ? epoch : null, body,
    shared_body: typeof sharedBody === 'string' ? sharedBody : null, is_shared: isShared,
    attachment_count: Number.isInteger(attachmentCount) ? attachmentCount : 0, media_types: [...mediaTypes],
    shares: count(seed ? seed.shares : share?.share_count?.count, 'shares'),
    reactions: count(seed ? seed.reactions : reaction?.reaction_count?.count, 'reactions'),
    comments: count(seed ? seed.comments : comment?.comment_rendering_instance?.comments?.total_count ?? target?.comment_rendering_instance?.comments?.total_count, 'comments'),
    shares_raw: null, reactions_raw: null, comments_raw: null, collected_at: observedAt, body_truncated: false,
    status: body ? '页面返回的完整原文' : isShared ? '无附言转发' : mediaTypes.size ? '无文字媒体贴文' : attachmentCount ? '无文字附件贴文' : '空正文待核查',
    source, body_known: bodyKnown, field_observed_at: { body: bodyKnown ? observedAt : null, url: url ? observedAt : null, publication_time: published ? observedAt : null },
    field_issues: issues, source_fields: { body: 'root Story message.text', date: 'root Story creation_time', counts: 'root Story adaptive UFI feedback renderers' } };
  post.count_observed_at = Object.fromEntries(['shares', 'reactions', 'comments'].map(key => [key, post[key] === null ? null : observedAt]));
  return post;
}

export function mergePost(map, post) {
  const previous = map.get(post.post_id);
  if (previous && Date.parse(previous.collected_at) > Date.parse(post.collected_at)) return previous;
  const value = { ...post, count_observed_at: { ...post.count_observed_at }, field_observed_at: { ...post.field_observed_at }, retained_fields: [] };
  if (previous) {
    const preserve = (field, key) => { value[field] = previous[field]; value.field_observed_at[key] = previous.field_observed_at?.[key] ?? previous.collected_at;
      value.retained_fields.push({ field, from_collected_at: value.field_observed_at[key], reason: 'unavailable_in_new_observation' }); };
    if (!post.url && previous.url) preserve('url', 'url');
    if (!post.published_at && previous.published_at) { preserve('published_at', 'publication_time'); value.published_at_raw = previous.published_at_raw; }
    if (post.body_known === false && previous.body_known !== false) { preserve('body', 'body'); value.body_known = true;
      if (value.body) value.status = '页面返回的完整原文'; }
  }
  if (previous) for (const key of ['shares', 'reactions', 'comments']) if (value[key] === null && previous[key] !== null) {
    value[key] = previous[key]; value.count_observed_at[key] = previous.count_observed_at?.[key] ?? previous.collected_at;
  }
  map.set(value.post_id, value); return value;
}

export function parseFeedResponse(raw, context) {
  const posts = [], errors = []; let pageInfo = null, streamFinal = false, frameCount = 0, malformedFrames = 0, rejectedStories = 0;
  for (const original of String(raw).split(/\r?\n/)) {
    const line = original.replace(/^for\s*\(;;\);/, '').trim(); if (!line) continue;
    let frame; try { frame = JSON.parse(line); } catch { malformedFrames++; continue; }
    frameCount++;
    for (const error of Array.isArray(frame.errors) ? frame.errors : []) errors.push({ code: typeof error.code === 'number' ? error.code : null, severity: ['ERROR', 'CRITICAL', 'WARNING'].includes(error.severity) ? error.severity : null });
    if (frame.extensions?.is_final === true) streamFinal = true;
    const node = frame.data?.node;
    const accept = candidate => { const post = normalizeStory(candidate, context); if (post) posts.push(post); else rejectedStories++; };
    if (node?.group_feed) {
      for (const edge of node.group_feed.edges || []) accept(edge.node);
      if (node.group_feed.page_info) pageInfo = node.group_feed.page_info;
    } else if (node?.post_id) {
      const responsePath = frame.path;
      if (!responsePath || Array.isArray(responsePath) && responsePath.includes('group_feed') && responsePath.includes('edges')) accept(node);
      else rejectedStories++;
    }
    if (frame.data?.page_info && Array.isArray(frame.path) && frame.path.includes('group_feed')) pageInfo = frame.data.page_info;
  }
  return { posts, pageInfo, streamFinal, frameCount, malformedFrames, rejectedStories, errors };
}

export function pageStatus(result, requestCursor) {
  if (result.errors.length) return 'response_error';
  if (!result.pageInfo || !result.streamFinal || result.malformedFrames || typeof result.pageInfo.has_next_page !== 'boolean') return 'pagination_incomplete';
  if (result.rejectedStories || new Set(result.posts.map(p => p.post_id)).size !== result.posts.length) return 'story_shape_mismatch';
  if (result.pageInfo.has_next_page && result.posts.length !== PAGE_SIZE) return 'unexpected_story_count';
  if (!result.pageInfo.has_next_page && result.posts.length > PAGE_SIZE) return 'unexpected_story_count';
  if (result.pageInfo.has_next_page && (!result.pageInfo.end_cursor || result.pageInfo.end_cursor === requestCursor)) return 'cursor_not_advanced';
  return 'ok';
}

export function boundaryState(audit, start, requiredPages) {
  const numbered = audit.filter(r => r.kind === 'page' && r.status === 'ok').sort((a, b) => a.page - b.page);
  const transitions = []; let previous = null;
  for (const row of numbered) for (let i = 0; i < row.dates.length; i++) {
    const date = Date.parse(row.dates[i]);
    if (Number.isFinite(date) && previous && date > previous.date) transitions.push({ previous_page: previous.page, previous_id: previous.id, next_page: row.page, next_id: row.ids[i] });
    if (Number.isFinite(date)) previous = { date, page: row.page, id: row.ids[i] };
  }
  const tail = [];
  for (const row of [...numbered].reverse()) {
    if (!row.stream_final || row.count !== PAGE_SIZE || row.dates.length !== PAGE_SIZE
        || !row.dates.every(t => Number.isFinite(Date.parse(t)) && Date.parse(t) < Date.parse(start))) break;
    tail.unshift(row);
  }
  const unique = new Set(tail.slice(-requiredPages).flatMap(row => row.ids)).size;
  const reached = tail.length >= requiredPages && unique >= requiredPages * PAGE_SIZE;
  return { oldPages: tail.length, reached, dateOrderRegressions: transitions.length, transitions,
    reason: reached ? transitions.length ? 'date_boundary_needs_review' : 'date_boundary_reached' : null,
    evidence: tail.slice(-requiredPages).map(r => ({ page: r.page, ids: r.ids, dates: r.dates, stream_final: r.stream_final })) };
}

// Runs in the target page; returns only selected root Story fields, never raw page JSON.
export function readInitialSeedFields({ groupId, groupUrl }) {
  const expected = new URL(groupUrl).pathname.replace(/\/$/, '');
  if (location.hostname.replace(/^www\./, '') !== 'facebook.com' || location.pathname.replace(/\/$/, '') !== expected) return [];
  const found = new Map(); let visited = 0;
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 50 || visited++ > 150000) return;
    const story = value.comet_sections?.content?.story;
    const group = String(value.feedback?.associated_group?.id || story?.target_group?.id || '');
    if (value.__typename === 'Story' && value.post_id && group === groupId) {
      const target = value.comet_sections?.feedback?.story?.story_ufi_container?.story?.feedback_context?.feedback_target_with_context;
      const actions = target?.comet_ufi_summary_and_actions_renderer?.feedback?.adaptive_ufi_action_renderers || [];
      const fb = kind => actions.find(a => a.__typename === kind)?.feedback;
      const attachments = story?.attachments || value.attachments || [], types = new Set();
      function media(x, d = 0) { if (!x || typeof x !== 'object' || d > 7) return; if (typeof x.media?.__typename === 'string') types.add(x.media.__typename); if (Array.isArray(x)) for (const v of x) media(v, d + 1); else for (const k of ['styles', 'attachment', 'all_subattachments', 'subattachments', 'nodes', 'edges', 'node']) media(x[k], d + 1); }
      media(attachments);
      const attached = story?.attached_story || value.attached_story;
      found.set(String(value.post_id), { __typename: 'Story', post_id: String(value.post_id), _seed_fields: {
        group_id: group, creation_time: value.creation_time,
        url: value.permalink_url || value.comet_sections?.timestamp?.story?.url || story?.wwwURL || null,
        body: (story?.message || story?.comet_sections?.message?.story?.message || value.message)?.text ?? '',
        body_known: typeof (story?.message || story?.comet_sections?.message?.story?.message || value.message)?.text === 'string'
          || story?.message === null || story?.comet_sections?.message?.story?.message === null || value.message === null,
        is_shared: !!attached, shared_body: attached?.message?.text ?? null, attachment_count: attachments.length, media_types: [...types],
        shares: fb('XFBUFIAdaptiveShareActionRenderer')?.share_count?.count ?? null,
        reactions: fb('UFIStoryReactActionRenderer')?.reaction_count?.count ?? null,
        comments: fb('UFICommentActionRenderer')?.comment_rendering_instance?.comments?.total_count ?? target?.comment_rendering_instance?.comments?.total_count ?? null } });
      return; // Do not reinterpret this Story's shared story, comments, or attachments as feed entries.
    }
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else for (const [key, child] of Object.entries(value)) if (!['attached_story', 'comments', 'replies', 'actors', 'author', 'attachments', 'message'].includes(key)) visit(child, depth + 1);
  }
  for (const script of document.querySelectorAll('script[type="application/json"]')) { try { visit(JSON.parse(script.textContent)); } catch { /* Non-JSON scripts are irrelevant. */ } }
  return [...found.values()];
}

export function requestTemplate(request, pageUrl, config, expectedGroupId = null) {
  try {
    if (canonicalGroupUrl(pageUrl) !== config.groupUrl) return null;
    const url = new URL(request.url());
    if (url.origin !== new URL(config.groupUrl).origin || !url.pathname.startsWith('/api/graphql')) return null;
    const form = new URLSearchParams(request.postData() || '');
    if (form.get('fb_api_req_friendly_name') !== OPERATION) return null;
    const variables = JSON.parse(form.get('variables') || '{}'), groupId = String(variables.id || '');
    if (!/^\d+$/.test(groupId) || variables.sortingSetting !== 'CHRONOLOGICAL' || variables.count !== PAGE_SIZE) return null;
    const expected = expectedGroupId || config.groupId;
    if (expected && groupId !== expected) return null;
    const slug = new URL(config.groupUrl).pathname.split('/')[2];
    if (/^\d+$/.test(slug) && groupId !== slug) return null;
    return { url: url.href, body: request.postData(), variables, groupId };
  } catch { return null; }
}

function hasCleanPageEvidence(row) {
  const audit = row.audit, posts = row.posts;
  return row.page > 0 && audit?.kind === 'page' && audit.page === row.page && audit.status === row.status
    && audit.stream_final === row.stream_final && audit.has_next === row.has_next && audit.http_status === 200
    && Number.isInteger(audit.frame_count) && audit.frame_count > 0 && audit.malformed_frames === 0
    && audit.rejected_stories === 0 && Array.isArray(audit.errors) && audit.errors.length === 0
    && Array.isArray(posts) && audit.count === posts.length && Array.isArray(audit.ids) && Array.isArray(audit.dates)
    && audit.ids.length === posts.length && audit.dates.length === posts.length
    && posts.every((post, index) => typeof post.post_id === 'string' && /^\d+$/.test(post.post_id)
      && audit.ids[index] === post.post_id && audit.dates[index] === post.published_at)
    && new Set(audit.ids).size === posts.length;
}

function isAdvancingPage(row) {
  return row.status === 'ok' && row.stream_final === true && row.has_next === true
    && typeof row.next_cursor === 'string' && !!row.next_cursor && row.next_cursor !== row.request_cursor
    && (row.page === 0 || hasCleanPageEvidence(row) && row.posts.length === PAGE_SIZE);
}

function retryClassification(row) {
  if (!hasCleanPageEvidence(row) || row.next_cursor !== null) return null;
  if (row.status === 'ok' && row.stream_final === true && row.has_next === false && row.posts.length === 0)
    return 'TERMINAL_RETRY_SUPERSEDED';
  if (row.status === 'pagination_incomplete' && row.stream_final === false && row.has_next === null
      && row.posts.length > 0 && row.posts.length <= PAGE_SIZE) return 'INCOMPLETE_RETRY_SUPERSEDED';
  return null;
}

export function selectActiveHistory(records, checkpoint) {
  const grouped = new Map(), supersededTerminals = [], supersededIncomplete = [];
  for (const record of records) {
    if (!Number.isInteger(record.page) || record.page < 0) throw new Error('Invalid journal page number.');
    if (record.page > checkpoint.pages) continue;
    if (!grouped.has(record.page)) grouped.set(record.page, []);
    grouped.get(record.page).push(record);
  }
  const active = [];
  for (let page = 0; page <= checkpoint.pages; page++) {
    const attempts = grouped.get(page) || [];
    const advancing = attempts.filter(isAdvancingPage);
    if (advancing.length !== 1) throw new Error('Checkpoint history is discontinuous or repeats a successful page.');
    const winner = advancing[0], position = attempts.indexOf(winner);
    for (let i = 0; i < attempts.length; i++) {
      const old = attempts[i]; if (old === winner) continue;
      if (i > position || old.request_cursor !== winner.request_cursor) throw new Error('Checkpoint contains a conflicting retry lineage.');
      const classification = retryClassification(old);
      if (!classification) throw new Error('Only an evidenced empty terminal or ordinary incomplete response may be superseded.');
      const entry = { page, old_ids: old.audit.ids, new_ids: winner.audit.ids, classification };
      (classification === 'TERMINAL_RETRY_SUPERSEDED' ? supersededTerminals : supersededIncomplete).push(entry);
    }
    if (page && winner.request_cursor !== active.at(-1).next_cursor) throw new Error('Checkpoint history is discontinuous.');
    active.push(winner);
  }
  if (active.at(-1)?.next_cursor !== checkpoint.cursor) throw new Error('Checkpoint history is discontinuous.');
  return { active, supersededTerminals, supersededIncomplete };
}

export async function loadResumeState(config) {
  const posts = new Map();
  if (!config.resumeCheckpointPath) {
    if (await exists(path.join(config.outputDir, 'pagination-checkpoint.json')) || await exists(path.join(config.outputDir, 'posts.json')))
      throw new Error('Output already contains a collection. Specify resumeCheckpointPath or a new outputDir.');
    return { posts, audit: [], checkpoint: null, scope: null, supersededTerminals: [], supersededIncomplete: [], initialEvidence: null, bootstrapDates: [] };
  }
  let checkpoint;
  try { checkpoint = await readJson(config.resumeCheckpointPath); } catch { throw new Error('Requested checkpoint is missing or unreadable; refusing to restart from the beginning.'); }
  const scope = checkpointScope(config, config.groupId || checkpoint.group_id);
  assertScope(checkpoint, scope, 'Resume');
  if (checkpoint.schema_version !== SCHEMA_VERSION || !Number.isInteger(checkpoint.pages) || checkpoint.pages < 0
      || checkpoint.next_page !== checkpoint.pages + 1 || typeof checkpoint.cursor !== 'string' || !checkpoint.cursor
      || !Array.isArray(checkpoint.history_files) || !checkpoint.history_files.length || !path.isAbsolute(checkpoint.source_file || ''))
    throw new Error('Checkpoint lacks a usable cursor, history chain, or source snapshot.');
  const prior = await readJson(checkpoint.source_file); assertScope(prior.metadata, scope, 'Previous posts');
  const records = [];
  for (const file of checkpoint.history_files) {
    if (!path.isAbsolute(file)) throw new Error('History paths must remain absolute and available.');
    const lines = (await fs.readFile(file, 'utf8')).split('\n');
    if (lines.at(-1) !== '') lines.pop(); // A torn tail cannot have advanced the fsynced checkpoint.
    for (const line of lines) if (line.trim()) { const row = JSON.parse(line); assertScope(row, scope, 'History'); records.push(row); }
  }
  if (records.some(row => row.page > checkpoint.pages && row.status === 'ok' && row.stream_final === true && row.has_next === true))
    throw new Error('Journal advanced beyond this checkpoint. Use the newest verified last-usable continuation; refusing to replay an already recorded successful page.');
  const { active: selected, supersededTerminals, supersededIncomplete } = selectActiveHistory(records, checkpoint);
  for (const row of records.filter(record => record.page > checkpoint.pages)) {
    if (row.page !== checkpoint.next_page || row.request_cursor !== checkpoint.cursor || !retryClassification(row))
      throw new Error('Uncommitted history requires review before retry; only the same-boundary ordinary incomplete response or empty terminal is resumable.');
  }
  // Rebuild from committed successful observations. Failed attempts stay in their
  // original journals and cannot supply IDs, text, counts, or fallback fields.
  for (const row of selected) for (const post of row.posts || []) mergePost(posts, post);
  const audit = selected.filter(row => row.page > 0).map(row => row.audit);
  if (audit.some(row => !row || row.status !== 'ok' || row.stream_final !== true)) throw new Error('Checkpoint history has incomplete audit evidence.');
  return { posts, audit, checkpoint, scope, supersededTerminals, supersededIncomplete,
    bootstrapDates: (selected[0]?.posts || []).map(post => post.published_at).filter(Boolean), initialEvidence: {
    seedScanSucceeded: prior.metadata.initial_seed_scan_succeeded === true,
    seedCount: prior.metadata.initial_page_seed_count || 0,
    responsesAccepted: prior.metadata.initial_pagination_responses_accepted || 0
  } };
}

export async function createCheckpointStore(directory, scope, prior, requiredBoundaryPages = scope.required_boundary_pages) {
  if (requiredBoundaryPages !== scope.required_boundary_pages) throw new Error('Checkpoint boundary strategy mismatch.');
  await fs.mkdir(directory, { recursive: true });
  const historyFile = path.resolve(directory, `pagination-history-${Date.now()}-${randomUUID()}.jsonl`);
  const first = await fs.open(historyFile, 'wx'); await first.sync(); await first.close();
  const historyFiles = [...new Set([...(prior?.history_files || []), historyFile])];
  let usable = prior ? { ...prior, history_files: historyFiles, source_file: path.resolve(directory, 'posts.json') } : null;
  async function persist() {
    if (!usable) return;
    await atomicJson(path.join(directory, 'last-usable-continuation.json'), usable);
    await atomicJson(path.join(directory, 'pagination-checkpoint.json'), usable);
  }
  await persist();
  return {
    get usable() { return usable; },
    async record(record) {
      const row = { schema_version: SCHEMA_VERSION, ...scope, ...record };
      const handle = await fs.open(historyFile, 'a');
      try { await handle.writeFile(JSON.stringify(row) + '\n'); await handle.sync(); } finally { await handle.close(); }
      if (record.status === 'ok' && record.stream_final === true && record.has_next === true
          && typeof record.next_cursor === 'string' && record.next_cursor && record.next_cursor !== record.request_cursor) {
        usable = { schema_version: SCHEMA_VERSION, ...scope, cursor: record.next_cursor, pages: record.page, next_page: record.page + 1,
          boundary_pages: record.old_pages_after || 0, required_boundary_pages: requiredBoundaryPages,
          history_files: historyFiles, source_file: path.resolve(directory, 'posts.json'), audit_file: path.resolve(directory, 'crawl-audit.json'), updated_at: now() };
        await persist();
      }
      await this.finish(record.status, record.page, record.has_next);
    },
    async finish(status, page, hasNext) {
      await atomicJson(path.join(directory, 'pagination-state.json'), { schema_version: SCHEMA_VERSION, ...scope, page, status,
        has_next: hasNext, required_boundary_pages: requiredBoundaryPages, history_files: historyFiles,
        last_usable_page: usable?.pages ?? null, updated_at: now() });
    }
  };
}

export async function run({ page, input, outputDir: taskOutputDir, progress = async () => {}, signal = { aborted: false } }) {
  const config = normalizeInput(input), resumed = await loadResumeState(config);
  const directory = config.outputDir, posts = resumed.posts, audit = resumed.audit, pending = new Set();
  await fs.mkdir(directory, { recursive: true });
  let groupId = resumed.scope?.group_id || config.groupId, scope = resumed.scope, template = null, capturing = true, bootstrapRequest = null;
  let cursor = null, hasNext = null, pages = resumed.checkpoint?.pages || 0, reason = 'running', store = null, initError = null;
  const startingPage = pages, started = now();
  let seedScanSucceeded = resumed.initialEvidence?.seedScanSucceeded || false,
    seedCount = resumed.initialEvidence?.seedCount || 0,
    initialResponsesAccepted = resumed.initialEvidence?.responsesAccepted || 0;
  let bootstrapDates = resumed.bootstrapDates;
  const context = source => ({ groupId, groupUrl: config.groupUrl, source });
  const onRequest = request => {
    if (!capturing || template) return; // Freeze one request: response completion order cannot move the bootstrap cursor.
    const candidate = requestTemplate(request, page.url(), config, groupId);
    if (candidate) { template = candidate; bootstrapRequest = request; groupId = candidate.groupId; }
  };
  const onResponse = response => {
    if (!capturing || response.request() !== bootstrapRequest) return;
    const candidate = template; if (!candidate) return;
    const job = (async () => {
      try {
        const result = parseFeedResponse(await response.text(), { ...context('browser_feed_response'), groupId: candidate.groupId });
        const status = pageStatus(result, candidate.variables.cursor);
        if (status !== 'ok') { initError = status; return; }
        groupId = candidate.groupId;
        // A resumed run uses initialization only for fresh authentication/context.
        // Its head-of-feed observations must not enter the dataset without a journal page.
        if (!resumed.checkpoint) {
          for (const post of result.posts) mergePost(posts, post);
          initialResponsesAccepted = 1;
        }
        cursor = result.pageInfo.end_cursor; hasNext = result.pageInfo.has_next_page;
      } catch { initError = 'initial_response_unreadable'; }
    })();
    pending.add(job); job.finally(() => pending.delete(job));
  };
  const boundary = () => boundaryState(audit, config.startTime, config.boundaryPages);
  async function save(finished) {
    const values = [...posts.values()], inRange = post => post.published_at && Date.parse(post.published_at) >= Date.parse(config.startTime) && Date.parse(post.published_at) <= Date.parse(config.endTime);
    const evidence = boundary(), goodRows = audit.filter(row => row.kind === 'page' && row.status === 'ok').sort((a, b) => a.page - b.page);
    const continuous = goodRows.length === pages && goodRows.every((row, index) => row.page === index + 1 && row.stream_final === true);
    const currentDates = (goodRows.length ? goodRows.at(-1).dates : bootstrapDates).map(Date.parse).filter(Number.isFinite);
    const currentPageEarliest = currentDates.length ? new Date(Math.min(...currentDates)).toISOString() : null;
    const metadata = { ...(scope || { group_url: config.groupUrl, group_id: groupId, start: config.startTime, end: config.endTime }),
      timestamp_storage: 'UTC', timezone: config.timezone, input_start_time: config.startTime, input_end_time: config.endTime, collection_started: started, collected_at: now(),
      coverage_status: reason, finished, coverage_complete: false, boundary_verified: evidence.reached && continuous,
      completeness_note: 'A consecutive-old-page stop is evidence about this account-visible traversal, not a proof of all platform posts. Independent audit is required.',
      continuity_verified: continuous, resumed_from_page: resumed.checkpoint ? startingPage + 1 : null, feed_pages: pages,
      current_page_earliest: currentPageEarliest,
      in_range_count: values.filter(inRange).length, unknown_date_count: values.filter(post => !post.published_at).length,
      outside_range_count: values.filter(post => post.published_at && !inRange(post)).length, discovered_count: values.length,
      has_next_page: hasNext, boundary_pages: evidence.oldPages, required_boundary_pages: config.boundaryPages,
      date_order_regressions: evidence.dateOrderRegressions, date_order_observations: evidence.transitions,
      boundary_evidence: evidence.evidence, initial_page_seed_count: seedCount, initial_seed_scan_succeeded: seedScanSucceeded,
      initial_pagination_responses_accepted: initialResponsesAccepted,
      initial_evidence_origin: resumed.checkpoint ? 'retained_checkpoint_bootstrap' : 'current_initial_page',
      superseded_terminal_attempts: resumed.supersededTerminals,
      superseded_incomplete_attempts: resumed.supersededIncomplete,
      review_required: evidence.dateOrderRegressions > 0 || !seedScanSucceeded || values.some(post => post.field_issues?.length || ['shares', 'reactions', 'comments'].some(key => post[key] === null)),
      count_definition: 'reactions includes all reaction types; null means unavailable and differs from an explicit zero. count_observed_at preserves per-metric observation times.' };
    const value = { metadata, posts: values.filter(inRange), undated_posts: values.filter(post => !post.published_at), outside_range_posts: values.filter(post => post.published_at && !inRange(post)) };
    await atomicJson(path.join(directory, 'posts.json'), value); await atomicJson(path.join(directory, 'crawl-audit.json'), audit);
    if (taskOutputDir && path.resolve(taskOutputDir) !== directory) await atomicJson(path.join(taskOutputDir, 'posts.json'), value);
    await progress({ current: pages - startingPage, total: config.maxPages, message: `Batch ${pages - startingPage}/${config.maxPages} pages; cumulative ${pages}; saved ${metadata.in_range_count} in-range posts.` });
  }
  page.on('request', onRequest); page.on('response', onResponse);
  try {
    const target = new URL(config.groupUrl); target.searchParams.set('sorting_setting', 'CHRONOLOGICAL');
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.body?.innerText.length > 100, null, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(3000);
    for (let attempt = 0; attempt < 12 && (!template || (!resumed.checkpoint && cursor === null && hasNext !== false)); attempt++) {
      if (signal.aborted) { reason = 'stopped'; break; }
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(1500);
    }
    await Promise.allSettled([...pending]); capturing = false;
    if (canonicalGroupUrl(page.url()) !== config.groupUrl) throw new Error('Target page context changed; refusing to use a pagination request from another context.');
    if (reason !== 'stopped' && (initError || !template || !groupId || (!resumed.checkpoint && cursor === null && hasNext !== false))) {
      reason = 'initialization_failed';
      await atomicJson(path.join(directory, 'initialization-diagnostic.json'), { at: now(), reason, request_captured: !!template,
        cursor_present: !!cursor, expected_context_verified: true, response_status: initError, resuming: !!resumed.checkpoint });
      throw new Error('No complete target-group pagination request/response was captured. No checkpoint was replaced.');
    }
    if (groupId) scope = checkpointScope(config, groupId);
    if (resumed.scope) assertScope(scope, resumed.scope, 'Current page');
    if (groupId && !resumed.checkpoint) {
      let seeds = [];
      try { seeds = await page.evaluate(readInitialSeedFields, { groupId, groupUrl: config.groupUrl }); seedScanSucceeded = true; } catch {}
      for (const candidate of seeds) { const post = normalizeStory(candidate, context('initial_page_seed')); if (post) { mergePost(posts, post); seedCount++; } }
    }
    if (!resumed.checkpoint) bootstrapDates = [...posts.values()].map(post => post.published_at).filter(Boolean);
    if (resumed.checkpoint) { cursor = resumed.checkpoint.cursor; hasNext = true; }
    await save(false);
    if (reason === 'stopped' && resumed.checkpoint) store = await createCheckpointStore(directory, scope, resumed.checkpoint, config.boundaryPages);
    if (reason !== 'stopped') {
      store = await createCheckpointStore(directory, scope, resumed.checkpoint, config.boundaryPages);
      if (!resumed.checkpoint) await store.record({ page: 0, at: now(), request_cursor: template.variables.cursor ?? null, next_cursor: cursor, has_next: hasNext,
        stream_final: true, status: 'ok', old_pages_after: 0, posts: [...posts.values()] });
      for (let batchPage = 0; batchPage < config.maxPages; batchPage++) {
        if (signal.aborted) { reason = 'stopped'; break; }
        const stop = boundary(); if (stop.reached) { reason = stop.reason; break; }
        if (hasNext === false) { reason = 'feed_end'; break; }
        const requestCursor = cursor, nextPage = pages + 1, oldBefore = stop.oldPages;
        const body = new URLSearchParams(template.body); body.set('variables', JSON.stringify({ ...template.variables, count: PAGE_SIZE, cursor: requestCursor }));
        let response;
        try {
          response = await page.evaluate(async args => {
            const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 45000);
            try { const result = await fetch(args.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': args.name }, body: args.body, credentials: 'include', signal: abort.signal }); return { status: result.status, text: await result.text() }; }
            catch { return { status: 0, text: '' }; } finally { clearTimeout(timer); }
          }, { url: template.url, body: body.toString(), name: OPERATION });
        } catch { response = { status: 0, text: '' }; }
        const result = response.status === 200 ? parseFeedResponse(response.text, context('browser_authenticated_pagination')) : null;
        const status = result ? pageStatus(result, requestCursor) : 'http_error';
        const row = { kind: 'page', page: nextPage, at: now(), status, http_status: response.status,
          ids: result?.posts.map(post => post.post_id) || [], dates: result?.posts.map(post => post.published_at) || [],
          count: result?.posts.length || 0, has_next: result?.pageInfo?.has_next_page ?? null,
          stream_final: result?.streamFinal ?? false, frame_count: result?.frameCount ?? 0,
          malformed_frames: result?.malformedFrames ?? 0, rejected_stories: result?.rejectedStories ?? 0, errors: result?.errors || [] };
        audit.push(row); if (status === 'ok') for (const post of result.posts) mergePost(posts, post);
        if (status === 'ok') { pages = nextPage; cursor = result.pageInfo.end_cursor; hasNext = result.pageInfo.has_next_page; }
        await store.record({ page: nextPage, at: row.at, request_cursor: requestCursor, next_cursor: result?.pageInfo?.end_cursor ?? null,
          has_next: row.has_next, stream_final: row.stream_final, status, old_pages_before: oldBefore, old_pages_after: boundary().oldPages,
          posts: result?.posts || [], audit: row });
        if (status !== 'ok') { reason = status; break; }
        const reached = boundary(); if (reached.reached) { reason = reached.reason; break; }
        if (hasNext === false) { reason = 'feed_end'; break; }
        if (batchPage % 10 === 0) await save(false);
        await page.waitForTimeout(config.paceMs);
      }
    }
    if (reason === 'running') reason = 'page_limit';
    await save(true); if (store) await store.finish(reason, pages, hasNext);
    return { processed: [...posts.values()].filter(post => post.published_at && Date.parse(post.published_at) >= Date.parse(config.startTime) && Date.parse(post.published_at) <= Date.parse(config.endTime)).length,
      reason, pages, batchPages: pages - startingPage, files: ['posts.json'] };
  } catch (error) {
    if (reason === 'running') reason = 'execution_error';
    // Keep previous checkpoint intact even if a final aggregate snapshot cannot be written.
    try { await atomicJson(path.join(directory, 'run-error.json'), { at: now(), reason, cumulative_pages: pages, filesystem_code: ['EPERM', 'EBUSY', 'EACCES', 'ENOSPC'].includes(error.code) ? error.code : null }); } catch {}
    try { await save(true); } catch {}
    if (store) try { await store.finish(reason, pages, hasNext); } catch {}
    throw error;
  } finally { capturing = false; template = null; bootstrapRequest = null; page.off('request', onRequest); page.off('response', onResponse); }
}
