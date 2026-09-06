# Skill + Pack 发行约定

可复用业务技能把判断方法、可执行参考、离线验收和安全迭代放在同一目录。它不是某次任务的归档。

```text
skill-root/
  SKILL.md
  LICENSE
  THIRD_PARTY_NOTICES.md
  skill-release.json
  agents/openai.yaml
  references/
    method-and-pitfalls.md
    data-contract.md
    runtime-adaptation.md
    self-iteration.md
  assets/reddit-comment-tree-pack/
    collect.mjs
    pack.json
    input.example.json
  schemas/
    run-review.schema.json
    iteration-proposal.schema.json
  scripts/
    verify-pack.mjs
    finalize-paused.mjs
    verify-paused.mjs
    review-run.mjs
    verify-review.mjs
    validate-release.mjs
    verify-release.mjs
    package-skill.mjs
    deploy-skill.mjs
    verify-portability.mjs
    release-skill.mjs
  validation.json
```

## 分工

- SKILL 说明何时使用、稳定不变量、证据门槛和最短执行路径。
- LICENSE 和 THIRD_PARTY_NOTICES 说明该 Skill 自身的发行许可、外部运行时与平台引用边界。
- skill-release.json 只声明稳定名称、版本、平台、成熟度、Task Master 能力契约和清洁性布尔值；不含任务设置、凭据、真实数据、日期或文件哈希。
- references 保存条件性细节；Agent 只读当前阶段需要的文件。
- Pack 是单文件、自包含的参考执行器，任务设置只经 input 传入。
- scripts 提供确定性测试、离线复盘、发行清洁、ZIP 和目录部署。
- validation 记录发行包自身验证，不保存真实任务证据。

## 发行清洁

发行目录不得含真实帖子/评论 ID、Task ID、Profile 名、账号、Cookie、Token、任务日期、历史运行计数、本机绝对路径、原始响应、评论正文或 outputDir。合成 fixtures 明确使用虚构值。

`skill-release.json` 的 Task Master 依赖只写能力契约。目标设备在部署时解析当地可用接口，不写死 Task Master 版本、launcher 路径、宿主 shell 或 Profile。

Pack 和 Skill 共享 bundle 版本。状态 schema 与 method revision 单独决定恢复兼容；不能用 bundle 版本替代状态验证。执行器行为、输入输出或适配要求改变时同步更新方法文档、数据契约、测试和版本。

## 跨设备打包与部署

`package-skill.mjs` 默认先执行完整发行门禁，再使用 Node 内置模块生成 ZIP。条目只有相对 POSIX 路径且统一以 Skill 根目录开头；不依赖 PowerShell、bash 或系统 zip。ZIP 内不得出现 `..`、绝对路径或 symlink。门禁失败时不得创建 ZIP。

在目标设备解压后，可直接放到当地 Agent 的 skills 根目录，或执行：

```text
node scripts/deploy-skill.mjs <解压后的Skill目录> <目标skills根目录> [备份根目录]
```

部署器验证源目录、在目标 skills 根目录内建立临时 staging，并把同名旧版本永久备份到 skills 根目录之外；可以显式传入备份根目录，省略时使用与 skills 根目录并列的默认备份目录。部署和安装后都核对字节清单；安装失败时从根目录内的短期 rollback slot 恢复，成功后清除该 slot。skills 根目录最终不得残留备份 Skill。skills 与备份根目录由目标 Agent 的配置决定，不假设固定 home、盘符或产品目录。

完整发布优先运行纯 Node 编排器：

```text
node scripts/release-skill.mjs <Skill目录> <新ZIP> [SHA256旁车文件]
```

它顺序运行 core、暂停整理、复盘、发行清洁和可移植性套件，根据实际 TAP 结果重建无任务绑定的 `validation.json`，再执行 exact gate、生成 ZIP 与 SHA-256 旁车。ZIP 和旁车必须位于 Skill 源目录之外；失败时恢复发布前的 validation 并删除本次新建的归档。

## 发布门槛

1. 对将要打包的确切 collect 运行全部行为测试。
2. 暂停、复盘、清洁与打包脚本各自通过测试。
3. validation 中区分 Windows、Linux、macOS 及 Node 版本的实测、CI 或未测试状态；各 suite 的 tests/pass/fail 必须与测试脚本声明及本次实际执行相符。
4. 独立 Agent 检查真实行为、恢复边界和任务污染。
5. validation 的 `filesExcludingValidation` 与发行目录做双向逐文件核对，检查 bytes、SHA-256 与 collectorSha；多一个、少一个或任一字节变化都拒绝。
6. 生成 ZIP、SHA-256 和文件 inventory；重新读取 ZIP 核对全部条目。
7. 安装前在 skills 根目录之外保留旧版本；安装后再核对目录 inventory 和根目录清洁性。

每次运行都生成复盘不表示每次都发布新版本。只有通用证据通过 [自复盘与自迭代](self-iteration.md) 的 promotion gate 才更新发行包。
