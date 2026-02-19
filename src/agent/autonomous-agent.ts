/**
 * Autonomous WP Cache Analysis Agent
 *
 * Unlike the linear pipeline, this agent:
 * 1. Navigates the site autonomously, discovering pages to analyze
 * 2. Experiments with different request patterns to test cache behavior
 * 3. Monitors changes over time and adjusts its analysis strategy
 * 4. Makes decisions about what to investigate based on findings
 */

import { EventEmitter } from 'node:events';
import { httpClient, type HttpClientResult } from '../mcp-server/tools/http-client.js';
import { cacheTester, type CacheTestResult } from '../mcp-server/tools/cache-tester.js';
import { dnsLookup, type DnsLookupResult } from '../mcp-server/tools/dns-lookup.js';
import { wpSiteHealth, type WPSiteHealthResult } from '../mcp-server/tools/wp-site-health.js';
import { sslInfo, type SSLInfoResult } from '../mcp-server/tools/ssl-info.js';
import { analyze, type AnalysisResult } from './analyzer.js';
import { analyzeWithLLM, buildContextFromResults, type LLMAnalysis, type LLMProvider } from '../llm/analyzer.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface AgentConfig {
  /** Base URL to analyze */
  baseUrl: string;
  /** Maximum pages to discover and analyze */
  maxPages: number;
  /** Maximum depth for link crawling */
  maxDepth: number;
  /** Request timeout in milliseconds */
  timeout: number;
  /** Enable AI-powered analysis */
  useAI: boolean;
  /** LLM provider (claude or local) */
  llmProvider: LLMProvider;
  /** Anthropic API key */
  apiKey?: string;
  /** Enable monitoring mode (continuous analysis) */
  monitorMode: boolean;
  /** Monitoring interval in milliseconds */
  monitorInterval: number;
  /** Maximum monitoring cycles (0 = infinite) */
  maxMonitorCycles: number;
  /** Enable cache experimentation */
  experimentMode: boolean;
  /** Verbose logging */
  verbose: boolean;
}

export interface PageAnalysis {
  url: string;
  depth: number;
  timestamp: Date;
  httpResult: HttpClientResult;
  cacheTest?: CacheTestResult;
  ruleAnalysis: AnalysisResult;
  llmAnalysis?: LLMAnalysis;
  discoveredLinks: string[];
}

export interface CacheExperiment {
  name: string;
  description: string;
  headers: Record<string, string>;
  expectedBehavior: string;
  actualResult?: {
    cacheHit: boolean;
    ttfb: number;
    headers: Record<string, string>;
  };
  passed?: boolean;
  insight?: string;
}

export interface AgentMemory {
  /** Pages analyzed with their results */
  pages: Map<string, PageAnalysis>;
  /** URLs pending analysis */
  pendingUrls: Set<string>;
  /** URLs that failed to load */
  failedUrls: Set<string>;
  /** Discovered patterns and insights */
  insights: string[];
  /** Cache experiments run and their results */
  experiments: CacheExperiment[];
  /** Historical snapshots for monitoring mode */
  snapshots: Array<{
    timestamp: Date;
    summary: AgentSummary;
  }>;
  /** Learned rules that adjust agent behavior */
  learnedRules: LearnedRule[];
}

export interface LearnedRule {
  id: string;
  condition: string;
  action: string;
  confidence: number;
  timesApplied: number;
  successRate: number;
}

export interface AgentSummary {
  pagesAnalyzed: number;
  cacheWorking: boolean;
  cacheWorkingPages: number;
  averageTTFB: number;
  detectedPlugins: string[];
  detectedCDNs: string[];
  conflicts: string[];
  criticalIssues: string[];
  recommendations: string[];
  experimentResults?: {
    passed: number;
    failed: number;
    insights: string[];
  };
}

