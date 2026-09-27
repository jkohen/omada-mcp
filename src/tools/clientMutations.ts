import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { deviceMacSchema, siteInputSchema, toToolResult, wrapToolHandler } from '../server/common.js';

export function registerClientMutationTools(server: McpServer, client: OmadaClient): void {
    // 1. reconnectClient
    server.registerTool(
        'reconnectClient',
        {
            description:
                'Force-disconnect an active client device, prompting it to immediately reconnect and re-associate (useful for band steering or AP roaming).',
            inputSchema: siteInputSchema
                .extend({
                    clientMac: deviceMacSchema.describe('MAC address of the client device to reconnect (e.g. AA-BB-CC-DD-EE-FF)'),
                })
                .shape,
        },
        wrapToolHandler('reconnectClient', async ({ clientMac, siteId, customHeaders }) => {
            const sid = siteId || (client as any).siteId;
            const res = await client.callApi(
                {
                    method: 'POST',
                    url: `/sites/${encodeURIComponent(sid)}/cmd/clients/${encodeURIComponent(clientMac)}/reconnect`,
                },
                customHeaders
            );
            return toToolResult(res);
        })
    );

    // 2. blockClient
    server.registerTool(
        'blockClient',
        {
            description:
                'Block a client device by its MAC address, denying network access across all SSIDs and switch ports.',
            inputSchema: siteInputSchema
                .extend({
                    clientMac: deviceMacSchema.describe('MAC address of the client device to block'),
                })
                .shape,
        },
        wrapToolHandler('blockClient', async ({ clientMac, siteId, customHeaders }) => {
            const sid = siteId || (client as any).siteId;
            const res = await client.callApi(
                {
                    method: 'POST',
                    url: `/sites/${encodeURIComponent(sid)}/cmd/clients/${encodeURIComponent(clientMac)}/block`,
                },
                customHeaders
            );
            return toToolResult(res);
        })
    );

    // 3. unblockClient
    server.registerTool(
        'unblockClient',
        {
            description:
                'Unblock a previously blocked client device by its MAC address, restoring network access.',
            inputSchema: siteInputSchema
                .extend({
                    clientMac: deviceMacSchema.describe('MAC address of the client device to unblock'),
                })
                .shape,
        },
        wrapToolHandler('unblockClient', async ({ clientMac, siteId, customHeaders }) => {
            const sid = siteId || (client as any).siteId;
            const res = await client.callApi(
                {
                    method: 'POST',
                    url: `/sites/${encodeURIComponent(sid)}/cmd/clients/${encodeURIComponent(clientMac)}/unblock`,
                },
                customHeaders
            );
            return toToolResult(res);
        })
    );

    // 4. updateClient
    server.registerTool(
        'updateClient',
        {
            description:
                'Update client device settings such as its friendly display name or reserved fixed IP address.',
            inputSchema: siteInputSchema
                .extend({
                    clientMac: deviceMacSchema.describe('MAC address of the client device to update'),
                    name: z.string().optional().describe('New friendly display name for the client'),
                    ip: z.string().optional().describe('Fixed / reserved IP address to assign to the client'),
                })
                .shape,
        },
        wrapToolHandler('updateClient', async ({ clientMac, name, ip, siteId, customHeaders }) => {
            const sid = siteId || (client as any).siteId;
            const payload: Record<string, unknown> = {};
            if (name !== undefined) payload.name = name;
            if (ip !== undefined) payload.ip = ip;
            const res = await client.callApi(
                {
                    method: 'PATCH',
                    url: `/sites/${encodeURIComponent(sid)}/clients/${encodeURIComponent(clientMac)}`,
                    data: payload,
                },
                customHeaders
            );
            return toToolResult(res);
        })
    );
}
