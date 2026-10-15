# Omada MCP OAuth 2.0 Gateway for Raspberry Pi 5

A secure **Remote MCP (Model Context Protocol) OAuth 2.0 Gateway** designed to connect **Google Gemini Spark**, **Google Antigravity**, and other Remote MCP clients to a local **TP-Link Omada Fusion 2.5G Gateway** (or standalone Omada Controller).

---

## 🏗️ Architecture Overview

```text
[ Google Gemini Spark / Antigravity ]
                 │
                 │ 1. Auto-Discovers RFC 8414 & RFC 9470 Metadata
                 │ 2. Connects via HTTPS (Tailscale Funnel)
                 ▼
    https://<your-node>.<your-tailnet>.ts.net/mcp
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Raspberry Pi 5                                              │
│                                                             │
│  Tailscale Funnel (Port 3000)                               │
│       │                                                     │
│       ▼                                                     │
│  MCP Gateway (Express + @modelcontextprotocol/sdk)          │
│    ├── GET  /.well-known/oauth-authorization-server         │
│    ├── GET  /.well-known/oauth-protected-resource           │
│    ├── GET  /oauth/authorize (Redirect URI Handler)         │
│    ├── POST /oauth/token     (OAuth 2.0 & OIDC Token Issue)  │
│    └── POST /mcp             (StreamableHTTP Transport)     │
│       │                                                     │
│       ▼ (Local Web UI Session API)                          │
│  OmadaFusionSession (POST /api/v2/login)                    │
│       │                                                     │
│       ▼ HTTPS (Local LAN)                                   │
│  TP-Link Omada Gateway (e.g. 192.168.1.1)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Key Features

- **Standard OAuth 2.0 & OIDC Support**: Implements OAuth 2.0 Authorization Code Flow with PKCE, Dynamic Client Registration (RFC 7591), and Discovery Metadata (RFC 8414 / RFC 9470) required by Google Gemini.
- **StreamableHTTP Transport**: Uses standard **StreamableHTTP** (`/mcp` and `POST /`) compliant with the Model Context Protocol specification.
- **Standalone Fusion Gateway Compatibility**: Automatically authenticates against local Omada Fusion Gateways via local Web UI session login (`POST /api/v2/login`), managing session cookies (`TPOMADA_SESSIONID`) and CSRF tokens automatically without needing TP-Link Cloud OpenAPI.

---

## 🚀 Setup Instructions

### 1. Prerequisites
- Raspberry Pi 5 (or any Linux/macOS/Windows server).
- Node.js **v20.x+** or **v22.x+** installed.
- Tailscale installed with Tailscale Funnel enabled.

### 2. Installation

Clone this repository on your Raspberry Pi:

```bash
git clone https://github.com/jkohen/omada-mcp.git
cd omada-mcp
npm install
```

### 3. Environment Configuration (`.env`)

Create a `.env` file from the template:

```bash
cp .env.example .env
nano .env
```

Configure your gateway parameters and Omada credentials:

```env
PORT=3000
HOST=127.0.0.1

# OAuth 2.0 Credentials (for Gemini / Remote MCP Clients)
OAUTH_CLIENT_ID=omada_gemini_client
OAUTH_CLIENT_SECRET=your_secure_client_secret_here
JWT_SECRET=your_secure_jwt_signing_secret_here

# TP-Link Omada Gateway Credentials (Local Web UI Login)
OMADA_URL=https://192.168.1.1
OMADA_USERNAME=admin
OMADA_PASSWORD=your_omada_user_password
OMADA_SITE=Default
OMADA_OMADAC_ID=your_omadac_id
```

### 4. Build & Start the Server

```bash
# Build TypeScript
npm run build

# Start server
npm start
```

### 5. Enable Tailscale Funnel

Expose port 3000 to the public internet securely using Tailscale Funnel:

```bash
sudo tailscale funnel --bg 3000
```

Verify that your public endpoint is reachable:

```bash
curl https://<your-node>.<your-tailnet>.ts.net/health
```

---

## 🧪 Automated Testing

Run the included test suite to verify Gateway connectivity, authentication, and live tool queries:

```bash
# Run all tests sequentially (Auth suite, StreamableHTTP handshake, and Omada tool verification)
npm test

# Or run individual test suites:
npm run test:auth         # Authentication & security tests (401 rejections, static tokens, OAuth JWT)
npm run test:streamable   # StreamableHTTP transport & protocol handshake
npm run test:methods      # Live Omada controller method verification (sites, devices, clients, dashboard)
```

---

## 🤖 Connecting to Google Gemini Spark & Antigravity

### Gemini Spark Setup
1. In Gemini's custom MCP configuration screen, enter:
   - **Server URL**: `https://<your-node>.<your-tailnet>.ts.net/mcp`
   - **Client ID**: `omada_gemini_client` (or your configured `OAUTH_CLIENT_ID`)
   - **Client Secret**: `your_secure_client_secret_here` (or your configured `OAUTH_CLIENT_SECRET`)
2. Gemini will automatically complete the OAuth 2.0 handshake using discovery endpoints.

### Antigravity Setup
Add the gateway to your MCP server configuration:

```json
{
  "mcpServers": {
    "omada-mcp": {
      "serverUrl": "https://<your-node>.<your-tailnet>.ts.net/mcp?access_token=<your_oauth_secret_or_token>"
    }
  }
}
```

---

## ⚙️ Running as a Systemd Service

To keep the gateway running automatically on Pi boot:

```bash
sudo cp omada-mcp-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now omada-mcp-gateway
```

Check service status:

```bash
sudo systemctl status omada-mcp-gateway
journalctl -u omada-mcp-gateway -f
```

---

## 📄 License
MIT
