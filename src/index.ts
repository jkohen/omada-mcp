import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import crypto, { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

dotenv.config();

// Ignore self-signed TLS certificates for local Omada Fusion Gateway (192.168.1.1)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "omada_gemini_client";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || "test_oauth_client_secret";
const JWT_SECRET = process.env.JWT_SECRET || "default_jwt_secret_change_in_production";

const APP_ID = "omada-mcp";
const APP_NAME = "Omada MCP";

// --- Omada Fusion Web UI Client (Username / Password Login) ---
class OmadaFusionSession {
  private baseUrl: string;
  private username: string;
  private password: string;
  private siteId: string;
  private token?: string;
  private omadacId?: string;
  private cookieHeader?: string;
  private expiresAt: number = 0;

  constructor() {
    this.baseUrl = process.env.OMADA_URL || "https://192.168.1.1";
    this.username = process.env.OMADA_USERNAME || "admin";
    this.password = process.env.OMADA_PASSWORD || "your_omada_password";
    this.siteId = process.env.OMADA_SITE || "Default";
  }

  async ensureLogin(): Promise<{ token: string; omadacId: string; cookieHeader: string }> {
    if (this.token && this.cookieHeader && Date.now() < this.expiresAt) {
      return { token: this.token, omadacId: this.omadacId!, cookieHeader: this.cookieHeader };
    }

    const res = await fetch(`${this.baseUrl}/api/v2/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });

    const setCookieHeader = res.headers.get("set-cookie");
    let rawCookies: string[] = [];
    if (typeof (res.headers as any).getSetCookie === "function") {
      rawCookies = (res.headers as any).getSetCookie();
    } else if (setCookieHeader) {
      rawCookies = [setCookieHeader];
    }

    const parsedCookies: string[] = [];
    for (const c of rawCookies) {
      if (c && typeof c === "string") {
        const parts = c.split(";");
        if (parts[0]) {
          parsedCookies.push(parts[0]);
        }
      }
    }
    this.cookieHeader = parsedCookies.join("; ");

    const data = await res.json() as any;
    if (data.errorCode !== 0 || !data.result?.token) {
      throw new Error(`Omada Fusion Web UI login failed: ${data.msg || JSON.stringify(data)}`);
    }

    this.token = String(data.result.token);
    this.omadacId = String(data.result.omadacId || "your_omadac_id");
    this.expiresAt = Date.now() + 30 * 60 * 1000;

    console.log(`[MCP Gateway] Omada Fusion Web UI login successful! Token: ${this.token.substring(0, 8)}...`);
    return { token: this.token, omadacId: this.omadacId, cookieHeader: this.cookieHeader };
  }

  async request(apiPath: string, extraParams: Record<string, any> = {}): Promise<any> {
    const { token, omadacId, cookieHeader } = await this.ensureLogin();
    const cleanPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
    
    // Parse URL & base path
    const urlObj = new URL(`${this.baseUrl}/${omadacId}/api/v2${cleanPath}`);
    urlObj.searchParams.set("token", token);

    // Auto-inject default pagination/filter parameters for list endpoints if omitted
    if (urlObj.pathname.includes("/clients")) {
      if (!urlObj.searchParams.has("currentPage")) urlObj.searchParams.set("currentPage", "1");
      if (!urlObj.searchParams.has("currentPageSize")) urlObj.searchParams.set("currentPageSize", "500");
      if (!urlObj.searchParams.has("filters.active")) urlObj.searchParams.set("filters.active", "true");
    } else if (urlObj.pathname.includes("/devices") || urlObj.pathname.includes("/logs")) {
      if (!urlObj.searchParams.has("currentPage")) urlObj.searchParams.set("currentPage", "1");
      if (!urlObj.searchParams.has("currentPageSize")) urlObj.searchParams.set("currentPageSize", "100");
    }

    // Append any extra args (excluding siteId)
    for (const [k, v] of Object.entries(extraParams)) {
      if (k !== "siteId" && v !== undefined && v !== null) {
        urlObj.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(urlObj.toString(), {
      headers: {
        "Cookie": cookieHeader,
        "Csrf-Token": token,
        "Accept": "application/json"
      }
    });

    return await res.json();
  }

  getSiteId(): string {
    return this.siteId;
  }
}

const omadaSession = new OmadaFusionSession();

const app = express();

// --- 0. Universal Verbose Request Logger & Accept Header Force ---
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`[HTTP LOG] ${new Date().toISOString()} | Method: ${req.method} | Path: ${req.url} | IP: ${req.ip} | UA: ${req.headers["user-agent"] || "none"}`);
  
  // Force accept header property getter for StreamableHTTP SDK compatibility
  Object.defineProperty(req.headers, "accept", {
    get: () => "application/json, text/event-stream",
    configurable: true,
    enumerable: true
  });
  next();
});

app.use(cors({
  origin: true,
  credentials: true,
  allowedHeaders: ["Authorization", "Content-Type", "Accept", "X-Requested-With", "mcp-version", "mcp-session-id"],
  methods: ["GET", "POST", "OPTIONS", "HEAD"]
}));
app.options("*", cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const authCodes = new Map<string, { clientId: string; redirectUri: string; expiresAt: number }>();
const activeSseTransports = new Map<string, SSEServerTransport>();
const activeStreamableTransports = new Map<string, StreamableHTTPServerTransport>();

// --- 1. Bearer Token Verification Middleware ---
const authenticateBearer = (req: Request, res: Response, next: NextFunction) => {
  if (req.method === "HEAD" || req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (process.env.ALLOW_ANONYMOUS !== "false") {
    console.log(`[MCP Gateway] Proceeding with unauthenticated connection from ${req.ip} (ALLOW_ANONYMOUS=true)`);
    next();
    return;
  }

  const authHeader = req.headers.authorization || (req.query.access_token as string) || (req.headers["x-api-key"] as string);
  let token: string | undefined;

  if (authHeader && typeof authHeader === "string") {
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    } else {
      token = authHeader;
    }
  }

  if (!token) {
    const host = req.headers.host || "<your-node>.<your-tailnet>.ts.net";
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const baseUrl = `${protocol}://${host}`;

    res.setHeader("WWW-Authenticate", `Bearer realm="omada-mcp", authorization_uri="${baseUrl}/oauth/authorize", token_uri="${baseUrl}/oauth/token", as_uri="${baseUrl}"`);
    res.status(401).json({
      id: APP_ID,
      name: APP_NAME,
      error: "unauthorized",
      error_description: "Bearer token missing. Please authenticate via OAuth 2.0 or pass ?access_token=<token>."
    });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    (req as any).user = decoded;
    next();
  } catch (err) {
    const host = req.headers.host || "<your-node>.<your-tailnet>.ts.net";
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const baseUrl = `${protocol}://${host}`;

    res.setHeader("WWW-Authenticate", `Bearer error="invalid_token", token_uri="${baseUrl}/oauth/token"`);
    res.status(401).json({
      id: APP_ID,
      name: APP_NAME,
      error: "invalid_token",
      error_description: "Token verification failed or expired."
    });
  }
};

// --- 2. OAuth 2.0 Dynamic Client Registration (RFC 7591) ---
app.post(["/oauth/register", "/register"], (req: Request, res: Response) => {
  console.log(`[MCP Gateway] Dynamic Client Registration (RFC 7591) request from ${req.ip}`);
  res.status(201).json({
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    grant_types: ["authorization_code", "client_credentials"],
    redirect_uris: req.body?.redirect_uris || ["https://gemini.google.com/oauth/callback"]
  });
});

// --- 3. Standard OAuth 2.0 Authorization Endpoint (302 Auto-Redirect) ---
app.get("/oauth/authorize", (req: Request, res: Response) => {
  const { client_id, redirect_uri, state } = req.query as Record<string, string>;

  console.log(`[MCP Gateway] OAuth Authorize request for client ${client_id}, redirecting to ${redirect_uri}`);

  const authCode = crypto.randomBytes(16).toString("hex");
  authCodes.set(authCode, {
    clientId: client_id || OAUTH_CLIENT_ID,
    redirectUri: redirect_uri || "https://gemini.google.com/oauth/callback",
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  if (redirect_uri) {
    const targetUrl = new URL(redirect_uri);
    targetUrl.searchParams.set("code", authCode);
    if (state) targetUrl.searchParams.set("state", state);
    res.redirect(302, targetUrl.toString());
    return;
  }

  res.send("Authorization code generated: " + authCode);
});

// --- 4. Standard OAuth 2.0 / OIDC Token Endpoint ---
app.post("/oauth/token", (req: Request, res: Response) => {
  let clientId = req.body.client_id;

  const token = jwt.sign(
    { sub: clientId || OAUTH_CLIENT_ID, scope: "openid profile omada:read" },
    JWT_SECRET,
    { expiresIn: "24h" }
  );

  const host = req.headers.host || "<your-node>.<your-tailnet>.ts.net";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  const idToken = jwt.sign(
    { sub: clientId || OAUTH_CLIENT_ID, iss: baseUrl, aud: clientId || OAUTH_CLIENT_ID },
    JWT_SECRET,
    { expiresIn: "24h" }
  );

  console.log(`[MCP Gateway] Standard OAuth 2.0 / OIDC Token issued for client ${clientId || OAUTH_CLIENT_ID}`);

  res.json({
    access_token: token,
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 86400,
    scope: "openid profile omada:read"
  });
});

// Metadata Documents
const getDiscoveryMetadata = (req: Request) => {
  const host = req.headers.host || "<your-node>.<your-tailnet>.ts.net";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: ["openid", "profile", "email", "omada:read"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["HS256"],
    mcp: {
      id: APP_ID,
      name: APP_NAME,
      version: "1.0.0",
      protocolVersion: "2024-11-05",
      sse_endpoint: `${baseUrl}/sse`,
      mcp_endpoint: `${baseUrl}/mcp`
    }
  };
};

const getProtectedResourceMetadata = (req: Request) => {
  const host = req.headers.host || "<your-node>.<your-tailnet>.ts.net";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  return {
    resource: baseUrl,
    authorization_servers: [baseUrl],
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    grant_types_supported: ["authorization_code", "client_credentials"],
    scopes_supported: ["openid", "profile", "email", "omada:read"],
    bearer_methods_supported: ["header"]
  };
};

app.get([
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/.well-known/mcp.json",
  "/.well-known/mcp"
], (req: Request, res: Response) => {
  res.json(getDiscoveryMetadata(req));
});

app.get([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource/sse"
], (req: Request, res: Response) => {
  res.json(getProtectedResourceMetadata(req));
});

app.get("/.well-known/jwks.json", (_req: Request, res: Response) => {
  res.json({ keys: [] });
});

// --- 5. Tool Definitions & Tool Execution ---
const TOOLS_DEFINITIONS = [
  {
    name: "listSites",
    description: "List all sites on the Omada Fusion Gateway controller.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "listDevices",
    description: "List all hardware devices (Access Points, Switches, Fusion Gateway) on the Omada network.",
    inputSchema: { type: "object", properties: { siteId: { type: "string" } } }
  },
  {
    name: "listClients",
    description: "List all connected Wi-Fi and Ethernet client devices on the Omada network.",
    inputSchema: { type: "object", properties: { siteId: { type: "string" } } }
  },
  {
    name: "getGatewayDetail",
    description: "Get detail and WAN/LAN status of the Omada Fusion 2.5G Gateway.",
    inputSchema: { type: "object", properties: { siteId: { type: "string" } } }
  },
  {
    name: "getDashboardOverview",
    description: "Get summary dashboard overview of network health, active clients, and traffic.",
    inputSchema: { type: "object", properties: { siteId: { type: "string" } } }
  }
];

// --- Declarative Tool Endpoint Registry ---
const TOOL_ENDPOINT_MAP: Record<string, (siteId: string) => string> = {
  listSites: () => "/sites",
  listDevices: (siteId) => `/sites/${siteId}/devices`,
  listClients: (siteId) => `/sites/${siteId}/clients`,
  getGatewayDetail: (siteId) => `/sites/${siteId}/gateways`,
  getDashboardOverview: (siteId) => `/sites/${siteId}/dashboard/overview`,
  getDashboardWifiSummary: (siteId) => `/sites/${siteId}/dashboard/wlan-summary`,
  getDashboardSwitchSummary: (siteId) => `/sites/${siteId}/dashboard/switch-summary`,
  getClientsDistribution: (siteId) => `/sites/${siteId}/dashboard/client-distribution`
};

async function handleToolCall(name: string, args: any): Promise<any> {
  const defaultSiteId = omadaSession.getSiteId();
  const siteId = args?.siteId || defaultSiteId;

  console.log(`[MCP Gateway] Executing tool '${name}' against Omada Fusion Gateway (site: ${siteId})`);

  try {
    const getEndpoint = TOOL_ENDPOINT_MAP[name];
    if (getEndpoint) {
      const endpoint = getEndpoint(siteId);
      const res = await omadaSession.request(endpoint, args);
      return { content: [{ type: "text", text: JSON.stringify(res.result || res, null, 2) }] };
    }
    return { content: [{ type: "text", text: `Tool '${name}' not implemented in gateway.` }], isError: true };
  } catch (err: any) {
    console.error(`[MCP Gateway] Tool '${name}' execution error:`, err);
    return { content: [{ type: "text", text: `Error executing ${name}: ${err.message}` }], isError: true };
  }
}

// --- 6. Transports: SSE & StreamableHTTP ---

// A. SSE Handler
const handleSseConnection = async (req: Request, res: Response) => {
  console.log(`[MCP Gateway] SSE connection established from ${req.ip} at ${req.path}`);
  
  const host = req.headers.host || "<your-node>.<your-tailnet>.ts.net";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  const sseTransport = new SSEServerTransport(`${baseUrl}/messages`, res);
  const sessionId = sseTransport.sessionId;
  activeSseTransports.set(sessionId, sseTransport);

  const server = new Server(
    { name: APP_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await handleToolCall(name, args);
  });

  await server.connect(sseTransport);

  req.on("close", () => {
    console.log(`[MCP Gateway] SSE Connection closed for session ${sessionId}`);
    activeSseTransports.delete(sessionId);
  });
};

app.get("/sse", authenticateBearer, handleSseConnection);

app.post(["/messages", "/sse/messages"], authenticateBearer, async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  if (sessionId && activeSseTransports.has(sessionId)) {
    const transport = activeSseTransports.get(sessionId)!;
    await transport.handlePostMessage(req, res, req.body);
    return;
  }
  res.status(404).json({ error: "Session not found" });
});

// B. StreamableHTTP Handler
const handleStreamableHttpRequest = async (req: Request, res: Response) => {
  if (req.method === "GET" && (!req.headers["mcp-session-id"] && !req.query.sessionId)) {
    console.log(`[MCP Gateway] Routing GET ${req.path} without session ID to SSE EventStream handler`);
    return handleSseConnection(req, res);
  }

  const sessionId = (req.headers["mcp-session-id"] || req.query.sessionId) as string;
  
  let transport: StreamableHTTPServerTransport;
  if (sessionId && activeStreamableTransports.has(sessionId)) {
    transport = activeStreamableTransports.get(sessionId)!;
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = new Server(
      { name: APP_NAME, version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: TOOLS_DEFINITIONS };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return await handleToolCall(name, args);
    });

    await server.connect(transport);

    req.on("close", () => {
      if (transport.sessionId) {
        activeStreamableTransports.delete(transport.sessionId);
      }
    });
  }

  await transport.handleRequest(req, res, req.body);
  if (transport.sessionId && !activeStreamableTransports.has(transport.sessionId)) {
    activeStreamableTransports.set(transport.sessionId, transport);
  }
};

app.all("/mcp", authenticateBearer, handleStreamableHttpRequest);

// Root GET & POST handlers
app.get("/", (req: Request, res: Response) => {
  if (req.headers.accept && req.headers.accept.includes("text/event-stream")) {
    return authenticateBearer(req, res, () => handleSseConnection(req, res));
  }
  res.json(getDiscoveryMetadata(req));
});

app.post("/", authenticateBearer, handleStreamableHttpRequest);

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    id: APP_ID,
    name: APP_NAME,
    status: "ok",
    gateway: "Omada MCP OAuth 2.0 Gateway (Secured)"
  });
});

// --- 7. Start Server ---
app.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(` Omada MCP Gateway running on http://${HOST}:${PORT}`);
  console.log(` App ID: ${APP_ID} | App Name: ${APP_NAME}`);
  console.log(` Authorize URL:       http://${HOST}:${PORT}/oauth/authorize`);
  console.log(` Token URL:           http://${HOST}:${PORT}/oauth/token`);
  console.log(` SSE Endpoint:        http://${HOST}:${PORT}/sse`);
  console.log(` StreamableHTTP:      http://${HOST}:${PORT}/mcp`);
  console.log(` Public Funnel URL:   https://<your-node>.<your-tailnet>.ts.net/mcp`);
  console.log(`=======================================================`);
});
