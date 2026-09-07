# Instagram 数据契约

本文件定义业务语义；内置采集器的实际文件与字段见 [运行契约](runtime.md)，不是下列所有逻辑表都会自动生成。JSON/JSONL 使用 UTF-8，ID 保存为字符串，时间用带时区 ISO 8601。未知数值为 null，另记 `unknown / hidden / unavailable / not_collected / parse_failed` 与原因，不填 0。

## 输入、身份与作品

`brief.json` 保存 `briefId, briefVersion, objective, product, coreScenes, referenceLinks/type/reasons, targetMarkets, creatorLocations, audienceRequirements, languages, contentFormats, contentWindow, requiredConditions, preferences, budgets, authorizedActions, assumptions`。`rubricVersion` 固定本轮角色、主题、证据与判断锚点。业务目标另记 `goalType=discovery/theme_seed/qualified, goalCount`；采集器的 `targetCount` 和审计 CLI 的 `--target` 仅表示本轮发现候选数。主题种子或完整资格目标必须经对应审核另行验收，不能因发现量达到就宣布业务完成。

优先保存 `stableId + stableIdNamespace`，只有明确映射证据才能合并跨入口 ID。没有平台稳定 ID 时，以小写规范 handle 作为 provisional 身份键；保留原 handle/URL、观察时点与别名证据。不因同名、头像或跨平台同 handle 合并。内置对账工具按规范 handle 计数，不宣称去重到自然人或运营主体；有确证更名映射时先在上游合并并保留映射。

作品优先稳定 media ID，否则使用 Instagram URL 中明确的、大小写敏感的 shortcode。同一 shortcode 的 `/p/`、`/reel/`、`/reels/` 可按作品标识对账，保留实际 URL 和观察到的形式；不凭外观相似或相同作者猜作品相同。带作者的 URL 路径只是作者线索，仍需当前作品区域确认。

跨轮 `baseline.json` 至少含 `handles[]`，冻结历史正式池、溢出、仅补查及其他已知对象，记录文件 SHA256。基线不随本轮补证变动；下一轮显式形成新基线。本轮账户记录不回写旧轮次或改动旧基线。

## 原始观察与关系

账号观察最少包含 `handle, canonicalUrl, observedAt, batchId/actionKey, routeId, routeVariant, seed, parentSeed, depth, query, sourceUrl, sourceWorkUrl, cueEvidenceId, evidenceKind, evidenceId`。缺的字段可为 null，但发现的必要来源不可缺失。实体与内容可有多个观察；追加原始记录而非覆盖历史。

`evidenceKind` 的计数语义：

| 记录 | 是否可进入发现候选框 |
|---|---|
| Similar / Following 的 `account_card` | 是；保存真实卡片与路线，不含背景种子主页 |
| 内容路线的 `content_author` / `cached_content_author` | 是；作品和作者需已解析，缓存保留原证据时点与来源，当前访问成本另记 |
| 有证据指名作者的 `profile` | 仅限定路线 `profile_credit_repost`、`lookupOnly=true`、`routeVariant=named_profile_lookup`（兼容 `named_profile_from_verified_prior_work`），目标 handle 相同且带父种子/原作品/署名证据才计 |
| 普通种子 `profile`、`profile_enrich` | 背景或补证；不获得新的发现贡献 |
| 仅被提及、未取得对象本身观察的 `reference_only` | 否；进入关系/待查队列 |
| 页面聚合“还有 N 个”但未载入记录 | 否；另报 `reportedUnloadedCount` |

来源条件由工具校验结构，Agent 仍需审核原证据真实语义。`lookupOnly` 标记本身不证明该对象是新发现或有主题资格。

内容保存 `shortcode/mediaId, url, authors[], authorResolution, evidenceId, observedAt, format, publishedAt, caption, pageText, inspectionMode`。未单独提取 caption 时为 null，不能把页面正文全部改名文案。`inspectionMode=metadata_only/thumbnail/visual/audiovisual`；轮播记实际检查项数，视频记实际观察范围与必要时间点。网格采样不证明完整时间线。

关系保存 `fromEntity/fromContent, toHandle, relationType, sourceUrl, evidenceId, observedAt, parentSeed, depth, verificationStatus`。`platform_recommended_similar, following, content_author, collab_coauthor, tagged_in_content, explicit_credit, mentioned_in_caption, visible_comment_mention, repost_source, paid_partnership` 分开。未分清 caption 或评论时显式模糊，不能计为确定作者。折叠共同作者记 partial，不补造未显示作者。

