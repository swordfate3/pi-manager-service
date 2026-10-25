# language: zh-CN
功能: 不依赖 WSL 的本地与反向代理连接

  场景大纲: 真实 Pi 在不同入口和屏幕下接收消息
    当 我在 "<入口>" 和 "<屏幕>" 打开独立 Pi 网页
    那么 入口内的静态资源和 WebSocket 均成功连接
    当 我通过入口发送真实 Pi 测试消息
    那么 入口显示真实 Pi 回复并保存截图
    而且 导出文件通过当前入口下载成功

    例子:
      | 入口             | 屏幕    |
      | /                | desktop |
      | /s/test-session/ | desktop |
      | /s/test-session/ | mobile  |
