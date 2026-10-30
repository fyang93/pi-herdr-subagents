/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * automatically when their task settles (see the `agent_settled` handler);
 * interactive agents end when the human exits the pane.
 *
 * `ask_question` keeps the session OPEN: it publishes the question in
 * `${sessionFile}.ask/` for the parent's watcher, auto-exit waits for the answer
 * (`awaitingAnswer`), and the parent replies with subagent_message — which lands
 * as the subagent's next turn.
 */
import { parseFrontmatter, type AgentEndEvent, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findLastAssistantMessage, pendingInboxMessages, publishQuestion, removeConsumedFile } from "./session.ts";

/**
 * Number of child subagents this session itself still has in flight.
 *
 * When this extension is loaded inside a subagent that can spawn its own
 * children (e.g. a worker delegating to scout/researcher), `index.ts` runs in
 * the same process and publishes a live count through a shared process-global
 * symbol. A subagent that spawns children and then writes a "waiting for
 * results" message would otherwise auto-exit the instant that turn ends —
 * killing the session before its children report back. Reading this count lets
 * `agent_settled` keep the session open until every child has finished and its
 * result has been delivered.
 *
 * Returns 0 when the spawning tools aren't loaded (scout/researcher, or a
 * standalone session), so those agents auto-exit exactly as before.
 */
export function runningChildrenCount(): number {
  return (globalThis as any)[Symbol.for("pi-subagents/running-children-count")]?.() ?? 0;
}

type AgentMessage = AgentEndEvent["messages"][number];

/** Pi marks Escape aborts on the assistant message or settled event. */
export function wasAborted(message: AgentMessage | undefined): boolean {
  return message?.role === "assistant" && message.stopReason === "aborted";
}

export interface SubagentErrorInfo {
  errorMessage: string;
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (the settled handler keeps that session open).
 */
export function findLatestAssistantError(
  messages: AgentMessage[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    // An answer cut off at the model's output limit is incomplete, not a result.
    if (msg.stopReason === "length") {
      return { errorMessage: "The answer was cut off at the model's output limit; resume the session to continue it." };
    }
    if (msg.stopReason !== "error" || wasAborted(msg)) return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
    };
  }
  return null;
}

const CHILD_STATE_KEY = Symbol.for("pi-subagents/child-state");

interface ChildState {
  /** An ask_question is unanswered; cleared only when a reply is submitted (`input`), not by a run something else started. */
  awaitingAnswer: boolean;
  /** Skills to load with the first task, so one run has them all; Pi's `/skill:` expands one per prompt. */
  skills: string[];
  /** Entries on every branch before this run; /tree must not turn an old answer into its result. */
  existingEntryIds: Set<string>;
  /** When a task that has started no run is taken as refused; kept across /reload. */
  runDeadline: number | null;
  /** Submitted files whose deletion failed must never be submitted again, including after reload. */
  inboxCleanup: Set<string>;
  /**
   * The inbox file handed to Pi but not yet queued or started: Pi runs input handlers first, and a
   * run settling meanwhile must not end the session. Kept until then, or until its deadline.
   */
  inboxSubmitted: { file: string; deadline: number } | null;
  exitAfterInbox: boolean;
}

/** A loaded skill as Pi's `/skill:name` expansion renders it, or "" when no such skill is loaded. */
function skillBlock(pi: ExtensionAPI, name: string): string {
  const command = pi.getCommands().find((entry) => entry.source === "skill" && entry.name === `skill:${name}`);
  if (!command) return "";
  try {
    const { body } = parseFrontmatter(readFileSync(command.sourceInfo.path, "utf8"));
    return `<skill name="${name}" location="${command.sourceInfo.path}">\nReferences are relative to ${dirname(command.sourceInfo.path)}.\n\n${body.trim()}\n</skill>`;
  } catch {
    return "";
  }
}

/** A task whose prompt starts no run in this long was refused by Pi; it starts one in ms, or s for an OAuth refresh. */
export const RUN_START_TIMEOUT = 30_000;

const newChildState = (entries: SessionEntry[]): ChildState => ({
  awaitingAnswer: false,
  skills: (process.env.PI_SUBAGENT_SKILLS ?? "").split(",").map((name) => name.trim()).filter(Boolean),
  existingEntryIds: new Set(entries.map((entry) => entry.id)),
  runDeadline: null,
  inboxCleanup: new Set(),
  inboxSubmitted: null,
  exitAfterInbox: false,
});

