#!/usr/bin/env node
/**
 * Autonomous WP Cache Analysis Agent CLI
 *
 * This is the autonomous agent mode that:
 * - Navigates the site on its own, discovering pages
 * - Experiments with cache configurations to find issues
 * - Monitors the site over time and adjusts its logic
 */

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import { AutonomousAgent, type AgentConfig, type AgentSummary } from './autonomous-agent.js';
import { checkOllamaRunning, ensureModel, MODELS, type PullProgress } from '../llm/client.js';

const program = new Command();

program
  .name('wp-agent')
  .description('Autonomous WordPress Cache Analysis Agent')
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

function printSummary(summary: AgentSummary): void {
  console.log('');
  console.log(chalk.bold('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.bold.cyan('                    AUTONOMOUS AGENT REPORT'));
  console.log(chalk.bold('═══════════════════════════════════════════════════════════════'));
  console.log('');

  // Overview
  console.log(chalk.bold('📊 Overview'));
  console.log(`   Pages analyzed: ${chalk.yellow(summary.pagesAnalyzed)}`);
  console.log(`   Cache working: ${summary.cacheWorking ? chalk.green('YES') : chalk.red('NO')} (${summary.cacheWorkingPages}/${summary.pagesAnalyzed} pages)`);
  console.log(`   Average TTFB: ${chalk.yellow(summary.averageTTFB + 'ms')}`);
  console.log('');

  // Detected Stack
  console.log(chalk.bold('🔧 Detected Stack'));
  console.log(`   Plugins: ${summary.detectedPlugins.length > 0 ? summary.detectedPlugins.join(', ') : chalk.gray('None detected')}`);
  console.log(`   CDNs: ${summary.detectedCDNs.length > 0 ? summary.detectedCDNs.join(', ') : chalk.gray('None detected')}`);
  console.log('');

  // Conflicts
  if (summary.conflicts.length > 0) {
    console.log(chalk.bold.red('⚠️  Conflicts Detected'));
    for (const conflict of summary.conflicts) {
      console.log(`   ${chalk.red('•')} ${conflict}`);
    }
    console.log('');
  }

  // Critical Issues
  if (summary.criticalIssues.length > 0) {
    console.log(chalk.bold.red('🚨 Critical Issues'));
    for (const issue of summary.criticalIssues) {
      console.log(`   ${chalk.red('•')} ${issue}`);
    }
    console.log('');
  }

  // Experiment Results
  if (summary.experimentResults) {
    console.log(chalk.bold('🧪 Cache Experiments'));
    console.log(`   Passed: ${chalk.green(summary.experimentResults.passed)}`);
    console.log(`   Failed: ${chalk.red(summary.experimentResults.failed)}`);
    if (summary.experimentResults.insights.length > 0) {
      console.log('   Insights:');
      for (const insight of summary.experimentResults.insights) {
        console.log(`   ${chalk.blue('•')} ${insight}`);
      }
    }
    console.log('');
  }

  // Recommendations
  if (summary.recommendations.length > 0) {
    console.log(chalk.bold('💡 Recommendations'));
    for (let i = 0; i < summary.recommendations.length; i++) {
      console.log(`   ${i + 1}. ${summary.recommendations[i]}`);
    }
    console.log('');
  }

  console.log(chalk.bold('═══════════════════════════════════════════════════════════════'));
}

program
  .argument('<url>', 'Base URL to analyze')
  .option('--max-pages <n>', 'Maximum pages to analyze', '10')
  .option('--max-depth <n>', 'Maximum link depth to crawl', '2')
  .option('--timeout <ms>', 'Request timeout in milliseconds', '30000')
  .option('--ai', 'Enable AI-powered analysis')
  .option('--local', 'Use local Ollama instead of Claude for AI')
  .option('--anthropic-key <key>', 'Anthropic API key')
  .option('--no-experiments', 'Skip cache experiments')
  .option('--monitor', 'Enable continuous monitoring mode')
  .option('--monitor-interval <ms>', 'Monitoring interval in milliseconds', '60000')
  .option('--monitor-cycles <n>', 'Maximum monitoring cycles (0 = infinite)', '0')
  .option('-v, --verbose', 'Show detailed output')
  .option('--json', 'Output as JSON')
  .action(async (url: string, options) => {
    try {
      // Validate URL
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        console.error(chalk.red('Error: Only HTTP/HTTPS URLs are supported'));
        process.exit(1);
      }

      const useAI = options.ai === true;
      const useLocal = options.local === true;

      // Check AI prerequisites
      if (useAI) {
        if (useLocal) {
          if (options.verbose) {
            console.error(chalk.gray('→ Checking Ollama...'));
          }
          const ollamaRunning = await checkOllamaRunning();
          if (!ollamaRunning) {
            console.error(chalk.red('Error: Ollama is not running.'));
            console.error(chalk.yellow('Start Ollama with: ollama serve'));
            process.exit(1);
          }
          await ensureLocalModels(options.verbose);
        } else {
          const apiKey = options.anthropicKey || process.env.ANTHROPIC_API_KEY;
          if (!apiKey) {
            console.error(chalk.red('Error: Anthropic API key required for AI analysis.'));
            console.error(chalk.yellow('Set ANTHROPIC_API_KEY or use --anthropic-key'));
            process.exit(1);
          }
        }
      }

      // Create agent configuration
      const config: Partial<AgentConfig> & { baseUrl: string } = {
        baseUrl: url,
        maxPages: parseInt(options.maxPages, 10),
        maxDepth: parseInt(options.maxDepth, 10),
        timeout: parseInt(options.timeout, 10),
        useAI,
        llmProvider: useLocal ? 'local' : 'claude',
        apiKey: options.anthropicKey,
        experimentMode: options.experiments !== false,
        monitorMode: options.monitor === true,
        monitorInterval: parseInt(options.monitorInterval, 10),
        maxMonitorCycles: parseInt(options.monitorCycles, 10),
        verbose: options.verbose === true,
      };

      // Create and configure agent
      const agent = new AutonomousAgent(config);

      // Set up event handlers for verbose output
      if (options.verbose && !options.json) {
        agent.on('start', () => {
          console.error(chalk.cyan('\n🤖 Autonomous Agent Starting...\n'));
        });

        agent.on('reconnaissance_complete', ({ dns, siteHealth }) => {
          console.error(chalk.gray('✓ Reconnaissance complete'));
          if (siteHealth?.isWordPress) {
            console.error(chalk.gray(`  WordPress ${siteHealth.wpVersion || ''} detected`));
          }
          if (dns?.detected.cdn) {
            console.error(chalk.gray(`  CDN: ${dns.detected.cdn}`));
          }
        });

        agent.on('analyzing_page', ({ url, depth }) => {
          console.error(chalk.gray(`→ Analyzing: ${url} (depth: ${depth})`));
        });

        agent.on('page_analyzed', ({ pageAnalysis }) => {
          const status = pageAnalysis.ruleAnalysis.cacheStatus.working
            ? chalk.green('cached')
            : chalk.yellow('not cached');
          console.error(chalk.gray(`  ✓ ${status}, TTFB: ${pageAnalysis.cacheTest?.doubleHit.firstRequest.ttfb || 0}ms`));
        });

        agent.on('page_failed', ({ url, error }) => {
          console.error(chalk.red(`  ✗ Failed: ${url} - ${error}`));
        });

        agent.on('insight', ({ insight }) => {
          console.error(chalk.blue(`💡 ${insight}`));
        });

        agent.on('experiment_complete', ({ experiment }) => {
          const status = experiment.passed ? chalk.green('✓') : chalk.red('✗');
          console.error(chalk.gray(`  ${status} ${experiment.name}`));
        });

        agent.on('changes_detected', ({ changes }) => {
          console.error(chalk.yellow('\n⚠️  Changes Detected:'));
          changes.forEach((c: string) => console.error(chalk.yellow(`   ${c}`)));
        });
      }

      // Handle SIGINT for graceful shutdown
      process.on('SIGINT', () => {
        console.error(chalk.yellow('\nGracefully stopping agent...'));
        agent.stop();
      });

      // Run the agent
      const summary = await agent.run();

      // Output results
      if (options.json) {
        console.log(JSON.stringify({
          summary,
          insights: agent.getInsights(),
          memory: {
            pagesAnalyzed: agent.getMemory().pages.size,
            failedUrls: Array.from(agent.getMemory().failedUrls),
            experiments: agent.getMemory().experiments,
            learnedRules: agent.getMemory().learnedRules,
          },
        }, null, 2));
      } else {
        printSummary(summary);

        // Print insights
        const insights = agent.getInsights();
        if (insights.length > 0) {
          console.log(chalk.bold('🔍 Agent Insights'));
          for (const insight of insights) {
            console.log(`   ${chalk.blue('•')} ${insight}`);
          }
          console.log('');
        }

        // Print learned rules
        const rules = agent.getMemory().learnedRules;
        if (rules.length > 0 && options.verbose) {
          console.log(chalk.bold('🧠 Learned Rules'));
          for (const rule of rules) {
            console.log(`   ${chalk.magenta('•')} ${rule.action} (confidence: ${(rule.confidence * 100).toFixed(0)}%)`);
          }
          console.log('');
        }
      }

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
