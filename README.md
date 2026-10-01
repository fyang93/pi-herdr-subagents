# pi-herdr-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running as named agents in [herdr](https://herdr.dev). Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

## How it works

`subagent()` returns as soon as the sub-agent is up. Each sub-agent is a herdr agent in its own pane, without stealing keyboard focus: an unfocused split of the largest pane in the parent's tab, or a background tab when no split leaves both halves at least **50 columns × 15 rows** (`PI_SUBAGENT_MIN_COLUMNS`, `PI_SUBAGENT_MIN_ROWS`). Existing panes are never rearranged, and a zoomed tab always gets a background tab.

- **Start** — `herdr agent start <name> --kind pi` launches pi once the pane's shell is ready, and returns when pi is ready for input; the skills and the task are then submitted with `herdr agent prompt`. The herdr agent name is derived from the display name (`Scout: auth` → `scout-auth`, suffixed when taken).
- **Status** — while sub-agents run, a widget above the input shows each one's elapsed time and state, with the tool a working pi sub-agent is in (read from its session file):

  ```
  ╭─ Subagents ──────────────────────── 2 running ─╮
  │ 01:10  Sleeper (worker)          working · bash │
  │ 00:18  Scout (scout)                    blocked │
  ╰─────────────────────────────────────────────────╯
  ```

  herdr's agents sidebar shows the same sub-agents as working, idle, blocked or done. The extension installs herdr's pi integration (`herdr integration install pi`) on first start inside herdr, so the state comes from pi itself rather than screen detection.
- **Blocked** — when herdr sees an autonomous sub-agent stuck at a confirmation or question dialog, the parent is told once, with the pane to look at.
- **Interrupted** — when someone presses Escape in an autonomous sub-agent's pane, it stays open waiting for input and the parent is told once; `subagent_message` continues it.
- **Completion** — a sub-agent ends when its final turn ends; there is no done tool. On quit it writes `<session>.exit`: `done` after its final turn (or when a human leaves an interactive pane), `quit` when someone ended an autonomous one early (reported as ended early, with its last message), or `error` with the provider's message when its last turn failed. The parent checks that marker and asks herdr whether the agent is still in its pane, once a second. An agent that leaves its pane twice in a row without a marker is reported as interrupted; its pane is left open for inspection. On completion the parent reads the result from the session file, closes the pane and steers the result into the main session.
- **Start failures** — if pi does not come up, the error includes the pane's last lines before the pane is closed. A name another parent took at the same moment is picked again once.
- **Shutdown** — on parent shutdown or `/reload`, tracked sub-agent panes are closed.

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent as a named herdr agent in its own pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and herdr agent. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is submitted as one prompt with `herdr agent prompt` (multi-line kept) and picked up at the next turn boundary; herdr refuses it while the sub-agent waits at a dialog. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the saved loadout.** The optional tool allowlist, model, thinking level, system prompt, spawn whitelist, cwd, and config directory are snapshotted to `<session>.loadout.json`. Resume restores those settings; extensions are discovered from the current configuration, not frozen at spawn time.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openai-codex/gpt-5.6-luna` | `read`, `grep`, `find`, `ls`, `mcp` | Fast read-only codebase recon |
| **researcher** | `openai-codex/gpt-5.6-luna` | `web_search`, `source_check`, `fetch_content`, `get_search_content`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | pi default | `read`, `write`, `edit`, `bash`, `web_search`, `source_check`, `fetch_content`, `get_search_content` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Optional comma-separated tool allowlist, passed as `--tools`. Omit or leave empty for the default full toolset. Extensions load normally in both cases; no tool-to-extension path mapping is needed. `ask_question` is added automatically, as are spawning tools when `subagent_agents` grants delegation |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether a blocked sub-agent wakes the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether a sub-agent blocked at a dialog sends a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents report it; user-driven agents stay quiet (the user is already working in that pane). Set explicitly to override.

## Tool access control

Tool restrictions are **optional**:

- With `tools`: pass `--tools <allowlist>` (including child control tools).
- Without `tools` (or with an empty value): omit `--tools` and use Pi's default full toolset, even when `subagent_agents` is configured.
- In both cases, extensions are discovered normally from the child's configuration; no `--no-extensions` or third-party tool-path mapping is used. Package-local helpers (`ask_question`, `safe_bash`, and delegation support) are still explicitly loaded as needed.

The saved tool allowlist survives resume. It limits model-callable tools, not extension initialization, event hooks, or background tasks; this is not a security sandbox. Only enable extensions that are suitable for running in child processes.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Install and enable tool-providing packages normally, for example `pi install npm:pi-web-access` or `pi install npm:pi-mcp-adapter`. Their tools can then be named in `tools`, without registering extension paths. Older sessions with a saved `web_fetch` allowlist should be replaced by new sessions using `fetch_content`.

Scout allows `mcp` for discovery and single calls; add `mcpScript` if batching is needed. Without the adapter, scout falls back to local file tools. Configure CodeGraph or other servers through the adapter in the child's config/cwd; connections are not inherited from the parent. `mcp:server-name` frontmatter syntax is not supported by this extension. The gateway can access all configured servers: scout's read-only instructions are not an enforced MCP permission boundary. Restrict server operations separately when required.

The old `registerToolExtension(name, path)` hook has been removed; enable the extension in Pi settings instead.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (AGENTS.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← AGENTS.md, .pi/…
    └── sre/             ← AGENTS.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [herdr](https://herdr.dev) 0.9+; start pi inside a herdr pane

Sub-agent sessions show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

## Acknowledgements

This fork builds on [Amos Blomqvist's tmux-only fork](https://github.com/amosblomqvist/pi-interactive-subagents) of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). The original project introduced the subagent architecture; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/). This version runs on herdr only.

## License

MIT
