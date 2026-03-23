/**
 * Telegram HTML post-processor.
 * Converts standard markdown to Telegram's HTML parse mode format.
 */

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert standard markdown text to Telegram HTML format.
 *
 * Processing order:
 * 1. Extract fenced code blocks (``` ... ```) → <pre>, protect from further processing
 * 2. Extract inline code (`...`) → <code>, protect from further processing
 * 3. HTML-escape remaining text: & → &amp;  < → &lt;  > → &gt;
 * 4. Convert --- → blank line
 * 5. Convert ## headings → <b>Heading</b>
 * 6. Convert **bold** → <b>bold</b>
 * 7. Convert - item / * item → • item
 * 8. Convert *bold* → <b>bold</b>
 * 9. Convert _italic_ → <i>italic</i>
 * 10. Reinsert code blocks
 */
export function formatForTelegram(text: string): string {
  const placeholders: string[] = [];

  // Step 1: Extract fenced code blocks (``` ... ```) → <pre>
  let out = text.replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_, content) => {
    placeholders.push(`<pre>${htmlEscape(content)}</pre>`);
    return `\x00P${placeholders.length - 1}\x00`;
  });

  // Step 2: Extract inline code (`...`) → <code>
  out = out.replace(/`([^`\n]+)`/g, (_, content) => {
    placeholders.push(`<code>${htmlEscape(content)}</code>`);
    return `\x00P${placeholders.length - 1}\x00`;
  });

  // Step 3: HTML-escape remaining text
  out = htmlEscape(out);

  // Step 4: Convert --- → blank line
  out = out.replace(/^-{3,}$/gm, "");

  // Step 5: Convert ## headings → <b>Heading</b>
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Step 6: Convert **bold** → <b>bold</b>
  out = out.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");

  // Step 7: Convert - item / * item → • item
  out = out.replace(/^[ \t]*[-*]\s+(.+)$/gm, "• $1");

  // Step 8: Convert *bold* → <b>bold</b> (single asterisk, after bullets handled)
  out = out.replace(/\*([^*\n]+)\*/g, "<b>$1</b>");

  // Step 9: Convert _italic_ → <i>italic</i>
  // Use word-boundary guards to avoid mangling snake_case identifiers
  out = out.replace(/(?<![a-zA-Z0-9])_([^_\n]+?)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // Step 10: Reinsert code blocks
  out = out.replace(/\x00P(\d+)\x00/g, (_, i) => placeholders[parseInt(i, 10)]);

  return out;
}

function findPreRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const open = "<pre>";
  const close = "</pre>";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(open, i);
    if (start === -1) break;
    const end = text.indexOf(close, start);
    if (end === -1) break;
    ranges.push([start, end + close.length]);
    i = end + close.length;
  }
  return ranges;
}

function isInsidePre(pos: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => pos > start && pos < end);
}

/**
 * Split a long message at natural boundaries (paragraph > line > word).
 * Never splits mid-word or inside <pre> blocks. Chunks are at most maxLen characters.
 */
export function splitLongMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const preRanges = findPreRanges(remaining);

    // Prefer paragraph boundary (\n\n)
    const lastPara = slice.lastIndexOf("\n\n");
    // Then line boundary (\n)
    const lastLine = slice.lastIndexOf("\n");
    // Then word boundary (space)
    const lastSpace = slice.lastIndexOf(" ");

    let splitAt: number;
    if (lastPara > 0 && !isInsidePre(lastPara, preRanges)) {
      splitAt = lastPara + 2;
    } else if (lastLine > 0 && !isInsidePre(lastLine, preRanges)) {
      splitAt = lastLine + 1;
    } else if (lastSpace > 0 && !isInsidePre(lastSpace, preRanges)) {
      splitAt = lastSpace + 1;
    } else {
      // If all candidate split points are inside a <pre> block, split after it
      const coveringPre = preRanges.find(([start, end]) => start < maxLen && end > maxLen);
      if (coveringPre) {
        splitAt = coveringPre[1];
      } else {
        splitAt = maxLen;
      }
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
