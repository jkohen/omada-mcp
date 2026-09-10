import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function verifyMethods() {
  const baseUrl = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
  const clientId = process.env.OAUTH_CLIENT_ID || 'omada_gemini_client';
  const clientSecret = process.env.OAUTH_CLIENT_SECRET || 'test_oauth_client_secret';

  console.log('=== Omada MCP Method Verification ===\n');

  console.log('1. Acquiring OAuth 2.0 Bearer token...');
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`Failed to get OAuth token: ${JSON.stringify(tokenData)}`);
  }
  console.log('   ✅ OAuth 2.0 JWT acquired successfully\n');

  console.log('2. Establishing StreamableHTTP MCP connection...');
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
    { name: 'verify-methods-agent', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('   ✅ Connected to MCP Gateway!\n');

  console.log('3. Listing registered MCP tools...');
  const toolsList = await client.listTools();
  console.log(`   ✅ Total Tools Registered: ${toolsList.tools.length}`);

  // Breakdown by prefix
  const counts = {};
  for (const tool of toolsList.tools) {
    const prefix = tool.name.replace(/[A-Z].*$/, '');
    counts[prefix] = (counts[prefix] || 0) + 1;
  }
  console.log('   Breakdown by action prefix:');
  for (const [prefix, count] of Object.entries(counts)) {
    console.log(`     - ${prefix}*: ${count} tools`);
  }
  console.log('');

  async function testMethod(name, args = {}) {
    console.log(`Testing tool: ${name}`);
    try {
      const res = await client.callTool({ name, arguments: args });
      if (res.isError) {
        console.log(`   ⚠️ Tool returned error: ${res.content?.[0]?.text || 'Unknown error'}`);
        return null;
      }
      const text = res.content?.[0]?.text;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return parsed;
    } catch (err) {
      console.log(`   ❌ Exception calling ${name}: ${err.message}`);
      return null;
    }
  }

  // 4. Test listSites
  const sites = await testMethod('listSites');
  if (Array.isArray(sites)) {
    console.log(`   ✅ PASS: listSites returned ${sites.length} site(s):`);
    for (const s of sites) {
      console.log(`      • Site Name: "${s.name}", ID: ${s.id}, Public IP: ${s.sitePublicIp || 'N/A'}`);
    }
  }
  console.log('');

  // 5. Test listDevices
  const devices = await testMethod('listDevices');
  if (Array.isArray(devices)) {
    console.log(`   ✅ PASS: listDevices returned ${devices.length} device(s):`);
    for (const d of devices) {
      console.log(`      • [${d.type || 'Device'}] ${d.name || d.model} (Model: ${d.model}, IP: ${d.ip}, MAC: ${d.mac}, Status: ${d.status})`);
    }
  }
  console.log('');

  // 6. Test listClients
  const clients = await testMethod('listClients');
  if (Array.isArray(clients)) {
    const wirelessCount = clients.filter(c => c.wireless).length;
    const wiredCount = clients.filter(c => !c.wireless).length;
    console.log(`   ✅ PASS: listClients returned ${clients.length} active client(s):`);
    console.log(`      • Wireless clients: ${wirelessCount}`);
    console.log(`      • Wired clients:    ${wiredCount}`);
    const sampleClients = clients.slice(0, 5);
    for (const c of sampleClients) {
      console.log(`      • Client: "${c.name || c.hostName || 'Unnamed'}" | IP: ${c.ip} | MAC: ${c.mac} | Network: ${c.wireless ? 'WiFi (' + c.ssid + ')' : 'Wired'}`);
    }
    if (clients.length > 5) {
      console.log(`      ... and ${clients.length - 5} more clients.`);
    }
  }
  console.log('');

  // 7. Test getDashboardOverview
  const overview = await testMethod('getDashboardOverview');
  if (overview && typeof overview === 'object') {
    console.log('   ✅ PASS: getDashboardOverview returned telemetry:');
    console.log(`      • Gateway Status: ${overview.gatewayStatus ?? 'N/A'}`);
    console.log(`      • Total APs: ${overview.totalApNum ?? 'N/A'} (Connected: ${overview.connectedApNum ?? 'N/A'})`);
    console.log(`      • Total Switches: ${overview.totalSwitchNum ?? 'N/A'} (Connected: ${overview.connectedSwitchNum ?? 'N/A'})`);
    console.log(`      • Total Users: ${overview.totalUserNum ?? 'N/A'} (Wireless: ${overview.wirelessUserNum ?? 'N/A'}, Wired: ${overview.wiredUserNum ?? 'N/A'})`);
  }
  console.log('');

  // 8. Test getGatewayDetail
  const gwDetail = await testMethod('getGatewayDetail', { gatewayMac: '00-11-22-33-44-55' });
  if (gwDetail) {
    console.log('   ✅ PASS: getGatewayDetail returned details:');
    console.log(`      • Gateway: ${gwDetail.name || 'Gateway'} (Model: ${gwDetail.model}, IP: ${gwDetail.ip}, Firmware: ${gwDetail.firmwareVersion || gwDetail.version})`);
  }
  console.log('');

  // 9. Test getGatewayWanStatus
  const wanStatus = await testMethod('getGatewayWanStatus', { gatewayMac: '00-11-22-33-44-55' });
  if (wanStatus) {
    console.log('   ✅ PASS: getGatewayWanStatus returned WAN details:');
    console.log(`      • WAN Status:`, JSON.stringify(wanStatus).slice(0, 140) + '...');
  }
  console.log('');

  // 10. Test getDevice (fetch single device detail)
  const device = await testMethod('getDevice', { deviceId: '00-11-22-33-44-66' });
  if (device) {
    console.log('   ✅ PASS: getDevice returned AP details:');
    console.log(`      • Device: "${device.name}" (Model: ${device.model}, IP: ${device.ip}, MAC: ${device.mac}, Status: ${device.status})`);
  }
  console.log('');

  // 11. Test getClientDetail
  const clientDetail = await testMethod('getClientDetail', { clientMac: '00-11-22-33-44-77' });
  if (clientDetail) {
    console.log('   ✅ PASS: getClientDetail returned client details:');
    console.log(`      • Client: "${clientDetail.name}" (IP: ${clientDetail.ip}, MAC: ${clientDetail.mac}, SSID: ${clientDetail.ssid || 'N/A'}, Signal: ${clientDetail.signalLevel || clientDetail.rssi} dBm)`);
  }
  console.log('');

  await client.close();
  console.log('=== Method Verification Run Completed ===');
}

verifyMethods().catch(err => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