观察知识类型另记 `page_observation / official_documentation / platform_claim / creator_claim / analyst_inference`。简介自称和平台预测不是已验证受众或转化事实。只保存任务需要的公开商务信息与来源，不猜邮箱、不输出 cookies、token、密码或授权头。

## 账本、动作身份与恢复

动作规范保存路线、种子/查询、入口 URL、变体、明确作品列表、过滤/排序、窗口、预算、证据级别、署名来源、是否只查主页、跳过作品和刷新意图。动作键对完整业务规范递归按对象键排序，含批次身份；尝试号、开始/结束时间及结果字段不改变同一业务动作。数组顺序影响实际执行时保留。

幂等范围是同批、同业务规范；跨批不默认跳过。改变预算、作品列表、来源或过滤形成新动作；不能手工复用旧键以掩盖计划变化。实体已见不代表这个动作已完成。Task Master 的 request key 防重复提交与模块内动作键是两层不同机制。

动作日志追加 started/running 与终态，记录 `actionKey, routeId, seed, startedAt, finishedAt, durationMs, status, stopReason, observed handles/work IDs, error`。已完成跳过和未启动有独立事件；未启动不是零候选的已执行动作。完成前必须已有持久化证据；中途失败可保留有效观察，不把 partial 结果整批抹掉。

恢复校验模块版本/哈希、输入指纹、基线哈希和已有日志。当前执行器按已提交 JSONL 与动作账本恢复，未完成动作从可靠入口重进并去重，不支持猜造平台 cursor 或任意滚动位置恢复。只有换行提交的完整记录可计数；非提交尾部先保存原字节再修复，坏中间行报错，不静默跳过。只写 checkpoint 但没有读回不算已实现恢复。

## 审核记录与优先级

审核保存 `handle/entityKey, briefVersion, rubricVersion, reviewLevel, reviewer, reviewedAt, profileObservedAt, profileEvidenceId, evidenceIds[], role, theme, continuity, fit, commercial, expansionStatus, allowedScope, missingFields, rationale`。关键条件采用 `pass/fail/unknown/not_required`，偏好缺证据为 null。

`reviewLevel` 区分卡片初筛、主页语义审核、视觉/音频检查和商业核验。自动分词/显示名匹配只给 triage，不替代 Agent 审阅。角色、主题与合作资格分别输出；工具不会从审核标签自动构造商务合格。

合并时，有引用的主页语义审核优先于卡片初筛；同证据层再按实际观察时点及审核时间。不要凭 `profile_review` 字样给没有主页证据的记录高优先级。不同 Brief/rubric 不能不说明地混合裁决，需先按本轮标准复审。纠正单独追加 `supersedes/reason/originalEvidence/newEvidence`，保留旧判定并重新生成下游视图。

第一阶段输出可以是 `core_personal, core_team, intermediary, needs_verification, rejected` 或任务自定义等价标签；`intermediary` 必须给具体允许的下一跳。完整资格视图另按必需条件决定 `qualified/needs_verification/rejected`。展开种子可与这些视图交叉，不加进总人数。

## 计数、效率与验收

正式新增 = 有效候选证据 − 冻结基线 − 精确无效观察，按首次候选出现顺序去重取前 N；超额尾部为 overflow。保留 `allObservedFirst` 和 `candidateFirst` 的区别；只补证账号、引用与背景不进入候选首次归属。若历史格式曾用别的口径，明确版本差异，不能静默改写历史实测数字。

正式池 route-first attribution 合计等于正式量。路线内 candidate-own 去重允许跨路线重叠，其总和不等于账号总数。全部观察量不等于候选量。发现、补查、诊断、审核和等待分别算成本；缺少耗时是 unknown，不能当零。复用旧作品找到的指名账号保留旧准备成本边界。

质量样本保存候选框哈希、冻结时间、路线/种子、阶段、选样方法、应审、已审、unknown、通过与唯一账号数。目的性补查和固定样本不混分母，路线样本相互重叠时另报。仅在采样范围内给比率；无法推出全部未审对象不合格，也不能把浏览器卡片速度改称完整合格名单产能。

交付保留 canonical JSON/JSONL、表格视图、原始证据、动作/断点、覆盖与复盘。CSV/XLSX 对 `=,+,-,@` 开头自由文本作安全文本处理，JSON 保留原文；核对实际单元格类型、ID 字符串、计数和哈希。目标量、必要范围与证据三者完成才是 complete，未达项必须显式列出。
