/**
 * agentCore.js — the agent brain, independent of Electron.
 * Talks to Ollama, owns the six workspace tools, runs the loop.
 *
 * Hooks let any UI plug in:
 *   onThinking(step, maxSteps)          model is generating
 *   onStats({step, seconds, tps, ctxUsed, ctxMax})
 *   onToolCall(name, args)              a tool is about to run
 *   onAssistant(text)                   final plain-text answer
 *   requestApproval({kind, title, detail}) -> Promise<boolean>
 */

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const MAX_TOOL_ROUNDS = 25;
const MAX_FILE_CHARS = 60000;
const MAX_CMD_CHARS = 12000;

const SYSTEM_PROMPT = `You are a precise, capable coding agent running locally on the user's machine.
You have tools to explore the workspace, read and write files, and run shell commands.

Rules:
- Always read a file before modifying it. Never guess at existing contents.
- Prefer small, surgical edits via edit_file over rewriting whole files.
- After making changes, verify them (run the code, run tests, or re-read the file).
- Use list_dir and search_files to orient yourself before diving in.
- When the task is complete, summarize what you changed in plain text and stop calling tools.
- Keep shell commands non-interactive (no editors, no prompts).
- The user may not be technical: keep final summaries short and jargon-free.`;

const TOOL_DEFS = [
  { type: "function", function: { name: "list_dir",
    description: "List files and folders in a directory of the workspace.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Relative path, default '.'" } }, required: [] } } },
  { type: "function", function: { name: "read_file",
    description: "Read the full contents of a text file.",
    parameters: { type: "object", properties: {
      path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file",
    description: "Create or completely overwrite a file. Prefer edit_file for changes to existing files.",
    parameters: { type: "object", properties: {
      path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file",
    description: "Replace one exact occurrence of old_text with new_text in a file. Read the file first; old_text must match exactly and be unique.",
    parameters: { type: "object", properties: {
      path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"] } } },
  { type: "function", function: { name: "search_files",
    description: "Case-insensitive text search across all files in the workspace. Returns file:line matches.",
    parameters: { type: "object", properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Subdirectory to search, default '.'" } },
      required: ["pattern"] } } },
  { type: "function", function: { name: "run_command",
    description: "Run a non-interactive shell command in the workspace (tests, builds, git, etc). 120s timeout.",
    parameters: { type: "object", properties: {
      command: { type: "string" } }, required: ["command"] } } },
];

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);

/** Minimal unified-style diff for approval previews. */
function simpleDiff(oldText, newText) {
  const a = oldText.split("\n"), b = newText.split("\n");
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push("- " + a[i]);
    if (b[i] !== undefined) out.push("+ " + b[i]);
    if (out.length > 200) { out.push("... (diff truncated)"); break; }
  }
  return out.join("\n") || "(no visible changes)";
}

class Agent {
  constructor({ workspace, model, ollamaUrl = "http://localhost:11434",
                numCtx = 16384, autoApprove = false, hooks = {} }) {
    this.root = fs.realpathSync(workspace);
    this.model = model;
    this.ollamaUrl = ollamaUrl;
    this.numCtx = numCtx;
    this.autoApprove = autoApprove;
    this.hooks = hooks;
    this.cancelled = false;
    this.messages = [{ role: "system",
      content: `${SYSTEM_PROMPT}\nWorkspace root: ${this.root}\nOS: ${process.platform}` }];
  }

  clear() {
    this.messages = this.messages.slice(0, 1);
  }

  cancel() { this.cancelled = true; }

  // ---- safety helpers ----------------------------------------------------

  _resolve(p) {
    const full = path.resolve(this.root, p || ".");
    const rel = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes workspace: ${p}`);
    }
    return full;
  }

  async _confirm(kind, title, detail) {
    if (this.autoApprove) return true;
    if (!this.hooks.requestApproval) return false;
    return await this.hooks.requestApproval({ kind, title, detail });
  }

  // ---- tools ---------------------------------------------------------------

  list_dir({ path: p = "." } = {}) {
    const full = this._resolve(p);
    const names = fs.readdirSync(full).sort();
    return names.map(n => {
      if (SKIP_DIRS.has(n)) return `${n}/ (skipped)`;
      const st = fs.statSync(path.join(full, n));
      return st.isDirectory() ? `${n}/` : `${n}  (${st.size} bytes)`;
    }).join("\n") || "(empty directory)";
  }

  read_file({ path: p }) {
    const text = fs.readFileSync(this._resolve(p), "utf8");
    return text.length > MAX_FILE_CHARS
      ? text.slice(0, MAX_FILE_CHARS) + `\n... [truncated, file is ${text.length} chars total]`
      : text;
  }

  async write_file({ path: p, content }) {
    const full = this._resolve(p);
    const exists = fs.existsSync(full);
    const detail = exists
      ? simpleDiff(fs.readFileSync(full, "utf8"), content)
      : content.slice(0, 1500) + (content.length > 1500 ? "\n..." : "");
    const ok = await this._confirm("write",
      `${exists ? "Change" : "Create"} file: ${p}`, detail);
    if (!ok) return "User declined the write. Ask them how to proceed.";
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    return `Wrote ${content.length} chars to ${p}.`;
  }

  async edit_file({ path: p, old_text, new_text }) {
    const full = this._resolve(p);
    const text = fs.readFileSync(full, "utf8");
    const count = text.split(old_text).length - 1;
    if (count === 0) return "old_text not found in file. Re-read the file and try again with exact text.";
    if (count > 1) return `old_text appears ${count} times; provide more surrounding context to make it unique.`;
    const ok = await this._confirm("edit", `Edit file: ${p}`,
      simpleDiff(old_text, new_text));
    if (!ok) return "User declined the edit. Ask them how to proceed.";
    fs.writeFileSync(full, text.replace(old_text, new_text), "utf8");
    return `Edited ${p} successfully.`;
  }

  search_files({ pattern, path: p = "." }) {
    const hits = [];
    const pat = pattern.toLowerCase();
    const walk = dir => {
      for (const name of fs.readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const fp = path.join(dir, name);
        const st = fs.statSync(fp);
        if (st.isDirectory()) { walk(fp); continue; }
        if (st.size > 2_000_000) continue;
        let text;
        try { text = fs.readFileSync(fp, "utf8"); } catch { continue; }
        if (text.includes("\u0000")) continue; // binary
        text.split("\n").forEach((line, i) => {
          if (hits.length < 60 && line.toLowerCase().includes(pat)) {
            hits.push(`${path.relative(this.root, fp)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
        if (hits.length >= 60) return;
      }
    };
    walk(this._resolve(p));
    return hits.length
      ? hits.join("\n") + (hits.length >= 60 ? "\n... [more results truncated]" : "")
      : "No matches found.";
  }

  async run_command({ command }) {
    const ok = await this._confirm("command", "Run command", command);
    if (!ok) return "User declined to run the command. Ask them how to proceed.";
    return new Promise(resolve => {
      exec(command, { cwd: this.root, timeout: 120000, maxBuffer: 8_000_000 },
        (err, stdout, stderr) => {
          if (err && err.killed) return resolve("Command timed out after 120 seconds.");
          let out = (stdout || "") + (stderr ? "\n[stderr]\n" + stderr : "");
          if (out.length > MAX_CMD_CHARS) out = out.slice(0, MAX_CMD_CHARS) + "\n... [output truncated]";
          resolve(`exit code: ${err ? err.code ?? 1 : 0}\n${out || "(no output)"}`);
        });
    });
  }

  // ---- Ollama --------------------------------------------------------------

  async _chat() {
    const res = await fetch(`${this.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model, messages: this.messages, tools: TOOL_DEFS,
        stream: false, options: { num_ctx: this.numCtx, temperature: 0.2 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  // ---- the loop --------------------------------------------------------------

  async send(userText) {
    this.cancelled = false;
    this.messages.push({ role: "user", content: userText });
    const dispatch = {
      list_dir: a => this.list_dir(a),       read_file: a => this.read_file(a),
      write_file: a => this.write_file(a),   edit_file: a => this.edit_file(a),
      search_files: a => this.search_files(a), run_command: a => this.run_command(a),
    };

    for (let step = 1; step <= MAX_TOOL_ROUNDS; step++) {
      if (this.cancelled) { this.hooks.onAssistant?.("(stopped)"); return; }
      this.hooks.onThinking?.(step, MAX_TOOL_ROUNDS);
      const t0 = Date.now();
      const resp = await this._chat();
      const msg = resp.message;
      this.messages.push(msg);

      const evalNs = resp.eval_duration || 0;
      this.hooks.onStats?.({
        step,
        seconds: (Date.now() - t0) / 1000,
        tps: evalNs ? (resp.eval_count || 0) / (evalNs / 1e9) : 0,
        ctxUsed: (resp.prompt_eval_count || 0) + (resp.eval_count || 0),
        ctxMax: this.numCtx,
      });

      const calls = msg.tool_calls || [];
      if (!calls.length) {
        this.hooks.onAssistant?.((msg.content || "").trim());
        return;
      }
      for (const call of calls) {
        if (this.cancelled) { this.hooks.onAssistant?.("(stopped)"); return; }
        const name = call.function?.name || "";
        let args = call.function?.arguments || {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        this.hooks.onToolCall?.(name, args);
        let result;
        try {
          result = dispatch[name] ? await dispatch[name](args) : `Unknown tool: ${name}`;
        } catch (e) {
          result = `Tool error: ${e.message}`;
        }
        this.messages.push({ role: "tool", content: String(result), tool_name: name });
      }
    }
    this.hooks.onAssistant?.(
      "I hit the step limit for this request. Ask me to continue if you'd like me to keep going.");
  }
}

module.exports = { Agent, TOOL_DEFS };
