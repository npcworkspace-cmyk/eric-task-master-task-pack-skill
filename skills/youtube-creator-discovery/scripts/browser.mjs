import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export const VERSION='0.1.3';
export const hash=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
export function actionKey(a){const {id,...job}=a;return hash(job).slice(0,24);}
export function parseMetric(raw){if(raw==null||raw==='')return{raw:raw??null,value:null,approximate:null};const m=String(raw).replaceAll(',','').match(/([\d.]+)\s*(亿|万|[KMB])?/i);if(!m)return{raw,value:null,approximate:null};const n=Number(m[1]),unit=m[2]?.toUpperCase();return{raw,value:Number.isFinite(n)?Math.round(n*({K:1e3,M:1e6,B:1e9,'万':1e4,'亿':1e8}[unit]||1)):null,approximate:!!unit};}
export function validate(input){
 if(!input.projectId||!input.briefVersion||!path.isAbsolute(input.runDir))throw Error('projectId, briefVersion and absolute runDir required');
 if(!Number.isInteger(input.targetCount)||input.targetCount<1||!Number.isFinite(input.maxMinutes)||input.maxMinutes<=0)throw Error('finite targetCount and maxMinutes required');
 if(!Array.isArray(input.actions)||!input.actions.length)throw Error('bounded actions required');
 for(const a of input.actions){const u=new URL(a.url);if(u.protocol!=='https:'||u.hostname!=='www.youtube.com')throw Error('Only www.youtube.com HTTPS actions');if(!a.route||!Number.isInteger(a.maxScrolls)||a.maxScrolls<0||a.maxScrolls>100||!Number.isInteger(a.maxCards)||a.maxCards<1||a.maxCards>2000)throw Error('route and bounded maxScrolls/maxCards required');}
}
// Executes inside the current Task Master page. Only mounted cards are observations;
// renderer payloads provide stable identities for those same cards, never extra candidates.
export function capturePage(){
 const textOf=x=>typeof x==='string'?x:x?.simpleText??x?.content??x?.runs?.map(y=>y.text||'').join('')??'';
 const canon=h=>{try{const u=new URL(h,location.href);if(u.hostname!=='www.youtube.com'&&u.hostname!=='youtube.com')return null;if(/^\/@[^/]+|^\/channel\/UC[\w-]+/.test(u.pathname))return 'https://www.youtube.com'+u.pathname.replace(/\/(videos|shorts|featured|about|streams|playlists|join).*$/,'');}catch{}return null;};
 const stableMap=new Map();let traversed=0;
 const walk=(v)=>{if(!v||typeof v!=='object'||++traversed>150000)return;for(const[k,x]of Object.entries(v)){if(/^(videoRenderer|compactVideoRenderer|playlistVideoRenderer|channelRenderer|lockupViewModel|playlistRenderer)$/.test(k)){const id=x.videoId||x.channelId||x.contentId||x.playlistId;if(id)stableMap.set(id,{kind:k,data:x});}if(!/menu|tracking|player|logging|thumbnail|adSlot|serviceEndpoint/i.test(k))walk(x);}};
 walk(window.ytInitialData?.contents);
 for(const el of document.querySelectorAll('ytd-item-section-renderer,ytd-rich-item-renderer,ytd-playlist-video-list-renderer'))walk(el.data);
 function author(r){
  const runs=r.ownerText?.runs||r.longBylineText?.runs||r.shortBylineText?.runs||[];
  for(const x of runs){const b=x.navigationEndpoint?.browseEndpoint;if(/^UC[\w-]{22}$/.test(b?.browseId||''))return {channelId:b.browseId,name:x.text||null,url:canon(b.canonicalBaseUrl)||'https://www.youtube.com/channel/'+b.browseId};}
  if(/^UC[\w-]{22}$/.test(r.channelId||''))return{channelId:r.channelId,name:textOf(r.title),url:canon(r.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl)||'https://www.youtube.com/channel/'+r.channelId};
  let found=null;const seek=(o)=>{if(found||!o||typeof o!=='object')return;const b=o.browseEndpoint;if(/^UC[\w-]{22}$/.test(b?.browseId||''))found={channelId:b.browseId,url:canon(b.canonicalBaseUrl)||'https://www.youtube.com/channel/'+b.browseId,name:null};for(const[k,v]of Object.entries(o))if(!/menu|tracking|thumbnail/i.test(k))seek(v);};seek(r.metadata);if(found)found.name=r.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content||null;return found;
 }
 const meta=window.ytInitialData?.metadata?.channelMetadataRenderer;
 const headerText=document.body.innerText.slice(0,1600);
 const profile=meta&&/^\/(?:@|channel\/)/.test(location.pathname)?{channelId:meta.externalId,name:meta.title,url:canon(meta.vanityChannelUrl||meta.channelUrl),description:meta.description||null,headerText,subscriberRaw:headerText.match(/[\d.,]+\s*(?:万|亿|[KMB])?\s*(?:位订阅者|subscribers)/i)?.[0]||null}:null;
 const cards=[]; const elems=document.querySelectorAll('ytd-video-renderer,ytd-channel-renderer,ytd-playlist-renderer,ytd-compact-video-renderer,yt-lockup-view-model,ytd-playlist-video-renderer,ytm-shorts-lockup-view-model');
 for(const el of elems){
  if(!el.getClientRects().length||el.closest('ytd-ad-slot-renderer,ytd-search-pyv-renderer,ytd-in-feed-ad-layout-renderer'))continue;
  const anchors=[...el.querySelectorAll('a[href]')]; const video=anchors.find(a=>/^\/watch\?v=|^\/shorts\/[\w-]+/.test(a.getAttribute('href')||''));
  const pl=anchors.find(a=>(a.getAttribute('href')||'').startsWith('/playlist?list='));
  const chan=anchors.find(a=>canon(a.href)); const raw=el.data&&typeof el.data==='object'?el.data:null;
  const playlistCard=!!pl&&['YT-LOCKUP-VIEW-MODEL','YTD-PLAYLIST-RENDERER'].includes(el.tagName);
  const href=playlistCard?pl.href:video?.href||pl?.href||chan?.href; if(!href)continue;
  const u=new URL(href);const id=raw?.videoId||raw?.channelId||raw?.playlistId||u.searchParams.get('v')||u.searchParams.get('list')||u.pathname.match(/\/shorts\/([\w-]+)/)?.[1]||u.pathname.match(/\/channel\/([\w-]+)/)?.[1];
  const r=raw||stableMap.get(id)?.data||{};const kind=el.tagName==='YTD-CHANNEL-RENDERER'?'channel':playlistCard?'playlist':r.contentType==='LOCKUP_CONTENT_TYPE_PLAYLIST'?'playlist':'video';
  let owner=author(r);if(!owner&&chan)owner={channelId:null,url:canon(chan.href),name:chan.innerText||null};
  if(!owner&&profile&&kind==='video'&&/\/videos$|\/shorts$|\/streams$/.test(location.pathname))owner={channelId:profile.channelId,url:profile.url,name:profile.name};
  if(owner&&chan?.innerText&&!owner.name)owner.name=chan.innerText.trim();
  const contentFormat=kind==='video'?u.pathname.startsWith('/shorts/')?'shorts':'video':null;
  cards.push({kind,id:id||null,contentFormat,title:textOf(r.title)||textOf(r.metadata?.lockupMetadataViewModel?.title)||textOf(r.overlayMetadata?.primaryText)||el.querySelector('h3')?.textContent?.trim()||el.innerText.split('\n')[0],url:kind==='video'&&id?'https://www.youtube.com/'+(contentFormat==='shorts'?'shorts/':'watch?v=')+id:kind==='playlist'&&id?'https://www.youtube.com/playlist?list='+id:owner?.url||href,owner,viewsRaw:textOf(r.viewCountText)||textOf(r.overlayMetadata?.secondaryText)||null,publishedRaw:textOf(r.publishedTimeText)||null,durationRaw:textOf(r.lengthText)||null,description:r.descriptionSnippet?textOf(r.descriptionSnippet):r.detailedMetadataSnippets?.map(x=>textOf(x.snippetText)).join(' ')||null,cardText:el.innerText.slice(0,1600),evidenceKind:'mounted_card',renderer:el.tagName});
 }
 const v=window.ytInitialPlayerResponse?.videoDetails;
 const currentVideoId=location.pathname==='/watch'?new URL(location.href).searchParams.get('v'):location.pathname.match(/^\/shorts\/([\w-]+)$/)?.[1];
 const details=v&&currentVideoId&&v.videoId===currentVideoId?{id:v.videoId,channelId:v.channelId,title:v.title,author:v.author,description:v.shortDescription||null,contentFormat:location.pathname.startsWith('/shorts/')?'shorts':'video'}:null;
 const descriptionEl=document.querySelector('ytd-text-inline-expander,ytd-watch-metadata #description');
 const mentions=descriptionEl?[...descriptionEl.querySelectorAll('a[href]')].map(a=>({url:canon(a.href),text:a.innerText})).filter(x=>x.url):[];
 return{url:location.href,title:document.title,observedAt:new Date().toISOString(),pageText:document.body.innerText.slice(0,2400),cards,profile,details,mentions,visibleChips:[...document.querySelectorAll('yt-chip-cloud-chip-renderer')].map(e=>e.innerText).filter(Boolean),hasContinuation:[...document.querySelectorAll('ytd-continuation-item-renderer')].some(e=>e.getClientRects().length>0)};
}
export async function run({page,input,outputDir,progress,wait,signal}){
 validate(input);const dir=input.runDir;await fs.mkdir(path.join(dir,'evidence'),{recursive:true});
 const read=async f=>{try{return JSON.parse(await fs.readFile(path.join(dir,f),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
 const atomic=async(f,v)=>{const p=path.join(dir,f);await fs.writeFile(p+'.tmp',JSON.stringify(v,null,2));await fs.rename(p+'.tmp',p);};
 const project={projectId:input.projectId,briefVersion:input.briefVersion,targetCount:input.targetCount,baselineIds:[...(input.baselineIds||[])].sort()};
 const existing=await read('project.json');if(existing&&hash(existing)!==hash(project))throw Error('PROJECT_CONTRACT_MISMATCH');if(!existing)await atomic('project.json',project);
 const records=[];for(const n of (await fs.readdir(path.join(dir,'evidence'))).filter(n=>n.endsWith('.json')).sort()){const r=JSON.parse(await fs.readFile(path.join(dir,'evidence',n),'utf8'));records.push(r);}
 const baseline=new Set(project.baselineIds),seen=new Set(),done=new Set();
 for(const r of records){for(const c of r.cards||[])if(c.owner?.channelId&&r.countDiscovery&&c.kind!=='playlist'&&!baseline.has(c.owner.channelId))seen.add(c.owner.channelId);if(r.actionComplete)done.add(r.actionKey);}
 const started=Date.now(),batchId=input.batchId||new Date().toISOString().replace(/[:.]/g,'-');let sequence=0,executed=0;let stopReason='actions_exhausted';
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(batchId))throw Error('INVALID_BATCH_ID');
 if(records.some(r=>r.batchId===batchId))throw Error('BATCH_ID_ALREADY_USED_USE_NEW_ID');
 const costs=[];const moduleSource=await fs.readFile(new URL(import.meta.url)),moduleHash=hash(moduleSource);
 await fs.mkdir(path.join(dir,'modules'),{recursive:true});await fs.writeFile(path.join(dir,'modules',moduleHash+'.mjs'),moduleSource);
 async function checkpoint(reason,a=null){await atomic('checkpoint.json',{schemaVersion:1,project,...{version:VERSION,moduleHash,batchId},updatedAt:new Date().toISOString(),uniqueObserved:seen.size,target:input.targetCount,completedActionKeys:[...done],currentAction:a,reason,recovery:'Evidence replay; unfinished action navigates from its original URL and deduplicates loaded cards. No guessed continuation.'});await progress({current:Math.min(seen.size,input.targetCount),total:input.targetCount,message:`${seen.size} channels; ${reason}`});}
 const append=async(f,v)=>fs.appendFile(path.join(dir,f),JSON.stringify(v)+'\n');
 async function guard(a,status){
  const txt=await page.locator('body').innerText({timeout:6000});
  const verification=/\/sorry\//.test(page.url())||/unusual traffic|confirm you.re not a bot|confirm you are not a bot|not a robot|验证您不是|异常流量/i.test(txt.slice(0,6000));
  if(verification){await append('events.jsonl',{at:new Date().toISOString(),kind:'verification',url:page.url(),actionKey:actionKey(a)});await checkpoint('waiting_verification',a);await wait({reason:'verification'});await guard(a,null);}
  if([403,429].includes(status)||/Too Many Requests|此操作过于频繁|Access Denied/i.test(txt.slice(0,2000)))throw Error('ACCESS_RESTRICTED');
  if(/consent\.youtube|accounts\.google/.test(page.url()))throw Error('USER_ACTION_REQUIRED');
 }
 for(const a of input.actions){
  const key=actionKey(a);if(done.has(key))continue;
  if(signal.aborted){stopReason='cancelled';break;}if(Date.now()-started>=input.maxMinutes*60000){stopReason='time_budget';break;}if(seen.size>=input.targetCount&&a.countDiscovery!==false){stopReason='target_reached';break;}
  const t=Date.now();let status='completed',reason='scroll_budget',last=null;const ownCards=new Set();let noGrowth=0;
  await checkpoint('action_start',a);
  try{
   const response=await page.goto(a.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(input.settleMs??1800);await guard(a,response?.status());
   if(a.filterLabel){await page.getByRole('button',{name:/^搜索过滤条件$|^过滤$|^Search filters$/}).click({timeout:7000});await page.getByText(a.filterLabel,{exact:true}).last().click({timeout:7000});await page.waitForTimeout(input.settleMs??1800);await guard(a,null);}
   if(a.chip){await page.getByText(a.chip,{exact:true}).last().click({timeout:7000});await page.waitForTimeout(input.settleMs??1800);await guard(a,null);}
   // Public description is read from this exact video's loaded videoDetails.
   // Expanding a hidden duplicate "more" control must not discard useful evidence.
   for(let scroll=0;scroll<=a.maxScrolls;scroll++){
    if(signal.aborted){reason='cancelled';status='partial';break;}if(Date.now()-started>=input.maxMinutes*60000){reason='time_budget';status='partial';break;}
    await guard(a,null);const snap=await page.evaluate(capturePage);if(a.expectedChannelId&&snap.profile?.channelId!==a.expectedChannelId)throw Error('PROFILE_IDENTITY_MISMATCH');
    if(a.currentVideoOnly){const d=snap.details;if(!a.expectedVideoId||d?.id!==a.expectedVideoId||!/^UC[\w-]{22}$/.test(d?.channelId||''))throw Error('VIDEO_IDENTITY_UNRESOLVED');snap.cards=[{kind:'video',id:d.id,contentFormat:a.sourceContentFormat||d.contentFormat,title:d.title,url:'https://www.youtube.com/'+((a.sourceContentFormat||d.contentFormat)==='shorts'?'shorts/':'watch?v=')+d.id,owner:{channelId:d.channelId,name:d.author,url:'https://www.youtube.com/channel/'+d.channelId},description:d.description,evidenceKind:'exact_current_video_details'}];}
    const before=ownCards.size;const fresh=snap.cards.filter(c=>{const k=c.kind+':'+(c.id||c.url);if(ownCards.has(k))return false;ownCards.add(k);return true;});
    const filename=`${batchId}-${String(++sequence).padStart(5,'0')}-${key}.json`;
    last={...snap,cards:fresh,action:a,actionKey:key,batchId,scroll,version:VERSION,moduleHash,countDiscovery:a.countDiscovery!==false,evidenceFile:'evidence/'+filename};
    await atomic(last.evidenceFile,last); // Commit evidence before counts/checkpoint.
    for(const c of fresh)if(c.owner?.channelId&&last.countDiscovery&&c.kind!=='playlist'&&!baseline.has(c.owner.channelId))seen.add(c.owner.channelId);
    noGrowth=ownCards.size===before?noGrowth+1:0;
    await checkpoint(`${a.route}: ${ownCards.size} cards`,{...a,scroll,lastEvidence:last.evidenceFile});
    if(seen.size>=input.targetCount&&last.countDiscovery){reason='target_reached';break;}
    if(ownCards.size>=a.maxCards){reason='card_budget';break;}
    if(noGrowth>=(input.noGrowthLimit??3)){reason=snap.hasContinuation?'no_growth_unresolved':'loaded_list_end';break;}
    if(scroll===a.maxScrolls)break;
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(input.scrollWaitMs??1500);
   }
   if(ownCards.size===0){const txt=last?.pageText||'';if(/No results found|没有找到|未找到任何|无搜索结果/i.test(txt))reason='observed_no_results';else{status='partial';reason='content_not_loaded_or_unsupported';}}
  }catch(e){status='failed';reason=e.message;await append('events.jsonl',{at:new Date().toISOString(),actionKey:key,kind:'action_failed',error:reason,url:page.url()});}
  const cost={batchId,actionKey:key,route:a.route,action:a,startedAt:new Date(t).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-t,status,reason,cards:ownCards.size,version:VERSION,moduleHash};costs.push(cost);await append('actions.jsonl',cost);
  if(status==='completed'){const marker={action:a,actionKey:key,batchId,actionComplete:true,observedAt:new Date().toISOString(),cards:[],countDiscovery:false};await atomic(`evidence/${batchId}-${String(++sequence).padStart(5,'0')}-${key}-complete.json`,marker);done.add(key);}
  executed++;await checkpoint(reason,a);
  if(reason==='ACCESS_RESTRICTED'||reason==='USER_ACTION_REQUIRED'||reason==='cancelled'||reason==='time_budget'){stopReason=reason;break;}
 }
 await checkpoint(stopReason);const result={businessStatus:seen.size>=input.targetCount?'discovery_target_reached':'partial',stopReason,uniqueObserved:seen.size,target:input.targetCount,executed,runDir:dir,batchId,version:VERSION,moduleHash};await fs.writeFile(path.join(outputDir,'result.json'),JSON.stringify(result,null,2));await append('runs.jsonl',result);return result;
}
