import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler } from '../server/common.js';

export function registerGetSiteSettingsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getSiteSettings',
        {
            description:
                'Get full site settings on the Omada controller, including site metadata, resource limits, auto-upgrade rules, speed test settings, alert notifications, and device retention policies.',
            inputSchema: siteInputSchema.shape,
        },
        wrapToolHandler('getSiteSettings', async ({ siteId, customHeaders }) =>
            toToolResult(await client.getSiteSettings(siteId, customHeaders))
        )
    );
}
