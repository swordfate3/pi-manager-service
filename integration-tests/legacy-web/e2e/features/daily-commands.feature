# language: zh-CN
功能: 日常会话命令

  场景: 恢复、统计、导出与重载真实 Pi 会话
    假如 日常命令 faux response fixture 已准备
    当 我打开 Pi Web UI
    而且 我连接只读 state_sync observer
    而且 我发送消息 "DAILY_SESSION_ONE_MARKER"
    而且 聊天区显示消息 "Daily response one."
    而且 我设置当前会话名 "daily-session-one-unique"
    而且 我记录第一会话身份与历史 "DAILY_SESSION_ONE_MARKER"
    而且 我执行斜杠命令 "/new"
    而且 我发送消息 "DAILY_SESSION_TWO_MARKER"
    而且 聊天区显示消息 "Daily response two."
    而且 我设置当前会话名 "daily-session-two"
    而且 我记录第二会话身份与历史 "DAILY_SESSION_TWO_MARKER"
    而且 我启用会话分支操作
    而且 我执行斜杠命令 "/resume"
    那么 恢复会话选择器列出第一会话并标记当前会话
    当 我取消恢复会话选择器
    那么 第二会话仍保持当前
    当 我再次打开恢复会话选择器并拒绝草稿替换 "第二会话未发送的草稿"
    那么 恢复会话选择器仍打开且草稿保留
    当 我取消恢复会话选择器
    而且 我执行斜杠命令 "/resume 参数"
    那么 日常命令错误显示 "Usage: /resume"
    而且 当前会话仍为第二会话
    当 我再次打开恢复会话选择器并恢复第一会话
    那么 恢复使用原第一会话 ID 与历史
    而且 高级会话操作需要重新启用
    当 我执行斜杠命令 "/webui"
    而且 我执行斜杠命令 "/name"
    那么 当前名称查询显示实际会话名称
    当 我执行斜杠命令 "/session"
    那么 会话统计显示 session ID、累计 tokens 与 context usage
    而且 会话统计保留 Messages 和 Tool calls
    当 我关闭会话详情
    而且 我记录当前会话文件并确认 HTML 导出
    那么 下载的 HTML 包含当前会话唯一标记且原会话文件未改变
    当 我执行斜杠命令 "/export 参数"
    那么 日常命令错误显示 "Usage: /export"
    当 我再次启用会话分支操作
    而且 我记录当前运行时身份
    而且 我执行斜杠命令 "/reload"
    那么 收到新 runtime 的 state_sync 且 session ID 与历史不变
    而且 高级会话操作需要重新启用
    当 我发送消息 "DAILY_AFTER_RELOAD_MARKER"
    那么 聊天区显示消息 "Daily response after reload."
    当 我执行斜杠命令 "/reload 参数"
    那么 日常命令错误显示 "Usage: /reload"
    当 我在未启用高级操作时选择第二会话恢复
    那么 日常命令错误显示 "Run /webui first to enable session resume commands"
    当 我执行斜杠命令 "/reload"
    那么 日常命令错误显示 "Run /webui first to enable runtime reload"
