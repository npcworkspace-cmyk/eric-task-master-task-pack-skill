// Self-contained Task Master entry. Browser access uses only the supplied page.
import { mkdir, readFile, writeFile, rename, open, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const VERSION = 'tk-fast-0.1.1';
const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const handleKey = value => String(value ?? '').replace(/^https:\/\/(?:www\.)?tiktok\.com\/@/i, '').replace(/^@/, '').replace(/\/$/, '').toLowerCase();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pairKey = (actionId, id) => `${actionId}|${id}`;

export function normalizeInput(input) {
  if (!input?.briefId || !Array.isArray(input.queries) || !input.queries.length) throw new Error('briefId and nonempty queries required');
  const queries = input.queries.map(q => norm(typeof q === 'string' ? q : q?.query));
  if (queries.some(q => !q || q.length > 200) || new Set(queries.map(q => q.toLowerCase())).size !== queries.length) throw new Error('Queries must be nonempty and distinct');
  const result = { firstPassWorks: 60, maxWorksPerQuery: 120, maxScrolls: 100, scrollWaitMs: 2000, searchTimeoutMs: 18000, maxWallMs: 900000, baselineHandles: [], ...input, queries };
  for (const key of ['targetWorks', 'firstPassWorks', 'maxWorksPerQuery', 'maxScrolls', 'scrollWaitMs', 'searchTimeoutMs', 'maxWallMs', 'minFollowers', 'maxFollowers']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < (['minFollowers', 'maxFollowers'].includes(key) ? 0 : 1)) throw new Error(`Explicit valid ${key} required`);
  }
  if (queries.length > 200 || result.targetWorks > 50000 || result.maxWorksPerQuery > 500 || result.firstPassWorks > result.maxWorksPerQuery || result.minFollowers > result.maxFollowers || result.maxScrolls > 300) throw new Error('Input exceeds bounded limits');
  return result;
}

export function pageState(text) {
  if (/将拼图滑块|拼图.*(?:拖动|滑块)|完成安全验证|verify to continue|verify you are human|complete the puzzle|拖动滑块|完成验证|拖动拼图|Drag the slider|Drag the puzzle piece|puzzle piece into place|Security verification/i.test(text)) return 'verification';
  if (/too many attempts|too many requests|操作太频繁|访问过于频繁|Access Denied/i.test(text)) return 'limited';
  if (/登录以搜索|log in to search|login required|log in to continue/i.test(text)) return 'login_required';
  if (/No results|没有结果|找不到[^\n]*的结果|未找到[^\n]*结果/i.test(text)) return 'empty';
  return 'available';
}

function emptyForQuery(text, query) {
  const quoted=text.match(/找不到\s*["“](.*?)["”]\s*的结果/);
  return pageState(text)==='empty' && (!quoted || norm(quoted[1]).toLowerCase()===norm(query).toLowerCase());
}

export function createIndex({ baselineHandles = [] } = {}) {
  return { works: new Map(), authors: new Map(), pairs: new Map(), pending: new Map(), processed: new Set(), baselineHandles: new Set(baselineHandles.map(handleKey)), responseCount: 0, responseIds: new Set() };
}

function compatibleCaption(card, caption) {
  const full = norm(caption), preview = norm(card.caption ?? card.alt), text = norm(card.text);
  if (!full) return false;
  if (preview === full || (preview && preview.includes(full)) || (text && text.includes(full))) return true;
  const prefix = preview.replace(/(?:…|\.{3})(?:\s*(?:more|更多))?\s*$/i, '').trim();
  return prefix.length >= 24 && prefix !== preview && full.startsWith(prefix);
}

function tryMatch(store, key) {
  const card = store.pairs.get(key), pending = store.pending.get(key);
  if (!card || !pending) return;
  for (const [token, entry] of pending) {
    if (store.processed.has(token)) { pending.delete(token); continue; }
    const { item, response } = entry;
    if (handleKey(item.author?.uniqueId) !== handleKey(card.authorHandle) || !compatibleCaption(card, item.caption)) continue;
    const work = store.works.get(String(item.id));
    if (!work || work.authorHandle !== handleKey(item.author.uniqueId)) continue;
    const evidence = { actionId: response.actionId, responseId: response.id, sourceUrl: card.action.sourceUrl, sourceWorkUrl: work.url, observedAt: response.observedAt, scope: 'ui_response_matched_rendered_work_and_author' };
    work.metadata ??= {};
    work.metadata.caption = item.caption;
    if (Number.isFinite(item.createTime) && item.createTime > 0) work.metadata.createTime = item.createTime;
    if (item.stats && Object.keys(item.stats).length) work.metadata.stats = { ...(work.metadata.stats ?? {}), ...item.stats };
    if (Array.isArray(item.textExtra)) work.metadata.textExtra = item.textExtra;
    if (item.music?.id) work.metadata.music = item.music;
    work.metadata.evidence = evidence;
    (work.metadataEvidence ??= []).push(evidence);
    const author = store.authors.get(work.authorHandle);
    if (typeof item.author.signature === 'string' && item.author.signature.trim()) author.bio = item.author.signature;
    if (typeof item.author.nickname === 'string') author.displayName = item.author.nickname;
    if (item.author.id) author.platformId = String(item.author.id);
    const count = item.authorStats?.followerCount;
    if (Number.isFinite(count) && count >= 0 && (!author.followersObservedAt || String(response.observedAt) >= author.followersObservedAt)) {
      author.followers = count; author.followersEvidence = evidence; author.followersObservedAt = response.observedAt;
    }
    author.identityVerified = true;
    store.processed.add(token); pending.delete(token);
  }
  if (!pending.size) store.pending.delete(key);
}

