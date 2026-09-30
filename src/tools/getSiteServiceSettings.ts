import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler } from '../server/common.js';

export function registerGetSiteServiceSettingsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getSiteServiceSettings',
        {
            description:
                'Get unified wireless site service settings from the Omada controller: Mesh configuration, Fast Roaming (802.11k/v), Band Steering (including multi-band 6GHz), Beacon Control, Airtime Fairness, LLDP, LED controls, and Remote Logging.',
            inputSchema: siteInputSchema.shape,
        },
        wrapToolHandler('getSiteServiceSettings', async ({ siteId, customHeaders }) =>
            toToolResult(await client.getSiteServiceSettings(siteId, customHeaders))
        )
    );
}
