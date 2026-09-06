# 跨设备部署和当前机器配置

发行内容为三个同层 Skill 目录。共享运行库只放在 tiktok-seed-discovery/scripts/runtime，其他两个通过相对路径复用。安装、复盘和升级程序使用 Node 内置模块，不需要 Python 或 npm 依赖。任务的 Profile、参考资料、账号、时间窗口、数量目标、国家组合、登录和环境配置不随发行包转移。

## 当前设备需要什么

- Node.js 22 或更高版本。
- Eric Task Master 及其可用 Chrome；浏览器操作统一交给 Task Master。
- 支持本地 Skill 文档、文件/命令工具并可调用 Task Master 的 Agent。
- 当前任务已经选定、可正常访问页面的 Profile。登录、验证、限流和权限由实际环境决定，安装 Skill 不等于页面一定可用。

Windows、macOS、Linux 使用相同 Node 程序。默认宿主安装路径由 CODEX_HOME/skills 或当前用户主目录 .codex/skills 解析；其他 Agent 用其支持的目录作为 install.mjs 的 --skills-dir。安装后按宿主规则重新加载。不要将别人的整个 .codex 或浏览器用户数据目录当作 Skill 包复制。

首次运行从种子 Skill 目录执行：

```text
node scripts/doctor.mjs
node scripts/doctor.mjs --config <this-machine-environment.json>
```

可选配置唯一关键字段 `taskmasterPath` 指向当前机器的真实启动器；Windows 一般为 taskmaster.cmd，其他系统使用实际可执行文件。配置在包外，路径带空格时按当前 shell 正确引用。解析顺序：显式配置 → TASKMASTER_CLI → PATH → 系统安装候选。显式路径失效应报告修正步骤，不偷偷选另一套安装。

doctor 只读取本地文件与 Node 信息，不启动 Manager/浏览器、不联网、不安装依赖，也不证明 Chrome、Profile 或平台搜索已验证。缺依赖时 Agent 根据 missing/agentNextSteps 说明具体缺口。Task Master 安装与调用见 [最小运行手册](../../tiktok-seed-discovery/references/taskmaster-operations.md)；已有正式 eric-task-master Skill 时同时采用其当前说明。

## 配置与数据分三处

| 位置 | 内容 | 是否进入 ZIP |
|---|---|---|
| 三个 Skill | 通用 MD、解析/采集/处理模块、策略与升级工具、合成测试、版本信息 | 是 |
| 当前机器环境 | Task Master 路径、Skill 宿主路径、可选通用策略状态目录 | 否 |
| 本轮任务目录 | Brief、输入预算、Profile 选择、原始观察、审核、控制文件、断点、复盘、任务专属改进证据 | 否 |

配置中的相对路径均相对该配置文件目录，程序化调用可传 configBaseDir；不依赖 shell 当前目录。读取 taskOutputs 的 taskId→outputDir 映射时，必须使用 Task Master 实际返回值或明确导出工件位置；不猜内部任务存储目录。兼容显式提供 taskRoot 的离线导出布局。

换机器恢复任务时，另行迁移需要的任务数据，重新设置本机输出映射、控制文件和 Profile 路径，并保留原始暂停与 notBefore 时点。旧证据中的历史绝对路径只代表当时来源；程序会拒绝明显不属于当前操作系统的绝对配置路径。不能通过重建配置取消旧暂停。

## 跨任务策略与版本

有限入口权重默认从当前用户主目录 .tiktok-discovery/policies/current.json 读取。TIKTOK_DISCOVERY_STATE_DIR 若设置必须是绝对路径，策略改从该目录下 policies/current.json 读取。显式 policyFile 优先，损坏或缺失时报错；没有默认文件时采用中性权重。每轮启动固定已用路径、版本和字节 SHA256，后续轮才读取新版。

通用策略状态与安装目录分开，不随安装器覆盖，也不默认随 ZIP 分发。需要迁移某个经过验证的策略时单独检查其适用范围。执行器/MD 的升级版本由第三 Skill 的 release.json 和安装记录管理，具体流程见 [自迭代与恢复](code-evolution.md)。

## 验证范围

本包针对三个操作系统编写，实际验证情况以发行 QA.json 为准。Windows 实机离线测试、含空格/中文路径和三系统路径矩阵，不等于 macOS/Linux 实机浏览器采集。Agent 分开报告“已安装”“本地依赖已检测”“页面执行已验证”“业务名单完成”，不把其中一个替代其他步骤。
