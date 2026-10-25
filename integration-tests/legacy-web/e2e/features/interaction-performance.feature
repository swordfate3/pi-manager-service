# language: zh-CN
功能: 交互性能回归

  场景: 长会话 sidebar toggle 指标与挂载行数
    假如 性能测试长会话 fixture 已准备
    当 我打开 Pi Web UI
    那么 侧栏展开与收起性能已记录

  @optimized
  场景: 优化版长会话 sidebar 只挂载视窗附近的行
    假如 性能测试长会话 fixture 已准备
    当 我打开 Pi Web UI
    那么 优化后侧栏可见行数有界
    而且 虚拟侧栏滚轮移出后保留键盘焦点

  场景: 大型真实 Pi 工具展开收起指标
    假如 大型工具输出性能 fixture 已准备
    当 我打开 Pi Web UI
    而且 我让 agent 执行大型真实工具输出
    那么 大型工具展开与收起指标已记录

  场景: 大型真实 Pi 工具保留有界预览且原文件不变
    假如 大型工具输出性能 fixture 已准备
    当 我打开 Pi Web UI
    而且 我让 agent 执行大型真实工具输出
    那么 大型工具历史预览有界且原文件保持完整
