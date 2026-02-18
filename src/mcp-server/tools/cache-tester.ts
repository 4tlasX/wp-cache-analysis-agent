/**
 * Cache Tester Tool
 * Tests cache behavior with double-hit and bypass checks
 */

import { httpClient, type HttpClientResult } from './http-client.js';

export interface CacheStatusHeader {
  header: string;
  value: string;
  isHit: boolean;
}

export interface CacheTestResult {
  url: string;
  doubleHit: {
    firstRequest: RequestSummary;
    secondRequest: RequestSummary;
    cacheWorking: boolean;
    explanation: string;
  };
  bypassTest?: {
    withQueryString: RequestSummary;
    bypassed: boolean;
  };
  headers: {
    cacheControl?: string;
    expires?: string;
    etag?: string;
    lastModified?: string;
    vary?: string;
    age?: string;
    // Additional cache-related headers
    cfEdgeCache?: string;
    serverTiming?: string;
    speculationRules?: string;
  };
  cacheStatus: {
    header?: string;
    value?: string;
    isHit: boolean;
  };
  // All found cache status headers
  allCacheHeaders: CacheStatusHeader[];
}

interface RequestSummary {
  statusCode: number;
  ttfb: number;
  cacheHeader?: string;
  cacheValue?: string;
}

// Known cache status headers
const CACHE_STATUS_HEADERS = [
  'x-cache',
  'x-cache-status',
  'cf-cache-status',
  'x-fastcgi-cache',
  'x-nginx-cache',
  'x-varnish-cache',
  'x-proxy-cache',
  'x-litespeed-cache',
  'x-vercel-cache',
  'x-cache-hits',
  'x-served-by',
];

const HIT_VALUES = ['hit', 'tcp_hit', 'mem_hit', 'stale'];
const MISS_VALUES = ['miss', 'tcp_miss', 'dynamic', 'bypass', 'expired'];

// Find ALL cache status headers and determine if any show a HIT
function findAllCacheHeaders(headers: Record<string, string>): CacheStatusHeader[] {
  const found: CacheStatusHeader[] = [];

  for (const h of CACHE_STATUS_HEADERS) {
    if (headers[h]) {
      const value = headers[h].toLowerCase();
      const isHit = HIT_VALUES.some(v => value.includes(v));
      found.push({ header: h, value: headers[h], isHit });
    }
  }

  return found;
}

// Legacy function for compatibility - returns first cache status
function findCacheStatus(headers: Record<string, string>): { header?: string; value?: string; isHit: boolean } {
  const all = findAllCacheHeaders(headers);
  // If ANY header shows HIT, return that one first
  const hitHeader = all.find(h => h.isHit);
  if (hitHeader) {
    return { header: hitHeader.header, value: hitHeader.value, isHit: true };
  }
  // Otherwise return the first header found
  if (all.length > 0) {
    return { header: all[0].header, value: all[0].value, isHit: false };
  }
  return { isHit: false };
}

function summarizeRequest(result: HttpClientResult): RequestSummary {
  const cacheStatus = findCacheStatus(result.headers);
  return {
    statusCode: result.statusCode,
    ttfb: result.timing.ttfb,
    cacheHeader: cacheStatus.header,
    cacheValue: cacheStatus.value,
  };
}

export interface CacheTesterOptions {
  timeout?: number;
  testBypass?: boolean;
  delayBetweenRequests?: number;
}

export async function cacheTester(
  url: string,
  options: CacheTesterOptions = {}
): Promise<CacheTestResult> {
  const {
    timeout = 30000,
    testBypass = true,
    delayBetweenRequests = 500,
  } = options;

  // First request (should be MISS or populate cache)
  const first = await httpClient(url, { timeout });

  // Small delay to let cache populate
  await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));

  // Second request (should be HIT if caching works)
  const second = await httpClient(url, { timeout });

  const firstSummary = summarizeRequest(first);
  const secondSummary = summarizeRequest(second);
  const secondStatus = findCacheStatus(second.headers);
  const allSecondHeaders = findAllCacheHeaders(second.headers);

  // Determine if cache is working - check ALL cache headers
  let cacheWorking = false;
  let explanation = '';

  // Check if ANY cache header shows a HIT
  const hitHeaders = allSecondHeaders.filter(h => h.isHit);

  if (hitHeaders.length > 0) {
    cacheWorking = true;
    const hitInfo = hitHeaders.map(h => `${h.header}: ${h.value}`).join(', ');
    explanation = `Cache HIT detected (${hitInfo})`;
  } else if (second.timing.ttfb < first.timing.ttfb * 0.5) {
    // If second request is significantly faster, cache might be working
    cacheWorking = true;
    explanation = `Second request was ${Math.round((1 - second.timing.ttfb / first.timing.ttfb) * 100)}% faster, suggesting cache is working`;
  } else if (allSecondHeaders.length > 0) {
    const missInfo = allSecondHeaders.map(h => `${h.header}: ${h.value}`).join(', ');
    explanation = `Cache status: ${missInfo}`;
  } else {
    explanation = 'No cache status headers found and no significant speed improvement';
  }

  // Get all cache headers for complete picture
  const allCacheHeaders = findAllCacheHeaders(second.headers);

  const result: CacheTestResult = {
    url,
    doubleHit: {
      firstRequest: firstSummary,
      secondRequest: secondSummary,
      cacheWorking,
      explanation,
    },
    headers: {
      cacheControl: second.headers['cache-control'],
      expires: second.headers['expires'],
      etag: second.headers['etag'],
      lastModified: second.headers['last-modified'],
      vary: second.headers['vary'],
      age: second.headers['age'],
      // Additional cache-related headers
      cfEdgeCache: second.headers['cf-edge-cache'],
      serverTiming: second.headers['server-timing'],
      speculationRules: second.headers['speculation-rules'],
    },
    cacheStatus: secondStatus,
    allCacheHeaders,
  };

  // Test bypass with query string
  if (testBypass) {
    const bypassUrl = `${url}${url.includes('?') ? '&' : '?'}nocache=${Date.now()}`;
    const bypassResult = await httpClient(bypassUrl, { timeout });
    const bypassStatus = findCacheStatus(bypassResult.headers);

    result.bypassTest = {
      withQueryString: summarizeRequest(bypassResult),
      bypassed: !bypassStatus.isHit,
    };
  }

  return result;
}

// MCP Tool definition
export const cacheTesterTool = {
  name: 'cache-tester',
  description: 'Tests cache behavior with double-hit check and optional bypass test',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to test',
      },
      testBypass: {
        type: 'boolean',
        description: 'Whether to test cache bypass with query string (default: true)',
      },
      timeout: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 30000)',
      },
    },
    required: ['url'],
  },
};
