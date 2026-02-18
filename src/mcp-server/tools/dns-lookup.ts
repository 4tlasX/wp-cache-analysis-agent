/**
 * DNS Lookup Tool
 * Performs DNS lookups to help detect CDNs and WAFs
 */

import { promises as dns } from 'node:dns';

export interface DnsLookupResult {
  hostname: string;
  addresses: AddressInfo[];
  cnames: string[];
  nameservers: string[];
  detected: {
    cdn?: string;
    waf?: string;
    hosting?: string;
  };
  error?: string;
}

interface AddressInfo {
  address: string;
  family: 4 | 6;
}

// Known CDN/WAF IP ranges and CNAME patterns
const CDN_PATTERNS: Record<string, { cnames?: RegExp[]; ipRanges?: string[] }> = {
  cloudflare: {
    cnames: [/\.cloudflare\.com$/i, /\.cloudflare-dns\.com$/i],
  },
  fastly: {
    cnames: [/\.fastly\.net$/i, /\.fastlylb\.net$/i],
  },
  akamai: {
    cnames: [/\.akamai\.net$/i, /\.akamaiedge\.net$/i, /\.edgekey\.net$/i],
  },
  cloudfront: {
    cnames: [/\.cloudfront\.net$/i],
  },
  keycdn: {
    cnames: [/\.kxcdn\.com$/i],
  },
  bunnycdn: {
    cnames: [/\.b-cdn\.net$/i],
  },
  sucuri: {
    cnames: [/\.sucuri\.net$/i, /\.sucuridns\.com$/i],
  },
  stackpath: {
    cnames: [/\.stackpathdns\.com$/i, /\.hwcdn\.net$/i],
  },
  incapsula: {
    cnames: [/\.incapdns\.net$/i],
  },
};

const HOSTING_PATTERNS: Record<string, RegExp[]> = {
  'WP Engine': [/\.wpengine\.com$/i, /\.wpenginepowered\.com$/i],
  'Kinsta': [/\.kinsta\.cloud$/i],
  'SiteGround': [/\.sgvps\.net$/i, /\.siteground\.net$/i],
  'GoDaddy': [/\.godaddy\.com$/i, /\.secureserver\.net$/i],
  'Bluehost': [/\.bluehost\.com$/i],
  'AWS': [/\.amazonaws\.com$/i, /\.aws\.amazon\.com$/i],
  'Google Cloud': [/\.googleusercontent\.com$/i, /\.google\.com$/i],
  'DigitalOcean': [/\.digitalocean\.com$/i],
  'Vercel': [/\.vercel-dns\.com$/i, /\.vercel\.app$/i],
  'Netlify': [/\.netlify\.com$/i, /\.netlify\.app$/i],
};

function detectFromCnames(cnames: string[]): { cdn?: string; waf?: string; hosting?: string } {
  const result: { cdn?: string; waf?: string; hosting?: string } = {};

  for (const cname of cnames) {
    // Check CDN patterns
    for (const [name, patterns] of Object.entries(CDN_PATTERNS)) {
      if (patterns.cnames?.some(p => p.test(cname))) {
        if (['sucuri', 'incapsula'].includes(name)) {
          result.waf = name.charAt(0).toUpperCase() + name.slice(1);
        } else {
          result.cdn = name.charAt(0).toUpperCase() + name.slice(1);
        }
        break;
      }
    }

    // Check hosting patterns
    for (const [name, patterns] of Object.entries(HOSTING_PATTERNS)) {
      if (patterns.some(p => p.test(cname))) {
        result.hosting = name;
        break;
      }
    }
  }

  return result;
}

async function resolveCnames(hostname: string): Promise<string[]> {
  const cnames: string[] = [];
  let current = hostname;
  const seen = new Set<string>();

  while (!seen.has(current)) {
    seen.add(current);
    try {
      const result = await dns.resolveCname(current);
      if (result.length > 0) {
        cnames.push(result[0]);
        current = result[0];
      } else {
        break;
      }
    } catch {
      break; // No CNAME record
    }
  }

  return cnames;
}

export interface DnsLookupOptions {
  resolveCnames?: boolean;
  resolveNameservers?: boolean;
}

export async function dnsLookup(
  url: string,
  options: DnsLookupOptions = {}
): Promise<DnsLookupResult> {
  const { resolveCnames: doCnames = true, resolveNameservers = true } = options;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return {
      hostname: url,
      addresses: [],
      cnames: [],
      nameservers: [],
      detected: {},
      error: 'Invalid URL',
    };
  }

  const result: DnsLookupResult = {
    hostname,
    addresses: [],
    cnames: [],
    nameservers: [],
    detected: {},
  };

  try {
    // Resolve A/AAAA records
    const [ipv4, ipv6] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);

    if (ipv4.status === 'fulfilled') {
      result.addresses.push(...ipv4.value.map(a => ({ address: a, family: 4 as const })));
    }
    if (ipv6.status === 'fulfilled') {
      result.addresses.push(...ipv6.value.map(a => ({ address: a, family: 6 as const })));
    }

    // Resolve CNAME chain
    if (doCnames) {
      result.cnames = await resolveCnames(hostname);
    }

    // Resolve nameservers for the domain
    if (resolveNameservers) {
      try {
        // Get the root domain for NS lookup
        const parts = hostname.split('.');
        const rootDomain = parts.slice(-2).join('.');
        result.nameservers = await dns.resolveNs(rootDomain);
      } catch {
        // NS lookup might fail, that's ok
      }
    }

    // Detect CDN/WAF/Hosting from CNAME chain
    result.detected = detectFromCnames([hostname, ...result.cnames]);

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'DNS lookup failed';
  }

  return result;
}

// MCP Tool definition
export const dnsLookupTool = {
  name: 'dns-lookup',
  description: 'Performs DNS lookups to detect CDN, WAF, and hosting providers',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to analyze',
      },
      resolveCnames: {
        type: 'boolean',
        description: 'Whether to resolve CNAME chain (default: true)',
      },
    },
    required: ['url'],
  },
};
