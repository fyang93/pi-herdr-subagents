/** How subagents look in the parent: tool calls and results, their messages, and the running-subagents widget. */
import { keyHint, type ExtensionAPI, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Text, TruncatedText, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { NO_AGENTS } from "./agents.ts";
import { currentTool, type SessionStats } from "./session.ts";

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
export function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * Build the dim usage line for a completed subagent, mirroring the format of
 * the in-process subagents extension: "↑in ↓out R… W… $cost · ctx".
 * `theme.fg` is applied by the caller; this returns plain segments joined.
 */
export function formatUsageSegments(stats: SessionStats): string[] {
  const segs: string[] = [];
  if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
  return segs;
}

function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Right-hand label: herdr's state, plus the tool a working pi subagent is in. */
function widgetStatus(running: WidgetAgent, theme: Pick<Theme, "fg">): string {
  const status = running.status ?? "starting";
  if (status === "blocked") return theme.fg("error", status);
  if (status !== "working") return theme.fg("dim", status);
  const tool = currentTool(running.sessionFile);
  return theme.fg("warning", "working") + (tool ? ` · ${tool}` : "");
}

/** One bordered line per running subagent: elapsed, name (agent), state. */
export function renderSubagentWidgetLines(agents: WidgetAgent[], width: number, theme: Pick<Theme, "fg">, now = Date.now()): string[] {
  if (width < 4) return [];
  const inner = width - 2;
  const title = `─ Subagents `;
  const info = ` ${agents.length} running ─`;
  const top = title.length + info.length <= inner
    ? `${title}${"─".repeat(inner - title.length - info.length)}${info}`
    : "─".repeat(inner);
  const lines = [theme.fg("accent", `╭${top}╮`)];
  for (const agent of agents) {
    const right = ` ${widgetStatus(agent, theme)} `;
    const left = truncateToWidth(` ${formatClock(now - agent.startTime)}  ${agent.name}${agent.agent ? ` (${agent.agent})` : ""}`,
      Math.max(0, inner - visibleWidth(right)));
    const row = truncateToWidth(left + " ".repeat(Math.max(0, inner - visibleWidth(left) - visibleWidth(right))) + right, inner);
    lines.push(theme.fg("accent", "│") + row + " ".repeat(Math.max(0, inner - visibleWidth(row))) + theme.fg("accent", "│"));
  }
  lines.push(theme.fg("accent", `╰${"─".repeat(inner)}╯`));
  return lines;
}

/** What the running-subagents widget shows of each subagent. */
export interface WidgetAgent {
  name: string;
  agent?: string;
  startTime: number;
  /** Last herdr status; none yet while it starts. */
  status?: string;
  sessionFile: string;
}

export const spawnRenderers: ToolRenderers = {
  renderCall(args, theme) {
    const partialArgs = args as Record<string, unknown>;
    const agentName =
      typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
    const name =
      typeof partialArgs.name === "string" && partialArgs.name
        ? partialArgs.name
        : agentName || "(unnamed)";
    const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
    // Only show the agent tag separately when a distinct name was given.
    const agent =
      agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
    const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
      ? theme.fg("dim", ` in ${partialArgs.cwd}`)
      : "";
    let text =
      "○ " +
      theme.fg("toolTitle", theme.bold(name)) +
      agent +
      cwdHint;

    // Show a one-line task preview. renderCall is called repeatedly as the
    // LLM generates tool arguments, so args.task grows token by token.
    // We keep it compact here — Ctrl+O on renderResult expands the full content.
    if (task) {
      const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
      const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
      if (preview) {
        text += "\n" + theme.fg("toolOutput", preview);
      }
      const totalLines = task.split("\n").length;
      if (totalLines > 1) {
        text += theme.fg("muted", ` (${totalLines} lines)`);
      }
    }

    return new Text(text, 0, 0);
  },

  renderResult(result, _opts, theme) {
    const details = result.details as any;
    const name = details?.name ?? "(unnamed)";

    // "Started" result — tool returned immediately
    if (details?.status === "started") {
      return new Text(
        theme.fg("accent", "●") +
          " " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — started"),
        0,
        0,
      );
    }

    // Validation or launch error
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    return new Text(theme.fg("dim", text), 0, 0);
  },
};

export const listRenderers: ToolRenderers = {
  renderResult(result, _opts, theme) {
    const details = result.details as any;
    const agents = details?.agents ?? [];
    if (agents.length === 0) return new Text(theme.fg("dim", NO_AGENTS), 0, 0);
    const lines = agents.map((a: any) => {
      const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
      const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
      const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
      return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
    });
    return new Text(lines.join("\n"), 0, 0);
  },
};

export const messageRenderers: ToolRenderers = {
  renderCall(args, theme) {
    const target = (args as { name?: string }).name ?? "(unknown)";
    return new Text(
      "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
      0,
      0,
    );
  },

  renderResult(result, _opts, theme) {
    const details = result.details as any;

    if (details?.status === "steered") {
      return new Text(
        theme.fg("success", "✓") +
          " " +
          theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
          theme.fg("dim", " — message delivered"),
        0,
        0,
      );
    }

    if (details?.status === "started") {
      return new Text(
        theme.fg("accent", "●") +
          " " +
          theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
          theme.fg("dim", " — resumed"),
        0,
        0,
      );
    }

    // Fallback / error
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    return new Text(theme.fg("dim", text), 0, 0);
  },
};

/** Renderers for the results, status notices and questions steered into the parent. */
export function registerMessageRenderers(pi: ExtensionAPI): void {
  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
        const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

        // Success: icon already conveys "completed", so show "N tools · duration"
        // like the in-process extension. Failure: surface the failure reason.
        let header: string;
        if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : details.endedEarly ? "ended early" : `failed (exit ${exitCode})`;
          header = `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${titleSegment}${theme.fg("dim", toolPart)}`;
        }

        // Usage line: ↑in ↓out R… W… $cost · context-gauge (color-coded by %).
        let usageLine: string | null = null;
        if (stats) {
          const segs = formatUsageSegments(stats).map((s) => theme.fg("dim", s));
          if (stats.contextTokens > 0) {
            const window = stats.contextWindow;
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            const coloredCtx =
              pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
            segs.push(coloredCtx);
          }
          if (segs.length > 0) usageLine = segs.join(theme.fg("dim", " "));
        }

        // Older session messages predate the summary field.
        const summary = details.summary ?? (typeof message.content === "string" ? message.content : "")
          .replace(/\n\n(If more work is needed, f|F)ollow up with subagent_message[\s\S]+$/, "")
          .replace(/^Sub-agent "[^\n]*\n\n/, "");

        // Build content for the box
        const contentLines = [header];
        if (usageLine) contentLines.push(usageLine);
        // The provider's error, which a partial answer in the summary would otherwise hide.
        if (errorMessage && !summary.includes(errorMessage)) contentLines.push(theme.fg("error", `Error: ${errorMessage}`));

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) contentLines.push(summary);
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) {
              contentLines.push(
                theme.fg(
                  "dim",
                  `Follow up:  subagent_message({ name: ${JSON.stringify(details.name)}, message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
            }
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", truncateToWidth(line, Math.max(0, width - 2))));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return box.render(width);
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, _options, theme) => {
    const details = message.details as any;
    const line = details?.line ?? details?.lines?.join("\n");
    if (!line) return undefined;

    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    box.addChild(new Text(
      `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}\n${theme.fg("dim", line)}`,
      0, 0,
    ));
    return box;
  });

  // ── subagent_question message renderer ──
  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    const name = details.name ?? "subagent";
    const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
    const box = new Box(1, 1, (text: string) => theme.bg("toolSuccessBg", text));
    box.addChild(new Text(
      `${theme.fg("accent", "?")} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks a question")}`,
      0, 0,
    ));
    if (options.expanded) {
      box.addChild(new Text(
        `\n${details.question ?? ""}\n\n${theme.fg("dim", `Reply: subagent_message({ name: ${JSON.stringify(name)}, message: "…" })`)}`,
        0, 0,
      ));
    } else {
      box.addChild(new TruncatedText(theme.fg("dim", (details.question ?? "").split("\n")[0])));
      box.addChild(new Text(theme.fg("muted", keyHint("app.tools.expand", "to expand")), 0, 0));
    }
    return box;
  });
}
