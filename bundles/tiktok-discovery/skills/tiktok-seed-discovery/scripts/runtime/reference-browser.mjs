// Self-contained Task Master task. No sibling imports; no direct API requests.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const VERSION = 'tiktok-reference-browser-v2';
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const safeId = value => typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : null;
const account = value => clean(value).replace(/^@/, '').toLowerCase();
const writeJson = async (file, value) => { await fs.writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); await fs.rename(file + '.tmp', file); };
export function parseListing(data, expectedHandle) {
  const raw = data.itemList ?? data.item_list ?? data.data?.itemList ?? data.data?.item_list;
  if (!Array.isArray(raw)) return null;
  const items = [], rejected = [];
  for (const item of raw) {
    const id = safeId(item.id), owner = account(item.author?.uniqueId);
    if (!id || !/^\d+$/.test(id) || owner !== account(expectedHandle) || typeof item.desc !== 'string') { rejected.push('item_identity_or_caption_unverified'); continue; }
    const type = item.imagePost ? 'photo' : 'video';
    items.push({ id, authorHandle: owner, url: `https://www.tiktok.com/@${owner}/${type}/${id}`, caption: item.desc,
      createTime: Number.isFinite(item.createTime) && item.createTime > 0 ? item.createTime : null,
      contentType: type, pinned: typeof item.isPinned === 'boolean' ? item.isPinned : null,
      author: { platformId: safeId(item.author.id), handle: owner, displayName: item.author.nickname ?? null, bio: item.author.signature ?? null },
      stats: Object.fromEntries(['diggCount', 'commentCount', 'playCount', 'shareCount', 'collectCount'].filter(key => Number.isFinite(item.stats?.[key]) && item.stats[key] >= 0).map(key => [key, item.stats[key]])),
      textExtra: (item.textExtra ?? []).map(tag => ({ hashtagName: tag.hashtagName ?? null, userUniqueId: tag.userUniqueId ?? null })),
      music: item.music?.id ? { id: safeId(item.music.id), title: item.music.title ?? null, authorName: item.music.authorName ?? null } : null });
  }
  const code = data.status_code ?? data.statusCode ?? null;
  const more = data.hasMore ?? data.has_more;
  return { items, rejectedItems: rejected.length, rawCount: raw.length, businessStatusCode: code, hasMore: more === false || more === 0 ? false : more === true || more === 1 ? true : null, nextCursor: safeId(data.cursor ?? data.maxCursor) };
}
export function assessCoverage({ pages, posts, identityVerified, stopReason, window }) {
  const from = Date.parse(window.start) / 1000, until = Date.parse(window.end) / 1000;
  const inWindow = posts.filter(post => post.createTime !== null && post.createTime >= from && post.createTime <= until);
  const unknownDate = posts.filter(post => !Number.isFinite(post.createTime));
  const chain = pages.filter(page => page.identityVerified && page.businessStatusCode === 0 && page.rejectedItems === 0);
  let cursor = '0', exhausted = false;
  const visited = new Set();
  while (!visited.has(cursor)) {
    visited.add(cursor);
    const page = chain.find(value => value.requestCursor === cursor);
    if (!page) break;
    if (page.hasMore === false) { exhausted = true; break; }
    if (page.hasMore !== true || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const interruption = !['native_list_exhausted', 'no_new_posts', 'scroll_budget'].includes(stopReason);
  const enumerationComplete = identityVerified && exhausted && !interruption;
  return { status: enumerationComplete && !unknownDate.length ? 'complete_visible_public_window' : 'partial',
    scope: 'public_posts_visible_to_this_profile_at_observation_time', identityVerified, enumerationComplete,
    paginationChainFromHeadComplete: exhausted, knownPosts: posts.length, inWindow: inWindow.length,
    outsideWindow: posts.length - inWindow.length - unknownDate.length, unknownDate: unknownDate.length,
    earliestObserved: posts.filter(post => Number.isFinite(post.createTime)).reduce((min, post) => min === null ? post.createTime : Math.min(min, post.createTime), null),
    stopReason, reason: !identityVerified ? 'profile_identity_unverified' : !exhausted ? 'native_cursor_chain_to_list_end_not_proven' : unknownDate.length ? 'undated_posts_prevent_full_window_assignment' : interruption ? 'collection_interrupted' : 'visible_public_list_exhausted_with_dates',
    window, note: 'Pinned items never prove date order. Stalled scrolling and old posts are not evidence of full coverage.' };
}
function readSurface() {
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const text = (document.body?.innerText ?? '').slice(0, 40000);
  const fields = [...document.querySelectorAll('[data-e2e]')].filter(el => visible(el) && /^(user-title|user-subtitle|user-unique-id|user-bio|followers-count|following-count|likes-count)$/.test(el.getAttribute('data-e2e'))).map(el => ({ field: el.getAttribute('data-e2e'), text: el.innerText }));
  const links = [...document.querySelectorAll('main a[href], [data-e2e="user-post-item"] a[href]')].filter(visible).map(el => ({ url: el.href, text: el.innerText || el.getAttribute('aria-label') || '' })).filter(link => /\/@[^/]+\/(video|photo)\/\d+/.test(link.url));
  const caption = document.querySelector('[data-e2e="video-desc"]')?.innerText ?? null;
  return { url: location.href, text, fields, links, anchorCaption: caption,
    verification: !![...document.querySelectorAll('iframe, [role="dialog"]')].filter(visible).find(el => /captcha|verify|verification|puzzle/i.test((el.getAttribute('src') ?? '') + ' ' + (el.getAttribute('title') ?? '') + ' ' + (el.innerText ?? ''))) };
}
function scrollProfile() {
  const link = document.querySelector('main a[href*="/video/"],main a[href*="/photo/"]');
  let node = link?.parentElement;
  while (node && !(/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight)) node = node.parentElement;
  node ??= document.scrollingElement ?? document.documentElement;
  const before = node.scrollTop;
  node.scrollTop = Math.min(node.scrollHeight, before + Math.max(400, node.clientHeight * 0.9));
  return { before, after: node.scrollTop };
}
export async function run({ page, input, outputDir, progress, wait, signal }) {
  if (!input.briefId || !Array.isArray(input.references) || !input.window?.start || !input.window?.end) throw Error('Invalid reference input');
  const limits = input.limits;
  if (!limits || !Number.isSafeInteger(limits.maxPostsPerReference) || limits.maxPostsPerReference < 1) throw Error('Bounded reference limits required');
  await fs.mkdir(outputDir, { recursive: true });
  const startedAt = new Date().toISOString(), startedMs = Date.now();
  const corpus = { schemaVersion: VERSION, briefId: input.briefId, startedAt, window: input.window, references: [], status: 'running' };
  const eventFile = path.join(outputDir, 'reference-events.jsonl');
  const requestContexts = new WeakMap(), pending = new Set();
  const profileCache = new Map();
  let current = null, fatal = null, writes = Promise.resolve();
  const event = (type, data) => { writes = writes.then(() => fs.appendFile(eventFile, JSON.stringify({ type, at: new Date().toISOString(), data }) + '\n')); return writes; };
  const save = async () => { await Promise.all([...pending]); await writes; await writeJson(path.join(outputDir, 'reference-corpus.json'), corpus); };
  async function guard() {
    if (signal?.aborted) throw Error('CANCELLED');
    if (Date.now() - startedMs > limits.maxWallMs) throw Error('WALL_BUDGET');
    let control = {};
    if (input.controlFile) {
      try { control = JSON.parse((await fs.readFile(input.controlFile, 'utf8')).replace(/^\uFEFF/, '')); } catch (error) { throw Error(`CONTROL_FILE_UNREADABLE:${error.code ?? error.message}`); }
    }
    if (/paused|cooling|stopped|cancelled/.test(control.status ?? '')) throw Error('USER_PAUSED');
    for (const value of [input.notBefore, control.notBefore].filter(Boolean)) {
      if (!Number.isFinite(Date.parse(value))) throw Error('INVALID_COOLDOWN');
      if (Date.now() < Date.parse(value)) throw Error('COOLDOWN_ACTIVE');
    }
    if (fatal) throw Error(fatal);
  }
  async function surface() {
    await guard();
    const view = await page.evaluate(readSurface);
    const challenge = view.verification || /complete the puzzle|drag the slider|verify to continue|拼图.*滑块|完成安全验证/i.test(view.text);
    const login = /log in to (?:search|continue)|登录以搜索|login required/i.test(view.text);
    if (challenge || login) {
      await event('waiting_user', { referenceId: current?.id, reason: challenge ? 'verification' : 'login_required' });
      await save();
      await progress({ message: '参考采集已保存，等待用户完成验证或登录。' });
      await wait({ reason: challenge ? 'verification' : 'login_required' });
      return surface();
    }
    if (/too many requests|too many attempts|Access Denied|操作太频繁|访问过于频繁/i.test(view.text)) throw Error('ACCESS_LIMIT');
    return view;
  }
  const onRequest = request => {
    if (!current?.owner || current.phase !== 'profile') return;
    try {
      const url = new URL(request.url());
      if (!/(^|\.)tiktok\.com$/.test(url.hostname) || !/^\/api\/post\/item_list\/?$/.test(url.pathname)) return;
      requestContexts.set(request, { record: current, requestCursor: url.searchParams.get('cursor') ?? url.searchParams.get('maxCursor') ?? null, endpoint: url.pathname });
    } catch {}
  };
  const onResponse = response => {
    const context = requestContexts.get(response.request());
    if (!context || context.record.phase !== 'profile' || !context.record.pendingListings) return;
    const job = (async () => {
      if ([403, 429].includes(response.status())) { fatal = 'ACCESS_LIMIT'; await event('http_limit', { referenceId: context.record.id, status: response.status() }); return; }
      if (response.status() < 200 || response.status() >= 300) { fatal = 'REFERENCE_HTTP_ERROR_' + response.status(); await event('http_error', { referenceId: context.record.id, status: response.status() }); return; }
      if (!(response.headers()['content-type'] ?? '').includes('json')) return;
      let data, timer;
      try { data = await Promise.race([response.json(), new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]); } catch { return; } finally { clearTimeout(timer); }
      if (!data) { await event('response_unreadable', { referenceId: context.record.id }); return; }
      const code = data.status_code ?? data.statusCode;
      if (code !== undefined && code !== 0) { fatal = `REFERENCE_NATIVE_ERROR_${String(code).slice(0, 30)}`; await event('business_error', { referenceId: context.record.id, code }); return; }
      const listing = parseListing(data, context.record.owner);
      if (!listing) return;
      const pageRecord = { ...listing, items: undefined, requestCursor: context.requestCursor, endpoint: context.endpoint, observedAt: new Date().toISOString(), identityVerified: false };
      if (context.record.phase === 'profile' && context.record.pendingListings) context.record.pendingListings.push({ listing, pageRecord });
    })();
    pending.add(job);
    job.then(() => pending.delete(job), error => { fatal = `RESPONSE_PROCESSING_FAILED:${error.message}`; pending.delete(job); });
  };
  function absorb(record) {
    if (!record.identityVerified) return;
    for (const { listing, pageRecord } of record.pendingListings.splice(0)) {
      pageRecord.identityVerified = true;
      record.pages.push(pageRecord);
      for (const item of listing.items) {
        if (!record.posts.some(post => post.id === item.id)) {
          if (record.posts.length >= limits.maxPostsPerReference) { record.truncated = true; continue; }
          record.posts.push({ ...item, evidence: { referenceId: record.id, sourceUrl: record.profileUrl, endpoint: pageRecord.endpoint, requestCursor: pageRecord.requestCursor, observedAt: pageRecord.observedAt, scope: 'normal_profile_post_list_response_exact_author_with_rendered_profile_identity' } });
        }
      }
    }
  }
  page.on('request', onRequest); page.on('response', onResponse);
  try {
    await guard();
    for (const ref of input.references) {
      current = { ...ref, phase: 'resolve', identityVerified: false, posts: [], pages: [], pendingListings: [], anchor: null, coverage: { status: 'unstarted' } };
      corpus.references.push(current);
      const url = new URL(ref.url);
      if (!/(^|\.)tiktok\.com$/.test(url.hostname)) { current.coverage = { status: 'unresolved_reference', reason: 'Agent must map external reference to an evidenced TikTok URL' }; continue; }
      let stopReason = 'scroll_budget';
      try {
        await guard();
        await page.goto(ref.url, { waitUntil: 'domcontentloaded', timeout: limits.pageWaitMs });
        await page.waitForTimeout(500);
        const first = await surface(), resolved = new URL(first.url), match = resolved.pathname.match(/^\/@([\w.]+)(?:\/(?:video|photo)\/(\d+))?\/?$/);
        if (!/(^|\.)tiktok\.com$/.test(resolved.hostname) || !match) throw Error('REFERENCE_OWNER_NOT_RESOLVED');
        current.owner = account(match[1]); current.profileUrl = `https://www.tiktok.com/@${current.owner}`;
        if (match[2]) current.anchor = { id: match[2], url: `https://www.tiktok.com${resolved.pathname}`, caption: first.anchorCaption, observedAt: new Date().toISOString(), scope: 'user_supplied_reference_work_visible_caption', visualStyleVerified: false };
        const cached = profileCache.get(current.owner);
        if (cached) {
          current.identityVerified = cached.identityVerified;
          current.profile = structuredClone(cached.profile);
          current.posts = structuredClone(cached.posts);
          current.pages = structuredClone(cached.pages);
          current.coverage = structuredClone(cached.coverage);
          current.timelineSourceReferenceId = cached.id;
          current.phase = 'done'; delete current.pendingListings;
          await event('reference_timeline_reused', { referenceId: ref.id, sourceReferenceId: cached.id, owner: current.owner });
          await save();
          continue;
        }
        current.phase = 'profile';
        // Reload profile even for profile references, so the head request is bound to its owner.
        await guard(); await page.goto(current.profileUrl, { waitUntil: 'domcontentloaded', timeout: limits.pageWaitMs });
        await page.waitForFunction(() => document.querySelector('[data-e2e="user-title"],[data-e2e="user-subtitle"],[data-e2e="user-unique-id"]'), null, { timeout: limits.pageWaitMs }).catch(() => {});
        let unchanged = 0, previousCount = -1;
        for (let scroll = 0; scroll <= limits.maxScrollsPerReference; scroll++) {
          const view = await surface();
          const onProfile = new URL(view.url).pathname.replace(/\/$/, '') === `/@${current.owner}`;
          current.identityVerified = onProfile && view.fields.some(field => ['user-title', 'user-subtitle', 'user-unique-id'].includes(field.field) && account(field.text) === current.owner);
          if (!current.identityVerified) throw Error('PROFILE_IDENTITY_UNVERIFIED');
          current.profile = { url: current.profileUrl, fields: view.fields, observedAt: new Date().toISOString() };
          await Promise.all([...pending]); absorb(current);
          if (current.truncated) { stopReason = 'post_budget'; break; }
          if (current.pages.some(value => value.hasMore === false && value.businessStatusCode === 0)) { stopReason = 'native_list_exhausted'; break; }
          const count = current.posts.length;
          unchanged = count === previousCount ? unchanged + 1 : 0; previousCount = count;
          current.coverage = assessCoverage({ ...current, stopReason: 'scroll_budget', window: input.window });
          await save();
          if (scroll % 10 === 0) await progress({ current: corpus.references.length - 1, total: input.references.length, message: `参考 ${current.id} 已读取 ${count} 条贴文；正在核对时间窗口与分页覆盖。` });
          if (unchanged >= limits.noNewScrollLimit) { stopReason = current.pages.length ? 'no_new_posts' : 'profile_post_list_not_observed'; break; }
          if (scroll === limits.maxScrollsPerReference) break;
          await guard(); await page.evaluate(scrollProfile); await page.waitForTimeout(limits.scrollWaitMs);
        }
      } catch (error) { stopReason = error.message; if (/ACCESS_LIMIT|NATIVE_ERROR|USER_PAUSED|COOLDOWN|CANCELLED|WALL_BUDGET|CONTROL_FILE/.test(stopReason)) fatal = stopReason; }
      await Promise.all([...pending]); absorb(current);
      stopReason = fatal ?? stopReason;
      current.coverage = assessCoverage({ ...current, stopReason, window: input.window });
      current.phase = 'done';
      delete current.pendingListings;
      if (current.identityVerified && !fatal) profileCache.set(current.owner, structuredClone(current));
      await event('reference_done', { referenceId: ref.id, posts: current.posts.length, coverage: current.coverage });
      await save();
      await progress({ current: corpus.references.length, total: input.references.length, message: `参考 ${corpus.references.length}/${input.references.length}：${current.posts.length} 条公开贴文，覆盖 ${current.coverage.status}` });
      if (fatal) break;
    }
  } catch (error) { fatal = error.message; }
  finally {
    page.off('request', onRequest); page.off('response', onResponse);
    await Promise.all([...pending]);
    if (current?.pendingListings) { absorb(current); delete current.pendingListings; }
    corpus.finishedAt = new Date().toISOString(); corpus.wallMs = Date.now() - startedMs;
    corpus.status = fatal ? 'partial' : 'bounded_references_complete'; corpus.stopReason = fatal;
    corpus.uniquePosts = new Set(corpus.references.flatMap(ref => ref.posts.map(post => post.id))).size;
    corpus.uniqueCreators = new Set(corpus.references.map(ref => ref.owner).filter(Boolean)).size;
    corpus.unstartedReferences = input.references.filter(ref => !corpus.references.some(record => record.id === ref.id)).map(ref => ref.id);
    corpus.executedCodeSha256 = createHash('sha256').update(await fs.readFile(new URL(import.meta.url))).digest('hex');
    await save();
  }
  return { status: corpus.status, references: corpus.references.length, unstartedReferences: corpus.unstartedReferences, posts: corpus.uniquePosts, postObservations: corpus.references.reduce((sum, ref) => sum + ref.posts.length, 0), uniqueCreators: corpus.uniqueCreators, fullyCoveredReferences: corpus.references.filter(ref => ref.coverage?.status === 'complete_visible_public_window').length, wallMs: corpus.wallMs, stopReason: fatal };
}
