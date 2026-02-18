#!/usr/bin/env node
/**
 * WP Analysis Agent
 * Main entry point - orchestrates tools and generates reports
 */

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';

import { httpClient } from '../mcp-server/tools/http-client.js';
import { cacheTester } from '../mcp-server/tools/cache-tester.js';
import { dnsLookup } from '../mcp-server/tools/dns-lookup.js';
import { wpscan, type WPScanResult } from '../mcp-server/tools/wpscan.js';
import { wpSiteHealth, type WPSiteHealthResult } from '../mcp-server/tools/wp-site-health.js';
import { sslInfo, type SSLInfoResult } from '../mcp-server/tools/ssl-info.js';
import { analyze } from './analyzer.js';
import { generateReport } from './reporter.js';

// LLM imports
import {
  checkOllamaRunning,
  ensureModel,
  MODELS,
  type PullProgress,
} from '../llm/client.js';
import { analyzeWithLLM, buildContextFromResults, type LLMProvider } from '../llm/analyzer.js';

const program = new Command();

program
  .name('wp-analyze')
  .description('WordPress Cache Analysis Agent')
  .version('1.0.0');

function formatProgress(model: string, progress: PullProgress): string {
  if (progress.percent !== undefined) {
    const bar = '█'.repeat(Math.floor(progress.percent / 5)) +
                '░'.repeat(20 - Math.floor(progress.percent / 5));
    return `  ${model}: [${bar}] ${progress.percent}%`;
  }
  return `  ${model}: ${progress.status}`;
}

async function ensureLocalModels(verbose: boolean): Promise<boolean> {
  // Only check analyzer model (we removed orchestrator)
  if (verbose) {
    console.error(chalk.gray(`→ Checking ${MODELS.analyzer}...`));
  }

  let lastLine = '';
  await ensureModel(MODELS.analyzer, (progress) => {
    if (verbose) {
      const line = formatProgress(MODELS.analyzer, progress);
      if (line !== lastLine) {
        process.stderr.write(`\r${line}`);
        lastLine = line;
      }
    }
  });
  if (verbose && lastLine) {
    console.error('');
  }

  return true;
}

