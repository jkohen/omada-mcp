import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { deviceMacSchema, siteInputSchema, toToolResult, wrapToolHandler } from '../server/common.js';

export function registerDeviceMutationTools(server: McpServer, client: OmadaClient): void {
    // 1. rebootDevice
    server.registerTool(
        'rebootDevice',
        {
            description:
                '[Destructive] Reboot an Omada hardware device (Access Point, Switch, or Gateway). Causes temporary network disruption during restart.',
            inputSchema: siteInputSchema
                .extend({
                    deviceMac: deviceMacSchema.describe('MAC address of the device to reboot (e.g. 00-11-22-33-44-55)'),
                })
                .shape,
        },
        wrapToolHandler('rebootDevice', async ({ deviceMac, siteId, customHeaders }) => {
            const sid = siteId || (client as any).siteId;
            const res = await client.callApi(
                {
                    method: 'POST',
                    url: `/sites/${encodeURIComponent(sid)}/cmd/devices/${encodeURIComponent(deviceMac)}/reboot`,
                },
                customHeaders
            );
            return toToolResult(res);
        })
    );

    // 2. locateDevice
    server.registerTool(
        'locateDevice',
        {
            description:
                'Flash or stop flashing the physical LED indicator on an Omada device (Access Point or Switch) to identify its physical location.',
            inputSchema: siteInputSchema
                .extend({
                    deviceMac: deviceMacSchema.describe('MAC address of the device to locate'),
                    locate: z.boolean().default(true).describe('True to start LED flashing, false to stop flashing'),
                })
                .shape,
        },
        wrapToolHandler('locateDevice', async ({ deviceMac, locate, siteId, customHeaders }) => {
            const sid = siteId || (client as any).siteId;
            const res = await client.callApi(
                {
                    method: 'POST',
                    url: `/sites/${encodeURIComponent(sid)}/cmd/devices/${encodeURIComponent(deviceMac)}/locate`,
                    data: { locate: locate ?? true },
                },
                customHeaders
            );
            return toToolResult(res);
        })
    );

    // 3. setDeviceName
    server.registerTool(
        'setDeviceName',
        {
            description:
                'Set or update the friendly display name of an Omada hardware device.',
            inputSchema: siteInputSchema
                .extend({
                    deviceMac: deviceMacSchema.describe('MAC address of the device to rename'),
                    name: z.string().min(1).describe('New friendly display name for the device'),
                })
                .shape,
        },
        wrapToolHandler('setDeviceName', async ({ deviceMac, name, siteId, customHeaders }) => {
            const sid = siteId || (client as any).siteId;
            const res = await client.callApi(
                {
                    method: 'PATCH',
                    url: `/sites/${encodeURIComponent(sid)}/devices/${encodeURIComponent(deviceMac)}`,
                    data: { name },
                },
                customHeaders
            );
            return toToolResult(res);
        })
    );

    // 4. triggerRfScan
    server.registerTool(
        'triggerRfScan',
        {
            description:
                'Trigger an RF (radio frequency) spectrum scan on an Access Point to detect interference and channel usage.',
            inputSchema: siteInputSchema
                .extend({
                    deviceMac: deviceMacSchema.describe('MAC address of the Access Point to trigger an RF scan on'),
                })
                .shape,
        },
        wrapToolHandler('triggerRfScan', async ({ deviceMac, siteId, customHeaders }) => {
            const sid = siteId || (client as any).siteId;
            const res = await client.callApi(
                {
                    method: 'POST',
                    url: `/sites/${encodeURIComponent(sid)}/cmd/devices/${encodeURIComponent(deviceMac)}/rfscan`,
                },
                customHeaders
            );
            return toToolResult(res);
        })
    );
}
