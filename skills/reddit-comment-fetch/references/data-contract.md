# 输入、产物与完成性契约

## 输入

| 字段 | 规则 |
|---|---|
| posts | 必填，1–1000 个 Reddit 帖子 URL 或 base36 ID；规范化后去重。1000 是内存保护上限，不是任务默认范围 |
| resumeFrom | 可选，上一业务输出目录。绝对路径最明确；相对路径按 Worker 当前目录解析，启动前应显示解析后的本地路径供核对 |
| maxRequests | 可选，本次读取尝试预算，默认 300，范围 1–100000；失败读取也计入 |
| skipUnavailable | 可选布尔值，默认 false；true 时普通读取失败跳过对应帖子，深层读取失败只保留该锚点缺口；429 仍全局处理 |

输入示例只有占位 ID，不是默认任务。Pack 根据规范化帖子 ID 构造 Reddit HTTPS 端点，不导航到输入中的任意主机或路径。排序固定为 confidence；改变帖子集合、排序、状态 schema 或不兼容 method revision 都不是同一断点。

## 数据和来源

评论以稳定 comment ID 去重，保存 post ID、parent ID、正文、作者、时间、层级提示和首次来源批次。递归 replies 与 morechildren 可能重复返回同一评论；首次持久化来源保持不变。

`[deleted]`、`[removed]` 和空正文按平台实际返回保留。某个请求 ID 未返回不能推断为删除。页面显示评论数、请求 ID 数、返回对象数和去重评论数是不同指标。

## 产物

| 文件 | 用途 |
|---|---|
| batches/*.json | initial、more 或 thread 的原始响应和受限诊断；恢复与审计依据 |
| checkpoint.json | 帖子身份、队列、锚点、已应用批次摘要与请求状态 |
| comments.jsonl | 去重后的评论对象，一行一条 |
| coverage.json | 每帖已保存数据、普通缺口、深层锚点、跳过和诊断 |
| result.json | 本次业务状态、原因、计数和相对产物引用 |
| run-retrospective.json/.md | 每次优雅结束时自动生成的聚合复盘；不修改源码 |
| manifest.json | 以上文件与原始批次的字节数和 SHA-256 |

manifest 中只写 outputDir 内的 POSIX 相对路径。可迁移身份使用帖子集合、排序、状态摘要和文件哈希；本机绝对路径不是业务身份，也不应成为消费者依赖。

当前状态为 `schema:1`、`method_revision:"experimental-thread-anchors-v1"`。继续旧状态前同时核对二者；只允许明确列入兼容集合的来源 revision。未知 revision 在任何网络读取前拒绝，不能覆盖成当前值后继续。缺失或为 null 的 legacy revision 只兼容旧 initial/more 形状；只要 checkpoint 出现 `thread_anchors`、`resolved_empty_more`、pending thread 请求或 thread batch，就在联网和复制证据前拒绝。

## 覆盖口径

| 字段 | 含义 |
|---|---|
| queue_count / queued_ids | 已发现、尚未请求完成的普通评论 ID |
| missing_ids | 有界读取后仍未返回评论对象的 ID；原因未知 |
| empty_more | 尚无直接展开证据的空 more 观察 |
| resolved_empty_more | 已由焦点身份和直接展开证据解决的原观察 |
| thread_anchors | pending、resolved 或 unresolved 的父评论焦点 |
| remaining_unresolved | pending + unresolved 锚点数 |
| structural_gaps | 无法按已知结构解释的响应节点 |
| missing_parent_ids | 已返回评论引用了本结果中未返回的父评论 |

这些类别可能指向同一分支，不能相加成“缺失评论总数”。HTTP 200、新增评论数大于零或普通队列清空都不足以关闭深层缺口。

业务状态：

- `exhausted_accessible`：已发现的普通与深层前沿均处理完，且没有已知缺口；只代表当前可访问对象。
- `partial`：预算结束、跳过、未返回 ID、未解决锚点、结构缺口、停止或暂时读取失败；已有数据可交付和续采。
- `blocked`：访问挑战、重复限流、外域重定向、缺少必需运行能力，或人工 handoff wait 失败阻止继续。正文读取器均不可用时原因固定为 `runtime_body_capability_missing`，并在首个诊断 batch 后停止；人工 handoff wait 失败时原因固定为 `runtime_wait_failed`。

Worker completed、退出码 0、JSON 解析成功和 advertised num_comments 都不能替代 coverage。

## 恢复

Pack 先原子写原始 batch，再推进 checkpoint。恢复时：

1. 校验 schema、method revision、legacy 请求/字段形状、帖子集合与排序；
2. 校验全部已应用 batch 的文件名、请求身份、规范端点和摘要；
3. 保留旧 batch 字节；
4. 回放已经落盘但 checkpoint 尚未应用的响应；
5. 对没有持久化响应的 pending 读取按原节奏有界重试。

同一 Worker 的 wait/resume 和进程退出后新任务的 resumeFrom 不是一回事。用户暂停时使用当地 Task Master 官方 pause；当地没有 pause 时使用官方 stop 并保留 outputDir。以后是否原地恢复由当地运行时决定，业务续采始终可以由兼容 Pack 验证断点后新建任务。

重新采最新评论快照时不要传 resumeFrom。跨设备复制断点后，将 resumeFrom 指向新设备的本地目录；manifest 和 checkpoint 哈希用于判断内容是否仍为同一谱系。

## 强停后的离线整理

强停可能来不及写最终清单。请求确认停止后，可在 Skill 目录运行：

```text
node scripts/finalize-paused.mjs <source-output> <new-delivery>
```

工具只读源目录，目标必须不存在且不能与源重叠。它校验已应用日志；发现篡改、缺批次或已落盘未应用响应时拒绝整理。通过后在新目录重建 comments、coverage、result 和 manifest，明确标为 `partial/user_paused`。不得为了出报告偷偷恢复网络。

随后执行 `review-run.mjs` 生成脱敏聚合复盘和迭代候选。详见 [自复盘与自迭代](self-iteration.md)。
