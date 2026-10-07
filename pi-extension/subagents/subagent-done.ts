/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * automatically when their agent loop ends (see the `agent_end` handler);
 * interactive agents end when the human exits the pane.
 *
 * `ask_question` keeps the session OPEN: it writes a `${sessionFile}.ask`
 * signal the parent's watcher picks up, parks the session in a "waiting" state
 * (auto-exit is suppressed for that turn via `awaitingAnswer`), and the parent
 * replies with subagent_message — which lands as the subagent's next turn.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text, matchesKey } from "@mariozechner/pi-tui";
import { closeOwnPaneOnExit } from "./herdr.ts";
import { Type } from "@sinclair/typebox";
import { existsSync, writeFileSync } from "node:fs";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

/**
 * Number of child subagents this session itself still has in flight.
 *
 * When this extension is loaded inside a subagent that can spawn its own
 * children (e.g. a worker delegating to scout/researcher), `index.ts` runs in
 * the same process and publishes a live count through a shared process-global
 * symbol. A subagent that spawns children and then writes a "waiting for
 * results" message would otherwise auto-exit the instant that turn ends —
 * killing the session before its children report back. Reading this count lets
 * `agent_end` keep the session open until every child has finished and its
 * result has been delivered.
 *
 * Returns 0 when the spawning tools aren't loaded (scout/researcher, or a
 * standalone session), so those agents auto-exit exactly as before.
 */
