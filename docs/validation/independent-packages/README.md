# 独立拆包证据索引

日期：2026-10-26。总体结论与能力边界见[拆分验证记录](../2026-10-26-independent-packages.md)。本目录归档本轮产生的报告和任务说明，不随运行包分发。

阅读顺序：

1. [执行账本与边界决定](progress.md)：任务、提交范围、所有 `Ruling:` 与保留限制。
2. [Manager 提取报告](task-1-report.md)及其[初审](task-1-review.md)、[第一次修复复审](task-1-fix-1-review.md)、[第二次修复复审](task-1-fix-2-review.md)。
3. [Web v1 拆分报告](task-2-report.md)及[任务审查](task-2-review.md)。
4. [全分支审查](final-review.md)：记录当时待修复事项，不能单独当作最终状态。
5. [最终修复报告](final-fix-report.md)及[最终复审](final-re-review.md)：原发现均已解决。

任务说明和报告保留当时的路径、命令、时间与状态，因此部分文字提到 `.superpowers/sdd/` 临时目录。原始 Markdown 在归档时逐字节核对；整目录清理被安全策略拒绝后，原目录与差异包一并保留，不采用替代删除方式。生成的差异包不重复存入永久文档，也可按账本中固定提交范围重建。

这些记录包含失败→修复的历史，不能只摘取一次历史失败当作当前结论，也不能把局部通过扩展成未执行的完整浏览器、Gate socket、原生/Docker、MCP 或生产验收。基线压力超时、opt-in 跳过与初始测试隔离事件均保留。
