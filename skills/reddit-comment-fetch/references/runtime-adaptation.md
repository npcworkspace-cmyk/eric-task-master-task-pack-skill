# 运行与跨环境适配

## 能力探测

每台设备都以当地安装的 Eric Task Master Skill、CLI `--help`、发行清单或官方示例为准。仅确认：

1. 本地模块如何启动，是否要求注册；
2. page/context 怎样交付，谁拥有 Profile 与浏览器生命周期；
3. input 和 outputDir 的类型、路径与持久性；
4. progress、wait、取消和外部停止的实际语义；
5. Worker 结束、等待、恢复与新任务续采怎样区分；
6. 入口是否被单文件冻结，能否引用兄弟模块。

不要用版本号、操作系统或旧设备路径推断接口。文档足够就适配；只有文档与行为冲突时才读取最少的本地实现。不得创建另一套浏览器控制器。

## Pack 需要的最小契约

参考入口导出 `run(runtime)`，并将易变接口限制在执行器的 adapter 区域。当前算法真正需要：

```js
{
  page,       // 必须支持 goto；优先读 goto 响应的 text()，locator('body').innerText 只作正文 fallback
  input,      // 本次 JSON 配置
  outputDir,  // 本次可写的路径
  signal,     // 可选 AbortSignal
  progress,   // 可选异步进度回调
  wait        // 可选异步等待/人工交接回调
}
```

正文读取不把 locator 当硬前置能力：`page.goto()` 返回对象有 `text()` 即可；没有 `response.text()` 时，才要求 `page.locator('body').innerText()`。两者在导航后都不可用时，首个批次记录 `RUNTIME_BODY_CAPABILITY_MISSING`，随即以 `blocked/runtime_body_capability_missing` 停止并在 coverage 留下受限 notice；这属于运行时适配缺口，不得当成网络波动重复读取，也不能把空正文当成有效 JSON。

如果当地运行时字段不同，制作当次适配副本，把它映射到上述内部契约；不要把设备路径或运行版本分支写回采集内核。入口被单文件冻结的环境必须保持生产入口自包含；说明、测试与辅助脚本无需随 Worker 复制。

## 跨平台要求

- 路径用 `node:path` 构造；不拼接路径分隔符，不硬编码盘符、home 或安装目录。
- 文件操作使用 Node 内置 API；路径由参数或运行时提供。路径示例只写占位符。
- 不调用 PowerShell、bash、cmd、系统 `zip`、curl 或操作系统专有浏览器命令作为采集前提。
- 输入和 JSONL 使用 UTF-8；时间使用 ISO 8601 UTC；帖子和评论 ID 始终按字符串。
- 采集内核不靠当前工作目录定位自身资源。用户明确传入的相对 `resumeFrom` 按 Worker 当前目录解析；Skill 自身的相对引用由脚本相对于自身定位。
- Profile 的选择、租约和清理由目标 Task Master 管理；Pack 不保存 Profile 名称或凭据。

## 生命周期映射

| 业务目的 | 运行时能力 | Pack 行为 |
|---|---|---|
| 短暂冷却 | sleep 或 runtime wait | 先保存断点；即使被提前唤醒也不绕过截止时间。wait 抛错时记录受限诊断并用本地 sleep 等到原截止时间 |
| 人工恢复访问 | runtime wait/handoff | 先交付 partial，再等待当地正常授权访问；wait 抛错则明确结束为 `blocked/runtime_wait_failed`，保留断点供显式续采 |
| 用户暂停 | 当地官方 pause；没有则官方 stop | 停止新请求，保留 outputDir；不得伪造 Worker 状态 |
| 进程退出后续采 | 新任务 + resumeFrom | 校验完整旧日志，回放已写未应用批次，再继续 |
| 采最新快照 | 新任务且不传 resumeFrom | 与补完旧任务分开，不混用数据谱系 |

Manager 能否原地 resume 与业务断点能否续采是两件事。运行时升级后重新核对 pause/stop/resume 的命令和语义；Skill 只固定“先停止请求、保存证据、显式恢复”的业务不变量。

## 适配验收

离线复盘的目标目录必须是新目录，父目录已存在，且与运行证据目录互不包含。检查重叠时解析父目录的真实路径，避免系统路径别名把输出放回原始证据目录；别名不构成独立的输出位置。

1. 导入实际生产入口，确认语法和导出函数。
2. `node scripts/verify-pack.mjs <实际入口>` 跑完离线行为测试。
3. 在临时目录运行 `node scripts/validate-release.mjs <Skill目录>`，确认版本一致、链接有效且没有任务绑定内容。
4. 核对当地 launcher 的真实参数、引用与 Profile 生命周期。
5. 用户已授权真实采集时，先用其输入做小预算运行，检查 JSON、批次、断点、manifest 和 retrospective，再扩大预算。

合成测试不能证明当地会话、网络或站点权限。若用户只要求打包或部署，离线验收足够，不要自行选择真实帖子启动浏览器。
