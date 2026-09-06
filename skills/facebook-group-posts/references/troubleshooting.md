# 已遇到的坑与处理顺序

每次先读取状态和最后持久化证据，再决定是否恢复。只显示一个不变的去重总数无法诊断任务。

| 现象 | 已验证或需要确认的原因 | 策略 |
|---|---|---|
| 帖子数长期不变，浏览器很慢 | 长时间DOM滚动导致页面持续增长，或正在重走已采区间 | 看页数/cursor是否前进。用同源原生分页减少DOM增长；以保存cursor恢复；不靠反复重启从首页翻回去 |
| 每页只有1条，响应正常 | 只读首个JSONframe，遗漏后续2条 | 解析全部stream frames，验证末帧与page_info，合成测试至少3个独立Story |
| 换批后旧帖子数长时间不变 | 去重前缀正在重放，或实际页面仅初始化 | 检查首个正式request_cursor与上批end_cursor相等；报告本批页与新post增量 |
| 结束但最早日期未到起点 | feed_end不是整月完成证据 | 保存最后有效cursor；做有限复核；仍无新数据则交付partial并注明缺口，不无限重启 |
| 新任务又从第一页开始 | checkpoint缺失、作用域不符或终端null覆盖 | 明确拒绝隐式降级；用已记录cursor恢复；缺cursor时无法凭页号重建 |
| 整页转圈，抓不到请求 | 曾屏蔽image/media/font导致页面初始化不完整 | 默认不屏蔽这些资源；等可见正文和自然请求，有限滚动；勿把初始化失败当空群 |
| 旧页中又出现较新日期 | 平台返回顺序并非严格递减 | 保留原始creation_time；连续多旧页+链检查+人工复核；不按一次回跳推断漏页或直接改日期 |
| hover时间不同、文章像评论 | DOM article语义包含评论容器 | 使用root Story与group/post_id定位；主帖时间与页面主贴头部抽样比对 |
| 正文为空但有分享长文 | 主贴没有附言，分享原文属于attached_story | 主贴空值保持；分享原文独立列；分无附言分享与未知空文 |
| 分享数/赞数/评数全变0 | 字段结构变化，空值被默认填0 | 分开missing和0；保存字段来源；结构变化停止并修适配器 |
| 日期明明一样却scope mismatch | PowerShell自动把ISO转DateTime，隐式字符串再解析丢失偏移 | Node保持JSON字符串；若维护PS版，使用ConvertFrom-Json -DateKind String或等价保真解析，比较UTC时刻 |
| CLI中文标签导致JSON无法解析 | 隐藏PowerShell/native输出UTF8被按GBK解码 | Node按UTF8读取子进程字节；PS则统一Console输入/输出及$OutputEncoding；不要打印原始敏感响应排错 |
| 原子写入报EPERM/EBUSY/EACCES | 阅读器短暂锁住被替换文件 | 短时关闭读者、有限原子rename重试；读者共享ReadWrite/Delete；不删目标强行替换 |
| checkpoint已前进而posts较旧 | 日志/断点先落盘，聚合文件更新时异常 | 重放已提交的有效journal补齐快照，再从最后有效cursor继续；不能只看旧聚合JSON重采全部 |
| PS File.Replace失败 | null备份参数被绑定为空字符串 | PS7用File.Move(temp,target,true)并有限重试；当前Pack用Node原子rename |
| 新批一直queued | 手动打开同Profile窗口或另一worker占租约 | 查Profile租约与任务状态；采集批次全部结束后再恢复手动窗口，不新建并发writer |
| Manager被关闭又冒出新任务 | 监督器把故障当作重新启动信号 | 运行中固定Manager身份；服务停止/改变则停调度并人工诊断；launch结果未知不能重复创建 |
| 用户说停了但worker仍跑 | 只停监督器，没有停止当前Task Master任务 | 使用Pack stop入口并核验当前task终态；保留断点，取消也不默认删数据 |
| 新设备提示 launcher not found | Task Master CLI 不在 PATH，且未显式配置 | 用 doctor 查看解析结果；通过 `--launcher` / `--taskmaster` 或 `ERIC_TASK_MASTER_CLI` 指向当前设备的正式安装，不把该路径写回 Skill |
| 任务已停但复盘状态仍 pending | 尚未运行任务本地 `evolve.py review` | 根据终态证据选择 `no_change` 或 candidate；review 收据生成后状态才变 completed |
| 发布 ZIP 被拒绝 | Skill 目录有缓存/未知文件、manifest 漂移、具体任务 URL/路径或禁止 token | 不放宽扫描；清理未声明缓存，将任务材料移回工作区，刷新并验证 manifest 后重新打包 |
| 同游标重试成功，审核仍报失败页 | 采集器与审计器对重试历史使用不同规则 | 保留原尝试，仅按共同的严格判据选择后续完整成功页；失败观察不能作为正文或计数依据 |
| Excel正文比JSON多一个引号 | 把CSV安全前缀直接复用到Excel库，而库保留了前缀 | 按格式分别构造值；XLSX显式字符串；逐字符读回验证，不能放宽核验掩盖差异 |
| 技术修复只在某次任务里有效 | 补丁含群组、数量、范围或现场路径；没有可移植fixture | 将需求保留任务层，提炼技术不变量后隔离修改；验证通过才按evolve机制采纳 |

## 恢复决策

- `page_limit`：校验本批页数、scope、history、有效cursor后自动下一批。
- 时间边界：停止采集，进入覆盖审核；有回跳/未知日期则先解决或标限制。
- `feed_end`：结果可交付但不能宣称整月齐全；检查边界和历史，必要时从同一有效断点做一次有界复核。
- 认证/挑战/限流：保留已获数据，交给用户或等待允许的恢复时点；不绕过。
- 截断响应/字段缺失/文件占用：有限重试或修复后明确恢复；先核对日志是否已提交，避免重复启动。
- 用户暂停/取消：保留全部现有产物与断点。若Manager要求人工等待，使用其等待状态；不要擅自resume。

## 未验证的捷径

不能把“按日期直接跳群组feed”“凭post_id推导任意页cursor”“任意增大count”“重启一定突破上限”当作支持能力。未经有效验证的页面入口、日期跳转和请求形状不进入通用Pack。

每次遇到的新问题均在任务本地复盘。只将可复现的技术根因、对应策略与验证吸收进Skill；没有新通用问题时记录no_change，不增加无依据的全局规则。
