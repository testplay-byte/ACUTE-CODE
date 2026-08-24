<!-- last-reviewed: 2026-08-24 round-33 -->
# DEMO — Phase 2: Core Skeleton (≤2 minutes)

**Goal:** create an agent in the UI and complete one real conversation with it. This is the Phase 2 exit criterion.

## Start the app

```bash
cd C:\Users\khurr\Desktop\ZCODE\ACUTE_CODE\acute-code\src-tauri
cargo run          # first build takes a few minutes; later runs start in seconds
```

What happens automatically: the window opens · the shell mints a session token and spawns the sidecar (`node agent-core/dist/main.js`) · the sidecar binds a loopback port and prints `ACUTE_READY {"port":N}` · the shell health-polls it · your OpenRouter key is read from Windows Credential Manager and injected into the sidecar's environment (never written to disk).

## Walkthrough

1. **Create the agent** — sidebar → **Agents** → *New agent*: name it (e.g. "My Assistant"), role anything, provider `openrouter`, model `stealth/ox-alpha`, temperature 0.2, save. It appears in the registry (the five built-in templates are there too — they can be duplicated/edited but not deleted).
2. **Start a conversation** — sidebar → **Sessions** → *New session* → pick your agent → type a message (e.g. "Say hello and tell me what you are") → Enter.
3. **Watch it answer** — your message bubbles right, the model replies left, with a `input → output tok` usage line under it. That reply is a **live OpenRouter round trip** through your key — no mocks.
4. **Try an error path** (optional) — create an agent with no provider/model and message it: you get a clear inline error banner (409 CONFLICT) with a Retry button, and your message stays in the transcript.

## What this proves (acceptance mapping)

| Criterion | Proof point |
|---|---|
| App boots with auto-started sidecar | The window + sidecar spawn you just watched |
| SQLite migrations run | First launch created `%APPDATA%\acute-code\acute.db` and seeded the 5 templates |
| Provider live-tested | The reply came from `stealth/ox-alpha` via OpenRouter |
| Agent CRUD UI functional | Step 1 (create; also edit/duplicate/delete on the registry) |
| Single-agent chat round trip | Steps 2–3 |

## Troubleshooting

- Window opens but UI shows demo data → the sidecar didn't spawn; check the terminal output for `[sidecar]` lines.
- 409/502 banner on send → agent has no provider/model (409) or the provider call failed (502 — check your OpenRouter key in Credential Manager: `ACUTE-CODE/provider/openrouter`).
- Closing the window stops the sidecar (graceful shutdown + taskkill fallback) — no orphan `node` processes.
