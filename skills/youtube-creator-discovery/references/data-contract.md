# YouTube 数据契约 v1

本文件描述逻辑对象。Pack 0.1.4 的实际 JSON/CLI 映射见 [Pack 契约](pack-contract.md)：observation 保存在 evidence 页面记录及其中的 cards/profile/details；entity、edge、作品、正式/溢出池聚合在 canonical.json；动作在 actions.jsonl，Agent 的 assessment 单独保存在任务审核文件。浏览器模块保持 0.1.3，离线处理器为 0.1.4；处理器不自动产生语义评分或商务合格。

本版本正式数量仅计已解析到稳定频道 ID 的对象。暂时只有 handle/URL 的观察存入 unresolved 队列，不能拿来补足 N；补查后保留身份迁移证据和原来源，不把补查本身计新发现。页面推荐只是 `recommended_visible`，播放列表条目作者只是 `playlist_video_author`。

没有作者链接的 Shorts 也以 video ID 存入 unresolved，保留原视频 URL、标题、格式、动作和证据。实体作品和来源保留 `contentFormat`。历史版本缺此字段为未知，不按时长推断短视频。

只在关系中被提及、尚未取得对象本身观察的实体标记 `reference_only`，不计入实际已采或已审候选数。只有聚合数量而未载入具体记录的结果单列 `reported_unloaded_count`；不能据此生成对象、合格数或全局去重数。实体总数、已采候选、已审对象与关系数量分别对账。

本契约用于本 Skill 的单项目批次与跨轮复用，无需其他业务 Skill。可使用 JSONL/SQLite 做内部保存，CSV/XLSX 做用户交付；字段含义及实体关系保持一致。原始观察追加保存，不用新评分覆盖旧证据。

## 必需数据对象

| 对象 | 必需字段与含义 |
|---|---|
| project | project_id、schema_version、brief_version、原始 brief、结构化条件、正反种子及理由、预算、目标与停止规则、created_at |
| entity | entity_key、platform=youtube、entity_type（channel/video/playlist/organization）、stable_id、canonical_url、aliases、display_name、identity_status、first_seen_at、last_seen_at |
| observation | observation_id、entity_key、field、value、raw_value、source_url、retrieved_at、evidence_type、method、route_id/version、run_id、batch_id、content_id、window、artifact_ref、missing_reason |
| edge | edge_id、from_entity、to_entity、relation_type、query_or_seed、source_url、observation_ids、observed_at、depth；关系可为 authored、playlist_contains、mentioned、collaboration_explicit、recommended_visible、query_discovered |
| action | action_id、action_key、route_id/version、seed/query、brief_version、parent_action、depth、requested_fields、budget、state、attempts、checkpoint_ref、cursor、processed_entity_keys、output_refs、stop_reason |
| assessment | assessment_id、entity_key、brief_version、rubric_version、evidence_cutoff、match、commercial、expansion、criterion_results、evidence_ids、unknowns、decision、reason、assessor、assessed_at |
| run_summary | run_id、任务大师 task_id 与 Dashboard URL（若使用）、状态、开始/结束、计数、路线产出、耗时/配额/费用观察、覆盖缺口、待办与检查点、停止原因 |

所有时间使用带时区 ISO 8601。evidence_type 至少区分 observed（直接观察）、self_claim（账号自述）、provider_claim（供应商声明）、inference（推断）、unknown；官方平台文档放入路线来源，不作为某红人的身份/受众证据。

## 身份与指标

