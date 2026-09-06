# Eric Task Master Task Pack Skills

独立安装、独立调用、可恢复、只读优先的社媒专项 Codex Skills。每个平台保留自己的导航、分页、去重、断点、覆盖判断、审核和导出方法；浏览器与 Chrome Profile 生命周期统一交给 [Eric Task Master](https://github.com/npcworkspace-cmyk/eric-task-master)。

Independent, auditable Codex Skills for social-platform research and collection. Each Skill is a separate installable package. Eric Task Master remains the external browser runtime.

## 为什么是多个 Skill

Facebook 群组分页和 Reddit 评论树不是同一种数据结构，也没有同一套恢复语义。本仓库共享发布工具和 Task Master 能力契约，但不把平台判断塞进一个总控 Skill，也不要求安装一个平台才能使用另一个平台。

## 当前目录

| Skill | 平台 | 能力 | 状态 |
| --- | --- | --- | --- |
| `facebook-group-posts` | Facebook | 群组贴文只读采集、游标恢复、字段核验、导出、自迭代 | stable |
| `reddit-comment-fetch` | Reddit | 评论树、`morechildren`、深层补取、覆盖缺口、自迭代 | portable-offline-validated |
| `tiktok-discovery` 三 Skill 包 | TikTok | 参考深剖、种子发现、逐轮裂变、集中审核、MD/执行器复盘与回滚 | portable-offline-validated |

TikTok 位于 `bundles/tiktok-discovery`，包含独立调用的 `tiktok-seed-discovery`、`tiktok-seed-expansion` 和 `tiktok-discovery-retrospective`。这三个阶段共享一份运行库，作为一个完整发行包安装，不依赖 Facebook、Reddit 或本仓库工具。

`stable` 表示已有完整执行器和发布验证；`portable-offline-validated` 表示通用核心、打包和跨目录安装已经通过离线验证，真实平台适配仍需在有权使用的本地 Profile 中核验。

其他平台在各自完成清理、独立安装和发布验证后再进入目录；未列出的本地开发 Skill 不会被本仓库首发打包。

## 安装

先安装 Eric Task Master。它不包含在本仓库或任何 Skill ZIP 中。

克隆仓库后安装一个 Skill：

```bash
python tools/skillkit.py install --skill facebook-group-posts
```

安装到指定 Skills 目录：

```bash
python tools/skillkit.py install --skill reddit-comment-fetch --skills-dir /path/to/skills
```

也可以从 GitHub Release 下载某个独立 ZIP，验证后安装：

```bash
python tools/skillkit.py verify --archive path/to/skill.zip
python tools/skillkit.py install --archive path/to/skill.zip
```

目录发现顺序是显式 `--skills-dir`、`SOCIAL_SKILLS_DIR`、`CODEX_HOME/skills`、`~/.codex/skills`。

TikTok 使用随包的 Node 安装器。下载并解压三 Skill ZIP 后：

```text
node install.mjs --dry-run
node install.mjs
node install.mjs --skills-dir /path/to/agent/skills
```

该安装器默认使用 `CODEX_HOME/skills` 或 `~/.codex/skills`，保留旧版备份并校验整包哈希。Node.js 22+ 是离线程序依赖；Task Master 和 Chrome 由当前机器提供。开始方式见 [TikTok START-HERE](bundles/tiktok-discovery/START-HERE.md)。

## 校验与打包

```bash
python tools/skillkit.py validate --all --strict
python tools/skillkit.py test --all
python -m unittest discover -s tests -p "test_*.py"
python tools/skillkit.py package --all --output dist
python tools/tiktok_bundle.py validate
python tools/tiktok_bundle.py package --output dist
```

打包器生成每个 Skill 的确定性 ZIP、`SHA256SUMS` 和机器可读 `release-index.json`。验证器拒绝绝对设备路径、明显凭据、真实任务配置、非规范归档成员、路径穿越、符号链接、文件名冲突和清单漂移。

TikTok 工具复用同一泄漏扫描和归档路径检查，并将完整包加入同一索引/校验清单。其 ZIP 使用原生 `manifest.json` 与 `node install.mjs`，不交给单 Skill 安装器拆分。CI 在三个操作系统上运行离线回归、ZIP 解包安装、安装后重建；不访问 TikTok 或其他社媒账户。部署步骤和验证边界见 [发布流程](docs/release-process.md)。

## 任务配置边界

群组、帖子、账号或搜索链接，日期和数量范围，Chrome Profile，页面或动作预算，检查点和输出目录属于每次任务。它们保存在任务工作目录，不进入 Skill、提交、CI fixture 或 release ZIP。

所有发布内容使用合成 fixture。页面可见不代表允许商业复用；跳过和未启动不等于零；Task Master Worker 结束也不等于业务覆盖完整。

## Task Master 与 Skill 的职责

| Eric Task Master | 专项 Skill |
| --- | --- |
| Chrome 与 Profile 生命周期 | 平台页面和响应语义 |
| 一个 Profile 一个写入者 | 分页、去重和业务断点 |
| task ID、状态、等待、停止和恢复 | 字段、证据、覆盖和缺失原因 |
| output directory 与进度通道 | 审核、导出和业务完成判断 |

Task 模块使用 [`taskmaster-task-module-v1`](docs/task-master-contract.md)。验证页面、限流或访问拒绝进入等待或保守停止，不实现绕过。

## 任务后自迭代

任务终态写入 task-local `evolution-review-status.json`。复盘只从带证据的运行记录提取通用改进，候选可以同时修改执行器与 Markdown，但不能复制客户、目标账号、查询词、Profile 或现场统计。候选必须通过旧版和新版回归、测试差异审核、泄漏扫描和独立 ZIP 安装后才能进入正式版本。详见 [自迭代协议](docs/evolution.md)。

## 兼容性与证据

公共 CI 在 Windows、macOS 和 Linux 上运行离线测试，不登录任何社媒账号。真实 Chrome 或真实平台验证只在维护者有权使用的本地 Profile 中有界执行，并在发布记录中与静态、离线证据分开标注。未实测的平台或版本写 `not_tested`，不会写成已兼容。

## License

[MIT](LICENSE). 平台名称和商标归各自权利人所有，详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
