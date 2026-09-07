# Pack 0.1.5 契约

依赖 Node.js 20+、已安装 Eric Task Master 与其可用 Chrome Profile。无需 npm 安装；浏览器由 Task Master 提供。Windows 真机验证情况见随版本交付的实测报告；路径使用 Node path API，其他系统未实跑。

本次公共包为 0.1.5，离线处理器逻辑仍为 0.1.4，浏览器逻辑仍为 0.1.3。发行副本统一 LF 换行，不能用旧本机字节哈希指代公共文件；新增元数据、许可证与验证说明不改变采集和对账行为。浏览器返回的 version 指执行模块版本，处理器输出的 processorVersion 指处理器版本，不能混称为本次重新进行了真实浏览器验证。

## 文件与调用

`browser.mjs` 是 Task Master 自包含入口，只导入 Node 内置模块。`process.mjs` 与 `behavior.test.mjs` 是本地工具，随完整目录携带，不能只复制处理器。运行输入和输出目录在包外。

```text
taskmaster run /absolute/skill/scripts/browser.mjs --profile USER_CHOSEN_PROFILE --input '@/absolute/job/batch.json' --detach --json
taskmaster panel --json
taskmaster follow TASK_ID --wait-ms 30000 --json
node /absolute/skill/scripts/process.mjs /absolute/job/process.json
node --test /absolute/skill/scripts/behavior.test.mjs
```

命令中的路径与 Profile 均替换为当前环境真实值。使用已安装启动器绝对路径；不依赖 PATH 中可能残留的旧版 Task Master。

## 浏览器输入

```json
{
  "projectId": "unique-job-id",
  "briefVersion": "1.0",
  "batchId": "unique-batch-id",
  "runDir": "/absolute/job/run",
  "targetCount": 200,
  "baselineIds": [],
  "maxMinutes": 20,
  "settleMs": 1800,
  "scrollWaitMs": 1500,
  "noGrowthLimit": 3,
  "actions": [
    {
      "route": "scene_search",
      "url": "https://www.youtube.com/results?search_query=USER_QUERY",
      "query": "USER_QUERY",
      "maxScrolls": 5,
      "maxCards": 100,
      "countDiscovery": true,
      "depth": 0
    }
  ]
}
```

此处数值仅演示。`targetCount` 必须正整数，`maxMinutes` 为正有限数；每动作必须有 `maxScrolls`（0–100）、`maxCards`（1–2000）和真实 `route`、YouTube HTTPS URL。总动作数组有界。`maxCards` 是每次页面提交后检查的上限，单页可能越过，原始越界记录保留；正式池按 N 截断。

可选动作字段：`filterLabel` 为实际观察到的搜索过滤项文案；`chip` 为实际可见的推荐筛选文案；`expectedChannelId` 用于主页身份核对；`countDiscovery:false` 用于参考或补资料，不贡献新增；`seed/sourceVideo/sourcePlaylist/sourceEvidence/depth/phase/pair` 保留来源和试验设计。动作键覆盖所有这些业务字段（仅忽略展示 `id`）；不同参数不能错误复用完成标记。

`currentVideoOnly:true` 配合 `expectedVideoId` 仅取精确匹配的当前视频作者，不采旁边推荐。它用于未解析作者补查；设置原发现 `route/sourceVideo/sourceEvidence`，`sourceContentFormat:"shorts"` 保留原短视频形式。补查成功的首次计数是原发现的身份完成，不能另外创造一种新发现关系。未知作者、错 video ID 均不得计数。

执行器采用普通页面导航、实际控件与有界滚动。通过已挂载卡片及其页面渲染数据取得 ID，不发送未观察到的内部 API 请求；不会导出 cookies、tokens 或认证头。页面载入的 `videoDetails` 只在 video ID 与当前 URL 一致时读取标题、作者和公开说明。

## 状态与恢复

`project.json` 固定 projectId、briefVersion、targetCount、baselineIds。同目录不同合同拒绝合并。`evidence/*.json` 是先提交的页面最小证据，`*-complete.json` 是完成标记；恢复读取这两者重建已见 ID 与已完成动作。`checkpoint.json` 为摘要，不能替代原始证据。

每个 `batchId` 必须唯一，禁止重用已写过的批次号；恢复用新批次号、相同业务动作即可跳过完成动作并重放未完成动作。调整适配器后记录新模块哈希与变更原因；若需要重新执行已完成的旧动作，添加明确的 `adapterRevision`，不要删除原记录。

