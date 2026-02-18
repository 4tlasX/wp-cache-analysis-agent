/**
 * LLM Analyzer
 * Deep analysis of cache configuration using Claude (default) or local Ollama
 */

import { claudeChat, anonymizeSiteData, anonymizeText, type AnonymizedData } from './claude-client.js';
import { chat, MODELS, type ChatMessage } from './client.js';
import type { AnalysisResult } from '../agent/analyzer.js';

const SYSTEM_PROMPT = `You are a WordPress performance expert analyzing a site's caching configuration.

You have access to web search. USE IT to look up information about ALL detected plugins.

IMPORTANT: The "REST API Namespaces" field shows raw WordPress REST API namespaces. These reveal installed plugins even if not explicitly listed. Common mappings:
- "litespeed" = LiteSpeed Cache plugin
- "wc" = WooCommerce
- "yoast" = Yoast SEO
- "elementor" = Elementor
- "wp-rocket" = WP Rocket
- "jetpack" = Jetpack
- "wordfence" = Wordfence
Look up ANY namespace you see to identify the plugin it belongs to and search for its best practices.

Search for:
- Known conflicts between the detected plugins (cache plugins AND REST API plugins)
- Common issues with specific plugin combinations
- Best practices for the detected cache stack
- Any recent bugs or compatibility issues with the plugins mentioned
- Recommended settings and configuration for each detected plugin
- Optimal tuning suggestions for the specific hosting environment
- Performance-related settings that are commonly misconfigured
- Plugin interactions that may affect performance (e.g., WooCommerce + cache plugins)

Given the analysis data, provide:
1. A clear summary of the current cache setup
2. Any conflicts or misconfigurations you identify (including from web search)
3. Prioritized recommendations for improvement

Focus on:
- Cache plugin conflicts (multiple page cache plugins)
- CDN configuration (is HTML being edge-cached?)
- Missing optimizations (no caching, no CDN)
- Server-level cache issues
- Object cache configuration (Redis/Memcached)
- Image optimization opportunities
- Known plugin conflicts from your web search

Be specific and actionable. Reference actual header values and plugin names when relevant. Include any relevant findings from web search about plugin conflicts, recommended settings, and configuration best practices. When suggesting settings, be specific about which plugin settings page and option names to look for.

Respond with JSON only (no markdown code blocks, no citation tags):
{
  "summary": "2-3 sentence summary of the cache setup",
  "score": 0-100,
  "issues": [
    {
      "severity": "high|medium|low",
      "title": "Short title (5-10 words)",
      "description": "Detailed explanation of what's wrong and why it matters (2-3 sentences)",
      "fix": "Step-by-step instructions to fix: 1) Go to X settings page, 2) Change Y to Z, 3) Save and clear cache"
    }
  ],
  "recommendations": [
    {
      "priority": 1,
      "title": "Short title (5-10 words)",
      "description": "Detailed steps: 1) What to do, 2) Where to find the setting, 3) What value to use, 4) Why this helps",
      "impact": "high|medium|low"
    }
  ]
}

CRITICAL: Every "fix" and "description" field MUST contain complete, actionable steps - never use "..." or placeholder text. Include specific plugin names, settings pages, and option values.`;

export interface LLMAnalysis {
  summary: string;
  score: number;
  issues: Array<{
    severity: 'high' | 'medium' | 'low';
    title: string;
    description: string;
    fix: string;
  }>;
  recommendations: Array<{
    priority: number;
    title: string;
    description: string;
    impact: 'high' | 'medium' | 'low';
  }>;
}

export interface AnalysisContext {
  url: string;
  siteName?: string;
  siteDescription?: string;
  isWordPress: boolean;
  headers: Record<string, string>;
  plugins: string[];
  restPlugins?: Array<{ name: string; category?: string }>;
  namespaces?: string[];
  cdns: string[];
  serverCache: string[];
  cacheWorking: boolean;
  cacheExplanation: string;
  ttfb?: { first: number; second: number };
  objectCache?: { enabled: boolean; type?: string };
  serverInfo?: {
    phpVersion?: string;
    mysqlVersion?: string;
    wpMemoryLimit?: string;
  };
  imageIssues?: {
    total: number;
    withIssues: number;
    missingDimensions: number;
    missingLazyLoad: number;
    legacyFormats: number;
  };
  conflicts?: Array<{ plugins: string[]; reason: string }>;
}

export type LLMProvider = 'claude' | 'local';

export interface AnalyzeOptions {
  provider?: LLMProvider;
  apiKey?: string;
}

/**
 * Extract JSON from a response that may contain markdown code fences or extra text
 */
