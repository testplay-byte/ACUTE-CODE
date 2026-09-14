/**
 * ROUND-97 (R97-F) — the syntax highlighter behind CodeBlock's colors.
 *
 * The owner: "in the thinking, if it shows a code block, then that code block
 * should clearly be highlighted. It should clearly be formatted in colors and
 * it should be properly shown." Prism (MIT — the license audit's allowed set)
 * tokenizes; THIS module is the app's single owner of which languages load
 * and how a fence's info string maps onto them. The THEMING lives in
 * index.css (the .token.* palette, light + dark) — no Prism CSS is imported;
 * the app paints its own so the colors follow the design system.
 *
 * Pure helpers (highlightCode + normalizeLang) are exported for tests.
 */
import Prism from "prismjs";

// ── the language set ────────────────────────────────────────────────────────
// Explicit imports (NOT loadLanguages — that pulls the whole catalogue into
// the bundle). Order matters: each grammar declares its dependencies and
// Prism's extend() requires the base to exist first, so the sequence below is
// the Prism components' own dependency order.
import "prismjs/components/prism-markup";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-css";
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-go";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
// prism-php declares markup-templating + c as dependencies (components.json)
// — the templating grammar MUST load before php or its before-highlight hook
// reads an undefined grammar and every later highlight() throws (found by
// bisect in the R97-F tests).
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-regex";

/** The fence-info-string → Prism grammar alias map (the common spellings a
 * model emits; unknown aliases fall back to plain text — never a crash). */
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  react: "jsx",
  html: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  svelte: "markup",
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  terminal: "bash",
  yml: "yaml",
  md: "markdown",
  rust: "rust",
  rs: "rust",
  golang: "go",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  dockerfile: "docker",
  text: "none",
  txt: "none",
  plaintext: "none",
  plain: "none",
};

/** R97-F: normalize a fence's info string to a loaded Prism grammar name
 * ("" → none). Pure; exported for tests. */
export function normalizeLang(raw: string | undefined): string {
  const lang = (raw ?? "").trim().toLowerCase().split(/[\s:,]/)[0] ?? "";
  if (lang === "") return "none";
  const aliased = LANG_ALIASES[lang] ?? lang;
  return Prism.languages[aliased] !== undefined ? aliased : "none";
}

/** R97-F: highlight `code` as `lang` → an HTML string of `<span class="token
 * …">` runs, or null when the language is unknown (the caller renders the
 * plain text — never a crash, never fabricated markup). Pure-ish (Prism's
 * tokenize is deterministic); exported for tests + CodeBlock. */
export function highlightCode(code: string, lang: string | undefined): string | null {
  const grammarName = normalizeLang(lang);
  if (grammarName === "none") return null;
  const grammar = Prism.languages[grammarName];
  if (grammar === undefined) return null;
  try {
    return Prism.highlight(code, grammar, grammarName);
  } catch {
    // A pathological input must never take the render down with it.
    return null;
  }
}

// ── R97-J (m4): the per-line split ─────────────────────────────────────────
// The R97-F CodeBlock rendered Prism's whole-block HTML in ONE <code>, which
// silently dropped the line-number gutter the plain fallback (and every
// pre-R97 block) had — and made the two paths wrap differently. The honest
// fix: split the TOKEN STREAM (never the output HTML — tokens span newlines:
// block comments, template literals; naive string-splitting breaks their
// spans) into one HTML string per line, re-opening the enclosing token
// classes on each continuation line. The CodeBlock then renders the SAME
// numbered rows as the fallback, colors included.

/** One element of Prism's token stream. */
type TokenNode = string | { type: string; alias?: string | string[]; content: TokenNode | TokenNode[] };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tokenClass(token: { type: string; alias?: string | string[] }): string {
  // Prism's own stringify shape: type + aliases, space-joined.
  const classes = [token.type];
  if (token.alias !== undefined) {
    if (Array.isArray(token.alias)) classes.push(...token.alias);
    else classes.push(token.alias);
  }
  return classes.join(" ");
}

/** R97-J (m4): highlight + split → one HTML string per line (same span
 * classes as highlightCode, re-opened across line breaks), or null when the
 * language is unknown / the input is pathological (the caller falls back to
 * the plain numbered rows — never a crash). Pure; exported for tests. */
export function highlightLines(code: string, lang: string | undefined): string[] | null {
  const grammarName = normalizeLang(lang);
  if (grammarName === "none") return null;
  const grammar = Prism.languages[grammarName];
  if (grammar === undefined) return null;
  try {
    const tokens = Prism.tokenize(code, grammar) as TokenNode[];
    const out: string[] = [];
    let current = "";
    const stack: string[] = [];

    const openSpan = (cls: string): void => {
      stack.push(cls);
      current += `<span class="token ${cls}">`;
    };
    const closeSpan = (): void => {
      stack.pop();
      current += "</span>";
    };
    const newline = (): void => {
      // Close this line's open spans, then re-open them on the next line so
      // every line is standalone-valid HTML.
      const open = [...stack];
      for (let i = 0; i < open.length; i += 1) closeSpan();
      out.push(current);
      current = "";
      for (const cls of open) openSpan(cls);
    };
    const emitText = (text: string): void => {
      const parts = text.split("\n");
      parts.forEach((part, i) => {
        if (i > 0) newline();
        current += escapeHtml(part);
      });
    };
    const walk = (node: TokenNode): void => {
      if (typeof node === "string") {
        emitText(node);
        return;
      }
      openSpan(tokenClass(node));
      if (Array.isArray(node.content)) {
        for (const child of node.content) walk(child);
      } else {
        walk(node.content);
      }
      closeSpan();
    };

    for (const token of tokens) walk(token);
    for (let i = 0; i < stack.length; i += 1) closeSpan();
    out.push(current);
    return out;
  } catch {
    // A pathological input must never take the render down with it.
    return null;
  }
}
