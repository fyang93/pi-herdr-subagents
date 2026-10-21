import "./isolate.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, chmodSync, cpSync, symlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, parseSessionEntries, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { setTimeout as delay } from "node:timers/promises";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

import {
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  writeSubagentLoadout,
  loadoutSidecarPath,
  type SubagentLoadout,
  registryEntry,
  nameRegistryPath,
  pendingQuestions,
  pendingInboxMessages,
  publishInboxMessage,
  publishQuestion,
  findLastAssistantMessage,
  seedSubagentSessionFile,
  summarizeSessionStats,
  currentTool,
} from "../pi-extension/subagents/session.ts";

import {
  findLatestAssistantError,
  runningChildrenCount,
  RUN_START_TIMEOUT,
} from "../pi-extension/subagents/subagent-done.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";

// --- Helpers ---

/** Stand in for a child submitting its pending messages to Pi. */
function consumeInbox(sessionFile: string): string[] {
  return pendingInboxMessages(sessionFile).map((file) => {
    const { message } = JSON.parse(readFileSync(file, "utf8"));
    rmSync(file);
    return message;
  });
}

/** A session file's entries (header first), parsed the way Pi parses them. */
function readEntries(file: string, after = 0): any[] {
  return parseSessionEntries(readFileSync(file, "utf8")).slice(after);
}

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      getThinkingLevel() { return "medium"; },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getActiveTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getSessionId", () => {
    it("reads the header id from a session file", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getSessionId(file), "sess-001");
    });

    it("returns null for a file without a session header", () => {
      const file = createSessionFile(dir, [USER_MSG]);
      assert.equal(getSessionId(file), null);
    });
  });

  describe("subagent loadout snapshot", () => {
    const sample: SubagentLoadout = {
      agent: "worker",
      toolAllowlist: "read,write,edit,bash,web_search,subagent,ask_question",
      systemPromptMode: "append",
      identity: "You are a worker agent.",
      spawnable: ["scout", "researcher"],
      interactive: false,
      cwd: "/work/dir",
      agentDir: "/home/u/.pi/agent",
    };

    it("writes the sidecar next to the session file", () => {
      const sf = join(dir, "s1.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.equal(loadoutSidecarPath(sf), sf + ".loadout.json");
      assert.ok(existsSync(sf + ".loadout.json"));
    });

    it("round-trips the full loadout", () => {
      const sf = join(dir, "s2.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.deepEqual(readSubagentLoadout(sf), sample);
    });

    it("returns null when the sidecar is absent", () => {
      assert.equal(readSubagentLoadout(join(dir, "missing.jsonl")), null);
    });

    it("returns null when the sidecar is valid JSON but not a loadout", () => {
      const sf = join(dir, "s4.jsonl");
      for (const bad of ["{}", "[]", JSON.stringify({ ...sample, spawnable: "scout" }), JSON.stringify({ ...sample, systemPromptMode: "prepend" })]) {
        writeFileSync(sf + ".loadout.json", bad, "utf8");
        assert.equal(readSubagentLoadout(sf), null, bad);
      }
    });

    it("returns null when the sidecar is corrupt", () => {
      const sf = join(dir, "s3.jsonl");
      writeFileSync(sf + ".loadout.json", "not json{", "utf8");
      assert.equal(readSubagentLoadout(sf), null);
    });
  });

  describe("subagent name registry", () => {
    it("registers and resolves a name to its session file", () => {
      const adir = join(dir, "art-1");
      registerName(adir, "worker", { sessionFile: "/s/worker.jsonl" });
      const entry = registryEntry(readNameRegistry(adir), "worker");
      assert.deepEqual(entry, { sessionFile: "/s/worker.jsonl" });
      assert.ok(existsSync(nameRegistryPath(adir)));
    });

    it("accumulates multiple names and overwrites on re-register", () => {
      const adir = join(dir, "art-2");
      registerName(adir, "scout", { sessionFile: "/s/scout.jsonl" });
      registerName(adir, "scout-2", { sessionFile: "/s/scout2.jsonl" });
      const reg = readNameRegistry(adir);
      assert.deepEqual(Object.keys(reg).sort(), ["scout", "scout-2"]);
      // Overwrite scout with a new session file.
      registerName(adir, "scout", { sessionFile: "/s/scout-new.jsonl" });
      assert.equal(registryEntry(readNameRegistry(adir), "scout")!.sessionFile, "/s/scout-new.jsonl");
    });

    it("returns null for unknown names and {} for a missing/corrupt registry", () => {
      const adir = join(dir, "art-3");
      assert.equal(registryEntry(readNameRegistry(adir), "nope"), null);
      assert.deepEqual(readNameRegistry(adir), {});
      mkdirSync(adir, { recursive: true });
      writeFileSync(nameRegistryPath(adir), "not json{", "utf8");
      assert.deepEqual(readNameRegistry(adir), {});
    });

    it("keeps any name as its own entry, and reports a registry it cannot write", () => {
      const adir = join(dir, "art-4");
      registerName(adir, "__proto__", { sessionFile: "/s/proto.jsonl" });
      assert.equal(registryEntry(readNameRegistry(adir), "__proto__")?.sessionFile, "/s/proto.jsonl");
      assert.equal(registryEntry(readNameRegistry(adir), "constructor"), null, "inherited properties are not names");
      writeFileSync(join(dir, "a-file"), "");
      assert.throws(() => registerName(join(dir, "a-file", "art"), "x", { sessionFile: "/s/x.jsonl" }));
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("keeps an earlier reply when an extension message triggers a later run", () => {
      const reply = (text: string, stopReason: string) => ({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text }], stopReason },
      });
      const entries = [
        reply("old answer", "stop"),
        USER_MSG,
        reply("Checking sources.", "toolUse"),
        reply("Full findings with sources.", "stop"),
        { type: "custom_message", customType: "web-search-content-ready", content: "Content fetched" },
        reply("Done; findings delivered.", "stop"),
      ] as any[];
      assert.equal(findLastAssistantMessage(entries), "Full findings with sources.\n\nDone; findings delivered.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        parentBranch: [MODEL_CHANGE, USER_MSG, ASSISTANT_MSG],
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    const spawning = (callId: string) => ({ type: "message", id: `spawn-${callId}`, parentId: "x",
      message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "subagent", arguments: {} }] } });
    const fork = (name: string, parentBranch: any[], forkPoint?: string) => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, ...parentBranch]);
      const childFile = join(dir, `${name}.jsonl`);
      seedSubagentSessionFile({ mode: "fork", parentSessionFile: parentFile, parentBranch, forkPoint, childSessionFile: childFile, childCwd: "/tmp/fork-cwd" });
      const [header, ...entries] = readEntries(childFile);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/fork-cwd");
      return entries.map((entry) => entry.id);
    };

    it("copies the active branch up to the message holding the spawning call", () => {
      assert.deepEqual(fork("fork-child", [MODEL_CHANGE, USER_MSG, ASSISTANT_MSG, spawning("call-1")], "call-1"),
        [MODEL_CHANGE.id, USER_MSG.id, ASSISTANT_MSG.id]);
    });

    it("keeps the whole conversation when a subagent's result started the spawning run", () => {
      const result = { type: "custom_message", id: "result-1", parentId: "asst-001", customType: "subagent_result", content: "done" };
      assert.deepEqual(fork("after-result", [MODEL_CHANGE, USER_MSG, ASSISTANT_MSG, result, spawning("call-2")], "call-2"),
        [MODEL_CHANGE.id, USER_MSG.id, ASSISTANT_MSG.id, "result-1"]);
    });

    it("finds the spawning call made from a codemode script by its enclosing call", () => {
      assert.deepEqual(fork("nested", [MODEL_CHANGE, USER_MSG, ASSISTANT_MSG, spawning("call-4")], "call-4/1"),
        [MODEL_CHANGE.id, USER_MSG.id, ASSISTANT_MSG.id]);
    });

    it("forks the active branch, not an abandoned branch at the end of the file", () => {
      // The parent file ends with an abandoned answer; the session manager's branch does not.
      const branch = [MODEL_CHANGE, USER_MSG, ASSISTANT_MSG, spawning("call-3")];
      const abandoned = { ...ASSISTANT_MSG, id: "asst-abandoned" };
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG, abandoned]);
      const childFile = join(dir, "tree-child.jsonl");
      seedSubagentSessionFile({ mode: "fork", parentSessionFile: parentFile, parentBranch: branch, forkPoint: "call-3", childSessionFile: childFile, childCwd: "/tmp" });
      assert.deepEqual(readEntries(childFile, 1).map((entry) => entry.id), [MODEL_CHANGE.id, USER_MSG.id, ASSISTANT_MSG.id]);
    });
  });

  describe("summarizeSessionStats", () => {
    const asstWithUsage = (id: string, opts: {
      model?: string;
      tools?: string[];
      usage?: Record<string, unknown>;
    }) => ({
      type: "message",
      id,
      parentId: "user-001",
      message: {
        role: "assistant",
        ...(opts.model ? { model: opts.model } : {}),
        content: [
          { type: "text", text: "ok" },
          ...(opts.tools ?? []).map((name, i) => ({ type: "toolCall", name, id: `${id}-tc${i}` })),
        ],
        ...(opts.usage ? { usage: opts.usage } : {}),
      },
    });

    it("aggregates tokens/cost cumulatively and tracks last context size", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, provider: "anthropic", modelId: "claude-sonnet-4-6" },
        USER_MSG,
        asstWithUsage("a1", {
          tools: ["read", "grep"],
          usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, totalTokens: 1350, cost: { total: 0.01 } },
        }),
        asstWithUsage("a2", {
          tools: ["write"],
          usage: { input: 30, output: 70, cacheRead: 2000, cacheWrite: 0, totalTokens: 3500, cost: { total: 0.02 } },
        }),
      ]);
      const stats = summarizeSessionStats(readEntries(file, 0))!;
      assert.equal(stats.model, "claude-sonnet-4-6");
      assert.equal(stats.provider, "anthropic", "the provider keys the model-registry lookup for the context window");
      assert.equal(stats.toolCount, 3);
      assert.equal(stats.inputTokens, 130);
      assert.equal(stats.outputTokens, 120);
      assert.equal(stats.cacheReadTokens, 3000);
      assert.equal(stats.cacheWriteTokens, 200);
      // contextTokens is the LAST assistant turn's totalTokens, not the sum.
      assert.equal(stats.contextTokens, 3500);
      assert.ok(Math.abs(stats.cost - 0.03) < 1e-9);
    });

    it("bills what Pi bills: compactions, branch summaries, usage entries and model-running tool results", () => {
      const usage = (tokens: number, cost: number) => ({ input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { total: cost } });
      const stats = summarizeSessionStats([
        asstWithUsage("a1", { usage: usage(100, 0.01) }),
        { type: "compaction", id: "c1", usage: usage(1000, 0.1) },
        { type: "branch_summary", id: "b1", usage: usage(200, 0.02) },
        { type: "usage", id: "u1", usage: usage(100, 0.01) },
        { type: "message", id: "t1", message: { role: "toolResult", content: [], usage: usage(100, 0.01) } },
      ] as any[]);
      assert.equal(stats.inputTokens, 1500);
      assert.equal(Math.round(stats.cost * 100), 15);
      assert.equal(stats.contextTokens, 0, "unknown after a compaction, until another assistant turn");
      const later = summarizeSessionStats([{ type: "compaction", id: "c0", usage: usage(1, 0) }, asstWithUsage("a2", { usage: usage(100, 0.01) })] as any[]);
      assert.equal(later.contextTokens, 100, "context occupancy comes from the assistant turn");
    });

    it("prefers per-message model over model_change", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-haiku-4-5" },
        asstWithUsage("a1", { model: "claude-sonnet-4-6", usage: { totalTokens: 10, cost: { total: 0 } } }),
      ]);
      assert.equal(summarizeSessionStats(readEntries(file, 0))!.model, "claude-sonnet-4-6");
    });

    it("handles missing usage gracefully", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const stats = summarizeSessionStats(readEntries(file, 0))!;
      assert.equal(stats.toolCount, 0);
      assert.equal(stats.inputTokens, 0);
      assert.equal(stats.cost, 0);
      assert.equal(stats.contextTokens, 0);
    });
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("parses quoted scalars, YAML tool lists, comments and CRLF with Pi frontmatter", async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      const variants = ['tools: "+codemode -bash" # relative selection', 'tools: [+codemode, -bash]', 'tools:\n  - +codemode\n  - -bash'];
      for (const [index, tools] of variants.entries()) {
        const name = `yaml-${index}`;
        writeAgentFile(projectAgentsDir, name,
          `name: "${name}"\nmodel: 'test/model'\n${tools}\nauto-exit: true\ninteractive: false\ndescription: |\n  First line\n  Second line`, "Role body.");
        const file = join(projectAgentsDir, `${name}.md`);
        writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
        const agent = testApi.loadAgentDefaults(name)!;
        assert.equal(agent.name, name);
        assert.equal(agent.model, "test/model");
        assert.equal(agent.description, "First line\nSecond line");
        assert.equal(agent.autoExit, true);
        assert.equal(agent.interactive, false);
        assert.equal(agent.body, "Role body.");
        assert.equal(testApi.buildSubagentToolAllowlist(agent.tools), "+codemode,-bash,+ask_question");
      }
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("does not discover example roles until explicitly installed", async () => {
    await withIsolatedAgentEnv(() => {
      assert.deepEqual(testApi.discoverAgentDefinitions(), []);
      for (const name of ["scout", "researcher", "worker"]) {
        assert.equal(testApi.loadAgentDefaults(name), null);
      }
    });
  });

  it("example scout/researcher/worker all resolve as non-interactive (auto-exit)", async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      cpSync(fileURLToPath(new URL("../examples/agents/", import.meta.url)), projectAgentsDir, { recursive: true });
      for (const name of ["scout", "researcher", "worker"]) {
        const defs = testApi.loadAgentDefaults(name);
        assert.ok(defs, `expected installed example ${name} to be discoverable`);
        assert.equal(
          defs.interactive ?? !defs.autoExit,
          false,
          `${name} should resolve as non-interactive (autonomous, auto-exit)`,
        );
      }
    });
  });

  it("worker is granted the spawning toolset restricted to scout and researcher", async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      cpSync(fileURLToPath(new URL("../examples/agents/", import.meta.url)), projectAgentsDir, { recursive: true });
      const worker = testApi.loadAgentDefaults("worker");
      assert.ok(worker, "expected installed example worker to be discoverable");
      assert.deepEqual(worker.subagentAgents, ["scout", "researcher"]);

      const allowlist = testApi.buildSubagentToolAllowlist(worker.tools, { grantSpawning: true });
      assert.ok(allowlist, "expected an allowlist");
      const tools = new Set(allowlist!.split(","));
      for (const t of ["subagent", "subagent_message", "subagents_list"]) {
        assert.ok(tools.has(`+${t}`), `expected spawning tool +${t} in worker allowlist`);
      }
      assert.ok(tools.has("+codemode"), "expected worker to enable codemode");
    });
  });

  it("scout and researcher are not granted spawning tools", async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      cpSync(fileURLToPath(new URL("../examples/agents/", import.meta.url)), projectAgentsDir, { recursive: true });
      for (const name of ["scout", "researcher"]) {
        const defs = testApi.loadAgentDefaults(name);
        assert.ok(defs, `expected installed example ${name} to be discoverable`);
        assert.equal(defs.subagentAgents, undefined, `${name} should not declare subagent_agents`);
      }
    });
  });

  it("keeps delegation denied without subagent_agents even when extensions load normally", async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      cpSync(fileURLToPath(new URL("../examples/agents/", import.meta.url)), projectAgentsDir, { recursive: true });
      const moduleUrl = new URL("../pi-extension/subagents/index.ts", import.meta.url).href;
      for (const allowed of [undefined, "", "scout"]) {
        const env: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT_AGENT: "worker" };
        delete env.PI_SUBAGENT_ALLOWED;
        if (allowed !== undefined) env.PI_SUBAGENT_ALLOWED = allowed;
        const output = execFileSync(process.execPath, ["--input-type=module", "-e",
          `import { __test__ } from ${JSON.stringify(moduleUrl)};
           console.log(JSON.stringify(__test__.discoverAgentDefinitions().map(a => a.name)));`,
        ], { env, encoding: "utf8" });
        assert.deepEqual(JSON.parse(output), allowed ? ["scout"] : []);
      }
    });
  });

  it("treats empty tools frontmatter as unrestricted without swallowing the next field", async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      writeAgentFile(projectAgentsDir, "empty-tools", "tools:   \nsubagent_agents: scout\nmodel: test/model");
      const agent = testApi.loadAgentDefaults("empty-tools")!;
      assert.equal(agent.tools, undefined);
      assert.equal(agent.model, "test/model");
      assert.deepEqual(agent.subagentAgents, ["scout"]);
      assert.equal(testApi.buildSubagentToolAllowlist(agent.tools, { grantSpawning: true }), null);
    });
  });

  it("gives scout an explicit read-only tool allowlist plus codemode", async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      cpSync(fileURLToPath(new URL("../examples/agents/", import.meta.url)), projectAgentsDir, { recursive: true });
      const scout = testApi.loadAgentDefaults("scout");
      assert.equal(scout?.tools, "read,grep,find,ls,codemode");
      assert.equal(testApi.buildSubagentToolAllowlist(scout?.tools), "read,grep,find,ls,codemode,ask_question");
    });
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("preserves plain allowlists and relative selectors without mixing their semantics", () => {
    assert.equal(testApi.buildSubagentToolAllowlist("read,bash,web_search"), "read,bash,web_search,ask_question");
    assert.equal(testApi.buildSubagentToolAllowlist("+codemode -bash"), "+codemode,-bash,+ask_question");
    assert.equal(testApi.buildSubagentToolAllowlist("-bash,+bash,-bash"), "-bash,+bash,-bash,+ask_question");
    assert.equal(testApi.buildSubagentToolAllowlist(["+codemode", "-bash"]), "+codemode,-bash,+ask_question");
    assert.equal(testApi.buildSubagentToolAllowlist("+ask_question,-ask_question"), "+ask_question");
    assert.equal(testApi.buildSubagentToolAllowlist("-subagent", { grantSpawning: true }),
      "+ask_question,+subagent,+subagent_message,+subagents_list");
    assert.throws(() => testApi.buildSubagentToolAllowlist("read,+codemode"), /not both/);
    assert.throws(() => testApi.buildSubagentToolAllowlist("+code*"), /Invalid tool selector/);
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
    assert.equal(testApi.buildSubagentToolAllowlist(" , ", { grantSpawning: true }), null);
    assert.equal(testApi.buildSubagentToolAllowlist(undefined, { grantSpawning: true }), null);
  });

  it("applyLoadoutToArgs replays identity, tool restriction and delegation helper, but never the model", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      const sessionFile = join(d, "worker.jsonl");
      const identity = "You are a worker.\n\n## Rules\n- Stay on task.";
      testApi.applyLoadoutToArgs(parts, {
        agent: "worker",
        toolAllowlist: "read,write",
        systemPromptMode: "append",
        identity,
        spawnable: ["scout"],
        cwd: null,
        agentDir: null,
      }, sessionFile);
      // The session keeps model and thinking from the first launch, including a later switch.
      assert.equal(parts.includes("--model") || parts.includes("--thinking"), false);
      // The identity is appended to Pi's base prompt, so it holds on every request — as a file,
      // since herdr refuses arguments with line breaks.
      const identityFile = parts[parts.indexOf("--append-system-prompt") + 1];
      assert.equal(identityFile, `${sessionFile}.identity.md`);
      assert.equal(readFileSync(identityFile, "utf8"), identity);
      assert.ok(parts.every((part) => !part.includes("\n")), "no argument spans lines");
      assert.ok(!parts.includes("--no-extensions"), "extension discovery stays enabled");
      assert.ok(parts.some((part) => part.endsWith("subagents/index.ts")));
      assert.equal(parts[parts.indexOf("--tools") + 1], "read,write");
    });
  });

  it("applyLoadoutToArgs keeps the APPEND_SYSTEM.md Pi would load beside an appended identity", () => {
    withTempDir((d) => {
      const [agentDir, role] = [join(d, "agent"), join(d, "project", "role")];
      mkdirSync(join(role, ".pi"), { recursive: true });
      mkdirSync(agentDir);
      const appended = () => {
        const parts: string[] = [];
        testApi.applyLoadoutToArgs(parts, { agent: null, toolAllowlist: null, systemPromptMode: "append",
          identity: "ID", spawnable: null, cwd: role, agentDir }, join(d, "s.jsonl"));
        return parts.flatMap((part, i) => (parts[i - 1] === "--append-system-prompt" ? [part] : []));
      };
      const id = join(d, "s.jsonl.identity.md");
      assert.deepEqual(appended(), [id]);
      writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "global");
      assert.deepEqual(appended(), [join(agentDir, "APPEND_SYSTEM.md"), id]);
      // The project's own replaces the global one only where Pi trusts it: here, by a trusted parent folder.
      writeFileSync(join(role, ".pi", "APPEND_SYSTEM.md"), "role");
      assert.deepEqual(appended(), [join(agentDir, "APPEND_SYSTEM.md"), id]);
      new ProjectTrustStore(agentDir).set(join(d, "project"), true);
      assert.deepEqual(appended(), [join(role, ".pi", "APPEND_SYSTEM.md"), id]);
    });
  });

  it("applyLoadoutToArgs omits restriction flags when the loadout was unrestricted", () => {
    const parts: string[] = [];
    testApi.applyLoadoutToArgs(parts, {
      agent: null, toolAllowlist: null, systemPromptMode: null,
      identity: null, spawnable: null, cwd: null, agentDir: null,
    }, "/nonexistent/s.jsonl");
    assert.deepEqual(parts, []);
  });


  it("does not treat a plain .md without frontmatter as an agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      mkdirSync(projectAgentsDir, { recursive: true });
      writeFileSync(join(projectAgentsDir, "README.md"), "# Agents\n\nNotes about these agents.\n");
      const names = testApi.discoverAgentDefinitions().map((agent: { name: string }) => agent.name);
      assert.equal(names.includes("README"), false, names.join(","));
      assert.equal(testApi.loadAgentDefaults("README"), null);
    });
  });

  it("skips an unreadable profile instead of hiding every other agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(projectAgentsDir, "readable-agent", "name: readable-agent");
      symlinkSync(join(projectAgentsDir, "missing-target.md"), join(projectAgentsDir, "dangling.md"));
      assert.ok(testApi.discoverAgentDefinitions().some((agent: { name: string }) => agent.name === "readable-agent"));
    });
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute("call", {}, undefined, undefined, { cwd: process.cwd() });
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute("call", {}, undefined, undefined, { cwd: process.cwd() });
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute("call", {}, undefined, undefined, { cwd: process.cwd() });
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("subagent-done.ts", () => {
  it("lists only tools declared to the model in the child widget", () => {
    const { api } = createMockExtensionApi();
    let start: any, toggle: any, widget: any;
    api.on = (event: string, handler: any) => { if (event === "session_start") start = handler; };
    api.registerShortcut = (_key: string, shortcut: any) => { toggle = shortcut.handler; };
    api.getAllTools = () => { throw new Error("must not list configured tools"); };
    let active = ["read", "ask_question"];
    api.getActiveTools = () => active;
    subagentDoneExtension(api);
    const ctx = { ui: { setWidget(_key: string, factory: any) { widget = factory; } }, sessionManager: { getEntries: () => [] } };
    const theme = { bg: (_color: string, text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text };
    start({}, ctx);
    const shown = widget({}, theme);
    assert.match(shown.render(80).join("\n"), /2 tools/);
    active = [...active, "mcp_search"]; // an MCP server connected after startup
    assert.match(shown.render(80).join("\n"), /3 tools/, "the widget follows the active tools");
    toggle(ctx);
    const output = widget({}, theme).render(80).join("\n");
    assert.match(output, /ask_question, mcp_search, read/);
    assert.doesNotMatch(output, /bash|denied/);
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("reports provider errors even when the error text mentions AbortError", () => {
      assert.deepEqual(findLatestAssistantError([{ role: "assistant", stopReason: "error", errorMessage: "AbortError from provider" }]), {
        errorMessage: "AbortError from provider",
      });
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("reports an answer cut off at the output limit as incomplete", () => {
      const info = findLatestAssistantError([{ role: "assistant", stopReason: "length", content: [{ type: "text", text: "Partial" }] }]);
      assert.match(info!.errorMessage, /cut off at the model's output limit/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });

  describe("runningChildrenCount", () => {
    const KEY = Symbol.for("pi-subagents/running-children-count");
    function withGlobal(value: unknown, run: () => void) {
      const prev = (globalThis as any)[KEY];
      (globalThis as any)[KEY] = value;
      try {
        run();
      } finally {
        (globalThis as any)[KEY] = prev;
      }
    }

    it("returns 0 when the spawning tools aren't loaded (no global)", () => {
      withGlobal(undefined, () => {
        assert.equal(runningChildrenCount(), 0);
      });
    });

    it("reflects the live child count published by index.ts", () => {
      withGlobal(() => 3, () => {
        assert.equal(runningChildrenCount(), 3);
      });
    });

    it("returns zero when the running map is empty", () => {
      withGlobal(() => 0, () => assert.equal(runningChildrenCount(), 0));
    });
  });

  describe("ask_question tool", () => {
    function setupSubagentExtension(sessionFile: string) {
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      const mock = createMockExtensionApi();
      subagentDoneExtension(mock.api);
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      return { mock, restore };
    }

    it("registers ask_question (and no caller_ping) with a single freeform question param", () => {
      const dir = createTestDir();
      const { mock, restore } = setupSubagentExtension(join(dir, "s.jsonl"));
      try {
        const names = mock.registeredTools.map((t) => t.name);
        assert.ok(names.includes("ask_question"));
        assert.ok(!names.includes("caller_ping"));
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
        assert.match(tool.description, /orchestrator/i);
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("publishes the question for the parent and does NOT shut the session down", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { mock, restore } = setupSubagentExtension(sessionFile);
      try {
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        let shutdownCalled = false;
        const ctx = { shutdown() { shutdownCalled = true; } } as any;
        const out = await tool.execute("call-1", { question: "Which API base URL?" }, undefined, undefined, ctx);

        assert.equal(shutdownCalled, false, "ask_question must keep the session open");
        assert.match(out.content[0].text, /wait/i);

        assert.deepEqual(pendingQuestions(sessionFile).questions, ["Which API base URL?"]);
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Regression tests for the mid-run reply race: a reply steered in while the
    // asking run is still open fires `input` but NOT `agent_start`, so the flag
    // must be cleared on `input` or the session parks forever.
    // Slash commands the harness reports, such as loaded skills.
    const commands: any[] = [];
    function setupCapturingExtension(sessionFile: string, { autoExit = true } = {}) {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const tools: any[] = [];
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerTool(t: any) { tools.push(t); },
        registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
        sendUserMessage() {}, sendMessage() {}, setSessionName() {}, getActiveTools() { return []; },
        getCommands() { return commands; },
      } as any;
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = autoExit ? "1" : "0";
      subagentDoneExtension(api);
      // Handlers get the session context unless a test passes its own.
      const emit = (event: string, payload: any = {}, context: any = ctx) =>
        (handlers.get(event) ?? []).map((h) => h(event === "input" ? { text: "human input", ...payload } : payload, context));
      const restore = () => {
        emit("session_shutdown", { reason: "reload" });
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      let shutdownCalls = 0;
      const branch: any[] = []; // the child's active branch, as its session manager reports it
      const ctx = {
        ui: { setWidget() {} },
        sessionManager: { getEntries: () => branch, getLeafId: () => branch.at(-1)?.id ?? null, getBranch: () => branch },
        isIdle: () => true,
        model: { provider: "test", id: "model" } as any,
        modelRegistry: { hasConfiguredAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true }) } as any,
        shutdown() { shutdownCalls++; },
      };
      emit("session_start", {}, ctx);
      const settle = async (messages: any[] = [], aborted = false) => {
        emit("agent_end", { messages }, ctx);
        emit("agent_before_settle", { outcome: aborted ? "aborted" : "completed" }, ctx);
        emit("agent_settled", { aborted }, ctx);
      };
      const askWith = async (question: string) => {
        const tool = tools.find((t) => t.name === "ask_question");
        await tool.execute("c1", { question }, undefined, undefined, ctx);
      };
      const ask = () => askWith("v1 or v2?");
      return { api, emit, settle, ask, askWith, restore, ctx, branch,
        reload() { emit("session_shutdown", { reason: "reload" }); handlers.clear(); subagentDoneExtension(api); emit("session_start", { reason: "reload" }); },
        get shutdownCalls() { return shutdownCalls; } };
    }

    it("does not exit or report a temporary error until retries settle", async () => {
      const dir = createTestDir();
      const session = join(dir, "s.jsonl");
      const h = setupCapturingExtension(session);
      try {
        h.emit("agent_start");
        h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "temporary overload" }] }, h.ctx);
        await delay(10);
        assert.equal(h.shutdownCalls, 0);
        assert.equal(existsSync(`${session}.exit`), false);
        await h.settle([{ role: "assistant", stopReason: "stop" }]);
        assert.equal(h.shutdownCalls, 1);
        assert.ok(existsSync(`${session}.exiting`), "published before Pi stops reading input");
        h.emit("session_shutdown", { reason: "quit" });
        assert.deepEqual(JSON.parse(readFileSync(`${session}.exit`, "utf8")), { type: "done", summary: null });
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports a terminal provider error on quit, once shutdown has begun", async () => {
      const dir = createTestDir();
      const session = join(dir, "s.jsonl");
      const h = setupCapturingExtension(session);
      try {
        h.emit("agent_start");
        const failed = { role: "assistant", stopReason: "error", errorMessage: "overloaded after retries", content: [] };
        h.branch.push({ type: "message", id: "e1", message: failed });
        await h.settle([failed]);
        assert.equal(h.shutdownCalls, 1);
        assert.equal(existsSync(`${session}.exit`), false, "no marker before the shutdown it would race");
        h.emit("session_shutdown", { reason: "quit" }, h.ctx);
        assert.deepEqual(JSON.parse(readFileSync(`${session}.exit`, "utf8")),
          { type: "error", errorMessage: "overloaded after retries", summary: "Subagent error: overloaded after retries" });
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps the session open while its own child tasks are still running", async () => {
      const key = Symbol.for("pi-subagents/running-children-count");
      const previous = (globalThis as any)[key];
      const dir = createTestDir();
      const h = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        h.emit("agent_start");
        (globalThis as any)[key] = () => 1;
        await h.settle();
        assert.equal(h.shutdownCalls, 0, "unfinished children must prevent exit");
        (globalThis as any)[key] = () => 0;
        h.emit("input");
        h.emit("agent_start");
        await h.settle();
        assert.equal(h.shutdownCalls, 1, "once children are done a later run may exit normally");
      } finally {
        (globalThis as any)[key] = previous;
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes done or quit receipts on shutdown", async () => {
      for (const finishFirst of [true, false]) {
        const dir = createTestDir();
        const sessionFile = join(dir, "s.jsonl");
        const h = setupCapturingExtension(sessionFile);
        try {
          h.emit("agent_start");
          // The answer comes from the active branch the session manager reports.
          h.branch.push({ type: "message", id: "a1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done it." }] } });
          if (finishFirst) await h.settle([{ role: "assistant", stopReason: "stop" }]);
          h.emit("session_shutdown", { reason: "quit" }, h.ctx);
          assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: finishFirst ? "done" : "quit", summary: "Done it." });
        } finally {
          h.restore();
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    it("preserves ordinary results on a pre-upgrade child's reload, but never falls back to an unrelated branch", () => {
      for (const baseline of [null, "old", "missing"] as const) {
        const dir = createTestDir(), sessionFile = join(dir, "legacy.jsonl");
        const h = setupCapturingExtension(sessionFile);
        try {
          const state = (globalThis as any)[Symbol.for("pi-subagents/child-state")];
          delete state.existingEntryIds;
          state.baseline = baseline;
          if (baseline !== null) h.branch.push({ ...ASSISTANT_MSG, id: "old" });
          if (baseline !== "missing") h.branch.push({ type: "message", id: "new", message: { role: "assistant", content: [{ type: "text", text: "Fresh answer" }] } });
          h.reload();
          h.emit("session_shutdown", { reason: "quit" }, h.ctx);
          assert.equal(JSON.parse(readFileSync(sessionFile + ".exit", "utf8")).summary, baseline === "missing" ? null : "Fresh answer");
        } finally {
          h.restore();
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    it("reports a failed last turn as an error when a human quits an interactive child", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const h = setupCapturingExtension(sessionFile, { autoExit: false });
      try {
        h.branch.push({ type: "message", id: "e1", message: { role: "assistant", stopReason: "error", errorMessage: "429 after retries", content: [] } });
        h.emit("session_shutdown", { reason: "quit" }, h.ctx);
        const marker = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
        assert.equal(marker.type, "error");
        assert.equal(marker.errorMessage, "429 after retries");
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("ends with an error when Pi starts no run for its task, instead of waiting forever", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const h = setupCapturingExtension(sessionFile);
      try {
        // A task that starts a run is not affected, nor one whose preparation waits at a dialog.
        h.emit("input");
        h.emit("agent_start");
        t.mock.timers.tick(RUN_START_TIMEOUT);
        h.emit("input");
        h.emit("ui_prompt_start");
        t.mock.timers.tick(RUN_START_TIMEOUT * 2);
        assert.equal(h.shutdownCalls, 0, "a human is answering a dialog");
        h.emit("ui_prompt_start");
        h.emit("ui_prompt_end");
        h.emit("agent_start");
        t.mock.timers.tick(RUN_START_TIMEOUT);
        assert.equal(h.shutdownCalls, 0);
        // One Pi refuses (no credentials) starts none.
        h.emit("input");
        t.mock.timers.tick(RUN_START_TIMEOUT);
        assert.equal(h.shutdownCalls, 1);
        assert.ok(existsSync(`${sessionFile}.exiting`));
        h.emit("session_shutdown", { reason: "quit" });
        const marker = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
        assert.equal(marker.type, "error");
        assert.match(marker.errorMessage, /no run for the task within 30 s \(test\/model\).*credentials/);
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("restarts the deadline when a dialog closes without a run, as a declined one that swallowed the task", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const dir = createTestDir();
      const h = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        h.emit("input");
        t.mock.timers.tick(RUN_START_TIMEOUT / 2);
        h.emit("ui_prompt_start");
        t.mock.timers.tick(RUN_START_TIMEOUT);
        h.emit("ui_prompt_end");
        t.mock.timers.tick(RUN_START_TIMEOUT - 1);
        assert.equal(h.shutdownCalls, 0, "a full deadline from the close");
        t.mock.timers.tick(1);
        assert.equal(h.shutdownCalls, 1);
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps the deadline of a task that started no run across /reload", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const h = setupCapturingExtension(sessionFile);
      try {
        h.emit("input");
        t.mock.timers.tick(RUN_START_TIMEOUT / 2);
        h.emit("session_shutdown", { reason: "reload" });
        let reloadedShutdowns = 0;
        const reloaded = { ...h.ctx, shutdown() { reloadedShutdowns++; } };
        subagentDoneExtension(h.api); // /reload re-runs the factory
        h.emit("session_start", { reason: "reload" }, reloaded);
        t.mock.timers.tick(RUN_START_TIMEOUT / 2);
        assert.ok(reloadedShutdowns >= 1, "the reloaded session ends it on time");
        assert.equal(h.shutdownCalls, 0, "never through the stale context");
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not report an earlier run's provider error for a resumed run ended early", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const h = setupCapturingExtension(sessionFile);
      try {
        h.branch.push({ type: "message", id: "old", message: { role: "assistant", stopReason: "error", errorMessage: "OLD FAILURE", content: [] } });
        h.emit("session_start", { reason: "resume" }, h.ctx); // the resumed run starts after it
        h.emit("session_shutdown", { reason: "quit" }, h.ctx);
        assert.equal(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")).type, "quit");
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("stays open on structured or message-level aborts", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const h = setupCapturingExtension(sessionFile);
      try {
        for (const interrupted of [{ stopReason: "stop" }, { stopReason: "aborted" }]) {
          h.emit("agent_start");
          await h.settle([{ role: "assistant", ...interrupted }], interrupted.stopReason === "stop");
          assert.equal(h.shutdownCalls, 0);
          assert.equal(existsSync(`${sessionFile}.paused`), true);
          assert.equal(statSync(`${sessionFile}.paused`).mode & 0o777, 0o600);
          rmSync(`${sessionFile}.paused`);
          assert.equal(existsSync(`${sessionFile}.exit`), false, "aborted turns stay parked without an exit receipt");
        }
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports an AbortError-named provider failure instead of parking", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const h = setupCapturingExtension(sessionFile);
      try {
        h.emit("agent_start");
        const message = { role: "assistant", stopReason: "error", errorMessage: "AbortError: provider rejected request", content: [] };
        h.branch.push({ type: "message", id: "provider-error", message });
        await h.settle([message]);
        assert.equal(h.shutdownCalls, 1);
        h.emit("session_shutdown", { reason: "quit" });
        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
          type: "error", errorMessage: "AbortError: provider rejected request", summary: "Subagent error: AbortError: provider rejected request",
        });
        assert.equal(existsSync(`${sessionFile}.paused`), false);
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits (does not park) when the reply arrives mid-run via input", async () => {
      const dir = createTestDir();
      const h = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        h.emit("agent_start");
        await h.ask();
        // Reply arrives MID-RUN as a steer: input fires, no new agent_start.
        h.emit("input");
        await h.settle();
        assert.equal(h.shutdownCalls, 1, "reply consumed mid-run → settled task should exit");
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps waiting for a reply when another run (a child's result) starts first", async () => {
      const dir = createTestDir();
      const h = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        h.emit("agent_start");
        await h.ask();
        await h.settle();
        h.emit("agent_start"); // a custom message started this run; nobody replied
        await h.settle();
        assert.equal(h.shutdownCalls, 0);
        h.emit("input");
        h.emit("agent_start");
        await h.settle();
        assert.equal(h.shutdownCalls, 1);
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("remembers an unanswered question across /reload", async () => {
      const dir = createTestDir();
      const h = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        await h.ask();
        subagentDoneExtension(h.api); // /reload re-runs the factory
        h.emit("session_start", { reason: "reload" }, h.ctx);
        h.emit("agent_start"); // woken by something other than a reply
        await h.settle();
        assert.equal(h.shutdownCalls, 0);
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("drops an unsent question or interruption notice once input arrives", async () => {
      const dir = createTestDir();
      const session = join(dir, "s.jsonl");
      const h = setupCapturingExtension(session);
      try {
        await h.ask();
        writeFileSync(`${session}.paused`, "{}");
        h.emit("input");
        assert.equal(existsSync(`${session}.ask`), false);
        assert.equal(existsSync(`${session}.paused`), false);
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects a blank question instead of waiting for an answer to it", async () => {
      const dir = createTestDir();
      const session = join(dir, "s.jsonl");
      const h = setupCapturingExtension(session);
      try {
        await assert.rejects(h.askWith("  \n "), /empty/);
        assert.deepEqual(pendingQuestions(session).files, []);
        await h.settle();
        assert.equal(h.shutdownCalls, 1);
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not wait for an answer to a question it failed to publish", async () => {
      const dir = createTestDir();
      writeFileSync(join(dir, "a-file"), "");
      const h = setupCapturingExtension(join(dir, "a-file", "s.jsonl")); // nowhere to write
      try {
        await assert.rejects(h.ask());
        await h.settle();
        assert.equal(h.shutdownCalls, 1);
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps every question asked before the parent picks them up, in order", async () => {
      const dir = createTestDir();
      const session = join(dir, "s.jsonl");
      const h = setupCapturingExtension(session);
      try {
        await h.ask();
        await h.ask();
        assert.deepEqual(pendingQuestions(session).questions, ["v1 or v2?", "v1 or v2?"]);
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("submits inbox files in order, removes malformed files, and retries a synchronous send failure", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const dir = createTestDir(), session = join(dir, "s.jsonl");
      const h = setupCapturingExtension(session), sent: any[] = [];
      let throws = true;
      h.api.sendUserMessage = (text: string, options: any) => {
        if (throws) throw new Error("stale API");
        sent.push({ text, options });
      };
      try {
        Object.assign(h.ctx, { isIdle: () => false, signal: new AbortController().signal });
        const first = publishInboxMessage(session, "line one\nline two"), second = publishInboxMessage(session, "next");
        writeFileSync(first, JSON.stringify({ message: "line one\nline two", followUp: true })); // legacy field is ignored
        writeFileSync(join(session + ".inbox", "000-malformed.json"), "{");
        t.mock.timers.tick(250);
        assert.deepEqual(sent, []);
        assert.deepEqual(pendingInboxMessages(session), [first, second]);
        throws = false;
        t.mock.timers.tick(250);
        assert.deepEqual(sent, [
          { text: "line one\nline two", options: { deliverAs: "steer" } },
          { text: "next", options: { deliverAs: "steer" } },
        ]);
        assert.deepEqual(pendingInboxMessages(session), []);
        h.reload();
        t.mock.timers.tick(250);
        assert.equal(sent.length, 2, "submitted files are gone, also after reload");
      } finally { h.restore(); rmSync(dir, { recursive: true, force: true }); }
    });

    it("submits only one idle prompt per tick, then steers into its run", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const dir = createTestDir(), session = join(dir, "s.jsonl");
      const h = setupCapturingExtension(session), sent: any[] = [];
      h.api.sendUserMessage = (text: string, options: any) => {
        h.emit("input", { text, streamingBehavior: options?.deliverAs });
        sent.push({ text, options });
      };
      try {
        const first = publishInboxMessage(session, "first"), second = publishInboxMessage(session, "second");
        t.mock.timers.tick(250);
        assert.equal(sent.length, 1, "the first idle submission ends this tick");
        assert.deepEqual(pendingInboxMessages(session), [second]);
        assert.deepEqual(sent[0].options, { deliverAs: "steer" });
        h.emit("agent_start");
        Object.assign(h.ctx, { isIdle: () => false, signal: new AbortController().signal });
        t.mock.timers.tick(250);
        assert.equal(sent.length, 2);
        assert.deepEqual(sent[1].options, { deliverAs: "steer" });

        assert.equal(existsSync(first), false);
        assert.deepEqual(pendingInboxMessages(session), []);
      } finally { h.restore(); rmSync(dir, { recursive: true, force: true }); }
    });

    it("leaves files arriving after .exiting unread", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const dir = createTestDir(), session = join(dir, "s.jsonl");
      const h = setupCapturingExtension(session), sent: string[] = [];
      h.api.sendUserMessage = (text: string) => sent.push(text);
      const file = publishInboxMessage(session, "task");
      try {
        t.mock.timers.tick(250);
        assert.deepEqual(sent, ["task"]);
        assert.equal(existsSync(file), false);
        writeFileSync(join(session + ".inbox", "bad.json"), "null");
        await h.settle();
        t.mock.timers.tick(250);
        assert.equal(h.shutdownCalls, 1, "malformed inbox work does not park a finished task");
        assert.equal(existsSync(session + ".exiting"), true);
        const unread = publishInboxMessage(session, "too late");
        t.mock.timers.tick(250);
        assert.deepEqual(pendingInboxMessages(session), [unread]);
        assert.equal(sent.length, 1);
      } finally { h.restore(); rmSync(dir, { recursive: true, force: true }); }
    });

    it("loads every configured skill with the first task, so one run has them all", async () => {
      const dir = createTestDir();
      for (const name of ["first", "second"]) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n\nUse the ${name} way.\n`);
        commands.push({ name: `skill:${name}`, source: "skill", sourceInfo: { path: join(dir, name, "SKILL.md") } });
      }
      process.env.PI_SUBAGENT_SKILLS = "first, second, missing";
      const h = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        const [first] = h.emit("input", { text: "do the task" });
        assert.equal(first.action, "transform");
        assert.equal(first.text, [
          `<skill name="first" location="${join(dir, "first", "SKILL.md")}">\nReferences are relative to ${join(dir, "first")}.\n\nUse the first way.\n</skill>`,
          `<skill name="second" location="${join(dir, "second", "SKILL.md")}">\nReferences are relative to ${join(dir, "second")}.\n\nUse the second way.\n</skill>`,
          "do the task",
        ].join("\n\n"));
        assert.equal(h.emit("input", { text: "a follow-up" })[0], undefined, "only the first task carries them");
      } finally {
        delete process.env.PI_SUBAGENT_SKILLS;
        commands.length = 0;
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("waits for a manual /compact to finish before exiting", async () => {
      const dir = createTestDir();
      const h = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        let compacting = true;
        Object.assign(h.ctx, { isIdle: () => !compacting, signal: undefined });
        h.emit("agent_start");
        await h.settle(); // a child's result started a run during the compaction
        assert.equal(h.shutdownCalls, 0, "shutting down now would cancel the compaction");
        // Pi announces the end of the compaction, and clears its busy state only after.
        h.emit("session_compact", {});
        await delay(20);
        assert.equal(h.shutdownCalls, 0);
        compacting = false;
        await delay(80);
        assert.equal(h.shutdownCalls, 1);
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("waits for an unsent draft before exiting", async () => {
      const dir = createTestDir();
      const h = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        h.emit("input");
        h.emit("agent_start");
        let draft = "half-typed follow-up";
        Object.assign(h.ctx, { hasUI: true });
        Object.assign(h.ctx.ui, { getEditorText: () => draft });
        await h.settle();
        assert.equal(h.shutdownCalls, 0, "a draft keeps the session open");
        draft = "";
        await h.settle();
        assert.equal(h.shutdownCalls, 1);
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("parks after settlement while the reply is still pending", async () => {
      const dir = createTestDir();
      const h = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        h.emit("agent_start");
        await h.ask();
        await h.settle();
        assert.equal(h.shutdownCalls, 0, "pending question with no reply must park, not exit");
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits when the reply arrives as a new turn (agent_start also clears the flag)", async () => {
      const dir = createTestDir();
      const h = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        h.emit("agent_start");
        await h.ask();
        await h.settle();
        assert.equal(h.shutdownCalls, 0, "parks while waiting");
        h.emit("input");
        h.emit("agent_start");
        await h.settle();
        assert.equal(h.shutdownCalls, 1, "after the reply task settles, exit");
      } finally {
        h.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("commands", () => {
  it("/subagent emits a spawn tool call for a known agent", async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      writeAgentFile(projectAgentsDir, "scout", "name: scout");
      const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();
      subagentsModule.default(api);
      const subagent = registeredCommands.find((command) => command.name === "subagent");
      assert.ok(subagent, "expected /subagent to be registered");
      subagent.handler("scout map the auth code", { ui: { notify() {} } });
      assert.equal(sentUserMessages.length, 1);
      assert.match(sentUserMessages[0], /agent: "scout"/);
      assert.match(sentUserMessages[0], /map the auth code/);
    });
  });

  it("does not register the removed /iterate or /plan commands", () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    assert.equal(registeredCommands.find((c) => c.name === "iterate"), undefined);
    assert.equal(registeredCommands.find((c) => c.name === "plan"), undefined);
  });
});

describe("tool registration", () => {
  it("rejects a top-level spawn with no agent and no fork", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", { name: "x", task: "do it" }, undefined, undefined, { cwd: process.cwd() });
    assert.equal(result.details?.error, "agent required");
    assert.match(result.content[0].text, /specify which agent/i);
  });

  it("launches profiles with their identity, session mode and interactive policy", async () => {
    const testApi = (subagentsModule as any).__test__;
    const deps = testApi.launchDeps;
    const oldStart = deps.startAgent, oldWatch = deps.watchSubagent;
    const oldEnv = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
    try {
      await withIsolatedAgentEnv(async ({ projectDir, projectAgentsDir }) => {
        Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });
        for (const [name, mode] of [["spm-replace", "replace"], ["spm-append", "append"], ["spm-none", undefined], ["spm-bogus", "foobar"]]) {
          writeAgentFile(projectAgentsDir, name, `name: ${name}${mode ? `\nsystem-prompt: ${mode}` : ""}`, `You are ${name}.\n\nWork carefully.`);
        }
        for (const [name, fields] of [
          ["fork-plain", "session-mode: fork\nauto-exit: true\ntools: read\nskills: first, second\nmodel: test/model\nthinking: high"],
          ["lineage", "session-mode: lineage-only\nauto-exit: false"],
          ["interactive", "auto-exit: true\ninteractive: true"],
          ["quiet", "auto-exit: false\ninteractive: false"],
        ]) writeAgentFile(projectAgentsDir, name, `name: ${name}\n${fields}`, `You are ${name}.`);
        const parent = join(projectDir, "parent.jsonl");
        writeFileSync(parent, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG,
          { ...USER_MSG, id: "user-002", parentId: "asst-001" }].map(e => JSON.stringify(e)).join("\n") + "\n");
        const launches: any[] = [];
        deps.startAgent = async (launch: any) => {
          assert.deepEqual(pendingInboxMessages(launch.env.PI_SUBAGENT_SESSION), [], "no task while herdr waits for readiness");
          launches.push(launch);
          return { surface: `w1:p${launches.length + 1}`, agent: launch.name };
        };
        deps.watchSubagent = async () => ({ summary: "", exitCode: 0, elapsed: 0 }); // settles at once
        const { api, registeredTools } = createMockExtensionApi();
        (subagentsModule as any).default(api);
        const tool = registeredTools.find((item) => item.name === "subagent");
        const ctx = { cwd: projectDir, sessionManager: {
          getSessionFile: () => join(projectDir, "parent.jsonl"), getSessionDir: () => projectDir, getSessionId: () => "parent-id",
          getBranch: () => readEntries(parent, 1) } };
        const spawn = async (agent: string) => {
          await tool.execute("call", { agent, task: "do the task" }, undefined, undefined, ctx);
          const launch = launches.at(-1);
          const flag = ["--system-prompt", "--append-system-prompt"].find((f) => launch.args.includes(f));
          const promptValue = flag && launch.args[launch.args.indexOf(flag) + 1];
          return { flag, file: flag && readFileSync(promptValue, "utf8"), task: JSON.parse(readFileSync(pendingInboxMessages(launch.env.PI_SUBAGENT_SESSION)[0], "utf8")).message,
            launch, running: [...testApi.runningSubagents.values()].at(-1) };
        };
        const replace = await spawn("spm-replace");
        assert.equal(replace.flag, "--system-prompt");
        assert.equal(replace.file, "You are spm-replace.\n\nWork carefully.");
        assert.ok(replace.launch.args.every((arg: string) => !arg.includes("\n")), "herdr refuses arguments with line breaks");
        assert.doesNotMatch(replace.task, /You are spm-replace/);
        assert.equal(replace.running.interactive, true);
        assert.equal(existsSync(replace.running.sessionFile), false, "standalone is not seeded");
        const append = await spawn("spm-append");
        assert.equal(append.flag, "--append-system-prompt");
        assert.equal(append.file, "You are spm-append.\n\nWork carefully.");
        assert.ok(append.launch.args.every((arg: string) => !arg.includes("\n")));
        assert.doesNotMatch(append.task, /You are spm-append/);
        for (const agent of ["spm-none", "spm-bogus"]) {  // no or unknown mode: identity rides in the task prompt
          const plain = await spawn(agent);
          assert.equal(plain.flag, undefined);
          assert.match(plain.task, new RegExp(`You are ${agent}\\.[\\s\\S]*do the task`));
        }
        const fork = await spawn("fork-plain");
        assert.equal(fork.task, "You are fork-plain.\n\ndo the task");
        assert.equal(fork.launch.env.PI_SUBAGENT_SKILLS, "first, second", "the child loads them all with the task");
        assert.equal(fork.running.interactive, false);
        assert.equal(fork.launch.env.PI_SUBAGENT_AUTO_EXIT, "1");
        assert.equal(fork.launch.args[fork.launch.args.indexOf("--tools") + 1], "read,ask_question");
        assert.equal(fork.launch.args[fork.launch.args.indexOf("--model") + 1], "test/model");
        // herdr's integration is always loaded explicitly, so settings cannot exclude it.
        assert.ok(fork.launch.args.some((arg: string, i: number) => fork.launch.args[i - 1] === "-e" && arg.endsWith("herdr-agent-state.ts")));
        assert.equal(fork.launch.args[fork.launch.args.indexOf("--thinking") + 1], "high");
        assert.match(readFileSync(fork.running.sessionFile, "utf8"), /Here is my plan/);
        assert.equal(readEntries(fork.running.sessionFile, 0)[0].parentSession, parent);
        const lineage = await spawn("lineage");
        assert.equal(lineage.running.interactive, true);
        assert.equal(readEntries(lineage.running.sessionFile, 0).length, 1);
        assert.equal(readEntries(lineage.running.sessionFile, 0)[0].parentSession, parent);
        assert.equal((await spawn("interactive")).running.interactive, true);
        assert.equal((await spawn("quiet")).running.interactive, false);
      });
    } finally {
      deps.startAgent = oldStart; deps.watchSubagent = oldWatch;
      testApi.runningSubagents.clear();
      for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  it("refuses to message a subagent that is still starting instead of starting a second pi on it", async () => {
    const testApi = (subagentsModule as any).__test__;
    const deps = testApi.launchDeps;
    const oldStart = deps.startAgent, oldWatch = deps.watchSubagent, oldFind = deps.findSessionAgent;
    const oldEnv = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
    try {
      await withIsolatedAgentEnv(async ({ projectDir, projectAgentsDir }) => {
        Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });
        // Seeded at launch, so its session and loadout exist before pi does.
        writeAgentFile(projectAgentsDir, "seeded", "name: seeded\nsession-mode: lineage-only\nauto-exit: true");
        let starts = 0, childSession!: string, release!: (started: { surface: string; agent: string }) => void;
        deps.startAgent = (launch: any) => { starts++; childSession = launch.env.PI_SUBAGENT_SESSION; return new Promise((resolve) => { release = resolve; }); };
        deps.watchSubagent = async () => ({ summary: "", exitCode: 0, elapsed: 0 });
        deps.findSessionAgent = async () => null;
        const { api, registeredTools } = createMockExtensionApi();
        (subagentsModule as any).default(api);
        const tool = (name: string) => registeredTools.find((item) => item.name === name);
        writeFileSync(join(projectDir, "parent.jsonl"), JSON.stringify(SESSION_HEADER) + "\n");
        const ctx = { cwd: projectDir, sessionManager: { getSessionFile: () => join(projectDir, "parent.jsonl"),
          getSessionDir: () => projectDir, getSessionId: () => "parent-id", getBranch: () => [] } };
        const spawning = tool("subagent").execute("call", { agent: "seeded", task: "do it" }, undefined, undefined, ctx);
        await new Promise((resolve) => setImmediate(resolve));
        const early = await tool("subagent_message").execute("call", { name: "seeded", message: "more" }, undefined, undefined, ctx);
        assert.match(early.details.error, /still starting/);
        assert.equal(starts, 1);
        assert.deepEqual(pendingInboxMessages(childSession), [], "task waits for readiness");
        release({ surface: "w1:p2", agent: "seeded" });
        assert.equal((await spawning).details.status, "started");
        assert.match(consumeInbox(childSession)[0], /do it/);
      });
    } finally {
      deps.startAgent = oldStart; deps.watchSubagent = oldWatch; deps.findSessionAgent = oldFind;
      testApi.runningSubagents.clear(); testApi.startingSessions.clear();
      for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  it("closes an untracked pane when publishing fails after launch or resume", async () => {
    const testApi = subagentsModule.__test__, deps = testApi.launchDeps, saved = { ...deps };
    const env = { ...process.env };
    try {
      await withIsolatedAgentEnv(async ({ projectDir, projectAgentsDir }) => {
        const log = join(projectDir, "closed"), cli = join(projectDir, "herdr");
        writeFileSync(cli, `#!/bin/sh\nif [ "$1 $2" = "pane close" ]; then echo "$3" >> "${log}"; fi\nexec "${env.HERDR_BIN_PATH}" "$@"\n`, { mode: 0o700 });
        Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: cli });
        writeAgentFile(projectAgentsDir, "seeded", "name: seeded\nsession-mode: lineage-only\nauto-exit: true");
        const { api, registeredTools } = createMockExtensionApi();
        subagentsModule.default(api as any);
        const tool = (name: string) => registeredTools.find(item => item.name === name);
        const ctx = { cwd: projectDir, sessionManager: {
          getSessionFile: () => join(projectDir, "parent.jsonl"), getSessionDir: () => projectDir,
          getSessionId: () => "parent-id", getBranch: () => [],
        } };
        deps.startAgent = async (launch: any) => {
          assert.deepEqual(pendingInboxMessages(launch.env.PI_SUBAGENT_SESSION), []);
          writeFileSync(launch.env.PI_SUBAGENT_SESSION + ".inbox", "not a directory");
          return { surface: "w1:p2", agent: "seeded" };
        };
        deps.watchSubagent = async () => assert.fail("failed publication must not start a watcher");
        deps.findSessionAgent = async () => null;
        await assert.rejects(tool("subagent").execute("call", { agent: "seeded", task: "task" }, undefined, undefined, ctx), /EEXIST|ENOTDIR/);
        await assert.rejects(tool("subagent_message").execute("call", { name: "seeded", message: "message" }, undefined, undefined, ctx), /EEXIST|ENOTDIR/);
        assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["w1:p2", "w1:p2"]);
        assert.equal(testApi.runningSubagents.size, 0);
        assert.equal(testApi.startingSessions.size, 0);
      });
    } finally {
      Object.assign(deps, saved);
      testApi.runningSubagents.clear(); testApi.startingSessions.clear();
      process.env = env;
    }
  });

  it("cwd only sets the start directory; a .pi/agent there never replaces the parent's config dir", async () => {
    const testApi = (subagentsModule as any).__test__;
    const deps = testApi.launchDeps;
    const oldStart = deps.startAgent, oldWatch = deps.watchSubagent;
    const oldEnv = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
    try {
      await withIsolatedAgentEnv(async ({ projectDir, projectAgentsDir, globalDir }) => {
        Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });
        writeAgentFile(projectAgentsDir, "cwd-agent", "name: cwd-agent\ncwd: roles/default", "You are cwd-agent.");
        writeAgentFile(projectAgentsDir, "fallback-cwd", "name: fallback-cwd");
        const role = join(projectDir, "roles", "sre");
        mkdirSync(join(role, ".pi", "agent"), { recursive: true });
        const launches: any[] = [];
        deps.startAgent = async (launch: any) => { launches.push(launch); return { surface: "w1:p2", agent: launch.name }; };
        deps.watchSubagent = async () => ({ summary: "", exitCode: 0, elapsed: 0 }); // settles at once
        const { api, registeredTools } = createMockExtensionApi();
        (subagentsModule as any).default(api);
        const tool = registeredTools.find((item) => item.name === "subagent");
        const ctx = { cwd: projectDir, sessionManager: {
          getSessionFile: () => join(projectDir, "parent.jsonl"), getSessionDir: () => projectDir, getSessionId: () => "parent-id" } };
        await tool.execute("call", { agent: "cwd-agent", task: "do it", cwd: role }, undefined, undefined, ctx);
        const [launch] = launches;
        assert.equal(launch.cwd, role);
        assert.equal(launch.env.PI_CODING_AGENT_DIR, globalDir);
        const sessionFile = launch.args[launch.args.indexOf("--session") + 1];
        assert.equal(readSubagentLoadout(sessionFile)?.agentDir, globalDir);
        // A relative config dir is the parent's: the child, started elsewhere, gets it absolute.
        process.env.PI_CODING_AGENT_DIR = "../global";
        await tool.execute("call", { agent: "fallback-cwd", task: "do it", cwd: role }, undefined, undefined, ctx);
        process.env.PI_CODING_AGENT_DIR = globalDir;
        assert.equal(launches.at(-1).env.PI_CODING_AGENT_DIR, globalDir);
        assert.ok(launches.at(-1).args[launches.at(-1).args.indexOf("--session") + 1].startsWith(join(globalDir, "sessions")));
        // An explicit name taken by an earlier subagent is suffixed.
        // Launched in parallel: the registry write before the first await keeps them apart.
        await Promise.all(["sre", "sre"].map((name) =>
          tool.execute("call", { agent: "fallback-cwd", name, task: "do it" }, undefined, undefined, ctx)));
        assert.deepEqual(launches.slice(-2).map((item) => item.name), ["sre", "sre-2"]);
        const contextCwd = join(projectDir, "context");
        // Project agents are found from the session's cwd.
        cpSync(projectAgentsDir, join(contextCwd, ".pi", "agents"), { recursive: true });
        for (const [agent, cwd, expected] of [
          ["cwd-agent", "roles/sre", join(contextCwd, "roles/sre")],
          ["cwd-agent", undefined, join(globalDir, "roles/default")],
          ["fallback-cwd", undefined, contextCwd],
        ]) {
          await tool.execute("call", { agent, cwd, task: "do it" }, undefined, undefined, { ...ctx, cwd: contextCwd });
          const latest = launches.at(-1);
          assert.equal(latest.cwd, expected);
          const snapshot = readSubagentLoadout(latest.args[latest.args.indexOf("--session") + 1]);
          assert.equal(snapshot?.cwd, expected);
          assert.equal(snapshot?.agentDir, globalDir);
        }
      });
    } finally {
      deps.startAgent = oldStart; deps.watchSubagent = oldWatch;
      testApi.runningSubagents.clear();
      for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  it("refuses an allowlisted agent whose definition is missing", () => {
    const moduleUrl = new URL("../pi-extension/subagents/index.ts", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import extension from ${JSON.stringify(moduleUrl)};
      const tools = [];
      extension({ on() {}, registerTool(t) { tools.push(t); }, registerCommand() {}, registerMessageRenderer() {} });
      console.log(JSON.stringify(await tools.find(t => t.name === "subagent").execute("call", { agent: "missing-profile-9a", task: "work" }, undefined, undefined, { cwd: process.cwd() })));
    `], { encoding: "utf8", env: { ...process.env, PI_SUBAGENT_AGENT: "worker", PI_SUBAGENT_ALLOWED: "missing-profile-9a" } });
    const result = JSON.parse(output);
    assert.equal(result.details.error, "agent not in allowlist");
    assert.match(result.content[0].text, /Available agents: \(none\)/);
  });

  it("rejects a top-level spawn naming an unknown agent", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", {
      name: "x",
      task: "do it",
      agent: "wizard",
    }, undefined, undefined, { cwd: process.cwd() });
    assert.equal(result.details?.error, "unknown agent");
    assert.equal(result.isError, true, "Pi and codemode scripts see the call as failed");
    assert.match(result.content[0].text, /not a known agent/i);
  });

  it("exposes a debloated schema: agent+task required, name/model/cwd optional, no override knobs", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const props = subagentTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["agent", "cwd", "model", "name", "task"],
      "only agent/task/name/model/cwd should remain",
    );
    assert.deepEqual(
      [...(subagentTool.parameters.required ?? [])].sort(),
      ["agent", "task"],
      "agent and task must be required",
    );
    // The removed override knobs must be gone.
    for (const gone of ["tools", "skills", "systemPrompt", "fork", "interactive", "resumeSessionId"]) {
      assert.equal(props[gone], undefined, `expected ${gone} param to be removed`);
    }
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_message with name + message both required (name-only addressing)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.ok(messageTool, "expected subagent_message tool to be registered");

    const props = messageTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["message", "name"],
      "name/message only (sessionId dropped)",
    );
    assert.equal(props.message.type, "string");
    assert.equal(props.name.type, "string");
    assert.deepEqual(
      messageTool.parameters.required?.slice().sort(),
      ["message", "name"],
      "name and message should both be required",
    );
    assert.equal(props.sessionId, undefined, "sessionId should be removed");
    assert.equal(props.autoExit, undefined, "autoExit knob should be removed");
  });

  it("replays the loadout snapshot on resume (not the model), refuses without one, guards concurrent starts, and permits retry", async () => {
    const root = createTestDir();
    const oldEnv = { ...process.env };
    const testApi = (subagentsModule as any).__test__;
    const deps = testApi.launchDeps;
    const oldStart = deps.startAgent;
    const oldWatch = deps.watchSubagent;
    const oldFind = deps.findSessionAgent;
    try {
      for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
      Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });

      const parentDir = join(root, "parent");
      const artifactDir = join(parentDir, "artifacts", "parent-id");
      const name = "worker";
      const sessionFile = join(root, "child session.jsonl");
      writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "child-id", version: 3, cwd: root }) + "\n");
      registerName(artifactDir, name, { sessionFile });
      const launchCwd = join(root, "launch-cwd");
      const agentDir = join(root, "agent-dir");
      const { api, registeredTools } = createMockExtensionApi();
      let shutdown!: (...args: any[]) => void;
      api.on = (event: string, handler: any) => { if (event === "session_shutdown") shutdown = handler; };
      (subagentsModule as any).default(api);
      const tool = registeredTools.find((item) => item.name === "subagent_message");
      const ctx = { cwd: root, sessionManager: {
        getSessionFile: () => join(parentDir, "parent.jsonl"),
        getSessionDir: () => parentDir,
        getSessionId: () => "parent-id",
      } };
      const execute = () => tool.execute("call", { name, message: "continue" }, undefined, undefined, ctx);
      let release!: (started: { surface: string; agent: string }) => void;
      const launches: any[] = [];
      deps.startAgent = (launch: any) => { launches.push(launch); return new Promise((resolve) => { release = resolve; }); };
      deps.watchSubagent = async () => ({ name, task: "continue", summary: "ok", exitCode: 0, elapsed: 0 });
      deps.findSessionAgent = async () => null;

      // Without a snapshot, a bare resume would drop the identity and tool restriction.
      const refused = await execute();
      assert.match(refused.details.error, /no loadout snapshot/);
      assert.equal(launches.length, 0);

      writeSubagentLoadout(sessionFile, {
        agent: "profile-no-longer-present",
        toolAllowlist: "read,ask_question",
        systemPromptMode: "append",
        identity: "You are a scout.",
        spawnable: ["scout"],
        interactive: true,
        cwd: launchCwd,
        agentDir,
      });
      for (const message of ["", " \n\t "]) {
        const empty = await tool.execute("call", { name, message }, undefined, undefined, ctx);
        assert.match(empty.details.error, /`message` is required/);
        assert.equal(launches.length, 0);
      }
      const first = execute();
      const second = await execute();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(launches.length, 1);
      assert.match(second.details.error, /still starting/);
      assert.deepEqual(pendingInboxMessages(sessionFile), [], "resume waits for readiness");
      release({ surface: "w1:p7", agent: "worker" });
      const started = await first;
      assert.equal(started.details.status, "started");
      assert.equal(started.details.pane, "w1:p7");
      assert.equal([...testApi.runningSubagents.values()][0].interactive, false);
      const [launch] = launches;
      assert.equal(launch.cwd, launchCwd);
      const args: string[] = launch.args;
      assert.deepEqual(args.slice(0, 4), ["--session", sessionFile, "-e", fileURLToPath(new URL("../pi-extension/subagents/subagent-done.ts", import.meta.url))]);
      // The session restores model/thinking; replaying --model would undo a later switch.
      assert.equal(args.includes("--model"), false);
      assert.equal(readFileSync(args[args.lastIndexOf("--append-system-prompt") + 1], "utf8"), "You are a scout.");
      assert.equal(args[args.indexOf("--tools") + 1], "read,ask_question");
      assert.ok(args.includes(fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url))), "delegation helper replayed");
      const published = pendingInboxMessages(sessionFile).map(file => JSON.parse(readFileSync(file, "utf8")));
      assert.equal(published.length, 1);
      assert.equal(published[0].id, undefined);
      assert.equal(published[0].message, "continue");
      assert.equal(launch.prompt, undefined);
      assert.deepEqual(launch.env, {
        PI_SUBAGENT_NAME: name,
        PI_SUBAGENT_SESSION: sessionFile,
        PI_SUBAGENT_ALLOWED: "scout",
        PI_SUBAGENT_AGENT: "profile-no-longer-present",
        PI_CODING_AGENT_DIR: agentDir,
        PI_SUBAGENT_AUTO_EXIT: "1",
      });

      testApi.runningSubagents.clear();
      let attempts = 0;
      deps.startAgent = async () => {
        if (++attempts === 1) throw new Error("agent start failed");
        return { surface: "w1:p8", agent: "worker" };
      };
      await assert.rejects(execute(), /agent start failed/);
      assert.equal(testApi.startingSessions.has(sessionFile), false);
      assert.equal((await execute()).details.status, "started", "a failed start must permit retry");

      // The native transcript is authoritative for completion details.
      const active = [...testApi.runningSubagents.values()][0];
      writeFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider unavailable" } }) + "\n", { flag: "a" });
      writeFileSync(sessionFile + ".exit", JSON.stringify({ type: "error", errorMessage: "provider unavailable" }), "utf8");
      const failed = await oldWatch(active, new AbortController().signal, { close: () => {} });
      assert.equal(failed.exitCode, 1);
      assert.equal(failed.errorMessage, "provider unavailable");
      assert.equal(testApi.runningSubagents.size, 0);
      assert.equal(existsSync(sessionFile + ".exit"), false);
      assert.equal((await execute()).details.status, "started", "provider error completion must permit resume");

      // A resumed run is autonomous, and its snapshot says so for a parent that takes it back.
      assert.equal(readSubagentLoadout(sessionFile)?.interactive, false);
      // An interactive child never resumed keeps its policy when taken back.
      writeSubagentLoadout(sessionFile, { ...readSubagentLoadout(sessionFile)!, interactive: true });

      // Still running, but untracked (this parent restarted): steer it instead of starting a second pi on it.
      testApi.runningSubagents.clear();
      const steered: string[] = [];
      deps.findSessionAgent = async (file: string) => (file === sessionFile ? { agent: "worker-live", pane: "w1:p5" } : null);
      consumeInbox(sessionFile); // the earlier stub starts never read their tasks
      deps.watchSubagent = async (_child: any, signal: AbortSignal) => {
        await delay(5);
        steered.push(...consumeInbox(sessionFile));
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        return { summary: "ok", exitCode: 0, elapsed: 0 };
      };
      deps.startAgent = async () => assert.fail("a live session must not be started again");
      const cancelLookup = new AbortController();
      deps.findSessionAgent = async (file: string) => { cancelLookup.abort(); return file === sessionFile ? { agent: "worker-live", pane: "w1:p5" } : null; };
      await assert.rejects(tool.execute("call", { name, message: "continue" }, cancelLookup.signal, undefined, ctx), /abort/i);
      assert.deepEqual(steered, [], "a cancelled call neither adopts nor steers the live child");
      assert.equal(testApi.runningSubagents.size, 0);
      deps.findSessionAgent = async (file: string) => (file === sessionFile ? { agent: "worker-live", pane: "w1:p5" } : null);
      const reattached = await execute();
      assert.equal(reattached.details.status, "steered");
      assert.deepEqual(steered, ["continue"]);
      assert.deepEqual([...testApi.runningSubagents.values()].map((r) => [r.herdrName, r.surface, r.interactive]), [["worker-live", "w1:p5", true]],
        "a child taken back keeps its supervision setting");
      // A reattached child that finishes as the message is sent is resumed too.
      for (const child of testApi.runningSubagents.values()) child.abortController?.abort();
      testApi.runningSubagents.clear();
      deps.watchSubagent = async (child: any) => {
        await delay(5);
        testApi.runningSubagents.delete(child.id);
        return { summary: "ok", exitCode: 0, elapsed: 0 };
      };
      deps.startAgent = async () => ({ surface: "w1:p6", agent: "worker" });
      assert.equal((await execute()).details.status, "started");
      deps.findSessionAgent = async () => null;

      // Finishing with the inbox unread: resume once reported.
      testApi.runningSubagents.clear();
      let racedReport = false;
      testApi.runningSubagents.set("racing", { id: "racing", name, task: "t", surface: "w1:p6", herdrName: "worker-racing", startTime: 0, sessionFile, interactive: false,
        watching: delay(5).then(() => { racedReport = true; testApi.runningSubagents.delete("racing"); }) });
      deps.startAgent = async () => ({ surface: "w1:p6", agent: "worker" });
      const raced = await execute();
      assert.equal(racedReport, true);
      assert.equal(raced.details.status, "started");

      // Clear stale markers and unread inbox files before resuming.
      testApi.runningSubagents.clear();
      for (const marker of [".exit", ".exiting", ".paused"]) writeFileSync(sessionFile + marker, "{}");
      publishQuestion(sessionFile, "obsolete");
      consumeInbox(sessionFile);
      const pending = publishInboxMessage(sessionFile, "unacknowledged");
      deps.startAgent = async () => {
        for (const marker of [".exit", ".exiting", ".paused", ".ask", ".inbox"]) assert.equal(existsSync(sessionFile + marker), false);
        assert.equal(existsSync(pending), false);
        return { surface: "w1:p6", agent: "worker" };
      };
      assert.equal((await execute()).details.status, "started");
      assert.deepEqual(consumeInbox(sessionFile), ["continue"]);

      // Finished, but tracked until its watcher reports it: the message waits for that, then resumes.
      testApi.runningSubagents.clear();
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
      let reported = false;
      testApi.runningSubagents.set("finishing", { id: "finishing", name, task: "t", surface: "w1:p6", startTime: 0, sessionFile, interactive: false,
        watching: delay(5).then(() => { reported = true; testApi.runningSubagents.delete("finishing"); rmSync(`${sessionFile}.exit`); }) });
      deps.startAgent = async () => ({ surface: "w1:p6", agent: "worker" });
      const resumedAfter = await execute();
      assert.equal(reported, true);
      assert.equal(resumedAfter.details.status, "started");

      // Escape during a start abandons it and closes the pane instead of tracking it.
      testApi.runningSubagents.clear();
      let startSignal!: AbortSignal;
      deps.startAgent = (_launch: any, signal: AbortSignal) => { startSignal = signal; return new Promise((resolve) => { release = resolve; }); };
      const escape = new AbortController();
      const escaped = tool.execute("call", { name, message: "continue" }, escape.signal, undefined, ctx);
      await new Promise((resolve) => setImmediate(resolve));
      escape.abort();
      assert.equal(startSignal.aborted, true, "the start sees the cancellation");
      release({ surface: "w1:p9", agent: "worker" });
      await assert.rejects(escaped, /abort/i);
      assert.equal(testApi.runningSubagents.size, 0);

      // Shutdown during a start closes the late pane instead of tracking it.
      testApi.runningSubagents.clear();
      const moduleKey = Symbol.for("pi-subagents/poll-abort-controller");
      const originalController = (globalThis as any)[moduleKey];
      (globalThis as any)[moduleKey] = new AbortController();
      try {
        deps.startAgent = () => new Promise((resolve) => { release = resolve; });
        const pending = execute();
        await new Promise((resolve) => setImmediate(resolve));
        shutdown({}, {});
        release({ surface: "w1:p9", agent: "worker" });
        await assert.rejects(pending, /aborted/i);
        assert.equal(testApi.runningSubagents.size, 0);
        assert.equal(testApi.startingSessions.size, 0);
      } finally {
        (globalThis as any)[moduleKey] = originalController;
      }
    } finally {
      deps.startAgent = oldStart;
      deps.watchSubagent = oldWatch;
      deps.findSessionAgent = oldFind;
      testApi.runningSubagents.clear();
      testApi.startingSessions.clear();
      process.env = oldEnv;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("adopted profile and lifecycle designs", () => {
  const testApi = subagentsModule.__test__;

  it("inherits model/thinking on launch, preserves configured skills and validates names", async () => {
    const deps = testApi.launchDeps, saved = { ...deps };
    const env = { ...process.env };
    try {
      Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });
      await withIsolatedAgentEnv(async ({ projectDir, projectAgentsDir }) => {
        const launches: any[] = [];
        deps.startAgent = async (launch) => { launches.push(launch); return { surface: "w1:p8", agent: launch.name }; };
        deps.watchSubagent = async () => ({ summary: "ok", exitCode: 0, elapsed: 0 });
        writeAgentFile(projectAgentsDir, "isolated", "name: isolated\nskill: first");
        writeAgentFile(projectAgentsDir, "chosen", "name: chosen\nmodel: profile/model\nthinking: off");
        for (const mode of ["fork", "lineage-only"]) writeAgentFile(projectAgentsDir, mode, `name: ${mode}\nsession-mode: ${mode}`);
        const parent = createSessionFile(projectDir, [SESSION_HEADER]);
        const { api, registeredTools } = createMockExtensionApi();
        api.getThinkingLevel = () => "high";
        subagentsModule.default(api);
        const tool = registeredTools.find(tool => tool.name === "subagent");
        const ctx = { cwd: projectDir, model: { provider: "current", id: "model" }, sessionManager: {
          getSessionFile: () => parent, getSessionDir: () => projectDir, getSessionId: () => "parent", getBranch: () => [] } };
        for (const name of ["a\nb", "a\tb", "a\x1bb", "a".repeat(65)]) {
          const result = await tool.execute("bad", { agent: "isolated", name, task: "work" }, undefined, undefined, ctx);
          assert.match(result.details.error, /single line of 1–64/);
        }
        assert.equal(launches.length, 0);
        await tool.execute("empty-name", { agent: "isolated", name: "", task: "work" }, undefined, undefined, ctx);
        await tool.execute("trimmed-name", { agent: "isolated", name: " spaced ", task: "work" }, undefined, undefined, ctx);
        assert.deepEqual(launches.map(launch => launch.name), ["isolated", "spaced"]);
        launches.length = 0;
        testApi.runningSubagents.clear();
        const result = await tool.execute("start", { agent: "isolated", task: "work", name: "a".repeat(64) }, undefined, undefined, ctx);
        const args = launches[0].args;
        assert.equal(args[args.indexOf("--model") + 1], "current/model");
        assert.equal(args[args.indexOf("--thinking") + 1], "high");
        assert.ok(!args.some(flag => ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"].includes(flag)));
        assert.ok(args.some((arg: string) => arg.endsWith("subagent-done.ts")));
        assert.equal(launches[0].env.PI_SUBAGENT_SKILLS, "first", "configured skills remain enabled");
        const loadout = readSubagentLoadout(result.details.sessionFile)!;
        const resumed: string[] = [];
        testApi.applyLoadoutToArgs(resumed, loadout, result.details.sessionFile);
        assert.ok(!resumed.some(flag => flag.startsWith("--no-")));
        assert.ok(!resumed.includes("--model") && !resumed.includes("--thinking"));
        assert.equal(testApi.uniqueRunningName("a".repeat(64), new Set(["a".repeat(64)])), "a".repeat(62) + "-2");
        await tool.execute("override", { agent: "isolated", task: "work", model: "chosen/model" }, undefined, undefined, ctx);
        assert.equal(launches[1].args[launches[1].args.indexOf("--model") + 1], "chosen/model");
        await tool.execute("profile", { agent: "chosen", task: "work" }, undefined, undefined, ctx);
        assert.equal(launches[2].args[launches[2].args.indexOf("--model") + 1], "profile/model");
        assert.equal(launches[2].args[launches[2].args.indexOf("--thinking") + 1], "off");
        for (const mode of ["fork", "lineage-only"]) {
          const seeded = await tool.execute(mode, { agent: mode, task: "work" }, undefined, undefined, ctx);
          const args = launches.at(-1).args;
          assert.equal(args[args.indexOf("--model") + 1], "current/model");
          assert.equal(args[args.indexOf("--thinking") + 1], "high");
          assert.equal(readEntries(seeded.details.sessionFile)[0].parentSession, parent);
        }
      });
    } finally { Object.assign(deps, saved); process.env = env; testApi.runningSubagents.clear(); testApi.unconsumed.clear(); }
  });

  it("creates private files and directories without chmodding existing ones", () => {
    withTempDir(dir => {
      const session = join(dir, "owned", "child.jsonl");
      seedSubagentSessionFile({ mode: "lineage-only", parentSessionFile: "parent", parentBranch: [], childSessionFile: session, childCwd: dir });
      const loadout: SubagentLoadout = { agent: null, toolAllowlist: null, systemPromptMode: null, identity: null, spawnable: null, cwd: null, agentDir: null };
      writeSubagentLoadout(session, loadout);
      const artifact = join(dir, "artifacts", "parent");
      registerName(artifact, "child", { sessionFile: session });
      publishQuestion(session, "private question");
      const inbox = publishInboxMessage(session, "private message");
      testApi.applyLoadoutToArgs([], { identity: "private identity", systemPromptMode: "append" }, session);
      for (const file of [session, loadoutSidecarPath(session), nameRegistryPath(artifact), inbox, pendingQuestions(session).files[0], session + ".identity.md"]) {
        assert.equal(statSync(file).mode & 0o777, 0o600, file);
      }
      for (const path of [join(dir, "owned"), join(dir, "artifacts"), artifact, session + ".inbox", session + ".ask"]) assert.equal(statSync(path).mode & 0o777, 0o700, path);
      chmodSync(loadoutSidecarPath(session), 0o644);
      chmodSync(session + ".inbox", 0o755);
      writeSubagentLoadout(session, loadout);
      publishInboxMessage(session, "next");
      assert.equal(statSync(loadoutSidecarPath(session)).mode & 0o777, 0o644);
      assert.equal(statSync(session + ".inbox").mode & 0o777, 0o755);
      writeFileSync(loadoutSidecarPath(session), JSON.stringify({ ...loadout, extensions: false, skillsEnabled: "old" }));
      assert.ok(readSubagentLoadout(session), "older isolation fields are ignored");
    });
  });

  it("lists available agent definitions only", async () => {
    const dir = createTestDir();
    const { api, registeredTools } = createMockExtensionApi();
    subagentsModule.default(api);
    try {
      writeAgentFile(join(dir, ".pi", "agents"), "scout", "name: scout");
      const listed = await registeredTools.find(tool => tool.name === "subagents_list").execute("list", {}, undefined, undefined, { cwd: dir });
      assert.match(listed.content[0].text, /• scout/);
      assert.equal(listed.details.running, undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      herdrName: "worker",
      interactive: false,
      ...overrides,
    };
  }

  it("registers subagent_message and not the old interrupt/resume tools", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_message"), true);
    assert.equal(names.includes("subagent_interrupt"), false);
    assert.equal(names.includes("subagent_resume"), false);
  });

  it("uniqueRunningName suffixes defaulted names that collide with running subagents", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      // No collision: base name is returned untouched.
      assert.equal(testApi.uniqueRunningName("worker"), "worker");

      runningMap.set("a1", makeRunning({ id: "a1", name: "worker", surface: "a1" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-2");

      runningMap.set("b2", makeRunning({ id: "b2", name: "worker-2", surface: "b2" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-3");

      // A distinct base is unaffected by the worker collisions.
      assert.equal(testApi.uniqueRunningName("scout"), "scout");
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName also avoids names already taken in the persistent registry", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      // A finished subagent's name lives in the registry even though nothing is
      // running — a fresh default must skip it so names stay unique session-wide.
      const registryNames = new Set(["worker", "worker-2"]);
      assert.equal(testApi.uniqueRunningName("worker", registryNames), "worker-3");
      // A name not in the registry (or running/reserved) is unaffected.
      assert.equal(testApi.uniqueRunningName("scout", registryNames), "scout");
      // An empty registry behaves like before.
      assert.equal(testApi.uniqueRunningName("worker", new Set()), "worker");
    } finally {
      runningMap.clear();
    }
  });

  it("delivers a multi-line steer through the inbox, independent of pane moves", async () => {
    const testApi = (subagentsModule as any).__test__;
    const dir = createTestDir();
    const sessionFile = join(dir, "child.jsonl");
    const child = makeRunning({ sessionFile, surface: "w2:p1" });
    testApi.runningSubagents.set(child.id, child);
    try {
      const waiting = testApi.steerLive(child, "do this\nthen that");
      assert.deepEqual(consumeInbox(sessionFile), ["do this\nthen that"]);
      const result = await waiting;
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "steered" });
      assert.match(result.content[0].text, /next turn boundary/);
      assert.equal(testApi.runningSubagents.has(child.id), true);
      rmSync(`${sessionFile}.inbox`, { recursive: true });
      writeFileSync(`${sessionFile}.inbox`, "not a directory");
      assert.match((await testApi.steerLive(child, "hi")).details.error, /Failed to deliver/);
    } finally {
      testApi.runningSubagents.clear();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects empty messages before either steering or resuming", async () => {
    const testApi = (subagentsModule as any).__test__;
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const tool = registeredTools.find(t => t.name === "subagent_message");
    try {
      for (const active of [false, true]) {
        if (active) testApi.runningSubagents.set("a1", makeRunning());
        for (const message of [undefined, "", " \n\t "]) {
          const result = await tool.execute("call", { name: "Worker", message });
          assert.match(result.details.error, /`message` is required/);
        }
      }
    } finally {
      testApi.runningSubagents.clear();
    }
  });

  it("reports a subagent ended early by hand", async () => {
    const testApi = (subagentsModule as any).__test__;
    const text = testApi.resolveResultPresentation({ exitCode: 1, elapsed: 30, summary: "half done", endedEarly: true }, "Worker");
    assert.match(text, /ended in its pane before it finished.*\n\nhalf done/s);
  });

  it("does not synthesize pause sidecar notifications", async () => {
    const testApi = (subagentsModule as any).__test__;
    const dir = createTestDir();
    const sessionFile = join(dir, "s.jsonl");
    const { api } = createMockExtensionApi();
    const sent: any[] = [];
    api.sendMessage = (message: any) => { sent.push(message); };
    (subagentsModule as any).default(api);
    await testApi.watchSubagent(makeRunning({ sessionFile }), new AbortController().signal, {
      wait: async (_surface: string, _signal: AbortSignal, options: any) => { options.onTick("idle"); return { reason: "done", exitCode: 0 }; },
      close: () => {},
    });
    assert.equal(sent.filter((m) => m.customType === "subagent_status").length, 0);
    assert.equal(existsSync(`${sessionFile}.paused`), false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-abc",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    // Follow-ups reference the name (not the session id).
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const failed = (summary: string) => testApi.resolveResultPresentation(
      { exitCode: 1, elapsed: 14, summary, sessionFile: "/tmp/subagent.jsonl", sessionId: "019f-xyz",
        errorMessage: "Anthropic 529 Overloaded after 3 retries" },
      "Worker",
    );
    // The text is all the parent model receives: a partial answer travels with the error.
    const partial = failed("Found the bug in auth.ts:42; was checking the tests when");
    assert.match(partial, /Sub-agent "Worker" failed/);
    assert.match(partial, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(partial, /Partial answer — not a completed result:\n\nFound the bug in auth.ts:42/);
    assert.match(partial, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(partial, /Session id:/);
    const none = failed("Subagent error: Anthropic 529 Overloaded after 3 retries");
    assert.match(none, /did not produce a result/);
    assert.doesNotMatch(none, /Partial answer/);
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders one status notice without an expand hint, including old messages", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const renderer = registeredMessageRenderers.find(entry => entry.name === "subagent_status").renderer;
    const line = "Worker: blocked at a dialog in pane w1:p2";
    for (const details of [{ line }, { lines: [line], overflow: 0 }]) {
      const rendered = renderer({ details }, { expanded: false }, createTheme());
      const output = rendered.render(80).join("\n");
      assert.match(output, /Subagent status/);
      assert.ok(output.includes(line));
      assert.doesNotMatch(output, /to expand/);
      assert.notEqual(rendered.render(80)[0], "", "no extra spacer before the box");
    }
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { line: "Worker running 5m, active (bash 2m)." },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("result and question renderers", () => {
  before(() => initTheme("dark"));
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
  const plain = (lines: string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trim()).join("");

  it("escapes quotes and backslashes in every generated name argument", async () => {
    const dir = createTestDir(), sessionFile = join(dir, "quoted.jsonl");
    const name = 'review "auth" \\ paths', argument = `name: ${JSON.stringify(name)}, message: "…"`;
    const testApi = subagentsModule.__test__;
    const { api, registeredMessageRenderers, sentMessages } = createMockExtensionApi();
    subagentsModule.default(api);
    const child = { id: "quoted", name, task: "t", surface: "w1:p3", herdrName: "quoted", startTime: Date.now(), sessionFile, interactive: false };
    try {
      const result = { exitCode: 0, elapsed: 1, summary: "done" };
      assert.ok(testApi.resolveResultPresentation(result, name).includes(argument));
      publishQuestion(sessionFile, "Which way?");
      writeFileSync(sessionFile + ".paused", "{}");
      await testApi.watchSubagent(child, new AbortController().signal, {
        wait: async (_agent, _signal, options) => { options.onTick("idle"); return { reason: "done", exitCode: 0 }; },
        close: () => {},
      });
      assert.equal(sentMessages.length, 2, "question and interruption instructions");
      for (const { message } of sentMessages) assert.ok(message.content.includes(argument), message.content);
      for (const type of ["subagent_result", "subagent_question"]) {
        const renderer = registeredMessageRenderers.find(entry => entry.name === type).renderer;
        const message = { content: "", details: { ...result, name, question: "Which way?" } };
        assert.ok(plain(renderer(message, { expanded: true }, theme).render(512)).includes(argument));
      }
    } finally {
      testApi.undelivered.clear(); testApi.queued.clear();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps complete expanded content and safely truncates collapsed ANSI/wide previews", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const text = "A界🙂".repeat(30) + "TAIL_MARKER";
    const summary = `\x1b[31m${text}\x1b[0m`;
    for (const type of ["subagent_result", "subagent_question"]) {
      const renderer = registeredMessageRenderers.find(entry => entry.name === type).renderer;
      const message = { content: "not the summary", details: { name: "Worker", summary, question: summary, elapsed: 1 } };
      const expanded = renderer(message, { expanded: true }, theme).render(24);
      assert.ok(plain(expanded).includes(text), `${type} must not lose wrapped text`);
      assert.notEqual(expanded[0], "", "no extra spacer before the box");
      const collapsed = renderer(message, { expanded: false }, theme).render(24);
      assert.ok(plain(collapsed).includes("..."));
      assert.ok(!plain(collapsed).includes("TAIL_MARKER"));
      for (const line of [...expanded, ...collapsed]) assert.ok(visibleWidth(line) <= 24);
    }
  });

  it("uses the saved summary, preserves empty summaries, and renders legacy result messages", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const renderer = registeredMessageRenderers.find(entry => entry.name === "subagent_result").renderer;
    const testApi = (subagentsModule as any).__test__;
    for (const extra of [{ exitCode: 0 }, { exitCode: 1 }, { exitCode: 1, endedEarly: true }, { exitCode: 1, errorMessage: "PROVIDER_ERROR" }]) {
      const details = { name: "Worker", elapsed: 3, ...extra };
      const content = testApi.resolveResultPresentation({ ...details, summary: "ACTUAL_SUMMARY" }, details.name);
      const old = plain(renderer({ content, details }, { expanded: true }, theme).render(80));
      assert.ok(old.includes(extra.errorMessage ? "PROVIDER_ERROR" : "ACTUAL_SUMMARY"));
      assert.ok(!old.includes('Sub-agent "Worker"'), "legacy display strips the generated label");
      const fresh = plain(renderer({ content, details: { ...details, summary: "SAVED_SUMMARY" } }, { expanded: true }, theme).render(80));
      assert.ok(fresh.includes("SAVED_SUMMARY"));
      assert.ok(!fresh.includes("ACTUAL_SUMMARY"));
      const empty = plain(renderer({ content, details: { ...details, summary: "" } }, { expanded: true }, theme).render(80));
      assert.ok(!empty.includes("ACTUAL_SUMMARY"));
    }
    // A partial answer does not hide the provider's error, collapsed or expanded.
    const details = { name: "Worker", elapsed: 3, exitCode: 1, errorMessage: "PROVIDER_ERROR", summary: "PARTIAL_ANSWER" };
    for (const expanded of [false, true]) {
      const text = plain(renderer({ content: "", details }, { expanded }, theme).render(80));
      assert.ok(text.includes("PROVIDER_ERROR") && text.includes("PARTIAL_ANSWER"), text);
    }
  });
});

describe("running-subagents widget", () => {
  const testApi = (subagentsModule as any).__test__;
  const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

  it("shows elapsed time, name, agent and herdr state, with the current tool while working", () => {
    withTempDir((d) => {
      const sessionFile = join(d, "child.jsonl");
      const call = (name: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id: "1", name }] } });
      writeFileSync(sessionFile, [JSON.stringify({ type: "session", id: "s" }), call("read"),
        JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "read" } }), call("bash")].join("\n") + "\n");
      assert.equal(currentTool(sessionFile), "bash");
      const agents = [
        { name: "Sleeper", agent: "worker", startTime: 0, status: "working", sessionFile },
        { name: "Scout", startTime: 52_000, status: "blocked", sessionFile: join(d, "missing.jsonl") },
        { name: "Fresh", startTime: 59_000, sessionFile },
      ];
      const colors: string[] = [];
      const theme = { fg: (color: string, text: string) => { colors.push(color); return `\x1b[35m${text}\x1b[0m`; } };
      const lines = testApi.renderSubagentWidgetLines(agents, 60, theme, 70_000).map(strip);
      assert.match(lines[0], /Subagents .* 3 running/);
      assert.match(lines[1], /01:10 {2}Sleeper \(worker\) +working · bash │$/);
      assert.match(lines[2], /00:18 {2}Scout +blocked │$/);
      assert.match(lines[3], /starting │$/);
      assert.ok(["accent", "error", "dim", "warning"].every(color => colors.includes(color)), "widget uses the supplied active theme");
      for (const width of [60, 30, 12, 4]) {
        for (const line of testApi.renderSubagentWidgetLines(agents, width, theme, 70_000)) assert.equal(visibleWidth(line), width);
      }
    });
  });

  it("reports no tool once the call has a result or the session is gone", () => {
    withTempDir((d) => {
      const sessionFile = join(d, "child.jsonl");
      writeFileSync(sessionFile, [
        JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash" }] } }),
        JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "bash" } }),
      ].join("\n"));
      assert.equal(currentTool(sessionFile), undefined);
      assert.equal(currentTool(join(d, "missing.jsonl")), undefined);
    });
  });
});

describe("subagent display helpers", () => {
  const testApi = (subagentsModule as any).__test__;

  describe("formatTokens", () => {
    it("renders raw counts below 1k, 1 decimal below 10k, rounded k above", () => {
      assert.equal(testApi.formatTokens(850), "850");
      assert.equal(testApi.formatTokens(3200), "3.2k");
      assert.equal(testApi.formatTokens(45000), "45k");
    });
  });

  describe("formatContextUsage", () => {
    it("shows a percent gauge when the window is known", () => {
      assert.equal(testApi.formatContextUsage(36_000, 200_000), "18.0%/200k");
      assert.equal(testApi.formatContextUsage(500_000, 1_000_000), "50.0%/1.0M");
    });

    it("falls back to a window-less ctx label when unknown", () => {
      assert.equal(testApi.formatContextUsage(37_000, undefined), "37k ctx");
    });
  });

  describe("formatUsageSegments", () => {
    it("emits arrow/cache/cost segments, skipping zero fields", () => {
      const segs = testApi.formatUsageSegments({
        model: "claude-sonnet-4-6",
        toolCount: 3,
        inputTokens: 3200,
        outputTokens: 890,
        cacheReadTokens: 45000,
        cacheWriteTokens: 0,
        contextTokens: 7000,
        cost: 0.042,
      });
      assert.deepEqual(segs, ["↑3.2k", "↓890", "R45k", "$0.042"]);
    });

    it("returns an empty list when there is no usage", () => {
      assert.deepEqual(
        testApi.formatUsageSegments({
          model: null,
          toolCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          contextTokens: 0,
          cost: 0,
        }),
        [],
      );
    });
  });

});

describe("watchSubagent", () => {
  const testApi = (subagentsModule as any).__test__;
  const running = { id: "watch-test", name: "watch-test", task: "task", surface: "w1:p9", startTime: Date.now(), sessionFile: "/missing-session", interactive: false } as any;

  it("collects Pi completion and closes the pane pi left at its shell prompt", async () => {
    let closed = false;
    const result = await testApi.watchSubagent(running, new AbortController().signal, {
      wait: async () => ({ reason: "done", exitCode: 0 }),
      close: () => { closed = true; },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(closed, true);
    assert.match(result.summary, /without output/);
  });

  it("delivers a completed result without closing a pane whose session was replaced", async () => {
    const root = createTestDir();
    const sessionFile = join(root, "replaced.jsonl");
    writeFileSync(sessionFile + ".exit", JSON.stringify({ type: "done", summary: "Original answer" }));
    const child = { ...running, sessionFile };
    testApi.runningSubagents.set(child.id, child);
    try {
      const result = await testApi.watchSubagent(child, new AbortController().signal, {
        wait: async () => ({ reason: "done", exitCode: 0, summary: "Original answer", preservePane: true }),
        close: () => assert.fail("must not close a reused pane"),
      });
      assert.equal(result.summary, "Original answer");
      assert.equal(result.exitCode, 0);
      assert.equal(testApi.runningSubagents.has(child.id), false);
      assert.equal(existsSync(sessionFile + ".exit"), false);
    } finally {
      testApi.runningSubagents.delete(child.id);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps completed results and pane ownership when removing a marker fails", async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, "warn", (message: string) => warnings.push(message));
    for (const preservePane of [false, true]) {
      const root = createTestDir(), sessionFile = join(root, "cleanup.jsonl");
      // rmSync without recursive fails on a directory, even when tests run as root.
      mkdirSync(sessionFile + ".exiting");
      const closed: string[] = [];
      try {
        const result = await testApi.watchSubagent({ ...running, sessionFile }, new AbortController().signal, {
          wait: async () => ({ reason: "done", exitCode: 0, summary: "Original answer", preservePane }),
          close: (pane: string) => { closed.push(pane); },
        });
        assert.equal(result.summary, "Original answer");
        assert.equal(result.exitCode, 0);
        assert.deepEqual(closed, preservePane ? [] : [running.surface]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every(message => message.includes("Could not remove subagent marker")));
  });

  it("closes and untracks tasks on caller abort and module abort", async () => {
    const closed: string[] = [];
    const close = (surface: string) => { closed.push(surface); };
    const wait = (_surface: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      if (signal.aborted) reject(new Error("aborted"));
    });

    const userAbort = new AbortController();
    userAbort.abort();
    assert.equal((await testApi.watchSubagent(running, userAbort.signal, { wait, close })).summary, "Subagent cancelled.");
    assert.deepEqual(closed, ["w1:p9"]);

    const moduleKey = Symbol.for("pi-subagents/poll-abort-controller");
    const original = (globalThis as any)[moduleKey];
    const moduleAbort = new AbortController();
    (globalThis as any)[moduleKey] = moduleAbort;
    moduleAbort.abort();
    const shutdownAbort = new AbortController(); // session shutdown aborts each watcher's own controller too
    shutdownAbort.abort();
    try {
      assert.equal((await testApi.watchSubagent(running, shutdownAbort.signal, { wait, close })).summary, "Subagent cancelled.");
    } finally {
      (globalThis as any)[moduleKey] = original;
    }
    assert.deepEqual(closed, ["w1:p9", "w1:p9"]);
  });

  it("leaves a handed-off pane open when its watcher is aborted", async () => {
    const closed: string[] = [];
    const wait = (_target: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      if (signal.aborted) reject(new Error("aborted"));
    });
    const aborted = new AbortController();
    aborted.abort();
    const handedOff = { ...running, handedOff: true };
    assert.equal((await testApi.watchSubagent(handedOff, aborted.signal, { wait, close: pane => closed.push(pane) })).summary, "Subagent cancelled.");
    assert.deepEqual(closed, []);
    assert.equal((await testApi.watchSubagent({ ...running }, aborted.signal, { wait, close: pane => closed.push(pane) })).summary, "Subagent cancelled.");
    assert.deepEqual(closed, ["w1:p9"]);
  });

  it("keeps the exit marker when /reload hands the subagent over while its pane closes", async () => {
    const root = createTestDir();
    const sessionFile = join(root, "closing.jsonl");
    writeFileSync(sessionFile, [USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
    const child = { ...running, sessionFile };
    try {
      await testApi.watchSubagent(child, new AbortController().signal, {
        wait: async () => ({ reason: "done", exitCode: 0 }),
        close: async () => { child.handedOff = true; }, // shutdown(reload) runs during the close
      });
      assert.ok(existsSync(`${sessionFile}.exit`), "the reloaded watcher still finds the result");
      await testApi.watchSubagent({ ...running, sessionFile }, new AbortController().signal, {
        wait: async () => ({ reason: "done", exitCode: 0 }), close: () => {},
      });
      assert.ok(!existsSync(`${sessionFile}.exit`), "a delivered result consumes its marker");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the answer the child read from its active branch", async () => {
    const answer = async () => ({ reason: "done", exitCode: 0, summary: "From the active branch." });
    assert.equal((await testApi.watchSubagent({ ...running }, new AbortController().signal, { wait: answer, close: () => {} })).summary,
      "From the active branch.");
    const silent = async () => ({ reason: "done", exitCode: 0 });
    assert.equal((await testApi.watchSubagent({ ...running }, new AbortController().signal, { wait: silent, close: () => {} })).summary,
      "Sub-agent exited without output");
  });

  it("waits on the herdr agent name and closes the pane it moved to", async () => {
    const closed: string[] = [];
    let waitedOn = "";
    const moved = { ...running, id: "moved-test", herdrName: "watch-test" };
    await testApi.watchSubagent(moved, new AbortController().signal, {
      wait: async (target: string, _signal: AbortSignal, options: any) => {
        waitedOn = target;
        options.onTick("working", "w2:p1");
        return { reason: "done", exitCode: 0 };
      },
      close: (surface: string) => { closed.push(surface); },
    });
    assert.equal(waitedOn, "watch-test");
    assert.deepEqual(closed, ["w2:p1"]);
    assert.equal(moved.surface, "w2:p1");
  });

  it("keeps the last status when a status check gets no answer", async () => {
    const uncertain = { ...running, id: "uncertain-test", status: "working" };
    const result = await testApi.watchSubagent(uncertain, new AbortController().signal, {
      wait: async (_target: string, _signal: AbortSignal, options: any) => {
        options.onTick(null);
        return { reason: "done", exitCode: 0 };
      },
      close: () => {},
    });
    assert.equal(uncertain.status, "working");
    assert.equal(result.exitCode, 0);
  });

  it("wakes the parent once when a non-interactive subagent becomes blocked", async () => {
    const { api } = createMockExtensionApi();
    const sent: any[] = [];
    api.sendMessage = (message: any) => { sent.push(message); };
    (subagentsModule as any).default(api);
    const blocked = { ...running, id: "blocked-test" };
    await testApi.watchSubagent(blocked, new AbortController().signal, {
      wait: async (_surface: string, _signal: AbortSignal, options: any) => {
        for (const status of ["working", "blocked", "blocked", "working", "blocked"]) options.onTick(status);
        return { reason: "done", exitCode: 0 };
      },
      close: () => {},
    });
    assert.equal(sent.filter((m) => m.customType === "subagent_status").length, 2);
    assert.match(sent[0].content, /blocked .* pane w1:p9/);
  });
});

describe("session shutdown", () => {
  it("hands running subagents to the reloaded module instead of closing them", async () => {
    const testApi = (subagentsModule as any).__test__;
    const originalWatch = testApi.launchDeps.watchSubagent;
    const moduleKey = Symbol.for("pi-subagents/poll-abort-controller");
    const originalModule = (globalThis as any)[moduleKey];
    (globalThis as any)[moduleKey] = new AbortController();
    const { api } = createMockExtensionApi();
    const sent: any[] = [];
    api.sendMessage = (message: any) => { sent.push(message); };
    let shutdown!: (event: any) => void, sessionStart!: (event: any, ctx: any) => void;
    api.on = (event: string, handler: any) => {
      if (event === "session_shutdown") shutdown = handler;
      if (event === "session_start") sessionStart = handler;
    };
    const watched: any[] = [];
    testApi.launchDeps.watchSubagent = async (child: any, signal: AbortSignal) => {
      watched.push(child);
      if (child.handedOff === false) return { name: child.name, task: child.task, summary: "Real result", exitCode: 0, elapsed: 1 };
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { name: child.name, task: child.task, summary: "Subagent cancelled.", exitCode: 1, elapsed: 1 };
    };
    try {
      (subagentsModule as any).default(api);
      const children = [
        { id: "reload-pi", name: "pi", task: "pi task", surface: "w1:p1", startTime: 1, sessionFile: "/tmp/pi.jsonl", interactive: true },
        { id: "reload-fresh", name: "fresh", task: "fresh task", surface: "w1:p2", startTime: 2, sessionFile: "/tmp/fresh.jsonl", interactive: false },
      ];
      for (const child of children) {
        testApi.runningSubagents.set(child.id, child);
        testApi.watchAndDeliver(child);
      }
      shutdown({ reason: "reload" });
      await delay(10);
      assert.equal(testApi.runningSubagents.size, 0);
      assert.ok(children.every((child) => child.handedOff));
      assert.deepEqual(sent, [], "a handed-off subagent must not be reported as cancelled");

      sessionStart({ reason: "reload" }, {});
      await delay(10);
      const resumed = watched.slice(2);
      assert.deepEqual(resumed.map((child) => [child.name, child.task, child.startTime, child.interactive]),
        [["pi", "pi task", 1, true], ["fresh", "fresh task", 2, false]]);
      assert.deepEqual(sent.map((m) => m.content.match(/Real result/)?.[0]), ["Real result", "Real result"]);
      assert.deepEqual(sent.map(m => m.details.summary), ["Real result", "Real result"]);

      sessionStart({ reason: "reload" }, {});
      await delay(10);
      assert.equal(watched.length, 4, "a handoff is consumed once");
    } finally {
      testApi.launchDeps.watchSubagent = originalWatch;
      testApi.runningSubagents.clear();
      (globalThis as any)[moduleKey].abort();
      (globalThis as any)[moduleKey] = originalModule;
    }
  });

  it("hands held questions and completed results to the new API once, retaining pending-result counts", async () => {
    const testApi = subagentsModule.__test__;
    const root = createTestDir();
    const sessionFile = join(root, "held.jsonl");
    const originalWatch = testApi.launchDeps.watchSubagent;
    const moduleKey = Symbol.for("pi-subagents/poll-abort-controller");
    const originalModule = (globalThis as any)[moduleKey];
    (globalThis as any)[moduleKey] = new AbortController();
    const childCount = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
    const handlers = new Map<string, (...args: any[]) => any>();
    const { api } = createMockExtensionApi();
    const oldSent: any[] = [], newSent: any[] = [];
    api.on = (event: string, handler: any) => { handlers.set(event, handler); };
    api.sendMessage = (message: any) => oldSent.push(message);
    const ctx = { isIdle: () => true, hasUI: false };
    testApi.undelivered.clear(); testApi.unconsumed.clear(); testApi.queued.clear();
    testApi.launchDeps.watchSubagent = async (child: any) => {
      testApi.runningSubagents.delete(child.id);
      return { summary: "Held result", exitCode: 0, elapsed: 1 };
    };
    try {
      subagentsModule.default(api);
      handlers.get("session_start")!({ reason: "startup" }, ctx);
      handlers.get("input")!({ text: "handled by another extension" }, ctx);
      const child: any = { id: "held-child", name: "held-child", task: "task", surface: "w1:p9", herdrName: "held-child", sessionFile, startTime: Date.now(), interactive: false };
      publishQuestion(sessionFile, "Held question?");
      testApi.deliverPendingQuestion(child);
      testApi.runningSubagents.set(child.id, child);
      testApi.watchAndDeliver(child);
      await delay(0);
      assert.deepEqual(oldSent, []);
      assert.equal(pendingQuestions(sessionFile).files.length, 0);
      assert.equal(testApi.undelivered.size, 2);
      assert.equal(testApi.runningSubagents.size, 0, "completed child cannot be recovered from running watchers");
      await handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
      api.sendMessage = () => assert.fail("old API must not be used after reload");
      subagentsModule.default({ ...api, sendMessage: (message: any) => newSent.push(message) });
      handlers.get("session_start")!({ reason: "reload" }, ctx);
      assert.deepEqual(newSent.map(m => m.customType), ["subagent_question", "subagent_result"]);
      assert.equal(childCount(), 1, "the result must enter the conversation before a nested parent may exit");
      for (const message of newSent) handlers.get("message_start")!({ message: { role: "custom", ...message } });
      assert.equal(childCount(), 0);
      assert.equal(testApi.undelivered.size, 0);
      handlers.get("session_start")!({ reason: "reload" }, ctx);
      handlers.get("agent_start")!({});
      assert.equal(newSent.length, 2, "handoff and old held queue are consumed once");
    } finally {
      await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
      testApi.launchDeps.watchSubagent = originalWatch;
      testApi.runningSubagents.clear(); testApi.undelivered.clear(); testApi.unconsumed.clear(); testApi.queued.clear();
      (globalThis as any)[moduleKey] = originalModule;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports nothing, and rejects nothing, when a session switch cancels a watched subagent", async () => {
    const testApi = (subagentsModule as any).__test__;
    const originalWatch = testApi.launchDeps.watchSubagent;
    const moduleKey = Symbol.for("pi-subagents/poll-abort-controller");
    const originalModule = (globalThis as any)[moduleKey];
    (globalThis as any)[moduleKey] = new AbortController();
    const { api } = createMockExtensionApi();
    let stale = false, sends = 0;
    // Pi invalidates the old pi right after session_shutdown: every later call throws.
    api.sendMessage = () => { sends++; if (stale) throw new Error("This extension ctx is stale"); };
    let shutdown!: (event: any) => void;
    api.on = (event: string, handler: any) => { if (event === "session_shutdown") shutdown = handler; };
    let closed = false;
    testApi.launchDeps.watchSubagent = async (child: any, signal: AbortSignal) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      await delay(5); // closing the pane takes a herdr call
      closed = true;
      // It had finished just before: a success, but its session is shutting down.
      return { summary: "Done.", exitCode: 0, elapsed: 1 };
    };
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      (subagentsModule as any).default(api);
      const child = { id: "switch", name: "switch", task: "task", surface: "w1:p1", startTime: 1, sessionFile: "/tmp/switch.jsonl", interactive: false };
      testApi.runningSubagents.set(child.id, child);
      testApi.watchAndDeliver(child);
      await shutdown({ reason: "new" });
      assert.equal(closed, true, "shutdown waits for the pane to close");
      stale = true;
      await delay(20);
      assert.equal(sends, 0);
      assert.deepEqual(rejections, []);
    } finally {
      process.off("unhandledRejection", onRejection);
      testApi.launchDeps.watchSubagent = originalWatch;
      testApi.runningSubagents.clear();
      (globalThis as any)[moduleKey] = originalModule;
    }
  });

  it("judges each message by its own inbox file, and removes an unread one before resume", async () => {
    const testApi = (subagentsModule as any).__test__;
    const root = createTestDir();
    const sessionFile = join(root, "busy.jsonl");
    let finish!: () => void;
    const child: any = { id: "busy", name: "busy", task: "t", surface: "w1:p3", herdrName: "busy", startTime: 0, sessionFile, interactive: false,
      watching: new Promise<void>((resolve) => { finish = () => { testApi.runningSubagents.delete("busy"); resolve(); }; }) };
    testApi.runningSubagents.set("busy", child);
    try {
      const a = testApi.steerLive(child, "A"), b = testApi.steerLive(child, "B");
      const files = pendingInboxMessages(sessionFile);
      assert.deepEqual(files.map(file => JSON.parse(readFileSync(file, "utf8")).message), ["A", "B"]);
      rmSync(files[0]); // child submitted only A before it exited
      finish();
      assert.equal((await a)?.details.status, "steered");
      assert.equal(await b, null, "B was never read: resume with it");
      assert.deepEqual(pendingInboxMessages(sessionFile), [], "unread file removed so resume cannot duplicate it");
    } finally {
      testApi.runningSubagents.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Escape stops waiting for an unread inbox message, not the watcher or delivery", async () => {
    const testApi = (subagentsModule as any).__test__;
    const root = createTestDir();
    const sessionFile = join(root, "waiting.jsonl");
    const child: any = { id: "waiting", name: "waiting", sessionFile, watching: new Promise(() => {}) };
    testApi.runningSubagents.set(child.id, child);
    try {
      const escape = new AbortController();
      const waiting = testApi.steerLive(child, "more\nwork", escape.signal);
      escape.abort();
      await assert.rejects(waiting, /abort/i);
      assert.deepEqual(consumeInbox(sessionFile), ["more\nwork"], "Escape does not retract a sent message");
      assert.equal(testApi.runningSubagents.has(child.id), true);
    } finally {
      testApi.runningSubagents.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops waiting for a finishing subagent on Escape, without touching its supervision", async () => {
    const testApi = (subagentsModule as any).__test__;
    const root = createTestDir();
    const sessionFile = join(root, "finishing.jsonl");
    writeFileSync(`${sessionFile}.exiting`, "{}");
    let reported = false;
    const child: any = { id: "finishing", name: "finishing", task: "t", surface: "w1:p3", herdrName: "finishing", startTime: 0, sessionFile, interactive: false,
      watching: delay(200).then(() => { reported = true; }) };
    testApi.runningSubagents.set("finishing", child);
    try {
      const escape = new AbortController();
      const waiting = testApi.steerLive(child, "more", escape.signal);
      escape.abort();
      await assert.rejects(waiting);
      assert.equal(reported, false, "it returned before the child was reported");
      await child.watching;
      assert.equal(reported, true, "the watcher itself went on");
    } finally {
      testApi.runningSubagents.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes when the watcher already cleaned up the markers", async () => {
    const testApi = (subagentsModule as any).__test__;
    const root = createTestDir();
    const sessionFile = join(root, "gone.jsonl");
    const child: any = { id: "gone", name: "gone", sessionFile, watching: Promise.resolve() };
    try {
      assert.equal(await testApi.steerLive(child, "lost"), null);
      assert.deepEqual(pendingInboxMessages(sessionFile), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers waiting questions together, and keeps one asked during delivery for the next tick", async () => {
    const testApi = (subagentsModule as any).__test__;
    const root = createTestDir();
    const sessionFile = join(root, "asker.jsonl");
    const { api } = createMockExtensionApi();
    const sent: string[] = [];
    // The child publishes another question while the first ones are being delivered.
    api.sendMessage = (message: any) => {
      sent.push(message.details.question);
      if (sent.length === 1) publishQuestion(sessionFile, "third?");
    };
    (subagentsModule as any).default(api);
    publishQuestion(sessionFile, "first?");
    publishQuestion(sessionFile, "second?");
    const child = { id: "asker", name: "asker", task: "t", surface: "w1:p3", herdrName: "asker", startTime: Date.now(), sessionFile, interactive: false };
    try {
      await testApi.watchSubagent(child, new AbortController().signal, {
        wait: async (_target: string, _signal: AbortSignal, options: any) => {
          options.onTick("working");
          options.onTick("working");
          return { reason: "done", exitCode: 0 };
        },
        close: () => {},
      });
      assert.deepEqual(sent, ["first?\n\nsecond?", "third?"]);
      assert.deepEqual(pendingQuestions(sessionFile).files, []);
    } finally {
      testApi.runningSubagents.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers nothing into a session that is shutting down, even from a watcher that already finished", async () => {
    const testApi = (subagentsModule as any).__test__;
    const originalWatch = testApi.launchDeps.watchSubagent;
    const moduleKey = Symbol.for("pi-subagents/poll-abort-controller");
    const originalModule = (globalThis as any)[moduleKey];
    (globalThis as any)[moduleKey] = new AbortController();
    const { api } = createMockExtensionApi();
    const sent: any[] = [];
    api.sendMessage = (message: any) => { sent.push(message); };
    let shutdown!: (event: any, ctx: any) => Promise<void>;
    api.on = (event: string, handler: any) => { if (event === "session_shutdown") shutdown = handler; };
    let report!: () => void;
    // Its watcher has finished and removed it, so shutdown cannot abort it; the result is still on its way.
    testApi.launchDeps.watchSubagent = async (child: any) => {
      testApi.runningSubagents.delete(child.id);
      await new Promise<void>((resolve) => { report = resolve; });
      return { summary: "Done.", exitCode: 0, elapsed: 1 };
    };
    try {
      (subagentsModule as any).default(api);
      const child = { id: "late", name: "late", task: "t", surface: "w1:p1", herdrName: "late", startTime: 1, sessionFile: "/tmp/late.jsonl", interactive: false };
      testApi.runningSubagents.set(child.id, child);
      testApi.watchAndDeliver(child);
      await delay(1);
      const stopping = shutdown({ reason: "new" }, { ui: { notify() {} } });
      report();
      await stopping;
      await delay(5);
      assert.deepEqual(sent, []);
    } finally {
      testApi.launchDeps.watchSubagent = originalWatch;
      testApi.runningSubagents.clear();
      (globalThis as any)[moduleKey] = originalModule;
    }
  });

  it("counts a child as pending until its result enters the conversation, not just until its pane closed", async () => {
    const testApi = (subagentsModule as any).__test__;
    const originalWatch = testApi.launchDeps.watchSubagent;
    const childCount = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
    const { api } = createMockExtensionApi();
    const sent: any[] = [];
    api.sendMessage = (message: any) => { sent.push(message); };
    let messageStart!: (event: any) => void;
    api.on = (event: string, handler: any) => { if (event === "message_start") messageStart = handler; };
    testApi.unconsumed.clear();
    testApi.launchDeps.watchSubagent = async (child: any) => {
      testApi.runningSubagents.delete(child.id); // its pane closed
      return { summary: "Done.", exitCode: 0, elapsed: 1 };
    };
    try {
      (subagentsModule as any).default(api);
      const child = { id: "last", name: "last", task: "t", surface: "w1:p1", herdrName: "last", startTime: 1, sessionFile: "/tmp/last.jsonl", interactive: false };
      testApi.runningSubagents.set(child.id, child);
      testApi.watchAndDeliver(child);
      await delay(1);
      assert.equal(testApi.runningSubagents.size, 0);
      assert.equal(sent.length, 1);
      assert.equal(childCount(), 1, "its result is still on its way in: the worker must not exit");
      messageStart({ message: { role: "custom", customType: "subagent_result", details: sent[0].details } });
      assert.equal(childCount(), 0);
    } finally {
      testApi.launchDeps.watchSubagent = originalWatch;
      testApi.runningSubagents.clear();
      testApi.unconsumed.clear();
    }
  });

  it("sends a result or question again after Escape dropped it from Pi's queue", async () => {
    const testApi = (subagentsModule as any).__test__;
    const originalWatch = testApi.launchDeps.watchSubagent;
    const childCount = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
    const root = createTestDir();
    const sessionFile = join(root, "asker.jsonl");
    const { api } = createMockExtensionApi();
    const sent: Array<{ message: any; options: any }> = [];
    api.sendMessage = (message: any, options: any) => { sent.push({ message, options }); };
    const handlers = new Map<string, (event: any) => void>();
    api.on = (event: string, handler: any) => { handlers.set(event, handler); };
    testApi.unconsumed.clear();
    testApi.undelivered.clear();
    // The child asks, then finishes; both notices are steered while the parent is busy.
    testApi.launchDeps.watchSubagent = async (child: any) => {
      publishQuestion(sessionFile, "Which way?");
      testApi.deliverPendingQuestion(child);
      testApi.runningSubagents.delete(child.id);
      return { summary: "Done.", exitCode: 0, elapsed: 1 };
    };
    try {
      (subagentsModule as any).default(api);
      handlers.get("session_start")!({ reason: "startup" }, { isIdle: () => false }); // the parent is working
      const child = { id: "busy-parent", name: "busy-parent", task: "t", surface: "w1:p1", herdrName: "busy-parent", startTime: 1, sessionFile, interactive: false };
      testApi.runningSubagents.set(child.id, child);
      testApi.watchAndDeliver(child);
      await delay(1);
      assert.deepEqual(sent.map(({ message }) => message.customType), ["subagent_question", "subagent_result"]);
      assert.deepEqual(pendingQuestions(sessionFile).files, [], "the question file is consumed once queued");
      // Escape: Pi drops both queued steers and ends the run aborted.
      handlers.get("agent_settled")!({ aborted: true });
      const again = sent.slice(2);
      assert.deepEqual(again.map(({ message }) => message.customType), ["subagent_question", "subagent_result"]);
      assert.ok(again.every(({ options }) => options.triggerTurn === false), "appended, without the turn the user stopped");
      // Appended is delivered: Pi reports no message_start to extensions for it.
      assert.equal(childCount(), 0);
      handlers.get("agent_settled")!({ aborted: true });
      assert.equal(sent.length, 4, "nothing left to send again");

      // Editing queued input (Alt+Up) clears Pi's queue without aborting: steer it again, to be taken in as before.
      testApi.watchAndDeliver({ ...child, id: "dequeued" });
      await delay(1);
      handlers.get("agent_settled")!({ aborted: false });
      const steered = sent.at(-1)!;
      assert.equal(steered.message.details.deliveryId, "dequeued");
      assert.deepEqual(steered.options, { triggerTurn: true, deliverAs: "steer" });
      assert.equal(childCount(), 1, "until it is taken in");
      handlers.get("message_start")!({ message: { role: "custom", ...steered.message } });
      assert.equal(childCount(), 0);
    } finally {
      testApi.launchDeps.watchSubagent = originalWatch;
      testApi.runningSubagents.clear();
      testApi.unconsumed.clear();
      testApi.undelivered.clear();
      testApi.queued.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds a notice while the parent prepares a submitted prompt, and sends it into that prompt's run", async (t) => {
    const testApi = (subagentsModule as any).__test__;
    const { api } = createMockExtensionApi();
    const sent: any[] = [];
    api.sendMessage = (message: any) => { sent.push(message); };
    const handlers = new Map<string, (...args: any[]) => void>();
    api.on = (event: string, handler: any) => { handlers.set(event, handler); };
    testApi.undelivered.clear();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      (subagentsModule as any).default(api);
      const idle = { isIdle: () => true };
      handlers.get("session_start")!({ reason: "startup" }, idle);
      // The user submits a prompt; an extension's hook is still preparing it when a notice comes.
      handlers.get("input")!({ text: "my task" }, idle);
      testApi.notify({ customType: "subagent_status", content: "child blocked", display: true, details: { line: "x" } });
      assert.equal(sent.length, 0, "a run started now would make Pi reject the prompt");
      handlers.get("agent_start")!({});
      assert.equal(sent.length, 1, "sent into the prompt's run");
      // A prompt that never starts a run (another extension handled it) does not hold notices for long.
      handlers.get("input")!({ text: "/handled" }, idle);
      testApi.notify({ customType: "subagent_status", content: "again", display: true, details: { line: "y" } });
      assert.equal(sent.length, 1);
      t.mock.timers.tick(30_000);
      assert.equal(sent.length, 2);
    } finally {
      testApi.undelivered.clear();
      testApi.queued.clear();
    }
  });

  it("sends an interruption or blocked notice again after Escape dropped it", async () => {
    const testApi = (subagentsModule as any).__test__;
    const root = createTestDir();
    const sessionFile = join(root, "stuck.jsonl");
    const { api } = createMockExtensionApi();
    const sent: Array<{ message: any; options: any }> = [];
    api.sendMessage = (message: any, options: any) => { sent.push({ message, options }); };
    const handlers = new Map<string, (event: any) => void>();
    api.on = (event: string, handler: any) => { handlers.set(event, handler); };
    testApi.undelivered.clear();
    try {
      (subagentsModule as any).default(api);
      handlers.get("session_start")!({ reason: "startup" }, { isIdle: () => false }); // the parent is working
      writeFileSync(`${sessionFile}.paused`, "{}");
      const child = { id: "stuck", name: "stuck", task: "t", surface: "w1:p4", herdrName: "stuck", startTime: 1, sessionFile, interactive: false };
      await testApi.watchSubagent(child, new AbortController().signal, {
        wait: async (_target: string, _signal: AbortSignal, options: any) => {
          options.onTick("blocked");
          return { reason: "done", exitCode: 0 };
        },
        close: () => {},
      });
      assert.deepEqual(sent.map(({ message }) => message.details.line.replace("stuck: ", "")), ["interrupted, waiting in pane w1:p4", "blocked at a dialog in pane w1:p4"]);
      assert.equal(existsSync(`${sessionFile}.paused`), false);
      handlers.get("agent_settled")!({ aborted: true }); // Escape dropped both
      assert.equal(sent.length, 4);
      assert.ok(sent.slice(2).every(({ message, options }) => message.customType === "subagent_status" && options.triggerTurn === false));
    } finally {
      testApi.runningSubagents.clear();
      testApi.undelivered.clear();
      testApi.queued.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries closing a pane, and reports one that stays open at shutdown", async () => {
    const testApi = (subagentsModule as any).__test__;
    const { api } = createMockExtensionApi();
    let shutdown!: (event: any, ctx: any) => Promise<void>;
    api.on = (event: string, handler: any) => { if (event === "session_shutdown") shutdown = handler; };
    (subagentsModule as any).default(api);
    const waitUntilAborted = (_target: string, signal: AbortSignal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const watch = (name: string, close: () => void) => {
      const controller = new AbortController();
      const child = { id: name, name, task: "t", surface: `w1:${name}`, herdrName: name, startTime: Date.now(), sessionFile: `/tmp/${name}.jsonl`, interactive: false };
      const watching = testApi.watchSubagent(child, controller.signal, { wait: waitUntilAborted, close });
      controller.abort();
      return watching;
    };
    let flakyCalls = 0;
    await watch("flaky", () => { if (++flakyCalls < 3) throw new Error("herdr busy"); });
    assert.equal(flakyCalls, 3, "a transient failure is retried");
    await watch("stuck", () => { throw new Error("herdr down"); });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      await shutdown({ reason: "quit" }, { ui: { notify: (text: string) => warnings.push(text) } });
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /stuck \(herdr pane w1:stuck\)/);
    assert.doesNotMatch(warnings[0], /flaky/);
  });

  it("closes the watched pane and leaves no tracked child after the actual shutdown handler", async () => {
    const testApi = (subagentsModule as any).__test__;
    const moduleKey = Symbol.for("pi-subagents/poll-abort-controller");
    const original = (globalThis as any)[moduleKey];
    (globalThis as any)[moduleKey] = new AbortController();
    const { api } = createMockExtensionApi();
    let shutdown!: (...args: any[]) => void;
    api.on = (event: string, handler: any) => { if (event === "session_shutdown") shutdown = handler; };
    (subagentsModule as any).default(api);
    testApi.unconsumed.clear(); // results other tests delivered without Pi taking them in
    const running = { id: "shutdown-test", name: "shutdown-test", task: "task", surface: "terminal_123", startTime: Date.now(), sessionFile: "/missing-session", abortController: new AbortController() };
    const closed: string[] = [];
    try {
      testApi.runningSubagents.set(running.id, running);
      const watching = testApi.watchSubagent(running, running.abortController.signal, {
        wait: (_surface: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
        close: (surface: string) => closed.push(surface),
      });
      const childCount = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
      assert.equal(childCount(), 1);
      shutdown({ reason: "quit" }, {});
      assert.equal((await watching).summary, "Subagent cancelled.");
      assert.deepEqual(closed, [running.surface]);
      assert.equal(childCount(), 0);
    } finally {
      testApi.runningSubagents.clear();
      (globalThis as any)[moduleKey] = original;
    }
  });
});
