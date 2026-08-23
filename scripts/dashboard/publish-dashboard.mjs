#!/usr/bin/env node
/**
 * Publish the public status dashboard to the separate PUBLIC repo
 * testplay-byte/ACUTE-DASH (ADR-0021). Run AFTER a merged, CI-green round
 * when docs/status.json moved (WORKFLOW §6).
 *
 * Steps: build dashboard.html (denylist-checked) → clone/refresh ACUTE-DASH
 * via token-in-URL (ADR-0018 pattern; remote sanitized) → commit + push →
 * ensure Pages (API, idempotent) → verify the live URL answers 200.
 *
 * Env: GITHUB_PAT (required; the orchestrator's PAT — dashboard-only
 * fine-grained PAT works too), ACUTE_DASH_NAME (default ACUTE-DASH).
 * The PAT value is never printed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAT = process.env.GITHUB_PAT;
const OWNER = "testplay-byte";
const NAME = process.env.ACUTE_DASH_NAME ?? "ACUTE-DASH";
if (!PAT) {
  console.error("GITHUB_PAT env required (value never printed)");
  process.exit(1);
}

const api = (path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${PAT}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "acute-dash-publisher",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });

const run = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.status !== 0) {
    const out = (res.stderr || res.stdout || "");
    if (/403|Permission to .* denied/.test(out)) {
      console.error(
        `PUSH DENIED (HTTP 403): the fine-grained PAT's repository access does not include ${OWNER}/${NAME}.\n` +
        "OWNER ONE-TIME FIX (pick one):\n" +
        "  A) github.com → Settings → Developer settings → Fine-grained tokens → edit this token →\n" +
        `     Repository access → add ${OWNER}/${NAME} → Contents: Read and write → Save.\n` +
        `  B) Create a NEW fine-grained token scoped to ONLY ${NAME} (Contents R/W) and set it as\n` +
        "     the ACUTE_DASH_PAT repo secret / GITHUB_PAT when publishing.\n" +
        "Then re-run: GITHUB_PAT=<token> node scripts/dashboard/publish-dashboard.mjs",
      );
      process.exit(2);
    }
    console.error(`command failed: ${cmd} ${args.join(" ")}\n${out.slice(0, 500)}`);
    process.exit(1);
  }
  return res.stdout;
};

// 1. Build the dashboard (includes the denylist assert).
run("node", [join(repoRoot, "scripts", "dashboard", "build-dashboard.mjs"), "--out", join(repoRoot, ".dev", "dashboard.html")]);

// 2. Ensure the public repo exists (idempotent).
const repoRes = await api(`/repos/${OWNER}/${NAME}`);
if (repoRes.status === 404) {
  const created = await api("/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name: NAME,
      private: false,
      has_issues: false,
      has_wiki: false,
      has_projects: false,
      description: "Acute — public status dashboard (generated; no source)",
    }),
  });
  if (!created.ok) {
    console.error(`repo create failed: HTTP ${created.status}`);
    process.exit(1);
  }
  console.log(`created public repo ${OWNER}/${NAME}`);
} else if (!repoRes.ok) {
  console.error(`repo check failed: HTTP ${repoRes.status}`);
  process.exit(1);
} else if ((await repoRes.json()).private) {
  console.error(`${OWNER}/${NAME} is PRIVATE — refusing to publish into it`);
  process.exit(1);
}

// 3. Clone (token-in-URL for THIS command only), copy, commit, push.
const work = mkdtempSync(join(tmpdir(), "acute-dash-"));
try {
  run("git", ["-c", "credential.helper=", "clone", `https://${OWNER}:${PAT}@github.com/${OWNER}/${NAME}.git`, "dash"], {
    cwd: work,
  });
  const dash = join(work, "dash");
  run("git", ["remote", "set-url", "origin", `https://github.com/${OWNER}/${NAME}.git`], { cwd: dash });

  copyFileSync(join(repoRoot, ".dev", "dashboard.html"), join(dash, "index.html"));
  const readme = existsSync(join(dash, "README.md"))
    ? readFileSync(join(dash, "README.md"), "utf8")
    : `# ${NAME}\n\nGenerated status dashboard for **Acute** (private product).\nThis repo contains ONLY the generated \`index.html\` — no source code.\n\nRebuilt from the private repo's \`docs/status.json\`; see ADR-0021.\n`;
  writeFileSync(join(dash, "README.md"), readme, "utf8");

  run("git", ["add", "-A"], { cwd: dash });
  run("git", ["-c", "user.name=acute-dashboard-publisher", "-c", "user.email=dash@acute.local", "commit", "-q", "-m", `status update ${new Date().toISOString()}`], { cwd: dash });
  run("git", ["-c", "credential.helper=", "push", `https://${OWNER}:${PAT}@github.com/${OWNER}/${NAME}.git`, "HEAD:main"], { cwd: dash });
  console.log(`pushed ${NAME}@main`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 4. Ensure Pages is enabled from main (idempotent).
const pagesRes = await api(`/repos/${OWNER}/${NAME}/pages`);
if (pagesRes.status === 404) {
  const enable = await api(`/repos/${OWNER}/${NAME}/pages`, {
    method: "POST",
    body: JSON.stringify({ source: { branch: "main", path: "/" } }),
  });
  console.log(enable.ok ? "pages enabled (main/)" : `pages enable HTTP ${enable.status} — enable manually if needed`);
} else {
  console.log("pages already enabled");
}

// 5. Verify the live URL (propagation can take a minute).
const url = `https://${OWNER}.github.io/${NAME}/`;
for (let i = 1; i <= 6; i++) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (res.ok) {
      console.log(`live: ${url} (HTTP 200)`);
      process.exit(0);
    }
  } catch {
    /* propagation delay — retry */
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.log(`pushed, but ${url} not answering yet — GitHub Pages propagation; re-check in a minute`);
