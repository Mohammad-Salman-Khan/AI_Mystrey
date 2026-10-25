import { setServers } from 'node:dns';

/**
 * Configure Node's c-ares resolver before the MongoDB driver is imported.
 * `dns.lookup()` uses the OS resolver; `resolveSrv()` uses this resolver list,
 * which is what mongodb+srv connection strings rely on.
 */
export function initializeDnsServers(): void {
  const configured = process.env.DNS_SERVERS?.trim();
  if (!configured) return;

  const servers = configured.split(',').map(server => server.trim()).filter(Boolean);
  if (servers.length === 0) {
    throw new Error('DNS_SERVERS is set but does not contain a DNS server address.');
  }

  setServers(servers);
  console.info(`Configured Node DNS resolver servers (${servers.length}).`);
}
