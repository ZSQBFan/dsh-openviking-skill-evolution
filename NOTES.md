# Project notes

## 2026-11-20 · M0 接入核验通过

- 工作区为本地 `main`，初始无提交。宿主 manifest 为 `@deepseek-ai/dsh 0.2.2-rc.3`，Desktop 的 ASAR 通过同版 Electron 44.7.0 的 `ELECTRON_RUN_AS_NODE=1` 读取和启动。
- 固定上游 [hermes-loop v0.3.2](https://github.com/weibaohui/hermes-loop/tree/6ce02f45dc489a9fad4ab71f55d488b01ac294ed)。对照 README、`src/index.js`、`client/bundle.js` 与 `test/loop.test.mjs`。固定基线包含手动复盘、10 轮或 10 次工具调用、30 分钟冷却、三种写入模式与独立 Curator。此轮根据行为重写，未复用上游源码。
- 安装版 `dsh-commands/lib/index.js` 的 `ctx.commands.register({ name, description, input, handler })` 接受 `handler({ agent, rawInput, signal })`。`ctx.commands.execute(agent, line, [], signal)` 返回 `{ commandId, result }` 并写入 `command/run`、`command/done` 两个 log-only 事件。`ctx.sessionProjections.register(definition)` 返回可等待的注册句柄，`stateOf(session)` 折叠已提交事件并可在重放时重建。`session/event` 是提交后观察入口。新实现用投影，避开已弃用的 `snapshotEvents()`、`ownEvents()` 与 `eventAt()`。
- 安装版 `dsh-tools/lib/pipeline.js:188–212` 持久化 `tool/call.data.{callId,name,arguments}`，`tool/result.data.message` 包含 `source.callId`、`isError` 和内容。`dsh-mcp-client/lib/index.js:565–605` 将 MCP 文本结果投影到工具消息，`isError` 会成为失败。`dsh-agent/lib/index.js:582` 公开 `ctx.agents.create()`，`ctx.llm.stream()` 是模型辅助请求入口，需让模型输入可从日志重建。两条模型执行路线已核源码，本轮未调用模型。
- 本机 OV Memory 插件 manifest 为 `0.5.31`，`mcp.mjs` 复用 DSH MCP bridge，`mcp-env.mjs` 使用现有 OV 连接。已实测部署实例 MCP `health`、私有技能 canonical URI 全量单读、私有 URI 缺失返回 `NOT_FOUND`，以及共享目录列表为空。全量单读是无 URI 标头的 Markdown，批量读有标头且可能逐 URI 报错。会话启动目录注入、原生本地引导技能 provider 和远端正文读取是不同路径。既有会话目录刷新的行为仍待测。部署服务端版本、写权限、附件、索引、PUT/audit 与原子条件更新均未实测。公开接口参考 [OpenViking Skills API](https://docs.openviking.ai/en/api/04-skills)。
- `python3 test/host-smoke.py` 通过。脚本以临时 `DSH_HOME`、清洁环境和回环随机端口启动同版 `web`，由 overlay 加载探针。探针在真实 Cordis 挂载分支中加载插件，验证 `/skill-refine` 注册、执行和提交事件，调用分支 `dispose()`，随后验证命令无注册且不可执行。隔离进程随测试退出。包管理器安装、卸载及 GUI 图标展示尚未验证。

## M1 · 手动影子复盘通过隔离事件夹具

- `/skill-refine` 列出本会话可绑定的读取事件及序号。`/skill-refine <canonical-skill-uri>` 只产出结构化 `create`、`patch` 或 `no_change`。规则审阅独立于主模型，使用显式纠正或显式经验，不推测自由文本中的意图。
- 修订提案要求同一会话成功完成 OV 全量单读，并有随后提交的用户纠正引用该读取结果。提案附完整 URI、读取文本的 SHA-256、调用及结果序号、纠正序号、原因与单行 unified diff。保留 frontmatter，拒绝歧义匹配。显式新建经验只产出私有路径候选，存在性标记 `unverified`。
- `npm test` 通过 8 项，覆盖小幅修订、无学习证据、同名作用域、失败或部分读、会话内旧版本、身份不明的别名、重复触发、新建与 fork 继承边界。`python3 test/host-smoke.py` 另在真实宿主提交合成的读取和用户纠正事件，得到 `patch`，紧接着复触发得到 `no_change/duplicate`。插件仅注册命令与证据投影，影子复盘没有 OV 请求或写入口。OpenViking 的项目笔记同步属于独立的开发记录。
- 已验证的旧版本行为以本会话后来观察到的不同正文为准。部署端在两次读取之间的未观察修改、MCP 从传输到事件的隔离端到端链路、浏览器命令入口、重启后的去重和任意自然语言审阅未验。当前投影保留最近 160 条相关证据，最多绑定 24,000 字符的单读结果。
- 最小复现：先从会话用 `mcp__openviking__read` 按 canonical URI 无 `limit` 地读取技能。运行 `/skill-refine` 获取 `readResultSeq`，提交下列四行的用户消息，再运行 `/skill-refine <canonical-skill-uri>`。

```text
技能纠正 <readResultSeq>
原文：<技能正文中唯一的整行>
改为：<替换后的整行>
原因：<从本会话得到的纠正理由>
```

- 新建证据使用 `技能经验 <canonical-private-skill-uri>`，随后三行依次为 `描述：…`、`步骤：…`、`原因：…`。同会话调用上述带 URI 的命令查看提案。

## M1 · 隔离 Web 只读集成验收通过

- 实测宿主为 Desktop `0.2.2-rc.3` 的 Web profile。临时目录隔离 `DSH_HOME`、`DSH_AGENTS_HOME`、Documents、工作目录和会话持久化。模型使用确定性进程内适配器，OpenViking 一端使用本地 stdio 只读协议夹具。Web 消息经过实际 Agent Loop、DSH MCP 客户端和工具管线，由宿主提交事件。观察器只记录事件与摘要。
- 浏览器从输入框调用 `/skill-refine`，可以发现命令并看到列表和 JSON 结果。私有 `viking://user/fixture/skills/demo/SKILL.md` 的 `tool/call` seq 29 与 `tool/result` seq 30 共享 call ID `fixture-eddc19fb-c71e-47b5-899c-4b4bcfe6d75b`。夹具正文、事件正文和提案基线的 SHA-256 一致，为 `201237f3ce12338cef29078b84190df268c06f91e46b4492ea28f85e8b4de127`。纠正 seq 42 生成单行 diff `Run smoke.` → `Run smoke and check exit status.`，提案 seq 47。
- 同一进程再次执行 seq 49 与重启后从侧栏恢复同一会话的 seq 52，均返回 `no_change/duplicate`，`previousProposalId` 均为 `d9b9d731223b7e4b45297809aa85528c21c1d8dc04ae80ea4eede0019b9f4884`。同名共享技能读取 seq 62 有独立 URI 和摘要，私有纠正没有进入共享提案。缺失结果 seq 77 的 `isError=true`，返回 `latest_read_unusable`。同会话读取不同版本 seq 105 后返回 `stale_read`。`limit: 4` 的部分结果 seq 120 成功传回但未计入可绑定列表，返回 `latest_read_unusable`。
- MCP 请求日志与宿主事件逐项核对，只有 6 次预期 `read` 和启动握手，9 次复盘均未额外调用 MCP。技能写入为 0。`python3 test/verify-integration.py <临时证据目录>`、`npm test`（8/8）、`python3 test/host-smoke.py` 均通过。
- 本轮尚未验证真实 OV 服务端经隔离 DSH 的连接、带附件包及元数据、远端目录注入和刷新、传输层无标记截断。`limit: 4` 证明的是显式分页产生的部分读。无标记且语法完整的短正文缺少独立完整性证据。真实部署的单读和缺失行为见 M0。自然语言独立审阅及跨会话版本变化仍未验。

### 复现实测

1. 设置 `DSH_INSTALL_DIR` 与 `DSH_NODE_EXECUTABLE` 指向本机 DSH 包和匹配的 Electron 可执行文件，运行 `python3 test/integration-host.py`。使用临时证据目录中 `host-1.log` 打印的完整认证 URL 打开 Web。
2. 在一个新会话依次发送 `Fixture read private` 和 `/skill-refine`，获取实际读取序号。按上文四行格式发送纠正，将 `Run smoke.` 改成 `Run smoke and check exit status.`，原因为 `Verify the result.`。连续两次发送 `/skill-refine viking://user/fixture/skills/demo/SKILL.md`。
3. 在启动脚本的终端输入 `restart`，打开新日志的认证 URL，通过侧栏恢复原会话。再次发送私有复盘命令。发送 `Fixture read shared`，然后复盘 `viking://agent/skills/demo/SKILL.md`。发送 `Fixture read missing`，然后复盘 `viking://user/fixture/skills/missing/SKILL.md`。
4. 连续发送两次 `Fixture read private` 后复盘私有 URI。发送 `Fixture read partial` 后再次复盘私有 URI，最后发送 `/skill-refine`。验证日志后在启动终端输入 `quit` 关闭宿主并清理临时目录。

## 首次本地提交复核

独立审阅发现两个 M1 边界问题。若后续批量读取包含同一技能，现有投影会略过整次调用，旧单读仍可能生成提案。单行 diff 在 CRLF 文件中丢失行尾的 CR 字符，末行无换行时也缺少相应标记。将当前版本保存为只读阶段基线。M2 可以先在隔离 OV 做接口探针。将提案接入写回前，需修复这两个问题并加入回归测试。

## 后续验收

1. M2 在隔离 OV 核验私有技能写入口及权限、审批绑定、版本冲突、附件存留、索引回读和恢复。条件更新尚无部署证据，自动覆盖门槛仍保留。
2. M3 走正常 DSH 入口完成隔离技能加载、纠正、复盘、审批、写回、再次加载和回滚。MVP 后按开发任务中的阶段推进上游对齐。
