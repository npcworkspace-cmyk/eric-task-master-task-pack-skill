# Eric Task Master 最小运行手册

本页足以让未安装独立 `eric-task-master` Skill 的 Agent 执行本包。已有该 Skill 时同时遵循本机当前版本说明；已知任务授权、客户指定 Profile 和暂停/冷却状态始终沿用。

## 缺环境时怎样处理

本包离线程序需要 Node.js 22 或更高版本；浏览器执行需要正式 Eric Task Master 和稳定版 Chrome。先在本次机器运行 `tiktok-seed-discovery/scripts/doctor.mjs`，按返回的 `missing` 和 `agentNextSteps` 处理明确缺项，不对每个普通批次重复安装检查。

1. 已有启动器时，使用 doctor 返回的实际路径；可用 `environment.json` 的 `taskmasterPath` 或 `TASKMASTER_CLI` 固定当前安装。明确路径失效时修正该配置，不悄悄换另一套程序。
2. 缺 Task Master 时，查看 [官方最新 Release](https://github.com/npcworkspace-cmyk/eric-task-master/releases/latest) 的真实版本、资产名称、安装说明与校验文件。根据本机 OS 和 CPU 架构选择匹配包：`windows-x64`、`macos-arm64`、`macos-x64`、`linux-arm64` 或 `linux-x64`。未列出的架构不能声称已支持。
3. 优先使用该 Release 的安装包；安装器不可用时采用同一 Release 的 `eric-task-master-v<VERSION>-<TARGET>-portable.zip`。文件名中的 VERSION/TARGET 从真实 Release 与本机读取，不使用写死版本。下载同 Release 的 `SHA256SUMS`，计算包文件 SHA256 并与对应资产逐字核对；不匹配就停止安装并报告。
4. 便携包解压到稳定目录，用其中 `eric-task-master/bin/taskmaster.cmd`（Windows）或 `eric-task-master/bin/taskmaster`（macOS/Linux）的绝对路径。便携发行包含 Node.js 与 Playwright；确认实际 Node 版本满足本包要求。独立 Skill ZIP 是说明文件，不是 Manager 程序。Chrome 仍需本机安装。
5. 本机安装、执行权限或登录需要用户操作时，只说明当前具体缺项和操作位置；保留已填业务信息。按已有安装授权继续，遇到 OS 审批交给用户，不为缺依赖自动修改代理、网络或浏览器安全配置。

SHA256 可用 Windows `Get-FileHash -Algorithm SHA256 -LiteralPath "实际包路径"`、macOS `shasum -a 256 "实际包路径"` 或 Linux `sha256sum "实际包路径"` 计算。只比较当前实际下载资产与官方同 Release 校验值，不拿另一版本的校验值凑数。

## 选择 Profile 和登录

客户已经指定 Profile 时，每次 `run` 显式带 `--profile NAME_OR_ID`，不可替换或自动轮换。未指定且 Task Master 已有默认 Profile 时可以使用既有默认；若返回 `DEFAULT_PROFILE_REQUIRED`，用 `taskmaster panel --json` 打开 Dashboard，请用户选择或创建 Profile。

需要手动登录时，在 Dashboard 打开已选 Profile，或运行 `taskmaster profiles open NAME_OR_ID`。这会打开普通 Chrome，用户自行登录；关闭该 Profile 的手动窗口后再启动自动任务。不要导出、复制或记录 cookies、口令、令牌。复用 Profile 不保证平台不会再次要求验证。

## 一次启动，持续跟踪，读取产物

下列命令中的 `taskmaster` 表示 doctor 已确定的启动器；当前 shell 不能直接找到它时，用正确引用的绝对路径。TASK_ID、PROFILE、SEQUENCE 都由实际返回值或用户选择替换：

```text
taskmaster run ./reference-browser.mjs --input "@reference-input.json" --profile PROFILE --detach --json
taskmaster panel --json
taskmaster follow TASK_ID --wait-ms 30000 --json
taskmaster follow TASK_ID --after SEQUENCE --wait-ms 30000 --json
taskmaster status TASK_ID --json
```

`run` 会按需要启动 Manager。保留 Task ID、实际 outputDir，以及 `panel --json` 返回的 Dashboard URL，并把 URL 告知用户。每次 follow 保存最新 after 游标；只报告有意义的数量、状态变化或需要处理的缺口。不要反复提交 run 来代替 follow。

提交结果不确定时，可使用预先记录的 `--request-key KEY` 去重：同键同输入返回同任务，内容改变必须另用新键；先核状态而非盲目重复。KEY 为 1–160 个 ASCII 字母、数字或 `._:-`，首字符为字母或数字。

Task Master **只冻结入口 `.mjs`**。本包 `reference-browser.mjs` 与 `browser.mjs` 均自包含；相对同级 imports/文件不会自动复制到 Worker。配置经 `--input "@文件路径"` 读入；离线 process/frontier/reference-analysis 在安装目录运行，并显式传实际任务产物目录。

浏览器任务将有价值观察、分页和 checkpoint 增量保存到 outputDir。任务完成后读取文件，即使停止/失败也交付可用部分与未开始清单。`finished`、Worker 返回成功、HTTP 200 都不等于名单已准确或覆盖完整；业务结论由本包的 coverage、审核与资格证据决定。

## 验证、暂停与恢复

页面验证由浏览器任务检测，检测后停止派发动作并执行 `await wait({ reason: "verification" })`；验证在别的 tab 时传对应 `page`。不要额外做定时截图循环。普通冷却控制遵循本包的 controlFile/notBefore，不能借启动新任务解除。

当前 Task Master 等待机制会保留浏览器与 Worker，等待期间 follow 可返回 `attention`、截图路径和 probeId。Agent 读取实际截图；只有能明确确认验证已恢复，才调用 `taskmaster resume TASK_ID --probe PROBE_ID --json`。看不清或未恢复就继续等待，不能自动解题或因时间到了认定验证完成。

超出 Manager 的验证等待窗口后，follow 返回 `manualResumeRequired`；当前说明为 20 分钟。此时最后一张截图只供诊断，不能再按 probe 自动恢复。用户点 Dashboard Resume 或明确要求恢复后，使用：

```text
taskmaster resume TASK_ID --json
```

用户要求暂停时先保存业务 checkpoint 和待执行队列，停止继续派发并保留控制状态；当前执行任务若需结束可用 `taskmaster stop TASK_ID --json`，保留已落盘产物。不要使用 delete 代替暂停，不删除 Profile。恢复前核对当前任务状态、冷却时间及用户最新指示，按真实 checkpoint 接续；已经停止的任务不能凭空当成仍在 wait 中。

同一个 Profile 只有一个浏览器写入者，由 Manager 管理占用和生命周期。Agent 可以并行进行离线聚类与评审，不另建控制器争抢 Profile。执行过程中不在日志、progress 或报告中保存认证信息；本包只读采集不会自动外联。