- 频道优先以 `youtube:channel:<channel_id>` 为键；视频、列表使用各自 stable ID。暂时拿不到 ID 时用 `youtube:channel:url:<normalized_url>`，设置 provisional 并保存 handle/旧 URL aliases。后续确认 ID 后保留迁移映射和原 observation，不复制成新人。
- URL 去除跟踪参数和无关 fragment，保留识别资源的 ID；不得误删视频的 v 或列表的 list。名字相同不是同一频道，跨平台同名不得自动合并。明确公开互链等证据可添加 identity_link，并保留各平台账号与统计。
- 指标 observation 保留来源原字符串、解析值、单位、精度/约数、观测时间。窗口标明内容形式、published_from/to、sample_count、sample_ids、选样规则、排除项；不存在或隐藏的值为 null + missing_reason。
- 衍生值单独记录 formula_version、输入 observation IDs、样本分母。观看量不改名为独立观众；样本播放中位数不是预测触达；公开互动不能推出实际受众地区。

## 判断与名单

三项独立判断不加总为一个掩盖缺口的总分：

- match：high / medium / low / unknown；依据主题、形式、语言等本项目 rubric，逐条件给 evidence_ids。
- commercial：pass / fail / unknown；必要条件全部有充分证据才 pass，已证实冲突 fail，关键缺失 unknown。不是合作邀约或报价确认。
- expansion：high / medium / low / unknown；依据可追溯的新关系、细分主题覆盖和历史路线产出，注明依据或待验证假设。

用户需要数值分时可以配置有锚点的分数和权重，但保存 rubric_version、单项证据与未知项，不能把 unknown 当零分。筛选门槛与样本量是项目配置，不能写成平台事实。

decision 为 qualified / pending / rejected，三类按当前版本互斥；seed_selected 为独立标记，可与任一类并存。qualified 仅表示满足声明的本轮筛选标准，不代表已签约、已验证全部受众或保证投放效果。存在尚未完成的必要条件必须 pending。rejected 记录明确条件冲突；主题不相关但关系有价值时可仍为 seed。

没有该版本审核记录的对象为 unreviewed，不是 pending。任务记录区分用户必要条件与 Agent 审核方法；role 是主体属性，不单独替代按当前任务条件作出的 decision。需要至少若干作品时先说明这是用户条件还是取证方法，不能事后收紧门槛再把旧结果当作同口径比较。

## 动作、恢复和停止

action_key 至少由 platform + route_version + seed_or_query + window + requested_fields + brief_version 形成稳定键，避免同对象同路线反复执行。state 使用 pending / running / completed / partial / waiting_user / failed / cancelled。保存已完成动作和 cursor，不能从实体已存在推断某路线已执行。

写 observation/edge 完成并对账后才推进 checkpoint。checkpoint 包含来源动作、真实 cursor 或 last_seen IDs、已提交页/单元、未完成队列、模块版本与 input hash。模块恢复可重放最后单元并去重，不声称平台游标永久有效或 Manager 自动修复业务状态。retry 次数/退避有界，访问拒绝、验证码或费用预算不足不能无限重试。

summary 至少记录 raw records、unique channels、qualified/pending/rejected/unreviewed、seed count、重复数、补查数、每路线新增合格数/耗时。正式池应满足 reviewed = qualified + pending + rejected，formal = reviewed + unreviewed；溢出、基线及仅观察对象不进入这些分母。scope 的样本审核完成不表示全池审核完成，pending 仍表示必要证据未决。视频/列表不计作红人数，seed 不加进名单总数。项目 run_status 为 complete / partial / cancelled，partial 写明已完成范围、未完成动作与原因；单个动作的完成状态仍为 completed，与项目状态分开。

## 用户交付

交付 `qualified.csv`、`pending.csv`、`rejected.csv`、`unreviewed.csv`、`seeds.csv` 和 `summary.md`；用户偏好工作簿时同名工作表可替代 CSV。不要把未审合并进名为 pending 的交付文件。名单含账号链接、主题/形式、三项判断、关键证据链接、采样窗口、缺口、状态理由和版本。内部保存 entities、observations、edges、actions、assessments 与项目配置，保证可复查。

原始页面材料仅保存本次必要且允许的证据；不得写入 cookie、token、认证 header 或私密资料。公开商务入口可单列来源及观测时间；联系行为不属于本数据流程。
