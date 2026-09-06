# 离线验证

验证命令从本Skill目录执行，使用已存在的Node与Python环境：

```text
node tests/test-collector.mjs
node tests/test-batches.mjs
python tests/test-audit-export.py
python tests/test-evolve.py
python tests/test-portable.py
python scripts/portable.py doctor --skill-root . --require offline
```

collector 测试使用合成流响应和临时文件；batches 测试使用模拟 Task Master，不运行真实浏览器，并检查终态复盘待办；audit/export 测试使用合成帖子并写回 JSON/CSV/XLSX；evolve 测试验证任务本地复盘、候选隔离、解释器传递、验证门槛、版本漂移、备份及回退行为；portable 测试验证 manifest、任务泄漏闸门、确定性 ZIP、恶意成员拒绝和隔离目录事务安装。

维护改动时首先运行受影响的验证；采纳新版时由evolve执行完整固定门槛。不能删除失败用例、把可用字段改成空值或放宽逐字比对来制造通过。新的失败模式应留下最小合成回归，不将真实帖子搬入tests。

验证结果、输出日志、源码指纹和版本回退证据由evolve保留在任务工作目录。发布包保留源码、合成tests、方法、空白模板和manifest，不含这些现场工作文件。

发布前另用 `portable.py package` 生成 ZIP，再用 `portable.py verify` 独立读取一次。针对本次任务已知的 slug、ID、Profile、Task ID 或独特统计值，通过重复的 `--forbid-token` 做任务本地反查；token 只参与本次检查，不进入发布包。

对复杂解析和恢复修改，独立审阅者用最少必要的合成输入，从入口执行到交付，并检查正常、漏行、字段污染、断链等行为。自动脚本通过与独立审核分开记录。

本版技术更新以离线回归和模拟演练验证，没有因此重新启动线上采集。新群组或站点结构变化仍需要当次任务的小批校准。

v1.2.0 在 Windows 主机实际执行 119 个离线用例：collector 21、batch supervisor 23、audit/export 43、evolution 21、portable 11。macOS/Linux 尚未实机运行；不得把跨平台路径代码和临时目录模拟写成对应系统已验证。