export function runningChildrenCount(): number {
  const fn = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
  if (typeof fn !== "function") return 0;
  try {
    const n = fn();
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Escape ends a turn as `aborted`, or, when it interrupts a running tool, as
 * `error` with an abort message. pi 0.99 has no structured abort field for the
 * latter, so its message is matched; prefer such a field if pi adds one.
 */
export function wasAborted(message: any): boolean {
  return message?.stopReason === "aborted" ||
    (message?.stopReason === "error" && /operation was aborted|AbortError/i.test(String(message.errorMessage ?? "")));
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return !wasAborted(msg);
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error" || wasAborted(msg)) return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI, options: {
  topLevel?: boolean;
  agent?: () => string;
  autoExit?: () => boolean;
} = {}) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = () => options.autoExit?.() ?? (process.env.PI_SUBAGENT_AUTO_EXIT === "1");

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  // Set when ask_question is called; suppresses auto-exit so the session stays
  // open while it waits for the orchestrator's reply. Cleared when the reply
  // lands — on `input` (covers a reply steered into the current run) and on
  // `agent_start` (covers a reply that starts a fresh turn after parking).
  let awaitingAnswer = false;
  // Set when this extension ends the session after a completed final turn.
  let finished = false;
  let stopWatchingKeys: (() => void) | undefined;
  let exitTick: ReturnType<typeof setTimeout> | undefined;
  let sessionKey: string | undefined;
  let completionMessages: any[] | undefined;
  let completionCandidate = false;
  let compacting = false;
  const TAKEOVER_KEY = Symbol.for("pi-subagents/top-level-takeover");

  function cancelExit() {
    clearTimeout(exitTick);
    exitTick = undefined;
  }

  function finishIfReady(ctx: any) {
    if (!completionCandidate || finished || compacting || !autoExit() || awaitingAnswer || runningChildrenCount() ||
        (options.topLevel && userTookOver) || ctx.ui?.getEditorText?.() ||
        ctx.hasPendingMessages?.() || (ctx.isIdle && !ctx.isIdle())) return;
    const errorInfo = findLatestAssistantError(completionMessages);
    if (options.topLevel && errorInfo) return;
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (errorInfo && sessionFile) {
      try { writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", ...errorInfo })); } catch {}
    }
    finished = true;
    ctx.shutdown();
  }

  // ponytail: delayed idle/compaction checks on old pi; upgrade for agent_settled.
  // New pi cancels this
  // fallback before settlement and requests shutdown synchronously there, so
  // RPC and TUI both observe it at their final lifecycle boundary.
  function scheduleExit(ctx: any) {
    cancelExit();
    exitTick = setTimeout(() => {
      exitTick = undefined;
      if (completionCandidate && ctx.isIdle && !ctx.isIdle()) { scheduleExit(ctx); return; }
      finishIfReady(ctx);
    }, 10);
  }
  pi.on("session_before_compact", () => { compacting = true; cancelExit(); });
  pi.on("session_compact", (_event, ctx) => {
    compacting = false;
    if (completionCandidate) scheduleExit(ctx);
  });
  (pi.on as any)("agent_before_settle", (event: any) => {
    cancelExit();
    if (event.outcome === "aborted" || (options.topLevel && event.outcome === "error")) completionCandidate = false;
  });
  (pi.on as any)("agent_settled", (_event: any, ctx: any) => {
    cancelExit();
    finishIfReady(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    cancelExit();
    stopWatchingKeys?.();
    finished = false;
    completionCandidate = false;
    compacting = false;
    awaitingAnswer = false;
    agentStarted = false;
    sessionKey = ctx.sessionManager?.getSessionFile() ?? ctx.sessionManager?.getSessionId();
    userTookOver = options.topLevel && (globalThis as any)[TAKEOVER_KEY] === sessionKey;
    if (options.topLevel && options.agent?.() && ctx.hasUI && ctx.ui.onTerminalInput) {
      stopWatchingKeys = ctx.ui.onTerminalInput(data => {
        // Ignore terminal replies/mouse/focus reports; observe Escape, typing and paste.
        const text = data.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "").replace(/\x1b\[(?:200|201)~/g, "");
        if (matchesKey(data, "escape") || (agentStarted && /[^\x00-\x1f\x7f]/.test(text))) {
          userTookOver = true;
          (globalThis as any)[TAKEOVER_KEY] = sessionKey;
          cancelExit();
        }
        return undefined;
      });
    }
  });

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    if (options.topLevel) return;
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", (event) => {
    cancelExit();
    completionCandidate = false;
    // A submitted message is the orchestrator's (or a human's) reply — the
    // pending ask_question has been answered, however it was delivered. Clear
    // here, not only on agent_start, because a reply steered in *mid-run* is
    // absorbed into the current run (pi's `steer` behavior injects it before
    // the next LLM call): no new agent_start fires, so without this the flag
    // would stay set and agent_end would park the session as `waiting` even
    // though the answer already arrived and was consumed. (The `input` event
    // fires for mid-run steers because prompt() emits it before queueing.)
    awaitingAnswer = false;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    if (!options.topLevel || event?.source === "interactive") {
      userTookOver = true;
      if (options.topLevel) (globalThis as any)[TAKEOVER_KEY] = sessionKey;
    }
  });

  pi.on("agent_start", () => {
    cancelExit();
    completionCandidate = false;
    compacting = false;
    agentStarted = true;
    // A new turn is starting — any pending ask_question has now been answered
    // (or superseded), so let auto-exit resume normally when this turn ends.
    awaitingAnswer = false;
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    // Never shut down while this session still has work in flight:
    //  - awaitingAnswer: an ask_question is pending the orchestrator's reply.
    //  - runningChildrenCount(): this subagent spawned its own children and is
    //    waiting for their results (delivered as steered turns). Exiting now
    //    would strand those children and drop their results.
    // In both cases the session parks as `waiting` and resumes when the next
    // turn lands.
    const hasPendingChildren = runningChildrenCount() > 0;
    const shouldExit =
      !awaitingAnswer &&
      !hasPendingChildren &&
      autoExit() &&
      !(options.topLevel && userTookOver) &&
      shouldAutoExitOnAgentEnd(userTookOver, messages);

    completionCandidate = shouldExit;
    completionMessages = messages;
    if (shouldExit) {
      scheduleExit(ctx);
      return;
    }

    // Escape stopped an autonomous subagent mid-turn: it waits for input, so tell the parent.
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    const last = [...(messages ?? [])].reverse().find((m) => m?.role === "assistant");
    if (options.topLevel && wasAborted(last)) {
      userTookOver = true;
      (globalThis as any)[TAKEOVER_KEY] = sessionKey;
    }
    if (autoExit() && sessionFile && wasAborted(last)) {
      try { writeFileSync(`${sessionFile}.paused`, "{}"); } catch {}
    }

    if (autoExit() && !options.topLevel) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  // The parent learns how this session ended from `${sessionFile}.exit`: an
  // error marker written above, `done` when the work finished (an autonomous
  // agent's final turn, or a human leaving an interactive pane), or `quit` when
  // someone ended an autonomous agent early. A crash leaves no marker.
  pi.on("session_shutdown", (event) => {
    cancelExit();
    stopWatchingKeys?.();
    stopWatchingKeys = undefined;
    if (options.topLevel) {
      if (finished && (event as any).reason === "quit") closeOwnPaneOnExit();
      if ((event as any).reason !== "reload" && (globalThis as any)[TAKEOVER_KEY] === sessionKey) delete (globalThis as any)[TAKEOVER_KEY];
      return;
    }
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if ((event as any).reason !== "quit" || !sessionFile || existsSync(`${sessionFile}.exit`)) return;
    const type = finished || !autoExit() ? "done" : "quit";
    try { writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type })); } catch {}
  });

  if (options.topLevel) return;

  // Toggle expand/collapse with Ctrl+Alt+O
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
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
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      // Keep the session open: suppress auto-exit for this turn and park in the
      // "waiting" phase. The parent's watcher picks up the `.ask` signal and
      // notifies the orchestrator, who replies via subagent_message.
      awaitingAnswer = true;
      const askData = {
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        agent: process.env.PI_SUBAGENT_AGENT ?? "",
        question: params.question,
      };
      writeFileSync(`${sessionFile}.ask`, JSON.stringify(askData));

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
