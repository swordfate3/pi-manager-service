# language: zh-CN
功能: 真实长会话回归

  场景: 长线性 Pi 会话加载、刷新与同步保持有界
    假如 真实长会话 fixture 已准备
    当 我打开 Pi Web UI
    而且 我连接真实 state_sync observer
    那么 长会话主聊天区和侧边栏完整可用
    而且 state_sync 包含有界历史和部分树提示
    当 我刷新长会话 Web UI
    那么 长会话主聊天区和侧边栏完整可用
    而且 state_sync 包含有界历史和部分树提示
