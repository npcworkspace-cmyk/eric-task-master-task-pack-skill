# 高效采集的技术实现

Facebook 页面结构及操作名称不是稳定公开协议；新项目先校准，结构变更应明确停止并修适配器，不能把无法解析的数据视为没有帖子。字段适配与恢复逻辑是技术资产，现场链接、数量、日期和页码留在任务记录中。

## 页面内存中的原生请求

由 Task Master 提供的 `page` 导航到用户给定群组。监听目标页面自然产生的 `GroupsCometFeedRegularStoriesPaginationQuery`，验证群组ID与 `CHRONOLOGICAL` 排序后，在内存保留请求模板。新批次重新从页面取得模板，在同源页面上下文发起同一个只读分页操作；只使用服务端返回的cursor，保持原生count=3。

这条路径避免几千次DOM滚动持续扩大页面内存。它不把Cookie、token、请求头或原始request body写入文件，不复制凭据到外部程序，也不伪造签名或改成任意mutation。页面本身提供的权限、登录状态和限制仍然生效。被拒绝、速率限制或验证挑战时保存已有结果并停下，不靠并发、换账号或循环重启强行通过。

新批次会初始化群组页面以取得当前请求模板。这与重新逐页翻完整个历史前缀不同：真正的分页请求从断点cursor直接接续。若无法获取当前模板，应报告初始化失败，不宣称断点失效。

## 流式解析，防止每页漏两条

一次响应可能包含多行JSON，不是一个JSON对象。已验证的三条帖子分布可能是：

```text
frame 1: data.node.group_feed.edges[0].node
frame 2: data.node, path=["node","group_feed","edges",1]
frame 3: data.node, path=["node","group_feed","edges",2]
final:   data.page_info, path=["node","group_feed"], extensions.is_final=true
```

遍历完整frames并收集root Story；按post_id去重；读取末帧 `end_cursor` 和 `has_next_page`。必须验证final和分页信息。仅解析第一帧会产生“响应正常、每页只有一条”的系统性漏帖；遇到截断、JSON错误、缺失末帧、非预期边结构应保留失败原因，不能推进可恢复游标。

## 字段映射

| 输出 | 已验证来源 | 规则 |
|---|---|---|
| post_id / 主帖链接 | root Story post_id / canonical group permalink | 字符串；校验群组；不拿评论ID替代 |
| 主贴正文 | `root.comet_sections.content.story.message.text` | 只取同一Story的message；不拼入评论 |
| 分享原文 | `attached_story.message.text` | 独立字段，与主贴附言分开 |
| 发布时间 | root Story `creation_time` | 保存epoch和ISO，不用评论hover时间 |
| 附件类型 | 附件内 `media.__typename` 等结构 | 用作无正文解释证据，不做文字猜测 |
| 采集时间 | 每条记录实际观测时刻 | 互动数字与正文变更均按此解释 |

互动字段定位从：

```text
target = root.comet_sections.feedback.story.story_ufi_container.story
         .feedback_context.feedback_target_with_context
actions = target.comet_ufi_summary_and_actions_renderer.feedback
                .adaptive_ufi_action_renderers

UFIStoryReactActionRenderer.feedback.reaction_count.count
UFICommentActionRenderer.feedback.comment_rendering_instance.comments.total_count
XFBUFIAdaptiveShareActionRenderer.feedback.share_count.count
```

评论可回退到同一target的 `comment_rendering_instance.comments.total_count`。必须依类型识别renderer，不依赖数组固定下标。不要把comments页面的部分加载数当成评论总数，也不要把Like-only数与全部reaction混用。只拿到“1.2K”等显示值时保留显示值/近似属性，精确数仍为null。

## 游标与持久化顺序

每页记录作用域、页号、request_cursor、next_cursor、响应完整性、has_next、归一化post字段和时间证据。

