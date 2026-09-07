# Task Master 执行与离线对账

## 依赖和调用方式

浏览器使用 Eric Task Master，读取本机当前 `eric-task-master` 接入说明。它负责 Chrome、登录 Profile、租约和任务生命周期；本包只使用其 `run({page,input,outputDir,progress,wait,signal})` 契约，不启动第二个浏览器控制器。需要现成的稳定 Chrome 与用户可用 Profile。离线工具和测试使用 Node.js 18+，只依赖内置模块。

若 `taskmaster` 不在 PATH，按实际环境定位已安装 launcher：Windows `%LOCALAPPDATA%\Programs\Eric Task Master\bin\taskmaster.cmd`；其他系统按 Task Master 当前安装说明。缺少安装时使用官方 [Task Master Release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest) 并核对包哈希；本 Skill ZIP 不包含 Task Master、Chrome 或账号登录状态。不要硬编码维护者用户名、安装目录或 Profile。

`scripts/collect.mjs` 是自包含入口，不导入同目录文件；Task Master 只冻结入口文件。测试可以导入同目录脚本，测试依赖不属于浏览器任务依赖。

从当前机器的真实 Skill 目录和任务目录解析路径后运行，示意如下（替换占位项，shell 中逐参数传递）：

```text
taskmaster run <Skill绝对路径>/scripts/collect.mjs --input @<input.json绝对路径> --profile <本任务已选Profile> --detach --json
taskmaster panel --json
taskmaster follow <TASK_ID> --wait-ms 30000 --json
```

用户指定过 Profile 就显式传入；未指定时按当前 Task Master 默认契约，不能擅自替换已有选择。保存 Task ID，并立即向用户提供 panel 返回的 Dashboard URL。follow 使用返回的 after 序号续读；执行结束后读产物和覆盖，而非只读 Worker 状态。

## `collect.mjs` 输入

输入是任务目录中的 JSON，必需字段如下。没有内置行业、种子、数量目标或账号基线。

| 字段 | 语义 |
|---|---|
| `runId` | 本轮身份，非空字符串；同 runDir 恢复不变 |
| `batchId` | 批次身份，字母/数字开头，后续字母数字及 `._-`，最多 120 字符；同计划恢复不变 |
| `runDir` | 原始观察与业务状态保存的绝对路径，位于本任务目录 |
| `baselinePath` / `baselineSha256` | 冻结基线 JSON 的绝对路径与 64 位 SHA256；内容至少 `{"handles":[]}`，空基线也需显式提供 |
| `targetCount` | 本 runDir 的净新增发现目标，正整数；不是审核通过目标 |
| `actions` | 有限动作数组，由 Agent 根据参考/种子审核形成 |
| `maxDurationMs`（可选） | 本次提交的时间预算；用户有限时要求时填写剩余预算。按动作/滚动/作品边界检查，已进入的有限等待/导航可能跨过截止时点 |
| `waits`（可选） | 技术等待覆盖，不改变用户范围；`navigationMs/mainMs/settleMs/listInitialMs/listScrollMs/gridMs` |

SHA256 按文件原始字节计算，含编码与换行。所有实际路径、Profile、用户参数和历史对象留在任务文件中。跨轮新基线需要新 runDir；同轮追加新计划用新 batchId，但沿用 runId、目标、基线和模块。

技术等待的内置起点分别为 45,000/18,000/1,700/2,400/1,800/2,000 毫秒；导航和主区超时须为 1..120,000 毫秒，其余等待可为 0..120,000。禁止用 0 解除导航超时。这只是页面等待，不是允许加速、限制绕过或平台吞吐承诺。语言/选择器匹配目前限代码明确支持的中文与英文文本；其他 UI 需实际观察后适配。不要把试验配置复制成每个任务的固定配额。