function extractJSON<T>(text: string): T | null {
  // Step 1: Strip citation tags from web search results (e.g., <cite index="...">...</cite>)
  let cleaned = text.replace(/<cite[^>]*>[\s\S]*?<\/cite>/gi, '');

  // Step 2: Strip markdown code fences (```json ... ``` or ``` ... ```)
  cleaned = cleaned.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1');

  // Step 2: Try to parse the entire cleaned text as JSON
  try {
    return JSON.parse(cleaned.trim()) as T;
  } catch {
    // Continue to extraction attempts
  }

  // Step 3: Find balanced JSON object by tracking brace depth
  const startIndex = cleaned.indexOf('{');
  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      escape = true;
      continue;
    }

    if (char === '"' && !escape) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        // Found complete JSON object
        const jsonStr = cleaned.slice(startIndex, i + 1);
        try {
          return JSON.parse(jsonStr) as T;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function buildDataPrompt(context: AnalysisContext, anonymized?: AnonymizedData): string {
  const url = anonymized ? anonymized.anonymizedUrl : context.url;
  const siteName = anonymized ? anonymized.anonymizedSiteName : (context.siteName || 'Unknown');

  // Helper to scrub domain from any text
  const scrub = (text: string): string => {
    return anonymized ? anonymizeText(text, anonymized.urlMap) : text;
  };

  // Filter headers to only cache-relevant ones (don't leak sensitive data)
  const relevantHeaders = [
    'cache-control', 'cf-cache-status', 'x-cache', 'x-cache-status',
    'x-varnish', 'x-fastcgi-cache', 'x-nginx-cache', 'x-litespeed-cache',
    'x-proxy-cache', 'x-kinsta-cache', 'x-wpe-cached', 'x-sg-cache',
    'server', 'x-powered-by', 'age', 'expires', 'etag', 'vary'
  ];

  const filteredHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(context.headers)) {
    if (relevantHeaders.includes(key.toLowerCase())) {
      // Scrub domain from header values too
      filteredHeaders[key] = scrub(value);
    }
  }

  let prompt = `
Analyze this WordPress site's cache configuration:

URL: ${url}
Site: ${siteName}
WordPress detected: ${context.isWordPress}

HTTP Headers:
${Object.entries(filteredHeaders).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none relevant)'}

Detected Cache Plugins: ${context.plugins.length > 0 ? context.plugins.join(', ') : 'None'}
Plugins via REST API: ${context.restPlugins && context.restPlugins.length > 0 ? context.restPlugins.map(p => `${p.name}${p.category ? ` (${p.category})` : ''}`).join(', ') : 'None detected'}
REST API Namespaces: ${context.namespaces && context.namespaces.length > 0 ? context.namespaces.join(', ') : 'None'}
Detected CDNs: ${context.cdns.length > 0 ? context.cdns.join(', ') : 'None'}
Server-level Cache: ${context.serverCache.length > 0 ? context.serverCache.join(', ') : 'None'}

Cache Test Result: ${context.cacheWorking ? 'Working' : 'Not Working'}
Explanation: ${scrub(context.cacheExplanation)}`;

  if (context.ttfb) {
    prompt += `\nTTFB: First request ${context.ttfb.first}ms, Second request ${context.ttfb.second}ms`;
  }

  if (context.objectCache) {
    prompt += `\nObject Cache: ${context.objectCache.enabled ? 'Enabled' : 'Disabled'}`;
    if (context.objectCache.type) {
      prompt += ` (${context.objectCache.type})`;
    }
  }

  if (context.serverInfo && (context.serverInfo.phpVersion || context.serverInfo.mysqlVersion)) {
    prompt += `\n\nServer Info:`;
    if (context.serverInfo.phpVersion) prompt += `\n  PHP: ${context.serverInfo.phpVersion}`;
    if (context.serverInfo.mysqlVersion) prompt += `\n  MySQL: ${context.serverInfo.mysqlVersion}`;
    if (context.serverInfo.wpMemoryLimit) prompt += `\n  WP Memory: ${context.serverInfo.wpMemoryLimit}`;
  }

  if (context.imageIssues) {
    prompt += `\n\nImage Performance:
  Total images: ${context.imageIssues.total}
  With issues: ${context.imageIssues.withIssues}
  Missing dimensions: ${context.imageIssues.missingDimensions}
  Missing lazy loading: ${context.imageIssues.missingLazyLoad}
  Legacy formats (JPG/PNG): ${context.imageIssues.legacyFormats}`;
  }

  if (context.conflicts && context.conflicts.length > 0) {
    prompt += `\n\nDetected Conflicts:`;
    for (const conflict of context.conflicts) {
      prompt += `\n  - ${conflict.plugins.join(' + ')}: ${conflict.reason}`;
    }
  }

  prompt += '\n\nProvide your analysis as JSON.';

  return prompt;
}

