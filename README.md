# DSH OpenViking Skill Evolution

独立 DSH 扩展项目，用于为 OpenViking 托管的 Skills 提供接近 Hermes 的复盘、修订、使用统计和可恢复生命周期治理。

## 当前决策

- 以 OpenViking 作为技能正文、附件和跨 Harness 共享的唯一内容源。
- 参考 `weibaohui/hermes-loop` 的复盘触发、独立审阅、审批和 Curator 分层逻辑。
- 先实现影子复盘和可审计 diff，再逐步开放自动写回。
- 首版不引入第二套长期记忆，沿用现有 OpenViking memory/Experience。

## 首个验证闭环

用过的 OpenViking skill → 收集用户纠正或执行结果 → 生成修订 diff → 审批写回 → 下一次读取新版 → 可恢复。

## 相关资料

- Hermes Curator: https://hermes-agent.nousresearch.com/docs/user-guide/features/curator
- Hermes Skills: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- hermes-loop: https://github.com/weibaohui/hermes-loop
- OpenViking Skills API: https://docs.openviking.ai/en/api/04-skills
