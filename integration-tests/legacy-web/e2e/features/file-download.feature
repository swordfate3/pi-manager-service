Feature: Download linked project files
  Scenario Outline: Confirm a Chinese PDF download from an assistant's bold file path
    Given 文件下载测试通过 "<route>" 在 "<screen>" 打开
    When Pi 生成带中文路径的 PDF 回复
    Then 点击加粗路径后可以取消且不会下载
    And 确认下载后保留中文文件名和原始文件内容
    And Markdown 链接和行内代码路径也可以下载
    And 文件不存在时显示错误而不会离开聊天

    Examples:
      | route | screen  |
      | direct | desktop |
      | direct | mobile  |
      | hub    | desktop |
      | hub    | mobile  |
