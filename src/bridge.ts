import axios, { type AxiosInstance } from "axios";
import { OmadaClient } from "./omadaClient/index.js";
import { parseToolCategories, type ToolCategory, type ToolPermission } from "./config.js";

export interface OmadaSessionProvider {
  ensureLogin(): Promise<{ token: string; omadacId: string; cookieHeader: string }>;
  invalidate(): void;
  getSiteId(): string;
}

export function createBridgedOmadaClient(session: OmadaSessionProvider): {
  client: OmadaClient;
  activeCategories: Map<ToolCategory, Set<ToolPermission>>;
} {
  const baseUrl = process.env.OMADA_URL || "https://192.168.1.1";
  const omadacId = process.env.OMADA_OMADAC_ID || "your_omadac_id";
  const siteId = process.env.OMADA_SITE || "Default";

  const client = new OmadaClient({
    baseUrl,
    clientId: "local-fusion",
    clientSecret: "local-fusion",
    omadacId,
    siteId,
    strictSsl: false,
    requestTimeout: 30000,
  });

  // Mock the auth manager to bypass Cloud OpenAPI /openapi/authorize/token
  const mockAuth = {
    getAccessToken: async () => "local-session",
    clearToken: () => {
      session.invalidate();
    },
  };
  (client as any).auth = mockAuth;
  if ((client as any).request) {
    (client as any).request.auth = mockAuth;
  }

  // Intercept requests to bridge them to the local Omada Fusion Web UI API
  const http: AxiosInstance = (client as any).http;
  http.interceptors.request.use(async (config) => {
    const { token, omadacId: activeOmadacId, cookieHeader } = await session.ensureLogin();

    if (config.url) {
      if (config.url.startsWith("/openapi/")) {
        // Rewrite OpenAPI path: /openapi/v1/:omadacId/sites/... -> /:omadacId/api/v2/sites/...
        config.url = config.url.replace(/^\/openapi\/v[0-9]+\/[^/]+/, `/${activeOmadacId}/api/v2`);
      } else if (!config.url.startsWith(`/${activeOmadacId}/api/v2`)) {
        const normalized = config.url.startsWith("/") ? config.url : `/${config.url}`;
        config.url = `/${activeOmadacId}/api/v2${normalized}`;
      }
      // Rewrite overview-diagram to local overview endpoint
      config.url = config.url.replace(/\/dashboard\/overview-diagram/, "/dashboard/overview");
    }

    config.headers = config.headers || {};
    config.headers["Cookie"] = cookieHeader;
    config.headers["Csrf-Token"] = token;
    config.headers["Accept"] = "application/json";
    delete config.headers["Authorization"];

    config.params = config.params || {};
    config.params.token = token;

    // Map OpenAPI pagination params (page, pageSize) to Omada Web UI params (currentPage, currentPageSize)
    if (config.params.page !== undefined && config.params.currentPage === undefined) {
      config.params.currentPage = config.params.page;
    }
    if (config.params.pageSize !== undefined && config.params.currentPageSize === undefined) {
      config.params.currentPageSize = config.params.pageSize;
    }

    // Auto-inject required parameters for Omada Web UI endpoints
    if (config.url && config.url.includes("/clients")) {
      if (config.params["filters.active"] === undefined) {
        config.params["filters.active"] = "true";
      }
      if (config.params.currentPage === undefined) {
        config.params.currentPage = 1;
      }
      if (config.params.currentPageSize === undefined) {
        config.params.currentPageSize = 500;
      }
    } else if (config.url && (config.url.includes("/devices") || config.url.includes("/logs"))) {
      if (config.params.currentPage === undefined) {
        config.params.currentPage = 1;
      }
      if (config.params.currentPageSize === undefined) {
        config.params.currentPageSize = 100;
      }
    }

    return config;
  });

  // Intercept responses to handle session invalidation on auth failure
  http.interceptors.response.use(
    (response) => {
      if (response.data && typeof response.data === "object") {
        const data = response.data as { errorCode?: number };
        if (data.errorCode === -44106 || data.errorCode === -44111 || data.errorCode === -44112) {
          session.invalidate();
        }
      }
      return response;
    },
    (error) => {
      if (error.response?.status === 401 || error.response?.status === 403) {
        session.invalidate();
      }
      return Promise.reject(error);
    }
  );

  const rawCategories = process.env.OMADA_TOOL_CATEGORIES || "all";
  const { categories } = parseToolCategories(rawCategories);

  return { client, activeCategories: categories };
}
