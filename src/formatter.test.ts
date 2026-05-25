import { describe, it, expect } from "vitest";
import { formatForTelegram, splitLongMessage } from "./formatter.js";

// htmlEscape is not exported but we can verify it through formatForTelegram
// by passing text that contains HTML special chars outside code blocks.

describe("formatForTelegram", () => {
  describe("headings → bold", () => {
    it("converts ## heading to <b>bold</b>", () => {
      expect(formatForTelegram("## Hello World")).toBe("<b>Hello World</b>");
    });

    it("converts # h1 to <b>bold</b>", () => {
      expect(formatForTelegram("# Title")).toBe("<b>Title</b>");
    });

    it("converts ### h3 to <b>bold</b>", () => {
      expect(formatForTelegram("### Section")).toBe("<b>Section</b>");
    });

    it("converts h6 to <b>bold</b>", () => {
      expect(formatForTelegram("###### Deep")).toBe("<b>Deep</b>");
    });

    it("only converts headings at start of line", () => {
      const input = "text ## not a heading";
      const result = formatForTelegram(input);
      expect(result).not.toContain("<b>not a heading</b>");
    });
  });

  describe("bold conversion", () => {
    it("converts **bold** to <b>bold</b>", () => {
      expect(formatForTelegram("**bold text**")).toBe("<b>bold text</b>");
    });

    it("converts multiple bold spans", () => {
      const result = formatForTelegram("**foo** and **bar**");
      expect(result).toBe("<b>foo</b> and <b>bar</b>");
    });

    it("converts bold spanning multiple words", () => {
      expect(formatForTelegram("**hello world**")).toBe("<b>hello world</b>");
    });

    it("converts *single asterisk bold*", () => {
      expect(formatForTelegram("*bold text*")).toBe("<b>bold text</b>");
    });
  });

  describe("italic conversion", () => {
    it("converts _italic_ to <i>italic</i>", () => {
      expect(formatForTelegram("_italic_")).toBe("<i>italic</i>");
    });

    it("converts _italic_ surrounded by spaces", () => {
      expect(formatForTelegram("some _italic_ text")).toBe("some <i>italic</i> text");
    });

    it("does not convert underscores in snake_case identifiers", () => {
      expect(formatForTelegram("my_var_name")).toBe("my_var_name");
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

  describe("HTML escaping (no MarkdownV2 backslash escaping)", () => {
    it("does not escape periods", () => {
      expect(formatForTelegram("Hello.")).toBe("Hello.");
    });

    it("does not escape exclamation marks", () => {
      expect(formatForTelegram("Hello!")).toBe("Hello!");
    });

    it("does not escape parentheses", () => {
      expect(formatForTelegram("(test)")).toBe("(test)");
    });

    it("does not escape hyphens in text", () => {
      expect(formatForTelegram("well-known")).toBe("well-known");
    });

    it("does not escape equals signs", () => {
      expect(formatForTelegram("a = b")).toBe("a = b");
    });

    it("does not escape plus signs", () => {
      expect(formatForTelegram("a + b")).toBe("a + b");
    });

    it("does not escape curly braces", () => {
      expect(formatForTelegram("{key}")).toBe("{key}");
    });

    it("does not escape hash outside headings", () => {
      expect(formatForTelegram("color #fff")).toBe("color #fff");
    });

    it("does not escape pipe", () => {
      expect(formatForTelegram("a | b")).toBe("a | b");
    });

    it("does not escape tilde", () => {
      expect(formatForTelegram("~approx")).toBe("~approx");
    });

    it("does not escape square brackets", () => {
      expect(formatForTelegram("[link]")).toBe("[link]");
    });

    it("does not escape underscore in plain text", () => {
      expect(formatForTelegram("my_var")).toBe("my_var");
    });

    it("does not escape backslash", () => {
      expect(formatForTelegram("C:\\path")).toBe("C:\\path");
    });

    it("escapes ampersand", () => {
      expect(formatForTelegram("a & b")).toBe("a &amp; b");
    });

    it("escapes less-than", () => {
      expect(formatForTelegram("a < b")).toBe("a &lt; b");
    });

    it("escapes greater-than", () => {
      expect(formatForTelegram("> quote")).toBe("&gt; quote");
    });

    it("real-world billing example has no backslashes", () => {
      const input = "fly.io $9.39 (Visa ending 1728) cc-tg@0.3.7";
      expect(formatForTelegram(input)).toBe("fly.io $9.39 (Visa ending 1728) cc-tg@0.3.7");
    });
  });

  describe("code block preservation", () => {
    it("wraps fenced code blocks in <pre>", () => {
      const input = "```\nhello.world (test) + more!\n```";
      const result = formatForTelegram(input);
      expect(result).toBe("<pre>hello.world (test) + more!\n</pre>");
    });

    it("wraps inline code in <code>", () => {
      const input = "`my_var.method()`";
      const result = formatForTelegram(input);
      expect(result).toBe("<code>my_var.method()</code>");
    });

    it("escapes HTML inside code but does not convert markdown", () => {
      const input = "before (code) `my_var.x` after (end)";
      const result = formatForTelegram(input);
      expect(result).toBe("before (code) <code>my_var.x</code> after (end)");
    });

    it("wraps code block with language tag in <pre>", () => {
      const input = "```typescript\nconst x: Foo = bar();\n```";
      const result = formatForTelegram(input);
      expect(result).toBe("<pre>const x: Foo = bar();\n</pre>");
    });

    it("does not convert - bullets inside code blocks", () => {
      const input = "```\n- not a bullet\n```";
      expect(formatForTelegram(input)).toBe("<pre>- not a bullet\n</pre>");
    });

    it("escapes HTML special chars inside code blocks", () => {
      const input = "```\n<div>foo & bar</div>\n```";
      expect(formatForTelegram(input)).toBe("<pre>&lt;div&gt;foo &amp; bar&lt;/div&gt;\n</pre>");
    });
  });

  describe("HTML input escaping", () => {
    it("escapes HTML tags to prevent injection", () => {
      expect(formatForTelegram("<b>bold</b>")).toBe("&lt;b&gt;bold&lt;/b&gt;");
    });

    it("escapes multiple tags", () => {
      expect(formatForTelegram("<p>Hello <em>world</em></p>")).toBe(
        "&lt;p&gt;Hello &lt;em&gt;world&lt;/em&gt;&lt;/p&gt;"
      );
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
      expect(result).toBe("<b>My Heading - With Dash</b>");
    });

    it("handles bold with special chars", () => {
      const result = formatForTelegram("**hello.world**");
      expect(result).toBe("<b>hello.world</b>");
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
    expect(rejoined).toContain("First paragraph here");
    expect(rejoined).toContain("Second paragraph here");
    expect(rejoined).toContain("Third paragraph here");
  });

  it("does not split inside <pre> blocks", () => {
    // Build a message where the only split point falls inside a <pre> block
    const preContent = "x".repeat(3000);
    const text = `<pre>${preContent}</pre>\n\nafter`;
    // maxLen=3500 — the natural split at 3500 would land inside the <pre>
    const chunks = splitLongMessage(text, 3500);
    // Every chunk must not contain an unclosed <pre>
    for (const chunk of chunks) {
      const opens = (chunk.match(/<pre>/g) || []).length;
      const closes = (chunk.match(/<\/pre>/g) || []).length;
      expect(opens).toBe(closes);
    }
  });

  it("splits after a covering <pre> block when all natural boundaries are inside it", () => {
    // Construct text: a <pre> block that spans maxLen boundary, with no spaces or newlines
    // outside it within the window — forces the coveringPre branch.
    const preContent = "y".repeat(2000);
    const text = `<pre>${preContent}</pre>extra`;
    // maxLen=100 — the pre block spans [0, 2011], which covers position 100.
    // No spaces/newlines inside the pre block, so coveringPre branch must fire.
    const chunks = splitLongMessage(text, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // The first chunk must end at the close of the <pre> block
    expect(chunks[0]).toContain("</pre>");
    // No chunk should have mismatched <pre>/<\/pre> tags
    for (const chunk of chunks) {
      const opens = (chunk.match(/<pre>/g) || []).length;
      const closes = (chunk.match(/<\/pre>/g) || []).length;
      expect(opens).toBe(closes);
    }
  });

  it("hard-splits at maxLen when no boundary and no covering pre block", () => {
    // Pure run of 'a' with no spaces/newlines/pre — falls to splitAt = maxLen
    const text = "a".repeat(200);
    const chunks = splitLongMessage(text, 50);
    // Every chunk should be at most 50 characters
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    // Content is fully preserved
    expect(chunks.join("")).toBe(text);
  });

  it("produces no trailing empty chunk when remaining is exactly empty after loop", () => {
    // text length = 2 * maxLen exactly, split at word boundary at maxLen
    // After slicing off the first half, remaining is exactly the second half with no leftover.
    const half = "a".repeat(50);
    const text = `${half} ${half}`;  // 101 chars with space at index 50
    const chunks = splitLongMessage(text, 51);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });
});

describe("formatForTelegram — additional edge cases", () => {
  it("--- in the middle of a sentence is NOT converted (only full-line ---)", () => {
    // The regex ^-{3,}$ with gm only matches --- on its own line
    const result = formatForTelegram("before --- after");
    expect(result).toBe("before --- after");
  });

  it("longer rule (----) on its own line is also stripped", () => {
    const result = formatForTelegram("above\n----\nbelow");
    expect(result).toBe("above\n\nbelow");
  });

  it("bold spanning a newline is converted (s flag)", () => {
    const result = formatForTelegram("**hello\nworld**");
    expect(result).toBe("<b>hello\nworld</b>");
  });

  it("multiple HTML special chars in the same text", () => {
    // & < > all in one string
    const result = formatForTelegram("a & b < c > d");
    expect(result).toBe("a &amp; b &lt; c &gt; d");
  });

  it("htmlEscape inside code block does not double-escape", () => {
    // <pre> content is html-escaped once; the outer text is also html-escaped
    const input = "```\na & b\n```";
    const result = formatForTelegram(input);
    expect(result).toBe("<pre>a &amp; b\n</pre>");
  });

  it("italic does not fire for snake_case in the middle of a word", () => {
    expect(formatForTelegram("foo_bar_baz")).toBe("foo_bar_baz");
  });

  it("italic fires when _ delimiters are at non-word-character boundaries", () => {
    expect(formatForTelegram("(_italic_)")).toBe("(<i>italic</i>)");
  });

  it("inline code with < and > escapes them", () => {
    const result = formatForTelegram("`a < b`");
    expect(result).toBe("<code>a &lt; b</code>");
  });

  it("handles empty string input", () => {
    expect(formatForTelegram("")).toBe("");
  });
});
