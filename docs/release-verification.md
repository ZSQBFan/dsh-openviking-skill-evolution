# 发布验证

CI 在 Node.js 22 和 24 上运行 `npm test` 和 `npm run test:release`。打包检查会解包候选 `.tgz`，逐文件比对源码，核对包名、版本、导出和 SHA-256。随后加载解包后的插件入口，用合成会话事件、确定性 reviewer 和内存技能夹具调用候选 dashboard 的请求处理器。

发布前再运行真实 DSH Web 门禁。将 `DSH_NODE_EXECUTABLE` 指向已安装的 DSH Node 或 Electron 可执行文件，将 `DSH_INSTALL_DIR` 指向同一安装的 DSH 包目录，其中须包含 `lib/bin.js`。

```sh
npm test
npm run test:release:dsh -- /absolute/path/to/existing-output-directory
```

脚本在同一次运行中打包并执行两层门禁。它以临时 HOME 与 DSH profile 启动两个绑定到 `127.0.0.1` 的 Web 宿主。首个宿主通过插件管理器安装并启用候选包，通过已认证的 HTTP dashboard 保存、回读 reviewer 路由和超时设置，再发起三次复盘。确定性 reviewer 三次返回 `approve`。验证顺序如下。

1. 在审批模式生成 `pending` 提案，核对预览、证据和运行记录。通过 dashboard 批准后状态变为 `applied`，环回 OpenViking HTTP 夹具完成一次上传和替换。
2. 切换到 `shadow` 并生成草稿。提案可预览，技能正文保持批准后的版本。
3. 切回审批模式并生成新的 `pending` 提案。提案有审批操作，技能正文仍保持批准后的版本。
4. 第二个宿主回读安装状态，并验证同会话去重、停用、重新启用和卸载。两次启动都核对已安装文件的内容摘要与候选包一致。

门禁在标准输出记录包版本、tarball SHA-256、成员内容摘要、提案 ID、模型证据序号和正文写入前后的哈希。应使用成功后保留的同一份 `.tgz`，并将标准输出留作验收证据。现有同名文件会使保留步骤失败。省略目录可只运行验证，由脚本清理临时包与 profile。

此门禁覆盖真实 DSH 的认证 HTTP 路由和插件生命周期。会话事件、模型输出与 OpenViking 响应均来自隔离夹具。浏览器渲染、真实模型和真实 OpenViking 的验收见 [用户验收测试](user-acceptance-test.md)。
