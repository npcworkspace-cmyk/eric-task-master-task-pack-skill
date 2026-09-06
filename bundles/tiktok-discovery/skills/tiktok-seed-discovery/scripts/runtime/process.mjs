// Offline evidence reconstruction. No browser or network access.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadRuntimeConfig, normalizeRuntimeConfig, resolveTaskOutputDir, isMain } from './environment.mjs';

export const VERSION = 'tk-pipeline-offline-1.0.0';
export const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim();
export const handleKey = v => String(v ?? '').replace(/^https:\/\/(?:www\.)?tiktok\.com\/@/i, '').replace(/^@/, '').replace(/\/$/, '').toLowerCase();
const unique = values => [...new Set(values)];
const append = (list, value) => { const key = JSON.stringify(value); if (!list.some(x => JSON.stringify(x) === key)) list.push(value); };
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
export function safeTikTokUrl(value) {
  try { const u = new URL(value); if (u.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(u.hostname)) return null; return `https://www.tiktok.com${u.pathname.replace(/\/$/, '')}${u.pathname === '/search' ? `?q=${encodeURIComponent(u.searchParams.get('q') ?? '')}` : ''}`; } catch { return null; }
}
export function actionKey(action) {
  if (norm(action.query)) return `search|${norm(action.query).toLowerCase()}`;
  if (action.route === 'profile_suggested_accounts') return `profile_recommendations|${safeTikTokUrl(action.url) ?? norm(action.url)}`;
  return `url|${safeTikTokUrl(action.url) ?? norm(action.url)}`;
}
export async function readJson(file) { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
export async function writeJson(file, value) { await mkdir(dirname(resolve(file)), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
export async function cliConfig() { const index = process.argv.indexOf('--config'); if (index < 0 || !process.argv[index + 1]) throw Error('Usage: --config <json>'); return loadRuntimeConfig(process.argv[index + 1]); }
export function targetCountries(brief) {
  const input = brief.targetCountries ?? brief.countries ?? (brief.country ? [brief.country] : []);
  if (!Array.isArray(input) || input.some(c => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c))) throw Error('Brief countries must be explicit uppercase ISO 3166-1 alpha-2 country codes');
  return unique(input);
}
export function targetCountryStatus(country, brief) {
  const targets = targetCountries(brief);
  if (!targets.length) return 'pass';
  if (!country || country === 'unknown') return 'unknown';
  if (country === 'non_US') return targets.length === 1 && targets[0] === 'US' ? 'fail' : 'unknown';
  return targets.includes(country) ? 'pass' : 'fail';
}
export function followerBounds(brief) {
  const minimum = brief.followersMin ?? brief.minFollowers, maximum = brief.followersMax ?? brief.maxFollowers;
  if (!nonnegative(minimum) || !nonnegative(maximum) || minimum > maximum) throw Error('FOLLOWER_BOUNDS_REQUIRED: explicit valid minimum and maximum follower bounds are required');
  return { minimum, maximum };
}
const nonnegative = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const terms = values => (values ?? []).map(norm).filter(Boolean);
const hits = (text, values) => terms(values).filter(t => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu').test(text));

function captionMatches(card, caption) {
  const full = norm(caption), preview = norm(card.caption ?? card.alt), text = norm(card.text);
  if (!full) return false;
  if (preview === full || (preview && preview.includes(full)) || (text && text.includes(full))) return true;
  const prefix = preview.replace(/(?:…|\.{3})(?:\s*(?:more|更多))?\s*$/i, '').trim();
  return prefix.length >= 24 && prefix !== preview && full.startsWith(prefix);
}
function parsedFollowers(raw) {
  const m = norm(raw).replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([KMB万亿]?)$/i);
  return m ? Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9, 万: 1e4, 亿: 1e8 }[m[2].toUpperCase()] ?? 1) : null;
}
function edgeSources(action, taskId, ref, work = null) {
  const parents = action.sources?.length ? action.sources : [{ seed: action.seed ?? null, route: action.route ?? (action.query ? 'search' : 'unknown'), targetDepth: action.targetDepth ?? action.depth ?? (action.query && !action.seed ? 0 : null) }];
  return parents.map(s => ({ taskId, actionId: action.id, actionKey: actionKey(action), parent: s.seed ?? action.seed ?? null, route: s.route ?? action.route ?? null, sourceWork: s.sourceWork ?? null, rootDepth: Number.isInteger(s.rootDepth) ? s.rootDepth : null, depth: Number.isInteger(s.targetDepth) ? s.targetDepth : Number.isInteger(s.depth) ? s.depth : null, via: action.query ?? action.url ?? null, workId: work?.id ?? null, workUrl: work?.url ?? null, evidence: ref, sourceEvidence: s.evidence ?? null }));
}
function emptyAuthor(handle) { return { handle, url: `https://www.tiktok.com/@${handle}`, followers: null, bio: '', displayName: '', identityVerified: false, workIds: [], sources: [], bioEvidence: [], followersHistory: [], recommendationCards: [], collectionLinks: [] }; }
function ensureAuthor(index, handle) { if (!index.authors.has(handle)) index.authors.set(handle, emptyAuthor(handle)); return index.authors.get(handle); }
function setFollowers(author, value, evidence, raw = null) {
  if (!nonnegative(value)) return;
  const observation = { value, raw, precision: raw && /[KMB万亿]/i.test(raw) ? 'display_rounded' : 'exact_observed', evidence };
  append(author.followersHistory, observation);
  if (!author.followersEvidence || String(evidence.observedAt ?? '') >= String(author.followersEvidence.observedAt ?? '')) { author.followers = value; author.followersEvidence = evidence; author.followersPrecision = observation.precision; }
}
function setBio(author, text, evidence) { if (typeof text === 'string' && text.trim() && !/^(?:尚无个人简介|暂无简介|No bio yet)[.。!！]?$/i.test(text.trim())) { append(author.bioEvidence, { text, evidence }); if (!author.bioObservedAt || String(evidence.observedAt ?? '') >= author.bioObservedAt) { author.bio = text; author.bioObservedAt = String(evidence.observedAt ?? ''); } } }
function collectionLinks(links, evidence, workId = null) {
  return (links ?? []).flatMap(link => { const url = safeTikTokUrl(link.url); return url && /^\/(?:tag|music|effect|playlist)\//.test(new URL(url).pathname) ? [{ url, text: link.text ?? '', workId, evidence }] : []; });
}
function matchPair(index, taskId, pair) {
  const card = index.cards.get(pair), responses = index.pending.get(pair);
  if (!card || !responses) return;
  for (const { item, ref } of responses) {
    const token = `${ref.taskId}|${ref.responseId}|${item.id}`;
    if (index.matched.has(token) || handleKey(item.author?.uniqueId) !== card.authorHandle || !captionMatches(card, item.caption)) continue;
    const work = index.works.get(String(item.id));
    if (!work || work.authorHandle !== card.authorHandle) continue;
    const evidence = { ...ref, surfaceSeq: card.ref.seq, sourceWorkUrl: work.url, scope: 'same_action_response_matched_rendered_work_author_caption' };
    const metadata = { caption: item.caption, createTime: nonnegative(item.createTime) && item.createTime > 0 ? item.createTime : null, stats: item.stats ?? {}, textExtra: item.textExtra ?? [], music: item.music ?? null, evidence };
    append(work.metadataEvidence, metadata);
    if (!work.metadata || String(ref.observedAt ?? '') >= String(work.metadata.evidence.observedAt ?? '')) work.metadata = metadata;
    const author = ensureAuthor(index, work.authorHandle);
    author.identityVerified = true;
    if (item.author.id) {
      author.platformId = String(item.author.id);
      append(author.platformIdentityEvidence ??= [], { platformId: author.platformId, evidence });
    }
    if (item.author.nickname) author.displayName = item.author.nickname;
    setBio(author, item.author.signature, evidence);
    setFollowers(author, item.authorStats?.followerCount, evidence);
    index.matched.add(token);
  }
}
function ingestSurface(index, data, ref, taskId) {
  const view = data.view ?? { cards: data.cards, url: data.action?.sourceUrl }, action = data.action;
  if (!action?.id) return;
  index.taskActions.set(`${taskId}|${action.id}`, { ...index.taskActions.get(`${taskId}|${action.id}`), ...action, taskId });
  for (const card of view.cards ?? []) {
    const url = safeTikTokUrl(card.url), m = url && new URL(url).pathname.match(/^\/@([^/]+)\/(?:video|photo)\/(\d+)$/);
    if (!m || String(card.id) !== m[2] || handleKey(card.authorHandle) !== handleKey(m[1])) continue;
    const id = m[2], handle = handleKey(m[1]);
    if (index.works.has(id) && index.works.get(id).authorHandle !== handle) { index.gaps.push({ taskId, actionId: action.id, type: 'conflicting_work_author', workId: id }); continue; }
    if (!index.works.has(id)) index.works.set(id, { id, url, authorHandle: handle, captions: [], sources: [], metadataEvidence: [], collectionLinks: [], firstObservedAt: ref.observedAt });
    const work = index.works.get(id), author = ensureAuthor(index, handle);
    if (!author.workIds.includes(id)) author.workIds.push(id);
    for (const source of edgeSources(action, taskId, ref, work)) { append(work.sources, source); append(author.sources, source); }
    for (const [field, text] of [['caption', card.caption ?? card.alt], ['card_text', card.text]]) if (norm(text)) append(work.captions, { text, field, evidence: ref });
    if (card.id === view.detail?.id) for (const link of collectionLinks(view.detail.links, ref, id)) append(work.collectionLinks, link);
    const key = `${taskId}|${action.id}|${id}`;
    index.cards.set(key, { ...card, authorHandle: handle, ref });
    matchPair(index, taskId, key);
  }
  const expected = handleKey(new URL(safeTikTokUrl(action.url) ?? 'https://www.tiktok.com/').pathname.replace(/^\/@/, ''));
  const actual = handleKey(view.fields?.find(f => f.e2e === 'user-subtitle')?.text);
  const profileUrl = safeTikTokUrl(view.url), isOwnProfile = profileUrl === `https://www.tiktok.com/@${expected}` && actual === expected && /^[\w.]+$/.test(actual);
  if ((action.kind === 'profile' || view.kind === 'profile') && isOwnProfile) {
    const author = ensureAuthor(index, expected), evidence = { ...ref, scope: 'same_action_rendered_profile_url_and_identity' };
    author.identityVerified = true;
    author.profileEvidence = evidence;
    for (const source of edgeSources(action, taskId, evidence)) {
      if (Number.isInteger(source.depth)) author.observedDepth = Number.isInteger(author.observedDepth) ? Math.min(author.observedDepth, source.depth) : source.depth;
      if (source.parent !== author.handle) append(author.sources, source);
    }
    setBio(author, view.fields.find(f => f.e2e === 'user-bio')?.text, evidence);
    author.displayName = view.fields.find(f => f.e2e === 'user-title')?.text ?? author.displayName;
    const raw = view.fields.find(f => f.e2e === 'followers-count')?.text;
    setFollowers(author, parsedFollowers(raw), evidence, raw ?? null);
    for (const link of collectionLinks(view.links, evidence)) append(author.collectionLinks, link);
  }
  for (const card of action.route === 'profile_suggested_accounts' ? view.authorCards ?? [] : []) {
    const url = safeTikTokUrl(card.url), handle = handleKey(card.handle);
    if (card.containerScope !== 'profile_suggested_accounts' || url !== `https://www.tiktok.com/@${handle}` || !isOwnProfile || handle === expected) continue;
    const author = ensureAuthor(index, handle), evidence = { ...ref, scope: 'rendered_profile_suggested_accounts_card' };
    append(author.recommendationCards, { ...card, handle, url, parent: expected, evidence });
    for (const source of edgeSources(action, taskId, evidence)) append(author.sources, { ...source, parent: expected, route: 'profile_suggested_accounts', depth: source.depth === null ? null : source.depth + 1 });
    append(ensureAuthor(index, expected).recommendationCards, { ...card, handle, url, parent: expected, evidence });
  }
}

// A quote proves its source, not the validity of the reviewer's semantic inference.
export function validateReviews(canonical, reviews = []) {
  const authors = new Map(canonical.authors.map(a => [a.handle, a])), works = new Map(canonical.works.map(w => [w.id, w]));
  const output = [], rejected = [];
  for (const review of reviews) {
    const handle = handleKey(review.handle), author = authors.get(handle);
    if (!author) { rejected.push({ handle, reason: 'author_not_observed' }); continue; }
    const verify = e => {
      if (!e || norm(e.quote).length < 3) return null;
      const quote = norm(e.quote), work = e.workId ? works.get(String(e.workId)) : null;
      if (e.workId) {
        if (work?.authorHandle !== handle) return null;
        const candidates = [...(work.captions ?? []).map(c => ({ text: c.text, field: c.field, evidence: c.evidence })), ...(work.metadataEvidence ?? []).map(m => ({ text: m.caption, field: 'caption', evidence: m.evidence }))];
        const found = candidates.find(c => (!e.field || e.field === c.field || e.field === 'caption') && norm(c.text).includes(quote));
        return found ? { ...e, workId: work.id, field: found.field, sourceEvidence: found.evidence } : null;
      }
      if (e.field && e.field !== 'bio') return null;
      const found = (author.bioEvidence ?? []).find(b => norm(b.text).includes(quote));
      return found ? { ...e, field: 'bio', sourceEvidence: found.evidence } : null;
    };
    const evidence = (review.evidence ?? []).map(verify).filter(Boolean);
    const problems = [];
    if (evidence.length !== (review.evidence ?? []).length) problems.push('some_quotes_not_found_in_own_observed_evidence');
    const sufficient = evidence.length > 0;
    const targets = targetCountries(canonical.brief);
    let country = typeof review.country === 'string' && (/^[A-Z]{2}$/.test(review.country) || review.country === 'non_US' && targets.length === 1 && targets[0] === 'US') ? review.country : 'unknown';
    const countryEvidence = evidence.filter(e => e.field === 'bio' && author.locationEvidence?.some(l => l.country === country && norm(e.quote).toLowerCase().includes(norm(l.term).toLowerCase())));
    if (country !== 'unknown' && !countryEvidence.length) { country = 'unknown'; problems.push('country_needs_explicit_self_bio_location'); }
    const queries = (review.queries ?? []).flatMap(q => {
      const refs = (Array.isArray(q.evidence) ? q.evidence : q.evidence ? [q.evidence] : []).map(verify).filter(Boolean);
      if (!norm(q.route) || !norm(q.query) || norm(q.query).length > 200 || !refs.length) { problems.push('query_missing_valid_source_quote'); return []; }
      return [{ route: norm(q.route), query: norm(q.query), evidence: refs }];
    });
    const verified = { handle, topic: sufficient && ['pass', 'fail', 'unknown'].includes(review.topic) ? review.topic : 'unknown', role: sufficient && ['creator', 'brand', 'unknown'].includes(review.role) ? review.role : 'unknown', country, reasons: Array.isArray(review.reasons) ? review.reasons : [], evidence, expand: review.expand === true && sufficient, queries, validation: sufficient ? 'quotes_verified_semantic_judgment_by_reviewer' : 'unverified_review', problems };
    output.push(verified);
    if (problems.length || !sufficient) rejected.push({ handle, reasons: problems.length ? problems : ['review_has_no_valid_evidence'] });
  }
  return { reviews: [...new Map(output.map(r => [r.handle, r])).values()], rejected };
}
function locationEvidence(author, brief) {
  // These are self-location cues only. No caption, tag, language or inferred audience geography.
  const targets = targetCountries(brief);
  if (terms(brief.locationTerms).length && targets.length !== 1) throw Error('locationTerms requires one target country; use locationTermsByCountry or locationCues for multiple countries');
  const configured = [...terms(brief.locationTerms).map(term => ({ term, country: targets[0] })), ...Object.entries(brief.locationTermsByCountry ?? {}).flatMap(([country, values]) => { if (!/^[A-Z]{2}$/.test(country)) throw Error('locationTermsByCountry keys must be ISO country codes'); return terms(values).map(term => ({ term, country })); }), ...(targets.length === 1 && targets[0] === 'US' ? [...terms(brief.nonUSLocationTerms).map(term => ({ term, country: 'non_US' })), { term: 'United States', country: 'US' }, { term: 'USA', country: 'US' }] : [])];
  const result = configured.flatMap(({ term, country }) => (author.bioEvidence ?? []).flatMap(b => {
    const matching = b.text.split(/\n|\||;/).find(line => hits(line, [term]).length && !/\b(?:shipping|ship to|deliver|customers|audience|available|worldwide|travel(?:ed|led)? to)\b/i.test(line) && (norm(line).toLowerCase() === term.toLowerCase() || /📍|\b(?:based in|living in|live in|located in|from|resident|local)\b/i.test(line) || norm(line).toLowerCase().startsWith(`${term.toLowerCase()} `)));
    return matching ? [{ term, country, quote: matching.trim(), evidence: b.evidence, status: 'explicit_bio_location_text_requires_review' }] : [];
  }));
  for (const cue of brief.locationCues ?? []) {
    if (!(typeof cue.country === 'string' && (/^[A-Z]{2}$/.test(cue.country) || cue.country === 'non_US' && targets.length === 1 && targets[0] === 'US')) || typeof cue.pattern !== 'string' || !cue.pattern) throw Error('locationCues require an explicit ISO country and pattern');
    const pattern = new RegExp(cue.pattern, 'iu');
    for (const b of author.bioEvidence ?? []) for (const line of b.text.split(/\n|\||;/)) {
      if (/\b(?:shipping|ship to|deliver(?:y|ies)? to|customers|audience|available|worldwide)\b/i.test(line)) continue;
      const match = line.match(pattern);
      if (match?.[0]?.trim()) append(result, { term: match[0].trim(), country: cue.country, quote: line.trim(), cue: cue.label ?? cue.pattern, evidence: b.evidence, status: 'configured_explicit_bio_location_text_requires_review' });
    }
  }
  return result;
}
function sampleStats(samples) {
  const valid = samples.filter(w => nonnegative(w.metadata?.stats?.diggCount) && nonnegative(w.metadata?.stats?.commentCount) && nonnegative(w.metadata?.stats?.playCount) && w.metadata.stats.playCount > 0);
  const rates = valid.map(w => (w.metadata.stats.diggCount + w.metadata.stats.commentCount) / w.metadata.stats.playCount).sort((a, b) => a - b);
  return { sampleBasis: 'observed_same_author_works_not_claimed_recent', sampledWorks: samples.length, usableInteractionWorks: valid.length, missingInteractionWorks: samples.length - valid.length, interactionDefinition: '(likes + comments) / plays; shares and saves excluded', medianInteractionRate: rates.length ? rates.length % 2 ? rates[(rates.length - 1) / 2] : (rates[rates.length / 2 - 1] + rates[rates.length / 2]) / 2 : null, workIds: valid.map(w => w.id) };
}
function csv(rows) { return '\uFEFF' + rows.map(row => row.map(value => { let text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? ''); if (/^[=+@-]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; }).join(',')).join('\r\n') + '\r\n'; }
function buildClusters(works) {
  const tags = new Map(), pairs = new Map();
  for (const work of works) {
    const observed = unique((work.metadata?.textExtra ?? []).map(t => norm(t.hashtagName).replace(/^#/, '').normalize('NFKC').toLowerCase()).filter(Boolean));
    for (const tag of observed) { if (!tags.has(tag)) tags.set(tag, { tag, workIds: [], authorHandles: [], evidence: [] }); const t = tags.get(tag); t.workIds.push(work.id); t.authorHandles.push(work.authorHandle); t.evidence.push({ workId: work.id, evidence: work.metadata.evidence }); }
    for (let i = 0; i < observed.length; i++) for (let j = i + 1; j < observed.length; j++) { const pair = [observed[i], observed[j]].sort(), key = pair.join('|'); if (!pairs.has(key)) pairs.set(key, { tags: pair, workIds: [] }); pairs.get(key).workIds.push(work.id); }
  }
  return { method: 'normalized_observed_metadata_hashtags_and_cooccurrence', semanticClustering: 'not_performed', tags: [...tags.values()].map(t => ({ ...t, workIds: unique(t.workIds), authorHandles: unique(t.authorHandles), count: unique(t.workIds).length })).sort((a, b) => b.count - a.count), cooccurrence: [...pairs.values()].map(p => ({ ...p, workIds: unique(p.workIds), count: unique(p.workIds).length })).sort((a, b) => b.count - a.count) };
}
function inspectIdentities(authors) {
  const identities = new Map(), aliases = [], conflicts = [];
  for (const author of authors) {
    const ids = unique([author.platformId, ...(author.platformIdentityEvidence ?? []).map(x => x.platformId)].filter(Boolean));
    if (ids.length > 1) conflicts.push({ type: 'handle_observed_with_multiple_platform_ids', handle: author.handle, platformIds: ids, evidence: author.platformIdentityEvidence ?? [], disposition: 'unresolved_not_merged' });
    author.identityKey = ids.length === 1 ? `platform:${ids[0]}` : `handle:${author.handle}`;
    if (!identities.has(author.identityKey)) identities.set(author.identityKey, []);
    identities.get(author.identityKey).push(author);
  }
  for (const [identityKey, group] of identities) if (group.length > 1) aliases.push({ identityKey, platformId: group[0].platformId, handles: group.map(a => a.handle), evidence: group.flatMap(a => (a.platformIdentityEvidence ?? []).map(e => ({ handle: a.handle, ...e }))), disposition: 'same_platform_id_detected_handle_records_preserved' });
  return { aliases, conflicts, uniqueAccountIdentities: identities.size, countingRule: 'same_unambiguous_platform_id_counts_once; unknown_or_conflicting_id_counts_by_handle; handle_records_not_merged' };
}
function labelClusters(clusters, reviews, reviewFile, authors) {
  if (!Array.isArray(reviews)) throw Error('clusterReviewFile must contain an array');
  const tags = new Map(clusters.tags.map(t => [t.tag, t])), authorMap = new Map(authors.map(a => [a.handle, a])), covered = new Set();
  const groups = reviews.map((review, index) => {
    if (!norm(review.label) || !Array.isArray(review.tags) || !review.tags.length) throw Error(`Invalid cluster review at index ${index}`);
    const names = unique(review.tags.map(t => norm(t).replace(/^#/, '').normalize('NFKC').toLowerCase()));
    for (const name of names) if (!tags.has(name)) throw Error(`Cluster review references an unobserved tag: ${name}`);
    const members = names.map(name => tags.get(name));
    for (const name of names) covered.add(name);
    const workIds = unique(members.flatMap(t => t.workIds)), authorHandles = unique(members.flatMap(t => t.authorHandles)), sources = [];
    for (const member of members) for (const source of member.evidence) append(sources, { tag: member.tag, ...source });
    return { label: norm(review.label), tags: names, disposition: norm(review.disposition) || 'reviewed', workIds, authorHandles, workCount: workIds.length, authorCount: authorHandles.length, uniqueAccountIdentities: unique(authorHandles.map(h => authorMap.get(h)?.identityKey ?? `handle:${h}`)).length, sources, reviewFile: resolve(reviewFile) };
  });
  clusters.semanticClustering = 'ai_labeled_observed_tag_subset';
  clusters.semanticGroups = groups;
  clusters.unreviewedTags = clusters.tags.filter(t => !covered.has(t.tag)).map(t => t.tag);
  clusters.semanticReviewScope = 'provided_labels_on_observed_metadata_tags_only; overlap_allowed; no_new_tags_or_semantic_inference_by_script';
}
function mergeActions(records) {
  const grouped = new Map();
  for (const record of records) for (const attempt of record.attempts ?? [record]) {
    const key = actionKey(attempt);
    if (!grouped.has(key)) grouped.set(key, new Map());
    grouped.get(key).set(`${attempt.taskId}|${attempt.id}`, attempt);
  }
  return [...grouped.entries()].map(([key, value]) => {
    const attempts = [...value.values()], latest = attempts.at(-1), sources = [];
    for (const attempt of attempts) for (const source of attempt.sources ?? []) append(sources, source);
    return { ...latest, key, sources, attempted: attempts.some(a => a.startedAt || a.finishedAt || a.status), attempts };
  });
}

export async function processConfig(config) {
  config = normalizeRuntimeConfig(config);
  const brief = config.brief;
  if (!brief?.id || !Array.isArray(config.taskIds) || !config.outDir) throw Error('brief.id, taskIds and outDir required');
  const countryMeaning = brief.countryMeaning ?? 'creator_location';
  if (!['promotion_market', 'creator_location'].includes(countryMeaning)) throw Error('countryMeaning must be promotion_market or creator_location');
  const countryMeaningSource = brief.countryMeaning ? 'explicit_brief' : 'legacy_creator_location_default';
  const { minimum, maximum } = followerBounds(brief);
  const prior = config.priorCanonical ? await readJson(config.priorCanonical) : null;
  if (prior && (prior.schemaVersion !== VERSION || prior.brief.id !== brief.id)) throw Error('priorCanonical must be an evidence-reconstructed canonical for the same Brief');
  const index = { authors: new Map((prior?.authors ?? []).map(a => [a.handle, a])), works: new Map((prior?.works ?? []).map(w => [w.id, w])), cards: new Map(), pending: new Map(), matched: new Set(), taskActions: new Map(), gaps: [...(prior?.coverage?.gaps ?? [])] };
  const configuredBaseline = config.baselineHandles ?? brief.baselineHandles ?? prior?.baselineHandles;
  const baseline = new Set((configuredBaseline ?? []).map(handleKey));
  let baselineInitialized = configuredBaseline !== undefined;
  const priorHandles = new Set((prior?.authors ?? []).map(a => a.handle));
  const taskReports = [...(prior?.coverage?.tasks ?? [])], priorIds = new Set(taskReports.map(t => t.taskId));
  for (const taskId of unique(config.taskIds)) {
    if (priorIds.has(taskId)) continue;
    if (!/^task_[a-zA-Z0-9_-]+$/.test(taskId)) throw Error(`Invalid task ID: ${taskId}`);
    const outputDir = resolveTaskOutputDir(config, taskId);
    let checkpoint;
    try { checkpoint = await readJson(join(outputDir, 'checkpoint.json')); } catch (e) { index.gaps.push({ taskId, type: 'checkpoint_missing_or_invalid', reason: e.code ?? e.message }); }
    // A later enrichment batch knows this batch's authors already. It must not
    // erase their new-account status against the original discovery baseline.
    if (!baselineInitialized && checkpoint?.input) {
      for (const handle of checkpoint.input.baselineHandles ?? []) baseline.add(handleKey(handle));
      baselineInitialized = true;
    }
    const planned = checkpoint?.input?.actions ?? [], completed = checkpoint?.actions ?? checkpoint?.runtime?.actions ?? [];
    for (const action of [...planned, ...completed]) if (action.id) index.taskActions.set(`${taskId}|${action.id}`, { ...index.taskActions.get(`${taskId}|${action.id}`), ...action, taskId });
    const rawFile = join(outputDir, 'observations.jsonl'); let rawEvents = 0, rawLine = 0;
    try {
      for await (const line of createInterface({ input: createReadStream(rawFile, { encoding: 'utf8' }), crlfDelay: Infinity })) {
        rawLine++;
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { index.gaps.push({ taskId, type: 'invalid_or_partial_raw_line', line: rawLine }); continue; }
        rawEvents++;
        const data = event.data ?? {}, action = data.action ?? data;
        const ref = { taskId, rawFile, rawLine, seq: event.seq, actionId: action.id ?? data.actionId ?? null, observedAt: data.view?.observedAt ?? data.observedAt ?? action.startedAt ?? null };
        if (event.type === 'surface' || event.type === 'cards') ingestSurface(index, data, ref, taskId);
        if (event.type === 'response' && data.id && data.actionId) for (const item of data.items ?? []) {
          if (!item.id || !item.author?.uniqueId) continue;
          const pair = `${taskId}|${data.actionId}|${item.id}`;
          if (!index.pending.has(pair)) index.pending.set(pair, []);
          index.pending.get(pair).push({ item, ref: { ...ref, actionId: data.actionId, responseId: data.id } });
          matchPair(index, taskId, pair);
        }
        if (['action_start', 'action_done'].includes(event.type) && data.id) index.taskActions.set(`${taskId}|${data.id}`, { ...index.taskActions.get(`${taskId}|${data.id}`), ...data, taskId });
        if (['action_error', 'run_error', 'access', 'http_limit', 'response_read_timeout'].includes(event.type)) index.gaps.push({ ...ref, type: event.type, state: data.state ?? null, error: data.error ?? null });
      }
    } catch (e) { index.gaps.push({ taskId, type: 'raw_observations_unavailable', reason: e.code ?? e.message }); }
    for (const action of index.taskActions.values()) if (action.taskId === taskId && (!action.finishedAt || /error|not_verified|not_rendered|no_rendered|not_visible|unavailable|paused/i.test(action.status ?? ''))) index.gaps.push({ taskId, actionId: action.id, actionKey: actionKey(action), type: !action.finishedAt ? 'action_unfinished_or_not_started' : 'action_coverage_gap', status: action.status ?? 'not_started' });
    const checkpointWorks = checkpoint?.store?.works?.length ?? null;
    taskReports.push({ taskId, rawFile, rawEvents, checkpointPresent: !!checkpoint, plannedActions: planned.length, completedActions: completed.length, checkpointWorks, checkpointError: checkpoint?.error ?? null });
    // Pairing is task-local; release the raw response index before reading the next task.
    index.cards.clear(); index.pending.clear(); index.matched.clear();
  }
  const works = [...index.works.values()], authors = [...index.authors.values()];
  for (const work of works) {
    const stats = work.metadata?.stats;
    work.dataGaps = [!work.metadata?.evidence && 'no_same_action_response_and_dom_pair', !nonnegative(work.metadata?.createTime) && 'creation_time_not_observed', !nonnegative(stats?.diggCount) && 'likes_not_observed', !nonnegative(stats?.commentCount) && 'comments_not_observed', !nonnegative(stats?.playCount) && 'plays_not_observed'].filter(Boolean);
  }
  for (const author of authors) {
    author.sources = author.sources.filter(s => s.parent !== author.handle);
    author.workIds = unique(author.workIds).filter(id => index.works.get(id)?.authorHandle === author.handle);
    author.newVsBaseline = !baseline.has(author.handle);
    author.newVsPriorCanonical = prior ? !priorHandles.has(author.handle) : null;
    const samples = author.workIds.map(id => index.works.get(id));
    const text = [author.bio, ...samples.flatMap(w => [w.metadata?.caption, ...w.captions.map(c => c.text)])].filter(Boolean).join('\n');
    author.textSignals = { topicTerms: hits(text, brief.topicTerms), excludeTerms: hits(text, brief.excludeTerms), brandTerms: hits(text, brief.brandTerms), status: 'literal_text_screen_only_semantics_pending' };
    author.locationEvidence = locationEvidence(author, brief);
    author.followerStatus = !nonnegative(author.followers) ? 'unknown' : author.followers >= minimum && author.followers <= maximum ? 'pass' : 'fail';
    author.sampleStats = author.followerStatus === 'fail' ? { sampleBasis: 'not_computed_follower_gate_failed', sampledWorks: samples.length } : sampleStats(samples);
    author.dataGaps = [!author.followersEvidence && 'followers_not_observed', !author.bio && 'bio_not_observed', !author.workIds.length && 'own_works_not_observed', !author.locationEvidence.length && 'self_location_not_established', author.sources.some(s => s.depth === null) && 'source_depth_unknown'].filter(Boolean);
  }
  const identity = inspectIdentities(authors);
  const canonical = { schemaVersion: VERSION, generatedAt: new Date().toISOString(), brief, baselineHandles: [...baseline], authors, works, identityAliases: identity.aliases, identityConflicts: identity.conflicts, identityCounting: { uniqueAccountIdentities: identity.uniqueAccountIdentities, countingRule: identity.countingRule }, actions: mergeActions([...(prior?.actions ?? []), ...index.taskActions.values()]), coverage: { tasks: taskReports, gaps: index.gaps } };
  const validation = validateReviews(canonical, config.aiReviewFile ? await readJson(config.aiReviewFile) : prior?.aiReviews ?? []);
  canonical.aiReviews = validation.reviews; canonical.reviewValidation = validation.rejected;
  const reviewMap = new Map(validation.reviews.map(r => [r.handle, r]));
  for (const author of authors) {
    const review = reviewMap.get(author.handle);
    const creatorLocationMatch = targetCountryStatus(review?.country, brief);
    // Public self-location evidence establishes the creator's location only.
    // This runtime does not ingest verified audience-country evidence, so a
    // promotion-market conclusion cannot be supplied by a bio or review flag.
    const marketCountryStatus = 'unknown';
    const qualificationCountryStatus = countryMeaning === 'promotion_market' ? marketCountryStatus : creatorLocationMatch;
    author.assessment = { followers: author.followerStatus, topic: review?.topic ?? 'unknown', role: review?.role ?? 'unknown', country: review?.country ?? 'unknown', countryMeaning, countryMeaningSource, targetCountryStatus: creatorLocationMatch, targetCountryStatusBasis: 'creator_location_only', creatorLocationMatch, marketCountryStatus, marketCountryStatusReason: 'verified_audience_country_evidence_not_ingested', qualificationCountryStatus, expand: review?.expand ?? false, commercialQualification: 'not_assessed' };
    if (countryMeaning === 'promotion_market') author.dataGaps.push('promotion_market_audience_country_not_established');
    author.fitStatus = author.followerStatus === 'fail' || review?.topic === 'fail' || review?.role === 'brand' || qualificationCountryStatus === 'fail' ? 'fail' : author.followerStatus === 'pass' && review?.topic === 'pass' && review?.role === 'creator' && qualificationCountryStatus === 'pass' ? 'pass' : 'unknown';
    const depths = [...author.sources.map(s => s.depth), author.observedDepth].filter(Number.isInteger);
    author.depth = depths.length ? Math.min(...depths) : null;
  }
  canonical.authors.sort((a, b) => Number(b.textSignals.topicTerms.length > 0) - Number(a.textSignals.topicTerms.length > 0) || a.handle.localeCompare(b.handle));
  const queue = authors.filter(a => a.fitStatus === 'unknown').map(a => ({ handle: a.handle, url: a.url, followers: a.followers, followerStatus: a.followerStatus, bio: a.bio, bioEvidence: a.bioEvidence, locationEvidence: a.locationEvidence, assessment: a.assessment, textSignals: a.textSignals, workIds: a.workIds, samples: a.workIds.map(id => { const w = index.works.get(id); return { workId: id, url: w.url, caption: w.metadata?.caption ?? w.captions[0]?.text ?? null, captionEvidence: w.metadata?.evidence ?? w.captions[0]?.evidence ?? null }; }), pending: ['topic', 'role', countryMeaning === 'promotion_market' ? 'marketCountryStatus' : 'country'].filter(key => a.assessment[key] === 'unknown'), dataGaps: a.dataGaps }));
  const seeds = authors.filter(a => a.assessment.expand).map(a => ({ handle: a.handle, url: a.url, depth: a.depth, workIds: a.workIds, fitStatus: a.fitStatus, expansionEvidence: reviewMap.get(a.handle)?.evidence ?? [], queries: reviewMap.get(a.handle)?.queries ?? [] }));
  const historyKeys = new Set(canonical.actions.filter(a => a.attempted || a.startedAt || a.finishedAt || a.status).map(actionKey));
  const enrichActions = authors.filter(a => a.followerStatus !== 'fail' && (!a.followersEvidence || !a.bio || (a.assessment.topic === 'pass' && a.assessment.role !== 'brand' && a.assessment.qualificationCountryStatus !== 'fail' && a.sampleStats.usableInteractionWorks < (brief.minInteractionSamples ?? 3)) || (a.assessment.expand && !a.profileEvidence))).map(a => ({ kind: 'profile', route: 'profile_enrichment', seed: a.handle, url: a.url, sources: [{ seed: a.handle, route: 'profile_enrichment', rootDepth: a.depth, targetDepth: a.depth, evidence: a.sources[0]?.evidence ?? a.recommendationCards[0]?.evidence ?? null }] })).filter(a => !historyKeys.has(actionKey(a))).map(a => ({ ...a, id: digest([brief.id, actionKey(a)]) }));
  const enrich = { briefId: brief.id, phase: 'expand', ...(config.controlFile ? { controlFile: config.controlFile } : {}), ...(config.notBefore ? { notBefore: config.notBefore } : {}), seeds: [], baselineHandles: authors.map(a => a.handle), minFollowers: minimum, maxFollowers: maximum, limits: { pageWaitMs: 12000, maxScrolls: 2, collectionWorks: 12, maxWallMs: 1200000, maxRecommendationCards: 20, ...(config.limits ?? {}) }, actions: enrichActions };
  const clusters = buildClusters(works);
  clusters.semanticGroups = [];
  clusters.unreviewedTags = clusters.tags.map(t => t.tag);
  if (config.clusterReviewFile) labelClusters(clusters, await readJson(config.clusterReviewFile), config.clusterReviewFile, authors);
  const summary = { schemaVersion: VERSION, generatedAt: canonical.generatedAt, status: index.gaps.length ? 'partial_coverage' : 'bounded_raw_reconstruction_complete', tasks: taskReports.length, authors: authors.length, works: works.length, pairedMetadataWorks: works.filter(w => w.metadata?.evidence).length, followersKnown: authors.filter(a => nonnegative(a.followers)).length, followerRange: { min: minimum, max: maximum }, followerPass: authors.filter(a => a.followerStatus === 'pass').length, fitPass: authors.filter(a => a.fitStatus === 'pass').length, fitUnknown: authors.filter(a => a.fitStatus === 'unknown').length, fitFail: authors.filter(a => a.fitStatus === 'fail').length, fullyCommerciallyQualified: 0, reviewedExpansionSeeds: seeds.length, reviewQueue: queue.length, enrichActions: enrichActions.length, aiReviews: validation.reviews.length, reviewIssues: validation.rejected.length, dataGaps: index.gaps.length, clustering: clusters.method, semanticClustering: 'not_performed', interactionSample: 'observed_same_author_works_not_claimed_recent' };
  Object.assign(summary, { observedHandles: authors.length, uniqueAccountIdentities: identity.uniqueAccountIdentities, identityAliases: identity.aliases.length, identityConflicts: identity.conflicts.length, authorCountingRule: 'authors_and_other_author_metrics_count_observed_handles; uniqueAccountIdentities_counts_platform_ids_where_unambiguous', countryMeaning, countryMeaningSource, creatorLocationMatchPass: authors.filter(a => a.assessment.creatorLocationMatch === 'pass').length, marketCountryKnown: 0, geographyRule: 'creator_self_location_is_not_audience_or_promotion_market_evidence', semanticClustering: clusters.semanticClustering, semanticGroups: clusters.semanticGroups.length, unreviewedTags: clusters.unreviewedTags.length });
  const out = resolve(config.outDir); await mkdir(out, { recursive: true });
  for (const [name, value] of Object.entries({ canonical, clusters, 'review-queue': queue, seeds, 'enrich-input': enrich, summary })) await writeJson(join(out, `${name}.json`), value);
  await writeFile(join(out, 'authors.csv'), csv([['handle', 'url', 'followers', 'followersPrecision', 'bio', 'followerStatus', 'topic', 'role', 'country', 'countryMeaning', 'creatorLocationMatch', 'marketCountryStatus', 'qualificationCountryStatus', 'fitStatus', 'expand', 'depth', 'workIds', 'textSignals', 'dataGaps', 'sources'], ...authors.map(a => [a.handle, a.url, a.followers, a.followersPrecision, a.bio, a.followerStatus, a.assessment.topic, a.assessment.role, a.assessment.country, a.assessment.countryMeaning, a.assessment.creatorLocationMatch, a.assessment.marketCountryStatus, a.assessment.qualificationCountryStatus, a.fitStatus, a.assessment.expand, a.depth, a.workIds, a.textSignals, a.dataGaps, a.sources])]));
  await writeFile(join(out, 'works.csv'), csv([['id', 'authorHandle', 'url', 'caption', 'createTime', 'likes', 'comments', 'plays', 'interactionRate', 'evidence', 'sources'], ...works.map(w => { const s = w.metadata?.stats ?? {}, rate = nonnegative(s.diggCount) && nonnegative(s.commentCount) && nonnegative(s.playCount) && s.playCount > 0 ? (s.diggCount + s.commentCount) / s.playCount : null; return [w.id, w.authorHandle, w.url, w.metadata?.caption ?? w.captions[0]?.text, w.metadata?.createTime, s.diggCount, s.commentCount, s.playCount, rate, w.metadata?.evidence, w.sources]; })]));
  await writeFile(join(out, 'clusters.csv'), csv([['kind', 'tag', 'otherTag', 'workCount', 'workIds', 'authorHandles'], ...clusters.tags.map(t => ['metadata_hashtag', t.tag, '', t.count, t.workIds, t.authorHandles]), ...clusters.cooccurrence.map(t => ['cooccurrence', ...t.tags, t.count, t.workIds, ''])]));
  return { summary, canonical, clusters, queue, seeds, enrich };
}
if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify((await processConfig(await cliConfig())).summary, null, 2)); } catch (e) { console.error(e.stack); process.exitCode = 1; }
}
