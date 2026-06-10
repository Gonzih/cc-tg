# PLAN.md — fix/router-numeric-hashtag

## Task Restatement
`parseRoutingTag()` in `src/router.ts` currently matches `#57`, `#123`, `#2fast` as valid
routing tags because the regex first character class is `[a-zA-Z0-9]`. This causes Telegram
messages containing issue/PR reference numbers to spawn ghost meta-agent namespaces.
Fix: require the first character after `#` to be alphabetic (`[a-zA-Z]`).

---

## Approaches Considered

### A) Require alphabetic first character in regex (CHOSEN)
Change `#([a-zA-Z0-9][a-zA-Z0-9._-]*)` → `#([a-zA-Z][a-zA-Z0-9._-]*)`.
**Pro**: One-character change, surgical, matches the spec exactly.
**Con**: None.

### B) Post-match validation (reject if namespace is all-digits)
After matching, check `if (/^\d+$/.test(namespace)) return null`.
**Con**: More code; still fails for `#2fast`-style mixed tags.

### C) Require at least 2 characters
Ensure namespace is `[a-zA-Z][a-zA-Z0-9._-]+` (one or more after the letter).
**Con**: Would reject single-letter tags like `#a` which are valid real repo names.

---

## Approach: A

---

## Files to Touch
- `src/router.ts` — fix the regex and update the inline comment + JSDoc
- `src/router.test.ts` — add tests for `#57`, `#123abc`, `#2fast`, update existing comment

---

## Risks
- The `#org/repo` format also uses the same first character class for `part1` (the org).
  Changing the constraint means `#57/repo` won't route either, which is correct behaviour.
- No other callers of `parseRoutingTag` in the codebase need changes.
