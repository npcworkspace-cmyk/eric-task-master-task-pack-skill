import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Offline only. All task paths, targets and rubric decisions are caller inputs.
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const unique = values => [...new Set(values)];
const field = (row, camel, snake) => row?.[camel] ?? row?.[snake];
const reserved = new Set('accounts about api challenge checkpoint direct developer developers emails explore legal p popular privacy reel reels static stories terms tv web'.split(' '));
const runtimeFields = new Set('actionKey action_key attemptId attempt_id status startedAt started_at finishedAt finished_at completedAt completed_at durationMs duration_ms accountHandles account_handles contentIds content_ids cacheHits cache_hits stopReason stop_reason error lastError last_error observedAt observed_at updatedAt updated_at attempts outputObservationIds output_observation_ids checkpointSeq checkpoint_seq'.split(' '));
const knownTime = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const normalizedEvidenceId = value => nonempty(value) ? value.trim().replaceAll('\\', '/').replace(/^snapshots\//, '') : null;
const enrich = route => /^(?:profile_)?enrich(?:ment)?$/i.test(route || '');
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function instagramUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, 'https://www.instagram.com/');
    return url.protocol === 'https:' && ['instagram.com', 'www.instagram.com'].includes(url.hostname) && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}
export function normalizeHandle(value) {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (candidate.startsWith('/') || /^https?:\/\//i.test(candidate)) {
    const url = instagramUrl(candidate);
    if (!url || !/^\/[a-z0-9._]{1,30}\/?$/i.test(url.pathname)) return null;
    candidate = url.pathname.replaceAll('/', '');
  } else candidate = candidate.replace(/^@/, '');
  candidate = candidate.toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(candidate) && !reserved.has(candidate) ? candidate : null;
}
export function normalizeAccount(value, stableId = null, namespace = null) {
  const handle = normalizeHandle(value);
  const stable = nonempty(stableId) && nonempty(namespace);
  return { handle, canonicalUrl: handle ? `https://www.instagram.com/${handle}/` : null,
    entityKey: stable ? `instagram:${namespace.trim()}:${stableId.trim()}` : handle ? `instagram:handle:${handle}` : null,
    identityStatus: stable ? 'namespaced_id_supplied' : handle ? 'provisional_handle' : 'invalid' };
}
export function parseInstagramWork(value) {
  const url = instagramUrl(value); if (!url) return null;
  const match = url.pathname.match(/^\/(?:([A-Za-z0-9._]{1,30})\/)?(p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) return null;
  const format = match[2].toLowerCase() === 'p' ? 'p' : 'reel', shortcode = match[3];
  return { shortcode, format, canonicalUrl: `https://www.instagram.com/${format}/${shortcode}/`, key: `instagram:work:${shortcode}`,
    authorFromPath: match[1] ? normalizeHandle(match[1]) : null };
}
function canonicalJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort(compareText).map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  throw new Error('Action input must contain finite JSON values');
}
export function semanticActionKey(action, batchId = null) {
  if (!action || Array.isArray(action) || typeof action !== 'object') throw new Error('Action must be an object');
  const embedded = field(action, 'batchId', 'batch_id');
  if (action.batchId != null && action.batch_id != null && action.batchId !== action.batch_id) throw new Error('Conflicting batch identifiers');
  if (embedded != null && batchId != null && embedded !== batchId) throw new Error('Conflicting batch identifiers');
  const batch = batchId ?? embedded;
  if (!nonempty(batch)) throw new Error('A nonempty batchId is required for a semantic action key');
  const spec = Object.fromEntries(Object.entries(action).filter(([key]) => !runtimeFields.has(key) && !['batchId', 'batch_id'].includes(key)));
  spec.batchId = batch;
  return sha256(canonicalJSON(spec));
}
export function isCandidateEvidence(record) {
  if (!normalizeHandle(record?.handle)) return false;
  const kind = field(record, 'evidenceKind', 'evidence_kind');
  const route = field(record, 'routeId', 'route_id');
  const sourceUrl = field(record, 'sourceUrl', 'source_url');
  const absoluteSource = nonempty(sourceUrl) && /^https:\/\//i.test(sourceUrl) && instagramUrl(sourceUrl);
  if (['profile_similar', 'following'].includes(route)) return kind === 'account_card' && Boolean(absoluteSource);
  if (!['keyword_content', 'hashtag_content', 'brand_tagged', 'profile_collab_authors', 'profile_credit_repost'].includes(route)) return false;
  if (['content_author', 'cached_content_author'].includes(kind)) {
    const work = [field(record, 'contentUrl', 'content_url'), field(record, 'workUrl', 'work_url'), sourceUrl, field(record, 'sourceWorkUrl', 'source_work_url')]
      .filter(value => nonempty(value) && /^https:\/\//i.test(value)).map(parseInstagramWork).find(Boolean);
    if (!work) return false;
    const contentId = field(record, 'contentId', 'content_id');
    return contentId == null || contentId === work.shortcode || contentId === work.key;
  }
  const variant = field(record, 'routeVariant', 'route_variant');
  return route === 'profile_credit_repost' && kind === 'profile' && field(record, 'lookupOnly', 'lookup_only') === true &&
    ['named_profile_lookup', 'named_profile_from_verified_prior_work'].includes(variant) &&
    normalizeHandle(record.handle) !== null && normalizeHandle(record.handle) === normalizeHandle(record.seed) &&
    Boolean(absoluteSource) && normalizeHandle(sourceUrl) === normalizeHandle(record.handle) &&
    normalizeHandle(field(record, 'parentSeed', 'parent_seed')) !== null &&
    parseInstagramWork(field(record, 'sourceWorkUrl', 'source_work_url')) !== null &&
    nonempty(field(record, 'cueEvidenceId', 'cue_evidence_id'));
}
export function parseCommittedJSONL(text) {
  if (typeof text !== 'string') throw new Error('JSONL input must be a string');
  const last = text.lastIndexOf('\n'), committed = text.slice(0, last + 1), ignoredTail = text.slice(last + 1);
  const records = [], lineNumbers = [];
  for (const [index, raw] of committed.split('\n').entries()) {
    const line = index === 0 ? raw.replace(/^\uFEFF/, '') : raw;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error();
      records.push(record); lineNumbers.push(index + 1);
    } catch { throw new Error(`Invalid committed JSONL object at line ${index + 1}`); }
  }
  return { records, ignoredTail, committedBytes: Buffer.byteLength(committed, 'utf8'), lineNumbers };
}
export function readJsonl(file) {
  const bytes = fs.readFileSync(file), boundary = bytes.lastIndexOf(10) + 1;
  let committed;
  try { committed = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, boundary)); }
  catch { throw new Error('Invalid UTF-8 in committed JSONL bytes'); }
  const parsed = parseCommittedJSONL(committed);
  return { ...parsed, ignoredTail: bytes.subarray(boundary).toString('utf8'), sha256: sha256(bytes), bytes: bytes.length,
    committedBytes: boundary, ignoredTailBytes: bytes.length - boundary };
}
function safeUrl(value) {
  const url = instagramUrl(value); if (!url) return null;
  const queries = url.searchParams.getAll('q'); url.search = ''; url.hash = ''; url.hostname = 'www.instagram.com';
  for (const query of queries) url.searchParams.append('q', query);
  return url.toString();
}
function duration(row) {
  const start = knownTime(field(row, 'startedAt', 'started_at'));
  const end = knownTime(field(row, 'finishedAt', 'finished_at') ?? field(row, 'completedAt', 'completed_at'));
  const supplied = field(row, 'durationMs', 'duration_ms');
  return typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0 ? supplied : start !== null && end !== null && end >= start ? end - start : null;
}
const sumKnown = values => values.some(x => x !== null) ? values.reduce((n, x) => n + (x ?? 0), 0) : null;
const tally = (rows, key) => rows.reduce((out, row) => { const value = String(row[key] ?? 'unknown'); out[value] = (out[value] || 0) + 1; return out; }, Object.create(null));
function costRole(row) {
  const explicit = field(row, 'costRole', 'cost_role');
  if (explicit != null) return ['discovery', 'enrichment', 'diagnostic'].includes(explicit) ? explicit : 'unknown';
  if (row.phase === 'diagnostic' || row.slot === 'diagnostic') return 'diagnostic';
  return enrich(field(row, 'routeId', 'route_id')) ? 'enrichment' : 'discovery';
}
function reviewOriginal(row) {
  // Preserve semantic fields without copying parser metadata or credential containers.
  function clean(value) {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/^_|^(?:cookies?|authorization|password|access_?token|refresh_?token|session_?token|headers|storageState)$/i.test(key)).map(([key, item]) => [key, clean(item)]));
  }
  return clean(row);
}

