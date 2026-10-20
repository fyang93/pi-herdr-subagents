# pi-herdr-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running as named agents in [herdr](https://herdr.dev). Spawn a sub-agent, keep working, and get its result steered back automatically. Multiple sub-agents run concurrently in their own panes without stealing keyboard focus.

## Install and requirements

```sh
pi install git:github.com/fyang93/pi-herdr-subagents
```

Requires **pi 1.1.0+**, **Node.js 22.19+** and **herdr 0.9+**. Start pi inside a herdr pane (`herdr`, then `pi`). The extension installs herdr's Pi integration on first use; restart the parent if prompted. Children load it explicitly, even when settings exclude it, using their config directory's copy or the default `~/.pi/agent` copy. Launch fails if the integration is unavailable: restart recovery needs its session reports. To install it manually, run `herdr integration install pi`.

## Tools

| Tool | Parameters | Behaviour |
| --- | --- | --- |
| `subagent` | See below | Spawn asynchronously; return when ready, deliver the result later |
| `subagent_message` | `name`, `message` (strings, required) | Steer a running child or resume a finished session |
| `subagents_list` | None | List available agent profiles |
| `ask_question` | `question` (non-empty string, required) | Child sessions only: ask the orchestrator and wait for its reply |

The `/subagent <agent> <task>` shortcut asks the parent model to make a `subagent` call.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `agent` | string | required | Known, permitted agent profile |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name: one line, 1–64 characters, no control characters. Whitespace is trimmed; blank uses the agent name. Quotes and backslashes are allowed. Duplicates get suffixes (`scout-2`, …), shortening the base if needed; existing names remain addressable |
| `model` | string | profile's model, else parent's current model | Launch override. Thinking is inherited if the profile omits it. Resume restores model/thinking from the session |
| `cwd` | string | profile's `cwd`, else caller's directory | Working directory; see [Role folders](#role-folders) |

### Messaging and resume

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

Address children **by their exact returned name**, not session id. Names persist after completion and across parent restarts. Child sessions appear as `subagent <name>` in Pi's `/resume` list.

- **Running:** multi-line messages reach the child regardless of pane moves, as a steer when busy or a new prompt when idle. The tool waits until Pi takes the message. If the child is exiting or leaves it unread, the tool waits for its result, then resumes with that message. Escape cancels the wait, not supervision or an already-published message; completion still arrives later.
- **Finished:** resume is fire-and-forget, always autonomous, with the original name and a later result. Conversation, model and thinking come from Pi's saved session. The saved loadout restores identity, tool selection, spawn whitelist, cwd and config directory; the original profile file is not needed. A plain tool allowlist stays fixed; relative selectors or defaults use Pi's current defaults. Extensions come from current configuration.
- **Refused:** unknown name (the error lists known names), missing session, missing loadout snapshot, or a child still starting. A live child lost during a parent restart is adopted and steered, never started twice on the same transcript.

Name mappings live in `artifacts/<sessionId>/subagent-registry.json`; each nested spawner has its own registry. Loadouts live in `<session>.loadout.json`.

### Questions

`ask_question` asks one freeform question per call when requirements are ambiguous or a decision matters. The parent is notified with the child's name and replies using `subagent_message`. The child stays open until answered; a mid-turn reply is absorbed into that turn. Parallel questions are independent, and multiple pending questions from one child arrive together in order. Questions survive a child `/reload`; input typed in its pane also answers them. Without a reply, the pane stays open until a human closes it.

## Agent profiles

Place `.md` files in project `.pi/agents/` or global `~/.pi/agent/agents/`. Discovery priority is **project > global > package-bundled**; matching names override lower-priority profiles.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: "+codemode"
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Profile name used by `agent` |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Launch default; omitted inherits the parent's current model |
| `thinking` | string | Pi level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Applies with or without `model`; omitted inherits the parent's level on launch |
| `tools` | string or string[] | Plain names (`read,bash,codemode`) are a strict allowlist; `+name`/`-name` selectors (`"+codemode -bash"` or `[+codemode, -bash]`) modify defaults in order and retain extension tools. Mixing forms (`read,-bash`) is rejected at spawn. Empty/omitted uses defaults. `ask_question` and permitted spawning tools are added automatically |
| `subagent_agents` | string | Comma-separated profiles the child may spawn. A non-empty list grants `subagent`, `subagent_message`, `subagents_list` and restricts targets; empty/omitted denies spawning. An agent cannot spawn its own profile, even if listed |
| `skills` | string | Comma-separated skill names (also `skill:`); all load with the first task, in one run |
| `session-mode` | string | `standalone` (default): fresh, unlinked session. `lineage-only`: fresh with `parentSession` linkage for discovery/fork UX, no copied turns. `fork`: copy the caller's active branch up to the assistant message making the spawn call, not an abandoned `/tree` branch |
| `system-prompt` | string | `append` or `replace`: body becomes the child's system identity. Append also includes the `APPEND_SYSTEM.md` Pi would discover: the role folder's when present and trusted, otherwise the global file. Omitted: prepend the body to the task instead |
| `auto-exit` | boolean | Shut down automatically after settled work; recommended for autonomous profiles. See below |
| `interactive` | boolean | Suppress blocked-dialog notifications when true; default is the inverse of `auto-exit`. Set explicitly to override |
| `cwd` | string | Default working directory; see [Role folders](#role-folders) |
| `disable-model-invocation` | boolean | Hide from `subagents_list`, but allow explicit spawning |

### Auto-exit

With `auto-exit: true`, write a final answer and stop; there is no done tool. Exit waits for automatic retries, compaction (including manual `/compact`) and queued continuations. The summary is the last assistant answer on the active branch, including earlier replies since the last user input when an extension started another run.

Submitted human or orchestrator input is more work and can finish normally. Escape/abort, an unsent editor draft, an unanswered `ask_question`, or unfinished child sub-agents keep the session open. A later submitted task can complete normally. Terminal provider errors exit only after settlement, not during transient retries.

## Bundled agents

| Agent | Model | Tools | Role |
| --- | --- | --- | --- |
| **scout** | `openai/gpt-5.6-luna` | `read,grep,find,ls,codemode` | Fast read-only codebase recon |
| **researcher** | `openai/gpt-5.6-luna` | Defaults − `edit`, `write` + `codemode` | Web research, synthesized into a sourced brief |
| **worker** | parent's current model | Defaults + `codemode` + spawning | General implementer; may spawn `scout` and `researcher` |

All three use `auto-exit: true` and `system-prompt: append`.

## Role folders

`cwd` sets only the start directory. Pi loads its `AGENTS.md` and trusted project `.pi/` resources (skills, extensions, settings, `APPEND_SYSTEM.md`). The config directory (`PI_CODING_AGENT_DIR`) stays the parent's, so global extensions and herdr's integration still load.

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

The tool's `cwd` is relative to the caller; frontmatter `cwd` is relative to the Pi config directory (`~/.pi/agent` by default). Use an absolute frontmatter path for a project folder.

## Tool access and extensions

Tool restrictions are optional and **not a security sandbox**. `tools` becomes one `--tools` selection; required child tools use the same form. Without it, Pi's configured defaults apply even when spawning is allowed. Unknown allowlist names are ignored. `-name` removes a default tool, but extensions that register active tools (such as web or chat-push tools) remain available; use plain names to exclude them.

Every spawn, at every depth, must name a known profile. Top-level sessions may spawn any discoverable profile; children are limited to `subagent_agents` (enforced through `PI_SUBAGENT_ALLOWED`). Omitting `agent` cannot bypass this. Saved tool selection survives resume, but controls declarations, not extension initialization, hooks, background tasks or all indirect MCP access. Enable only extensions suitable for child processes.

Install tool packages normally, e.g. `pi install npm:pi-web-access`. Prefer modifiers for roles that should retain extension tools: `tools: -edit,-write,+codemode` keeps web tools available without listing each one; pi-web-access may expose `web_enable` first to activate them on demand. Use a plain allowlist when intentionally restricting tool declarations, as Scout does with `tools: read,grep,find,ls,codemode`. Do not list `ask_question`; this extension adds it automatically. Replace older sessions whose saved allowlist uses `web_fetch` with new sessions using `fetch_content`. The removed `registerToolExtension(name, path)` hook is replaced by enabling extensions in Pi settings.

Scout can discover native MCP tools with `tool_search` or codemode's `searchTools()` / `describeNamespace()`, then call directly or via codemode (including batches). Configure servers in `~/.pi/agent/mcp.json` or trusted project `.pi/mcp.json`; children connect according to that configuration and tool exposure (`direct`, `deferred`, `codemode`). No `mcp`/`mcpScript` adapter is needed. Read-only profile instructions do not enforce MCP permissions; restrict server operations separately.

New sidecars (loadout, identity, registry, questions, inbox and markers) use `0600`, new directories `0700`; existing paths are not chmodded. This protects local files, not tool access or the provider's copy of a prompt.

## How it works

- **Panes:** split the caller's current pane without focus, or use a background tab if either half would be under **80 columns × 24 rows** (readability-first default) (`PI_SUBAGENT_MIN_COLUMNS`, `PI_SUBAGENT_MIN_ROWS`) or the tab is zoomed. Other panes are never rearranged. Herdr names derive from display names (`Scout: auth` → `scout-auth`) and get suffixes when taken.
- **Delivery:** publish tasks only after Pi is ready. Children take inbox messages in order and delete files when Pi accepts them. Resume clears stale markers and inbox files; a waiting messaging tool reclaims its unread message before resuming.
- **Status:** the theme-aware widget shows elapsed time, profile, state and last tool (parallel calls may still have another tool running). Herdr's sidebar shows working, idle, blocked or done. Tracking follows pane moves; a replacement with a different reported session is never adopted, reported or closed. A missing session report alone is not a mismatch.
- **Attention:** autonomous children notify the parent once when blocked at a dialog or interrupted by Escape; their panes stay open. Use `subagent_message` to continue an interrupted child. Interactive children suppress blocked notices by default.
- **Completion:** `<session>.exit` reports `done` after final work or a human's interactive exit, early `quit` for an autonomous child, or `error`, with the active-branch answer. Provider failures and output-limit truncation report an error with any partial answer. Usage comes from the session. Allow Pi's shutdown up to 30 seconds, close the pane, then deliver the result. Missing completion markers mean interruption; leave the pane open for inspection. Notices wait for a parent prompt being prepared and survive cleared queues: after Escape they are appended without starting a turn, otherwise steered again.
- **Failures:** startup errors include recent pane output before cleanup. Answer startup dialogs (such as folder trust) by running pi there once. An autonomous task that starts no run within 30 seconds (such as missing model/credentials) fails instead of hanging; prompt preparation cancels that deadline and extension dialogs pause it. Failed pane closes are retried and unresolved panes reported. A concurrent name collision is retried once; only layout inspection and pane creation are serialized.
- **Shutdown:** parent exit or `/new`, `/resume`, `/fork` closes tracked panes, including starts in progress. `/reload` instead keeps children running and hands their results to the reloaded extension, including completions during reload.

Child tools widgets toggle with `Ctrl+Alt+O`; completion messages expand with `Ctrl+O`.

## Development

```sh
npm ci --ignore-scripts
npm test              # isolated stub herdr; no inherited subagent environment
npm run test:runtime  # local Pi 1.1.0, localhost simulated model
npm run test:e2e      # separate private herdr server; no working panes touched
```

Runtime TUI tests require util-linux `script`; RPC and TUI cases verify natural auto-exit. E2E uses scripted local responses to check session tracking, messaging and pane cleanup without real model credentials.

## Acknowledgements

Based on [Amos Blomqvist's tmux fork](https://github.com/amosblomqvist/pi-interactive-subagents) of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). The original introduced the subagent architecture; supervision was inspired by [RepoPrompt](https://repoprompt.com/). This fork uses herdr only.

## License

MIT