export interface AgentDecision {
  action: 'analyze_page' | 'run_experiment' | 'deep_dive' | 'skip' | 'stop' | 'adjust_strategy';
  reason: string;
  target?: string;
  priority: number;
}

type AgentState = 'idle' | 'discovering' | 'analyzing' | 'experimenting' | 'monitoring' | 'thinking' | 'stopped';

// ============================================================================
// Autonomous Agent Implementation
// ============================================================================

export class AutonomousAgent extends EventEmitter {
  private config: AgentConfig;
  private memory: AgentMemory;
  private state: AgentState = 'idle';
  private dnsResult?: DnsLookupResult;
  private siteHealthResult?: WPSiteHealthResult;
  private sslResult?: SSLInfoResult;
  private stopRequested = false;

  constructor(config: Partial<AgentConfig> & { baseUrl: string }) {
    super();
    this.config = {
      baseUrl: config.baseUrl,
      maxPages: config.maxPages ?? 10,
      maxDepth: config.maxDepth ?? 2,
      timeout: config.timeout ?? 30000,
      useAI: config.useAI ?? false,
      llmProvider: config.llmProvider ?? 'claude',
      apiKey: config.apiKey,
      monitorMode: config.monitorMode ?? false,
      monitorInterval: config.monitorInterval ?? 60000, // 1 minute default
      maxMonitorCycles: config.maxMonitorCycles ?? 0,
      experimentMode: config.experimentMode ?? true,
      verbose: config.verbose ?? false,
    };

    this.memory = {
      pages: new Map(),
      pendingUrls: new Set([this.config.baseUrl]),
      failedUrls: new Set(),
      insights: [],
      experiments: [],
      snapshots: [],
      learnedRules: [],
    };
  }

  // --------------------------------------------------------------------------
  // Main Agent Loop
  // --------------------------------------------------------------------------

  async run(): Promise<AgentSummary> {
    this.emit('start', { config: this.config });
    this.log('Agent starting autonomous analysis...');

    try {
      // Phase 1: Initial reconnaissance
      await this.reconnaissance();

      // Phase 2: Autonomous discovery and analysis
      await this.discoverAndAnalyze();

      // Phase 3: Run cache experiments
      if (this.config.experimentMode) {
        await this.runExperiments();
      }

      // Phase 4: Synthesize findings
      const summary = this.synthesize();

      // Phase 5: Monitoring mode (if enabled)
      if (this.config.monitorMode && !this.stopRequested) {
        await this.monitor(summary);
      }

      this.emit('complete', { summary });
      return summary;

    } catch (error) {
      this.emit('error', { error });
      throw error;
    }
  }

  stop(): void {
    this.stopRequested = true;
    this.log('Stop requested, finishing current task...');
  }

  // --------------------------------------------------------------------------
  // Phase 1: Reconnaissance
  // --------------------------------------------------------------------------

  private async reconnaissance(): Promise<void> {
    this.setState('discovering');
    this.log('Phase 1: Reconnaissance - gathering site-wide information...');

    // Parallel initial data gathering
    const [dnsResult, siteHealthResult, sslResult] = await Promise.all([
      dnsLookup(this.config.baseUrl).catch(() => undefined),
      wpSiteHealth(this.config.baseUrl, { timeout: this.config.timeout }).catch(() => undefined),
      sslInfo(this.config.baseUrl, { timeout: this.config.timeout }).catch(() => undefined),
    ]);

    this.dnsResult = dnsResult;
    this.siteHealthResult = siteHealthResult;
    this.sslResult = sslResult;

    // Initial insights from reconnaissance
    if (siteHealthResult?.isWordPress) {
      this.addInsight('Confirmed WordPress installation');
      if (siteHealthResult.restPlugins?.length) {
        this.addInsight(`Detected ${siteHealthResult.restPlugins.length} plugins via REST API`);
      }
    }

    if (dnsResult?.detected.cdn) {
      this.addInsight(`CDN detected: ${dnsResult.detected.cdn}`);
    }

    this.emit('reconnaissance_complete', { dns: dnsResult, siteHealth: siteHealthResult, ssl: sslResult });
  }