export async function analyzeWithLLM(
  context: AnalysisContext,
  options: AnalyzeOptions = {}
): Promise<LLMAnalysis> {
  const { provider = 'claude', apiKey } = options;

  try {
    if (provider === 'claude') {
      return await analyzeWithClaude(context, apiKey);
    } else {
      return await analyzeWithOllama(context);
    }
  } catch (error) {
    // Return a minimal analysis if LLM fails
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return {
      summary: `Unable to perform AI analysis: ${errorMsg}`,
      score: 50,
      issues: [],
      recommendations: [],
    };
  }
}

async function analyzeWithClaude(context: AnalysisContext, apiKey?: string): Promise<LLMAnalysis> {
  // Anonymize site data before sending to Claude
  const anonymized = anonymizeSiteData(
    context.url,
    context.siteName,
    context.siteDescription
  );

  const dataPrompt = buildDataPrompt(context, anonymized);

  const response = await claudeChat(
    [{ role: 'user', content: dataPrompt }],
    {
      system: SYSTEM_PROMPT,
      temperature: 0.5,
      maxTokens: 4096,
      webSearch: true,
    },
    apiKey
  );

  // Parse JSON response
  const analysis = extractJSON<LLMAnalysis>(response);
  if (!analysis) {
    throw new Error('Invalid JSON response from Claude');
  }

  // Validate and sanitize
  analysis.score = Math.max(0, Math.min(100, analysis.score || 50));
  analysis.issues = analysis.issues || [];
  analysis.recommendations = analysis.recommendations || [];

  return analysis;
}

async function analyzeWithOllama(context: AnalysisContext): Promise<LLMAnalysis> {
  const dataPrompt = buildDataPrompt(context);

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: dataPrompt },
  ];

  const response = await chat(messages, {
    model: MODELS.analyzer,
    temperature: 0.5,
    format: 'json',
  });

  const analysis = JSON.parse(response) as LLMAnalysis;

  // Validate and sanitize
  analysis.score = Math.max(0, Math.min(100, analysis.score || 50));
  analysis.issues = analysis.issues || [];
  analysis.recommendations = analysis.recommendations || [];

  return analysis;
}

export function buildContextFromResults(
  url: string,
  httpResult: any,
  cacheResult: any,
  _dnsResult: any,
  ruleAnalysis: AnalysisResult
): AnalysisContext {
  const context: AnalysisContext = {
    url,
    siteName: ruleAnalysis.wpInfo?.siteName,
    siteDescription: ruleAnalysis.wpInfo?.siteDescription,
    isWordPress: ruleAnalysis.isWordPress,
    headers: httpResult.headers || {},
    plugins: ruleAnalysis.plugins.map(p => p.name),
    restPlugins: ruleAnalysis.wpInfo?.restPlugins?.map(p => ({ name: p.name, category: p.category })),
    namespaces: ruleAnalysis.wpInfo?.namespaces,
    cdns: ruleAnalysis.cdns.map(c => c.name),
    serverCache: ruleAnalysis.serverCache.map(s => s.name),
    cacheWorking: cacheResult?.doubleHit?.cacheWorking || false,
    cacheExplanation: cacheResult?.doubleHit?.explanation || 'Not tested',
    ttfb: cacheResult?.doubleHit ? {
      first: cacheResult.doubleHit.firstRequest.ttfb,
      second: cacheResult.doubleHit.secondRequest.ttfb,
    } : undefined,
  };

  // Add object cache info
  if (ruleAnalysis.siteHealth?.objectCache) {
    context.objectCache = {
      enabled: ruleAnalysis.siteHealth.objectCache.enabled,
      type: ruleAnalysis.siteHealth.objectCache.type,
    };
  }

  // Add server info
  if (ruleAnalysis.siteHealth) {
    context.serverInfo = {
      phpVersion: ruleAnalysis.siteHealth.phpVersion,
      mysqlVersion: ruleAnalysis.siteHealth.mysqlVersion,
      wpMemoryLimit: ruleAnalysis.siteHealth.wpMemoryLimit,
    };
  }

  // Add image issues
  if (ruleAnalysis.imageAnalysis) {
    context.imageIssues = {
      total: ruleAnalysis.imageAnalysis.totalImages,
      withIssues: ruleAnalysis.imageAnalysis.imagesWithIssues,
      missingDimensions: ruleAnalysis.imageAnalysis.summary.missingDimensions,
      missingLazyLoad: ruleAnalysis.imageAnalysis.summary.missingLazyLoad,
      legacyFormats: ruleAnalysis.imageAnalysis.summary.legacyFormats,
    };
  }

  // Add conflicts
  if (ruleAnalysis.conflicts && ruleAnalysis.conflicts.length > 0) {
    context.conflicts = ruleAnalysis.conflicts.map(c => ({
      plugins: c.plugins,
      reason: c.reason,
    }));
  }

  return context;
}
