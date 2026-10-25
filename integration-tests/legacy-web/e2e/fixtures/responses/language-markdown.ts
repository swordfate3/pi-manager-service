import { fauxAssistantMessage } from "@earendil-works/pi-ai";

export const languageMarkdownBody = `MARKDOWN_RAW_CONTENT_42

\`\`\`js
const RAW_CODE_42 = "Keep this English string";
\`\`\`

| Column | Value |
| --- | --- |
| RAW_TABLE_42 | Keep this English table |

[External raw URL](https://example.com/raw-language-42)
`;

export default [fauxAssistantMessage(languageMarkdownBody)];
