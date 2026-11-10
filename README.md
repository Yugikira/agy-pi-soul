# Pi-Soul 🥧👻

> **Pi Coding Agent soul inside Google Antigravity CLI (`agy`) body.**  
> A lightweight, surgical coding harness powered by `@earendil-works/pi-coding-agent` running natively inside Google's Antigravity CLI on Windows, 100% compliant with Google Terms of Service.

---

## 🌟 Overview

Google's Antigravity CLI (`agy`) provides generous Gemini Pro/Flash quota with Google AI Pro plans, an interactive TUI, native subagent concurrency, and multimodal/search capabilities. However, on Windows and for everyday coding, `agy` suffers from noticeable friction:

- **Prompt Bloat**: Out-of-the-box system prompts and default rules are enormous, consuming substantial token context and degrading model reasoning performance.
- **PowerShell Lock-in**: On Windows, `agy`'s native command runner is strictly bound to `PowerShell.exe`. Models frequently generate slow, unwieldy commands like `Get-ChildItem | Select-String` instead of leveraging fast Unix tools like `ripgrep` (`rg`) and `fd`.
- **Heavy Editing Tools**: Default file editing primitives lack the agility and surgical accuracy found in specialized developer harnesses.

**Pi-Soul** solves this by performing an **orthogonal graft**:
We strip away `agy`'s bloated default prompt and clumsy execution tools, and inject the clean, minimalist soul of **[Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent)** (by Mario Zechner / Earendil Works) via a high-performance local MCP server.

```
┌────────────────────────────────────────────────────────────────────────┐
│                      ANTIGRAVITY CLI (The Body)                        │
│                                                                        │
│  • Google AI Pro Quota (Gemini 2.5 / 3.0 Pro & Flash)                  │
│  • Full TUI & Interactive Workspace Experience                         │
│  • Multi-Subagent Orchestration (`invoke_subagent`, `send_message`)    │
│  • Web Search (`search_web`, `read_url_content`)                       │
│  • Multimodal Document Analysis (`read_file` for PDF / Media)          │
│                                                                        │
│    ▲                                                            ▲      │
│    │  (excludeDefaultComponents: true)                          │      │
│    ▼                                                            ▼      │
│  ┌─────────────────────────────────────────────────────────────┐│      │
│  │                    PI-SOUL MCP (The Soul)                   ││      │
│  │                                                             ││      │
│  │  • bash: Pure Git Bash (`bash.exe`) + rg / fd / jq          ││      │
│  │  • read: Fast file reader with line offsets & limits        ││      │
│  │  • write: Direct atomic file writer                         ││      │
│  │  • edit: Surgical exact-match find-and-replace              ││      │
│  │  • codemode: Isolated QuickJS sandbox for chaining calls    ││      │
│  └─────────────────────────────────────────────────────────────┘│      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Why This Architecture? (ToS Safety & Zero Risk)

Many developers love Pi's CLI experience and have attempted to wrap `agy` as a headless background process or reverse-proxy to feed Pi or Claude Code. 

⚠️ **Warning: External headless scraping triggers Google 403 PERMISSION_DENIED account bans.** Google actively detects automated API multiplexing and proxying of `agy`.

**Pi-Soul takes the inverted, 100% compliant path:**
1. **Official Harness Host**: You launch and run the official `agy` binary directly in your terminal as an authenticated human user.
2. **Official Extension Points**: Pi-Soul uses only documented, first-class `agy` features: Custom Agent Markdown definitions (`agent.md`), standard Model Context Protocol (MCP) servers, and native flags (`excludeDefaultComponents: true`, `eager: true`).
3. **No Message Flattening**: External wrappers flatten conversation histories into massive single-turn messages, hitting token limits and truncation bugs. Pi-Soul keeps `agy`'s native conversational tree intact.

---

## ⚡ Key Features

### 1. Minimalist System Prompt (`excludeDefaultComponents: true`)
Leveraging configuration techniques uncovered from the Hermes `antigravity-agy` plugin ecosystem, `excludeDefaultComponents: true` completely purges `agy`'s verbose built-in prompt, rules, and PowerShell directives, returning full reasoning autonomy to the Gemini model.

### 2. Pi's Essential Five Tools (Zero-Delay Eager Loaded)
Through the local stdio MCP server (`mcp/index.mjs`), Pi's battle-tested primitives are exposed directly into the top-level tool list with `_meta: { "antigravity/alwaysLoad": true }` and `eager: true`:
- `bash`: Runs inside Git Bash (`C:\Program Files\Git\bin\bash.exe`). No PowerShell quirks, full POSIX pipeline support.
- `read`: Read files cleanly with optional start line and limit.
- `write`: Create or overwrite files cleanly.
- `edit`: Pi's signature surgical replacement. Requires exact unique text matches to prevent accidental overwrites. Like Pi, it reports a diff of the change; since MCP has no `details` field, it travels in `_meta["pisoul/toolDetails"]` as `{ diff, patch, firstChangedLine }` and never reaches the model.
- `codemode`: Powered by `@earendil-works/pi-codemode` inside a QuickJS WebAssembly sandbox. Lets the model chain loops of `tools.bash`, `tools.read`, and `tools.edit` in a single interaction without bloating context tokens. Nested tools are declared with their signatures, `bash` resolves to a structured `{ output, exit_code, … }` value, scripts may set a `// @options:` deadline, and the VM runs with pi's 256MB memory limit.

#### Parity notes (vs. `pi-coding-agent`)

The five tools follow pi's behaviour: identical descriptions and input schemas, the same 2000-line/50KB truncation with continuation notices, image detection by file content, `edit`'s matching/fuzzy/line-ending rules and error texts, bounded `bash` output, and the `codemode` sandbox semantics above.

Deliberate differences:

