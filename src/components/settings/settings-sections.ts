import {
  BarChart3,
  Bot,
  FileText,
  Globe,
  Info,
  Monitor,
  NotebookPen,
  Palette,
  PlugZap,
  ScanEye,
  Server,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * R102-C (owner v0.99.0: "If I try to go to the settings page, then
 * apparently the left sidebar does not change and the settings sidebar
 * shows on the right side of the left sidebar, which is not perfect …
 * handle it just like how it was handled previously"): the ONE source of
 * truth for the settings section list — the app sidebar's SETTINGS MODE
 * (restored this round: on /settings the LEFT sidebar becomes the settings
 * nav, the ROUND-34/R66 behavior the owner asked for back) and the
 * SettingsPage's ?tab= machine both render from THIS module.
 *
 * History: the list was born in SettingsPage (ROUND-34), mirrored into the
 * sidebar's SETTINGS_SECTIONS (R34→R98, id-synced — the R44
 * unreachable-tab lesson), then R100-E1 retired the sidebar's settings
 * mode in favor of a settings-local nav column — which is exactly the
 * doubled sidebar the owner rejected in v0.99.0. R102-C merges the two
 * copies HERE so the id-sync discipline is enforced by construction: one
 * list, two consumers, deep links (?tab=<id>) keep working everywhere.
 *
 * R98-I1 (owner: "add a dedicated section for functionality… separate the
 * different side options into different categories, like basic agent
 * capabilities, data and statistics"): the GROUPED map. Every entry
 * carries a `group` (the five owner-named categories, in nav order:
 * Workspace → Agents & Skills → Integrations → Data & Statistics →
 * System) and the list is CLUSTERED by group — appearance | agents +
 * subagents + skills + prompts | api + mcp + computeruse + vision +
 * browser | data | advanced + about. The ids (and each cluster's internal
 * order) are UNTOUCHED — every ?tab=<id> deep link keeps working (the URL
 * contract is load-bearing, the R44 lesson).
 */
export type SettingsGroup =
  | "Workspace"
  | "Agents & Skills"
  | "Integrations"
  | "Data & Statistics"
  | "System";

export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", icon: Palette, group: "Workspace" },
  { id: "agents", label: "Agents", icon: Bot, group: "Agents & Skills" },
  // ROUND-43 (R43-5, owner directive): the temporary sub-agent section —
  // dedicated API-key paste slots + model override. Deep-link ?tab=subagents.
  { id: "subagents", label: "Sub-agents", icon: Users, group: "Agents & Skills" },
  // ROUND-61 (R61, owner directive): the extensibility surface — skills,
  // MCP servers, and computer use (with its separate vision model).
  { id: "skills", label: "Skills", icon: Sparkles, group: "Agents & Skills" },
  // ROUND-98 (R98-E1/E3, owner directive): the prompt-customization section —
  // per-project system-prompt overrides + revert + drop + the live composed
  // preview. Sits beside Skills (the prompt-modules family). Deep-link
  // ?tab=prompts.
  { id: "prompts", label: "Prompts", icon: FileText, group: "Agents & Skills" },
  { id: "api", label: "Models & Providers", icon: Server, group: "Integrations" },
  { id: "mcp", label: "MCP Servers", icon: PlugZap, group: "Integrations" },
  { id: "computeruse", label: "Computer Use", icon: Monitor, group: "Integrations" },
  // ROUND-66 (R66, owner directive): the dedicated image-analysis section —
  // the vision model's OWN home (provider + model + API key), split out of
  // Computer Use so it also serves the general analyze_image tool.
  { id: "vision", label: "Image Analysis", icon: ScanEye, group: "Integrations" },
  // ROUND-97 (R97-G, owner directive): the dedicated BROWSER section — the
  // address-bar search engine, the homepage, the default zoom, and the
  // editable quick links. Same id discipline (deep-link ?tab=browser).
  { id: "browser", label: "Browser", icon: Globe, group: "Integrations" },
  // ROUND-106 (R106-S2, per ANDROID-R3-OWNER-RULINGS §3.2): the dedicated
  // DEVICES section — the desktop half of device linking: the allow-links
  // master toggle, "Link a device" (QR + PIN + the live 120s countdown +
  // the manual fallback), and the linked-devices list with revoke. Same id
  // discipline (deep-link ?tab=devices).
  { id: "devices", label: "Devices", icon: Smartphone, group: "Integrations" },
  // ROUND-98 (R98-I2, owner directive): the Data & Statistics section —
  // total tokens, peak day, the heatmap, the model-mix charts, agent
  // health, and clear-all-data (the same DataStatsPanel the /usage screen
  // hosts). Same id discipline (deep-link ?tab=data). R98-I1: its OWN
  // category in the grouped nav (the owner's "data and statistics").
  { id: "data", label: "Data & Statistics", icon: BarChart3, group: "Data & Statistics" },
  // ROUND-78 (R78-C, owner: "General Settings 重试配置"): the tab was
  // LABELED "General" then. R98-I1 (owner: "add a dedicated section for
  // functionality…"): the LABEL is "Functionality" now — the owner's word
  // for the category the engine switches live in. The id/deep-link STAYS
  // "advanced" (every existing ?tab=advanced link + doc keeps working;
  // the URL contract is load-bearing — changing it would break deep links).
  { id: "advanced", label: "Functionality", icon: SlidersHorizontal, group: "System" },
  // ROUND-122 (the owner's self-feedback directive): the dedicated
  // SELF-FEEDBACK section — the ledger's master switch + the raw file
  // viewer (the one shared feedback.md every post-turn reporter appends
  // to). Same id discipline (deep-link ?tab=feedback).
  { id: "feedback", label: "Self-Feedback", icon: NotebookPen, group: "System" },
  // ROUND-87 (R87, owner directive): the dedicated ABOUT section — the app
  // version, the update check (GitHub releases), and the application-wide
  // reset. Deep-link ?tab=about.
  { id: "about", label: "About", icon: Info, group: "System" },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  icon: LucideIcon;
  group: SettingsGroup;
}>;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/**
 * R100-E1 (research §C2 P1(a) — the VS Code settings-search pattern): the
 * per-tab keyword list backing the settings nav's SEARCH BOX (R102-C: the
 * box lives in the SIDEBAR's settings mode now). Honest scope: the query
 * filters the SECTION LIST by matching the label + these keywords (each
 * list extracted from that tab's real setting labels — "api key",
 * "provider", "zoom"…), case-insensitive substring. It NEVER touches the
 * tab state machine — the URL ?tab= stays the one truth (deep links keep
 * working; a hidden active tab keeps rendering until the user picks
 * another).
 */
export const SEARCH_KEYWORDS: Record<SettingsSectionId, readonly string[]> = {
  appearance: ["theme", "light", "dark", "mode", "density", "text size", "timestamps", "tool activity"],
  agents: ["agent", "create agent", "instructions", "template", "tools"],
  subagents: ["sub-agent", "api key", "model", "parallelism", "supervision"],
  skills: ["skill", "prompt module", "new skill", "skill body"],
  prompts: ["system prompt", "prompt section", "override", "preview", "project"],
  api: ["api key", "provider", "model", "openrouter", "anthropic", "openai", "google", "preset", "catalog", "context window", "price"],
  mcp: ["mcp", "server", "stdio", "command", "tool server"],
  computeruse: ["computer use", "desktop control", "master switch", "posture", "safety"],
  vision: ["vision", "image analysis", "model", "api key", "provider"],
  browser: ["search engine", "homepage", "home page", "zoom", "link opening", "quick links"],
  devices: ["device", "phone", "link", "pair", "pairing", "qr", "pin", "android", "companion", "revoke", "last seen"],
  data: ["data", "statistics", "tokens", "heatmap", "model mix", "agent health", "clear data", "usage"],
  advanced: ["retry", "rate limit", "timeout", "network", "thinking loop", "debug", "analyst", "memory", "desktop notifications", "schedule"],
  feedback: ["self-feedback", "feedback", "ledger", "report", "diagnostics", "improvements", "glitches", "issues", "file", "entries"],
  about: ["version", "update", "reset", "engine", "releases"],
};

/** True when the section matches the search needle (label or keyword,
 * case-insensitive substring) — the settings nav's filter predicate. */
export function sectionMatchesQuery(
  section: { id: SettingsSectionId; label: string },
  needle: string,
): boolean {
  if (needle === "") return true;
  return (
    section.label.toLowerCase().includes(needle) ||
    SEARCH_KEYWORDS[section.id].some((k) => k.toLowerCase().includes(needle))
  );
}
