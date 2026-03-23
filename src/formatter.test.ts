import { describe, it, expect } from "vitest";
import { formatForTelegram, splitLongMessage } from "./formatter.js";

describe("formatForTelegram", () => {
  describe("headings → bold", () => {
    it("converts ## heading to *bold*", () => {
      expect(formatForTelegram("## Hello World")).toBe("*Hello World*");
    });

    it("converts # h1 to *bold*", () => {
      expect(formatForTelegram("# Title")).toBe("*Title*");
    });

    it("converts ### h3 to *bold*", () => {
      expect(formatForTelegram("### Section")).toBe("*Section*");
    });

    it("converts h6 to *bold*", () => {
      expect(formatForTelegram("###### Deep")).toBe("*Deep*");
    });

    it("only converts headings at start of line", () => {
      const input = "text ## not a heading";
      // ## not at line start — should not be converted, # gets escaped
      const result = formatForTelegram(input);
      expect(result).not.toContain("*not a heading*");
    });
  });

  describe("bold conversion", () => {
    it("converts **bold** to *bold*", () => {
      expect(formatForTelegram("**bold text**")).toBe("*bold text*");
    });

    it("converts multiple bold spans", () => {
      const result = formatForTelegram("**foo** and **bar**");
      expect(result).toBe("*foo* and *bar*");
    });

    it("converts bold spanning multiple words", () => {
      expect(formatForTelegram("**hello world**")).toBe("*hello world*");
    });
  });

  describe("bullet conversion", () => {
    it("converts - item to • item", () => {
      expect(formatForTelegram("- first item")).toBe("• first item");
    });

    it("converts multiple list items", () => {
      const input = "- alpha\n- beta\n- gamma";
      const result = formatForTelegram(input);
      expect(result).toBe("• alpha\n• beta\n• gamma");
    });

    it("converts * bullet to • item", () => {
      expect(formatForTelegram("* star bullet")).toBe("• star bullet");
    });

    it("handles indented list items", () => {
      expect(formatForTelegram("  - indented")).toBe("• indented");
    });
  });

  describe("special char escaping", () => {
    it("escapes periods", () => {
      expect(formatForTelegram("Hello.")).toBe("Hello\\.");
    });

    it("escapes exclamation marks", () => {
      expect(formatForTelegram("Hello!")).toBe("Hello\\!");
    });

    it("escapes parentheses", () => {
      expect(formatForTelegram("(test)")).toBe("\\(test\\)");
    });

    it("escapes hyphens in text", () => {
      expect(formatForTelegram("well-known")).toBe("well\\-known");
    });

    it("escapes equals signs", () => {
      expect(formatForTelegram("a = b")).toBe("a \\= b");
    });

    it("escapes plus signs", () => {
      expect(formatForTelegram("a + b")).toBe("a \\+ b");
    });

    it("escapes curly braces", () => {
      expect(formatForTelegram("{key}")).toBe("\\{key\\}");
    });

    it("escapes greater-than", () => {
      expect(formatForTelegram("> quote")).toBe("\\> quote");
    });

    it("escapes hash outside headings", () => {
      expect(formatForTelegram("color #fff")).toBe("color \\#fff");
    });

    it("escapes pipe", () => {
      expect(formatForTelegram("a | b")).toBe("a \\| b");
    });

    it("escapes tilde", () => {
      expect(formatForTelegram("~approx")).toBe("\\~approx");
    });

    it("escapes square brackets", () => {
      expect(formatForTelegram("[link]")).toBe("\\[link\\]");
    });

    it("escapes underscore", () => {
      expect(formatForTelegram("my_var")).toBe("my\\_var");
    });

    it("escapes backslash", () => {
      expect(formatForTelegram("C:\\path")).toBe("C:\\\\path");
    });
  });

  describe("code block preservation", () => {
    it("does not escape chars inside fenced code blocks", () => {
      const input = "```\nhello.world (test) + more!\n```";
      const result = formatForTelegram(input);
      expect(result).toBe("```\nhello.world (test) + more!\n```");
    });

    it("does not escape chars inside inline code", () => {
      const input = "`my_var.method()`";
      const result = formatForTelegram(input);
      expect(result).toBe("`my_var.method()`");
    });

    it("escapes outside code but not inside", () => {
      const input = "before (code) `my_var.x` after (end)";
      const result = formatForTelegram(input);
      expect(result).toBe("before \\(code\\) `my_var.x` after \\(end\\)");
    });

    it("preserves code block with language tag", () => {
      const input = "```typescript\nconst x: Foo = bar();\n```";
      const result = formatForTelegram(input);
      expect(result).toBe("```typescript\nconst x: Foo = bar();\n```");
    });

    it("does not convert - bullets inside code blocks", () => {
      const input = "```\n- not a bullet\n```";
      expect(formatForTelegram(input)).toBe("```\n- not a bullet\n```");
    });
  });

  describe("html stripping", () => {
    it("strips HTML tags", () => {
      expect(formatForTelegram("<b>bold</b>")).toBe("bold");
    });

    it("strips multiple tags", () => {
      expect(formatForTelegram("<p>Hello <em>world</em></p>")).toBe("Hello world");
    });
  });

  describe("--- conversion", () => {
    it("converts --- to blank line", () => {
      const input = "above\n---\nbelow";
      const result = formatForTelegram(input);
      expect(result).toBe("above\n\nbelow");
    });
  });

  describe("combined", () => {
    it("handles heading with special chars", () => {
      const result = formatForTelegram("## My Heading - With Dash");
      expect(result).toBe("*My Heading \\- With Dash*");
    });

    it("handles bold with special chars", () => {
      const result = formatForTelegram("**hello.world**");
      expect(result).toBe("*hello\\.world*");
    });
  });
});

describe("splitLongMessage", () => {
  it("returns single chunk for short messages", () => {
    const result = splitLongMessage("short message");
    expect(result).toEqual(["short message"]);
  });

  it("returns single chunk at exactly maxLen", () => {
    const text = "a".repeat(4096);
    expect(splitLongMessage(text)).toHaveLength(1);
  });

  it("splits long messages", () => {
    const text = "a".repeat(4097);
    const chunks = splitLongMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("splits at paragraph boundary", () => {
    const para1 = "a".repeat(3000);
    const para2 = "b".repeat(3000);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitLongMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it("splits at line boundary when no paragraph break fits", () => {
    const line1 = "a".repeat(3000);
    const line2 = "b".repeat(3000);
    const text = `${line1}\n${line2}`;
    const chunks = splitLongMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("splits at word boundary when no newline fits", () => {
    const word1 = "a".repeat(3000);
    const word2 = "b".repeat(3000);
    const text = `${word1} ${word2}`;
    const chunks = splitLongMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(word1);
    expect(chunks[1]).toBe(word2);
  });

  it("never produces empty chunks for normal input", () => {
    const text = "Hello world.\n\nParagraph two.\n\nParagraph three.";
    const chunks = splitLongMessage(text, 20);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("respects custom maxLen", () => {
    const text = "Hello world";
    const chunks = splitLongMessage(text, 5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
  });

  it("reassembles to original content", () => {
    const text = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
    const chunks = splitLongMessage(text, 30);
    const rejoined = chunks.join("\n\n");
    // All content should be present (whitespace may differ due to trimming)
    expect(rejoined).toContain("First paragraph here");
    expect(rejoined).toContain("Second paragraph here");
    expect(rejoined).toContain("Third paragraph here");
  });
});
