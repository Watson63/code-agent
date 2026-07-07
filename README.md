# Workbench — local coding assistant (Electron)

A desktop app for the local coding agent. Chat window, folder picker, and
Allow / Don't allow buttons instead of a terminal. Runs 100% on this computer
via Ollama — no accounts, no subscriptions, nothing leaves the machine.

## One-time developer setup (your machine)

1. Install Node.js LTS from https://nodejs.org
2. Install Ollama from https://ollama.com and pull a model:
   ```
   ollama pull qwen3:8b
   ```
3. In this folder:
   ```
   npm install
   npm start
   ```

## Making an installer for non-technical users

```
npm run dist
```

This produces a one-click Windows installer in `dist/` (e.g.
`Workbench Setup 1.0.0.exe`). On their machine they need exactly two things:
run that installer, and install Ollama + pull a model (or you do that part
for them once). After that it's a normal desktop app.

## How a non-technical person uses it

1. Open Workbench
2. Click **Choose folder** and pick the project
3. Type what they want in plain words and press Enter
4. When the assistant wants to change a file or run a command, a card
   appears showing exactly what will change — they click **Allow** or
   **Don't allow**

The status bar shows progress as a floor being laid, plank by plank —
that's the conversation's working memory filling up. When the planks turn
amber, wrap up the task; red means start a **New chat** soon.

## Architecture

```
renderer/  (what you see)          main.js  (app process)        agentCore.js
┌────────────────────────┐  IPC   ┌───────────────────────┐      ┌──────────────────┐
│ chat UI, approval      │ <----> │ window, folder dialog, │ ---> │ agent loop,      │
│ cards, plank meter     │        │ IPC bridge             │      │ 6 tools, Ollama  │
└────────────────────────┘        └───────────────────────┘      └──────────────────┘
                                                                        |
                                                                  http://localhost:11434
                                                                        (Ollama)
```

- `agentCore.js` has zero Electron dependencies — it's the same loop as the
  Python `agent.py`, ported to Node, and can be tested standalone.
- Approvals flow: agent pauses on a Promise → card appears in the UI →
  the button click resolves the Promise → the agent continues.
- Security: contextIsolation on, nodeIntegration off, strict CSP, no
  innerHTML on model-generated content, and the agent physically cannot
  touch files outside the chosen folder.

## Settings that matter on 8GB VRAM

- Context is 16K by default (`numCtx` in main.js `settings`). The plank
  meter is calibrated to it. Raise to 32768 only if `nvidia-smi` shows
  headroom while a task is running.
- The model dropdown lists whatever `ollama list` knows about; it prefers
  qwen3 models because their tool calling is the most reliable at this size.

## Ideas for v2

- Streaming answers (token-by-token) instead of waiting per step
- A task history sidebar
- Per-folder memory (a WORKBENCH.md the agent reads on startup, like a
  mini CLAUDE.md)
- An "always allow commands like this" option per session
