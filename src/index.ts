import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import crypto, { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server/common.js";
import { registerAllTools } from "./tools/index.js";
import { createBridgedOmadaClient, type OmadaSessionProvider } from "./bridge.js";

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
class OmadaFusionSession implements OmadaSessionProvider {
  private baseUrl: string;
  private username: string;
  private password: string;
  private siteId: string;
  private token?: string;
  private omadacId?: string;
  private cookieHeader?: string;
  private expiresAt: number = 0;
  private loginPromise?: Promise<{ token: string; omadacId: string; cookieHeader: string }>;

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

    if (this.loginPromise) {
      return await this.loginPromise;
    }

    this.loginPromise = (async () => {
      try {
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
      } finally {
        this.loginPromise = undefined;
      }
    })();

    return await this.loginPromise;
  }

  invalidate(): void {
    this.token = undefined;
    this.cookieHeader = undefined;
    this.expiresAt = 0;
    this.loginPromise = undefined;
  }

  getSiteId(): string {
    return this.siteId;
  }
}

const omadaSession = new OmadaFusionSession();
const { client: omadaClient, activeCategories } = createBridgedOmadaClient(omadaSession);

const app = express();

// --- 0. Universal Verbose Request Logger & Accept Header Force ---
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`[HTTP LOG] ${new Date().toISOString()} | Method: ${req.method} | Path: ${req.url} | IP: ${req.ip} | UA: ${req.headers["user-agent"] || "none"}`);
  
  if (!req.headers.accept || req.headers.accept === "*/*") {
    req.headers.accept = "application/json, text/event-stream";
  }
  if (!req.rawHeaders.some(h => h.toLowerCase() === "accept")) {
    req.rawHeaders.push("Accept", "application/json, text/event-stream");
  }
  next();
});

