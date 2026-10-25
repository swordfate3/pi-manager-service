# language: zh-CN
功能: 左侧边栏

  场景: 左侧边栏默认隐藏并通过顶栏完整展开和收起
    假如 当前工作区是 git 仓库
    而且 agent 会返回普通助手回复
    当 我打开 Pi Web UI
    那么 左侧边栏不显示会话搜索框
    而且 聊天输入框仍然完整可见

    当 我展开左侧边栏
    那么 左侧边栏显示会话搜索框
    当 我收起左侧边栏
    那么 左侧边栏不显示会话搜索框
    而且 聊天输入框仍然完整可见

  场景: 移动端 sidebar、tree 和 workspace popup 使用 offcanvas
    假如 当前工作区是 git 仓库
    当 我打开 Pi Web UI 并设置移动视口
    那么 左侧边栏不显示会话搜索框
    当 我展开左侧边栏
    那么 左侧边栏显示会话搜索框
    当 我收起左侧边栏
    那么 左侧边栏不显示会话搜索框
    当 我执行斜杠命令 "/tree"
    那么 左侧会话侧边栏可见
    当 我收起左侧边栏
    而且 我打开 workspace 状态 popup
    那么 workspace 状态 popup 显示 git 状态
    当 我关闭 workspace 状态 popup
    那么 workspace 状态 popup 隐藏