export function ingestCards(store, cards, action) {
  for (const card of cards) {
    let url;
    try { url = new URL(card.url); } catch { continue; }
    const match = url.pathname.match(/^\/@([^/]+)\/(?:video|photo)\/(\d+)\/?$/);
    if (url.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(url.hostname) || !match) continue;
    const id = String(card.id ?? match[2]), authorHandle = handleKey(card.authorHandle ?? match[1]);
    if (id !== match[2] || authorHandle !== handleKey(match[1]) || !action?.id) continue;
    const canonicalUrl = `https://www.tiktok.com${url.pathname.replace(/\/$/, '')}`;
    if (store.works.has(id) && store.works.get(id).authorHandle !== authorHandle) continue;
    if (!store.works.has(id)) store.works.set(id, { id, url: canonicalUrl, authorHandle, firstObservedAt: action.observedAt, captions: [], sources: [] });
    const work = store.works.get(id);
    if (!work.sources.some(s => s.actionId === action.id)) work.sources.push({ actionId: action.id, query: action.query, sourceUrl: action.sourceUrl, observedAt: action.observedAt });
    const caption = card.caption ?? card.alt;
    if (caption && !work.captions.some(c => c.text === caption && c.actionId === action.id)) work.captions.push({ text: caption, source: 'rendered_card_text', actionId: action.id, observedAt: action.observedAt });
    if (card.metric) work.gridMetric = card.metric;
    if (!store.authors.has(authorHandle)) store.authors.set(authorHandle, { handle: authorHandle, url: `https://www.tiktok.com/@${authorHandle}`, followers: null, bio: '', workIds: [], identityVerified: false });
    const author = store.authors.get(authorHandle);
    if (!author.workIds.includes(id)) author.workIds.push(id);
    const key = pairKey(action.id, id);
    store.pairs.set(key, { ...card, id, authorHandle, action });
    tryMatch(store, key);
  }
}

export function ingestResponse(store, response) {
  if (!response?.actionId || !response.id || !Array.isArray(response.items)) return;
  if (!store.responseIds.has(response.id)) { store.responseIds.add(response.id); store.responseCount++; }
  for (const item of response.items) {
    if (!item.id || !item.author?.uniqueId) continue;
    const key = pairKey(response.actionId, String(item.id)), token = `${response.id}|${item.id}`;
    if (store.processed.has(token)) continue;
    if (!store.pending.has(key)) store.pending.set(key, new Map());
    store.pending.get(key).set(token, { item, response: { id: response.id, actionId: response.actionId, observedAt: response.observedAt } });
    tryMatch(store, key);
  }
}

export function summarize(store, { minFollowers, maxFollowers } = {}) {
  const authors = [...store.authors.values()], works = [...store.works.values()];
  const hasBounds = [minFollowers, maxFollowers].every(n => Number.isSafeInteger(n) && n >= 0) && minFollowers <= maxFollowers;
  return { uniqueWorks: works.length, matchedWorks: works.filter(w => w.metadata?.evidence).length, datedWorks: works.filter(w => Number.isFinite(w.metadata?.createTime)).length, uniqueAuthors: authors.length, newAuthors: authors.filter(a => !store.baselineHandles.has(a.handle)).length, followersKnown: authors.filter(a => Number.isFinite(a.followers)).length, followersInRange: hasBounds ? authors.filter(a => Number.isFinite(a.followers) && a.followers >= minFollowers && a.followers <= maxFollowers).length : null, responseCount: store.responseCount, pendingPairs: store.pending.size };
}

export function snapshot(store) {
  return { works: [...store.works], authors: [...store.authors], pairs: [...store.pairs], pending: [...store.pending].map(([key, values]) => [key, [...values]]), processed: [...store.processed], baselineHandles: [...store.baselineHandles], responseCount: store.responseCount, responseIds: [...store.responseIds] };
}
export function restore(saved) {
  return { works: new Map(saved.works), authors: new Map(saved.authors), pairs: new Map(saved.pairs), pending: new Map(saved.pending.map(([key, values]) => [key, new Map(values)])), processed: new Set(saved.processed), baselineHandles: new Set(saved.baselineHandles), responseCount: saved.responseCount, responseIds: new Set(saved.responseIds) };
}

export function replayEvent(store, runtime, event) {
  if (event.type === 'cards') ingestCards(store,event.data.cards,event.data.action);
  if (event.type === 'response') ingestResponse(store,event.data);
  if (event.type === 'action_done') {
    const action=event.data;
    if(!runtime.actions.some(a=>a.id===action.id))runtime.actions.push(action);
    if((runtime.queries[action.query]?.maxPass??0)<=action.pass)runtime.queries[action.query]={maxPass:action.pass,lastResult:action};
  }
}

function readPageDom() {
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const root = document.querySelector('main') ?? document;
  const cards = [...root.querySelectorAll('[data-e2e="search_top-item"]')].filter(visible).flatMap(row => {
    const a = [...row.querySelectorAll('a[href*="/video/"],a[href*="/photo/"]')].find(visible);
    if (!a) return [];
    const m = new URL(a.href).pathname.match(/^\/@([^/]+)\/(?:video|photo)\/(\d+)/);
    if (!m) return [];
    const metric = row.querySelector('[data-e2e="video-views"]');
    return [{ id: m[2], url: a.href, authorHandle: m[1], caption: a.querySelector('img')?.getAttribute('alt') ?? row.querySelector('img')?.getAttribute('alt') ?? '', text: row.innerText.slice(0,4000), metric: metric ? { raw: metric.innerText, semantic: row.querySelector('svg.like-icon') ? 'likes' : 'unconfirmed_grid_metric' } : null }];
  });
  return { url: location.href, text: document.body.innerText.slice(0,30000), cards: [...new Map(cards.map(c => [c.id,c])).values()] };
}

