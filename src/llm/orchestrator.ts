/**
 * Qwen Orchestrator
 * Decides which tools to run and in what order based on the URL and goal
 */

import { chat, MODELS, type ChatMessage } from './client.js';

export type ToolName = 'http-client' | 'cache-tester' | 'dns-lookup' | 'wpscan';

export interface OrchestrationPlan {
  tools: ToolName[];
  reasoning: string;
}

const SYSTEM_PROMPT = `You are a WordPress cache analysis orchestrator. Given a URL, you decide which diagnostic tools to run.

Available tools:
- http-client: Fetches the URL, captures HTTP headers and HTML content. Always run this first.
- cache-tester: Makes two requests to test if caching is working (double-hit test). Useful to verify cache effectiveness.
- dns-lookup: Performs DNS lookups to detect CDN/WAF providers from CNAME records.
- wpscan: Probes common WordPress plugin paths to detect installed plugins and checks for known vulnerabilities.

Your job is to create an efficient tool execution plan.

Rules:
1. http-client should always be first (we need headers to detect anything)
2. dns-lookup helps identify CDN providers that might not be visible in headers
3. cache-tester is useful but adds latency (two requests)
4. wpscan adds latency (probes many paths) - only include if user requests plugin scan or security audit

Respond with JSON only:
{
  "tools": ["tool1", "tool2", ...],
  "reasoning": "Brief explanation of why these tools in this order"
}`;

export async function createPlan(url: string, options?: {
  quick?: boolean;
}): Promise<OrchestrationPlan> {
  const userPrompt = options?.quick
    ? `Analyze ${url} - quick scan only, skip cache-tester if possible`
    : `Create an analysis plan for: ${url}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  try {
    const response = await chat(messages, {
      model: MODELS.orchestrator,
      temperature: 0.3,
      format: 'json',
    });

    const plan = JSON.parse(response) as OrchestrationPlan;

    // Validate tools
    const validTools: ToolName[] = ['http-client', 'cache-tester', 'dns-lookup', 'wpscan'];
    plan.tools = plan.tools.filter(t => validTools.includes(t as ToolName)) as ToolName[];

    // Ensure http-client is first
    if (!plan.tools.includes('http-client')) {
      plan.tools.unshift('http-client');
    } else if (plan.tools[0] !== 'http-client') {
      plan.tools = plan.tools.filter(t => t !== 'http-client');
      plan.tools.unshift('http-client');
    }

    return plan;

  } catch (error) {
    // Fallback to default plan if LLM fails
    return {
      tools: ['http-client', 'dns-lookup', 'cache-tester'],
      reasoning: 'Default plan (LLM unavailable)',
    };
  }
}

export interface AdaptiveContext {
  url: string;
  headersFound: Record<string, string>;
  pluginsDetected: string[];
  cdnsDetected: string[];
}

export async function shouldRunCacheTest(context: AdaptiveContext): Promise<{
  shouldRun: boolean;
  reason: string;
}> {
  // Quick heuristic checks first (no LLM needed)
  const cfStatus = context.headersFound['cf-cache-status'];
  if (cfStatus === 'HIT') {
    return {
      shouldRun: false,
      reason: 'Cache already confirmed via CF-Cache-Status: HIT',
    };
  }

  const xCache = context.headersFound['x-cache'];
  if (xCache?.includes('HIT')) {
    return {
      shouldRun: false,
      reason: 'Cache already confirmed via X-Cache header',
    };
  }

  // If no cache indicators, worth testing
  if (context.pluginsDetected.length > 0 || context.cdnsDetected.length > 0) {
    return {
      shouldRun: true,
      reason: 'Cache plugins/CDN detected but no HIT confirmed - worth testing',
    };
  }

  return {
    shouldRun: true,
    reason: 'No cache indicators found - testing to confirm status',
  };
}
