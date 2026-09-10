import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function runStreamableHttpTest() {
  const baseUrl = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
  const clientId = process.env.OAUTH_CLIENT_ID || 'omada_gemini_client';
  const clientSecret = process.env.OAUTH_CLIENT_SECRET || 'test_oauth_client_secret';

  console.log('=== Running Omada MCP StreamableHTTP Client Tests ===\n');

  console.log('1. Acquiring OAuth 2.0 access token from /oauth/token...');
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`
  });
  assert.strictEqual(tokenRes.status, 200, `Expected 200 from /oauth/token, got ${tokenRes.status}`);
  const tokenData = await tokenRes.json();
  assert.ok(tokenData.access_token, 'OAuth response missing access_token');
  console.log('   ✅ PASS: OAuth 2.0 Bearer JWT acquired');

  console.log('2. Connecting StreamableHTTP client transport to /mcp...');
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
  console.log('   ✅ PASS: MCP StreamableHTTP connection established');

  console.log('3. Querying available MCP tools via tools/list...');
  const toolsList = await client.listTools();
  assert.ok(Array.isArray(toolsList.tools), 'Expected tools to be an array');
  assert.ok(toolsList.tools.length > 0, 'Expected non-empty tools list');
  console.log(`   ✅ PASS: Received ${toolsList.tools.length} available tools`);

  console.log('4. Invoking live Omada tool (listSites)...');
  const sitesResult = await client.callTool({ name: 'listSites', arguments: {} });
  assert.ok(!sitesResult.isError, 'Tool call listSites returned isError=true');
  assert.ok(sitesResult.content?.[0]?.text, 'Tool call listSites returned empty content');
  const parsedSites = JSON.parse(sitesResult.content[0].text);
  assert.ok(Array.isArray(parsedSites), 'Expected listSites output to be JSON array');
  assert.ok(parsedSites.length > 0, 'Expected at least one site');
  console.log(`   ✅ PASS: listSites returned ${parsedSites.length} site(s) (Primary: "${parsedSites[0].name}")`);

  await client.close();
  console.log('\n=== All StreamableHTTP Tests Passed Successfully! ===\n');
}

runStreamableHttpTest().catch(err => {
  console.error('\n❌ StreamableHTTP Test Failed:', err);
  process.exit(1);
});
