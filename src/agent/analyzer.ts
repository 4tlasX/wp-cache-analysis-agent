/**
 * Analyzer
 * Maps tool outputs to signatures and detects cache plugins, CDNs, conflicts
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { HttpClientResult } from '../mcp-server/tools/http-client.js';
import type { CacheTestResult, CacheStatusHeader } from '../mcp-server/tools/cache-tester.js';
import type { DnsLookupResult } from '../mcp-server/tools/dns-lookup.js';
import type { WPScanResult, WPScanPlugin } from '../mcp-server/tools/wpscan.js';
import type { WPSiteHealthResult } from '../mcp-server/tools/wp-site-health.js';
import type { SSLInfoResult } from '../mcp-server/tools/ssl-info.js';
import { analyzeImages } from '../mcp-server/tools/image-analyzer.js';

// Types for signatures
interface PluginSignature {
  name: string;
  category: string;
  signatures: {
    html_comments?: string[];
    headers?: string[];
    cookies?: string[];
    paths?: string[];
  };
}

interface CdnSignature {
  name: string;
  signatures: {
    headers?: string[];
    server?: string;
    via?: string;
  };
}

interface Conflict {
  plugins: string[];
  severity: 'high' | 'medium' | 'low';
  reason: string;
}

interface Signatures {
  plugins: Record<string, PluginSignature>;
  cdns: Record<string, CdnSignature>;
  server_cache: Record<string, CdnSignature>;
  conflicts: Conflict[];
}

// Analysis result types
export interface DetectedPlugin {
  slug: string;
  name: string;
  category: string;
  matchedBy: string[];
}

export interface DetectedCdn {
  slug: string;
  name: string;
  matchedBy: string[];
}

export interface DetectedConflict {
  plugins: string[];
  severity: 'high' | 'medium' | 'low';
  reason: string;
}

export interface ServerSpecs {
  server?: string;
  originServer?: string;  // Actual server behind CDN
  poweredBy?: string;
  phpVersion?: string;
  hosting?: string;
  protocol?: string;
  tls?: string;
}

export interface DnsInfo {
  hostname: string;
  addresses: string[];
  cnames: string[];
  nameservers: string[];
}

export interface TimingInfo {
  ttfb: number;
  ttfbCached?: number;
  improvement?: number;
}

export interface AnalysisResult {
  url: string;
  isWordPress: boolean;
  plugins: DetectedPlugin[];
  cdns: DetectedCdn[];
  serverCache: DetectedCdn[];
  conflicts: DetectedConflict[];
  cacheStatus: {
    working: boolean;
    header?: string;
    value?: string;
    explanation: string;
    allHeaders: CacheStatusHeader[];
  };
  headers: {
    cacheControl?: string;
    expires?: string;
    etag?: string;
    lastModified?: string;
    server?: string;
    // Additional cache-related headers
    cfEdgeCache?: string;
    serverTiming?: string;
    speculationRules?: string;
  };
  serverSpecs: ServerSpecs;
  timing: TimingInfo;
  hosting?: string;
  // DNS info
  dns?: DnsInfo;
  // WPScan results
  detectedPlugins?: WPScanPlugin[];
  vulnerabilityCount?: number;
  // SSL info
  ssl?: {
    isSecure: boolean;
    tlsVersion?: string;
    certificate?: {
      issuer: string;
      validFrom: string;
      validTo: string;
      daysRemaining: number;
      altNames?: string[];
      cipher?: string;
    };
    error?: string;
  };
  // WordPress REST API info
  wpInfo?: {
    wpVersion?: string;
    siteName?: string;
    siteDescription?: string;
    timezone?: string;
    namespaces: string[];
    restPlugins: Array<{
      slug: string;
      name: string;
      namespace: string;
      category?: string;
    }>;
  };
  // Body class detection
  bodyClassInfo?: {
    theme?: string;
    hasWooCommerce: boolean;
    hasCustomLogo: boolean;
    pageType?: string;
    isBlockTheme: boolean;
    otherPlugins: string[];
  };
  // Server info from Site Health
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
    objectCache?: {
      enabled: boolean;
      type?: string;
      dropin?: string;
    };
  };
  // Head tag detection (theme, plugins, WP version)
  headTagInfo?: {
    wpVersion?: string;
    theme?: string;
    themeVersion?: string;
    plugins: Array<{ slug: string; name: string; version?: string }>;
    seoPlugin?: string;
    preconnectDomains: string[];
    dnsPrefetchDomains: string[];
    generator?: string;
  };
  // Image performance analysis
  imageAnalysis?: {
    totalImages: number;
    imagesWithIssues: number;
    summary: {
      missingDimensions: number;
      missingLazyLoad: number;
      missingSrcset: number;
      legacyFormats: number;
      missingAlt: number;
    };
    recommendations: string[];
  };
}

// Load signatures from YAML
function loadSignatures(): Signatures {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Go up from dist/agent to project root, then into config
  const sigPath = join(__dirname, '../../config/signatures.yaml');
  const content = readFileSync(sigPath, 'utf-8');
  return parseYaml(content) as Signatures;
}

let signaturesCache: Signatures | null = null;

function getSignatures(): Signatures {
  if (!signaturesCache) {
    signaturesCache = loadSignatures();
  }
  return signaturesCache;
}

// Detect WordPress
function detectWordPress(http: HttpClientResult): boolean {
  // Check for common WordPress indicators
  const wpIndicators = [
    () => http.html.includes('/wp-content/'),
    () => http.html.includes('/wp-includes/'),
    () => http.html.includes('wp-json'),
    () => http.headers['link']?.includes('wp-json'),
    () => http.headers['x-powered-by']?.toLowerCase().includes('wordpress'),
    () => http.htmlComments.some(c => c.toLowerCase().includes('wordpress')),
  ];

  return wpIndicators.some(check => {
    try {
      return check();
    } catch {
      return false;
    }
  });
}

// Parse body classes for theme and plugin detection
interface BodyClassInfo {
  theme?: string;
  hasWooCommerce: boolean;
  hasCustomLogo: boolean;
  pageType?: string;
  isBlockTheme: boolean;
  otherPlugins: string[];
}

function parseBodyClasses(html: string): BodyClassInfo {
  const result: BodyClassInfo = {
    hasWooCommerce: false,
    hasCustomLogo: false,
    isBlockTheme: false,
    otherPlugins: [],
  };

  // Extract body class attribute
  const bodyMatch = html.match(/<body[^>]*class=["']([^"']+)["']/i);
  if (!bodyMatch) return result;

  const classes = bodyMatch[1].split(/\s+/);

  for (const cls of classes) {
    // Theme detection: wp-theme-{name} or theme-{name}
    if (cls.startsWith('wp-theme-')) {
      result.theme = cls.replace('wp-theme-', '');
    } else if (cls.startsWith('theme-') && !result.theme) {
      result.theme = cls.replace('theme-', '');
    }

    // WooCommerce detection
    if (cls.startsWith('woocommerce')) {
      result.hasWooCommerce = true;
      if (cls === 'woocommerce-block-theme-has-button-styles' ||
          cls === 'woocommerce-uses-block-theme') {
        result.isBlockTheme = true;
      }
    }

    // Custom logo
    if (cls === 'wp-custom-logo') {
      result.hasCustomLogo = true;
    }

    // Page type
    if (cls === 'home') {
      result.pageType = 'home';
    } else if (cls === 'single') {
      result.pageType = 'single';
    } else if (cls === 'page') {
      result.pageType = 'page';
    } else if (cls === 'archive') {
      result.pageType = 'archive';
    } else if (cls === 'blog') {
      result.pageType = 'blog';
    }

    // Block theme indicators
    if (cls === 'wp-embed-responsive' || cls.includes('block-theme')) {
      result.isBlockTheme = true;
    }

    // Other common plugin classes
    if (cls.startsWith('elementor-')) {
      if (!result.otherPlugins.includes('Elementor')) {
        result.otherPlugins.push('Elementor');
      }
    }
    if (cls.startsWith('et_') || cls.startsWith('et-')) {
      if (!result.otherPlugins.includes('Divi')) {
        result.otherPlugins.push('Divi');
      }
    }
    if (cls.startsWith('fl-')) {
      if (!result.otherPlugins.includes('Beaver Builder')) {
        result.otherPlugins.push('Beaver Builder');
      }
    }
    if (cls.startsWith('oxygen-')) {
      if (!result.otherPlugins.includes('Oxygen')) {
        result.otherPlugins.push('Oxygen');
      }
    }
    if (cls.startsWith('bricks-')) {
      if (!result.otherPlugins.includes('Bricks')) {
        result.otherPlugins.push('Bricks');
      }
    }
    if (cls.startsWith('jetpack-')) {
      if (!result.otherPlugins.includes('Jetpack')) {
        result.otherPlugins.push('Jetpack');
      }
    }
  }

  return result;
}

// Parse head tags for theme, plugins, WP version, and other info
interface HeadTagInfo {
  wpVersion?: string;
  theme?: string;
  themeVersion?: string;
  plugins: Array<{ slug: string; name: string; version?: string }>;
  seoPlugin?: string;
  preconnectDomains: string[];
  dnsPrefetchDomains: string[];
  generator?: string;
}

// Known plugin slug -> display name mappings
const PLUGIN_DISPLAY_NAMES: Record<string, string> = {
  // E-commerce & Marketing
  'woocommerce': 'WooCommerce',
  'omnisend': 'Omnisend',
  'mailchimp-for-wp': 'Mailchimp for WP',
  'mailchimp-for-woocommerce': 'Mailchimp for WooCommerce',
  'klaviyo': 'Klaviyo',
  'hubspot': 'HubSpot',
  // Forms
  'wpforms-lite': 'WPForms Lite',
  'wpforms': 'WPForms',
  'contact-form-7': 'Contact Form 7',
  'forminator': 'Forminator',
  'hustle': 'Hustle',
  'ninja-forms': 'Ninja Forms',
  'gravityforms': 'Gravity Forms',
  'fluentform': 'Fluent Forms',
  // Page Builders
  'elementor': 'Elementor',
  'elementor-pro': 'Elementor Pro',
  'js_composer': 'WPBakery',
  'beaver-builder-lite-version': 'Beaver Builder',
  'oxygen': 'Oxygen',
  'bricks': 'Bricks',
  'breakdance': 'Breakdance',
  // SEO
  'wordpress-seo': 'Yoast SEO',
  'wordpress-seo-premium': 'Yoast SEO Premium',
  'seo-by-rank-math': 'Rank Math',
  'all-in-one-seo-pack': 'All in One SEO',
  'autodescription': 'The SEO Framework',
  // Cache & Performance
  'wp-rocket': 'WP Rocket',
  'litespeed-cache': 'LiteSpeed Cache',
  'w3-total-cache': 'W3 Total Cache',
  'wp-super-cache': 'WP Super Cache',
  'wp-fastest-cache': 'WP Fastest Cache',
  'autoptimize': 'Autoptimize',
  'perfmatters': 'Perfmatters',
  'flying-scripts': 'Flying Scripts',
  'async-javascript': 'Async JavaScript',
  'redis-cache': 'Redis Object Cache',
  // Security
  'wordfence': 'Wordfence',
  'better-wp-security': 'iThemes Security',
  'sucuri-scanner': 'Sucuri',
  'defender-security': 'Defender',
  // Image Optimization
  'imagify': 'Imagify',
  'wp-smushit': 'Smush',
  'shortpixel-image-optimiser': 'ShortPixel',
  'ewww-image-optimizer': 'EWWW Image Optimizer',
  'optimole-wp': 'Optimole',
  // Backup & Migration
  'updraftplus': 'UpdraftPlus',
  'duplicator': 'Duplicator',
  'all-in-one-wp-migration': 'All-in-One WP Migration',
  // Analytics
  'google-analytics-for-wordpress': 'MonsterInsights',
  'google-site-kit': 'Site Kit by Google',
  // Sliders & Galleries
  'revslider': 'Slider Revolution',
  'smart-slider-3': 'Smart Slider 3',
  'nextgen-gallery': 'NextGEN Gallery',
  // Other Popular
  'akismet': 'Akismet',
  'jetpack': 'Jetpack',
  'advanced-custom-fields': 'ACF',
  'acf-pro': 'ACF Pro',
  'classic-editor': 'Classic Editor',
  'really-simple-ssl': 'Really Simple SSL',
  'redirection': 'Redirection',
  'tablepress': 'TablePress',
  'cookie-law-info': 'CookieYes',
  'cookieyes': 'CookieYes',
  'complianz-gdpr': 'Complianz',
  'polylang': 'Polylang',
  'sitepress-multilingual-cms': 'WPML',
  'translatepress-multilingual': 'TranslatePress',
  'woocommerce-payments': 'WooCommerce Payments',
  'woocommerce-subscriptions': 'WooCommerce Subscriptions',
  'woo-gutenberg-products-block': 'WooCommerce Blocks',
};

// Prettify plugin slug to display name
function prettifyPluginSlug(slug: string): string {
  // Check known mappings first
  if (PLUGIN_DISPLAY_NAMES[slug]) {
    return PLUGIN_DISPLAY_NAMES[slug];
  }
  // Convert slug to title case: "my-plugin-name" -> "My Plugin Name"
  return slug
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function parseHeadTags(html: string): HeadTagInfo {
  const result: HeadTagInfo = {
    plugins: [],
    preconnectDomains: [],
    dnsPrefetchDomains: [],
  };

  // Extract head section
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if (!headMatch) return result;
  const head = headMatch[1];

  // WordPress version from generator meta tag
  const generatorMatch = head.match(/<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/i) ||
                         head.match(/<meta\s+content=["']([^"']+)["']\s+name=["']generator["']/i);
  if (generatorMatch) {
    result.generator = generatorMatch[1];
    const wpVersionMatch = generatorMatch[1].match(/WordPress\s+([\d.]+)/i);
    if (wpVersionMatch) {
      result.wpVersion = wpVersionMatch[1];
    }
  }

  // Theme from stylesheet link
  const themeStyleMatch = head.match(/\/wp-content\/themes\/([^/]+)\/[^"']*style\.css[^"']*(["'])/i) ||
                          head.match(/\/wp-content\/themes\/([^/]+)\//i);
  if (themeStyleMatch) {
    result.theme = themeStyleMatch[1];
    // Try to get theme version
    const versionMatch = head.match(new RegExp(`/wp-content/themes/${themeStyleMatch[1]}/[^"']*\\?ver=([^"'&]+)`, 'i'));
    if (versionMatch) {
      result.themeVersion = versionMatch[1];
    }
  }

  // Plugins from script/style URLs
  const pluginMatches = head.matchAll(/\/wp-content\/plugins\/([^/]+)\/[^"']*\?ver=([^"'&]+)/gi);
  const seenPlugins = new Set<string>();
  for (const match of pluginMatches) {
    const slug = match[1];
    const version = match[2];
    if (!seenPlugins.has(slug)) {
      seenPlugins.add(slug);
      result.plugins.push({ slug, name: prettifyPluginSlug(slug), version });
    }
  }
  // Also catch plugins without version
  const pluginMatchesNoVer = head.matchAll(/\/wp-content\/plugins\/([^/]+)\//gi);
  for (const match of pluginMatchesNoVer) {
    const slug = match[1];
    if (!seenPlugins.has(slug)) {
      seenPlugins.add(slug);
      result.plugins.push({ slug, name: prettifyPluginSlug(slug) });
    }
  }

  // SEO plugin detection from meta tags
  if (head.includes('yoast-schema-graph') || head.includes('Yoast SEO')) {
    result.seoPlugin = 'Yoast SEO';
  } else if (head.includes('rank-math') || head.includes('RankMath')) {
    result.seoPlugin = 'Rank Math';
  } else if (head.includes('aioseo') || head.includes('All in One SEO')) {
    result.seoPlugin = 'All in One SEO';
  } else if (head.includes('seopress') || head.includes('SEOPress')) {
    result.seoPlugin = 'SEOPress';
  } else if (head.includes('the-seo-framework')) {
    result.seoPlugin = 'The SEO Framework';
  }

  // Preconnect hints (reveal CDNs, fonts, analytics)
  const preconnectMatches = head.matchAll(/<link[^>]*rel=["']preconnect["'][^>]*href=["']([^"']+)["']/gi);
  for (const match of preconnectMatches) {
    try {
      const domain = new URL(match[1]).hostname;
      if (!result.preconnectDomains.includes(domain)) {
        result.preconnectDomains.push(domain);
      }
    } catch { /* invalid URL */ }
  }

  // DNS prefetch hints
  const dnsPrefetchMatches = head.matchAll(/<link[^>]*rel=["']dns-prefetch["'][^>]*href=["']([^"']+)["']/gi);
  for (const match of dnsPrefetchMatches) {
    try {
      const domain = new URL(match[1]).hostname;
      if (!result.dnsPrefetchDomains.includes(domain)) {
        result.dnsPrefetchDomains.push(domain);
      }
    } catch { /* invalid URL */ }
  }

  return result;
}

// Detect plugins from HTTP response
function detectPlugins(http: HttpClientResult, sigs: Signatures): DetectedPlugin[] {
  const detected: DetectedPlugin[] = [];

  for (const [slug, plugin] of Object.entries(sigs.plugins)) {
    const matchedBy: string[] = [];

    // Check HTML comments
    if (plugin.signatures.html_comments) {
      for (const pattern of plugin.signatures.html_comments) {
        if (http.htmlComments.some(c => c.includes(pattern)) || http.html.includes(pattern)) {
          matchedBy.push(`html_comment: ${pattern.substring(0, 30)}...`);
        }
      }
    }

    // Check headers
    if (plugin.signatures.headers) {
      for (const header of plugin.signatures.headers) {
        if (http.headers[header.toLowerCase()]) {
          matchedBy.push(`header: ${header}`);
        }
      }
    }

    // Check cookies
    if (plugin.signatures.cookies) {
      for (const cookie of plugin.signatures.cookies) {
        if (http.cookies.some(c => c.includes(cookie))) {
          matchedBy.push(`cookie: ${cookie}`);
        }
      }
    }

    // Check paths in HTML
    if (plugin.signatures.paths) {
      for (const path of plugin.signatures.paths) {
        if (http.html.includes(path)) {
          matchedBy.push(`path: ${path}`);
        }
      }
    }

    if (matchedBy.length > 0) {
      detected.push({
        slug,
        name: plugin.name,
        category: plugin.category,
        matchedBy,
      });
    }
  }

  return detected;
}

// Detect CDNs from HTTP response
function detectCdns(http: HttpClientResult, sigs: Signatures): DetectedCdn[] {
  const detected: DetectedCdn[] = [];

  for (const [slug, cdn] of Object.entries(sigs.cdns)) {
    const matchedBy: string[] = [];

    // Check headers
    if (cdn.signatures.headers) {
      for (const header of cdn.signatures.headers) {
        if (http.headers[header.toLowerCase()]) {
          matchedBy.push(`header: ${header}`);
        }
      }
    }

    // Check server header
    if (cdn.signatures.server) {
      if (http.headers['server']?.toLowerCase().includes(cdn.signatures.server.toLowerCase())) {
        matchedBy.push(`server: ${cdn.signatures.server}`);
      }
    }

    // Check via header
    if (cdn.signatures.via) {
      if (http.headers['via']?.toLowerCase().includes(cdn.signatures.via.toLowerCase())) {
        matchedBy.push(`via: ${cdn.signatures.via}`);
      }
    }

    if (matchedBy.length > 0) {
      detected.push({
        slug,
        name: cdn.name,
        matchedBy,
      });
    }
  }

  return detected;
}

// Detect server-level caching
function detectServerCache(http: HttpClientResult, sigs: Signatures): DetectedCdn[] {
  const detected: DetectedCdn[] = [];

  for (const [slug, cache] of Object.entries(sigs.server_cache)) {
    const matchedBy: string[] = [];

    if (cache.signatures.headers) {
      for (const header of cache.signatures.headers) {
        if (http.headers[header.toLowerCase()]) {
          matchedBy.push(`header: ${header}`);
        }
      }
    }

    if (cache.signatures.via) {
      if (http.headers['via']?.toLowerCase().includes(cache.signatures.via.toLowerCase())) {
        matchedBy.push(`via: ${cache.signatures.via}`);
      }
    }

    if (matchedBy.length > 0) {
      detected.push({
        slug,
        name: cache.name,
        matchedBy,
      });
    }
  }

  return detected;
}

// Detect conflicts
function detectConflicts(plugins: DetectedPlugin[], sigs: Signatures): DetectedConflict[] {
  const pluginSlugs = new Set(plugins.map(p => p.slug));
  const conflicts: DetectedConflict[] = [];

  for (const conflict of sigs.conflicts) {
    const matching = conflict.plugins.filter(p => pluginSlugs.has(p));
    if (matching.length >= 2) {
      conflicts.push({
        plugins: matching,
        severity: conflict.severity,
        reason: conflict.reason,
      });
    }
  }

  return conflicts;
}

// Extract PHP version from headers
function extractPhpVersion(headers: Record<string, string>): string | undefined {
  const poweredBy = headers['x-powered-by'] || '';
  const phpMatch = poweredBy.match(/PHP\/([\d.]+)/i);
  return phpMatch ? phpMatch[1] : undefined;
}

// Hosting providers and their typical origin servers
const HOSTING_SERVERS: Record<string, string> = {
  'WP Engine': 'nginx',
  'Kinsta': 'nginx',
  'SiteGround': 'nginx',
  'Pantheon': 'nginx',
  'Flywheel': 'nginx',
  'Cloudways': 'nginx/apache',
  'LiteSpeed Server': 'LiteSpeed',
};

// Detect hosting from headers
function detectHostingFromHeaders(headers: Record<string, string>): { hosting?: string; originServer?: string } {
  const server = (headers['server'] || '').toLowerCase();
  const poweredBy = (headers['x-powered-by'] || '').toLowerCase();

  // Check for managed WordPress hosts (these have their own headers)
  // WP Engine - multiple possible headers
  if (headers['x-wpe-cached'] || headers['x-wpe-backend'] ||
      headers['x-powered-by']?.includes('WP Engine') ||
      server.includes('wpe')) {
    return { hosting: 'WP Engine', originServer: 'nginx' };
  }
  if (headers['x-kinsta-cache']) {
    return { hosting: 'Kinsta', originServer: 'nginx' };
  }
  if (headers['x-sg-cache'] || server.includes('siteground')) {
    return { hosting: 'SiteGround', originServer: 'nginx' };
  }
  if (headers['x-pantheon-styx-hostname']) {
    return { hosting: 'Pantheon', originServer: 'nginx' };
  }
  if (headers['x-fw-cache'] || server.includes('flywheel')) {
    return { hosting: 'Flywheel', originServer: 'nginx' };
  }
  if (server.includes('cloudways')) {
    return { hosting: 'Cloudways', originServer: 'nginx' };
  }
  if (poweredBy.includes('plesk') || server.includes('plesk')) {
    return { hosting: 'Plesk' };
  }
  if (server.includes('litespeed')) {
    return { hosting: 'LiteSpeed Server', originServer: 'LiteSpeed' };
  }

  // If server header is a CDN, we can't determine origin from headers alone
  if (server === 'cloudflare' || server.includes('cdn')) {
    return {}; // Will need DNS or HTML to determine hosting
  }

  // Direct server detection (no CDN in front)
  if (server.includes('nginx')) {
    return { originServer: 'nginx' };
  }
  if (server.includes('apache')) {
    return { originServer: 'Apache' };
  }

  return {};
}

// Detect hosting from HTML content (useful when behind CDN)
function detectHostingFromHtml(html: string): string | undefined {
  // WP Engine patterns
  if (html.includes('wpenginepowered.com') ||
      html.includes('wpengine.com') ||
      html.includes('/cdn-cgi/') && html.includes('wpe')) {
    return 'WP Engine';
  }
  // Kinsta patterns
  if (html.includes('kinsta.cloud') || html.includes('kinstacdn.com')) {
    return 'Kinsta';
  }
  // SiteGround patterns
  if (html.includes('sgvps.net') || html.includes('siteground')) {
    return 'SiteGround';
  }
  // Flywheel patterns
  if (html.includes('flywheelsites.com') || html.includes('flywheelstaging.com')) {
    return 'Flywheel';
  }
  // Pantheon patterns
  if (html.includes('pantheonsite.io')) {
    return 'Pantheon';
  }
  return undefined;
}

// Main analyze function
export function analyze(
  http: HttpClientResult,
  cacheTest: CacheTestResult,
  dns?: DnsLookupResult,
  wpscanResult?: WPScanResult,
  siteHealthResult?: WPSiteHealthResult,
  sslResult?: SSLInfoResult
): AnalysisResult {
  const sigs = getSignatures();

  // WordPress detected via HTML OR REST API
  const isWordPress = detectWordPress(http) || siteHealthResult?.isWordPress || false;
  const plugins = detectPlugins(http, sigs);
  const cdns = detectCdns(http, sigs);
  const serverCache = detectServerCache(http, sigs);
  const conflicts = detectConflicts(plugins, sigs);
  const bodyClassInfo = parseBodyClasses(http.html);
  const headTagInfo = parseHeadTags(http.html);

  // Calculate timing improvement
  const firstTtfb = cacheTest.doubleHit.firstRequest.ttfb;
  const secondTtfb = cacheTest.doubleHit.secondRequest.ttfb;
  const improvement = firstTtfb > 0
    ? Math.round((1 - secondTtfb / firstTtfb) * 100)
    : 0;

  // Detect hosting and origin server
  const hostingInfo = detectHostingFromHeaders(http.headers);
  // Try headers first, then DNS, then HTML content
  const hosting = hostingInfo.hosting ||
                  dns?.detected.hosting ||
                  detectHostingFromHtml(http.html);

  // Determine origin server (what's actually serving the site)
  // If we detected a CDN in server header, use the hosting-based origin server
  const serverHeader = (http.headers['server'] || '').toLowerCase();
  const isCdnServer = serverHeader === 'cloudflare' || serverHeader.includes('cdn');
  const originServer = hostingInfo.originServer ||
                       (hosting && HOSTING_SERVERS[hosting]) ||
                       (isCdnServer ? undefined : http.headers['server']);

  return {
    url: http.url,
    isWordPress,
    plugins,
    cdns,
    serverCache,
    conflicts,
    cacheStatus: {
      working: cacheTest.doubleHit.cacheWorking,
      header: cacheTest.cacheStatus.header,
      value: cacheTest.cacheStatus.value,
      explanation: cacheTest.doubleHit.explanation,
      allHeaders: cacheTest.allCacheHeaders || [],
    },
    headers: {
      cacheControl: http.headers['cache-control'],
      expires: http.headers['expires'],
      etag: http.headers['etag'],
      lastModified: http.headers['last-modified'],
      server: http.headers['server'],
      // Additional cache-related headers
      cfEdgeCache: cacheTest.headers.cfEdgeCache,
      serverTiming: cacheTest.headers.serverTiming,
      speculationRules: cacheTest.headers.speculationRules,
    },
    serverSpecs: {
      server: originServer || http.headers['server'],
      originServer: isCdnServer ? originServer : undefined,
      poweredBy: http.headers['x-powered-by'],
      phpVersion: extractPhpVersion(http.headers),
      hosting,
      // Note: HTTP/2 detection via fetch() is unreliable - pseudo-headers aren't exposed
      // Servers like LiteSpeed support HTTP/2 natively but we can't confirm from response
    },
    timing: {
      ttfb: firstTtfb,
      ttfbCached: secondTtfb,
      improvement: improvement > 0 ? improvement : undefined,
    },
    hosting,
    // DNS info
    dns: dns ? {
      hostname: dns.hostname,
      addresses: dns.addresses.map(a => a.address),
      cnames: dns.cnames,
      nameservers: dns.nameservers,
    } : undefined,
    // WPScan results
    detectedPlugins: wpscanResult?.plugins,
    vulnerabilityCount: wpscanResult?.vulnerabilityCount,
    // SSL info
    ssl: sslResult ? {
      isSecure: sslResult.isSecure,
      tlsVersion: sslResult.tlsVersion,
      certificate: sslResult.certificate ? {
        issuer: sslResult.certificate.issuer.organization || sslResult.certificate.issuer.commonName || 'Unknown',
        validFrom: sslResult.certificate.validFrom,
        validTo: sslResult.certificate.validTo,
        daysRemaining: sslResult.certificate.daysRemaining,
        altNames: sslResult.certificate.altNames,
        cipher: sslResult.certificate.cipher?.name,
      } : undefined,
      error: sslResult.error,
    } : undefined,
    // WordPress REST API info (always include if siteHealthResult exists)
    wpInfo: siteHealthResult ? {
      wpVersion: siteHealthResult.wpVersion,
      siteName: siteHealthResult.siteName,
      siteDescription: siteHealthResult.siteDescription,
      timezone: siteHealthResult.timezone,
      namespaces: siteHealthResult.namespaces || [],
      restPlugins: siteHealthResult.restPlugins || [],
    } : undefined,
    // Server info from Site Health
    siteHealth: siteHealthResult?.siteHealth ? {
      phpVersion: siteHealthResult.siteHealth.phpVersion,
      mysqlVersion: siteHealthResult.siteHealth.mysqlVersion,
      serverSoftware: siteHealthResult.siteHealth.serverSoftware,
      curlVersion: siteHealthResult.siteHealth.curlVersion,
      wpMemoryLimit: siteHealthResult.siteHealth.wpMemoryLimit,
      wpDebugMode: siteHealthResult.siteHealth.wpDebugMode,
      isMultisite: siteHealthResult.siteHealth.isMultisite,
      activeTheme: siteHealthResult.siteHealth.activeTheme,
      activePluginsCount: siteHealthResult.siteHealth.activePluginsCount,
      httpsStatus: siteHealthResult.siteHealth.httpsStatus,
      objectCache: siteHealthResult.siteHealth.objectCache,
    } : undefined,
    // Body class detection (theme, WooCommerce, page builders)
    bodyClassInfo: bodyClassInfo.theme || bodyClassInfo.hasWooCommerce || bodyClassInfo.otherPlugins.length > 0
      ? bodyClassInfo
      : undefined,
    // Head tag detection (theme, plugins, WP version from generator)
    headTagInfo: headTagInfo.wpVersion || headTagInfo.theme || headTagInfo.plugins.length > 0 || headTagInfo.seoPlugin
      ? headTagInfo
      : undefined,
    // Image performance analysis
    imageAnalysis: (() => {
      const imgAnalysis = analyzeImages(http.html, http.url);
      if (imgAnalysis.totalImages === 0) return undefined;
      return {
        totalImages: imgAnalysis.totalImages,
        imagesWithIssues: imgAnalysis.imagesWithIssues,
        summary: imgAnalysis.summary,
        recommendations: imgAnalysis.recommendations,
      };
    })(),
  };
}