  // --------------------------------------------------------------------------
  // Phase 2: Autonomous Discovery & Analysis
  // --------------------------------------------------------------------------

  private async discoverAndAnalyze(): Promise<void> {
    this.setState('analyzing');
    this.log('Phase 2: Autonomous discovery and analysis...');

    while (this.memory.pendingUrls.size > 0 && !this.stopRequested) {
      // Make decision about what to do next
      const decision = await this.decide();

      if (decision.action === 'stop') {
        this.log(`Stopping: ${decision.reason}`);
        break;
      }

      if (decision.action === 'skip') {
        this.log(`Skipping: ${decision.reason}`);
        continue;
      }

      if (decision.action === 'analyze_page' && decision.target) {
        await this.analyzePage(decision.target, this.getUrlDepth(decision.target));
      }

      if (decision.action === 'adjust_strategy') {
        this.adjustStrategy(decision.reason);
      }

      // Check if we've hit our limits
      if (this.memory.pages.size >= this.config.maxPages) {
        this.log(`Reached max pages limit (${this.config.maxPages})`);
        break;
      }
    }
  }

  private async decide(): Promise<AgentDecision> {
    this.setState('thinking');

    // Apply learned rules first
    for (const rule of this.memory.learnedRules) {
      if (this.evaluateRule(rule)) {
        rule.timesApplied++;
        this.log(`Applying learned rule: ${rule.action}`);
      }
    }

    // Check stopping conditions
    if (this.memory.pages.size >= this.config.maxPages) {
      return { action: 'stop', reason: 'Max pages reached', priority: 0 };
    }

    if (this.memory.pendingUrls.size === 0) {
      return { action: 'stop', reason: 'No more URLs to analyze', priority: 0 };
    }

    // Prioritize URLs based on patterns
    const prioritizedUrls = this.prioritizeUrls();
    const nextUrl = prioritizedUrls[0];

    if (!nextUrl) {
      return { action: 'stop', reason: 'No valid URLs remaining', priority: 0 };
    }

    // Check if we should adjust strategy based on findings
    if (this.shouldAdjustStrategy()) {
      return {
        action: 'adjust_strategy',
        reason: this.getStrategyAdjustmentReason(),
        priority: 10,
      };
    }

    return {
      action: 'analyze_page',
      target: nextUrl,
      reason: 'Next prioritized URL',
      priority: 5,
    };
  }

  private prioritizeUrls(): string[] {
    const urls = Array.from(this.memory.pendingUrls);

    return urls.sort((a, b) => {
      // Prioritize certain page types
      const scoreA = this.getUrlPriority(a);
      const scoreB = this.getUrlPriority(b);
      return scoreB - scoreA;
    });
  }

  private getUrlPriority(url: string): number {
    let score = 0;
    const path = new URL(url).pathname.toLowerCase();

    // High priority: pages that likely have different caching
    if (path === '/' || path === '') score += 10;
    if (path.includes('/cart')) score += 8;
    if (path.includes('/checkout')) score += 8;
    if (path.includes('/my-account')) score += 7;
    if (path.includes('/shop')) score += 6;
    if (path.includes('/product')) score += 5;
    if (path.includes('/blog') || path.includes('/news')) score += 4;

    // Lower priority: static pages
    if (path.includes('/about')) score += 2;
    if (path.includes('/contact')) score += 2;
    if (path.includes('/privacy') || path.includes('/terms')) score += 1;

    // Penalize deep paths
    const depth = path.split('/').filter(Boolean).length;
    score -= depth;

    return score;
  }

