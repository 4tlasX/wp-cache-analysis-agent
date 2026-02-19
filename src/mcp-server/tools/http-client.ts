/**
 * HTTP Client Tool
 * Fetches a URL and captures headers, HTML, cookies, and timing
 */

export interface HttpClientResult {
  url: string;
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string>;
  html: string;
  htmlComments: string[];
  cookies: string[];
  timing: {
    dns: number;
    connect: number;
    ttfb: number;
    total: number;
  };
  error?: string;
}

export interface HttpClientOptions {
  timeout?: number;
  followRedirects?: boolean;
  userAgent?: string;
  headers?: Record<string, string>;
}

// Extract HTML comments from source
function extractHtmlComments(html: string): string[] {
  const comments: string[] = [];
  const regex = /<!--([\s\S]*?)-->/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    comments.push(match[1].trim());
  }
  return comments;
}

// Parse Set-Cookie headers
function parseCookies(headers: Headers): string[] {
  const cookies: string[] = [];
  const setCookie = headers.get('set-cookie');
  if (setCookie) {
    // Split on comma followed by space and cookie name pattern
    cookies.push(...setCookie.split(/,\s*(?=[^;,]+=)/));
  }
  return cookies;
}

export async function httpClient(
  url: string,
  options: HttpClientOptions = {}
): Promise<HttpClientResult> {
  const {
    timeout = 30000,
    followRedirects = true,
    userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    headers: customHeaders = {},
  } = options;

  const startTime = performance.now();
  let dnsTime = 0;
  let connectTime = 0;
  let ttfbTime = 0;

  try {
    // Validate URL
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only HTTP/HTTPS URLs are supported');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Build headers, allowing custom headers to override defaults
    const requestHeaders: Record<string, string> = {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Ch-Ua': '"Chromium";v="123", "Google Chrome";v="123", "Not:A-Brand";v="8"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      ...customHeaders,
    };

    const response = await fetch(url, {
      method: 'GET',
      headers: requestHeaders,
      redirect: followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
    });

    ttfbTime = performance.now() - startTime;
    clearTimeout(timeoutId);

    // Read body with size limit (10MB)
    const maxSize = 10 * 1024 * 1024;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.length;
        if (totalSize > maxSize) {
          reader.cancel();
          throw new Error('Response too large (>10MB)');
        }
        chunks.push(value);
      }
    }

    const html = new TextDecoder().decode(
      chunks.reduce((acc, chunk) => {
        const merged = new Uint8Array(acc.length + chunk.length);
        merged.set(acc);
        merged.set(chunk, acc.length);
        return merged;
      }, new Uint8Array())
    );

    const totalTime = performance.now() - startTime;

    // Convert headers to plain object
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    return {
      url,
      finalUrl: response.url,
      statusCode: response.status,
      headers,
      html,
      htmlComments: extractHtmlComments(html),
      cookies: parseCookies(response.headers),
      timing: {
        dns: dnsTime,
        connect: connectTime,
        ttfb: Math.round(ttfbTime),
        total: Math.round(totalTime),
      },
    };
  } catch (error) {
    const totalTime = performance.now() - startTime;
    return {
      url,
      finalUrl: url,
      statusCode: 0,
      headers: {},
      html: '',
      htmlComments: [],
      cookies: [],
      timing: {
        dns: 0,
        connect: 0,
        ttfb: 0,
        total: Math.round(totalTime),
      },
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// MCP Tool definition
export const httpClientTool = {
  name: 'http-client',
  description: 'Fetches a URL and returns headers, HTML, cookies, and timing information',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      timeout: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 30000)',
      },
    },
    required: ['url'],
  },
};
