# 数据契约与 CLI

以下 JSON 为字段示意，所有示例指标都是合成数据。真实结果保存在任务目录；包内不携带客户任务数据。发行包使用 Node.js 22+，不访问浏览器、不联网、不发送消息。

## 复盘输入

`performance.json`：

```json
{
  "schemaVersion": 1,
  "taskStatus": "paused",
  "stage": "seed",
  "adoptedPolicy": {"version": "default", "sha256": null},
  "coverage": {"planned": 100, "completed": 40, "unknown": 60},
  "routes": [{
    "route": "scenario", "actions": 4, "blockedActions": 1,
    "retrievedRecords": 80, "newUniqueAccounts": 30,
    "reviewedAccounts": 20, "passedAccounts": 10,
    "activeMs": 60000, "waitMs": 30000,
    "failureClasses": ["platform_block"],
    "evidence": [{"path": "observations.jsonl", "pointer": "lines 1-40"}]
  }],
  "observations": [{
    "kind": "risk", "summary": "Synthetic example: several pages were not observed.",
    "evidence": [{"path": "coverage.json", "pointer": "/unknown"}]
  }]
}
```

指标为非负数；计数为整数；未知为 `null` 或省略，不能填 0。`newUniqueAccounts` 指对任务基线与本轮已见集合去重后的新增，不是路线内去重记录数。多入口命中同一账号按首次发现计数，仍保存其他边。`reviewedAccounts` / `passedAccounts` 只统计上述新增账号，采用同一版本资格标准；未复核不计失败。`activeMs` 为该路线执行时间；`waitMs` 包含队列、正常等待、冷却及重试等待。不要在 active 中重复计 wait。共享等待只计一次并记录分摊办法；无法分摊时成本未知。

`failureClasses` 可用 `platform_block`、`auth_required`、`navigation_failure`、`extractor_failure`、`coverage_gap`、`qualification_gap`。保留原始证据的位置，不把鉴权信息、完整签名 URL 或 cookies 放入复盘。

每路线输出新账号/小时、通过账号/小时、已审核样本通过率、资格审核覆盖率。成本缺失时速率为 `null` / `unknown`。只有低通过率但审核覆盖不足时，不能直接判该入口无效。

```text
node <skill>/scripts/retrospect.mjs review --input <job>/performance.json --out <job>/retrospective
```

输出 `report.json`、`report.md` 和 `iteration.json`。自动建议先进入“待实验”；本脚本不把单批高收益自动升级为已验证。Agent 可以在本轮报告中补充已验证能力，须引用验证结果或测试证据。随后必须分别检查 MD、执行器和策略，填写 iteration.json 并运行 close；具体字段、隔离修改、验证、版本安装和整组回滚见 [MD 与执行器的迭代](code-evolution.md)。重复 review 不覆盖已有迭代决定，新的报告哈希与旧决定不符时 close 会要求重新审阅。

## 可跨任务保存的策略

`current.json` 只接受下列字段，不接受品牌、账号、查询、说明文本或未知配置：

```json
{
  "schemaVersion": 1,
  "version": "v1",
  "scope": {"platform": "tiktok", "stages": ["seed", "expansion"]},
  "strategy": {
    "actionDedup": true,
    "routePriority": {"hashtag": 1, "identity_location": 1, "scenario": 1, "brand_product": 1, "profile_recommendation": 1},
    "referenceQueryPriority": {"topic": 1, "scenario": 1, "brand_product": 1, "identity_location": 1, "hashtag": 1}
  }
}
```

权重必须完整、在 0.5–2 内；只改变相同授权范围内的顺序，不增大请求预算。使用端在启动时读取并固定策略，通过候选 `route` 或参考查询 `kind` 取乘数。未识别的动作类型用 1。不存在 `current.json` 时采用全部 1、去重开启的内置默认策略。策略 scope 不覆盖当前阶段时不用该策略。

跨任务默认策略目录：环境变量 `TIKTOK_DISCOVERY_STATE_DIR` 若设置必须是绝对路径，使用 `<state-dir>/policies`；否则使用 Node `os.homedir()` 下的 `.tiktok-discovery/policies`。`resolvePolicyFile(explicit)` 在未传显式路径时自动查找此处的 `current.json`，不存在返回 `null`；显式路径必须为绝对路径，按原样返回，缺失/损坏在加载时直接报错，绝不悄悄回退。只读查找不会创建目录。Agent 不需要记住上一任务的输出路径。

