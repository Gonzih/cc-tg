/**
 * Telegram MarkdownV2 post-processor.
 * Converts standard markdown to Telegram's MarkdownV2 format.
 */

/**
 * Convert standard markdown text to Telegram MarkdownV2 format.
 *
 * Processing order:
 * 1. Extract code blocks (fenced + inline) — protect from further processing
 * 2. Strip raw HTML tags
 * 3. Convert --- → blank line
 * 4. Convert ## headings → *bold*
 * 5. Convert **bold** → *bold*
 * 6. Convert - list items → • item
 * 7. Escape MarkdownV2 special chars (outside code blocks)
 * 8. Reinsert code blocks unchanged
 */
export function formatForTelegram(text: string): string {
  // Step 1: Extract code blocks and inline code to protect them
  const placeholders: string[] = [];

  // Fenced code blocks first (``` ... ```)
  let out = text.replace(/```[\s\S]*?```/g, (match) => {
    placeholders.push(match);
    return `\x00P${placeholders.length - 1}\x00`;
  });

  // Inline code (`...`)
  out = out.replace(/`[^`\n]+`/g, (match) => {
    placeholders.push(match);
    return `\x00P${placeholders.length - 1}\x00`;
  });

  // Step 2: Strip raw HTML tags
  out = out.replace(/<[^>]+>/g, "");

  // Step 3: Convert --- → blank line
  out = out.replace(/^-{3,}$/gm, "");

  // Step 4: Convert ## headings → *bold*
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Step 5: Convert **bold** → *bold*
  out = out.replace(/\*\*(.+?)\*\*/gs, "*$1*");

  // Step 6: Convert - list items → • item (leading - or * bullet)
  out = out.replace(/^[ \t]*[-*]\s+(.+)$/gm, "• $1");

  // Step 7: Escape MarkdownV2 special chars outside code blocks.
  // Per Telegram spec, these must be escaped: _ [ ] ( ) ~ > # + - = | { } . ! \
  // * is intentionally NOT escaped — it is used for bold formatting above.
  out = out.replace(/([_\[\]()~>#+\-=|{}.!\\])/g, "\\$1");

  // Step 8: Reinsert code blocks unchanged (no escaping inside them)
  out = out.replace(/\x00P(\d+)\x00/g, (_, i) => placeholders[parseInt(i, 10)]);

  return out;
}

/**
 * Split a long message at natural boundaries (paragraph > line > word).
 * Never splits mid-word. Chunks are at most maxLen characters.
 */
export function splitLongMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);

    // Prefer paragraph boundary (\n\n)
    const lastPara = slice.lastIndexOf("\n\n");
    // Then line boundary (\n)
    const lastLine = slice.lastIndexOf("\n");
    // Then word boundary (space)
    const lastSpace = slice.lastIndexOf(" ");

    let splitAt: number;
    if (lastPara > 0) {
      splitAt = lastPara + 2;
    } else if (lastLine > 0) {
      splitAt = lastLine + 1;
    } else if (lastSpace > 0) {
      splitAt = lastSpace + 1;
    } else {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