export function audit(options) {
  const target = options.target;
  if (!Number.isSafeInteger(target) || target < 0) throw new Error('target must be an explicit nonnegative integer');
  const accountFiles = [].concat(options.accounts || []), actionFiles = [].concat(options.actions || []), profileFiles = [].concat(options.profiles || []), reviewFiles = [].concat(options.reviews || []);
  if (!accountFiles.length || !options.baseline) throw new Error('accounts and baseline inputs are required');
  const inputs = [], warnings = [];
  function load(file) {
    const data = readJsonl(file), inputIndex = inputs.length;
    inputs.push({ path: path.resolve(file), name: path.basename(file), sha256: data.sha256, bytes: data.bytes, committedBytes: data.committedBytes, ignoredTailBytes: data.ignoredTailBytes, recordCount: data.records.length });
    if (data.ignoredTailBytes) warnings.push({ code: 'uncommitted_tail_ignored', inputIndex, bytes: data.ignoredTailBytes });
    return data.records.map((record, i) => ({ ...record, _inputIndex: inputIndex, _line: data.lineNumbers[i] }));
  }
  const baselineBytes = fs.readFileSync(options.baseline);
  let baselineData;
  try { baselineData = JSON.parse(baselineBytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('Invalid baseline JSON'); }
  if (!Array.isArray(baselineData.handles)) throw new Error('baseline JSON requires a handles array');
  const baseline = new Set(baselineData.handles.map(normalizeHandle).filter(Boolean));
  const invalidBaselineEntries = baselineData.handles.filter(h => !normalizeHandle(h)).length;
  if (invalidBaselineEntries) throw new Error('baseline contains invalid handle entries');
  inputs.push({ path: path.resolve(options.baseline), name: path.basename(options.baseline), sha256: sha256(baselineBytes), bytes: baselineBytes.length, recordCount: baselineData.handles.length });
  const invalidRows = options.invalid ? [].concat(options.invalid).flatMap(load) : [];
  if (invalidRows.some(r => !normalizeHandle(r.handle) || !normalizedEvidenceId(field(r, 'evidenceId', 'evidence_id')))) throw new Error('invalid-observations require a valid handle and exact evidenceId');
  const invalid = new Set(invalidRows.map(r => JSON.stringify([normalizeHandle(r.handle), normalizedEvidenceId(field(r, 'evidenceId', 'evidence_id'))])));
  const rawActions = actionFiles.flatMap(load), logicalActions = new Map(), attempts = new Map(), unstartedDispatches = [];
  for (const row of rawActions) {
    const key = field(row, 'actionKey', 'action_key') || semanticActionKey(row);
    const attempt = field(row, 'attemptId', 'attempt_id') ?? field(row, 'startedAt', 'started_at') ?? 'legacy_unknown_attempt';
    logicalActions.set(key, row);
    const hasStarted = knownTime(field(row, 'startedAt', 'started_at')) !== null || duration(row) !== null;
    if (!hasStarted && ['pending', 'queued', 'skipped', 'unstarted'].includes(row.status)) { unstartedDispatches.push({ key, status: row.status }); continue; }
    attempts.set(JSON.stringify([key, attempt]), { ...row, key, attempt });
  }
  const rawAccounts = accountFiles.flatMap(load), exclusions = { baselineRows: 0, referenceOnlyRows: 0, exactInvalidRows: 0, invalidHandleRows: 0, missingObservationEvidenceRows: 0 };
  const baselineObserved = new Set(), observations = [], validEvidence = new Map(), profileEvidence = new Map();
  let rowOrder = 0;
  function addProfile(p, fallbackId = null) {
    const handle = normalizeHandle(p?.handle), id = normalizedEvidenceId(field(p, 'evidenceId', 'evidence_id') || fallbackId);
    const urlHandle = normalizeHandle(p?.url ?? p?.profileUrl ?? p?.profile_url);
    if (!handle || !id || urlHandle !== handle || invalid.has(JSON.stringify([handle, id]))) return;
    const observedAt = field(p, 'observedAt', 'observed_at');
    const key = JSON.stringify([handle, id]), old = profileEvidence.get(key);
    if (!old || (knownTime(observedAt) ?? -1) >= old.time) profileEvidence.set(key, { time: knownTime(observedAt) ?? -1, observedAt: observedAt || null });
  }
  for (const row of rawAccounts) {
    rowOrder++;
    const handle = normalizeHandle(row.handle), kind = field(row, 'evidenceKind', 'evidence_kind');
    const evidenceId = normalizedEvidenceId(field(row, 'evidenceId', 'evidence_id'));
    if (!handle) { exclusions.invalidHandleRows++; continue; }
    if (kind === 'reference_only') { exclusions.referenceOnlyRows++; continue; }
    if (invalid.has(JSON.stringify([handle, evidenceId]))) { exclusions.exactInvalidRows++; continue; }
    const observedAt = field(row, 'observedAt', 'observed_at'), time = knownTime(observedAt);
    if (!evidenceId || time === null) { exclusions.missingObservationEvidenceRows++; continue; }
    const actionKey = field(row, 'actionKey', 'action_key') || null, action = logicalActions.get(actionKey) || {};
    const routeId = field(row, 'routeId', 'route_id') || field(action, 'routeId', 'route_id') || 'unknown';
    const merged = { ...action, ...row, handle, routeId, evidenceKind: kind };
    for (const [camel, snake] of [['routeVariant', 'route_variant'], ['lookupOnly', 'lookup_only'], ['parentSeed', 'parent_seed'], ['sourceWorkUrl', 'source_work_url'], ['cueEvidenceId', 'cue_evidence_id'], ['batchId', 'batch_id']]) merged[camel] = field(row, camel, snake) ?? field(action, camel, snake);
    const work = parseInstagramWork(field(row, 'contentUrl', 'content_url') || field(row, 'workUrl', 'work_url') || field(row, 'sourceUrl', 'source_url'));
    const item = { handle, routeId, actionKey, seed: normalizeHandle(merged.seed), depth: merged.depth ?? null,
      phase: merged.phase || null, batchId: field(merged, 'batchId', 'batch_id') || null, routeVariant: field(merged, 'routeVariant', 'route_variant') || null,
      parentSeed: normalizeHandle(field(merged, 'parentSeed', 'parent_seed')), sourceWorkUrl: parseInstagramWork(field(merged, 'sourceWorkUrl', 'source_work_url'))?.canonicalUrl || null,
      cueEvidenceId: normalizedEvidenceId(field(merged, 'cueEvidenceId', 'cue_evidence_id')), lookupOnly: field(merged, 'lookupOnly', 'lookup_only') === true,
      evidenceId, evidenceKind: kind || 'unknown', observedAt, time, rowOrder, inputIndex: row._inputIndex, line: row._line,
      sourceUrl: safeUrl(field(row, 'sourceUrl', 'source_url')), workKey: work?.key || null,
      candidate: !enrich(routeId) && isCandidateEvidence(merged), enrichment: enrich(routeId) };
    validEvidence.set(JSON.stringify([handle, evidenceId]), item);
    addProfile(row.profileEvidence ?? row.profile_evidence, evidenceId);
    if (kind === 'profile') addProfile({ handle, url: field(row, 'sourceUrl', 'source_url'), observedAt, evidenceId });
    if (baseline.has(handle)) { exclusions.baselineRows++; baselineObserved.add(handle); continue; }
    if (!item.candidate && !item.enrichment && ['account_card', 'content_author', 'cached_content_author'].includes(kind)) warnings.push({ code: 'candidate_source_incomplete_or_unsupported', handle, inputIndex: row._inputIndex, line: row._line });
    observations.push(item);
  }
  profileFiles.flatMap(load).forEach(p => addProfile(p));
  if (exclusions.invalidHandleRows || exclusions.missingObservationEvidenceRows) warnings.push({ code: 'invalid_observations_excluded', count: exclusions.invalidHandleRows + exclusions.missingObservationEvidenceRows });
  const reviews = new Map(), rawReviews = reviewFiles.flatMap(load);
  for (const row of rawReviews) {
    const handle = normalizeHandle(row.handle); if (!handle) { warnings.push({ code: 'review_invalid_handle', inputIndex: row._inputIndex, line: row._line }); continue; }
    const suppliedIds = field(row, 'evidenceIds', 'evidence_ids') || [];
    if (!Array.isArray(suppliedIds)) throw new Error('review evidenceIds must be an array');
    const ids = unique([...suppliedIds, field(row, 'profileEvidenceId', 'profile_evidence_id')].map(normalizedEvidenceId).filter(Boolean));
    const profileLinks = ids.map(id => profileEvidence.get(JSON.stringify([handle, id]))).filter(Boolean);
    const discoveryLinks = ids.map(id => validEvidence.get(JSON.stringify([handle, id]))).filter(Boolean);
    const level = field(row, 'evidenceLevel', 'evidence_level') || field(row, 'reviewLevel', 'review_level') || 'unknown';
    const explicitProfileReview = /^profile(?:_|$)/.test(level) && !/triage/.test(level);
    const verifiedProfile = explicitProfileReview && profileLinks.length > 0;
    const rank = [verifiedProfile ? 2 : discoveryLinks.length > 0 ? 1 : 0,
      verifiedProfile ? Math.max(...profileLinks.map(x => x.time)) : -1, knownTime(field(row, 'reviewedAt', 'reviewed_at')) ?? -1, row._inputIndex, row._line];
    const briefVersion = field(row, 'briefVersion', 'brief_version') ?? null, rubricVersion = field(row, 'rubricVersion', 'rubric_version') ?? null;
    const contextKey = JSON.stringify([handle, briefVersion, rubricVersion]);
    const selected = { handle, briefVersion, rubricVersion, role: row.role ?? 'unknown', theme: row.theme ?? 'unknown', disposition: row.disposition ?? 'unknown',
      expansionStatus: field(row, 'expansionStatus', 'expansion_status') ?? 'unknown', routeScope: field(row, 'routeScope', 'route_scope') ?? field(row, 'allowedScope', 'allowed_scope') ?? null,
      allowedScope: field(row, 'allowedScope', 'allowed_scope') ?? field(row, 'routeScope', 'route_scope') ?? null,
      rationale: row.rationale ?? null, continuity: row.continuity ?? null, originalReview: reviewOriginal(row),
      evidenceLevel: level, evidenceIds: ids, profileLinked: verifiedProfile, linkage: verifiedProfile ? 'profile_linked' : discoveryLinks.length ? 'discovery_linked' : 'unlinked',
      reviewedAt: field(row, 'reviewedAt', 'reviewed_at') || null, reviewBatchId: field(row, 'reviewBatchId', 'review_batch_id') || null,
      source: { inputIndex: row._inputIndex, line: row._line }, rank };
    const old = reviews.get(contextKey);
    if (!old || rank.some((value, i) => value !== old.rank[i] && rank.slice(0, i).every((v, j) => v === old.rank[j]) && value > old.rank[i])) reviews.set(contextKey, selected);
  }
  const byHandle = new Map();
  for (const observation of observations) { if (!byHandle.has(observation.handle)) byHandle.set(observation.handle, []); byHandle.get(observation.handle).push(observation); }
  const chronological = (a, b) => a.time - b.time || a.rowOrder - b.rowOrder;
  const firstCandidates = [...byHandle.values()].map(rows => rows.filter(x => x.candidate).sort(chronological)[0]).filter(Boolean).sort(chronological);
  const targetHandles = new Set(firstCandidates.slice(0, target).map(x => x.handle)), overflowHandles = new Set(firstCandidates.slice(target).map(x => x.handle));
  const ranks = new Map(firstCandidates.map((x, i) => [x.handle, i + 1]));
  const provenance = item => { const { time, rowOrder: order, candidate, enrichment, ...rest } = item; return { ...rest, candidate, enrichment }; };
  const entities = [...byHandle].map(([handle, rows]) => {
    const firstObserved = [...rows].sort(chronological)[0], candidateFirst = rows.filter(x => x.candidate).sort(chronological)[0];
    const variants = [...reviews.values()].filter(r => r.handle === handle).map(r => Object.fromEntries(Object.entries(r).filter(([key]) => !['handle', 'rank'].includes(key))));
    const matchingReviews = variants.filter(r => (options.briefVersion == null || r.briefVersion === options.briefVersion) && (options.rubricVersion == null || r.rubricVersion === options.rubricVersion));
    const selectedReview = matchingReviews.length === 1 ? matchingReviews[0] : null;
    if (matchingReviews.length > 1) warnings.push({ code: 'review_context_conflict', handle, contexts: matchingReviews.map(r => ({ briefVersion: r.briefVersion, rubricVersion: r.rubricVersion })) });
    return { handle, entityKey: `instagram:handle:${handle}`, identityStatus: 'provisional_handle', pool: targetHandles.has(handle) ? 'target' : overflowHandles.has(handle) ? 'overflow' : 'support_only',
      candidateRank: ranks.get(handle) ?? null, firstObserved: provenance(firstObserved), firstCandidate: candidateFirst ? provenance(candidateFirst) : null,
      candidateRoutes: unique(rows.filter(x => x.candidate).map(x => x.routeId)).sort(compareText), allObservedRoutes: unique(rows.map(x => x.routeId)).sort(compareText),
      observations: rows.map(provenance), review: selectedReview, reviewVariants: variants };
  }).sort((a, b) => (a.candidateRank ?? Infinity) - (b.candidateRank ?? Infinity) || compareText(a.handle, b.handle));
  const actionAttempts = [...attempts.values()], discoveryActions = actionAttempts.filter(x => costRole(x) === 'discovery');
  const costFrames = ['discovery', 'enrichment', 'diagnostic', 'unknown'].map(role => {
    const rows = actionAttempts.filter(x => costRole(x) === role), durations = rows.map(duration);
    return { costRole: role, actionCount: rows.length, browserKnownMs: sumKnown(durations), untimedActionCount: durations.filter(x => x === null).length,
      explicitRoleCount: rows.filter(x => field(x, 'costRole', 'cost_role') != null).length,
      routeDefaultRoleCount: rows.filter(x => field(x, 'costRole', 'cost_role') == null && x.phase !== 'diagnostic' && x.slot !== 'diagnostic').length };
  });
  if (costFrames.find(x => x.costRole === 'unknown').actionCount) warnings.push({ code: 'unrecognized_explicit_cost_role' });
  const routeIds = unique([...observations.map(x => x.routeId), ...actionAttempts.map(x => field(x, 'routeId', 'route_id') || 'unknown')]).sort(compareText);
  const supported = new Set(['profile_similar', 'following', 'keyword_content', 'hashtag_content', 'brand_tagged', 'profile_collab_authors', 'profile_credit_repost']);
  for (const routeId of routeIds) if (!enrich(routeId) && !supported.has(routeId)) warnings.push({ code: 'unsupported_route_support_only', routeId });
  const routes = routeIds.map(routeId => {
    const rows = observations.filter(x => x.routeId === routeId), candidates = rows.filter(x => x.candidate), candidateHandles = new Set(candidates.map(x => x.handle));
    const allActionRows = actionAttempts.filter(x => (field(x, 'routeId', 'route_id') || 'unknown') === routeId);
    const actionRows = allActionRows.filter(x => ['discovery', 'enrichment'].includes(costRole(x))), durations = actionRows.map(duration);
    return { routeId, ownBaselineNewUnique: unique(rows.map(x => x.handle)).length, candidateOwnBaselineNewUnique: candidateHandles.size,
      globalFirstCandidateUnique: firstCandidates.filter(x => x.routeId === routeId).length,
      globalFirstTargetUnique: firstCandidates.filter(x => x.routeId === routeId && targetHandles.has(x.handle)).length,
      targetPoolObservedUnique: [...candidateHandles].filter(h => targetHandles.has(h)).length,
      supportOnlyWithinRouteUnique: unique(rows.filter(x => !candidateHandles.has(x.handle)).map(x => x.handle)).length,
      observationRows: rows.length, evidenceKindRows: tally(rows, 'evidenceKind'), actionCount: actionRows.length,
      browserKnownMs: sumKnown(durations), untimedActionCount: durations.filter(x => x === null).length,
      allAttemptCount: allActionRows.length, allAttemptKnownMs: sumKnown(allActionRows.map(duration)),
      diagnosticBrowserKnownMs: sumKnown(allActionRows.filter(x => costRole(x) === 'diagnostic').map(duration)),
      unknownCostRoleBrowserKnownMs: sumKnown(allActionRows.filter(x => costRole(x) === 'unknown').map(duration)),
      actionStatuses: tally(actionRows, 'status'), stopReasons: tally(actionRows.map(r => ({ stopReason: field(r, 'stopReason', 'stop_reason') })), 'stopReason') };
  });
  const overlaps = routeIds.flatMap((a, i) => routeIds.slice(i + 1).map(b => ({ routeA: a, routeB: b,
    candidateIntersectionUnique: entities.filter(x => x.candidateRoutes.includes(a) && x.candidateRoutes.includes(b)).length,
    allObservationIntersectionUnique: entities.filter(x => x.allObservedRoutes.includes(a) && x.allObservedRoutes.includes(b)).length })));
  const changedInputs = inputs.flatMap((input, i) => !fs.existsSync(input.path) || sha256(fs.readFileSync(input.path)) !== input.sha256 ? [i] : []);
  if (changedInputs.length) warnings.push({ code: 'inputs_changed_during_read', inputIndexes: changedInputs });
  const running = [...logicalActions.values()].filter(x => ['running', 'pending', 'retryable'].includes(x.status)).length;
  if (running) warnings.push({ code: 'unfinished_logical_actions', count: running });
  const checks = { noBaselineCandidates: firstCandidates.every(x => !baseline.has(x.handle)),
    targetOverflowReconciles: targetHandles.size + overflowHandles.size === firstCandidates.length,
    routeFirstTargetReconciles: routes.reduce((n, x) => n + x.globalFirstTargetUnique, 0) === targetHandles.size,
    candidateOwnWithinObservedOwn: routes.every(x => x.candidateOwnBaselineNewUnique <= x.ownBaselineNewUnique),
    uniqueEntityHandles: new Set(entities.map(x => x.handle)).size === entities.length };
  const summary = { targetRequested: target, candidateUnique: firstCandidates.length, targetCount: targetHandles.size, overflowCount: overflowHandles.size,
    baselineUnique: baseline.size, baselineObservedUnique: baselineObserved.size, allNetNewObservedUnique: entities.length,
    supportOnlyUnique: entities.filter(x => x.pool === 'support_only').length, rawAccountRows: rawAccounts.length, exclusions,
    reviewedUnique: entities.filter(x => x.reviewVariants.length).length, selectedReviewUnique: entities.filter(x => x.review).length,
    profileLinkedReviewedUnique: entities.filter(x => x.review?.profileLinked).length,
    unreviewedUnique: entities.filter(x => !x.reviewVariants.length).length, unresolvedReviewContextUnique: entities.filter(x => x.reviewVariants.length && !x.review).length,
    unknownRoleReviewed: entities.filter(x => x.review?.role === 'unknown').length, unstartedDispatchRows: unstartedDispatches.length,
    discoveryActionCount: discoveryActions.length, enrichmentActionCount: actionAttempts.filter(x => costRole(x) === 'enrichment').length,
    diagnosticActionCount: actionAttempts.filter(x => costRole(x) === 'diagnostic').length, unknownCostRoleActionCount: actionAttempts.filter(x => costRole(x) === 'unknown').length,
    discoveryBrowserKnownMs: sumKnown(discoveryActions.map(duration)), enrichmentBrowserKnownMs: sumKnown(actionAttempts.filter(x => costRole(x) === 'enrichment').map(duration)),
    diagnosticBrowserKnownMs: sumKnown(actionAttempts.filter(x => costRole(x) === 'diagnostic').map(duration)), unknownCostRoleBrowserKnownMs: sumKnown(actionAttempts.filter(x => costRole(x) === 'unknown').map(duration)),
    perAccountReviewMs: null };
  return { schemaVersion: 'ig-audit-v1', generatedAt: new Date().toISOString(), status: warnings.length ? 'partial_snapshot' : 'audited_snapshot',
    targetReached: targetHandles.size === target, qualificationCertified: false, identityCountingBasis: 'normalized_handle_without_unverified_alias_merging',
    candidateRule: 'account_card/content_author/cached_content_author, or lookupOnly named profile with complete prior-work cue fields; enrichment and ordinary profile context are support only',
    summary, routes, costFrames, overlaps, entities, inputs: inputs.map(({ path: inputPath, ...rest }) => rest), warnings, qa: { passed: Object.values(checks).every(Boolean), checks },
    limitations: ['Offline consistency audit; declared evidence types do not certify webpage truth or authorship.',
      'Target counts only candidate evidence. firstObserved also retains earlier support; route first credit depends on collection order.',
      'All costs are recorded browser action attempts; retry journals coalesce by action key plus attempt identity. Missing attempt identity is legacy/unknown.',
      'Diagnostic cost is separate only when phase/slot=diagnostic or costRole=diagnostic is explicit. Unmarked historical actions use their route category, not a guessed diagnostic classification.',
      'Review priority uses exact same-handle evidence links, then evidence and review timestamps; no name-based qualification or unknown-enum rejection.',
      'No inferred alias mapping, audience, full-video inspection, commercial rights, sampling representativeness, or per-account review cost.',
      'Only LF-committed JSONL objects are read; even a valid final object without LF is uncommitted. Source files are never repaired here.'] };
}

function cli(args) {
  if (args.includes('--help')) { console.log('node ig-audit.mjs --accounts FILE [--accounts FILE] --baseline FILE --target N --out NEW_DIR [--actions FILE] [--profiles FILE] [--reviews FILE] [--invalid FILE] [--brief-version V] [--rubric-version V]\nInputs are UTF-8 JSON/JSONL. JSONL commits require LF. All repeated input flags preserve caller order. Output: audit.json and entities.jsonl; existing outputs are never replaced. No browser or network access.'); return; }
  const options = {}, repeat = new Set(['accounts', 'actions', 'profiles', 'reviews', 'invalid']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!['accounts', 'baseline', 'target', 'out', 'actions', 'profiles', 'reviews', 'invalid', 'brief-version', 'rubric-version'].includes(key) || !args[i].startsWith('--') || args[i + 1] === undefined) throw new Error('Invalid CLI arguments; use --help');
    const optionKey = key === 'brief-version' ? 'briefVersion' : key === 'rubric-version' ? 'rubricVersion' : key;
    if (repeat.has(key)) (options[key] ||= []).push(args[i + 1]); else { if (options[optionKey] !== undefined) throw new Error('Duplicate scalar option'); options[optionKey] = args[i + 1]; }
  }
  if (!options.out || options.target === undefined || !/^\d+$/.test(options.target)) throw new Error('--out and an integer --target are required');
  options.target = Number(options.target);
  const out = path.resolve(options.out), reportPath = path.join(out, 'audit.json'), entityPath = path.join(out, 'entities.jsonl');
  if (fs.existsSync(reportPath) || fs.existsSync(entityPath)) throw new Error('Output exists; choose a new output directory');
  const inputFiles = [].concat(options.accounts || [], options.actions || [], options.profiles || [], options.reviews || [], options.invalid || [], options.baseline || []);
  const normalizedPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (inputFiles.some(file => [reportPath, entityPath].some(dest => normalizedPath(file) === normalizedPath(dest)))) throw new Error('Output path overlaps an input');
  const result = audit(options), { entities, ...report } = result;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(entityPath, entities.map(x => JSON.stringify(x)).join('\n') + (entities.length ? '\n' : ''), { flag: 'wx' });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, qaPassed: result.qa.passed, targetReached: result.targetReached, summary: result.summary }));
  if (!result.qa.passed) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { cli(process.argv.slice(2)); } catch (error) { console.error(JSON.stringify({ status: 'error', message: error.message })); process.exitCode = 2; }
}
