/**
 * WordPress Site Health Tool
 * Fetches site info from /wp-json/ and basic server info from Site Health
 */

export interface DetectedRestPlugin {
  slug: string;
  name: string;
  namespace: string;
  category?: string;
}

export interface WPSiteHealthResult {
  url: string;
  isWordPress: boolean;
  wpVersion?: string;
  siteName?: string;
  siteDescription?: string;
  timezone?: string;
  homeUrl?: string;
  // Namespaces from REST API
  namespaces: string[];
  // Plugins detected via namespaces
  restPlugins: DetectedRestPlugin[];
  // Server info from Site Health /info endpoint
  siteHealth?: {
    phpVersion?: string;
    mysqlVersion?: string;
    serverSoftware?: string;
    curlVersion?: string;
    wpMemoryLimit?: string;
    wpDebugMode?: boolean;
    isMultisite?: boolean;
    activeTheme?: string;
    activePluginsCount?: number;
    httpsStatus?: string;
    // Object cache info
    objectCache?: {
      enabled: boolean;
      type?: string; // redis, memcached, apcu, file, etc.
      dropin?: string;
    };
  };
  error?: string;
}

interface FetchOptions {
  timeout?: number;
}

// Known namespace -> plugin mappings
const NAMESPACE_PLUGINS: Record<string, { name: string; category?: string }> = {
  // Cache plugins
  'wp-rocket': { name: 'WP Rocket', category: 'cache' },
  'litespeed': { name: 'LiteSpeed Cache', category: 'cache' },
  'wp-super-cache': { name: 'WP Super Cache', category: 'cache' },
  'w3tc': { name: 'W3 Total Cache', category: 'cache' },
  'breeze': { name: 'Breeze', category: 'cache' },
  'swift-performance': { name: 'Swift Performance', category: 'cache' },
  'powered-cache': { name: 'Powered Cache', category: 'cache' },
  'cache-enabler': { name: 'Cache Enabler', category: 'cache' },
  'comet-cache': { name: 'Comet Cache', category: 'cache' },
  'hummingbird': { name: 'Hummingbird', category: 'cache' },
  'nitropack': { name: 'NitroPack', category: 'cache' },
  'flying-press': { name: 'FlyingPress', category: 'cache' },
  'perfmatters': { name: 'Perfmatters', category: 'performance' },

  // Object cache plugins
  'redis-cache': { name: 'Redis Object Cache', category: 'object-cache' },
  'object-cache-pro': { name: 'Object Cache Pro', category: 'object-cache' },
  'docket-cache': { name: 'Docket Cache', category: 'object-cache' },
  'memcached': { name: 'Memcached', category: 'object-cache' },
  'apcu': { name: 'APCu Object Cache', category: 'object-cache' },

  // CDN/Optimization
  'cloudflare': { name: 'Cloudflare', category: 'cdn' },
  'bunnycdn': { name: 'BunnyCDN', category: 'cdn' },
  'jetpack': { name: 'Jetpack', category: 'performance' },
  'autoptimize': { name: 'Autoptimize', category: 'optimization' },
  'ewww': { name: 'EWWW Image Optimizer', category: 'optimization' },
  'smush': { name: 'Smush', category: 'optimization' },
  'imagify': { name: 'Imagify', category: 'optimization' },
  'shortpixel': { name: 'ShortPixel', category: 'optimization' },

  // SEO
  'yoast': { name: 'Yoast SEO', category: 'seo' },
  'rankmath': { name: 'Rank Math', category: 'seo' },
  'rank-math': { name: 'Rank Math', category: 'seo' },
  'aioseo': { name: 'All in One SEO', category: 'seo' },
  'seopress': { name: 'SEOPress', category: 'seo' },
  'the-seo-framework': { name: 'The SEO Framework', category: 'seo' },

  // Security
  'wordfence': { name: 'Wordfence', category: 'security' },
  'ithemes-security': { name: 'iThemes Security', category: 'security' },
  'sucuri': { name: 'Sucuri', category: 'security' },
  'all-in-one-wp-security': { name: 'All In One WP Security', category: 'security' },
  'defender': { name: 'Defender', category: 'security' },

  // E-commerce
  'wc': { name: 'WooCommerce', category: 'ecommerce' },
  'edd': { name: 'Easy Digital Downloads', category: 'ecommerce' },

  // Page builders
  'elementor': { name: 'Elementor', category: 'builder' },
  'divi': { name: 'Divi', category: 'builder' },
  'beaver-builder': { name: 'Beaver Builder', category: 'builder' },
  'bricks': { name: 'Bricks', category: 'builder' },
  'oxygen': { name: 'Oxygen', category: 'builder' },
  'breakdance': { name: 'Breakdance', category: 'builder' },
  'wpbakery': { name: 'WPBakery', category: 'builder' },
  'fl-builder': { name: 'Beaver Builder', category: 'builder' },

  // Forms
  'wpforms': { name: 'WPForms', category: 'forms' },
  'gravityforms': { name: 'Gravity Forms', category: 'forms' },
  'gf': { name: 'Gravity Forms', category: 'forms' },
  'contact-form-7': { name: 'Contact Form 7', category: 'forms' },
  'fluentform': { name: 'Fluent Forms', category: 'forms' },
  'forminator': { name: 'Forminator', category: 'forms' },
  'ninja-forms': { name: 'Ninja Forms', category: 'forms' },

  // Other popular
  'acf': { name: 'Advanced Custom Fields', category: 'developer' },
  'wpgraphql': { name: 'WPGraphQL', category: 'developer' },
  'wp-graphql': { name: 'WPGraphQL', category: 'developer' },
  'redirection': { name: 'Redirection', category: 'utility' },
  'updraftplus': { name: 'UpdraftPlus', category: 'backup' },
  'duplicator': { name: 'Duplicator', category: 'backup' },
  'mainwp': { name: 'MainWP', category: 'management' },
  'monsterinsights': { name: 'MonsterInsights', category: 'analytics' },
  'cookieyes': { name: 'CookieYes', category: 'compliance' },
  'complianz': { name: 'Complianz', category: 'compliance' },
  'polylang': { name: 'Polylang', category: 'translation' },
  'wpml': { name: 'WPML', category: 'translation' },
  'translatepress': { name: 'TranslatePress', category: 'translation' },
  'membpress': { name: 'MemberPress', category: 'membership' },
  'learndash': { name: 'LearnDash', category: 'lms' },
  'tutor': { name: 'Tutor LMS', category: 'lms' },
  'buddypress': { name: 'BuddyPress', category: 'community' },
  'bbpress': { name: 'bbPress', category: 'forum' },
};