- `read` on a directory answers "`<path>` is a directory, not a file." instead of Node's raw `EISDIR` error.
- Images are not resized (no image dependency added); files above 5MB are reported as an omitted image with a note instead of being sent inline.
- `bash` inherits the MCP server's environment as is; pi's `PI_*` session variables only exist inside pi itself.

### 3. Clear Tool Separation of Concerns
To avoid model confusion, tool responsibilities are strictly separated:
| Task | Tool | Provider |
|---|---|---|
| Text & Source Code Reading | `read` | Pi MCP |
| PDF & Binary Media Documents | `read_file` | Antigravity Host |
| File Edits (Surgical) | `edit` | Pi MCP |
| New Files / Complete Rewrites | `write` | Pi MCP |
| Terminal / Shell Commands | `bash` (Git Bash) | Pi MCP |
| Batch / Multi-step Automation | `codemode` (QuickJS) | Pi MCP |
| Subagent Spawning & Messaging | `invoke_subagent`, `send_message` | Antigravity Host |
| Web Search & Page Fetch | `search_web`, `read_url_content` | Antigravity Host |

---

## 📦 Prerequisites

1. **Operating System**: Windows 10/11 (or Linux/macOS)
2. **Node.js**: v18.0.0 or higher
3. **Git for Windows**: Includes Git Bash (`bash.exe`). Ensure Git Bash is accessible in `PATH` or standard location (`C:\Program Files\Git\bin\bash.exe`).
4. **Fast CLI Utilities**:
   Install `ripgrep`, `fd`, and `jq` for optimal agent performance:
   ```powershell
   scoop install ripgrep fd jq
   # or via winget:
   winget install BurntSushi.ripgrep.MSVC
   winget install sharkdp.fd
   winget install jqlang.jq
   ```
5. **Google Antigravity CLI**: `agy` installed and authenticated (`agy auth login`).

---

## 🚀 Installation & Setup

### Step 1: Clone and Install Dependencies
```bash
git clone https://github.com/your-username/pi-soul.git
cd pi-soul
npm install
```

This installs `@modelcontextprotocol/sdk` and `@earendil-works/pi-codemode`. (The core tools `bash`, `read`, `write`, and `edit` are natively implemented for ultra-fast <300ms cold startup without heavy bloated dependencies).

### Step 2: Configure MCP Server Path
Open `agents/pi-soul.md` and check the `mcpServers` configuration:
```yaml
mcpServers:
  - name: pisoul
    command: "node"
    args:
      - "D:/claude/agy-agents/pi-soul/mcp/index.mjs" # Update this to your absolute path!
    eager: true
```
> **Tip**: Replace the path with the absolute path to your `mcp/index.mjs`.

### Step 3: Register Agent with Antigravity CLI
You can register `pi-soul` globally or per project:

- **Global Setup**:
  Copy or symlink `agents/pi-soul.md` into your user agent directory:
  ```bash
  # Git Bash / Windows
  mkdir -p "$USERPROFILE/.gemini/antigravity/agents"
  cp agents/pi-soul.md "$USERPROFILE/.gemini/antigravity/agents/agent.md"
  ```
- **Project Setup**:
  Place `agents/pi-soul.md` inside your repository's `.agents/agents/pi-soul/agent.md`.

---

## 💻 Usage

### Launching `pi-soul`
Launch `agy` directly with the `pi-soul` agent:
```bash
agy --agent pi-soul
```

For seamless auto-execution (matching Pi's frictionless zero-prompt workflow):
```bash
agy --agent pi-soul --mode=auto
```

Alternatively, launch `agy` and switch dynamically using the slash command:
```text
/agents pi-soul
```

---

## 🧪 Verification & Smoke Tests

Verify that your agent is operating with Pi's soul:

1. **Bash & Ripgrep Test**:
   > *"Use rg to search for all occurrences of 'createBashTool' in this repo."*
   - Verify it calls `bash` (not PowerShell) and executes `rg` with immediate results.

2. **Codemode Sandbox Test**:
   > *"Use codemode to inspect all markdown files in the workspace and return their title headings."*
   - Verify it runs a JavaScript function inside QuickJS chaining `tools.bash` and `tools.read` in a single step without context bloat.

3. **Subagent & PDF Test**:
   > *"Read this PDF specification using read_file, then spawn a subagent to research related GitHub repositories using search_web."*
   - Verify that PDF parsing uses native `read_file` while subagent orchestration runs smoothly in the background.

---

## 📂 Repository Structure

```text
pi-soul/
├── agents/
│   └── pi-soul.md       # Custom Agent definition (prompt + YAML frontmatter)
├── mcp/
│   └── index.mjs        # Local stdio MCP Server exposing Pi tools & Codemode
├── package.json         # NPM package dependencies
├── package-lock.json    # Dependency lockfile
└── README.md            # Documentation
```

---

## 🔗 Related Projects & References

- **[pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)** by Mario Zechner / Earendil Works — The minimalist coding harness that inspired this project.
- **[pi-codemode](https://github.com/earendil-works/pi-codemode)** — QuickJS sandboxing for batch tool chaining.
- **[ahmadghoniem/agy-custom-agent](https://github.com/ahmadghoniem/agy-custom-agent)** — Guide and patterns for Antigravity custom agents.
- **[thoth-agents/pi-antigravity-bridge](https://github.com/EremesNG/thoth-agents)** ([Pi Package](https://pi.dev/packages/@thoth-agents/pi-antigravity-bridge?name=Agent&page=23)) — The inverse bridge (Pi CLI host calling AGY ACP).
- **Hermes `antigravity-agy` plugin** — Uncovered `excludeDefaultComponents: true` and internal AGY mechanisms.
- **[Common Agent Format](https://commonagents.io/harnesses)** — Standardization across coding agent manifests.

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