function scrollPageDom() {
  const first = document.querySelector('[data-e2e="search_top-item"]');
  let el = first?.parentElement;
  while (el) {
    if (/auto|scroll|overlay/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 2) break;
    el = el.parentElement;
  }
  el ??= document.scrollingElement ?? document.documentElement;
  const before = el.scrollTop;
  el.scrollTop = Math.min(el.scrollHeight, before + Math.max(100, el.clientHeight * 0.9));
  return { before, after: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight };
}

function extractResponseItems(data) {
  const items = [];
  function visit(value, depth) {
    if (!value || typeof value !== 'object' || depth > 7) return;
    if (value.id && typeof value.desc === 'string' && value.author?.uniqueId) {
      items.push({ id: String(value.id), caption: value.desc, createTime: value.createTime, author: { id: value.author.id, uniqueId: value.author.uniqueId, nickname: value.author.nickname, signature: value.author.signature }, authorStats: value.authorStats ?? null, stats: value.stats ?? null, textExtra: (value.textExtra ?? []).map(t => ({ hashtagName: t.hashtagName, userUniqueId: t.userUniqueId })), music: value.music?.id ? { id: String(value.music.id), title: value.music.title, authorName: value.music.authorName, original: value.music.original } : null });
      return;
    }
    if (Array.isArray(value)) { value.slice(0,2000).forEach(v => visit(v,depth+1)); return; }
    for (const v of Object.values(value)) if (v && typeof v === 'object') visit(v,depth+1);
  }
  visit(data,0); return items;
}

