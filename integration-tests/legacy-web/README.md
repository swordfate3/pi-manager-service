# Legacy Web/Hub integration fixtures

本目录保存从提交 `27326a8cbea8331cac29e6b6b41f98f2b69fa05b` 提取时存在的 Web/Hub、Pi 适配器/Hub 混合测试。`tests/` 保存原 Node 混合测试；`e2e/` 是原 `e2e/` 树的逐字历史归档，包括浏览器、视觉、受管 Gate/runtime 和 TUI guard 覆盖。文件保持原测试内容和原相对导入，逐文件 SHA-256 记录在 `docs/migration-inventory.json`。

这些测试不属于 Manager 默认离线单元测试，也没有在本任务中运行或标记为通过。它们仍依赖 Web 扩展、前端客户端、Playwright、真实 Pi 测试夹具或显式 Docker opt-in；归档不向 Manager 增加这些生产依赖，Manager 包本身也不会导入兄弟工作区源码。

## 后续安装式执行要求

1. 从固定提交导出一个临时 Web 源码副本，不使用或修改现有 Web 工作树。
2. 在 Manager 中先通过 `npm pack --dry-run --ignore-scripts --json`，再生成本地 tarball；临时 Web 夹具只安装该 tarball，不通过相对路径读取 Manager 源码。
3. 将 `tests/` 与 `e2e/` 归档分别放回临时 Web 副本的原位置，并由跨项目适配层把原 Hub 导入映射到已安装 Manager 包。适配层必须保留原断言，不得复制 Manager 源码到 Web 包或降低安全检查。
4. 使用临时配置、状态、端口和 Unix socket；不得使用生产凭据、生产 Gate 数据、真实会话或 Docker 卷。
5. 单独记录每个测试文件的结果。缺少跨项目适配层、Pi 夹具、浏览器或 socket 权限时应报告为未运行/阻塞，不能归入通过数。

阶段 2 只负责保存这些夹具。Web v1 清理和后续跨项目协议验收负责建立安装式适配层并重新执行。
