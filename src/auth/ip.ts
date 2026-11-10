import { isIP, isIPv6 } from 'node:net';
import type { FastifyRequest } from 'fastify';

/**
 * Where this request really came from: Cloudflare's CF-Connecting-IP when it is
 * a valid address, else the socket's. The header is only trustworthy because the
 * app is reachable solely through the Cloudflare tunnel (see README); a valid-IP
 * check also keeps junk out of the log and the rate-limit table.
 */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && isIP(cf.trim())) return cf.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * What the login rate limit counts by. IPv4 is the address itself. An IPv6
 * visitor usually controls a whole /64, so it is counted by that prefix, or
 * rotating through addresses would reset the limit on every try.
 */
export function rateKey(ip: string): string {
  const addr = ip.split('%')[0].toLowerCase(); // drop a zone id
  if (!isIPv6(addr) || addr.includes('.')) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr); // IPv4-mapped IPv6
    return mapped ? mapped[1] : addr;
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups =
    tail === undefined ? h : [...h, ...new Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return `v6:${groups
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':')}`;
}