// Browser-like headers to avoid bot detection
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Sec-Ch-Ua': '"Chromium";v="123", "Google Chrome";v="123", "Not:A-Brand";v="8"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

async function fetchJson(url: string, options: FetchOptions = {}): Promise<any> {
  const { timeout = 10000 } = options;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'GET',
      headers: BROWSER_HEADERS,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

function detectPluginsFromNamespaces(namespaces: string[]): DetectedRestPlugin[] {
  const detected: DetectedRestPlugin[] = [];
  const seen = new Set<string>();

  for (const ns of namespaces) {
    // Extract base namespace (before /v1, /v2, etc.)
    const baseName = ns.split('/')[0].toLowerCase();

    // Check against known plugins
    for (const [prefix, plugin] of Object.entries(NAMESPACE_PLUGINS)) {
      if (baseName === prefix || baseName.startsWith(prefix + '-') || ns.toLowerCase().includes(prefix)) {
        if (!seen.has(plugin.name)) {
          seen.add(plugin.name);
          detected.push({
            slug: prefix,
            name: plugin.name,
            namespace: ns,
            category: plugin.category,
          });
        }
        break;
      }
    }
  }

  return detected;
}

export interface ObjectCacheProbeResult {
  exists: boolean;
  type?: 'Redis' | 'Memcached' | 'APCu' | 'Docket Cache' | 'LiteSpeed' | 'Unknown';
  plugin?: string;
  signatures: string[];
}

// Known object cache signatures in object-cache.php content
const OBJECT_CACHE_SIGNATURES: Array<{
  pattern: RegExp;
  type: ObjectCacheProbeResult['type'];
  plugin?: string;
}> = [
  // Redis Object Cache plugin
  { pattern: /redis\s*object\s*cache/i, type: 'Redis', plugin: 'Redis Object Cache' },
  { pattern: /class\s+WP_Object_Cache.*redis/is, type: 'Redis' },
  { pattern: /\$redis|new\s+Redis\(|Redis::|\bredis\b.*connect/i, type: 'Redis' },
  { pattern: /predis/i, type: 'Redis', plugin: 'Predis' },
  { pattern: /phpredis/i, type: 'Redis' },
  { pattern: /object-cache-pro/i, type: 'Redis', plugin: 'Object Cache Pro' },

  // Memcached
  { pattern: /memcached?\s*object\s*cache/i, type: 'Memcached' },
  { pattern: /class\s+WP_Object_Cache.*memcache/is, type: 'Memcached' },
  { pattern: /\$memcache|new\s+Memcache[d]?\(|Memcache[d]?::/i, type: 'Memcached' },
  { pattern: /addServer.*11211/i, type: 'Memcached' },

  // APCu
  { pattern: /apcu\s*object\s*cache/i, type: 'APCu' },
  { pattern: /apcu_fetch|apcu_store|apcu_add/i, type: 'APCu' },

  // Docket Cache
  { pattern: /docket[_-]?cache/i, type: 'Docket Cache', plugin: 'Docket Cache' },
  { pattern: /Nawawi\\DocketCache/i, type: 'Docket Cache', plugin: 'Docket Cache' },

  // LiteSpeed
  { pattern: /litespeed/i, type: 'LiteSpeed', plugin: 'LiteSpeed Cache' },
  { pattern: /LSCWP/i, type: 'LiteSpeed', plugin: 'LiteSpeed Cache' },
];

async function probeObjectCache(baseUrl: string, timeout: number): Promise<ObjectCacheProbeResult> {
  const objectCachePath = `${baseUrl}/wp-content/object-cache.php`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // First do a HEAD request to check existence
    const headResponse = await fetch(objectCachePath, {
      method: 'HEAD',
      signal: controller.signal,
      headers: BROWSER_HEADERS,
    });

    clearTimeout(timeoutId);

    // 200 or 403 means file exists (403 = server blocking direct PHP access, which is good)
    if (headResponse.status === 404) {
      return { exists: false, signatures: [] };
    }

    if (headResponse.status === 200 || headResponse.status === 403) {
      // Try to GET the file content - some servers may return PHP source or error page with hints
      try {
        const getController = new AbortController();
        const getTimeoutId = setTimeout(() => getController.abort(), timeout);

        const getResponse = await fetch(objectCachePath, {
          method: 'GET',
          signal: getController.signal,
          headers: BROWSER_HEADERS,
        });

        clearTimeout(getTimeoutId);

        const content = await getResponse.text();
        const signatures: string[] = [];
        let detectedType: ObjectCacheProbeResult['type'] = 'Unknown';
        let detectedPlugin: string | undefined;

        // Check against known signatures
        for (const sig of OBJECT_CACHE_SIGNATURES) {
          if (sig.pattern.test(content)) {
            signatures.push(sig.pattern.source.substring(0, 30));
            if (detectedType === 'Unknown') {
              detectedType = sig.type;
              detectedPlugin = sig.plugin;
            }
          }
        }

        return {
          exists: true,
          type: detectedType,
          plugin: detectedPlugin,
          signatures,
        };
      } catch {
        // GET failed but HEAD succeeded - file exists
        return { exists: true, signatures: [] };
      }
    }

    return { exists: false, signatures: [] };
  } catch {
    return { exists: false, signatures: [] };
  }
}

export interface WPSiteHealthOptions {
  timeout?: number;
}

export async function wpSiteHealth(
  url: string,
  options: WPSiteHealthOptions = {}
): Promise<WPSiteHealthResult> {
  const { timeout = 10000 } = options;

  // Normalize URL
  let baseUrl = url.replace(/\/$/, '');
  if (!baseUrl.startsWith('http')) {
    baseUrl = `https://${baseUrl}`;
  }

  const result: WPSiteHealthResult = {
    url: baseUrl,
    isWordPress: true, // Always assume WordPress
    namespaces: [],
    restPlugins: [],
  };

  // Fetch /wp-json/, /wp-json/wp-site-health/v1/info, and probe object-cache.php in parallel
  const [wpJson, debugInfo, objectCacheProbe] = await Promise.all([
    fetchJson(`${baseUrl}/wp-json/`, { timeout }),
    fetchJson(`${baseUrl}/wp-json/wp-site-health/v1/info`, { timeout }),
    probeObjectCache(baseUrl, timeout),
  ]);

  // Try alternate URL if /wp-json/ failed (pretty permalinks disabled)
  let wpJsonData = wpJson;
  if (!wpJsonData) {
    wpJsonData = await fetchJson(`${baseUrl}/?rest_route=/`, { timeout });
  }

  if (!wpJsonData) {
    result.error = 'WP REST API not accessible';
    // Still try to get object cache and other data even if REST API failed
  }

  // Process REST API data if available
  if (wpJsonData) {
    // Basic site info from /wp-json/
    result.siteName = wpJsonData.name;
    result.siteDescription = wpJsonData.description;
    result.homeUrl = wpJsonData.home;
    result.timezone = wpJsonData.timezone_string;

    // Get namespaces - reveals installed plugins
    if (wpJsonData.namespaces && Array.isArray(wpJsonData.namespaces)) {
      result.namespaces = wpJsonData.namespaces;
      result.restPlugins = detectPluginsFromNamespaces(wpJsonData.namespaces);
    }

    // Determine WP version from namespaces
    if (result.namespaces.includes('wp/v2')) {
      if (result.namespaces.includes('wp-site-health/v1')) {
        result.wpVersion = '5.2+';
      } else if (result.namespaces.includes('wp-block-editor/v1')) {
        result.wpVersion = '5.0+';
      } else {
        result.wpVersion = '4.7+';
      }
    }
  }

  // Parse server info from Site Health /info endpoint
  if (debugInfo && typeof debugInfo === 'object') {
    result.siteHealth = {};

    // WordPress version (more accurate than namespace detection)
    if (debugInfo['wp-core']?.fields?.version?.value) {
      result.wpVersion = debugInfo['wp-core'].fields.version.value;
    }

    // Server info
    if (debugInfo['wp-server']?.fields) {
      const server = debugInfo['wp-server'].fields;
      result.siteHealth.phpVersion = server.php_version?.value;
      result.siteHealth.serverSoftware = server.httpd_software?.value;
      result.siteHealth.curlVersion = server.curl_version?.value;
    }

    // Database info
    if (debugInfo['wp-database']?.fields) {
      const db = debugInfo['wp-database'].fields;
      result.siteHealth.mysqlVersion = db.server_version?.value || db.extension?.value;
    }

    // WordPress constants
    if (debugInfo['wp-constants']?.fields) {
      const constants = debugInfo['wp-constants'].fields;
      result.siteHealth.wpMemoryLimit = constants.WP_MEMORY_LIMIT?.value;
      const debugVal = constants.WP_DEBUG?.value;
      result.siteHealth.wpDebugMode = debugVal === 'true' || debugVal === true;
    }

    // Multisite check
    if (debugInfo['wp-core']?.fields?.multisite) {
      const multiVal = debugInfo['wp-core'].fields.multisite.value;
      result.siteHealth.isMultisite = multiVal === true || multiVal === 'true';
    }

    // Active theme
    if (debugInfo['wp-active-theme']?.fields?.name?.value) {
      result.siteHealth.activeTheme = debugInfo['wp-active-theme'].fields.name.value;
    }

    // Active plugins count
    if (debugInfo['wp-plugins-active']?.fields) {
      result.siteHealth.activePluginsCount = Object.keys(debugInfo['wp-plugins-active'].fields).length;
    }

    // HTTPS status
    if (debugInfo['wp-core']?.fields?.https_status?.value) {
      result.siteHealth.httpsStatus = debugInfo['wp-core'].fields.https_status.value;
    }

    // Object cache detection
    // Check wp-dropins for object-cache.php
    if (debugInfo['wp-dropins']?.fields?.['object-cache.php']) {
      const dropin = debugInfo['wp-dropins'].fields['object-cache.php'];
      result.siteHealth.objectCache = {
        enabled: true,
        dropin: dropin.value || dropin.debug || 'object-cache.php',
      };
      // Try to detect type from dropin name
      const dropinStr = String(dropin.value || dropin.debug || '').toLowerCase();
      if (dropinStr.includes('redis')) {
        result.siteHealth.objectCache.type = 'Redis';
      } else if (dropinStr.includes('memcache')) {
        result.siteHealth.objectCache.type = 'Memcached';
      } else if (dropinStr.includes('apcu')) {
        result.siteHealth.objectCache.type = 'APCu';
      } else if (dropinStr.includes('docket')) {
        result.siteHealth.objectCache.type = 'Docket Cache';
      }
    }

    // Also check wp-constants for object cache constants
    if (debugInfo['wp-constants']?.fields) {
      const constants = debugInfo['wp-constants'].fields;
      // WP_CACHE_KEY_SALT indicates object cache is configured
      if (constants.WP_CACHE_KEY_SALT?.value && !result.siteHealth.objectCache) {
        result.siteHealth.objectCache = { enabled: true };
      }
    }

    // Check wp-server for Redis/Memcached extensions
    if (debugInfo['wp-server']?.fields) {
      const server = debugInfo['wp-server'].fields;
      if (!result.siteHealth.objectCache?.type) {
        if (server.redis_version?.value) {
          result.siteHealth.objectCache = result.siteHealth.objectCache || { enabled: false };
          result.siteHealth.objectCache.type = `Redis ${server.redis_version.value}`;
        }
        if (server.memcached_version?.value) {
          result.siteHealth.objectCache = result.siteHealth.objectCache || { enabled: false };
          result.siteHealth.objectCache.type = `Memcached ${server.memcached_version.value}`;
        }
      }
    }
  }

  // Direct probe of object-cache.php (works even when REST API is limited)
  if (objectCacheProbe.exists) {
    if (!result.siteHealth) {
      result.siteHealth = {};
    }
    // Merge probe results - probe takes precedence for type detection if REST API didn't find it
    if (!result.siteHealth.objectCache) {
      result.siteHealth.objectCache = {
        enabled: true,
        type: objectCacheProbe.type,
        dropin: objectCacheProbe.plugin || 'object-cache.php',
      };
    } else if (!result.siteHealth.objectCache.type || result.siteHealth.objectCache.type === 'Unknown') {
      // REST API found object cache but couldn't determine type - use probe result
      result.siteHealth.objectCache.type = objectCacheProbe.type;
      if (objectCacheProbe.plugin) {
        result.siteHealth.objectCache.dropin = objectCacheProbe.plugin;
      }
    }
  }

  return result;
}

// MCP Tool definition
export const wpSiteHealthTool = {
  name: 'wp-site-health',
  description: 'Fetches WordPress site info from REST API and detects plugins via namespaces',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The WordPress site URL',
      },
      timeout: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 10000)',
      },
    },
    required: ['url'],
  },
};
