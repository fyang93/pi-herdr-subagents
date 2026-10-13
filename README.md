# pi-herdr-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running as named agents in [herdr](https://herdr.dev). Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

## How it works

`subagent()` returns as soon as the sub-agent is up. Each sub-agent is a herdr agent in its own pane, without stealing keyboard focus: an unfocused split of the parent's own pane, or a background tab when splitting it would leave either half under **50 columns × 15 rows** (`PI_SUBAGENT_MIN_COLUMNS`, `PI_SUBAGENT_MIN_ROWS`). Other panes are never split or rearranged, and a zoomed tab always gets a background tab.

- **Start** — `herdr agent start <name> --kind pi` launches pi once the pane's shell is ready, and returns when pi is ready for input; the task is then submitted with `herdr agent prompt`, and the sub-agent's helper loads all its configured skills into that first prompt (Pi's `/skill:` expands one per prompt), so one run has them all. The herdr agent name is derived from the display name (`Scout: auth` → `scout-auth`, suffixed when taken).
- **Status** — while sub-agents run, a widget above the input shows each one's elapsed time and state, with the last tool a working pi sub-agent called (read from its session file; with parallel calls, not necessarily the one still running):

  ```
  ╭─ Subagents ──────────────────────── 2 running ─╮
  │ 01:10  Sleeper (worker)          working · bash │
  │ 00:18  Scout (scout)                    blocked │
  ╰─────────────────────────────────────────────────╯
  ```

  herdr's agents sidebar shows the same sub-agents as working, idle, blocked or done. Sub-agents are tracked by their herdr agent name, which follows the agent when its pane is moved (a pane id does not). The extension installs herdr's pi integration (`herdr integration install pi`) on first start inside herdr, so the state comes from pi itself rather than screen detection. herdr installs it in the default config directory (`~/.pi/agent`); every sub-agent loads it explicitly (its config dir's own copy if it has one), so settings cannot exclude it, since its reported session is also what lets a restarted parent find a sub-agent still running. Without the integration a launch fails rather than start a sub-agent that a restart could not find.
- **Blocked** — when herdr sees an autonomous sub-agent stuck at a confirmation or question dialog, the parent is told once, with the pane to look at.
- **Interrupted** — when someone presses Escape in an autonomous sub-agent's pane, it stays open waiting for input and the parent is told once; `subagent_message` continues it.
- **Completion** — a sub-agent ends when its task settles, after Pi's automatic retries, compaction and queued continuations; there is no done tool. On quit it writes `<session>.exit`: `done` after its final turn (or when a human leaves an interactive pane), `quit` when someone ended an autonomous one early (reported as ended early, with its last message), or `error` with the provider's message when its last turn failed — or was cut off at the model's output limit, keeping the partial answer. The marker carries the run's final answer, which the sub-agent reads from its active branch (after `/tree` or a session switch in its pane, that is not the file's last branch). The parent checks that marker once a second and follows herdr status/exit events for its pane over a socket subscription, with a safety reconcile every 15 seconds (once-a-second polling if the subscription is unavailable). An agent that leaves its pane twice in a row without a marker is reported as interrupted; its pane is left open for inspection. On completion the parent takes the answer from the marker and usage stats from the session file, waits until herdr reports pi gone (at most 30 seconds), so other extensions finish their own shutdown, closes the pane and steers the result into the main session. A notice that arrives while the parent prepares a prompt the user just submitted waits for that prompt's run, which a competing run would make Pi reject; if one already started while earlier extensions' input handlers ran, the prompt is steered into it instead. Results, questions and status notices are kept until they enter the parent's conversation: if Pi's queue is cleared before then, they are sent again once that run ends — appended without starting a new turn after Escape, steered as before after editing queued input. An autonomous sub-agent writes `<session>.exiting` before it shuts down, since Pi stops reading input then; a message sent from that moment on, or one herdr can no longer deliver to pi, waits for the result and then resumes the session — unless the sub-agent's receipt shows it took the message first, so a message never runs twice. Each message goes with a one-line delivery envelope, which the sub-agent's helper removes before Pi reads it and records, by id, in `<session>.inputs`.
- **Start failures** — if pi does not come up, the error includes the pane's last lines before the pane is closed, also when pi waits at a startup dialog such as trusting the folder (answer it by running pi there once). A pane that will not close is retried, and named in the error. An autonomous sub-agent whose task starts no run within 30 seconds — Pi refuses a prompt without a model or credentials before starting one — ends with an error rather than waiting; preparing a run does not count as refused, and a dialog an extension opens pauses the 30 seconds until it closes. A name another parent took at the same moment is picked again once. Launches are serialized only while they inspect the layout and open their pane.
- **Shutdown** — on parent shutdown or a session switch (`/new`, `/resume`, `/fork`), tracked sub-agent panes are closed, including ones still starting, before the parent goes on. A close that fails is retried; a pane that still cannot be closed is reported, since its sub-agent may keep working. `/reload` hands running sub-agents to the reloaded extension instead: they keep working in their panes, and their results arrive as usual — including one that finished during the reload.

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent as a named herdr agent in its own pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` shortcut, which asks the parent model to make that `subagent` call. Pane creation queries `herdr pane current --current`, so moved callers use their current pane and workspace rather than inherited ids.

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

- **Running** — the display name selects the tracked child, and the message is submitted with `herdr agent prompt` (multi-line kept) to its herdr agent name, which follows it across pane moves. The message is picked up at the next turn boundary; herdr refuses it while the sub-agent waits at a dialog. The call returns once the sub-agent's receipt names the message — at once, normally — or, if it finished without reading it, after resuming it with the message; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error if the name isn't registered (listing the known names), the session file is gone, or the session has no loadout snapshot (it predates sandboxed resume); a sub-agent still starting is not messaged until it has started. The original agent profile file is not required for resume. A subagent that is still running is steered instead of resumed, even one the parent lost track of when it restarted: herdr reports which pi agent runs the session file, and the parent takes it back.

**Resume replays the saved loadout.** Pi restores conversation, model and thinking from the native session, but rebuilds the system prompt and tool set from the current CLI flags and patches the session to match — a bare `--session` resume would drop the agent's identity and tool restriction. So at spawn the tool selection, system prompt, spawn whitelist, cwd and config directory are snapshotted to `<session>.loadout.json`, and resume replays them (the model is left to the session, so a later model switch survives). A plain tool allowlist is fixed; a `+name`/`-name` selection, or none, applies to Pi's defaults at resume time. Extensions are discovered from the current configuration, not frozen at spawn time.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open**, awaiting the reply, instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name; each question is its own file in `<session>.ask/`, and those a sub-agent asks before the parent picks them up are delivered together, in order. A pending question survives a `/reload` in the sub-agent's pane, and input typed there answers it.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openai-codex/gpt-5.6-luna` | Default tools − `bash`, `edit`, `write` + `grep`, `find`, `ls`, `codemode` | Fast read-only codebase recon |
| **researcher** | `openai-codex/gpt-5.6-luna` | Default tools − `edit`, `write` + `codemode` | Web research, synthesized into a sourced brief |
| **worker** | pi default | Default tools + `codemode` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

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
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | Pi thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), passed as `--thinking`, so it applies with or without `model` |
| `tools` | string or string[] | Pi tool selection, in exactly one of two forms: plain names such as `read,bash,codemode` are an allowlist that replaces the defaults; `+name`/`-name` selectors such as `"+codemode -bash"` or `[+codemode, -bash]` modify them. **The two forms cannot be mixed**: a list like `read,-bash` is rejected when the sub-agent is spawned, as Pi itself rejects it. Omit or leave empty for defaults. `ask_question` and permitted spawning tools are enabled automatically |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **A non-empty list grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list; an agent never spawns its own profile, even when listed. Omit it, or leave it empty, and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. In append mode the `APPEND_SYSTEM.md` Pi would load is passed too, since the flag replaces that discovery: the role folder's own when Pi has the folder recorded as trusted, else the global one. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether a blocked sub-agent wakes the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context: the active branch (after `/tree`, not the file's last branch), up to the assistant message that makes the spawning call

### auto-exit

With `auto-exit: true`, the session shuts down after Pi emits `agent_settled`, when no automatic retry, compaction or queued continuation remains (a manual `/compact` in its pane is waited for) — the agent just writes its final message and stops (there is no "done" tool). Its final answer becomes the summary returned to the parent: the last assistant message on its active branch, together with any earlier replies since the last user input when an extension message started another run after it. Recommended for all autonomous agents.

Notes:

- **Submitted input is more work.** A human or orchestrator's submitted task can finish and auto-exit normally. Escape/abort or an unsent editor draft keeps the session open; a later submitted task can complete normally.
- **Terminal provider errors exit only after settlement**, so transient errors do not interrupt automatic retries.
- **Auto-exit is suppressed while work is in flight:** the session stays open instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether a sub-agent blocked at a dialog sends a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents report it; user-driven agents stay quiet (the user is already working in that pane). Set explicitly to override.

## Tool access control

Tool restrictions are **optional**:

- With `tools`: pass Pi's tool selection to a single `--tools`. Relative selectors such as `+codemode,-bash` modify defaults; plain names form an allowlist; one list must use only one form. Required child tools are added using the same form. A `-name` selector removes a tool from Pi's default selection; extension tools that register themselves active (for example web or chat-push tools) stay available, so a role that must not reach them needs plain names. Unknown names in an allowlist are ignored.
- Without `tools` (or with an empty value): omit `--tools` and use Pi's configured defaults, even when `subagent_agents` is configured.
- In both cases, extensions are discovered normally from the child's configuration; no `--no-extensions` or third-party tool-path mapping is used. Package-local helpers (`ask_question` and delegation support) are still explicitly loaded as needed.

The saved tool allowlist survives resume. It controls tool declarations, not extension initialization, event hooks, background tasks or all indirect MCP access; this is not a security sandbox. Only enable extensions that are suitable for running in child processes.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Install and enable additional tool-providing packages normally, for example `pi install npm:pi-web-access`. Their tools can then be selected in `tools`, without registering extension paths. Older sessions with a saved `web_fetch` allowlist should be replaced by new sessions using `fetch_content`.

Scout can use Pi's native MCP servers and tools when available: discover tools with `tool_search` or `codemode`'s `searchTools()` / `describeNamespace()`, then call them directly or through `codemode` (which also supports batching). Configure servers in Pi's `~/.pi/agent/mcp.json` or trusted project `.pi/mcp.json`; servers are connected in the child's session according to that configuration. MCP tools are available according to their exposure (`direct`, `deferred`, or `codemode`); no adapter `mcp`/`mcpScript` gateway is required. Scout's read-only instructions are not an enforced MCP permission boundary; restrict server operations separately when required.

The old `registerToolExtension(name, path)` hook has been removed; enable the extension in Pi settings instead.

## Role folders

`cwd` only sets the directory a sub-agent starts in. Pi itself loads that directory's `AGENTS.md` and trusted project `.pi/` (skills, extensions, settings, `APPEND_SYSTEM.md`), so role-specific setups apply. The Pi config directory (`PI_CODING_AGENT_DIR`) stays the parent's, so your global extensions load, and herdr's Pi integration with them:

```
project/
└── agents/
    ├── game-designer/   ← AGENTS.md, .pi/…
    └── sre/             ← AGENTS.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter. The two use different bases: the `cwd` parameter is relative to the caller's working directory, while frontmatter `cwd` is relative to the Pi config directory (`~/.pi/agent` by default) — use an absolute path for a project folder.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) 1.1.0+ and Node.js 22.19+
- [herdr](https://herdr.dev) 0.9+; start pi inside a herdr pane

Sub-agent sessions show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

## Development

```sh
npm ci --ignore-scripts
npm test              # isolated: a stub herdr, no inherited subagent environment
npm run test:runtime
npm run test:e2e  # inside herdr; uses a separate private server
```

Runtime tests use the local Pi 1.1.0 CLI and a localhost simulated model, without real model credentials or herdr panes. The TUI cases require util-linux `script`. The sub-agent helper requests shutdown while Pi forwards `agent_settled`, so both RPC and TUI cases check that pi exits by itself. The herdr end-to-end test uses an isolated named server and scripted local responses to verify session-based tracking, messaging and pane cleanup without touching working panes.

## Acknowledgements

This fork builds on [Amos Blomqvist's tmux-only fork](https://github.com/amosblomqvist/pi-interactive-subagents) of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). The original project introduced the subagent architecture; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/). This version runs on herdr only.

## License

MIT
