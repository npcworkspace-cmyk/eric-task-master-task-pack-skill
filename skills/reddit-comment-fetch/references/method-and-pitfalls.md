# 方法、收益与坑

## 三段式 JSON 采集

1. 初始树：`/comments/{post}.json?raw_json=1&sort=confidence&limit=500`。
2. 宽度补取：将 `more.children` 按最多 100 个 ID 组成 `/api/morechildren.json` 请求，解析 `json.data.things` 并继续发现 t1 与 more。
3. 深度补取：观察到 `more{id:"_",count:0,children:[],parent_id:"t1_..."}` 且父评论确属同帖时，以父 ID 请求同帖焦点 JSON：`comment={parent}&context=0&depth=10`。

`_` 是深层截断标记，不是评论 ID。焦点请求返回后仍递归 replies；非空 more.children 回到普通队列；更深空 more 形成新的父评论锚点。

本方法不依赖评论 CSS、滚动位置或屏幕可见区域。[Reddit comments 文档](https://www.reddit.com/dev/api/#GET_comments_{article})说明 comment、context、depth 与 limit 的作用；[morechildren 文档](https://www.reddit.com/dev/api/#GET_api_morechildren)说明它用于补取基础树省略的评论、每次最多 100 个，并要求该端点串行请求。文档不代表当次会话一定有访问权限，返回形状仍以保存的响应判断。

## 关闭锚点的证据

必须同时满足：

- 响应中的帖子身份精确匹配；
- 请求的 focal t1 存在且 link_id 属于该帖；
- focal 下出现直接 t1 子评论，或出现可继续追踪的非空 more.children；
- 没有只是原样重复同一个空截断。

HTTP 200、响应中出现其他评论或总评论数增加都不够。直接孩子即使已经由别的批次保存，也可以作为结构展开证据；唯一评论增量另行统计。

同一锚点以 post ID + parent comment ID 去重，最多一次有效成功读取。再次出现同一空锚点记 repeated_anchor；身份正确但没有展开证据记 no_progress；读取或验证失败记 read_failure。三者都保留为缺口，防止无限循环。

## 效率来源

| 机制 | 收益 |
|---|---|
| JSON 原生结构 | 不渲染评论 UI，不滚动，不逐条点击 |
| morechildren 批量 ID | 一次读取多个被初始树省略的评论 |
| 只聚焦已观察的深层断点 | 避免逐评论重读整个帖子 |
| 稳定 ID 去重 | 重叠响应和恢复回放不会重复计数 |
| 原始批次先落盘 | 中断后从证据继续，不从头扫描 |
| 本地解析和紧凑进度 | 大正文留在文件，Agent 只跟踪计数、状态和缺口 |

这些是算法收益，不是吞吐或平台额度承诺。默认节奏是保守工程配置；所有 initial、more 和 thread 请求共享预算、串行间隔、滚动窗口和 429 冷却。

## 常见误判

| 误判 | 正确处理 |
|---|---|
| 初始 JSON 返回很多就叫全量 | 继续处理 more 和深层锚点，交付 coverage |
| 普通队列空就完成 | 同时检查 missing、empty_more、anchors 和 structural gaps |
| count=0 或 children=[] 代表没有回复 | 对已知同帖父评论做焦点补取；没有证据就保留缺口 |
| 将 `_` 当评论 ID 或唯一键 | 不请求 `_`；锚点键使用 post + parent |
| HTTP 成功等于所有 requested ID 都返回 | requested 与 returned 分开；未返 ID 有界重试后保持未知 |
| 未返 ID 都是 deleted | 只写 not_returned；不猜原因 |
| advertised num_comments 是完整分母 | 只作站点快照字段，不用于完整性验收 |
| 写 checkpoint 后再写响应 | batch 先写、checkpoint 后推进；落盘未应用时恢复回放 |
| 直接覆盖状态文件 | 同目录临时文件写完并同步后再原子替换 |
| progress 报告失败就停止数据采集 | 禁用后续 progress，记录受限 notice，继续持久化业务数据 |
| 把 locator 当所有运行时的硬能力 | 优先读取 `goto` 响应的 `text()`；只有响应不提供正文时才使用 body locator fallback |
| 把两种正文读取器都缺失当成临时网络故障 | 保留首个诊断 batch，立即结束为 `blocked/runtime_body_capability_missing`，由 Agent 审查 runtime adapter |
| runtime wait 抛错都归为 collector_error | 定时等待记录后降级到本地 sleep 并守住截止时间；人工 handoff wait 失败明确为 `blocked/runtime_wait_failed` |
| 所有 collector_error 都是网络 | 看读取、保存、应用、断点、进度等阶段；根因不足保持未知 |
| schema 相同就能恢复 | 同时验证 method revision、请求种类、端点和字段；未知 revision 拒绝，null legacy 也不得带 thread batch 或新字段 |
| Worker 的 stopped/canResume 决定业务断点 | Worker 生命周期和 Pack checkpoint 分开判断 |
| 换设备就沿用旧绝对路径和 Profile | 重新解析本地路径并由当地 Task Master 管理 Profile |

## 安全诊断

浏览器读取批次只保留 `error_stage` 和受限 `error_code`；本地循环 notice 只保留 `collector_stage`、受限代码和固定 error_name。不保存异常消息、栈、重定向中的查询内容、Cookie、Token 或页面凭据。

连接错误不能自动当成 429；解析、持久化和进度错误也不应触发网络重试。访问挑战使用正常授权会话和当地 Task Master 的等待机制，不能通过换 Profile、隐藏入口或导出凭据绕过。

## 快照边界

采集期间帖子仍可能新增、编辑或删除评论，因此长任务不是数据库一致性快照。保存批次时间与首次来源。`exhausted_accessible` 只说明此方法在当时会话和端点下没有已知剩余前沿，不证明历史评论绝对全量。

每次运行的具体帖子、Profile、错误数量、吞吐和真实响应验证只写入 outputDir 的 retrospective。要推广为新规则，先按 [自复盘与自迭代](self-iteration.md) 形成脱敏回归。