动作支持平铺预算或 `budget` 对象，两处同字段冲突会报错。必需基础字段为 `routeId, url`；主页路线需规范小写 `seed` 且入口主页与其一致。URL 必须为 HTTPS Instagram 主站，不能传外部 URL、凭据或未支持路线。保存 `parentSeed, depth, query, sourceWorkUrl, cueEvidenceId, cueRelationship` 等实际来源。

| 支持的 `routeId` | 必需预算/条件 | 行为 |
|---|---|---|
| `profile_similar` | `maxAccounts>=1, maxScrolls>=1, maxProfilePosts=0..12` | 核对主页，进入类似账户与查看全部，读取有限列表 |
| `following` | 同上 | 核对主页后读取有限 Following 列表 |
| `profile_enrich` | `maxProfilePosts=0..12` | 保存可见主页文字及有限已加载网格元数据；不授予发现贡献 |
| `keyword_content` / `hashtag_content` / `brand_tagged` | `maxWorks>=1, resolveLimit>=0, maxScrolls>=0` | 读取入口作品并有限解析当前作者；入口 URL 由本轮可见页面确定 |
| `profile_collab_authors` | 同内容预算，主页 seed 与 URL 一致 | 检查作品实际可见作者；路线名称不证明每个作者是 Collab，多作者/折叠状态另存 |
| `profile_credit_repost` | `lookupOnly=true, routeVariant=named_profile_lookup, parentSeed, sourceWorkUrl, cueEvidenceId, maxProfilePosts=0..12` | 只核验经 Agent 审核、有完整前作证据的指名主页；兼容旧变体 `named_profile_from_verified_prior_work` |

内容动作可提供 `workUrls[]` 和 `skipKnownWorkIds[]`，均参与动作身份。`resolveLimit=0` 只保存作品池，不会产生作品作者候选。`maxProfilePosts<=12` 是此补证实现的能力上限，不是“12 条足以审核”的业务规则；更多资料、完整窗口或音视频检查需要另写有界动作。

旧的全页 credit 正则扫描、任意账户自动递归、无限 Reels 流、Marketplace、Map/音频/Remix 和互动者采集不在这个入口中。需要时先核实实际页面与授权，然后实现最小适配，不能借用近似路线名字假装支持。

## 输出、停止和恢复

`runDir` 中保存以下实际文件；无该类记录时 JSONL 可能尚不存在，不能据缺文件推成已加载零结果。

- `run-manifest.json`、`plans/<batchId>.json`：运行/模块/基线/目标及批次输入指纹。
- `accounts.jsonl`、`profiles.jsonl`、`contents.jsonl`、`relations.jsonl`、`content-pools.jsonl`：原始观察和内容关系。
- `actions.jsonl`：运行与终态；`dispatch.jsonl`：已完成跳过、达标未启动、受阻未启动等记录。
- `snapshots/`：带实际 URL、来源动作和时间的页面快照；`evidence.jsonl` 保存快照 SHA256 以核对恢复时的证据连续性。`identity-events.jsonl`、`resolution-events.jsonl`：身份/作品解析缺口。
- `checkpoint.json`、`result-<batchId>.json`：已提交进度与本批状态。Task Master 的 outputDir 也有 checkpoint/result 副本。
- `invalid-observations.jsonl`（任务可追加）：以 handle + evidenceId 精确撤销错误观察，保留原始数据。
- `recovery-tails/`：被中断的未提交 JSONL 尾部原字节与修复记录。

账户记录中的 `evidenceKind` 和来源决定候选计数，普通背景主页及 enrich 不计新增。列表可能一次载入超过剩余目标，后续对账按首候选顺序封正式池并单列 overflow。作品作者只来自当前作品的可靠作者区域，预加载或歧义不解析；caption 未单独提取时保持 null。主页网格 alt/链接文字另存 `gridPreviewText/previewTextSource`，不能称完整文案。缓存记录保留旧 evidenceId、旧观察时点与本次复用时点，不能冒充重新观察作品。

动作有界完成不证明业务完成。目标未达、加载失败、结构/身份缺口、时间预算或访问阻断保留 partial；返回 targetReached、routeStops 和资格未评估状态。Agent 还需核对业务必需范围、主题/资格目标和审核队列。`dispatch` 未启动事件不能进入已执行路线质量分母。