export default function (pi: ExtensionAPI) {
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";

  function renderWidget(ctx: { ui: { setWidget: Function } }) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => ({
        invalidate() {},
        // Rebuilt on every render: tools can arrive later (MCP servers connect, tool_search loads some).
        render(width: number) {
          const tools = pi.getActiveTools().sort();
          const label = subagentAgent || subagentName;
          const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";
          const summary = expanded
            ? `${agentTag}${theme.fg("dim", ` — ${tools.length} available`)}${theme.fg("muted", "  (Ctrl+Alt+O to collapse)")}\n` +
              tools.map((name: string) => theme.fg("dim", name)).join(theme.fg("muted", ", "))
            : `${agentTag}${theme.fg("dim", ` — ${tools.length} tools`)}${theme.fg("muted", "  (Ctrl+Alt+O to expand)")}`;
          const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));
          box.addChild(new Text(summary, 0, 0));
          return box.render(width);
        },
      }),
      { placement: "aboveEditor" },
    );
  }

  const sessionFile = process.env.PI_SUBAGENT_SESSION;
  let messages: AgentMessage[] | undefined;
  // Set when this extension ends the session after a completed final turn.
  let finished = false;
  // A done task found Pi still busy (a manual /compact): it exits when that ends.
  let exitAfterCompaction = false;
  // Kept process-wide so a /reload, which re-runs this factory, does not forget it.
  const state = ((globalThis as any)[CHILD_STATE_KEY] ??= newChildState([])) as ChildState;
  // Why a task never started a run: Pi refuses a prompt without a model or credentials before any.
  let startError: SubagentErrorInfo | null = null;
  let runPending: ReturnType<typeof setTimeout> | undefined;
  let inboxTimer: ReturnType<typeof setInterval> | undefined;

  function processInbox(ctx: ExtensionContext): void {
    // Manual compaction rejects sendUserMessage asynchronously, so leave the inbox untouched.
    if (!sessionFile || finished || (!ctx.isIdle() && !ctx.signal)) return;
    const cleanup = state.inboxCleanup;
    for (const file of cleanup) if (!removeConsumedFile(file, cleanup)) return;
    // Queued, it runs before the session settles; never queued by the deadline, an input handler took it.
    if (state.inboxSubmitted && !ctx.hasPendingMessages() && Date.now() < state.inboxSubmitted.deadline) return;
    inboxTaken();
    let files: string[];
    try { files = pendingInboxMessages(sessionFile); }
    catch (error) { console.warn(`Could not read subagent inbox for ${sessionFile}: ${error}`); return; }
    const file = files[0];
    if (!file) {
      if (state.exitAfterInbox) exitIfDone(ctx);
      return;
    }
    let message: unknown;
    try { message = JSON.parse(readFileSync(file, "utf8"))?.message; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (!(error instanceof SyntaxError)) {
        console.warn(`Could not read subagent inbox file ${file}: ${error}`);
        return;
      }
    }
    if (typeof message !== "string") {
      removeConsumedFile(file, cleanup);
      processInbox(ctx);
      return;
    }
    state.inboxSubmitted = { file, deadline: Date.now() + RUN_START_TIMEOUT };
    try { pi.sendUserMessage(message, { deliverAs: "steer" }); }
    catch { state.inboxSubmitted = null; } // keep it, and retry in order next tick
  }

  /** Pi has taken the submitted inbox message: its file is the parent's receipt. */
  function inboxTaken() {
    const submitted = state.inboxSubmitted;
    state.inboxSubmitted = null;
    if (submitted) removeConsumedFile(submitted.file, state.inboxCleanup);
  }

  /** End an autonomous subagent whose task has started no run by its deadline. */
  function watchRunStart(ctx: ExtensionContext) {
    clearTimeout(runPending);
    if (state.runDeadline === null) return;
    runPending = setTimeout(() => {
      state.runDeadline = null;
      if (finished || !ctx.isIdle()) return;
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
      startError = { errorMessage: `Pi started no run for the task within ${RUN_START_TIMEOUT / 1000} s (${model}); it refuses a prompt when the model has no usable credentials, or none is selected.` };
      shutdown(ctx);
    }, Math.max(0, state.runDeadline - Date.now()));
    runPending.unref(); // Pi's own loop keeps the process alive
  }

  /** This run's entries, on the active branch: after /tree that is not the file's last branch. */
  function runEntries(ctx: ExtensionContext): SessionEntry[] {
    return ctx.sessionManager.getBranch().filter((entry) => !state.existingEntryIds.has(entry.id));
  }

  /**
   * Tell the parent how this run ended, with its answer, which the parent reports as the result.
   * A failed last turn of this run is an error however the session ends, also when a human quits.
   */
  function writeExit(ctx: ExtensionContext) {
    if (!sessionFile) return;
    let summary: string | null = null, errorInfo: SubagentErrorInfo | null = startError;
    try {
      const entries = runEntries(ctx);
      summary = findLastAssistantMessage(entries);
      errorInfo ??= findLatestAssistantError(entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])));
    } catch {} // the parent then reports the run without its answer
    const type = errorInfo ? "error" : finished || !autoExit ? "done" : "quit";
    try { writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type, ...errorInfo, summary }), { mode: 0o600 }); } catch {}
  }

  // Show widget + status bar on session start
  pi.on("session_start", (event, ctx) => {
    messages = undefined;
    finished = false;
    if (event.reason !== "reload") {
      Object.assign(state, newChildState(ctx.sessionManager.getEntries()));
      delete process.env.PI_SUBAGENT_SKILLS;
    }
    if (autoExit) watchRunStart(ctx); // a deadline set before a /reload, with this session's ctx

    renderWidget(ctx);
    if (subagentName) pi.setSessionName(`subagent ${subagentName}`);
    clearInterval(inboxTimer);
    inboxTimer = setInterval(() => processInbox(ctx), 250);
    inboxTimer.unref();
    processInbox(ctx);
  });

  pi.on("input", (event, ctx) => {
    // A submitted message is the orchestrator's (or a human's) reply — the
    // pending ask_question has been answered, however it was delivered. Clear
    // here, not only on agent_start, because a reply steered in *mid-run* is
    // absorbed into the current run (pi's `steer` behavior injects it before
    // the next LLM call): no new agent_start fires, so without this the flag
    // would stay set and settlement would park the session as `waiting` even
    // though the answer already arrived and was consumed. (The `input` event
    // fires for mid-run steers because prompt() emits it before queueing.)
    state.awaitingAnswer = false;
    // Someone is answering or continuing it already: an unsent question or interruption notice is obsolete.
    if (sessionFile) for (const marker of [".ask", ".paused"]) rmSync(sessionFile + marker, { recursive: true, force: true });
    // Pi refuses a prompt without a model or credentials before starting any run, so the task
    // would never settle: an autonomous subagent whose task starts no run ends with an error.
    if (autoExit && !finished && ctx.isIdle()) {
      state.runDeadline = Date.now() + RUN_START_TIMEOUT;
      watchRunStart(ctx);
    }
    // The first task carries the configured skills, expanded as Pi expands `/skill:name`.
    const skills = state.skills.splice(0).map((name) => skillBlock(pi, name)).filter(Boolean);
    if (skills.length) return { action: "transform" as const, text: `${skills.join("\n\n")}\n\n${event.text}`, images: event.images };
  });

  // A run starting, or a prompt being prepared (an extension's before_agent_start), means the
  // task was not refused.
  const runStarting = () => {
    state.runDeadline = null;
    clearTimeout(runPending);
  };
  pi.on("before_agent_start", runStarting);
  // A dialog — one an input handler or before_agent_start opens — waits for a human: it pauses the
  // deadline, which runs again from its close if no run has begun (a declined one may swallow the task).
  pi.on("ui_prompt_start", () => clearTimeout(runPending));
  pi.on("ui_prompt_end", (_event, ctx) => {
    if (state.runDeadline === null) return;
    state.runDeadline = Date.now() + RUN_START_TIMEOUT;
    watchRunStart(ctx);
  });
  pi.on("message_start", (event) => { if (event.message.role === "user") inboxTaken(); });
  pi.on("agent_start", () => {
    runStarting();
    exitAfterCompaction = false;
    state.exitAfterInbox = false;
  });

  // Low-level runs can still be followed by retries, compaction or queued work.
  pi.on("agent_end", (event) => { messages = event.messages; });
  // agent_settled is final: Pi has finished retries, recovery, compaction and queued work.
  pi.on("agent_settled", (event, ctx) => {
    if (!autoExit) return;
    const last = [...(messages ?? [])].reverse().find((m) => m?.role === "assistant");
    if (event.aborted || wasAborted(last)) {
      if (sessionFile) {
        try { writeFileSync(`${sessionFile}.paused`, "{}", { mode: 0o600 }); } catch {}
      }
      return;
    }

    exitIfDone(ctx);
  });
  // A manual /compact runs outside any run: a settle during it waits for it to end. Pi
  // announces the end before it clears its busy state, so look once it has.
  const afterCompaction = (event: { reason: string }, ctx: ExtensionContext) => {
    if (!exitAfterCompaction) return;
    const check = () => {
      if (!exitAfterCompaction) return; // a run started meanwhile; its own settle decides
      if (!ctx.isIdle() && !ctx.signal) return void setTimeout(check, 50).unref();
      exitIfDone(ctx);
    };
    setTimeout(check, 0).unref();
  };
  pi.on("session_compact", afterCompaction);
  pi.on("session_compact_failed", afterCompaction);

  /** End an autonomous subagent whose task is done, once nothing keeps it open. */
  function exitIfDone(ctx: ExtensionContext) {
    exitAfterCompaction = false;
    state.exitAfterInbox = false;
    // A pending answer, unfinished child or unsent draft keeps the session open for the next turn.
    if (finished || state.awaitingAnswer || runningChildrenCount() > 0) return;
    if (sessionFile) {
      try {
        if (pendingInboxMessages(sessionFile).length) {
          state.exitAfterInbox = true;
          return;
        }
      } catch (error) {
        console.warn(`Could not read subagent inbox for ${sessionFile}: ${error}`);
        state.exitAfterInbox = true;
        return;
      }
    }
    if (ctx.hasUI && ctx.ui.getEditorText().trim()) return;
    if (!ctx.isIdle()) {
      exitAfterCompaction = true;
      return;
    }
    shutdown(ctx);
  }

  /**
   * End this session. Pi stops reading input as it shuts down, before the exit marker can be
   * written on quit: say so first, so a message sent meanwhile is not taken for received.
   */
  function shutdown(ctx: ExtensionContext) {
    finished = true;
    if (sessionFile) try { writeFileSync(`${sessionFile}.exiting`, "{}", { mode: 0o600 }); } catch {}
    ctx.shutdown();
  }

  // Sidecars communicate completion/interruption across the child-parent process boundary.
  pi.on("session_shutdown", (event, ctx) => {
    clearTimeout(runPending);
    clearInterval(inboxTimer);
    if (event.reason === "quit" && sessionFile && !existsSync(`${sessionFile}.exit`)) writeExit(ctx);
  });

  // Toggle expand/collapse with Ctrl+Alt+O
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx);
    },
  });

  pi.registerTool({
    name: "ask_question",
    label: "ask_question",
    description:
      "Ask the orchestrator (the parent agent that spawned you) a single question and pause until they reply. " +
      "Use this when requirements are ambiguous, a decision would materially affect your work, you're blocked, " +
      "or you need information or confirmation only the orchestrator has. Prefer asking over guessing. " +
      "Your session stays open while you wait — the answer arrives as your next message, then you continue. " +
      "Ask exactly one question per call; make separate calls for unrelated questions.",
    promptSnippet:
      "Use this tool to ask the orchestrator one clarifying, missing-requirement, preference, or decision question before continuing — instead of guessing.",
    promptGuidelines: [
      "Ask exactly one question per tool call.",
      "If you need answers to multiple things, make separate ask_question calls instead of bundling them.",
      "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
      "Use it when multiple valid paths exist and the right one depends on the orchestrator's intent.",
      "Give enough context in the question that the orchestrator can answer without re-reading your whole task.",
      "After asking, stop and wait — the reply will arrive as your next message.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "The single freeform question to ask the orchestrator. Include enough context to answer it directly.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      if (!params.question.trim()) throw new Error("The question is empty: ask what you need the orchestrator to decide or tell you.");
      // The parent's watcher picks the question up and notifies the orchestrator,
      // who replies via subagent_message.
      publishQuestion(sessionFile, params.question);
      // Only a published question keeps the session open for its answer.
      state.awaitingAnswer = true;

      return {
        content: [
          {
            type: "text",
            text:
              "Question sent to the orchestrator. Stop here and wait — do not continue working or " +
              "assume an answer. Their reply will arrive as your next message.",
          },
        ],
        details: { question: params.question },
      };
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("ask_question ")) +
        theme.fg("muted", String((args as any).question ?? ""));
      return new Text(text, 0, 0);
    },
  });

}