策略目录只保存通用排序配置、不可变版本与哈希凭证，不放具体账号、品牌、查询、登录数据或任务记录。换电脑时可以按需迁移这个目录到同一规则解析的位置；无需复制浏览器 Profile。未迁移时从内置默认开始。

版本只用短字母、数字、点、下划线和连字符，不得把客户名写成版本号。版本不可原地覆盖。第一/二 Skill 将采用的版本与哈希写入任务报告，复盘可关联业务结果。

## 独立实验与门槛

候选策略是白名单 JSON；实验由 Agent 在用户已授权的任务范围内单独建立。冷却中不得为了实验访问平台。相同主题分层、时间段与资格定义的基线/候选组应有可比样本、互不污染的去重基线；选择有代表性的预先固定审核样本，不能只审核看起来最好的账号。

`experiment.json` 必须有：

```json
{
  "schemaVersion": 1,
  "source": "live",
  "completed": true,
  "isolated": true,
  "comparisonMatched": true,
  "scope": {"platform": "tiktok", "stages": ["seed", "expansion"]},
  "baselinePolicyHash": null,
  "candidatePolicyHash": "SHA256 of exact candidate file bytes",
  "checks": {"sameQualificationRules": true, "authorizationUnchanged": true, "noGuardChanges": true, "independentReview": true},
  "baseline": {"actions": 20, "blockedActions": 0, "newUniqueAccounts": 60, "reviewedAccounts": 40, "passedAccounts": 20, "activeMs": 120000, "waitMs": 60000, "coverage": {"planned": 20, "completed": 20}},
  "candidate": {"actions": 20, "blockedActions": 0, "newUniqueAccounts": 65, "reviewedAccounts": 44, "passedAccounts": 24, "activeMs": 110000, "waitMs": 60000, "coverage": {"planned": 20, "completed": 20}},
  "evidence": [{"path": "experiment-observations.jsonl", "sha256": "SHA256 of actual evidence file"}]
}
```

以上数值仍是合成示例，不能提交为生产证据。`baselinePolicyHash=null` 仅适用于尚无已发布策略。检查布尔值由独立评审 Agent 依据证据确认；脚本检查字段与哈希，不能替代业务判断。证据文件相对于实验文件所在目录，必须位于该目录内。

固定推广门槛：两组各至少 20 个动作、30 个已审核新增账号、审核覆盖至少 50%；通过率不下降；按总执行加等待耗时计算的通过账号/小时至少提升 5%；执行覆盖与审核覆盖不下降；受阻比例不增加。门槛为审慎的最低验证条件，不代表统计显著性或通用业务保证。主题改变时优先重新对照，允许继续使用默认策略。

```text
node <skill>/scripts/retrospect.mjs validate --candidate <job>/candidate-policy.json --experiment <job>/experiment.json --out <job>/validation.json
node <skill>/scripts/retrospect.mjs promote --candidate <job>/candidate-policy.json --experiment <job>/experiment.json --validation <job>/validation.json --policy-dir <policy-dir>
node <skill>/scripts/retrospect.mjs rollback --policy-dir <policy-dir> --version v1
```

`--policy-dir` 可省略；`promote` / `rollback` CLI 和 API 都使用上述跨任务默认目录。明确传入的目录仍优先。

`validate` 不写已采用策略；不满足条件返回 `passed:false` 与原因，退出码 2。`promote` 重新检查实验、证据、哈希和当前基线版本，只有 `live` 来源可推广。报告中的自由文本从不复制到策略目录。策略目录保存 `current.json`、`versions/<version>.json` 与只有版本/哈希的发布凭证。文件锁防止两个 Agent 同时发布；运行中的采集不自动重载。`rollback` 原子切回已有版本并保留现有版本，不修改任务数据。

## 代码能力的复用

输入格式修正、缺页检测或解析器改动不是策略权重。Agent 使用 [evolve.mjs 与安装器](code-evolution.md) 保存隔离候选、验证 MD 和执行器并发布可回滚版本。通用补丁不含客户数据；在合成/脱敏样本及适用的授权实测中检查字段、稳定 ID、覆盖和失败分类。策略对照实验不能替代代码能力验证，代码离线测试也不能证明真实入口收益提升。