program
  .argument('<url>', 'URL to analyze')
  .option('-f, --format <format>', 'Output format: json, markdown, text', 'text')
  .option('-v, --verbose', 'Show detailed output', false)
  .option('--ai', 'Enable AI-powered analysis (uses Claude by default)')
  .option('--local', 'Use local Ollama instead of Claude for AI analysis')
  .option('--anthropic-key <key>', 'Anthropic API key (or set ANTHROPIC_API_KEY env var)')
  .option('--wpscan', 'Detect plugins by probing common paths')
  .option('--wpscan-token <token>', 'WPScan API token for vulnerability lookup')
  .option('--no-dns', 'Skip DNS lookup')
  .option('--no-cache-test', 'Skip cache test (faster)')
  .option('--timeout <ms>', 'Request timeout in milliseconds', '30000')
  .action(async (url: string, options) => {
    try {
      // Validate URL
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        console.error(chalk.red('Error: Only HTTP/HTTPS URLs are supported'));
        process.exit(1);
      }

      const timeout = parseInt(options.timeout, 10);
      const useAI = options.ai === true;
      const useLocal = options.local === true;
      const llmProvider: LLMProvider = useLocal ? 'local' : 'claude';

      // Check AI prerequisites
      if (useAI) {
        if (useLocal) {
          // Check Ollama for local mode
          if (options.verbose) {
            console.error(chalk.gray('→ Checking Ollama...'));
          }

          const ollamaRunning = await checkOllamaRunning();
          if (!ollamaRunning) {
            console.error(chalk.red('Error: Ollama is not running.'));
            console.error(chalk.yellow('Start Ollama with: ollama serve'));
            console.error(chalk.gray('Or run without --local flag to use Claude API'));
            process.exit(1);
          }

          // Ensure models are downloaded
          await ensureLocalModels(options.verbose);
        } else {
          // Check for Anthropic API key
          const apiKey = options.anthropicKey || process.env.ANTHROPIC_API_KEY;
          if (!apiKey) {
            console.error(chalk.red('Error: Anthropic API key required for AI analysis.'));
            console.error(chalk.yellow('Set ANTHROPIC_API_KEY environment variable or use --anthropic-key'));
            console.error(chalk.gray('Or run with --local flag to use local Ollama'));
            process.exit(1);
          }
          if (options.verbose) {
            console.error(chalk.gray('→ Using Claude API for analysis'));
          }
        }
      }

      // Execute tools
      let httpResult: any;
      let cacheTestResult: any;
      let dnsResult: any;
      let wpscanResult: WPScanResult | undefined;
      let siteHealthResult: WPSiteHealthResult | undefined;
      let sslResult: SSLInfoResult | undefined;

      // HTTP Client (always runs first)
      if (options.verbose) {
        console.error(chalk.gray('→ Fetching URL...'));
      }
      httpResult = await httpClient(url, { timeout });
      if (httpResult.error) {
        console.error(chalk.red(`Error: ${httpResult.error}`));
        process.exit(1);
      }

      // DNS Lookup
      if (options.dns !== false) {
        if (options.verbose) {
          console.error(chalk.gray('→ DNS lookup...'));
        }
        dnsResult = await dnsLookup(url);
      }

      // Cache Test
      if (options.cacheTest !== false) {
        if (options.verbose) {
          console.error(chalk.gray('→ Running cache test...'));
        }
        cacheTestResult = await cacheTester(url, { timeout });
      }

      // Run WPScan if enabled
      if (options.wpscan) {
        if (options.verbose) {
          console.error(chalk.gray('→ Scanning for plugins...'));
        }
        wpscanResult = await wpscan(url, {
          apiToken: options.wpscanToken,
          timeout,
        });
        if (options.verbose && wpscanResult.plugins.length > 0) {
          console.error(chalk.gray(`  Found ${wpscanResult.plugins.length} plugins`));
        }
      }

      // Fetch WP REST API info (auto-detect WordPress)
      if (options.verbose) {
        console.error(chalk.gray('→ Fetching WP REST API...'));
      }
      siteHealthResult = await wpSiteHealth(url, { timeout });
      if (options.verbose && siteHealthResult.isWordPress) {
        const pluginCount = siteHealthResult.restPlugins?.length || 0;
        console.error(chalk.gray(`  WordPress ${siteHealthResult.wpVersion || ''}, ${pluginCount} plugins via REST`));
      }

      // Fetch SSL info
      if (options.verbose) {
        console.error(chalk.gray('→ Checking SSL certificate...'));
      }
      sslResult = await sslInfo(url, { timeout });
      if (options.verbose && sslResult.certificate) {
        console.error(chalk.gray(`  SSL: ${sslResult.tlsVersion}, expires in ${sslResult.certificate.daysRemaining} days`));
      }

      // Ensure we have minimal results if tools were skipped
      if (!cacheTestResult) {
        cacheTestResult = {
          url,
          doubleHit: {
            firstRequest: { statusCode: httpResult.statusCode, ttfb: httpResult.timing.ttfb },
            secondRequest: { statusCode: httpResult.statusCode, ttfb: httpResult.timing.ttfb },
            cacheWorking: false,
            explanation: 'Cache test skipped',
          },
          headers: {},
          cacheStatus: { isHit: false },
        };
      }

      // Rule-based analysis (always runs)
      if (options.verbose) {
        console.error(chalk.gray('→ Analyzing...'));
      }
      const ruleResult = analyze(httpResult, cacheTestResult, dnsResult, wpscanResult, siteHealthResult, sslResult);

      // LLM analysis (if enabled)
      let llmAnalysis;
      if (useAI) {
        if (options.verbose) {
          const providerName = useLocal ? 'Ollama (local)' : 'Claude';
          console.error(chalk.gray(`→ AI analysis via ${providerName}...`));
        }
        const context = buildContextFromResults(
          url,
          httpResult,
          cacheTestResult,
          dnsResult,
          ruleResult
        );
        llmAnalysis = await analyzeWithLLM(context, {
          provider: llmProvider,
          apiKey: options.anthropicKey,
        });
      }

      if (options.verbose) {
        console.error('');
      }

      // Generate report
      const report = generateReport(ruleResult, {
        format: options.format,
        verbose: options.verbose,
        llmAnalysis,
      });

      console.log(report);

    } catch (error) {
      if (error instanceof Error && error.message.includes('Invalid URL')) {
        console.error(chalk.red('Error: Invalid URL format'));
      } else {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
      process.exit(1);
    }
  });

program.parse();