  private async analyzePage(url: string, depth: number): Promise<PageAnalysis | null> {
    this.memory.pendingUrls.delete(url);

    if (this.memory.pages.has(url) || this.memory.failedUrls.has(url)) {
      return null;
    }

    this.log(`Analyzing: ${url} (depth: ${depth})`);
    this.emit('analyzing_page', { url, depth });

    try {
      // Fetch and analyze
      const httpResult = await httpClient(url, { timeout: this.config.timeout });
      if (httpResult.error) {
        this.memory.failedUrls.add(url);
        this.emit('page_failed', { url, error: httpResult.error });
        return null;
      }

      // Run cache test
      const cacheTest = await cacheTester(url, { timeout: this.config.timeout });

      // Rule-based analysis
      const ruleAnalysis = analyze(
        httpResult,
        cacheTest,
        this.dnsResult,
        undefined,
        this.siteHealthResult,
        this.sslResult
      );

      // Discover links for further analysis
      const discoveredLinks = this.extractLinks(httpResult.html, url, depth);

      // Add new links to pending if within depth limit
      if (depth < this.config.maxDepth) {
        for (const link of discoveredLinks) {
          if (!this.memory.pages.has(link) && !this.memory.failedUrls.has(link)) {
            this.memory.pendingUrls.add(link);
          }
        }
      }

      // LLM analysis if enabled
      let llmAnalysis: LLMAnalysis | undefined;
      if (this.config.useAI && this.shouldRunLLMAnalysis(ruleAnalysis)) {
        const context = buildContextFromResults(
          url,
          httpResult,
          cacheTest,
          this.dnsResult,
          ruleAnalysis
        );
        llmAnalysis = await analyzeWithLLM(context, {
          provider: this.config.llmProvider,
          apiKey: this.config.apiKey,
        });
      }

      const pageAnalysis: PageAnalysis = {
        url,
        depth,
        timestamp: new Date(),
        httpResult,
        cacheTest,
        ruleAnalysis,
        llmAnalysis,
        discoveredLinks,
      };

      this.memory.pages.set(url, pageAnalysis);
      this.deriveInsights(pageAnalysis);

      this.emit('page_analyzed', { pageAnalysis });
      return pageAnalysis;

    } catch (error) {
      this.memory.failedUrls.add(url);
      this.emit('page_failed', { url, error });
      return null;
    }
  }

  private extractLinks(html: string, baseUrl: string, _currentDepth: number): string[] {
    const links: string[] = [];
    const base = new URL(baseUrl);
    const linkRegex = /<a[^>]+href=["']([^"']+)["']/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      try {
        const href = match[1];
        // Skip anchors, javascript, mailto, tel
        if (href.startsWith('#') || href.startsWith('javascript:') ||
            href.startsWith('mailto:') || href.startsWith('tel:')) {
          continue;
        }

        const resolved = new URL(href, baseUrl);

        // Only include same-origin links
        if (resolved.origin === base.origin) {
          // Normalize URL (remove trailing slash, fragments)
          const normalized = resolved.origin + resolved.pathname.replace(/\/$/, '');
          if (!links.includes(normalized) && normalized !== baseUrl) {
            links.push(normalized);
          }
        }
      } catch {
        // Invalid URL, skip
      }
    }

