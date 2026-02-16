import { NextResponse } from 'next/server';
import os from 'os';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const hostname = os.hostname();
    const port = process.env.PORT || '3000';
    const platform = os.type();
    const arch = os.arch();
    const nodeVersion = process.version;
    const cpuCount = os.cpus().length;
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const osUptime = os.uptime();
    const processUptime = process.uptime();

    // Gather all network interfaces with IPs
    const rawInterfaces = os.networkInterfaces();
    const interfaces: { name: string; address: string; family: string; internal: boolean }[] = [];
    let primaryIP = '127.0.0.1';

    for (const [name, addrs] of Object.entries(rawInterfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        interfaces.push({
          name,
          address: addr.address,
          family: addr.family,
          internal: addr.internal,
        });
        // Pick the first external IPv4 as primary
        if (addr.family === 'IPv4' && !addr.internal && primaryIP === '127.0.0.1') {
          primaryIP = addr.address;
        }
      }
    }

    const mcpEndpoint = `http://${primaryIP}:${port}/api/mcp/execute`;

    return NextResponse.json({
      hostname,
      port,
      primaryIP,
      mcpEndpoint,
      interfaces,
      platform: {
        os: platform,
        arch,
        nodeVersion,
        cpuCount,
        totalMemory,
        freeMemory,
      },
      uptime: {
        os: osUptime,
        process: processUptime,
      },
    });
  } catch (error) {
    console.error('Server info error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get server info' },
      { status: 500 }
    );
  }
}