初始化使用最先匹配目标上下文的自然分页请求作为bootstrap锚点。它的request_cursor可以是非空值，因为初始HTML已带第一页；必须保留真实值，不强制改成null。之后每个分页仍严格以返回cursor接续。仅允许第一个匹配响应推进bootstrap，避免多个初始化响应先后完成顺序不同导致游标被覆盖。初始页面自带JSON只提取严格白名单的主帖字段，不保存原始页面JSON。

首次page 0日志收齐bootstrap与头部种子；续采初始化只更新内存请求模板，不把未经本次日志记录的头部观测混入结果。持久化顺序：

1. 解析并验证响应，归一化每条记录。
2. 追加日志并fsync，保证每页证据先保存。
3. 同目录临时文件写入、fsync，再原子替换checkpoint。
4. 更新聚合posts/audit快照和可见进度。

意外停止时聚合快照可能落后几页；先重放已提交journal恢复数据，再从最后有效游标接续。最后一个失败/终止响应的null cursor不能覆盖先前可用cursor。日志末尾无换行的半条记录不可视为已提交。

在任务授权范围内做有界复核时，只有相同页号、相同request_cursor的后来完整成功页可替代已支持的失败尝试。支持的情形是干净的完整空终页，或无接口/解析错误、缺少final与分页信息的普通截断响应；精确条件由collector和audit的同一契约校验。旧尝试保留为诊断证据，失败观测不参与正式字段重放。不同cursor的同页、普通成功页重复、非空终页、认证或响应错误不能自动合并放行。

作用域包括群组ID、固定起止、排序、原生页大小。续跑前校验作用域、日志存在、页序、游标链；另一个群组或另一个日期窗口的checkpoint不可混用。独立batch输出目录必须唯一，所有旧history文件保留。下游统计按post_id去重，保留最新有效观测，不用后来的null覆盖先前已知值。

Windows原子替换对EPERM/EBUSY/EACCES做短暂有限重试：50、100、200、400、800、1000、1000ms，共3.55秒。重试同一临时文件，不删除目标、不改ACL。若读者始终占用仍需停止修复，不能无限重试。

## 批次策略与真实覆盖

每批分页请求预算由当前任务显式提供，Skill 不保存历史任务的默认页数。该数表示请求页，不是固定帖子数或浏览器滚动数。仅到达 page_limit 且 checkpoint 确实前进才自动开始下一批。模块自包含，Task Master 复制单个入口后仍可执行；不能依赖旁边未被复制的模块。

平台返回feed_end可能早于任务范围。依据完整响应和最后有效游标做有限复核，复核成功后保存其衔接证据再继续。不要从单次停在某个页号推断平台存在固定分页上限，也不能把重启当作必然有效或无限自动重启。

按本地时间窗筛选不等于后端日期跳转。原生时间顺序也可能回跳：不能见一条旧帖即停止。默认观察连续5个完整旧页，同时检查未知日期、页内及跨页回跳和游标连续性。存在未解释回跳时要求独立审核；输出“观察到时间边界”与“覆盖已验证”的区别。

## 导出

JSON保留原始文字与精确字符串ID；CSV对潜在公式开头的文本做表格安全处理并在说明中记录；XLSX的ID和正文显式保存为文本。不同Excel库对前导单引号的处理不同，不能将CSV防护后的字符串直接当作XLSX原文。验证等号、加号、减号、@、原有单引号、Unicode及换行的写入和读回。超出Excel单元格32767字符限制的文本放入分片附表，并让主表指向分片，JSON/CSV必须保留全文。每份文件核对行数、主键、范围和全文。

交付只使用显式列白名单。auth、cursor、请求模板和内部history不进交付ZIP；断点留在用户的任务工作目录供后续恢复。

## 技术经验闭环

诊断应先定位层次：接口适配、流解析、日志持久化、游标恢复、调度、核验或格式导出。用最小合成fixture复现技术问题，再修正对应层并验证正例和负例。不要把一次的实际规模、群组业务内容、目标停止数或现场恢复页写成执行器常量。每次收尾的记录、候选、采纳和回退按 [演进机制](evolution.md) 执行。