同一输入恢复时读取指纹和提交账本，跳过已完成动作；未完成动作从可靠入口重新进入，依证据/实体去重，不声称精确恢复滚动位置。恢复前核对用户任务的剩余总预算，重新提交不会自动获得新预算；需要修改剩余提交时间时使用新 batchId。新计划新 batchId，变更模块/基线/全局目标需新 runDir 与明确迁移；不可直接把本次历史实验的旧日志目录当新版本断点。

可见加载失败保存页面证据并停止本批同一路线；身份错位或当前作品作者不明不猜值。登录/403/429/限制停止批次。验证页调用 `wait({reason:'verification'})`，遵循 Task Master 当前等待与恢复机制；等待返回后本模块结束为需重新检查的 partial，不自动继续一长串动作。没有用户恢复要求或明确解除证据时，不反复提交、不更换账号/Profile/线路。

## 离线审核工具

不需要浏览器或网络。`accounts`、`actions`、`profiles`、`reviews`、`invalid` 参数可重复，顺序作为相同时点的稳定次序；基线是 JSON，其余是逐条换行提交的 JSONL。

```text
node <Skill路径>/scripts/ig-audit.mjs --help
node <Skill路径>/scripts/ig-audit.mjs --accounts <accounts.jsonl> --baseline <baseline.json> --target <本轮发现目标> --actions <actions.jsonl> --profiles <profiles.jsonl> --reviews <reviews.jsonl> --out <新的对账目录>
```

只传存在的可选文件；需要剔除错误观察时加 `--invalid <invalid-observations.jsonl>`。所有 CLI 相对路径从当前工作目录解析，输出不覆盖已有 audit.json/entities.jsonl；修改审核后写新输出目录，不替换原审计记录。

输出 `audit.json` 与 `entities.jsonl`，包括 target/overflow/support_only、firstObserved/firstCandidate、全部来源、route-own 与交叉、已有审核的合并及成本未知项。候选必须有可追溯 IG 来源；内容作者还需可解析的作品 URL，已声明 contentId 时必须一致。缺来源不计正式候选并列 warning，字段结构通过仍不证明真实作者。

动作可显式给 `costRole=discovery/enrichment/diagnostic`；`phase` 或 `slot` 为 diagnostic 时也单列诊断成本。未标记的历史动作按路线分类，不猜其用途；不能把未标注诊断的旧统计称已准确拆分全部成本。`costFrames` 列各类成本，缺耗时留未知。`audited_snapshot` 是离线一致性快照，不代表全业务 complete；`partial_snapshot` 时读 warnings。存在有效 JSON 但没有末尾换行的尾记录也视为未提交，对账工具只读不修源文件。

审核可用 `evidenceLevel`（兼容 `reviewLevel`）、`evidenceIds[]`、`profileEvidenceId`，与同 handle 的 accounts/profiles 证据关联；仅写高层标签不足以获得高优先级。保留 Brief/rubric 版本，多版本会分别保留 reviewVariants，并提示选择上下文；需要时显式传 `--brief-version` 与 `--rubric-version`，不能通过选择版本冒充已完成复审。工具不会从字段存在自动确认创作者持续性或商务资格，最终判断仍由 Agent 按原证据完成。

## 本地验证

从 Skill 目录运行随包测试，均为离线合成/模拟，不操作 Instagram：

```text
node --test scripts/collect.test.mjs scripts/ig-audit.test.mjs scripts/parity.test.mjs
```

两个工具因 Task Master 入口冻结契约保留少量自包含的同义函数，parity 测试核对动作身份、来源候选、规范化和提交边界，修改后应一并运行。安装或修改后按实际测试结果记录版本/哈希；测试通过不代替新环境有界校准。更多边界见 [验证范围](validation-scope.md) 和 [每轮复盘](retrospective.md)。
