# language: zh-CN
功能: 聊天与会话同步

  场景: Web UI 执行 thinking 和 name 斜杠命令
    当 我打开 Pi Web UI
    而且 我执行斜杠命令 "/thinking max"
    那么 聊天区显示系统消息 "Thinking level: max"
    而且 thinking 等级按钮显示 "max"
    当 我打开设置面板
    那么 设置面板提供 "xhigh" thinking 等级
    而且 设置面板提供 "max" thinking 等级
    当 我关闭设置面板
    而且 我执行斜杠命令 "/name web-ui-e2e"
    那么 页面标题显示 "web-ui-e2e"

  场景: Web UI 执行 skill prompt 和注册的扩展命令
    假如 skill 与扩展命令测试 fixture 已准备
    当 我打开 Pi Web UI
    那么 斜杠命令建议包含 "/skill:e2e-skill"
    而且 斜杠命令建议包含 "/e2e-prompt"
    而且 斜杠命令建议包含 "/e2e-command"
    当 我执行斜杠命令 "/skill:e2e-skill 检查 skill"
    那么 聊天区显示消息 "Skill command expanded successfully."
    当 我执行斜杠命令 "/e2e-prompt"
    那么 聊天区显示消息 "Prompt template expanded successfully."
    当 我执行斜杠命令 "/e2e-command"
    那么 页面标题显示 "extension-command-ran"

  场景: 常用原生命令映射到 Web UI 操作
    假如 skill 与扩展命令测试 fixture 已准备
    当 我打开 Pi Web UI
    那么 斜杠命令建议包含 "/settings"
    而且 斜杠命令建议包含 "/model"
    而且 斜杠命令建议包含 "/session"
    而且 斜杠命令建议包含 "/tree"
    而且 斜杠命令建议包含 "/copy"
    而且 斜杠命令建议包含 "/export"
    当 我执行斜杠命令 "/settings"
    那么 设置面板可见
    当 我关闭设置面板
    而且 我执行斜杠命令 "/model"
    那么 模型选择器可见
    当 我关闭模型选择器
    而且 我执行斜杠命令 "/session"
    那么 聊天区包含系统消息 "Session stats"
    当 我关闭会话详情
    当 我收起左侧边栏
    而且 我执行斜杠命令 "/tree"
    那么 左侧会话侧边栏可见

  场景: Web UI 通过 /new 开始空会话
    假如 skill 与扩展命令测试 fixture 已准备
    当 我打开 Pi Web UI
    而且 我发送消息 "旧会话标记"
    而且 聊天区显示消息 "旧会话回复。"
    当 我执行斜杠命令 "/new"
    那么 聊天区不显示消息 "旧会话标记"
    而且 聊天区显示会话空状态

  场景: /clone 复制当前会话而 /fork 从选定用户消息创建分支
    假如 skill 与扩展命令测试 fixture 已准备
    当 我打开 Pi Web UI
    而且 我发送消息 "旧会话标记"
    而且 聊天区显示消息 "旧会话回复。"
    而且 我记录当前 Pi 会话文件证据，包含消息 "旧会话标记"
    而且 我启用会话分支操作
    而且 我执行斜杠命令 "/clone"
    那么 聊天区显示消息 "旧会话标记"
    而且 聊天区包含系统消息 "Cloned to a new session."
    而且 clone 会话文件具有新 ID 并保留消息 "旧会话标记"
    而且 原会话 JSONL 未被修改
    而且 会话分支操作需要重新启用
    当 我启用会话分支操作
    而且 我执行斜杠命令 "/fork"
    那么 分叉消息选择器显示 "旧会话标记"
    当 我从消息分叉会话 "旧会话标记"
    那么 聊天区不显示消息 "旧会话标记"
    而且 输入框包含 "旧会话标记"
    当 我发送消息 "分叉后继续消息"
    那么 聊天区显示消息 "你好，Pi Web UI 已收到消息。"
    而且 fork 会话文件具有新 ID 并且分叉在所选用户消息之前
    而且 原会话和 clone 会话 JSONL 均未被修改
    而且 会话分支操作需要重新启用
    当 我启用会话分支操作
    那么 会话分支操作仍然可用

  场景: 未启用 Web UI 时拒绝 fork 和 clone
    假如 skill 与扩展命令测试 fixture 已准备
    当 我打开 Pi Web UI
    而且 我发送消息 "拒绝操作标记"
    而且 聊天区显示消息 "你好，Pi Web UI 已收到消息。"
    而且 我执行斜杠命令 "/fork"
    那么 会话分支错误显示 "Run /webui first to enable session fork commands"
    当 我执行斜杠命令 "/clone"
    那么 会话分支错误显示 "Run /webui first to enable session fork commands"
    而且 聊天区显示消息 "拒绝操作标记"

  场景: 启用后取消 fork picker 保持原会话且拒绝 fork 参数
    假如 skill 与扩展命令测试 fixture 已准备
    当 我打开 Pi Web UI
    而且 我发送消息 "取消后仍在原会话"
    而且 聊天区显示消息 "你好，Pi Web UI 已收到消息。"
    而且 我启用会话分支操作
    而且 我执行斜杠命令 "/fork"
    那么 分叉消息选择器显示 "取消后仍在原会话"
    当 我取消分叉消息选择器
    那么 聊天区显示消息 "取消后仍在原会话"
    当 我执行斜杠命令 "/fork 参数"
    那么 会话分支错误显示 "Usage: /fork"
    而且 聊天区显示消息 "取消后仍在原会话"

  场景: 取消草稿覆盖确认时保留 fork picker 和草稿
    假如 skill 与扩展命令测试 fixture 已准备
    当 我打开 Pi Web UI
    而且 我发送消息 "草稿保护源消息"
    而且 聊天区显示消息 "你好，Pi Web UI 已收到消息。"
    而且 我启用会话分支操作
    而且 我执行斜杠命令 "/fork"
    那么 分叉消息选择器显示 "草稿保护源消息"
    当 我在选择器后保留草稿并拒绝覆盖确认 "不要丢失的草稿"
    那么 分叉消息选择器显示 "草稿保护源消息"
    当 我取消分叉消息选择器
    那么 输入框包含 "不要丢失的草稿"
    而且 聊天区显示消息 "草稿保护源消息"

  场景: Pi fork hook 取消后恢复输入并可再次 clone
    假如 skill 与扩展命令测试 fixture 已准备
    当 我打开 Pi Web UI
    而且 我发送消息 "hook 取消后仍保留的原消息"
    而且 聊天区显示消息 "你好，Pi Web UI 已收到消息。"
    而且 我启用会话分支操作
    而且 我执行斜杠命令 "/e2e-cancel-fork"
    而且 我执行斜杠命令 "/clone"
    那么 会话分支错误显示 "Cloning the session was cancelled."
    而且 聊天区显示消息 "hook 取消后仍保留的原消息"
    那么 输入框恢复可提交状态
    当 我执行斜杠命令 "/clone"
    那么 聊天区显示消息 "hook 取消后仍保留的原消息"
    而且 聊天区包含系统消息 "Cloned to a new session."

  场景: 没有用户消息时 fork 没有可选项
    假如 skill 与扩展命令测试 fixture 已准备
    当 我打开 Pi Web UI
    而且 我发送消息 "即将清空的消息"
    而且 聊天区显示消息 "你好，Pi Web UI 已收到消息。"
    而且 我执行斜杠命令 "/new"
    那么 聊天区显示会话空状态
    当 我执行斜杠命令 "/webui"
    而且 我执行斜杠命令 "/fork"
    那么 会话分支错误显示 "There are no user messages to fork from yet."

  场景: 刷新后从 Pi 会话恢复聊天内容
    假如 当前工作区是 git 仓库
    而且 agent 会更新 workspace status 文档
    当 我打开 Pi Web UI
    而且 我让 agent 更新 workspace status 文档
    而且 我刷新 Pi Web UI
    那么 聊天区显示消息 "Update the workspace status docs."
    而且 聊天区显示消息 "Updated the workspace status docs."
    而且 聊天区显示工具调用 "write"

  场景: 发送消息后显示用户消息和助手回复
    假如 当前工作区是 git 仓库
    而且 agent 会返回普通助手回复
    当 我打开 Pi Web UI
    而且 我发送消息 "你好"
    那么 聊天区显示消息 "你好"
    而且 聊天区显示消息 "你好，Pi Web UI 已收到消息。"
    而且 输入框恢复可提交状态

  场景: 助手文本完成后变成普通消息
    假如 当前工作区是 git 仓库
    而且 agent 会返回普通助手回复
    当 我打开 Pi Web UI
    而且 我发送消息 "写一段说明"
    那么 聊天区显示消息 "你好，Pi Web UI 已收到消息。"
    而且 输入框恢复可提交状态

  场景: 工具调用从执行中更新为成功结果
    假如 当前工作区是 git 仓库
    而且 agent 会更新 workspace status 文档
    当 我打开 Pi Web UI
    而且 我让 agent 更新 workspace status 文档
    那么 聊天区显示工具调用 "write"
    而且 聊天区显示消息 "Updated the workspace status docs."

  场景: 工具调用失败后显示错误状态
    假如 当前工作区是 git 仓库
    而且 agent 会执行失败的 write 工具
    当 我打开 Pi Web UI
    而且 我发送消息 "执行失败工具"
    那么 聊天区显示工具调用 "write"
    而且 聊天区显示工具错误状态
