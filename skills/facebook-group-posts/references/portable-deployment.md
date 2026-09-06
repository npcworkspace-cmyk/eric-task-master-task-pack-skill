# 跨设备部署与可携带发布

本 Skill 的发布单元是完整的 `facebook-group-posts` 目录。目标群组、时间窗、Profile、页数预算、断点、帖子数据、任务收据和交付文件都不属于发布单元，必须由每次任务在 Skill 外部提供。

## 运行时发现顺序

- Skills 目录：命令行 `--skills-dir` → `FB_GROUP_POSTS_SKILLS_DIR` → `CODEX_HOME/skills` → 当前用户主目录下的 `.codex/skills`。
- Node：命令行 `--node` → `FB_GROUP_POSTS_NODE` → `PATH` 中的 `node`。
- Task Master CLI：命令行 `--taskmaster` 或采集 prepare 的 `--launcher` → `ERIC_TASK_MASTER_CLI` → `PATH` 中的 `taskmaster` → 当前平台已知的正式安装回退位置（若存在）。
- Python：运行 `portable.py` 或 `evolve.py` 的 Python；嵌套演进测试会通过 `FB_GROUP_POSTS_PYTHON` 和 `FB_GROUP_POSTS_NODE` 继承已经选定的解释器。

不要把设备用户名、盘符、Home 路径、Profile 名称或 Task Master 安装路径写回 Skill。设备路径只存在于本机环境变量、命令参数或当次任务配置。

## 新设备安装

ZIP 解压后，先在解压目录运行只读诊断。Windows 可使用 `python` 或 `py -3`，macOS/Linux 可使用 `python3`；以下用 `PYTHON` 表示当前环境中选定的 Python 3.10+：

```text
PYTHON SKILL_EXTRACT_DIR/scripts/portable.py doctor --skill-root SKILL_EXTRACT_DIR --require offline
PYTHON SKILL_EXTRACT_DIR/scripts/portable.py install --source SKILL_EXTRACT_DIR
PYTHON INSTALLED_SKILL_DIR/scripts/portable.py doctor --skill-root INSTALLED_SKILL_DIR --require collection
```

自定义 Skills 目录时三条命令都显式传 `--skills-dir TARGET_SKILLS_DIR`，或设置上述环境变量。已有旧版时先审核当前任务是否仍引用安装目录；确认可升级后给 install 增加 `--replace`。安装器先在目标 Skills 目录建立完整暂存副本并核对哈希，再原子切换目录；旧版保存成同级版本备份。安装失败时会恢复已移动的旧版。

`doctor` 不打开浏览器。它分别报告：

- `manifest_valid`：发布成员、哈希和任务隔离声明是否一致；
- `offline_ready`：Python、Node 和离线能力是否可用；
- `collection_ready`：离线能力、Eric Task Master CLI 及其 Skill 是否同时可用；
- `openpyxl.found`：是否能生成可选 XLSX；缺失不影响 JSON/CSV。

诊断通过仍不代表某个群组页面结构已经兼容。第一次在新设备、新账号环境或新页面结构运行时，仍应创建新的任务工作区并做有界校准。

## 生成与验证发布 ZIP

只从已经通过演进验证并安装完成的 Skill 根目录打包：

```text
PYTHON INSTALLED_SKILL_DIR/scripts/portable.py package --skill-root INSTALLED_SKILL_DIR --output RELEASE_ZIP
PYTHON INSTALLED_SKILL_DIR/scripts/portable.py verify --archive RELEASE_ZIP
```

若本次任务有已知群组 slug、数字 ID、Profile 名、任务 ID 或独特统计值，打包和验证时可重复传入 `--forbid-token TASK_LOCAL_VALUE`。每个 token 至少四个字符；扫描不区分大小写。它只用于本次发布闸门，不写入 Skill 或 ZIP。

打包器按 manifest 精确列出成员，不递归夹带缓存、任务目录或未知文件。ZIP 使用固定成员顺序和时间戳；生成后重新读取并检查：

- 仅有一个 `facebook-group-posts/` 根前缀；
- 无绝对路径、父目录穿越、重复成员、目录项或符号链接；
- 成员集合、字节数与 SHA-256 同 manifest 完全一致；
- `includes_real_posts`、`includes_credentials`、`includes_task_configuration` 均为 false；
- 文本为 UTF-8，不含设备用户 Home 绝对路径或未标为 synthetic/fixture/example/test 的具体 Facebook 群组 URL；
- 不含调用者提供的任务 token。

同一源码与 manifest 生成的 ZIP 字节应一致。manifest 的版本或构建时间发生变化会合理改变 ZIP 哈希。

## 平台验证边界

执行器使用 Python 标准库、Node 内置模块和路径 API，不通过 shell 拼接用户参数。Windows `.cmd` 入口只接受已经验证的正式 Task Master 包装布局；其他平台或 `.exe`/可执行脚本直接作为参数数组运行。

发布验证必须区分“代码路径可携带”和“实机验证”。在一个平台通过模拟路径、ZIP、临时安装和全部离线测试，只能证明该平台实测与其他平台代码路径已覆盖；macOS/Linux 只有在对应主机运行 doctor、全部 tests、临时安装和回滚后，才可写入实机验证记录。

## 任务结束后的演进闭环

监督器在完成、停止、等待审核或异常退出时，在任务工作区写入 `evolution-review-status.json`，状态为 `pending`。Agent 随后必须运行 `evolve.py review`：

- 没有通用改进时生成 `no_change` 收据；
- 有证据支持改进时建立隔离 candidate，可同时修改 `scripts/*.py|*.mjs` 执行器和 `SKILL.md`/`references/*.md` 说明，补合成测试，再验证、采纳或回滚。

review 会把同一状态文件更新为 `completed` 并绑定收据路径和哈希。候选、证据、日志、状态文件和备份始终留在任务工作区；它们不会进入发布 ZIP。
