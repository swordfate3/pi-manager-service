export const mathFormattingPrompt =
  String.raw`MATH_USER_MARKER Inline \(A_1 + \alpha\). Display:
\[\frac{1}{2} + \sum_{i=1}^{40} x_i\]
Price: $5 USD. Code: ` +
  "`" +
  String.raw`\(ignored\)` +
  "`" +
  ".";

export const mathFormattingReply = String.raw`MATH_ASSISTANT_MARKER Inline \(E = mc^2\).

\[
\frac{1}{2} + \sum_{i=1}^{40} x_i = \frac{n(n+1)}{2}
\]

Existing dollar math $$x^2$$ and a price of $5 USD.`;

export const mathFormattingThinking =
  String.raw`MATH_THINKING_MARKER Inline \(a_1 + \alpha\).

\[
\frac{1}{2} + \sum_{i=1}^{40} x_i = \frac{n(n+1)}{2}
\]

Existing $$y^2$$. Price: $5 USD. Code: ` +
  "`" +
  String.raw`\(ignored\)` +
  "`";
