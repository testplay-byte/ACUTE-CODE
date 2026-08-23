/**
 * Intentional palette constants for the project-chat code view, ported from
 * design/demos/project-chat/src/components/project-chat/CodeView.tsx. File-type
 * colors and the syntax palette are DATA, not theme: they identify languages
 * (TypeScript blue, JSON amber, …) the same way in light and dark mode, so they
 * deliberately bypass the --ac-* token rule. Syntax hexes match the demo
 * exactly (#a5d6a7 strings, #6a737d comments, #f9a825 numbers, #c792ea
 * keywords, #82aaff types).
 */

export const SYNTAX_COLORS = {
  string: "#a5d6a7",
  comment: "#6a737d",
  number: "#f9a825",
  keyword: "#c792ea",
  type: "#82aaff",
} as const;

/** File-extension → icon chip color ("default" for unknown extensions). */
export const FILE_COLORS: Record<string, string> = {
  tsx: "#3178C6",
  ts: "#3178C6",
  json: "#F59E0B",
  css: "#A855F7",
  md: "#6B7280",
  env: "#EF4444",
  js: "#F7DF1E",
  default: "#6B7280",
};

/** Convenience lookup: extension of `fileName` → color (dotfiles like .env.local map to env). */
export function getFileColor(fileName: string): string {
  if (fileName.startsWith(".env")) return FILE_COLORS.env;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return FILE_COLORS.default;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return FILE_COLORS[ext] ?? FILE_COLORS.default;
}

const KEYWORDS = [
  "import",
  "export",
  "from",
  "const",
  "let",
  "var",
  "function",
  "return",
  "async",
  "await",
  "if",
  "else",
  "new",
  "typeof",
  "interface",
  "type",
  "extends",
];

const TYPES = [
  "string",
  "number",
  "boolean",
  "void",
  "NextRequest",
  "NextResponse",
  "RateLimiter",
  "AuthGuard",
];

/** Token split regex from the demo tokenizer, unchanged. */
const TOKEN_RE =
  /(\b(?:'[^']*'|"[^"]*"|`[^`]*`|\d+\.?\d*|\b[a-zA-Z_$][a-zA-Z0-9_$]*\b)\b|[{}()<>:;,=+\-*/&|!?.@[\]]|\/\/.*$)/g;

/**
 * Split one source line into colored tokens (verbatim port of the demo's
 * highlightLine; JSX spans replaced by {text, color} pairs so the caller owns
 * rendering). Uncolored tokens carry no `color`.
 */
export function highlightLine(line: string): Array<{ text: string; color?: string }> {
  const tokens = line.split(TOKEN_RE);

  return tokens.map((token) => {
    if (
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("`") && token.endsWith("`"))
    ) {
      return { text: token, color: SYNTAX_COLORS.string };
    }
    if (token.startsWith("//")) return { text: token, color: SYNTAX_COLORS.comment };
    if (/^\d+\.?\d*$/.test(token)) return { text: token, color: SYNTAX_COLORS.number };
    if (KEYWORDS.includes(token)) return { text: token, color: SYNTAX_COLORS.keyword };
    if (TYPES.includes(token)) return { text: token, color: SYNTAX_COLORS.type };
    return { text: token };
  });
}
