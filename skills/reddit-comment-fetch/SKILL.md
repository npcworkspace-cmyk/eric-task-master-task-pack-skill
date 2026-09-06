---
name: reddit-comment-fetch
description: 使用 Eric Task Master 获取已确定 Reddit 帖子的当前可访问评论，或在不同设备、操作系统和 Task Master 版本间部署、适配、复盘与改进评论采集 Pack。采用 JSON 评论树、morechildren 和父评论聚焦子树，不负责找帖或 VOC 分析。
metadata:
  version: "3.0.1"
---

# Reddit 评论获取

这是可移植的 **方法文档 + Pack 执行器 + 验收与迭代工具**。发行包不得包含任何一次任务的帖子、Profile、Task ID、账号、日期、运行统计、绝对路径或原始数据。任务设置只放在当次 input 和 outputDir。

## 执行路径

1. 用户已给帖子 URL/ID 就按其范围执行，不自行扩展找帖。沿用当前会话已明确的 Profile、跳过和恢复要求，不重复询问。
2. 读取目标设备当前 Eric Task Master Skill、CLI 帮助或本地契约，只核对入口、浏览器对象、输入、输出、等待、停止和文件冻结方式。按 [运行与跨环境适配](references/runtime-adaptation.md) 选择直接运行或制作适配副本；不靠固定版本号、launcher 路径或宿主 shell 猜接口。
3. 从 `assets/reddit-comment-tree-pack/` 复制 Pack，生成当次 input。输入只接受帖子、读取预算、可选业务断点和跳过策略，详见 [数据契约](references/data-contract.md)。
4. 修改执行器或适配层后，运行 `node scripts/verify-pack.mjs <实际入口>`。随后按本地 Task Master 契约启动和跟随任务。
5. 交付评论、coverage、result、manifest 和运行复盘。Task Master 执行结束不代表评论历史绝对全量；以业务 coverage 为准。
6. **每次执行后完成迭代闭环。** 正常结束时 Pack 先生成运行内 `run-retrospective.json` 与 `run-retrospective.md`；交付后 Agent 仍须对 outputDir 运行 `review-run.mjs`，在新目录生成经 manifest 核验的复盘及 proposal/no-change 草案。异常强停后先整理断点，再执行同一离线复盘。按 [自复盘与自迭代](references/self-iteration.md) 分类；只有证据支持改版时才进入 staging promotion gate。

## 稳定方法

```text
帖子 URL / ID
→ 初始 /comments/{post}.json
→ 提取 t1 并递归 replies
→ more.children 通过 morechildren 分批补取
→ 深层空 more 以已知父评论为焦点读取同帖子树
→ 评论按稳定 ID 去重，两条前沿共享节奏和预算
→ 原始批次先落盘，再推进 checkpoint
→ 输出评论、缺口、完整性清单与运行复盘
```

这种方式读取结构化 JSON，不需要滚动或逐条点击。具体端点、关闭缺口的证据和常见误判见 [方法、收益与坑](references/method-and-pitfalls.md)。

必须保持：

- **证据关闭缺口。** 请求成功不等于每个 ID 已返回；焦点身份和直接展开证据成立，才能关闭深层空 more。
- **批次先于断点。** 原始响应原子落盘后才推进状态；恢复时校验并回放，不依赖浏览器内存。
- **有界且共享的读取策略。** ordinary more 与 focused thread 串行、共享预算和限流；失败与无进展都必须停得下来。
- **业务状态属于 Pack。** Task Master 负责浏览器和 Worker 生命周期；解析、队列、去重、coverage、断点和复盘由 Pack 负责。
- **任务证据留在任务目录。** 发行 Skill 只保存可复用规则、合成测试和无任务绑定的验证结论。

访问遇到登录、验证、权限不足或 429 时，使用当前 Task Master 已提供的等待／停止机制并保留断点。不要换 Profile、导出凭据或改用另一套浏览器控制器绕过限制。用户已要求跳过不可访问帖子时，记录原因并继续；限流仍按全局策略处理。

## 跨设备边界

Pack 使用标准 Node ESM、Node 内置模块、`path` 和运行时交付的 Playwright page；不写死盘符、用户目录、路径分隔符、Profile 名、shell 命令或 Task Master 安装位置。目标环境必须自行提供兼容的浏览器 page、可写 outputDir、取消信号，以及它声明支持的进度／等待能力。

未知环境先用小预算、合成测试和临时输出目录验证适配。兼容是能力核对后的结论，不是“同名工具”或 schema 数字相同的推断。部署和打包见 [Skill + Pack 发行约定](references/skill-pack-standard.md)。

## 迭代边界

自动复盘只读取本次产物并给出证据、严重度和建议目标；**执行器不能在采集过程中覆盖自己的源码或已安装 Skill**。Agent 在隔离副本中实施通用修改，同时更新相关 MD、版本和测试。只有验证通过且不含任务绑定内容，才替换安装副本并保留回滚包。

一次站点波动、某帖特性或单个 Profile 的访问结果不应直接升级成全局规则。会影响数据完整性、安全、恢复或跨环境运行的问题可以单次触发修复；性能调参通常需要至少两次独立运行呈现同一模式。完整门槛见 [自复盘与自迭代](references/self-iteration.md)。

## 可验证范围

`validation.json` 只记录发行包自身的静态、合成和跨平台验证，不保存任何业务任务证据。真实采集证据由对应 outputDir 的 batch、coverage、manifest 与 retrospective 承担。没有实际运行就写“离线验证”，不得把 fixture 数量算进业务结果，也不得承诺 Reddit 当前可用、固定吞吐或历史绝对全量。
