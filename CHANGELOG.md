# Changelog

## 0.2.6

- Fix rollback verification when persisted metadata has the same values in a different key order.
- Let newly created skills converge to applied or rolled-back after exact package readback, while clearly reporting unconfirmed search indexing.
- Improve dashboard session selection, manual refresh feedback, keyboard activation and retry states.
- Verified the final candidate with 13 P0 user-acceptance cases on DSH 0.2.2-rc.5 and OpenViking 0.5.5.

## 0.2.5

- Keep automatic-review response diagnostics in a bounded, seven-day local log.
- Exclude reasoning chunks from reviewer JSON while retaining stream metadata.
- Record stable validation and upstream error codes for troubleshooting.

## 0.2.4 · 简化设置

- 把更新方式和 OpenViking 连接提示放在面板顶部，复盘阈值与模型选项默认收起，复盘间隔改用分钟显示。
- 默认自动更新，沿用 OpenViking 记忆插件的连接。连接配置不可用时显示只保存草稿，升级保留用户已保存的选择。

## 0.2.3 · 前台学习与技能附件

- DSH Agent 可以在任务中用 `skill_manage` 查看现有技能版本并提交学习结果。前台与后台复盘使用相同的治理模式和账本。
- 正文和 UTF-8 附件变更可以放在同一提案中预览、写回和回滚。替换或删除附件须匹配该文件的版本摘要。

## 0.2.2 · 默认自治理与存量技能

- 新安装默认自动复盘，复用原生 OpenViking Memory 的连接，有可用写入端时自动应用合格的私有技能提案。
- 安装前已有的私有技能在会话中完整读取后可参与复盘和本地巡检，保留附件、YAML 元数据和回滚快照。
- 没有可用写入端时按影子模式执行，保留本地提案。升级保留显式保存过的模式。

## 0.2.1 · 多段修订

- 审阅模型可以提交多段统一差异。写回按原文、行号和上下文校验每段变更，并保留技能的 YAML 元数据。

## 0.2.0 · 技能自治理

- 增加会话驱动的自动复盘、零工具模型提炼、冷却与去重，保留 `/skill-review` 即时入口和 `/skill-refine` 精确修订。
- 增加 DSH Web 技能演进面板，支持模式与模型配置、提案预览、审批、拒绝、回滚和运行记录。
- 受管私有技能支持新建、补丁与撤回。写回适用于通过验收的隔离 OpenViking 单写者实例。
- 增加本 profile 的读取统计、闲置巡检、归档和恢复，以及 OpenViking 记忆与 Experience 状态。

## 0.1.0 · 发布候选

- 新增 `/skill-refine`，按完整 URI 列出本会话观察到的 OpenViking 技能、作用域、读取状态和版本摘要。
- 纠正消息可直接指定技能 URI。插件以纠正前最近一次读取为准，该次读取必须完整且成功。提案展示单行 diff、证据位置和提案 ID，旧的事件编号格式仍可用。
- 默认配置仅生成草稿。重复提案、后续读取到不同版本、读取失败或证据不足时返回相应状态。
- 保留隔离单写者的实验性审批与整包回滚入口。自动复盘、共享写入和多写者写入留待后续验证。
