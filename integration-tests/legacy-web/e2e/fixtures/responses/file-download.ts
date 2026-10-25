import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

export const resumePath = "documents/求职/计算机硕士秋招简历-优化版.pdf";
export const resumeBytes = "%PDF-1.7\nPi Web download fixture 中文\n%%EOF\n";

export default [
  fauxAssistantMessage([fauxToolCall("write", { path: resumePath, content: resumeBytes })], { stopReason: "toolUse" }),
  fauxAssistantMessage(
    [
      `已生成 **${resumePath}**。`,
      `也可以点击 [下载简历](./${resumePath})，或使用行内路径 \`${resumePath}\`。`,
      "缺失文件：**documents/missing.pdf**。",
      "受限文件：[敏感文件](./.env)。",
      "外部网站：[外部报告](https://example.org/report.pdf)。",
    ].join("\n\n"),
  ),
];
