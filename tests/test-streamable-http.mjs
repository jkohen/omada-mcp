import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function runStreamableHttpTest() {
  const baseUrl = process.env.GATEWAY_URL || 'https://<your-node>.<your-tailnet>.ts.net';
  const clientId = process.env.OAUTH_CLIENT_ID || 'omada_gemini_client';
  const clientSecret = process.env.OAUTH_CLIENT_SECRET || 'test_oauth_client_secret';

  console.log('--- 1. Fetching OAuth Token ---');
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`
  });
  const tokenData = await tokenRes.json();
  console.log('OAuth Token acquired:', tokenData.access_token ? 'YES (Valid JWT)' : 'NO');

  console.log('--- 2. Connecting StreamableHTTP Client ---');
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`
        }
      }
    }
  );

  const client = new Client(
    { name: 'streamable-test-agent', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('✅ MCP StreamableHTTP Connection Established!');

  console.log('--- 3. Querying Omada Tools ---');
  const toolsList = await client.listTools();
  console.log(`✅ Total Omada Tools Available: ${toolsList.tools.length}`);

  const sitesResult = await client.callTool({ name: 'listSites', arguments: {} });
  console.log('--- 4. Live Omada Controller Query (listSites) ---');
  console.log(JSON.stringify(sitesResult, null, 2));

  await client.close();
  console.log('--- StreamableHTTP Test Complete ---');
}

runStreamableHttpTest().catch(err => {
  console.error('StreamableHTTP Test Error:', err);
  process.exit(1);
});
