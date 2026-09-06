# Pack 运行手册与契约

## 安装与目录

将整个 `facebook-group-posts` 文件夹作为一个版本单元部署，不要只复制 SKILL.md。Skills 目录和运行时均在当前设备解析，不将设备绝对路径保存到 Skill。用 `scripts/portable.py doctor/install` 诊断和事务安装；路径优先级、ZIP 验证与不同系统命令见 [跨设备部署](portable-deployment.md)。技能显示名为“FB群组帖子采集”，调用名为 `$facebook-group-posts`；新任务可自动匹配，也可显式调用。

浏览器执行依赖已安装的 `eric-task-master` 技能与Eric Task Master程序。Skill ZIP不包含Manager、Chrome、Node运行时、Python环境或登录Profile。找不到程序时读取Task Master技能的部署说明；不要悄悄使用临时旧版本、复制其他Profile凭据或引入第二个浏览器控制器。

| 文件 | 用途 |
|---|---|
| `scripts/prepare.mjs` | 从链接、固定范围和工作目录生成配置；不打开浏览器 |
| `scripts/batches.mjs` | 调用Task Master CLI逐批运行、状态检查、停止与断点交接 |
| `scripts/collect.mjs` | 自包含的Task Master模块；原生分页、字段提取和journal |
| `scripts/audit_export.py` | 离线检查、默认形态分类、JSON/CSV及可选XLSX导出 |
| `scripts/evolve.py` | 任务本地复盘、隔离候选、真实离线验证、版本采纳与回退 |
| `scripts/portable.py` | 跨设备 doctor、发布验证、确定性 ZIP 与事务安装 |
| `tests/` | 合成数据测试，不含真实群成员数据，不发起线上采集 |
| `assets/review-template.json` | 独立审核空白记录 |

运行环境：Node.js 18+、Python 3.10+；XLSX需openpyxl，缺少时先交付CSV/JSON并明确XLSX未生成。使用已存在的运行时；部署依赖前核实用户环境。采集器本身仅依赖Node内置模块和Task Master提供的page。

## 创建配置

```text
node scripts/prepare.mjs --help
node scripts/prepare.mjs --url GROUP_URL --start START_ISO_WITH_OFFSET --end END_ISO_WITH_OFFSET --workspace ABSOLUTE_WORK_DIRECTORY --max-pages TASK_BATCH_PAGE_BUDGET
```

参数必须从当前任务得出；示例不是默认范围。输出路径有空格应按当前 shell 引用。`--max-pages` 必填，明确限定这一批允许的分页请求数；Skill 不继承历史任务的页数。可显式指定 `--launcher` 与用户已选择的 `--profile`。launcher 也可通过 `ERIC_TASK_MASTER_CLI` 或 `PATH` 发现；未指定 Profile 即使用 Manager 默认 Profile，不写死历史 ID。起止时间必须含 Z 或数值时区偏移。

prepare返回实际config路径，并写入任务目录中的 `executor/collect.mjs`。配置的 `modulePath` 指向该副本，`moduleSha256`固定内容指纹；重复使用同一目录不会覆盖已有配置或副本。监督器每次启动批次前验证指纹。旧版无哈希配置仍可读取，但未固定执行器的旧任务运行中不要更新其引用的安装代码。

首次校准应由当次任务显式给出较小的 `--max-pages` 和 `--max-batches 1`，仅采一批后停下，验完后用已保存 checkpoint 在新的工作目录准备后续任务。`--max-batches` 未提供时不限制批次数，但仍按日期边界与错误规则停止。`--boundary-pages` 最少 5；`--pace-ms` 默认 500，不得为追求速度改成无等待高并发。`maxPages` 没有业务默认值，也不能用页大小乘成固定帖子保证。

## 启动、跟进、停止

```text
node scripts/batches.mjs run --config ABSOLUTE_CONFIG_JSON
node scripts/batches.mjs stop --config ABSOLUTE_CONFIG_JSON
```

控制器可能持续数小时；本地后台运行时隐藏窗口并保存其正常状态输出，保留进程标识。不要启动第二个相同工作目录的supervisor。启动后立即读取返回任务ID和Dashboard并告诉用户，使用Task Master follow/status或控制器状态报告有意义的变化。终端输出不能代替持久化结果。

stop既停止后续调度，也请求停止当前Task Master任务，并保留数据/断点。必须查看请求结果与任务终态；CLI失败时不能声称浏览器已经停止。用户明确取消后，不自动恢复，也不删除数据。Manager停止或身份变化时控制器停下，不擅自重新启动Manager继续。

Manager状态、Task Master任务状态、模块返回reason、checkpoint状态四者要一起检查。只有page_limit和确实前进的完整链允许自动下一批。日期边界、回跳待审核、feed_end、等待用户、错误都需要先评估数据。

