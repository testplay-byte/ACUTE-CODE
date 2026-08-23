#!/usr/bin/env node
/**
 * Public status-dashboard builder (round-17, ADR-0021).
 *
 * Reads ONLY docs/status.json + git metadata and emits a self-contained
 * dashboard.html (inline CSS, no JS, no external assets) styled on the
 * product's DESIGN-SYSTEM (dark bento cards, accent #FF6B2C, mono chips).
 *
 * SECURITY: fail-closed DENYLIST assert on the rendered output — the page
 * is published to a PUBLIC repo, so anything internal (tokens, the owner's
 * private model id, internal paths, env names, ports, the ntfy topic, id
 * prefixes, repo paths) aborts the build with exit 1 BEFORE publishing.
 * Content is allowlist-driven: only status.json fields and fixed literals
 * are interpolated, always HTML-escaped.
 *
 * Usage:  node scripts/dashboard/build-dashboard.mjs [--out <file>]
 * Env:    CI_CONCLUSION (optional: stamps the quality panel verdict)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const statusPath = resolve(repoRoot, "docs", "status.json");
const outPath = resolve(
  repoRoot,
  process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : "dashboard.html",
);

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const status = JSON.parse(readFileSync(statusPath, "utf8"));
if (status.schema !== "acute-status/1") {
  console.error(`status schema mismatch: ${status.schema}`);
  process.exit(1);
}

const sha = git(["rev-parse", "--short", "HEAD"]);
const commitDate = git(["log", "-1", "--format=%cs", "HEAD"]);
const builtAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
const ci =
  process.env.CI_CONCLUSION === "success"
    ? "green"
    : process.env.CI_CONCLUSION
      ? "red"
      : status.quality.ci;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STATE_COLOR = { usable: "#22c55e", building: "#FF6B2C", planned: "#8b8b8b" };

const pillarCard = (p) => `
    <div class="card pillar">
      <div class="pillar-head">
        <span class="dot" style="background:${STATE_COLOR[p.state] ?? "#8b8b8b"}"></span>
        <span class="pillar-title">${esc(p.title)}</span>
        <span class="chip">${esc(p.state)}</span>
      </div>
      <div class="bar"><div class="bar-fill" style="width:${Math.max(3, Math.min(100, Number(p.progress) || 0))}%"></div></div>
      <div class="pillar-foot">
        <span class="muted">${esc(p.summary)}</span>
        <span class="mono">${Number(p.progress) || 0}%</span>
      </div>
    </div>`;

const milestoneRow = (m) => `
      <div class="ms"><span class="mono muted">${esc(m.date)}</span><span>${esc(m.label)}</span></div>`;

const suiteChip = (s) => `<span class="chip">${esc(s.name)} · ${Number(s.tests) || 0} tests</span>`;

const PLAN_STATUS = { queued: "#8b8b8b", "owner-gated": "#FF6B2C", planned: "#8b8b8b", active: "#22c55e" };
const planRow = (item) => `
      <div class="plan-row">
        <span class="dot" style="background:${PLAN_STATUS[item.status] ?? "#8b8b8b"}"></span>
        <span class="plan-phase">${esc(item.phase)}</span>
        <span class="chip">${esc(item.status)}</span>
        <span class="muted plan-note">${esc(item.note)}</span>
      </div>`;
const principle = (s) => `      <li>${esc(s)}</li>`;

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acute — status</title>
<style>
  :root{--bg:#101014;--card:#17171c;--line:#2a2a31;--ink:#f2f0eb;--muted:#9b988f;--accent:#FF6B2C;--good:#22c55e}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:28px 20px 48px}
  .wrap{max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
  .card{background:var(--card);border:1.5px solid var(--line);border-radius:16px;padding:18px 20px}
  header.card{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .logo{width:34px;height:34px;border-radius:10px;background:var(--accent);display:grid;place-items:center;font-weight:800;font-size:16px;color:#111}
  h1{font-size:19px;letter-spacing:-.01em}
  .tagline{color:var(--muted);font-size:12.5px;flex:1 1 220px}
  .pill{font:600 11px/1 ui-monospace,monospace;padding:6px 10px;border-radius:999px}
  .pill.green{color:var(--good);background:rgba(34,197,94,.12)}
  .pill.red{color:#ef4444;background:rgba(239,68,68,.12)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
  .pillar-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
  .dot{width:9px;height:9px;border-radius:50%}
  .pillar-title{font-weight:700;font-size:13.5px;flex:1}
  .bar{height:5px;border-radius:99px;background:#232329;overflow:hidden}
  .bar-fill{height:100%;border-radius:99px;background:var(--accent)}
  .pillar-foot{display:flex;justify-content:space-between;gap:8px;margin-top:8px;font-size:12px}
  .muted{color:var(--muted)}
  .mono{font:11.5px ui-monospace,"JetBrains Mono",monospace}
  .chip{font:600 10.5px/1 ui-monospace,monospace;color:var(--muted);background:#232329;border-radius:7px;padding:5px 8px;white-space:nowrap}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:10px}
  .ms{display:flex;gap:14px;padding:5px 0;border-bottom:1px dashed #232329;font-size:12.5px}
  .ms:last-child{border-bottom:0}
  .ms .mono{min-width:86px}
  .plan-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed #232329;font-size:13px}
  .plan-row:last-child{border-bottom:0}
  .plan-phase{font-weight:600;min-width:180px}
  .plan-note{flex:1;font-size:12px}
  .plan-current{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:rgba(255,107,44,.08);border:1.5px solid rgba(255,107,44,.25);margin-bottom:12px}
  .plan-current-label{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);font-weight:700}
  .plan-current-title{font-weight:700;font-size:14px}
  .plan-current-detail{color:var(--muted);font-size:12px}
  .principles{margin:0;padding:0 0 0 16px;font-size:12.5px;color:var(--muted)}
  .principles li{padding:2px 0}
  footer{color:var(--muted);font:11px ui-monospace,monospace;text-align:center;margin-top:6px}
  a{color:var(--accent);text-decoration:none}
</style></head><body>
<div class="wrap">
  <header class="card">
    <div class="logo">◐</div>
    <div style="flex:1">
      <h1>${esc(status.product.name)} <span class="mono muted">v${esc(status.product.version)}</span></h1>
      <div class="tagline">${esc(status.product.tagline)} — ${esc(status.product.availability)}</div>
    </div>
    <span class="pill ${ci === "green" || ci === "success" ? "green" : "red"}">${ci === "green" || ci === "success" ? "● healthy" : "● check runs"}</span>
  </header>

  <div class="grid">
${status.pillars.map(pillarCard).join("\n")}
  </div>

${status.plan ? `
  <div class="card">
    <h2>The Plan</h2>
    <div class="plan-current">
      <div style="flex:1">
        <div class="plan-current-label">Now</div>
        <div class="plan-current-title">${esc(status.plan.current.title)}</div>
        <div class="plan-current-detail">${esc(status.plan.current.detail)}</div>
      </div>
    </div>
${status.plan.upcoming.map(planRow).join("\n")}
    ${status.plan.principles ? `
    <div style="margin-top:14px">
      <h2>Principles</h2>
      <ul class="principles">
${status.plan.principles.map(principle).join("\n")}
      </ul>
    </div>` : ""}
  </div>

` : ""}  <div class="card">
    <h2>Quality</h2>
    <div class="chips">
${status.quality.suites.map(suiteChip).join("\n")}
      <span class="chip">cargo check · ${esc(status.quality.cargoCheck)}</span>
      <span class="chip">license audit · ${esc(status.quality.licenseAudit.deps)} deps · ${esc(status.quality.licenseAudit.verdict)}</span>
    </div>
  </div>

  <div class="card">
    <h2>Milestones</h2>
${status.milestones.map(milestoneRow).join("\n")}
  </div>

  <div class="card">
    <h2>Built with</h2>
    <div class="chips">
${status.product.chips.map((c) => `      <span class="chip">${esc(c)}</span>`).join("\n")}
    </div>
    <div class="chips" style="margin-top:8px">
${status.publicLinks.map((l) => `      <a class="chip" href="${esc(l.url)}">${esc(l.label)} ↗</a>`).join("\n")}
    </div>
  </div>

  <footer>generated ${esc(builtAt)} · state ${esc(sha)} (${esc(commitDate)}) · hand-published from the private repo</footer>
</div>
</body></html>
`;

// ── fail-closed DENYLIST (ADR-0021) ─────────────────────────────────────────
const DENY = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "token pattern"],
  [/github_pat_/, "fine-grained token prefix"],
  [/sk-[A-Za-z0-9_-]{16,}/, "api-key pattern"],
  [/stealth\/ox-alpha|ox-alpha/, "private model id"],
  [/C:\\Users\\|\/home\/[a-z]+\//, "internal path"],
  [/ACUTEST/, "internal test folder"],
  [/ntfy\.sh|TASKISDONE/, "notification topic"],
  [/testplay-byte\/ACUTE-CODE(?!-DASH)/, "private repo path"],
  [/\b(agt_|sess_|prj_)[a-z0-9-]{6,}/i, "internal id prefix"],
  [/localhost:51\d\d|127\.0\.0\.1:51\d\d/, "dev port"],
  [/ACUTE_TOKEN|ACUTE_PROVIDER|ACUTE_DB_PATH/, "env auth surface"],
  [/Credential Manager|credentials\.txt/, "credential storage"],
  [/[A-Za-z0-9_]{70,}/, "suspicious long secret-like run"],
];
const hits = DENY.map(([re, why]) => (re.test(html) ? why : null)).filter(Boolean);
if (hits.length > 0) {
  console.error(`DENYLIST violation(s) in rendered dashboard: ${hits.join(", ")}`);
  process.exit(1);
}

writeFileSync(outPath, html, "utf8");
console.log(`dashboard written: ${outPath} (state ${sha}, ${html.length} bytes, denylist clean)`);
