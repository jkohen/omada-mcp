import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler } from '../server/common.js';

export function registerWirelessMutationTools(server: McpServer, client: OmadaClient): void {
    // 1. setSsidStatus
    server.registerTool(
        'setSsidStatus',
        {
            description:
                'Enable or disable a Wi-Fi broadcast SSID network on the site.',
            inputSchema: siteInputSchema
                .extend({
                    ssidId: z.string().min(1).describe('ID of the SSID / WLAN profile to enable or disable'),
                    enabled: z.boolean().describe('True to enable the SSID broadcast, false to disable'),
                })
                .shape,
        },
        wrapToolHandler('setSsidStatus', async ({ ssidId, enabled, siteId, customHeaders }) => {
            const sid = siteId || (client as any).siteId;
            const res = await client.callApi(
                {
                    method: 'PATCH',
                    url: `/sites/${encodeURIComponent(sid)}/setting/wlans/${encodeURIComponent(ssidId)}`,
                    data: { enable: enabled },
                },
                customHeaders
            );
            return toToolResult(res);
        })
    );
}
