# Instructions for AI Agents (AGENTS.md)

This document outlines the architecture, operational constraints, and workflow rules for any AI agent working on the `omada-mcp` repository.

---

## 1. System Architecture & Environment

* **Repository**: [`jkohen/omada-mcp`](https://github.com/jkohen/omada-mcp) (TypeScript, Node.js, Express, MCP SDK).
* **Role**: Model Context Protocol (MCP) gateway server implementing StreamableHTTP and SSE transports, secured with RFC-compliant OAuth 2.0 authentication.
* **Target Hardware**: TP-Link Omada Fusion 2.5G Gateway running embedded Omada Controller 6.x on local IP `https://192.168.1.1`.
* **Deployment Host**: Raspberry Pi 5 accessible over Tailscale at `https://<your-node>.<your-tailnet>.ts.net`.
* **Tools**: Exposes 320+ tools bridged from `tplink-omada-mcp` with automatic dynamic pagination, active client filtering, and standardized MCP risk annotations.

---

## 2. Strict Workflow Rules for AI Agents

### Rule 1: Local-First Development & Testing
* **NEVER SSH into the Raspberry Pi to develop, edit code, or run test suites.**
* All code editing, linting, typechecking, and test execution **MUST** be performed locally on the developer machine (Windows host).
* Local test execution connects over Tailscale directly to the remote gateway.

```powershell
# Set remote gateway target and run method verification locally
[System.Environment]::SetEnvironmentVariable('GATEWAY_URL', 'https://<your-node>.<your-tailnet>.ts.net')
node tests/test-verify-methods.mjs
```

### Rule 2: Raspberry Pi Access Scope
* Raspberry Pi access is strictly reserved for:
  1. **Deploying approved updates** via `git pull` and rebuilding.
  2. **Managing the systemd service** (`omada-mcp-gateway`).
  3. **Diagnosing critical server-level errors** (e.g. reviewing `journalctl` when the service fails to start).
* **User Accounts**:
  * ALWAYS work as **`<user>@raspberrypi`** for all git operations, directory navigation, and building.
  * ONLY use **`root`** (or `sudo`) for system service management (`systemctl restart omada-mcp-gateway`).

### Rule 3: Git & Deployment Lifecycle
* Never perform ad-hoc `scp` file copies to deploy code to the Raspberry Pi.
* All code changes must follow the clean Git lifecycle:
  1. Edit and verify locally.
  2. Review the diff with the user when requested.
  3. Commit and push to GitHub (`origin/main`).
  4. SSH into the Raspberry Pi as `jkohen` and pull:
     ```bash
     cd /opt/omada-mcp
     git pull
     npm run build
     ```
  5. Restart the gateway service as `root`:
     ```bash
     systemctl restart omada-mcp-gateway
     ```
* **Do not leave uncommitted modifications in `/opt/omada-mcp` on the Raspberry Pi**, as they prevent clean `git pull` fast-forwards.

---

## 3. Tool Annotations & Safety Protocol

All 320+ tools are dynamically annotated in `src/server/common.ts` via `inferToolAnnotations`:

* **`readOnlyHint`**:
  * `true`: All methods starting with `get`, `list`, `show`, `check`, `is`, `find`, `search`, `describe`.
  * `false`: Methods starting with `set`, `create`, `add`, `modify`, `update`, `delete`, `remove`, `reboot`, `restart`, `block`, `unblock`, `enable`, `disable`.
* **`destructiveHint`**:
  * `true`: Methods containing `delete`, `remove`, `factoryreset`, `reset`, `reboot`, `restart`, `purge`, `destroy`, `format` (operations causing irreversible data loss or hardware network interruption).
  * `false`: All read operations and safe non-destructive modifications.
* **`idempotentHint`**:
  * `true`: All read-only methods and absolute state-setters (`set*`, `enable*`, `disable*`, `block*`, `unblock*`).
  * `false`: Actions that repeat side-effects on every invocation (`reboot*`, `create*`, `triggerSpeedTest`, `upgrade*`).
* **`openWorldHint`**:
  * `false` (default for ~98% of tools): All tools communicating strictly with the local gateway (`192.168.1.1`).
  * `true`: Only tools connecting to external internet/cloud endpoints (`speedtest`, `cloud`, `firmwareupgrade`, `autocheckupgrade`, `external`, `ddns`).

Tool-specific overrides can be declared directly in the individual tool registration file when an exception is needed.
