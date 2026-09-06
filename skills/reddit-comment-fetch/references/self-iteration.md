# 每次执行后的自复盘与自迭代

目标是让真实运行持续改进通用方法，同时避免把某次任务、某台设备或偶发站点波动写进发行 Skill。

## 每次运行都做

正常结束时，执行器先在 outputDir 生成：

- `run-retrospective.json`：结果、完整性、故障、恢复和迭代信号的机器可读摘要；
- `run-retrospective.md`：给 Agent 和用户阅读的同口径说明。

交付完成后，Agent 对每次正常、暂停或受阻运行都必须执行一次离线复盘。强制停止导致执行器来不及交付时，先用 `finalize-paused.mjs` 生成离线暂停快照；然后对正常 outputDir 或暂停快照执行：

```text
node scripts/review-run.mjs <run-output> <new-review-directory>
```

review-run 只读源目录，并对 manifest 做失败关闭校验：四个核心证据、磁盘上的数字 batch 和既有 review 文件都必须双向列全且哈希相符。它在新目录生成经核验的复盘和 `iteration-proposal.json` 草案；没有改版信号时草案分类为 `no_change`。manifest 缺失时只生成 `evidence_untrusted` / `no_change` 结果，不得提出改版候选；manifest 有遗漏或篡改时不生成复盘目录。它不联网、不恢复采集、不改安装 Skill。

Agent 必须阅读复盘中的 `observations`、`decision` 和 `iteration-proposal.json`，用同一组分类词为本次运行选择：

- `no_change`：只有任务进度、预算耗尽、已知访问波动或没有新证据；
- `docs`：方法仍正确，但边界、诊断或适配说明不足；
- `executor`：解析、持久化、恢复、完整性或安全行为有可复现缺陷；
- `executor_and_docs`：实现与公开契约一起改变；
- `runtime_adapter`：仅当地 Task Master 接口变化，优先修改适配副本；可复用时才回写通用参考。

`pending_agent_review` 只表示 Agent 尚未完成上述分类。`candidateTargets` 与最终 `classification` 必须使用这组名称；`no_change` 不进入 staging promotion gate。

## 什么时候可以改

以下问题有一份可审计证据即可进入修复：数据丢失或重复、断点不能安全恢复、manifest 不一致、错误解析站点数据、越权输入、凭据泄漏、取消后仍请求、跨平台路径或文件语义导致失败。

性能、节奏、重试次数、某种响应形状的普遍性，通常至少需要两个独立运行呈现同一信号。单帖数据结构、单一 Profile 权限、某次网络错误和本次评论数量只能留在运行复盘，不成为全局默认。

## 迭代步骤

1. 先完成离线 review-run，并由 Agent 把 proposal 分类；只有分类不是 `no_change` 且证据达到上述门槛时，才从当前已安装版本复制到新的 staging 目录。
2. 只引入复盘证据支持的最小修改。修改执行器时同步方法或数据契约；只改文字时不要制造代码变更。
3. 把失败固化为合成回归测试，fixtures 不得含真实帖子、账号、Profile、Task ID、路径或业务数据。
4. 运行：

```text
node scripts/verify-pack.mjs <staging中的collect.mjs>
node scripts/verify-paused.mjs
node scripts/verify-review.mjs
node scripts/verify-release.mjs
node scripts/verify-portability.mjs
node scripts/validate-release.mjs <staging Skill目录>
```

5. 让独立 Agent 用最少的匿名证据审核真实行为；不得把原结论当成审核答案。
6. 更新 SKILL 与 Pack 的语义版本，重建 `validation.json`。验证记录只保存通用测试结论和源码哈希，不复制任务证据。
7. 用 `package-skill.mjs` 生成新 ZIP；核对 ZIP 清单与安装副本。替换前保存旧 ZIP 或目录备份。

## 自动化边界

执行器可以自动生成复盘、指出目标文件和建立迭代建议，不能自己决定并覆盖源码。源码修改由具有上下文的 Agent 在 staging 中完成，因为它需要区分平台波动、任务特性和通用缺陷。只有通过回归、无任务绑定扫描、版本一致性和独立审核的候选才能安装。

迭代完成后，任务复盘仍留在原 outputDir；发行包只带经过抽象后的规则和合成测试。这样跨设备分发不会泄漏任务范围，也不会让旧任务数据成为新任务默认值。
