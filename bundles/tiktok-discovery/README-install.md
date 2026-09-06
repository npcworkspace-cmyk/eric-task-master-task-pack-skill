# TikTok 三 Skill 通用包

需要 Node.js 22+、Eric Task Master、Chrome，以及能调用本地工具和 Skill 的 Agent。包内程序只用 Node 内置模块；浏览器和登录状态由当前设备提供。

    node install.mjs --dry-run
    node install.mjs
    node install.mjs --skills-dir "/your/agent/skills"

默认安装到 CODEX_HOME/skills，未设置时为当前用户的 .codex/skills。已有版本先备份；三个 Skill 的文档和执行器一同升级。重新加载方式以宿主 Agent 为准。

详见 [跨设备配置与恢复](skills/tiktok-discovery-retrospective/references/portability.md)、[MD 与执行器的迭代流程](skills/tiktok-discovery-retrospective/references/code-evolution.md)。发行包的 manifest.json 可核验所有文件；QA.json 明确本版实际验证范围。