app.use(cors({
  origin: true,
  credentials: true,
  allowedHeaders: ["Authorization", "Content-Type", "Accept", "X-Requested-With", "mcp-version", "mcp-session-id"],
  exposedHeaders: ["mcp-session-id"],
  methods: ["GET", "POST", "DELETE", "OPTIONS", "HEAD"]
}));
app.options("*", cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const authCodes = new Map<string, { clientId: string; redirectUri: string; expiresAt: number }>();

interface StreamSessionState {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createServer>;
  connected: boolean;
  lastAccessed: number;
}

const activeSessions = new Map<string, StreamSessionState>();

// --- 1. Bearer Token Verification Middleware ---
const authenticateBearer = (req: Request, res: Response, next: NextFunction) => {
  if (req.method === "HEAD" || req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Strictly enforce authentication for all MCP operations
  const authHeader = req.headers.authorization || (req.query.access_token as string) || (req.headers["x-api-key"] as string);
  let token: string | undefined;

  if (authHeader && typeof authHeader === "string") {
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7).trim();
    } else {
      token = authHeader.trim();
    }
  }

  const host = req.headers.host || "<your-node>.<your-tailnet>.ts.net";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  console.log(`[AUTH DEBUG] ${req.method} ${req.originalUrl} from ${req.ip} | Token: ${token ? 'Found' : 'MISSING'} | AuthHeader: ${req.headers.authorization ? 'Present' : 'None'}`);

  if (!token) {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp", realm="omada-mcp", authorization_uri="${baseUrl}/oauth/authorize", token_uri="${baseUrl}/oauth/token", as_uri="${baseUrl}"`
    );
    res.status(401).json({
      id: APP_ID,
      name: APP_NAME,
      error: "unauthorized",
      error_description: "Bearer token missing. Please authenticate via OAuth 2.0 or provide Authorization header."
    });
    return;
  }

  // Allow static OAuth token / client secret directly
  if (token === OAUTH_CLIENT_SECRET || (process.env.STATIC_OAUTH_TOKEN && token === process.env.STATIC_OAUTH_TOKEN)) {
    (req as any).user = { sub: OAUTH_CLIENT_ID, scope: "openid profile omada:read" };
    next();
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
  const { grant_type, client_id, client_secret, code, refresh_token } = req.body || {};

  if (client_secret && client_secret !== OAUTH_CLIENT_SECRET) {
    res.status(401).json({ error: "invalid_client", error_description: "Client secret is invalid." });
    return;
  }

  let clientId = client_id || OAUTH_CLIENT_ID;

  if (grant_type === "authorization_code") {
    if (!code) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing code parameter." });
      return;
    }
    const authCodeData = authCodes.get(code);
    if (!authCodeData || authCodeData.expiresAt < Date.now()) {
      res.status(400).json({ error: "invalid_grant", error_description: "Authorization code invalid or expired." });
      return;
    }
    clientId = authCodeData.clientId || clientId;
    authCodes.delete(code);
  } else if (grant_type === "refresh_token") {
    const rawRefreshToken = (refresh_token || req.query.refresh_token) as string | undefined;
    if (!rawRefreshToken) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing refresh_token parameter." });
      return;
    }
    try {
      const decoded = jwt.verify(rawRefreshToken, JWT_SECRET) as any;
      if (decoded.token_type !== "refresh_token") {
        res.status(400).json({ error: "invalid_grant", error_description: "Provided token is not a refresh token." });
        return;
      }
      clientId = decoded.sub || clientId;
    } catch {
      res.status(400).json({ error: "invalid_grant", error_description: "Refresh token is invalid or expired." });
      return;
    }
  } else if (grant_type !== "client_credentials" && grant_type) {
    res.status(400).json({ error: "unsupported_grant_type", error_description: `Grant type '${grant_type}' is not supported.` });
    return;
  }

  // 30-day access token lifetime
  const token = jwt.sign(
    { sub: clientId, scope: "openid profile omada:read", token_type: "access_token" },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  // 365-day refresh token lifetime
  const newRefreshToken = jwt.sign(
    { sub: clientId, token_type: "refresh_token" },
    JWT_SECRET,
    { expiresIn: "365d" }
  );

  const host = req.headers.host || "<your-node>.<your-tailnet>.ts.net";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  const idToken = jwt.sign(
    { sub: clientId, iss: baseUrl, aud: clientId },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  console.log(`[MCP Gateway] OAuth 2.0 Token issued for client ${clientId} (grant_type: ${grant_type || "default"})`);

  res.json({
    access_token: token,
    refresh_token: newRefreshToken,
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 30 * 24 * 3600, // 30 days in seconds (2,592,000)
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
    grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
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
      mcp_endpoint: `${baseUrl}/mcp`
    }
  };
};

const getProtectedResourceMetadata = (req: Request) => {
  const host = req.headers.host || "<your-node>.<your-tailnet>.ts.net";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
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

// --- 5. StreamableHTTP MCP Handler ---
const handleStreamableHttpRequest = async (req: Request, res: Response) => {
  const headerSessionId = (req.headers["mcp-session-id"] || req.query.sessionId) as string | undefined;

  if (req.method === "GET" && !headerSessionId && !req.headers.accept?.includes("text/event-stream")) {
    res.json(getDiscoveryMetadata(req));
    return;
  }

  let sessionState: StreamSessionState | undefined = headerSessionId ? activeSessions.get(headerSessionId) : undefined;

  // If client provided a session ID that is no longer active, return 404 per Streamable HTTP spec
  // so the client knows its session has expired and can cleanly re-initialize.
  if (headerSessionId && !sessionState) {
    console.log(`[MCP Gateway] Client requested expired or unknown session ID: ${headerSessionId}, returning 404`);
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null
    });
    return;
  }

  if (!sessionState) {
    const sessionId = headerSessionId || randomUUID();
    console.log(`[MCP Gateway] Creating StreamableHTTP session: ${sessionId} (from ${req.ip}, method: ${req.method})`);

    const mcpServer = createServer();
    registerAllTools(mcpServer, omadaClient, activeCategories);

    let pendingState: StreamSessionState;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: (id: string) => {
        activeSessions.set(id, pendingState);
        console.log(`[MCP Gateway] StreamableHTTP session registered: ${id} (Total active: ${activeSessions.size})`);
      },
      onsessionclosed: (id: string) => {
        activeSessions.delete(id);
        console.log(`[MCP Gateway] StreamableHTTP session closed: ${id} (Total active: ${activeSessions.size})`);
      },
    });

    // If client is reconnecting to an existing session after restart, adopt the session ID
    if (headerSessionId) {
      const internal = (transport as any)._webStandardTransport;
      if (internal) {
        internal.sessionId = headerSessionId;
        internal._initialized = true;
      }
    }

    pendingState = {
      transport,
      server: mcpServer,
      connected: false,
      lastAccessed: Date.now(),
    };

    activeSessions.set(sessionId, pendingState);

    await mcpServer.connect(transport);
    pendingState.connected = true;
    sessionState = pendingState;
  }

  sessionState.lastAccessed = Date.now();

  try {
    await sessionState.transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error(`[MCP Gateway] StreamableHTTP request handling error:`, err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: err?.message || "Internal server error" },
        id: null
      });
    }
  }
};

app.all("/mcp", authenticateBearer, handleStreamableHttpRequest);
app.post("/", authenticateBearer, handleStreamableHttpRequest);

app.get("/", (req: Request, res: Response) => {
  res.json(getDiscoveryMetadata(req));
});

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    id: APP_ID,
    name: APP_NAME,
    status: "ok",
    gateway: "Omada MCP StreamableHTTP Gateway (OAuth 2.0)",
    activeSessions: activeSessions.size
  });
});

// Periodic session cleanup (evict sessions inactive for > 1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, state] of activeSessions.entries()) {
    if (now - state.lastAccessed > 60 * 60 * 1000) {
      console.log(`[MCP Gateway] Evicting idle session: ${sessionId}`);
      activeSessions.delete(sessionId);
      void state.transport.close().catch(() => {});
      void state.server.close().catch(() => {});
    }
  }
}, 10 * 60 * 1000);

// --- 6. Start Server ---
app.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(` Omada MCP Gateway running on http://${HOST}:${PORT}`);
  console.log(` App ID: ${APP_ID} | App Name: ${APP_NAME}`);
  console.log(` Authorize URL:       http://${HOST}:${PORT}/oauth/authorize`);
  console.log(` Token URL:           http://${HOST}:${PORT}/oauth/token`);
  console.log(` StreamableHTTP:      http://${HOST}:${PORT}/mcp`);
  console.log(` Public Funnel URL:   https://<your-node>.<your-tailnet>.ts.net/mcp`);
  console.log(`=======================================================`);
});
