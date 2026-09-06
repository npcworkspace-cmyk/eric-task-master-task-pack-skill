# Eric Task Master Skills

**把你做熟的工作，变成 AI Agent 能反复、批量完成的能力。**

[English](README.md) | 简体中文

找红人、收集社群讨论、整理调研证据。你给 Agent 一个目标和一份可复用的 Skill，[任务大师](https://github.com/npcworkspace-cmyk/eric-task-master)负责把浏览器任务分批跑起来，边做边保存结果。

这里是任务大师的社区 Skill 库。每个 Skill 都包含三样东西：**Agent 看得懂的操作说明、处理重复工作的脚本，以及判断结果是否完成的检查方法。** 你可以直接使用、改进已有 Skill，也可以发布自己的 Skill。

我们希望让个人的规模化自动化成为可能：一个人也能组织原本需要大量重复点击的工作，再把好用的方法分享出来，让下一个人少走一遍弯路。

[开始使用](#从这里开始) · [Agent 执行指南](docs/agent-quickstart.md) · [贡献新 Skill](CONTRIBUTING.md) · [下载 Skill](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/releases/latest) · [安装任务大师](https://github.com/npcworkspace-cmyk/eric-task-master)

## 现在能做什么？

| 我想做什么 | 给 Agent 什么 | 能拿到什么 | 入口 |
| --- | --- | --- | --- |
| 收集 Facebook 群组贴文 | 群组链接、时间范围、采集预算 | 贴文、来源链接、字段核验、JSON/CSV，可选 XLSX，以及未覆盖说明 | [Facebook 群组采集](skills/facebook-group-posts/SKILL.md) |
| 批量读取已知 Reddit 帖子的评论 | 帖子链接、读取预算 | 评论与回复关系、已保存进度、缺失或无法访问的分支说明 | [Reddit 评论获取](skills/reddit-comment-fetch/SKILL.md) |
| 找 TikTok 红人，并从合适的人继续展开 | 推广国家、粉丝区间、3–5 条标注类型的参考链接、红人类别与风格 | 参考研究、去重账号、筛选证据、下一轮可展开的种子 | [TikTok 红人开发](bundles/tiktok-discovery/START-HERE.md) |
| 发布前检查刚完成的 Skill 或 Pack | 完整源码或组合包、预期行为、已有测试证据 | 有依据的审计、具体修改建议、未测范围，可选源码快照 | [Task Pack Audit](skills/task-pack-audit/SKILL.md) |

TikTok 是一个 ZIP、三个 Skill：**研究参考并找种子 → 从审核后的种子继续展开 → 复盘并改进方法。** 三个一起安装，每个阶段可以单独调用。

以上是目前已发布的流程。产品调研、供应商开发、媒体监测、网站 QA 等方向都欢迎大家贡献；它们还不是本库已经提供的能力。

## 从这里开始

### 1. 把项目链接和需求交给 Agent

把下面这段话复制给能读取本地文件、运行终端命令的 Agent：

```text
请使用 https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill
中的 Skill，帮我完成：[我想拿到的结果]。

先读 README.zh-CN.md 和 docs/agent-quickstart.md，选择并安装适合的已发布
Skill。缺少任务大师或其他依赖时，按官方发行说明协助安装。
执行前读取安装后的 SKILL.md。

我的输入和限制：[链接、范围、预算，以及已选的 Chrome Profile]。
只问缺少的信息。先跑一小批并核验结果，再在已授权范围内继续。
交付结果文件、未完成项和下一步建议，结束前完成本次复盘。
```

开发 TikTok 红人时，每条参考链接请注明是**竞品参考、品牌已合作红人，还是希望合作的风格参考**。同时给出推广国家、粉丝区间和红人类别/内容风格，Agent 会据此研究并生成搜索计划。

### 2. 准备浏览器账号

执行浏览器工作流时，安装[任务大师](https://github.com/npcworkspace-cmyk/eric-task-master/blob/main/README.zh-CN.md)和稳定版 Google Chrome。在任务大师 Dashboard 里选择 **Profile**，也就是一份单独保存的浏览器环境，按需要登录网站。开始自动任务前关闭它的手动浏览器窗口。

任务大师在你的电脑上运行，Agent 需要能访问这台电脑的文件和终端。Codex 有默认 Skill 安装目录；其他 Agent 可以指定自己的目录，或者直接读取已安装的 `SKILL.md`。具体命令见 [Agent 执行指南](docs/agent-quickstart.md)。

Task Pack Audit 直接审核本地文件，不需要任务大师、Chrome 或社媒账号；可选的快照工具需要 Python 3.11+。

### 3. 先看一小批，再放大

Agent 应先给你任务的 Dashboard 链接，并边做边保存有用结果。第一小批用来检查当前网页是否能读、筛选方向是否合适，再扩大预算或进入下一轮。

速度取决于网站、账号状态和审核深度。找到一千个账号，不等于一千个都符合合作条件。交付时要说清楚：收集了多少、审核通过多少、还有什么不知道。

## 给 Agent：安装后怎样真正跑起来

先读 [docs/agent-quickstart.md](docs/agent-quickstart.md)，其中列明：

1. 单个 Skill 与 TikTok 三 Skill 包分别使用哪个安装器。
2. 每个流程需要哪些输入，从哪个文件开始执行。
3. 怎样通过任务大师启动一次、跟踪进度、保留结果。
4. 交付前怎样检查业务任务是否真的完成。

每次任务的链接、凭据、Profile、预算和产物都留在 Skill 外。沿用用户选择的 Profile。遇到登录、验证或访问限制，保存进度，通过任务大师交接给用户处理。

## 把你的 Skill 分享出来，让别人也用得上

你已经让 Agent 稳定完成了一件有用的工作？**欢迎把这个 Skill 提交到这里。** 只解决一个具体问题也很好，不用先做出另一套自动化平台。

- **只有想法也可以：**[提交工作流建议](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/issues/new?template=skill-proposal.md)，说清输入、过程和想得到的结果。
- **已经有脚本：**按[贡献指南](CONTRIBUTING.md)补上操作说明、输入输出示例和检查方法，把它整理成 Skill。
- **发现错误或说明难懂：**[提交 Issue](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/issues/new)。修复、翻译和文档改进同样有价值，示例请先去除真实业务数据。
- **准备好发布：**Fork 仓库，提交 PR 并附上测试证据。审核合并后，由维护者通过[发布流程](docs/release-process.md)打包发布。

你可以让 AI Agent 帮你整理文档、抽出通用代码、补测试、准备 PR；提交者仍需检查实际内容。客户资料、账号信息和本机设置请留在自己的任务里。

参与的人越多，库里能做的事情就越多。你在自己项目里解决的一个问题，可以变成别人也能使用的改进。**用起来，在真实工作中改进，再把有用的部分贡献回来。** 我们希望这样一点点完善 AI 自动化生态。

## 每次做完，都有机会变得更好

已有 Skill 会要求 Agent 复盘本次成功、失败、浪费的步骤和缺失的证据。值得保留的改进可以同时更新说明与脚本，在隔离副本中验证，通过后成为新版本，并保留回退方式。

复盘也可以得出“不需要修改”的结论。一次网站异常、一个特殊账号，不应悄悄改变所有人的工作方式。详见[自迭代流程](docs/evolution.md)。

## 验证到了哪一步？

新建或改版的 Pack 分享前，使用 [Task Pack Audit](skills/task-pack-audit/SKILL.md)，按[八条撰写与迭代原则](skills/task-pack-audit/references/principles.md)核对实际实现，区分已确认问题、合理差异和未验证的说法。源码快照只确认审过哪份文件，不能替 Agent 作出审核通过的判断。

公共 CI 在 **Windows、macOS、Linux** 上做离线测试和打包检查；TikTok 包还验证 ZIP 安装及安装后的重建。CI 不登录社媒账号，通过 CI 不代表所有网站和账号此刻都能访问。

发布的 ZIP 带文件完整性记录，每次 Release 提供 `SHA256SUMS` 与 `release-index.json`。[查看 CI](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill/actions/workflows/ci.yml)或阅读[发布与核验流程](docs/release-process.md)。

## License

[MIT](LICENSE)。平台名称与商标说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

**两个项目配合使用：**

- [Eric Task Master 任务大师——安装本地浏览器任务执行器](https://github.com/npcworkspace-cmyk/eric-task-master)
- [Task Master Skills——寻找、开发和分享可复用的工作流](https://github.com/npcworkspace-cmyk/eric-task-master-task-pack-skill)

任务大师把浏览器工作持续跑起来，Skill 告诉 Agent 怎样把事情做好。