const csv = rows => '\ufeff' + rows.map(row => row.map(value => {const text=String(value??'');const safe=typeof value==='string'&&/^[=+@-]/.test(text)?"'"+text:text;return '"'+safe.replace(/"/g,'""')+'"';}).join(',')).join('\r\n');
async function atomicJson(path, value) { await writeFile(path + '.tmp', JSON.stringify(value)); await rename(path + '.tmp',path); }

export const LEVEL2_VERSION='tk-pipeline-2.1.0';
export function nativeResponseDiagnostic(data,endpoint,httpStatus){
  const code=data.status_code??data.statusCode??null;
  const message=typeof(data.status_msg??data.statusMsg)==='string'?norm(data.status_msg??data.statusMsg).replace(/https?:\/\/\S+/gi,'[url]').replace(/\bBearer\s+\S+/gi,'Bearer [redacted]').replace(/\b(authorization|cookie|token|session[_-]?id|msToken|X-Bogus|_signature)\s*[:=]\s*\S+/gi,'$1=[redacted]').slice(0,300):null;
  return {endpoint,httpStatus,payloadStatusCode:code,payloadStatusMessage:message,searchBusinessError:/^\/api\/search\//.test(endpoint)&&code!==null&&Number(code)!==0};
}
export function rawCardSignature(view){return [...new Set((view.cards??[]).map(c=>String(c.id)))].sort().join('|');}
export function searchReadiness(view,query,responseIds=new Set()){
  let u;try{u=new URL(view.url);}catch{return 'pending';}
  if(u.pathname!=='/search'||u.searchParams.get('q')!==query)return 'pending';
  const quoted=(view.text??'').match(/找不到\s*["“](.*?)["”]\s*的结果|No results for\s*["“](.*?)["”]/i);
  if(!(view.cards??[]).length&&pageState(view.text??'')==='empty'&&quoted&&norm(quoted[1]??quoted[2]).toLowerCase()===norm(query).toLowerCase())return 'explicit_query_empty';
  return (view.cards??[]).some(c=>responseIds.has(String(c.id)))?'current_action_response_cards':'pending';
}
export function retainDomAfterSearchTimeout(view,query,oldSignature){
  let u;try{u=new URL(view.url);}catch{return false;}
  const signature=rawCardSignature(view);return u.pathname==='/search'&&u.searchParams.get('q')===query&&!!signature&&signature!==oldSignature;
}
async function boundedRead(promise,ms){let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);})]);}finally{clearTimeout(timer);}}
function surfaceDom({expectedUrl='',kind='page'}={}) {
  const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const main=document.querySelector('main')??document.body;
  const fullText=document.body.innerText;
  const aInfo=a=>({url:a.href,text:(a.innerText||a.getAttribute('aria-label')||'').slice(0,600),e2e:a.getAttribute('data-e2e'),context:(a.closest('[data-e2e]')?.innerText??a.parentElement?.innerText??'').slice(0,1200)});
  const linksOf=root=>[...root.querySelectorAll('a[href]')].filter(visible).map(aInfo).filter(a=>/^https?:/.test(a.url)).slice(0,700);
  const dialogs=[...document.querySelectorAll('[role="dialog"],[class*="DivFollowContainer"],[data-e2e="user-following-modal"]')].filter(visible).map(e=>({text:e.innerText.slice(0,18000),links:linksOf(e),className:String(e.className),e2e:e.getAttribute('data-e2e')}));
  const fields=[...document.querySelectorAll('[data-e2e]')].filter(e=>visible(e)&&/user-(?:title|subtitle|bio)|followers-count|following-count|likes-count/.test(e.getAttribute('data-e2e')??'')).map(e=>({e2e:e.getAttribute('data-e2e'),text:e.innerText}));
  const controls=[...document.querySelectorAll('button,[role="button"],input,[data-e2e="following-count"],[data-e2e="followers-count"]')].filter(visible).map(e=>({tag:e.tagName,role:e.getAttribute('role'),e2e:e.getAttribute('data-e2e'),testid:e.getAttribute('data-testid'),text:(e.innerText??'').slice(0,250),aria:e.getAttribute('aria-label'),title:e.getAttribute('title'),className:String(e.className).slice(0,220)})).slice(0,180);
  let detail=null;
  const match=expectedUrl.match(/\/@([^/]+)\/(?:video|photo)\/(\d+)/);
  if(match){
    const articles=[...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')].filter(visible);
    const root=articles.find(e=>[...e.querySelectorAll('[id]')].some(x=>new RegExp('^xgwrapper(?:-\\d+)?-'+match[2]+'$').test(x.id))&&[...e.querySelectorAll('a[href]')].some(a=>new URL(a.href).pathname.replace(/\/$/,'')==='/@'+match[1]));
    if(root)detail={id:match[2],authorHandle:match[1],url:expectedUrl,caption:root.querySelector('[data-e2e="video-desc"]')?.innerText??'',text:root.innerText.slice(0,16000),links:linksOf(root),scope:'exact_work_id_and_author'};
  }
  const cards=[];
  for(const a of [...main.querySelectorAll('a[href*="/video/"],a[href*="/photo/"]')].filter(visible)){
    if(kind==='search'&&!a.closest('[data-e2e="search_top-item"]'))continue;
    const m=new URL(a.href).pathname.match(/^\/@([^/]+)\/(?:video|photo)\/(\d+)/);if(!m)continue;
    const row=a.closest('[data-e2e="search_top-item"],[data-e2e="user-post-item"],[data-e2e="challenge-item"],[data-e2e="music-item"]')??a;
    cards.push({id:m[2],authorHandle:m[1],url:a.href,caption:a.querySelector('img')?.alt??row.querySelector('img')?.alt??'',text:row.innerText.slice(0,4000),rowE2e:row.getAttribute('data-e2e')});
  }
  if(detail)cards.push(detail);
  const commentNodes=[...document.querySelectorAll('[data-e2e]')].filter(e=>visible(e)&&/comment/i.test(e.getAttribute('data-e2e')??'')&&e.innerText?.trim()&&!/icon|count|input|post|send/.test(e.getAttribute('data-e2e')??''));
  const comments=commentNodes.slice(0,80).map(e=>({e2e:e.getAttribute('data-e2e'),text:e.innerText.slice(0,3000),links:linksOf(e)}));
  const profileHandle=url=>{try{const u=new URL(url),m=u.pathname.match(/^\/@([^/]+)\/?$/);return ['www.tiktok.com','tiktok.com'].includes(u.hostname)&&m?m[1].toLowerCase():null;}catch{return null;}};
  const ownHandle=profileHandle(expectedUrl),authorCards=[],recommendationModules=[];
  if(kind==='profile'||kind==='profile_recommendations'){
    const headings=[...main.querySelectorAll('h2,h3,h4,span,p,div')].filter(e=>visible(e)&&/^(推荐账号|Suggested accounts|Recommended accounts)$/i.test(e.innerText.trim())&&!e.children.length);
    const seenRoots=new Set();
    for(const heading of headings){let root=heading.parentElement;
      for(let n=0;root&&root!==main&&n<6;n++,root=root.parentElement){
        if(root.innerText.length>18000||root.querySelector('[data-e2e="user-bio"]'))break;
        const links=[...root.querySelectorAll('a[href]')].filter(visible).filter(a=>profileHandle(a.href)&&profileHandle(a.href)!==ownHandle&&!a.getAttribute('data-e2e')?.startsWith('nav-'));
        if(!links.length)continue;if(seenRoots.has(root))break;seenRoots.add(root);
        recommendationModules.push({heading:heading.innerText.trim(),text:root.innerText.slice(0,18000),links:links.map(aInfo)});
        for(const a of links){const handle=profileHandle(a.href);if(authorCards.some(c=>c.handle===handle))continue;
          let card=a;for(let j=0;j<4&&card.parentElement&&card.parentElement!==root;j++){const up=card.parentElement,handles=new Set([...up.querySelectorAll('a[href]')].map(x=>profileHandle(x.href)).filter(Boolean));if(handles.size>1||up.innerText.length>1500)break;card=up;}
          const reasonText=(card.innerText.split('\n').find(t=>/可能认识|People you may know|Suggested for you|Follows you|关注了你|共同关注|mutual/i.test(t))??'').trim();
          authorCards.push({handle,url:'https://www.tiktok.com/@'+handle,displayName:(a.innerText||a.getAttribute('aria-label')||a.querySelector('img')?.alt||'').trim(),reasonText,rank:authorCards.length+1,containerScope:'profile_suggested_accounts',cardText:card.innerText.slice(0,1500)});
        }break;
      }
    }
  }

  const verificationVisible=[...document.querySelectorAll('[id*="captcha"],[class*="captcha"],iframe[src*="captcha"]')].some(visible);
  return {authorCards,recommendationModules,url:location.href,expectedUrl,kind,observedAt:new Date().toISOString(),verificationVisible,text:fullText.slice(0,22000),mainText:main.innerText.slice(0,22000),links:linksOf(main),dialogs,fields,controls,detail,cards:[...new Map(cards.map(c=>[c.id,c])).values()],comments};
}

function scrollSurfaceDom(){
  const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const root=dialogs.at(-1)??document.querySelector('main')??document.body;
  const containers=[root,...root.querySelectorAll('*')].filter(e=>visible(e)&&/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+50);
  const e=containers.sort((a,b)=>b.clientHeight-a.clientHeight)[0]??document.scrollingElement;
  const before=e.scrollTop;e.scrollTop=Math.min(e.scrollHeight,before+Math.max(300,e.clientHeight*.9));
  return {before,after:e.scrollTop,height:e.scrollHeight,viewport:e.clientHeight};
}

export async function run({page,input,outputDir,progress,wait,signal}){
  const startedAt=new Date().toISOString(),start=Date.now(),limits=input.limits,executedCodeSha256=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  if(!input.briefId||!Array.isArray(input.seeds))throw Error('Invalid level2 input');
  await mkdir(outputDir,{recursive:true});
  const log=await open(join(outputDir,'observations.jsonl'),'a');let seq=0,active=null,error=null,writeFailure=null;
  const store=createIndex(input),actions=[],pending=new Set(),requestActions=new WeakMap(),responseWorkIds=new Map();let writes=Promise.resolve();
  const record=async(type,data)=>{const event={seq:++seq,type,data};writes=writes.then(()=>log.write(JSON.stringify(event)+'\n'));await writes;return event.seq;};
  const relevant=req=>{try{const u=new URL(req.url());return u.hostname==='www.tiktok.com'&&u.pathname.startsWith('/api/')&&/search|item_list|post\/item|music|challenge|comment|user\/list|recommend/.test(u.pathname);}catch{return false;}};
  const onRequest=req=>{if(relevant(req)&&active){const requestQuery=new URL(req.url()).searchParams.get('keyword');if(active.query&&requestQuery&&norm(requestQuery)!==norm(active.query))return;requestActions.set(req,{id:active.id,url:active.url});}};
  const onResponse=res=>{const scope=requestActions.get(res.request());if(!scope)return;const job=(async()=>{if([403,429].includes(res.status())){await record('http_limit',{actionId:scope.id,status:res.status(),endpoint:new URL(res.url()).pathname});error='ACCESS_LIMIT';return;}let data;try{if(!(res.headers()['content-type']??'').includes('json'))return;data=await boundedRead(res.json(),5000);if(!data){await record('response_read_timeout',{actionId:scope.id,endpoint:new URL(res.url()).pathname});return;}}catch{return;}const endpoint=new URL(res.url()).pathname,diagnostic=nativeResponseDiagnostic(data,endpoint,res.status());await record('native_response_summary',{actionId:scope.id,...diagnostic});if(diagnostic.searchBusinessError){error='SEARCH_NATIVE_RESPONSE_ERROR_'+String(diagnostic.payloadStatusCode).slice(0,30);return;}const items=extractResponseItems(data);if(!items.length)return;const response={id:scope.id+':r'+Date.now()+':'+seq,actionId:scope.id,observedAt:new Date().toISOString(),endpoint,items};await record('response',response);if(!responseWorkIds.has(scope.id))responseWorkIds.set(scope.id,new Set());for(const item of items)responseWorkIds.get(scope.id).add(String(item.id));ingestResponse(store,response);})();pending.add(job);job.then(()=>pending.delete(job),e=>{writeFailure=e;pending.delete(job);});};
  page.on('request',onRequest);page.on('response',onResponse);
  async function drain(){await Promise.all([...pending]);await writes;if(writeFailure)throw writeFailure;}
  async function save(){await drain();await log.sync();await atomicJson(join(outputDir,'checkpoint.json'),{version:LEVEL2_VERSION,startedAt,input,actions,store:snapshot(store),seq,error});}
  async function checkExecutionControl(){
    let control={};
    if(input.controlFile){try{control=JSON.parse((await readFile(input.controlFile,'utf8')).replace(/^\uFEFF/,''));}catch(e){throw Error('CONTROL_FILE_UNREADABLE:'+e.code);}}
    if(/paused|cooling|stopped|cancelled/.test(control.status??''))throw Error('USER_PAUSED');
    for(const value of [input.notBefore,control.notBefore].filter(Boolean)){if(!Number.isFinite(Date.parse(value)))throw Error('INVALID_COOLDOWN');if(Date.now()<Date.parse(value))throw Error('COOLDOWN_ACTIVE');}
    if(error==='ACCESS_LIMIT'||error?.startsWith('SEARCH_NATIVE_RESPONSE_ERROR'))throw Error(error);
    if(input.stage==='seed'&&input.compilation?.status!=='ready')throw Error('REFERENCE_ANALYSIS_NOT_READY');
  }
  async function inspect(kind,url){await checkExecutionControl();const v=await page.evaluate(surfaceDom,{kind,expectedUrl:url});const state=v.verificationVisible?'verification':pageState(v.text);if(state==='verification'||state==='login_required'){await record('access',{action:active,state,view:v});await save();await page.screenshot({path:join(outputDir,'verification.png'),fullPage:false,timeout:6000}).catch(()=>{});await progress({message:`Paused: ${state}; ${actions.length} actions saved`});await wait({reason:state==='verification'?'verification':'login_required'});return inspect(kind,url);}if(state==='limited'||error==='ACCESS_LIMIT')throw Error('ACCESS_LIMIT');if(signal?.aborted)throw Error('CANCELLED');if(Date.now()-start>limits.maxWallMs)throw Error('WALL_BUDGET');return v;}
  async function dismiss(){const close=page.locator('[data-e2e="modal-close-inner-button"][role="button"]:visible');if(await close.count()===1&&/^(关闭|close)$/i.test((await close.getAttribute('aria-label')??'').trim()))await close.click({timeout:2500}).catch(()=>{});}
  async function goto(url,kind){await inspect('before_navigation',page.url());await page.goto(url,{waitUntil:'domcontentloaded',timeout:35000});await page.waitForFunction(({kind})=>{const t=document.body?.innerText??'';return /verify to continue|Security verification|暂无|不可用|找不到|Couldn't find|unavailable|private|私密|登录以/.test(t)||(kind==='profile'?!!document.querySelector('[data-e2e="user-title"],[data-e2e="user-subtitle"]'):kind==='content'?!!document.querySelector('[data-e2e="video-desc"]'):!!document.querySelector('a[href*="/video/"],a[href*="/photo/"]'));},{kind},{timeout:limits.pageWaitMs}).catch(()=>{});await dismiss();return inspect(kind,url);}
  async function commitView(view,action){const n=await record('surface',{action,view});
    for(const card of view.authorCards??[]){if(!store.authors.has(card.handle))store.authors.set(card.handle,{handle:card.handle,url:card.url,bio:'',followers:null,workIds:[],identityVerified:false});const author=store.authors.get(card.handle);(author.recommendationEvidence??=[]).push({actionId:action.id,seq:n,sourceUrl:view.url,observedAt:view.observedAt,reasonText:card.reasonText,rank:card.rank});}
    if(action.kind==='profile'){
      const expected=(action.seed??new URL(action.url).pathname.slice(2)).toLowerCase(),actual=view.fields.find(f=>f.e2e==='user-subtitle')?.text.replace(/^@/,'').trim().toLowerCase();
      if(actual===expected){if(!store.authors.has(expected))store.authors.set(expected,{handle:expected,url:'https://www.tiktok.com/@'+expected,workIds:[],followers:null,bio:'',identityVerified:true});const author=store.authors.get(expected),raw=view.fields.find(f=>f.e2e==='followers-count')?.text??'',match=raw.replace(/,/g,'').match(/^([\d.]+)\s*([KMB万亿])?$/i);author.bio=view.fields.find(f=>f.e2e==='user-bio')?.text??author.bio;author.profileEvidence={actionId:action.id,seq:n,sourceUrl:view.url,observedAt:view.observedAt};if(match){author.followers=Number(match[1])*({K:1e3,M:1e6,B:1e9,'万':1e4,'亿':1e8}[match[2]?.toUpperCase()]??1);author.followersRaw=raw;author.followersEvidence={...author.profileEvidence,scope:'profile_header_rounded_count'};author.followersObservedAt=view.observedAt;}}
    }
    if(view.cards.length)ingestCards(store,view.cards,{id:action.id,query:action.query??action.route,sourceUrl:view.url,observedAt:view.observedAt});await drain();return n;}
  async function begin(action){await checkExecutionControl();active={...action,id:action.id??hash([input.briefId,action.seed,action.route,action.url]).slice(0,20),startedAt:new Date().toISOString()};await record('action_start',active);return active;}
  async function done(action,extra){const result={...action,...extra,wallMs:Date.now()-Date.parse(action.startedAt),finishedAt:new Date().toISOString()};actions.push(result);await record('action_done',result);await save();await progress({current:actions.length,message:`${input.phase}: ${actions.length} actions; ${summarize(store,input).uniqueAuthors} observed authors; ${action.seed??''} ${action.route} ${extra.status}`});active=null;return result;}
  async function inspectControl(seed,route,selector,before){const a=await begin({seed:seed.handle,route,url:seed.url});const loc=page.locator(selector);let status='entry_not_visible',view=before,clicked=false;
    if(await loc.count()===1&&await loc.isVisible()){
      try{await loc.click({timeout:3500});clicked=true;await page.waitForFunction(t=>document.body.innerText!==t,before.text,{timeout:2500}).catch(()=>{});await page.waitForTimeout(300);view=await inspect('profile_relationship',seed.url);status=/出错了|Something went wrong/.test(view.mainText)?'page_error_no_relationship_list':view.dialogs.some(d=>/Following|Followers|已关注|粉丝/.test(d.text))?'relationship_dialog_observed':view.mainText!==before.mainText?'surface_changed_unverified_relationship':'no_visible_change';}catch(e){status='control_not_actionable';}
    }
    const evidenceSeq=await commitView(view,a);await done(a,{status,clicked,evidenceSeq,dialogCount:view.dialogs.length});
    if(clicked){await page.keyboard.press('Escape').catch(()=>{});if((await page.evaluate(surfaceDom,{expectedUrl:seed.url})).dialogs.length)await goto(seed.url,'profile');}
  }
  try{
    await checkExecutionControl();
    if(input.recoveryUrl){await begin({seed:'recovery',route:'verify_previous_challenge_surface',url:input.recoveryUrl});const v=await goto(input.recoveryUrl,'content');const evidenceSeq=await commitView(v,active);await done(active,{status:'page_access_recovered',evidenceSeq});}
    if(input.phase==='inventory')for(const seed of input.seeds.slice(input.seedOffset??0,(input.seedOffset??0)+(input.seedLimit??input.seeds.length))){
      let a=await begin({seed:seed.handle,route:'profile_inventory',url:seed.url}),v=await goto(seed.url,'profile');
      await page.waitForFunction(()=>document.querySelector('[data-e2e="nav-search"]')&&(/出错了|Something went wrong/.test(document.body.innerText)||document.querySelector('main a[href*="/video/"]')),null,{timeout:6000}).catch(()=>{});v=await inspect('profile',seed.url);
      const expected=seed.handle.toLowerCase(),actual=v.fields.find(f=>f.e2e==='user-subtitle')?.text.replace(/^@/,'').trim().toLowerCase();
      const evidenceSeq=await commitView(v,a);await done(a,{status:actual===expected?'profile_header_observed':'profile_not_verified',evidenceSeq,ownWorks:v.cards.filter(c=>c.authorHandle.toLowerCase()===expected).length,contentGridStatus:/出错了|Something went wrong/.test(v.mainText)?'page_error':v.cards.length?'visible_sample':'not_rendered'});
      if(actual===expected){
        for(const [route,sel] of [['following','[data-e2e="following-count"]'],['followers','[data-e2e="followers-count"]']]){await inspectControl(seed,route,sel,await inspect('profile',seed.url));}
        const now=await inspect('profile',seed.url),suggest=now.controls.find(c=>c.e2e&&/suggest|recommend/i.test(c.e2e)&&!/^关注$|^Follow$/.test(c.text));
        if(suggest)await inspectControl(seed,'suggested_accounts',`[data-e2e="${suggest.e2e}"]`,now);
        else{const x=await begin({seed:seed.handle,route:'suggested_accounts',url:seed.url});const evidenceSeq=await commitView(now,x);await done(x,{status:'no_named_recommendation_control_visible',evidenceSeq});}
      }
      a=await begin({seed:seed.handle,route:'content_inventory',url:seed.workUrl});v=await goto(seed.workUrl,'content');let evidenceSeq2=await commitView(v,a);
      if(v.detail&&!input.skipCommentControls){const button=page.locator('[data-e2e="comment-icon"][role="button"]:visible');if(await button.count()===1){await button.click({timeout:3000}).catch(()=>{});await page.waitForFunction(()=>[...document.querySelectorAll('[data-e2e]')].some(e=>/comment-level|comment-item|comment-list/.test(e.getAttribute('data-e2e')??'')&&e.getClientRects().length),null,{timeout:4500}).catch(()=>{});v=await inspect('content_comments',seed.workUrl);evidenceSeq2=await commitView(v,a);}}
      await done(a,{status:v.detail?'exact_content_observed':'content_not_verified',evidenceSeq:evidenceSeq2,commentContainers:v.comments.length,detailLinks:v.detail?.links.length??0});
      a=await begin({seed:seed.handle,route:'content_recommendations',url:seed.workUrl});
      const related=page.getByRole('button',{name:/^(猜你喜欢|You may like|Recommended)$/i});let clicked=false;
      if(!input.skipRecommendationControls&&await related.count()===1){await related.click({timeout:3000}).catch(()=>{});clicked=true;await page.waitForFunction(()=>!!document.querySelector('a[href*="/video/"] img'),null,{timeout:4500}).catch(()=>{});v=await inspect('content_recommendations',seed.workUrl);}
      const ev=await commitView(v,a);await done(a,{status:input.skipRecommendationControls?'branch_paused_after_repeated_product_only_samples':clicked?v.cards.some(c=>c.authorHandle.toLowerCase()!==seed.handle.toLowerCase())?'recommended_works_observed':'tab_opened_no_other_work_links':'entry_not_visible',clicked,evidenceSeq:ev,commentControlSkipped:input.skipCommentControls??false});
    }
    else if(input.phase==='expand')for(const sourceAction of input.actions){
      if(limits.totalWorks&&store.works.size>=limits.totalWorks)break;
      const a=await begin(sourceAction);let v,readinessStatus='not_applicable';
      try{
        if(a.query){
          if(!page.url().startsWith('https://www.tiktok.com'))await goto('https://www.tiktok.com/','page');await dismiss();
          let box=page.locator('input[data-e2e="search-user-input"]:visible').first();if(!await box.count()){await page.locator('[data-e2e="nav-search"]').click({timeout:5000});box=page.locator('input[data-e2e="search-user-input"]:visible').first();}
          const old=rawCardSignature(await inspect('search',a.url));await box.fill(a.query);
          const suggestions=await page.evaluate(()=>{const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';return [...document.querySelectorAll('[data-e2e]')].filter(e=>visible(e)&&/search.*suggest|related.*search|search.*related/.test(e.getAttribute('data-e2e')??'')).filter(e=>!/recent searches|search history|搜索历史|最近搜索/i.test(e.closest('[role="dialog"]')?.innerText??e.parentElement?.innerText??'')).slice(0,20).map(e=>({e2e:e.getAttribute('data-e2e'),text:e.innerText.slice(0,1000)}));});
          await record('public_search_suggestions',{actionId:a.id,query:a.query,status:suggestions.length?'suggestion_named_elements_observed':'no_verified_public_suggestion_elements',suggestions});await box.press('Enter');
          const deadline=Date.now()+limits.pageWaitMs;let ready=false;
          while(Date.now()<deadline){await drain();v=await inspect('search',page.url());readinessStatus=searchReadiness(v,a.query,responseWorkIds.get(a.id));if(readinessStatus!=='pending'){ready=true;break;}await new Promise(r=>setTimeout(r,120));}
          if(!ready){
            await record('action_error',{action:a,error:'SEARCH_READINESS_TIMEOUT',recoverable:true,rawView:v,expectedQuery:a.query});
            if(!retainDomAfterSearchTimeout(v,a.query,old))throw Error('SEARCH_RESULTS_NOT_RENDERED_TIMEOUT');
            readinessStatus='timeout_unpaired_dom_sample';
          }
        }else if(a.kind==='profile'&&a.enterFromSearch){
          const pathname=new URL(a.url).pathname;const link=page.locator('a[href="'+a.url+'"]:visible,a[href="'+pathname+'"]:visible').first();
          if(!await link.count())throw Error('NO_OBSERVED_PROFILE_LINK_ON_CURRENT_PAGE');
          await link.click({timeout:4000});await page.waitForURL(u=>u.pathname.replace(/\/$/,'')===pathname.replace(/\/$/,''),{timeout:8000});
          v=await inspect('profile',a.url);
        }else v=await goto(a.url,a.kind??'collection');
        if(!a.query&&new URL(v.url).pathname.replace(/\/$/,'')!==new URL(a.url).pathname.replace(/\/$/,''))throw Error('TARGET_PAGE_REDIRECTED');
        if(a.kind==='profile'&&a.route==='profile_suggested_accounts'){
          await page.waitForFunction(()=>!!document.querySelector('[data-e2e="nav-search"]')&&/视频|Videos|出错了|Something went wrong|推荐账号|Suggested accounts/i.test(document.body.innerText),null,{timeout:8000}).catch(()=>{});
          v=await inspect('profile',a.url);
          await commitView(v,a);
          if(!v.authorCards.length){
            const named=v.controls.find(c=>c.e2e&&/suggest|recommend/i.test(c.e2e)&&!/^关注$|^Follow$/.test(c.text));
            if(named){const control=page.locator('[data-e2e="'+named.e2e+'"]');if(await control.count()===1){await control.click({timeout:3000});await page.waitForFunction(()=>/推荐账号|Suggested accounts|Recommended accounts/i.test(document.body.innerText),null,{timeout:3000}).catch(()=>{});v=await inspect('profile',a.url);}}
          }
          if(v.recommendationModules.length){
            const more=page.getByText(/^(查看全部|See all|View all)$/i,{exact:true});
            if(await more.count()===1&&await more.isVisible()){await more.click({timeout:3000});await page.waitForTimeout(500);v=await inspect('profile',a.url);}
          }
        }
        const ids=new Set(),rawIds=new Set();let evidenceSeq=null,unchanged=0,stop='visible_sample',previousRawSignature=null;
        for(let n=0;n<=limits.maxScrolls;n++){
          const rawSignature=rawCardSignature(v);for(const c of v.cards)rawIds.add(c.id);
          unchanged=rawSignature===previousRawSignature?unchanged+1:0;previousRawSignature=rawSignature;
          const sample=a.authorOnly?{...v,cards:v.cards.filter(c=>c.authorHandle?.toLowerCase()===a.authorOnly.toLowerCase()),rawCardCount:v.cards.length,rawCardSignature:rawSignature,sampleScope:'search_results_filtered_to_exact_author_not_recent_timeline'}:v;
          evidenceSeq=await commitView(sample,a);for(const c of sample.cards)ids.add(c.id);
          if(ids.size>=(a.workLimit??limits.collectionWorks)||(limits.totalWorks&&store.works.size>=limits.totalWorks)){stop='sample_limit';break;}if(unchanged>=2||a.kind==='profile'){stop=a.kind==='profile'?'profile_sample':'no_new_rendered_works';break;}
          if(n===limits.maxScrolls){stop='scroll_budget';break;}
          await page.evaluate(scrollSurfaceDom);const scrollDeadline=Date.now()+Math.min(limits.scrollWaitMs??5000,limits.pageWaitMs);let changed=false;
          while(Date.now()<scrollDeadline){await drain();v=await inspect(a.query?'search':a.kind??'collection',a.url);if(rawCardSignature(v)!==rawSignature){changed=true;break;}await new Promise(r=>setTimeout(r,120));}
          if(!changed){const finalSample=a.authorOnly?{...v,cards:v.cards.filter(c=>c.authorHandle?.toLowerCase()===a.authorOnly.toLowerCase()),rawCardCount:v.cards.length,rawCardSignature:rawCardSignature(v),sampleScope:'search_results_filtered_to_exact_author_not_recent_timeline'}:v;evidenceSeq=await commitView(finalSample,a);await record('action_error',{action:a,error:'SCROLL_RENDER_TIMEOUT',recoverable:true,rawCardCount:v.cards.length});stop='scroll_render_timeout';break;}
        }
        await done(a,{status:ids.size?'sample_observed':/出错了|Something went wrong/.test(v.text)?'page_error':readinessStatus==='explicit_query_empty'?'explicit_empty':a.authorOnly&&rawIds.size?'no_rendered_works_for_requested_author':'no_rendered_works',evidenceSeq,works:ids.size,rawRenderedWorks:rawIds.size,readinessStatus,recommendedAccounts:(v.authorCards??[]).length,stopReason:stop});
      }catch(e){if(/ACCESS_LIMIT|CANCELLED|WALL_BUDGET|NATIVE_RESPONSE_ERROR|USER_PAUSED|COOLDOWN|CONTROL_FILE|REFERENCE_ANALYSIS_NOT_READY/.test(e.message))throw e;const ev=await record('action_error',{action:a,error:String(e.message)});await done(a,{status:'action_error',evidenceSeq:ev,error:String(e.message)});}
    }
  }catch(e){error=String(e.message);await record('run_error',{error,action:active});}
  finally{page.off('request',onRequest);page.off('response',onResponse);await save();await log.close();}
  const result={version:LEVEL2_VERSION,executedCodeSha256,phase:input.phase,startedAt,finishedAt:new Date().toISOString(),wallMs:Date.now()-start,status:error?'partial':'bounded_actions_complete',stopReason:error??(limits.totalWorks&&store.works.size>=limits.totalWorks?'work_target_reached':'all_requested_actions_attempted'),actions:actions.length,...summarize(store,input),qualified:0};
  await atomicJson(join(outputDir,'result.json'),result);return result;
}
