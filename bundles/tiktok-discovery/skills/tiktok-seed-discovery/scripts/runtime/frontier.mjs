// Compile a bounded next-round input from verified observations and quoted review.
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizeRuntimeConfig, isMain } from './environment.mjs';
import { VERSION, norm, actionKey, digest, readJson, writeJson, cliConfig, validateReviews, followerBounds } from './process.mjs';

export function routeCategory(action) {
  if (action.route === 'profile_suggested_accounts') return 'profile_recommendation';
  if (['hashtag_page', 'hashtag_query'].includes(action.route) || action.kind === 'collection' && /\/tag\//.test(action.url)) return 'hashtag';
  if (action.route === 'bio_identity_location_query') return 'identity_location';
  if (action.route === 'scene_query') return 'scenario';
  if (action.route === 'brand_query') return 'brand_product';
  return null;
}
export async function loadPolicySnapshot(file, readBytes = readFile) {
  const { validatePolicy } = await import('../../../tiktok-discovery-retrospective/scripts/retrospect.mjs');
  const bytes = await readBytes(file);
  const policy = validatePolicy(JSON.parse(bytes.toString('utf8')));
  return { policy, metadata: { version: policy.version, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
export async function frontierConfig(config) {
  config = normalizeRuntimeConfig(config);
  if (!config.canonicalPath || !config.outPath || !Number.isInteger(config.round) || config.round < 1) throw Error('canonicalPath, outPath and positive integer round required');
  const canonical = await readJson(config.canonicalPath);
  if (canonical.schemaVersion !== VERSION) throw Error('Unsupported canonical schema');
  const { minimum, maximum } = followerBounds(canonical.brief);
  const maxSeeds = config.maxSeeds ?? 12, maxActions = config.maxActionsPerSeed ?? 5;
  if (!Number.isInteger(maxSeeds) || maxSeeds < 1 || maxSeeds > 100 || !Number.isInteger(maxActions) || maxActions < 1 || maxActions > 30) throw Error('Invalid bounded seed/action limits');
  let routePriority = {}, policySource = null, policyIgnored = null;
  let adoptedPolicy = { version: 'default', sha256: null };
  const { resolvePolicyFile } = await import('../../../tiktok-discovery-retrospective/scripts/retrospect.mjs');
  const policyFile = await resolvePolicyFile(config.policyFile);
  if (policyFile) {
    const { policy, metadata } = await loadPolicySnapshot(policyFile);
    if (policy.scope.stages.includes('expansion')) { routePriority = policy.strategy.routePriority; adoptedPolicy = metadata; }
    else policyIgnored = { ...metadata, reason: 'policy_scope_does_not_cover_expansion' };
    policySource = policyFile;
  }
  const validation = validateReviews(canonical, config.aiReviewFile ? await readJson(config.aiReviewFile) : canonical.aiReviews ?? []);
  const authors = new Map(canonical.authors.map(a => [a.handle, a])), works = new Map(canonical.works.map(w => [w.id, w]));
  const history = new Set(canonical.actions.filter(a => a.attempted || a.startedAt || a.finishedAt || a.status).map(actionKey));
  const actions = new Map(), allCandidateSources = new Map(), seeds = [], skipped = [];
  const excludedTags = new Set((config.excludedTags ?? []).map(t => norm(t).replace(/^#/, '').normalize('NFKC').toLowerCase()));
  const allowedTags = config.allowedTags ? new Set(config.allowedTags.map(t => norm(t).replace(/^#/, '').normalize('NFKC').toLowerCase())) : null;
  for (const review of validation.reviews.filter(r => r.expand).slice(0, maxSeeds)) {
    const author = authors.get(review.handle);
    if (!Number.isInteger(author?.depth)) { skipped.push({ handle: review.handle, reason: 'actual_parent_depth_unknown' }); continue; }
    const seedActions = new Map();
    const source = (route, evidence, workId = null, targetDepth = author.depth + 1) => ({ seed: author.handle, route, rootDepth: author.depth, targetDepth, sourceWork: workId ? works.get(String(workId))?.url ?? null : null, evidence });
    const add = (action, sources) => {
      if (action.kind === 'collection') {
        const tagPath = new URL(action.url).pathname.match(/^\/tag\/([^/]+)\/?$/);
        const tagName = tagPath ? decodeURIComponent(tagPath[1]).normalize('NFKC').toLowerCase() : null;
        if (tagName && (excludedTags.has(tagName) || (allowedTags && !allowedTags.has(tagName)))) {
          skipped.push({ handle: author.handle, tag: tagName, reason: 'observed_tag_link_excluded_by_reviewed_batch_plan' }); return;
        }
      }
      const key = actionKey(action);
      if (history.has(key)) { skipped.push({ handle: author.handle, key, reason: 'action_already_attempted' }); return; }
      const existing = seedActions.get(key);
      if (existing) { for (const s of sources) if (!existing.sources.some(x => JSON.stringify(x) === JSON.stringify(s))) existing.sources.push(s); return; }
      seedActions.set(key, { ...action, id: digest([canonical.brief.id, key]), seed: author.handle, sources });
    };
    add({ kind: 'profile', route: 'profile_suggested_accounts', url: author.url }, [source('profile_suggested_accounts', author.profileEvidence ?? review.evidence[0], null, author.depth)]);
    for (const query of review.queries) add({ kind: 'search', route: query.route, query: query.query, url: `https://www.tiktok.com/search?q=${encodeURIComponent(query.query)}` }, query.evidence.map(e => source(query.route, { ...e, queryOrigin: 'ai_proposed_from_verified_quote_not_child_attribute' }, e.workId)));
    for (const id of author.workIds) {
      const work = works.get(id);
      for (const tag of work?.metadata?.textExtra ?? []) {
        const name = norm(tag.hashtagName).replace(/^#/, '').normalize('NFKC').toLowerCase();
        if (!name || !/^[\p{L}\p{N}_]+$/u.test(name)) continue;
        if (excludedTags.has(name)) { skipped.push({ handle: author.handle, tag: name, reason: 'tag_excluded_by_reviewed_batch_plan' }); continue; }
        if (allowedTags && !allowedTags.has(name)) { skipped.push({ handle: author.handle, tag: name, reason: 'tag_not_selected_in_reviewed_batch_plan' }); continue; }
        const actualLink = work.collectionLinks?.find(link => { try { return decodeURIComponent(new URL(link.url).pathname).toLowerCase() === `/tag/${name}`; } catch { return false; } });
        if (actualLink) add({ kind: 'collection', route: 'hashtag_page', url: actualLink.url }, [source('hashtag_page', actualLink.evidence, id)]);
        else {
          const context = norm(config.tagQueryContext ?? '');
          const tagQuery = norm(`#${name} ${name === context.toLowerCase() ? '' : context}`);
          add({ kind: 'search', route: 'hashtag_query', query: tagQuery, url: `https://www.tiktok.com/search?q=${encodeURIComponent(tagQuery)}` }, [source('hashtag_query', { ...work.metadata.evidence, field: 'textExtra.hashtagName', quote: tag.hashtagName, queryContext: config.tagQueryContext ?? null }, id)]);
        }
      }
      for (const link of work?.collectionLinks ?? []) add({ kind: 'collection', route: 'observed_collection_link', url: link.url }, [source('observed_collection_link', link.evidence, id)]);
    }
    for (const link of author.collectionLinks ?? []) add({ kind: 'collection', route: 'observed_collection_link', url: link.url }, [source('observed_collection_link', link.evidence, link.workId)]);
    // Sort after collecting all candidates. A route cannot occupy the budget merely
    // because it appears earlier in this source file. Stable sort preserves ties.
    const ranked = [...seedActions.values()].sort((a, b) => (routePriority[routeCategory(b)] ?? 1) - (routePriority[routeCategory(a)] ?? 1));
    for (const candidate of ranked) {
      const key = actionKey(candidate), sources = allCandidateSources.get(key) ?? [];
      for (const source of candidate.sources) if (!sources.some(s => JSON.stringify(s) === JSON.stringify(source))) sources.push(source);
      allCandidateSources.set(key, sources);
    }
    const selected = ranked.slice(0, maxActions);
    for (const candidate of ranked.slice(maxActions)) skipped.push({ handle: author.handle, key: actionKey(candidate), reason: 'bounded_seed_action_budget', routeCategory: routeCategory(candidate) });
    for (const candidate of selected) {
      const key = actionKey(candidate), existing = actions.get(key);
      if (existing) { for (const source of candidate.sources) if (!existing.sources.some(s => JSON.stringify(s) === JSON.stringify(source))) existing.sources.push(source); }
      else actions.set(key, candidate);
    }
    seeds.push({ handle: author.handle, url: author.url, depth: author.depth, workIds: author.workIds, expansionEvidence: review.evidence, candidateActions: ranked.length, plannedNewActions: selected.length });
  }
  // A candidate selected via one seed retains other verified parent sources even
  // when those parents spent their own action budgets on a higher priority route.
  for (const [key, action] of actions) action.sources = allCandidateSources.get(key) ?? action.sources;
  if (config.limits?.totalWorks !== undefined && (!Number.isSafeInteger(config.limits.totalWorks) || config.limits.totalWorks < 1)) throw Error('Invalid explicit totalWorks');
  const result = { briefId: canonical.brief.id, phase: 'expand', ...(config.controlFile ? { controlFile: config.controlFile } : {}), ...(config.notBefore ? { notBefore: config.notBefore } : {}), round: config.round, compiledAt: new Date().toISOString(), adoptedPolicy, seeds, baselineHandles: canonical.authors.map(a => a.handle), minFollowers: minimum, maxFollowers: maximum, limits: { pageWaitMs: 12000, maxScrolls: 8, collectionWorks: 100, maxWallMs: 1200000, maxRecommendationCards: 20, ...(config.limits ?? {}) }, actions: [...actions.values()], compilation: { sourceCanonical: resolve(config.canonicalPath), seedLimit: maxSeeds, actionLimitPerSeed: maxActions, policySource, policyIgnored, routePriority, skipped, reviewIssues: validation.rejected, rule: 'expansion_value_separate_from_fit; quotes_check_provenance; no_inherited_child_attributes; policy_changes_route_order_only' } };
  await writeJson(config.outPath, result); return result;
}
if (isMain(import.meta.url)) {
  try { const config = await cliConfig(); const result = await frontierConfig(config); console.log(JSON.stringify({ actions: result.actions.length, seeds: result.seeds.length, outPath: config.outPath })); } catch (e) { console.error(e.stack); process.exitCode = 1; }
}
