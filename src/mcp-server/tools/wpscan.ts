/**
 * WPScan API Tool
 * Detects WordPress plugins and checks for vulnerabilities
 * Free tier: 25 requests/day
 */

export interface WPScanPlugin {
  slug: string;
  name: string;
  version?: string;
  latestVersion?: string;
  outdated: boolean;
  vulnerabilities: WPScanVulnerability[];
}

export interface WPScanVulnerability {
  id: string;
  title: string;
  type: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  fixedIn?: string;
  references: string[];
}

export interface WPScanTheme {
  slug: string;
  name: string;
  version?: string;
  latestVersion?: string;
  outdated: boolean;
  vulnerabilities: WPScanVulnerability[];
}

export interface WPScanResult {
  url: string;
  wpVersion?: string;
  wpVersionVulnerable: boolean;
  plugins: WPScanPlugin[];
  themes: WPScanTheme[];
  vulnerabilityCount: number;
  error?: string;
}

interface WPScanOptions {
  apiToken?: string;
  timeout?: number;
}

// Probe common plugin paths to detect installed plugins
const COMMON_PLUGINS = [
  'akismet',
  'contact-form-7',
  'wordpress-seo',
  'woocommerce',
  'elementor',
  'wpforms-lite',
  'classic-editor',
  'jetpack',
  'wordfence',
  'really-simple-ssl',
  'duplicate-post',
  'all-in-one-seo-pack',
  'wp-mail-smtp',
  'updraftplus',
  'google-analytics-for-wordpress',
  'redirection',
  'wp-super-cache',
  'w3-total-cache',
  'wp-rocket',
  'litespeed-cache',
  'autoptimize',
  'wp-fastest-cache',
  'redis-cache',
  'imagify',
  'wp-smush',
  'shortpixel-image-optimiser',
  'regenerate-thumbnails',
  'tablepress',
  'tinymce-advanced',
  'better-wp-security',
  'sucuri-scanner',
  'limit-login-attempts-reloaded',
  'two-factor',
  'google-sitemap-generator',
  'yoast-seo-premium',
  'mailchimp-for-wp',
  'easy-digital-downloads',
  'bbpress',
  'buddypress',
  'memberpress',
  'learnpress',
];

async function probePlugin(baseUrl: string, slug: string, timeout: number): Promise<{ found: boolean; version?: string }> {
  const readmePath = `${baseUrl}/wp-content/plugins/${slug}/readme.txt`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(readmePath, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent': 'WP-Cache-Analyzer/1.0',
      },
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      // Try to get version from readme
      try {
        const readmeResponse = await fetch(readmePath, {
          signal: AbortSignal.timeout(timeout),
          headers: { 'User-Agent': 'WP-Cache-Analyzer/1.0' },
        });
        const text = await readmeResponse.text();
        const versionMatch = text.match(/Stable tag:\s*([\d.]+)/i);
        return { found: true, version: versionMatch?.[1] };
      } catch {
        return { found: true };
      }
    }

    return { found: false };
  } catch {
    return { found: false };
  }
}

async function fetchVulnerabilities(
  slug: string,
  version: string | undefined,
  apiToken: string
): Promise<WPScanVulnerability[]> {
  try {
    const response = await fetch(`https://wpscan.com/api/v3/plugins/${slug}`, {
      headers: {
        'Authorization': `Token token=${apiToken}`,
        'User-Agent': 'WP-Cache-Analyzer/1.0',
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json() as any;
    const pluginData = data[slug];

    if (!pluginData?.vulnerabilities) {
      return [];
    }

    return pluginData.vulnerabilities
      .filter((vuln: any) => {
        // If we have a version, only show vulns that affect it
        if (version && vuln.fixed_in) {
          return compareVersions(version, vuln.fixed_in) < 0;
        }
        return true;
      })
      .map((vuln: any) => ({
        id: vuln.id?.toString() || '',
        title: vuln.title || 'Unknown vulnerability',
        type: vuln.vuln_type || 'unknown',
        severity: mapSeverity(vuln.cvss?.score),
        fixedIn: vuln.fixed_in,
        references: vuln.references?.url || [],
      }));
  } catch {
    return [];
  }
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

function mapSeverity(cvssScore?: number): 'low' | 'medium' | 'high' | 'critical' | undefined {
  if (cvssScore === undefined) return undefined;
  if (cvssScore >= 9.0) return 'critical';
  if (cvssScore >= 7.0) return 'high';
  if (cvssScore >= 4.0) return 'medium';
  return 'low';
}

export async function wpscan(url: string, options: WPScanOptions = {}): Promise<WPScanResult> {
  const { apiToken, timeout = 5000 } = options;

  // Normalize URL
  let baseUrl = url.replace(/\/$/, '');
  if (!baseUrl.startsWith('http')) {
    baseUrl = `https://${baseUrl}`;
  }

  const result: WPScanResult = {
    url: baseUrl,
    wpVersionVulnerable: false,
    plugins: [],
    themes: [],
    vulnerabilityCount: 0,
  };

  // Probe for plugins in parallel (batches of 10)
  const detectedPlugins: WPScanPlugin[] = [];

  for (let i = 0; i < COMMON_PLUGINS.length; i += 10) {
    const batch = COMMON_PLUGINS.slice(i, i + 10);
    const probes = await Promise.all(
      batch.map(async (slug) => {
        const probe = await probePlugin(baseUrl, slug, timeout);
        return { slug, ...probe };
      })
    );

    for (const probe of probes) {
      if (probe.found) {
        const plugin: WPScanPlugin = {
          slug: probe.slug,
          name: probe.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          version: probe.version,
          outdated: false,
          vulnerabilities: [],
        };

        // If we have API token, check for vulnerabilities
        if (apiToken && probe.version) {
          plugin.vulnerabilities = await fetchVulnerabilities(probe.slug, probe.version, apiToken);
          result.vulnerabilityCount += plugin.vulnerabilities.length;
        }

        detectedPlugins.push(plugin);
      }
    }
  }

  result.plugins = detectedPlugins;

  return result;
}

// MCP Tool definition
export const wpscanTool = {
  name: 'wpscan',
  description: 'Detects WordPress plugins by probing common paths and optionally checks for vulnerabilities via WPScan API',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The WordPress site URL to scan',
      },
      apiToken: {
        type: 'string',
        description: 'WPScan API token for vulnerability lookup (optional)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout per request in milliseconds (default: 5000)',
      },
    },
    required: ['url'],
  },
};