    return links;
  }

  private shouldRunLLMAnalysis(analysis: AnalysisResult): boolean {
    // Run LLM analysis if there are interesting findings
    return (
      analysis.conflicts.length > 0 ||
      analysis.plugins.length > 2 ||
      !analysis.cacheStatus.working ||
      (analysis.imageAnalysis?.imagesWithIssues ?? 0) > 5
    );
  }

  private deriveInsights(page: PageAnalysis): void {
    const { ruleAnalysis, cacheTest } = page;

    // Cache behavior insights
    if (!ruleAnalysis.cacheStatus.working) {
      this.addInsight(`Page not cached: ${new URL(page.url).pathname}`);
    }

    // Conflict detection
    if (ruleAnalysis.conflicts.length > 0) {
      for (const conflict of ruleAnalysis.conflicts) {
        this.addInsight(`Conflict: ${conflict.plugins.join(' + ')} - ${conflict.reason}`);
      }
    }

    // Performance insights
    if (cacheTest && cacheTest.doubleHit.firstRequest.ttfb > 1000) {
      this.addInsight(`Slow TTFB (${cacheTest.doubleHit.firstRequest.ttfb}ms) on ${new URL(page.url).pathname}`);
    }

    // Learn from patterns
    this.learnFromPage(page);
  }

  private learnFromPage(page: PageAnalysis): void {
    // Example: Learn that certain paths are never cached
    const path = new URL(page.url).pathname;

    if (!page.ruleAnalysis.cacheStatus.working) {
      if (path.includes('/cart') || path.includes('/checkout') || path.includes('/my-account')) {
        this.addLearnedRule({
          id: 'dynamic_paths',
          condition: 'path contains cart/checkout/my-account',
          action: 'expect_no_cache',
          confidence: 0.9,
          timesApplied: 0,
          successRate: 1.0,
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Phase 3: Cache Experiments
  // --------------------------------------------------------------------------

  private async runExperiments(): Promise<void> {
    this.setState('experimenting');
    this.log('Phase 3: Running cache experiments...');

    const experiments = this.generateExperiments();

    for (const experiment of experiments) {
      if (this.stopRequested) break;

      this.log(`Running experiment: ${experiment.name}`);
      await this.runExperiment(experiment);
      this.memory.experiments.push(experiment);
    }

    this.emit('experiments_complete', { experiments: this.memory.experiments });
  }

  private generateExperiments(): CacheExperiment[] {
    const experiments: CacheExperiment[] = [
      {
        name: 'Cache Bypass Test',
        description: 'Test if cache can be bypassed with no-cache header',
        headers: { 'Cache-Control': 'no-cache' },
        expectedBehavior: 'Should bypass cache and hit origin',
      },
      {
        name: 'Vary Header Test',
        description: 'Test cache behavior with different Accept-Encoding',
        headers: { 'Accept-Encoding': 'identity' },
        expectedBehavior: 'May serve different cached version',
      },
      {
        name: 'Cookie Bypass Test',
        description: 'Test if cookies affect caching',
        headers: { 'Cookie': 'test_cookie=1' },
        expectedBehavior: 'May bypass cache for authenticated content',
      },
      {
        name: 'Query String Test',
        description: 'Test cache behavior with query parameters',
        headers: {},
        expectedBehavior: 'Cache may vary by query string',
      },
    ];

    // Add plugin-specific experiments based on detected plugins
    const homepage = this.memory.pages.get(this.config.baseUrl);
    if (homepage) {
      const plugins = homepage.ruleAnalysis.plugins;

      if (plugins.some(p => p.slug === 'wp-rocket')) {
        experiments.push({
          name: 'WP Rocket Mobile Cache',
          description: 'Test mobile-specific caching',
          headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)' },
          expectedBehavior: 'Should serve mobile-optimized cached version',
        });
      }

      if (plugins.some(p => p.slug === 'litespeed-cache')) {
        experiments.push({
          name: 'LiteSpeed ESI Test',
          description: 'Test Edge Side Includes behavior',
          headers: { 'X-LSCACHE': '1' },
          expectedBehavior: 'Should process ESI blocks',
        });
      }
    }

    return experiments;
  }

  private async runExperiment(experiment: CacheExperiment): Promise<void> {
    const url = experiment.name === 'Query String Test'
      ? `${this.config.baseUrl}?cache_test=${Date.now()}`
      : this.config.baseUrl;

    try {
      const result = await httpClient(url, {
        timeout: this.config.timeout,
        headers: experiment.headers,
      });

      const cacheHit = this.detectCacheHit(result.headers);

      experiment.actualResult = {
        cacheHit,
        ttfb: result.timing.ttfb,
        headers: result.headers,
      };

      // Determine if experiment passed and derive insights
      this.analyzeExperiment(experiment);

      this.emit('experiment_complete', { experiment });
    } catch (error) {
      experiment.insight = `Experiment failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  private detectCacheHit(headers: Record<string, string>): boolean {
    const cacheHeaders = [
      'x-cache', 'cf-cache-status', 'x-varnish', 'x-proxy-cache',
      'x-kinsta-cache', 'x-wpe-cached', 'x-litespeed-cache'
    ];

    for (const header of cacheHeaders) {
      const value = headers[header]?.toLowerCase();
      if (value && (value.includes('hit') || value === 'cached')) {
        return true;
      }
    }
    return false;
  }

  private analyzeExperiment(experiment: CacheExperiment): void {
    if (!experiment.actualResult) return;

    const { cacheHit, ttfb } = experiment.actualResult;

    switch (experiment.name) {
      case 'Cache Bypass Test':
        experiment.passed = !cacheHit;
        experiment.insight = cacheHit
          ? 'Cache does NOT respect no-cache header - may need server config'
          : 'Cache correctly bypasses on no-cache header';
        break;

      case 'Cookie Bypass Test':
        experiment.passed = !cacheHit;
        experiment.insight = cacheHit
          ? 'Cache serves cached content even with cookies - check cookie exclusions'
          : 'Cache correctly excludes requests with cookies';
        break;

      case 'Query String Test':
        // Both outcomes are valid depending on config
        experiment.passed = true;
        experiment.insight = cacheHit
          ? 'Query strings are cached (good for CDN, verify exclusions for dynamic params)'
          : 'Query strings bypass cache (conservative but may reduce hit rate)';
        break;

      default:
        experiment.passed = true;
        experiment.insight = `TTFB: ${ttfb}ms, Cache: ${cacheHit ? 'HIT' : 'MISS'}`;
    }

    if (experiment.insight) {
      this.addInsight(`Experiment "${experiment.name}": ${experiment.insight}`);
    }
  }

  // --------------------------------------------------------------------------
  // Phase 4: Synthesis
  // --------------------------------------------------------------------------

  private synthesize(): AgentSummary {
    this.log('Phase 4: Synthesizing findings...');

    const pages = Array.from(this.memory.pages.values());
    const allPlugins = new Set<string>();
    const allCDNs = new Set<string>();
    const allConflicts: string[] = [];
    const criticalIssues: string[] = [];
    const recommendations: string[] = [];

    let cacheWorkingCount = 0;
    let totalTTFB = 0;

    for (const page of pages) {
      const { ruleAnalysis, llmAnalysis } = page;

      // Aggregate plugins and CDNs
      ruleAnalysis.plugins.forEach(p => allPlugins.add(p.name));
      ruleAnalysis.cdns.forEach(c => allCDNs.add(c.name));

      // Aggregate conflicts
      for (const conflict of ruleAnalysis.conflicts) {
        const key = `${conflict.plugins.join(' + ')}: ${conflict.reason}`;
        if (!allConflicts.includes(key)) {
          allConflicts.push(key);
        }
      }

      // Count cache status
      if (ruleAnalysis.cacheStatus.working) {
        cacheWorkingCount++;
      }

      // Aggregate TTFB
      if (page.cacheTest) {
        totalTTFB += page.cacheTest.doubleHit.firstRequest.ttfb;
      }

      // Aggregate LLM findings
      if (llmAnalysis) {
        for (const issue of llmAnalysis.issues) {
          if (issue.severity === 'high' && !criticalIssues.includes(issue.title)) {
            criticalIssues.push(issue.title);
          }
        }
        for (const rec of llmAnalysis.recommendations) {
          if (rec.priority <= 2 && !recommendations.includes(rec.title)) {
            recommendations.push(rec.title);
          }
        }
      }
    }

    // Experiment results
    const passedExperiments = this.memory.experiments.filter(e => e.passed).length;
    const failedExperiments = this.memory.experiments.filter(e => e.passed === false).length;
    const experimentInsights = this.memory.experiments
      .filter(e => e.insight)
      .map(e => e.insight!);

    return {
      pagesAnalyzed: pages.length,
      cacheWorking: cacheWorkingCount > pages.length / 2,
      cacheWorkingPages: cacheWorkingCount,
      averageTTFB: pages.length > 0 ? Math.round(totalTTFB / pages.length) : 0,
      detectedPlugins: Array.from(allPlugins),
      detectedCDNs: Array.from(allCDNs),
      conflicts: allConflicts,
      criticalIssues,
      recommendations: recommendations.length > 0 ? recommendations : this.generateRecommendations(),
      experimentResults: this.config.experimentMode ? {
        passed: passedExperiments,
        failed: failedExperiments,
        insights: experimentInsights,
      } : undefined,
    };
  }

  private generateRecommendations(): string[] {
    const recommendations: string[] = [];
    const homepage = this.memory.pages.get(this.config.baseUrl);

    if (homepage) {
      if (!homepage.ruleAnalysis.cacheStatus.working) {
        recommendations.push('Enable page caching - no cache detected on homepage');
      }

      if (homepage.ruleAnalysis.cdns.length === 0) {
        recommendations.push('Consider adding a CDN for global performance');
      }

      if (homepage.ruleAnalysis.plugins.length === 0) {
        recommendations.push('Install a caching plugin (WP Rocket, LiteSpeed Cache, or W3 Total Cache)');
      }
    }

    return recommendations;
  }

  // --------------------------------------------------------------------------
  // Phase 5: Monitoring
  // --------------------------------------------------------------------------

  private async monitor(initialSummary: AgentSummary): Promise<void> {
    this.setState('monitoring');
    this.log('Phase 5: Entering monitoring mode...');

    let cycle = 0;
    this.memory.snapshots.push({ timestamp: new Date(), summary: initialSummary });

    while (!this.stopRequested) {
      cycle++;

      if (this.config.maxMonitorCycles > 0 && cycle > this.config.maxMonitorCycles) {
        this.log(`Reached max monitoring cycles (${this.config.maxMonitorCycles})`);
        break;
      }

      this.log(`Monitoring cycle ${cycle}, waiting ${this.config.monitorInterval / 1000}s...`);
      await this.sleep(this.config.monitorInterval);

      if (this.stopRequested) break;

      // Re-analyze homepage
      this.memory.pendingUrls.add(this.config.baseUrl);
      await this.analyzePage(this.config.baseUrl, 0);

      const newSummary = this.synthesize();
      this.memory.snapshots.push({ timestamp: new Date(), summary: newSummary });

      // Compare with previous
      const changes = this.detectChanges(initialSummary, newSummary);
      if (changes.length > 0) {
        this.log('Changes detected:');
        changes.forEach(c => this.log(`  - ${c}`));
        this.emit('changes_detected', { changes, summary: newSummary });

        // Adjust strategy based on changes
        this.adjustStrategyBasedOnChanges(changes);
      }
    }
  }

  private detectChanges(prev: AgentSummary, curr: AgentSummary): string[] {
    const changes: string[] = [];

    if (prev.cacheWorking !== curr.cacheWorking) {
      changes.push(`Cache status changed: ${prev.cacheWorking ? 'working' : 'not working'} → ${curr.cacheWorking ? 'working' : 'not working'}`);
    }

    const ttfbDiff = curr.averageTTFB - prev.averageTTFB;
    if (Math.abs(ttfbDiff) > 100) {
      changes.push(`Average TTFB ${ttfbDiff > 0 ? 'increased' : 'decreased'} by ${Math.abs(ttfbDiff)}ms`);
    }

    const newPlugins = curr.detectedPlugins.filter(p => !prev.detectedPlugins.includes(p));
    if (newPlugins.length > 0) {
      changes.push(`New plugins detected: ${newPlugins.join(', ')}`);
    }

    const removedPlugins = prev.detectedPlugins.filter(p => !curr.detectedPlugins.includes(p));
    if (removedPlugins.length > 0) {
      changes.push(`Plugins removed: ${removedPlugins.join(', ')}`);
    }

    return changes;
  }

  private adjustStrategyBasedOnChanges(changes: string[]): void {
    for (const change of changes) {
      if (change.includes('Cache status changed')) {
        // Re-run experiments to understand the change
        this.addInsight('Cache status changed - will re-run experiments next cycle');
      }

      if (change.includes('TTFB increased')) {
        // Add rule to investigate performance
        this.addLearnedRule({
          id: 'ttfb_investigation',
          condition: 'TTFB increased significantly',
          action: 'investigate_performance',
          confidence: 0.8,
          timesApplied: 0,
          successRate: 0,
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Strategy & Learning
  // --------------------------------------------------------------------------

  private shouldAdjustStrategy(): boolean {
    // Adjust if we're finding too many failed URLs
    const failureRate = this.memory.failedUrls.size /
      (this.memory.pages.size + this.memory.failedUrls.size + 1);

    return failureRate > 0.3;
  }

  private getStrategyAdjustmentReason(): string {
    const failureRate = this.memory.failedUrls.size /
      (this.memory.pages.size + this.memory.failedUrls.size + 1);

    if (failureRate > 0.3) {
      return 'High failure rate - adjusting URL selection';
    }

    return 'General strategy adjustment';
  }

  private adjustStrategy(reason: string): void {
    this.log(`Adjusting strategy: ${reason}`);

    if (reason.includes('failure rate')) {
      // Remove pending URLs that match failed patterns
      const failedPaths = Array.from(this.memory.failedUrls)
        .map(u => new URL(u).pathname);

      for (const pending of this.memory.pendingUrls) {
        const path = new URL(pending).pathname;
        if (failedPaths.some(fp => path.startsWith(fp.split('/').slice(0, -1).join('/')))) {
          this.memory.pendingUrls.delete(pending);
        }
      }
    }
  }

  private evaluateRule(rule: LearnedRule): boolean {
    // Simple rule evaluation - could be expanded with more sophisticated logic
    switch (rule.id) {
      case 'dynamic_paths':
        return true; // Always apply path-based rules
      case 'ttfb_investigation':
        return this.memory.snapshots.length > 1;
      default:
        return rule.confidence > 0.5;
    }
  }

  private addLearnedRule(rule: LearnedRule): void {
    const existing = this.memory.learnedRules.find(r => r.id === rule.id);
    if (existing) {
      existing.confidence = Math.min(1, existing.confidence + 0.1);
    } else {
      this.memory.learnedRules.push(rule);
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private getUrlDepth(url: string): number {
    // Find which discovered link led to this URL and calculate depth
    for (const [pageUrl, page] of this.memory.pages) {
      if (page.discoveredLinks.includes(url)) {
        return page.depth + 1;
      }
    }
    return 0;
  }

  private setState(state: AgentState): void {
    this.state = state;
    this.emit('state_change', { state });
  }

  private addInsight(insight: string): void {
    if (!this.memory.insights.includes(insight)) {
      this.memory.insights.push(insight);
      this.emit('insight', { insight });
    }
  }

  private log(message: string): void {
    if (this.config.verbose) {
      console.error(`[Agent] ${message}`);
    }
    this.emit('log', { message });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // --------------------------------------------------------------------------
  // Public Accessors
  // --------------------------------------------------------------------------

  getState(): AgentState {
    return this.state;
  }

  getMemory(): AgentMemory {
    return this.memory;
  }

  getInsights(): string[] {
    return this.memory.insights;
  }
}