`actions.jsonl` 保存尝试状态、耗时、失败、结束原因；`events.jsonl` 保存验证或错误；`runs.jsonl` 保存每批业务状态。`modules/<sha256>.mjs` 保存实际 Worker 运行的自包含源码，避免 Manager 清理临时模块后失去复现证据。`loaded_list_end` 仅表示当前已加载列表无新增且未见 continuation，不证明平台穷尽；`no_growth_unresolved`、card/scroll/time budget、访问限制分别报告。

`discovery_target_reached` 只表示发现数量达标。审核、商务、名单完整性仍由 Agent 按 Brief 验收。取消/失败不能覆盖先前证据。启动时应对源代码版本和模块哈希留痕；此包不支持秘密更换数据合同或透明迁移旧 schema。

## 本地处理

```json
{
  "runDir": "/absolute/job/run",
  "outputDir": "/absolute/job/analysis",
  "freezeSample": true,
  "sampleSize": 24
}
```

处理器读取证据与动作账本，输出 canonical.json、channels.csv、route-metrics.csv、summary.json；`freezeSample` 时另输出 frozen-sample.json。样本按 `sha256(route:channelId)` 排序，默认 sampleFrame 为 formal，只抽正式池；显式 observed 可包含溢出，须单列分母。sampleSize 是正整数。路线样本可复现但不是整池或全平台随机样本。已有冻结文件与新计算结果不一致时抛出 `FROZEN_SAMPLE_CHANGED_USE_NEW_OUTPUT`，在改写处理结果前停止；使用新输出目录保存新框，保留旧样本。

`canonical` 同时含正式、溢出、所有已观察频道、来源边、作品、主页、原始未解析观察与路线指标。原始 unresolved 不删除；另输出 identity-queue.json，按 video ID 去重后分 pending、resolved 和 conflicts，另存没有 video ID 的频道 URL。resolved 与冲突不要直接重新派发普通作者补查；队列不自动执行浏览器动作。

处理器不执行语义审核。未导入判断时 channels.csv 的 assessment 为 unreviewed；输入 Agent 已完成的审核记录后，分别输出 qualified.csv、pending.csv、rejected.csv、unreviewed.csv、review-summary.json 和 review-followups.json。待办保留已有理由与 missingCriteria，不从 pending 自动推断具体缺失条件，也不自动生成不受控补查动作。

可选处理配置：

```json
{
  "runDir": "/absolute/job/run",
  "outputDir": "/absolute/job/reviewed-analysis",
  "assessmentsFile": "/absolute/job/assessments.json",
  "reviewScope": {"mode": "all_formal", "rubricVersion": "job-rubric-1"}
}
```

`assessments.json` 是数组，每条为：

```json
{"channelId":"UC_STABLE_CHANNEL_ID","decision":"pending","rubricVersion":"job-rubric-1","reason":"已确认一条产品体验，持续分支证据待补","evidenceFiles":["evidence/OBSERVED_FILE.json"],"missingCriteria":["持续分支"]}
```

channelId 使用真实已观察频道 ID；decision 为 qualified/pending/rejected。同版本记录一人一条，历史判断留在另一个版本文件。重复 ID、未观察 ID、rubric 不一致、理由缺失或证据文件不存在均拒绝，不静默选取最后一条。证据文件存在校验不证明语义判断正确；Agent 仍需核对作品与作者归属。

reviewScope.mode 支持 all_formal、fixed_sample、none。fixed_sample 必须提供明确 channelIds；默认 none 表示没有声明审核范围。正式池计数排除溢出审核并另报 outsideFormalReviewed。scope.status=reviewed 只说明声明对象已有判断，pending 仍未决；allFormalReviewed、allFormalDecided 分开给出。处理器不从路线或目的性样本生成整池命中率，overallEstimatedHitRate 保持 null，统计估计由任务另行给出抽样依据。

已有含审核结果的输出目录再次处理时必须继续提供 assessmentsFile，避免误用无审核输入清空结果。新标准或新样本用新输出目录；任务审核记录本身和历史原始证据不被处理器修改。

CSV 使用 UTF-8 BOM、字符串引用与 null 留空；频道 ID 不转换数字。路线独立账号可能跨路线重叠，不能相加当总人数；firstAttributed 闭合正式池。durationMs 是浏览器动作壁钟时长（含该动作内等待与失败），不包含尚未记录的 Agent 审核和交付工作。
