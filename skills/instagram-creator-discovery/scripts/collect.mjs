// Self-contained Task Master entry. Candidate: offline tested; no new live-platform claim.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const VERSION = '1.0.1';
export const ROUTES = ['profile_similar','following','profile_enrich','keyword_content','hashtag_content','brand_tagged','profile_collab_authors','profile_credit_repost'];
const RESERVED = new Set(['explore','reels','reel','p','tv','popular','accounts','direct','stories','legal','web','about','api','developer','developers','privacy','terms','challenge','checkpoint','emails','static']);
export const RUNTIME_FIELDS = new Set(['actionKey','action_key','attemptId','attempt_id','status','startedAt','started_at','finishedAt','finished_at','completedAt','completed_at','durationMs','duration_ms','accountHandles','account_handles','contentIds','content_ids','cacheHits','cache_hits','stopReason','stop_reason','error','lastError','last_error','observedAt','observed_at','updatedAt','updated_at','attempts','outputObservationIds','output_observation_ids','checkpointSeq','checkpoint_seq']);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])) : value;
function instagramURL(value) {
  if(typeof value!=='string') return null;
  try { const u=new URL(value,'https://www.instagram.com/'); if(u.protocol!=='https:'||!['instagram.com','www.instagram.com'].includes(u.hostname)||u.port||u.username||u.password)return null; return u; } catch { return null; }
}
export function normalizeHandle(value) {
  if(typeof value!=='string')return null;
  let v=value.trim();
  if(v.startsWith('/')||/^https?:\/\//i.test(v)){const u=instagramURL(v);if(!u)return null;const m=u.pathname.match(/^\/([A-Za-z0-9_.]{1,30})\/?$/);if(!m)return null;v=m[1];}
  else v=v.replace(/^@/,'');
  return /^[A-Za-z0-9_.]{1,30}$/.test(v)&&!RESERVED.has(v.toLowerCase())?v.toLowerCase():null;
}
export function parseInstagramWork(value) {
  const u=instagramURL(value);if(!u)return null;
  const m=u.pathname.match(/^\/(?:(?<author>[A-Za-z0-9_.]{1,30})\/)?(?<format>p|reel|reels)\/(?<id>[A-Za-z0-9_-]+)\/?$/);if(!m)return null;
  const format=m.groups.format==='reels'?'reel':m.groups.format,shortcode=m.groups.id;
  return {shortcode,format,canonicalUrl:`https://www.instagram.com/${format}/${shortcode}/`,key:`instagram:work:${shortcode}`,authorFromPath:normalizeHandle(m.groups.author)};
}
const field=(row,camel,snake)=>row?.[camel]??row?.[snake];
const nonempty=value=>typeof value==='string'&&!!value.trim();
const compareText=(a,b)=>a<b?-1:a>b?1:0;
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
  const spec = Object.fromEntries(Object.entries(action).filter(([key]) => !RUNTIME_FIELDS.has(key) && !['batchId', 'batch_id'].includes(key)));
  spec.batchId = batch;
  return digest(canonicalJSON(spec));
}
export function isCandidateEvidence(record) {
  if (!normalizeHandle(record?.handle)) return false;
  const kind = field(record, 'evidenceKind', 'evidence_kind');
  const route = field(record, 'routeId', 'route_id');
  const sourceUrl = field(record, 'sourceUrl', 'source_url');
  const absoluteSource = nonempty(sourceUrl) && /^https:\/\//i.test(sourceUrl) && instagramURL(sourceUrl);
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
const budget=(a,k)=>{if(a.budget?.[k]!==undefined&&a[k]!==undefined&&a.budget[k]!==a[k])throw Error(`CONFLICTING_BUDGET_${k}`);return a.budget?.[k]??a[k];};
function integer(v,name,min=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(v)||v<min||v>max)throw Error(`INVALID_${name}`);return v;}
export function validateInput(input) {
  if(!input||typeof input!=='object')throw Error('INPUT_REQUIRED');
  if(typeof input.runId!=='string'||!input.runId.trim())throw Error('RUN_ID_REQUIRED');
  if(typeof input.batchId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(input.batchId))throw Error('INVALID_BATCH_ID');
  if(!path.isAbsolute(input.runDir||'')||!path.isAbsolute(input.baselinePath||''))throw Error('ABSOLUTE_RUN_AND_BASELINE_PATHS_REQUIRED');
  if(!/^[a-f0-9]{64}$/i.test(input.baselineSha256||''))throw Error('BASELINE_SHA256_REQUIRED');
  integer(input.targetCount,'TARGET_COUNT',1);
  if(input.maxDurationMs!==undefined)integer(input.maxDurationMs,'MAX_DURATION_MS',1);
  if(!Array.isArray(input.actions))throw Error('ACTIONS_REQUIRED');
  for(const a of input.actions){
    if(!a||!ROUTES.includes(a.routeId))throw Error('UNSUPPORTED_ROUTE');
    if(!instagramURL(a.url)||!/^https:\/\//i.test(a.url))throw Error('INSTAGRAM_ACTION_URL_REQUIRED');
    if(a.seed!==undefined&&normalizeHandle(a.seed)!==a.seed)throw Error('CANONICAL_SEED_REQUIRED');
    if(['profile_similar','following','profile_enrich','profile_credit_repost','profile_collab_authors'].includes(a.routeId)&&normalizeHandle(a.url)!==a.seed)throw Error('EXPECTED_PROFILE_URL_REQUIRED');
    if(a.routeId==='profile_credit_repost'){
      if(!isCandidateEvidence({...a,handle:a.seed,sourceUrl:a.url,evidenceKind:'profile'}))throw Error('AUTOMATIC_CREDIT_SCAN_UNSUPPORTED_USE_EVIDENCED_LOOKUP');
    }else if(a.lookupOnly)throw Error('LOOKUP_ONLY_REQUIRES_NAMED_CREDIT_ROUTE');
    if(['profile_similar','following'].includes(a.routeId)){integer(budget(a,'maxAccounts'),'MAX_ACCOUNTS',1);integer(budget(a,'maxScrolls'),'MAX_SCROLLS',1);}
    if(['profile_similar','following','profile_enrich','profile_credit_repost'].includes(a.routeId))integer(budget(a,'maxProfilePosts'),'MAX_PROFILE_POSTS',0,12);
    if(!['profile_similar','following','profile_enrich','profile_credit_repost'].includes(a.routeId)){
      integer(budget(a,'maxWorks'),'MAX_WORKS',1);integer(budget(a,'resolveLimit'),'RESOLVE_LIMIT',0);integer(budget(a,'maxScrolls'),'MAX_SCROLLS',0);
      if(a.workUrls!==undefined&&(!Array.isArray(a.workUrls)||a.workUrls.some(u=>!parseInstagramWork(u)||!/^https:\/\//i.test(u))))throw Error('INVALID_WORK_URLS');
      if(a.skipKnownWorkIds!==undefined&&(!Array.isArray(a.skipKnownWorkIds)||a.skipKnownWorkIds.some(x=>typeof x!=='string'||!/^[A-Za-z0-9_-]+$/.test(x))))throw Error('INVALID_SKIP_WORK_IDS');
    }
    const key=semanticActionKey(a,input.batchId);if(a.actionKey!==undefined&&a.actionKey!==key)throw Error('EXPLICIT_ACTION_KEY_MISMATCH');
  }
  for(const [k,v]of Object.entries(input.waits||{})){if(!['navigationMs','mainMs','settleMs','listInitialMs','listScrollMs','gridMs'].includes(k))throw Error('UNKNOWN_WAIT_OPTION');integer(v,`WAIT_${k}`,['navigationMs','mainMs'].includes(k)?1:0,120000);}
  return input;
}

// Runs inside page.evaluate; it deliberately has no references to module imports.
export function extractSnapshotDOM({scope}) {
  const dialog=document.querySelector('[role="dialog"]'),main=document.querySelector('main'),root=scope==='dialog'?(dialog||main||document.body):(main||document.body);
  const anchors=[...root.querySelectorAll('a[href]')],profileLink=a=>/^\/[A-Za-z0-9_.]{1,30}\/$/.test(a.getAttribute('href')||'');
  const links=anchors.slice(0,1800).map(a=>{let row=a.parentElement;for(let i=0;i<6&&row&&row!==root;i++){if(row.querySelectorAll('button').length===1&&row.innerText.length<800)break;row=row.parentElement;}return{href:a.getAttribute('href'),text:(a.innerText||a.getAttribute('aria-label')||'').slice(0,500),alt:a.querySelector('img')?.getAttribute('alt')?.slice(0,2200),cardText:scope==='dialog'?(row&&row!==root?row.innerText:a.innerText).slice(0,800):undefined};});
  const currentId=location.pathname.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  const workId=a=>{try{const u=new URL(a.getAttribute('href'),location.origin);return ['instagram.com','www.instagram.com'].includes(u.hostname)?u.pathname.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/)?.[1]:null;}catch{return null;}};
  const articles=[...root.querySelectorAll('article')];
  const matching=currentId?articles.filter(article=>[...article.querySelectorAll('a[href]')].some(a=>workId(a)===currentId)):[];
  const vertical=/\/reels\//.test(location.pathname),conflictingArticle=!!currentId&&matching.length===0&&articles.some(article=>[...article.querySelectorAll('a[href]')].some(a=>!!workId(a)));
  const authorScope=matching.length===1?matching[0]:root;
  const options=matching.length>1?[]:[...authorScope.querySelectorAll('button,[role="button"]')].filter(b=>['更多选项','More options'].includes(b.getAttribute('aria-label')||b.querySelector('svg')?.getAttribute('aria-label')));
  const headers=new Set();
  for(const more of options){let header=more.parentElement;for(let i=0;i<6&&header&&header!==authorScope;i++){const profiles=[...header.querySelectorAll('a[href]')].filter(profileLink);if(profiles.length&&profiles.length<=4&&header.innerText.length<1200){headers.add(header);break;}header=header.parentElement;}}
  const found=headers.size===1&&(matching.length===1||matching.length===0&&!vertical&&!conflictingArticle),header=found?[...headers][0]:null;
  return{url:location.origin+location.pathname+location.search,title:document.title,scope:scope==='dialog'&&dialog?'dialog':main?'main':'body',text:root.innerText.slice(0,22000),links,totalLinks:anchors.length,linksTruncated:anchors.length>1800,topLinks:found?[...header.querySelectorAll('a[href]')].map(a=>({href:a.getAttribute('href'),text:a.innerText})):[],authorHeaderFound:found,authorHeaderText:found?header.innerText:null,authorHeaderCandidates:headers.size,authorScope:matching.length===1?'current_permalink_article':matching.length>1?'ambiguous_articles':vertical?'vertical_unbound':conflictingArticle?'conflicting_article':'unique_header_fallback',times:[...root.querySelectorAll('time')].map(t=>({datetime:t.getAttribute('datetime'),text:t.textContent}))};
}

export async function run({page,input,outputDir,progress,wait,signal}) {
  validateInput(input);
  const startedWall=Date.now(),deadline=input.maxDurationMs===undefined?Infinity:startedWall+input.maxDurationMs;
  const baselineBytes=await fs.readFile(input.baselinePath),baselineHash=digest(baselineBytes);
  if(baselineHash!==input.baselineSha256.toLowerCase())throw Error('BASELINE_HASH_MISMATCH');
  const baselineData=JSON.parse(baselineBytes.toString('utf8').replace(/^\uFEFF/,''));
  if(!Array.isArray(baselineData.handles)||baselineData.handles.some(h=>!normalizeHandle(h)))throw Error('INVALID_BASELINE_HANDLES');
  const baseline=new Set(baselineData.handles.map(normalizeHandle)),runDir=input.runDir;
  await fs.mkdir(runDir,{recursive:true});await fs.mkdir(outputDir,{recursive:true});await fs.mkdir(path.join(runDir,'snapshots'),{recursive:true});await fs.mkdir(path.join(runDir,'plans'),{recursive:true});
  const readJSON=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  const atomic=async(file,obj)=>{const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(obj,null,2)+'\n');await fs.rename(tmp,file);};
  const moduleHash=digest(await fs.readFile(fileURLToPath(import.meta.url))),identity={schemaVersion:'ig-collector-run-v1',runId:input.runId,baselineSha256:baselineHash,moduleSha256:moduleHash,targetCount:input.targetCount};
  const identityFile=path.join(runDir,'run-manifest.json'),priorIdentity=await readJSON(identityFile);
  if(priorIdentity&&JSON.stringify(stable(priorIdentity))!==JSON.stringify(stable(identity)))throw Error('RUN_RECOVERY_FINGERPRINT_MISMATCH');
  if(!priorIdentity){
    for(const name of ['accounts.jsonl','actions.jsonl','contents.jsonl','profiles.jsonl'])try{if((await fs.stat(path.join(runDir,name))).size)throw Error('UNBOUND_EXISTING_RUN_REQUIRES_MIGRATION');}catch(e){if(e.code!=='ENOENT')throw e;}
    await atomic(identityFile,identity);
  }
  const planFile=path.join(runDir,'plans',input.batchId+'.json'),plan={batchId:input.batchId,inputSha256:digest(JSON.stringify(stable(input))),actionKeys:input.actions.map(a=>semanticActionKey(a,input.batchId))};
  const oldPlan=await readJSON(planFile);if(oldPlan&&JSON.stringify(oldPlan)!==JSON.stringify(plan))throw Error('BATCH_INPUT_FINGERPRINT_MISMATCH');if(!oldPlan)await atomic(planFile,plan);
  const attemptId=Date.now().toString(36)+'-'+crypto.randomBytes(5).toString('hex');
  const append=async(name,record)=>fs.appendFile(path.join(runDir,name),JSON.stringify(record)+'\n');
  async function readLines(name){
    const file=path.join(runDir,name);let bytes;try{bytes=await fs.readFile(file);}catch(e){if(e.code==='ENOENT')return[];throw e;}
    const boundary=bytes.lastIndexOf(10)+1;let committedText;try{committedText=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,boundary));}catch{throw Error('INVALID_COMMITTED_JSONL_UTF8');}
    const parsed=parseCommittedJSONL(committedText);parsed.committedBytes=boundary;
    if(boundary<bytes.length){
      await fs.mkdir(path.join(runDir,'recovery-tails'),{recursive:true});
      const tailFile=`${name}.${attemptId}.bin`;await fs.writeFile(path.join(runDir,'recovery-tails',tailFile),bytes.subarray(parsed.committedBytes));
      await fs.truncate(file,parsed.committedBytes);
      // Recovery evidence is saved before the source can receive new committed observations.
      await fs.writeFile(path.join(runDir,'recovery-tails',tailFile+'.json'),JSON.stringify({source:name,originalBytes:bytes.length,committedBytes:parsed.committedBytes,tailFile,at:new Date().toISOString()}));
    }
    return parsed.records;
  }
  // Validate every journal before any browser work; tail recovery never excuses a corrupt middle line.
  const journals={};for(const name of ['accounts.jsonl','actions.jsonl','contents.jsonl','profiles.jsonl','relations.jsonl','identity-events.jsonl','resolution-events.jsonl','content-pools.jsonl','invalid-observations.jsonl','dispatch.jsonl','evidence.jsonl'])journals[name]=await readLines(name);
  const evidenceIndex=new Map(journals['evidence.jsonl'].map(r=>[r.evidenceId,r]));
  for(const r of evidenceIndex.values()){if(path.basename(r.evidenceId)!==r.evidenceId)throw Error('INVALID_RECOVERY_EVIDENCE_PATH');let bytes;try{bytes=await fs.readFile(path.join(runDir,'snapshots',r.evidenceId));}catch{throw Error('RECOVERY_EVIDENCE_MISSING');}if(digest(bytes)!==r.sha256)throw Error('RECOVERY_EVIDENCE_HASH_MISMATCH');}
  for(const name of ['accounts.jsonl','contents.jsonl','profiles.jsonl'])for(const r of journals[name])if(!evidenceIndex.has(r.evidenceId))throw Error('RECOVERY_EVIDENCE_INDEX_MISSING');
  const invalidId=r=>{const id=field(r,'evidenceId','evidence_id');return typeof id==='string'?id.trim().replaceAll('\\','/').replace(/^snapshots\//,''):null;};
  if(journals['invalid-observations.jsonl'].some(r=>!normalizeHandle(r.handle)||!invalidId(r)))throw Error('INVALID_EXACT_OBSERVATION_EXCLUSION');
  const invalid=new Set(journals['invalid-observations.jsonl'].map(r=>`${normalizeHandle(r.handle)}|${invalidId(r)}`));
  const existing=journals['accounts.jsonl'].filter(r=>!invalid.has(`${normalizeHandle(r.handle)}|${r.evidenceId}`));
  const candidates=new Set(existing.filter(isCandidateEvidence).map(r=>normalizeHandle(r.handle))),net=new Set([...candidates].filter(h=>!baseline.has(h)));
  const completed=new Set(journals['actions.jsonl'].filter(a=>a.status==='completed').map(a=>a.actionKey));
  const cache=new Map(journals['contents.jsonl'].map(c=>({...c,authors:c.authors?.map(normalizeHandle).filter(h=>h&&!invalid.has(`${h}|${c.evidenceId}`))})).filter(c=>c.authors?.length&&c.authorResolution==='visible_header_resolved'&&parseInstagramWork(c.url)?.shortcode===c.shortcode).map(c=>[c.shortcode,c]));
  const waits={navigationMs:45000,mainMs:18000,settleMs:1700,listInitialMs:2400,listScrollMs:1800,gridMs:2000,...input.waits};
  let current=null,snapshotCount=0,executed=0,batchStop=null;const stoppedRoutes=new Map();
  const checkAbort=()=>{if(signal?.aborted)throw Error('USER_CANCELLED');if(Date.now()>=deadline)throw Error('TIME_BUDGET_EXCEEDED');};
  async function checkpoint(reason){
    const cp={schemaVersion:'ig-collector-checkpoint-v1',runId:input.runId,batchId:input.batchId,attemptId,updatedAt:new Date().toISOString(),candidateUnique:candidates.size,netNew:net.size,targetCount:input.targetCount,baselineCount:baseline.size,completedActions:completed.size,currentActionKey:current?.actionKey||null,reason};
    await atomic(path.join(runDir,'checkpoint.json'),cp);await atomic(path.join(outputDir,'checkpoint.json'),cp);await progress({current:Math.min(net.size,input.targetCount),total:input.targetCount,message:`${input.batchId}: ${net.size} new candidates; ${reason}`});
  }
  async function capture(phase,scope='main',httpStatus=null){
    checkAbort();
    const d=await page.evaluate(extractSnapshotDOM,{scope});
    d.observedAt=new Date().toISOString();d.actionKey=current.actionKey;d.routeId=current.routeId;d.seed=current.seed;d.phase=phase;d.httpStatus=httpStatus;
    d.state=/\/challenge\/|\/checkpoint\/|安全验证|验证您的身份|confirm you.re human/i.test(d.url+' '+d.text)?'verification':httpStatus===403||httpStatus===429||/稍后再试|Try again later|We restrict certain activity/i.test(d.text)?'restricted':/\/accounts\/login\//.test(d.url)?'login_required':/无法访问此页面|Sorry, this page isn.t available/i.test(d.text)?'page_unavailable':/(?:^|\n)\s*(?:加载失败|无法加载|Couldn't load|Failed to load|Something went wrong)(?:[^\n]{0,100})(?:\n|$)/i.test(d.text)?'load_failed':!d.text?.trim()?'not_loaded':'observed';
    const file=`${current.actionKey}-${attemptId}-${++snapshotCount}.json`;d.evidenceId=file;const bytes=JSON.stringify(d);await fs.writeFile(path.join(runDir,'snapshots',file),bytes);await append('evidence.jsonl',{evidenceId:file,sha256:digest(bytes),actionKey:current.actionKey,observedAt:d.observedAt});
    if(d.state==='verification'){await checkpoint('waiting_verification');await wait({reason:'verification'});throw Error('VERIFICATION_RESUME_RECHECK_REQUIRED');}
    if(['restricted','login_required'].includes(d.state))throw Error('PLATFORM_'+d.state.toUpperCase());
    return d;
  }
  async function go(url){checkAbort();const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:waits.navigationMs});await page.locator('main').waitFor({state:'visible',timeout:waits.mainMs}).catch(()=>null);await page.waitForTimeout(waits.settleMs);checkAbort();return response?.status?.()??null;}
  async function noteAccount(h,d,kind,extra={}){
    h=normalizeHandle(h);if(!h)return null;
    const rec={handle:h,canonicalUrl:`https://www.instagram.com/${h}/`,stableId:null,identityStatus:'provisional_handle',observedAt:d.observedAt,batchId:input.batchId,query:current.query??null,actionKey:current.actionKey,routeId:current.routeId,routeVariant:current.routeVariant||null,seed:current.seed||null,parentSeed:current.parentSeed||current.seed||null,sourceWorkUrl:current.sourceWorkUrl||null,cueEvidenceId:current.cueEvidenceId||null,cueRelationship:current.cueRelationship||null,lookupOnly:current.lookupOnly===true,depth:current.depth??0,sourceUrl:d.url,evidenceKind:kind,evidenceId:d.evidenceId,...extra};
    await append('accounts.jsonl',rec);current.accountHandles.add(h);if(isCandidateEvidence(rec)&&!invalid.has(`${h}|${d.evidenceId}`)){candidates.add(h);if(!baseline.has(h))net.add(h);}return rec;
  }
  async function noteProfile(d,expected){
    const observed=normalizeHandle(d.url);if(d.state!=='observed'||observed!==expected){await append('identity-events.jsonl',{expectedHandle:expected,observedHandle:observed,evidenceId:d.evidenceId,at:d.observedAt});return false;}
    const loadedMedia=[...new Map(d.links.flatMap(l=>{const w=parseInstagramWork(l.href);return w?[[w.shortcode,{...w,caption:null,gridPreviewText:l.alt||l.text||null,previewTextSource:l.alt?'image_alt':l.text?'anchor_text':null}]]:[];})).values()],posts=loadedMedia.slice(0,budget(current,'maxProfilePosts'));
    const privateMessage=/^\s*(此账户为私密账户|这是私密主页|This account is private)\s*$/im.test(d.text),privateObserved=privateMessage&&!loadedMedia.length?true:!privateMessage&&loadedMedia.length?false:null;
    const prof={handle:observed,url:d.url,observedAt:d.observedAt,text:d.text.slice(0,9000),posts,evidenceId:d.evidenceId,actionKey:current.actionKey,private:privateObserved,coverage:{profileText:'visible_snapshot_may_be_folded',posts:'loaded_metadata_only',loadedPostCount:loadedMedia.length,selectedPostCount:posts.length,postBudget:budget(current,'maxProfilePosts'),videoPlaybackVerified:false}};
    await append('profiles.jsonl',prof);await noteAccount(observed,d,'profile',{rawCardText:d.text.slice(0,1800),profileEvidence:prof});return true;
  }
  async function resolveWork(w){
    checkAbort();current.contentIds.add(w.shortcode);const cached=cache.get(w.shortcode);
    if(cached){for(const h of cached.authors)await noteAccount(h,{url:cached.url,observedAt:new Date().toISOString(),evidenceId:cached.evidenceId},'cached_content_author',{contentId:w.shortcode,reusedEvidence:true,originalObservedAt:cached.observedAt});current.cacheHits++;return;}
    let status=await go(w.canonicalUrl),d=await capture('content_detail','main',status);
    if(d.state!=='observed'){stoppedRoutes.set(current.routeId,d.state);return;}
    if(parseInstagramWork(d.url)?.shortcode!==w.shortcode){await append('resolution-events.jsonl',{requestedShortcode:w.shortcode,observedUrl:d.url,event:'content_identity_mismatch',evidenceId:d.evidenceId,actionKey:current.actionKey});stoppedRoutes.set(current.routeId,'content_identity_mismatch');return;}
    // A different layout gets one explicit permalink adaptation; no repeated page retry.
    if(!d.authorHeaderFound&&/\/(?:reel|reels)\//.test(d.url)){status=await go(`https://www.instagram.com/p/${w.shortcode}/`);d=await capture('content_permalink_layout','main',status);}
    if(d.state!=='observed'||parseInstagramWork(d.url)?.shortcode!==w.shortcode){stoppedRoutes.set(current.routeId,'content_identity_or_load_failure');return;}
    const authors=d.authorHeaderFound?[...new Set(d.topLinks.map(l=>normalizeHandle(l.href)).filter(Boolean))]:[];
    const partial=/其他\s*\d+\s*位用户|\d+\s*others/i.test(d.authorHeaderText||'');
    const rec={shortcode:w.shortcode,url:d.url,authors,authorResolution:authors.length?(partial?'coauthors_partial':'visible_header_resolved'):'unresolved',caption:null,pageText:d.text.slice(0,14000),authorHeaderText:d.authorHeaderText,authorHeaderFound:d.authorHeaderFound,times:d.times,format:w.format,evidenceId:d.evidenceId,observedAt:d.observedAt,actionKey:current.actionKey,routeId:current.routeId};
    await append('contents.jsonl',rec);if(authors.length&&!partial)cache.set(w.shortcode,rec);
    for(const h of authors)await noteAccount(h,d,'content_author',{contentId:w.shortcode,authorCount:authors.length,authorCoverage:rec.authorResolution,rawCardText:d.text.slice(0,2400)});
    for(const h of new Set(d.links.filter(l=>/^@/.test(l.text||'')).map(l=>normalizeHandle(l.href)).filter(Boolean)))await append('relations.jsonl',{fromContent:w.shortcode,toHandle:h,relationType:'visible_mention_location_unverified',verificationStatus:'reference_only',evidenceId:d.evidenceId,sourceUrl:d.url,actionKey:current.actionKey,observedAt:d.observedAt});
    if(!authors.length)stoppedRoutes.set(current.routeId,'author_header_unresolved');
  }
  const routeFailure=(reason)=>{stoppedRoutes.set(current.routeId,reason);current.status='partial';return reason;};
  async function runAction(a){
    const start=Date.now();current={...a,batchId:input.batchId,attemptId,actionKey:semanticActionKey(a,input.batchId),startedAt:new Date().toISOString(),status:'running',accountHandles:new Set(),contentIds:new Set(),cacheHits:0};
    await append('actions.jsonl',{...current,accountHandles:[],contentIds:[]});let reason='action_budget';
    try {
      let d=await capture('entry','main',await go(a.url));
      if(d.state!=='observed'){reason=routeFailure(d.state);return;}
      if(['profile_similar','following','profile_enrich','profile_credit_repost','profile_collab_authors'].includes(a.routeId)&&normalizeHandle(d.url)!==a.seed){await append('identity-events.jsonl',{expectedHandle:a.seed,observedHandle:normalizeHandle(d.url),url:d.url,evidenceId:d.evidenceId,at:d.observedAt});reason=routeFailure('identity_mismatch_needs_review');return;}
      if(['profile_similar','following','profile_enrich','profile_credit_repost'].includes(a.routeId)&&!await noteProfile(d,a.seed)){reason=routeFailure('profile_evidence_unavailable');return;}
      if(a.routeId==='profile_enrich'||a.lookupOnly){reason=a.lookupOnly?'named_profile_verified':'profile_observed';return;}
      if(['profile_similar','following'].includes(a.routeId)){
        if(a.routeId==='profile_similar'){
          const btn=page.getByRole('button',{name:/^(类似账户|Similar accounts)$/});if(await btn.count()!==1||!await btn.isVisible()){reason=routeFailure('entry_not_visible');return;}await btn.click();await page.waitForTimeout(waits.settleMs);d=await capture('similar_toggle_result');if(d.state!=='observed'){reason=routeFailure(d.state);return;}
          const all=page.getByRole('link',{name:/^(查看全部|See all)$/});if(await all.count()!==1){reason=routeFailure('see_all_not_visible');return;}await all.click();
        }else{const following=page.getByRole('link',{name:/^[0-9.,万]+\s*(关注|following)$/i});if(await following.count()!==1){reason=routeFailure('following_link_not_unique');return;}await following.click();}
        const collected=new Set();let stale=0;
        for(let j=0;j<budget(a,'maxScrolls')&&collected.size<budget(a,'maxAccounts')&&stale<2;j++){
          checkAbort();await page.waitForTimeout(j?waits.listScrollMs:waits.listInitialMs);d=await capture('account_list_'+j,'dialog');if(d.state!=='observed'||d.scope!=='dialog'){reason=routeFailure(d.scope!=='dialog'?'dialog_not_open':d.state);break;}
          const before=collected.size;for(const l of d.links){const h=normalizeHandle(l.href);if(h&&!collected.has(h)&&collected.size<budget(a,'maxAccounts')){collected.add(h);await noteAccount(h,d,'account_card',{displayName:l.text||null,rawCardText:l.cardText||l.text,listPosition:collected.size});}}
          stale=collected.size===before?stale+1:0;if(net.size>=input.targetCount){reason='target_reached';break;}if(collected.size>=budget(a,'maxAccounts')){reason='account_budget';break;}
          const advanced=await page.evaluate(()=>{const root=document.querySelector('[role="dialog"]');if(!root)return false;const el=[root,...root.querySelectorAll('*')].find(e=>e.scrollHeight>e.clientHeight+60&&/auto|scroll/.test(getComputedStyle(e).overflowY));if(!el)return false;el.scrollTop=el.scrollHeight;return true;});if(!advanced){reason=routeFailure('no_scroll_surface');break;}
        }
        if(!collected.size&&current.status==='running')reason=routeFailure('no_loaded_account_cards');else if(stale>=2)reason='no_new_after_two_checks';
      }else{
        const works=new Map(),absorb=()=>{for(const l of d.links){const w=parseInstagramWork(l.href);if(w&&!works.has(w.shortcode)&&works.size<budget(a,'maxWorks'))works.set(w.shortcode,w);}};
        if(a.workUrls){for(const url of a.workUrls.slice(0,budget(a,'maxWorks'))){const w=parseInstagramWork(url);works.set(w.shortcode,w);}}
        else {absorb();let stale=0;for(let j=0;j<budget(a,'maxScrolls')&&works.size<budget(a,'maxWorks')&&stale<2;j++){checkAbort();const before=works.size;await page.evaluate(()=>window.scrollTo(0,document.scrollingElement.scrollHeight));await page.waitForTimeout(waits.gridMs);d=await capture('content_grid_'+j);if(d.state!=='observed'){reason=routeFailure(d.state);break;}absorb();stale=works.size===before?stale+1:0;}}
        const selected=[...works.values()].filter(w=>!(a.skipKnownWorkIds||[]).includes(w.shortcode)).slice(0,budget(a,'resolveLimit'));
        await append('content-pools.jsonl',{actionKey:current.actionKey,routeId:a.routeId,seed:a.seed||null,url:d.url,observedAt:d.observedAt,loaded:works.size,selected,coverage:'bounded_partial',evidenceId:d.evidenceId});
        if(!works.size)reason=routeFailure('no_loaded_content');
        for(const w of selected){if(stoppedRoutes.has(a.routeId))break;if(net.size>=input.targetCount){reason='target_reached';break;}await resolveWork(w);}
        if(stoppedRoutes.has(a.routeId))reason=routeFailure(stoppedRoutes.get(a.routeId));else if(reason!=='target_reached')reason='content_and_resolution_budget';
      }
    }catch(e){current.status='partial';current.error=String(e.message);reason=e.message;if(/^(PLATFORM_|VERIFICATION_|USER_CANCELLED|TIME_BUDGET_EXCEEDED)/.test(reason))batchStop=reason;else stoppedRoutes.set(a.routeId,'action_error');}
    finally {
      const record={...current,status:current.status==='running'?'completed':current.status,finishedAt:new Date().toISOString(),durationMs:Date.now()-start,accountHandles:[...current.accountHandles],contentIds:[...current.contentIds],stopReason:reason};
      await append('actions.jsonl',record);if(record.status==='completed')completed.add(record.actionKey);current=record;executed++;await checkpoint(reason);
    }
  }
  for(const [i,a]of input.actions.entries()){
    const actionKey=semanticActionKey(a,input.batchId);let reason=null,status='unstarted';
    if(signal?.aborted)batchStop='USER_CANCELLED';
    if(Date.now()>=deadline)batchStop='TIME_BUDGET_EXCEEDED';
    if(completed.has(actionKey)){reason='already_completed';status='skipped';}
    else if(batchStop)reason=batchStop;
    else if(stoppedRoutes.has(a.routeId))reason='route_stopped:'+stoppedRoutes.get(a.routeId);
    else if(net.size>=input.targetCount&&a.routeId!=='profile_enrich')reason='target_reached';
    if(reason){await append('dispatch.jsonl',{batchId:input.batchId,attemptId,actionIndex:i,actionKey,routeId:a.routeId,seed:a.seed||null,status,reason,at:new Date().toISOString()});continue;}
    await runAction(a);
  }
  await checkpoint(batchStop||'batch_finished');
  const goalNotReached=input.actions.some(a=>a.routeId!=='profile_enrich')&&net.size<input.targetCount;
  const state=batchStop||stoppedRoutes.size||goalNotReached?'partial':'complete',result={schemaVersion:'ig-collector-result-v1',moduleVersion:VERSION,validationEvidence:'offline_candidate_only',state,runId:input.runId,batchId:input.batchId,attemptId,executed,netNew:net.size,candidateUnique:candidates.size,baselineCount:baseline.size,targetCount:input.targetCount,targetReached:net.size>=input.targetCount,goalNotReached,stopReason:batchStop||(goalNotReached?'queue_exhausted_before_target':null),routeStops:Object.fromEntries(stoppedRoutes),runDir,qualification:'not_evaluated',coverage:'bounded_visible_evidence',resume:state==='partial'?'Inspect persisted evidence and resolved blocking condition; resubmit the identical input to resume incomplete actions. Changed input requires a new batchId; changed module/baseline/target requires a new runDir.':null};
  await atomic(path.join(outputDir,'result.json'),result);await atomic(path.join(runDir,'result-'+input.batchId+'.json'),result);return result;
}