## 采集器直接输入

批次控制器负责生成实际输入，通常不需要手写。核心字段如下：

| 参数 | 约束 |
|---|---|
| groupUrl | 必需，Facebook群组URL，可用slug或数字ID；不接受无关站点 |
| startTime / endTime | 必需，有时区的固定ISO时刻；start不晚于end |
| outputDir | 必需，任务工作输出的绝对目录 |
| groupId | 可选；新任务可从目标群页面原生请求发现，续跑保持匹配 |
| resumeCheckpointPath | 可选；显式续跑时必需且必须有效；不隐式回到第一页 |
| maxPages | 必需；由当前任务显式给出的单个 Task Master 批次分页请求上限 |
| boundaryPages | 默认5，连续完整旧页门槛；不等于无需审核的全量保证 |

兼容别名和附加调试参数以当前模块校验为准。不要混用含义不同的历史输入文件；新Pack使用自己的schema版本。

通过Task Master直接运行时：

```text
taskmaster run ABSOLUTE_COLLECT_MJS --input @ABSOLUTE_INPUT_JSON --detach --json
taskmaster panel --json
taskmaster follow TASK_ID --json
```

Windows按实际已安装launcher绝对路径执行。模块不能假定相邻文件被复制，因此collect.mjs必须保持自包含。

## 断点恢复

批次目录包含 `posts.json`、`crawl-audit.json`、`pagination-checkpoint.json`、`pagination-state.json` 及 `pagination-history-*.jsonl` 等工作文件。checkpoint引用历史日志绝对路径；迁移整个任务目录后须显式核对/更新引用，不能只拷一个checkpoint就丢下日志。

发生异常先保存并读取监督器、Task Master和分页状态。优先检查本批目录中的有效checkpoint及监督器 `latest_checkpoint`；`next_checkpoint` 表示上次已通过自动交接核验的断点，可能比本批新保存的断点旧。审查确认可恢复后，在新工作目录用prepare的 `--resume-checkpoint ABSOLUTE_CHECKPOINT_JSON` 创建配置，起止与群组必须同原scope。先前数据由checkpoint source与journal恢复。首次初始化会正常加载目标页面，但正式分页必须用原断点cursor。

未知launch结果属于需要人工核对的状态：先查看Manager是否已经创建原任务，不能重发run。已有停止/失败配置不会自动无限重启。终端null不会清空last-usable游标；反过来，有游标也不证明上一批无误或整月完整。

极窄的落盘中断窗口可能出现“成功页已写入journal，但选中的checkpoint还未推进”。此时Pack会在浏览器启动前拒绝重放，要求核对最新checkpoint与journal，并生成经验证的一致恢复点；不能把这个拒绝改为静默从旧页或第一页开始。聚合posts快照落后而checkpoint已推进的普通情况则可直接由已提交journal恢复。

长批次运行期间不要更改默认Profile。控制器记录首个任务确认的实际profileId；后续任务Profile变化会立即停止并要求审核，避免混合不同账号可见的数据。

## 离线校验和导出

```text
python scripts/audit_export.py --help
python scripts/audit_export.py --source ABSOLUTE_FINAL_BATCH_DIRECTORY --output ABSOLUTE_NEW_DELIVERY_DIRECTORY --xlsx
```

使用独立的新交付目录，避免混入上次导出的旧文件。`--xlsx` 在openpyxl可用时生成工作簿；不需要Excel文件可省略或用 `--no-xlsx`。需要验证之前的数据未丢失时使用 `--baseline ABSOLUTE_PRIOR_POSTS_JSON`。审计应能访问checkpoint引用的所有journal。缺失日志时仍可检查当前数据字段并交付可用部分，但覆盖结论不能自动放行。

导出完成后读取自动审计，并按workflow执行独立审核。交付目录只放明确列出的结果与审核说明；不要将整个batch工作目录压缩给外部使用者。

## 离线回归

```text
node tests/test-collector.mjs
node tests/test-batches.mjs
python tests/test-audit-export.py
python tests/test-evolve.py
```

测试使用临时合成数据和模拟CLI/页面，不依赖当前登录。失败先处理相关风险；不要扩大测试到整月线上重采来验证一个文档或配置变化。修改Facebook字段适配器后，离线测试仍不能替代新任务中的小批线上校准。

## 任务后演进

无论本次目标是否完成，监督器终态都会生成任务本地 `evolution-review-status.json: pending`；取消后不得因此重启浏览器。Agent 必须用 `evolve.py review` 记录 no_change 或候选判断，状态才闭环为 completed。技术更新通过隔离副本和验证机制采纳，可同时更新执行器与 Markdown，保留原版及结果收据。详细命令和可验证边界见 [演进机制](evolution.md)。只修复技术层，不自动扩展用户目标或修改 Task Master 运行环境。
