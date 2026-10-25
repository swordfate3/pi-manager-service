Feature: 工作区附件上传

  Scenario Outline: 通用文件和图片上传到当前会话后再发送路径
    Given 附件上传测试通过 "<route>" 在 "<viewport>" 打开
    When 我选择中文说明、原始图片和大于消息限制的二进制附件
    Then 选择附件不会立即写入工作区
    When 我发送附件并让 Pi 读取上传说明
    Then 附件按原始字节保存在当前会话目录且 Pi 收到文件路径
    And 上传过程中可见进度且聊天帧不含附件原始数据

    Examples:
      | route  | viewport |
      | direct | desktop  |
      | hub    | desktop  |
      | hub    | mobile   |

  Scenario: 上传目录不可用时保留附件并允许修复后重试
    Given 附件上传测试通过 "direct" 在 "desktop" 打开
    When 我选择中文说明、原始图片和大于消息限制的二进制附件
    And 附件保存目录被符号链接阻断
    And 我尝试发送附件
    Then 上传失败不会发送消息且附件和草稿保留
    When 恢复正常目录后重试上传
    Then 附件按原始字节保存在当前会话目录且 Pi 收到文件路径

  Scenario: 取消最后一个文件后重试复用已完成附件
    Given 附件上传测试通过 "hub" 在 "desktop" 打开
    When 我选择中文说明、原始图片和大于消息限制的二进制附件
    And 两个附件保存后取消最后一个上传
    Then 取消上传不会发送 Pi 消息且草稿保留
    When 我重试已取消的附件提交
    Then 附件按原始字节保存在当前会话目录且 Pi 收到文件路径
    And 重试只重新上传被取消的文件

  Scenario: 其他网页切换会话时取消上传且不重发旧附件
    Given 附件上传测试通过 "direct" 在 "desktop" 打开
    When 我选择中文说明、原始图片和大于消息限制的二进制附件
    And 上传期间其他网页创建新会话
    Then 新会话不保留旧附件也不自动发送且已完成文件仍保留

  Scenario: 刷新后重选同一文件仅续传未确认分片
    Given 附件上传测试通过 "direct" 在 "desktop" 打开
    When 我选择可恢复的大文件附件
    And 上传至少两个分片确认后刷新浏览器
    When 我重选同一个文件并发送
    Then 刷新后只上传服务端尚未确认的分片且 Pi 收到路径

  Scenario: 超限附件和取消上传保留安全状态
    Given 附件上传测试通过 "hub" 在 "mobile" 打开
    When 我选择超过单文件限制的附件
    Then 网页拒绝超限文件且不会上传
    When 我选择中文说明、原始图片和大于消息限制的二进制附件
    And 我取消进行中的附件上传
    Then 取消上传不会发送 Pi 消息且草稿保留
