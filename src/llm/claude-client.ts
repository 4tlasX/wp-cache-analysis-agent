/**
 * Claude API Client
 * Handles AI analysis via Anthropic's Claude API with data anonymization
 */

import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;

export function getClaudeClient(apiKey?: string): Anthropic {
  if (!client) {
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error('ANTHROPIC_API_KEY environment variable or --anthropic-key required');
    }
    client = new Anthropic({ apiKey: key });
  }
  return client;
}

export interface AnonymizedData {
  originalUrl: string;
  anonymizedUrl: string;
  originalSiteName?: string;
  anonymizedSiteName: string;
  originalDescription?: string;
  anonymizedDescription: string;
  urlMap: Map<string, string>;
}

/**
 * Anonymize sensitive site data before sending to Claude
 */
export function anonymizeSiteData(
  url: string,
  siteName?: string,
  siteDescription?: string
): AnonymizedData {
  // Extract domain for consistent replacement
  let domain: string;
  try {
    const parsed = new URL(url);
    domain = parsed.hostname;
  } catch {
    domain = url;
  }

  const urlMap = new Map<string, string>();

  // Create anonymized versions
  const anonymizedUrl = url.replace(domain, 'example-site.com');
  urlMap.set(domain, 'example-site.com');

  // Anonymize site name
  const anonymizedSiteName = siteName ? '[Site Name]' : '[Unknown Site]';

  // Anonymize description
  const anonymizedDescription = siteDescription ? '[Site Description]' : '';

  return {
    originalUrl: url,
    anonymizedUrl,
    originalSiteName: siteName,
    anonymizedSiteName,
    originalDescription: siteDescription,
    anonymizedDescription,
    urlMap,
  };
}

/**
 * Anonymize a text block by replacing known URLs/domains
 */
export function anonymizeText(text: string, urlMap: Map<string, string>): string {
  let result = text;
  for (const [original, replacement] of urlMap) {
    result = result.replace(new RegExp(escapeRegex(original), 'gi'), replacement);
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ClaudeChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  system?: string;
  webSearch?: boolean;
}

export async function claudeChat(
  messages: ClaudeChatMessage[],
  options: ClaudeChatOptions = {},
  apiKey?: string
): Promise<string> {
  const claude = getClaudeClient(apiKey);

  const {
    model = 'claude-sonnet-4-20250514',
    maxTokens = 2048,
    temperature = 0.5,
    system,
    webSearch = false,
  } = options;

  // Build request with optional web search tool
  const request: Anthropic.MessageCreateParams = {
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages,
  };

  if (webSearch) {
    // web_search_20250305 is a server-side tool - API performs searches automatically
    request.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  let response = await claude.messages.create(request);
  let allMessages: Anthropic.MessageParam[] = [...messages];

  // Handle server-side tool loop - continue until we get a JSON response
  let iterations = 0;
  while (iterations < 10) {
    // Concatenate all text blocks from current response
    const allText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('');

    // Check if text contains a complete JSON object with required fields
    const hasJson = allText.includes('"summary"') &&
                    allText.includes('"score"') &&
                    allText.includes('"issues"') &&
                    allText.includes('{') &&
                    allText.includes('}');

    if (hasJson) {
      // Found JSON response - return the combined text from this response
      return allText;
    }

    // If stop_reason is end_turn and no more tool use, but no JSON yet, prompt for it
    const hasToolUse = hasServerToolUse(response.content);
    if (response.stop_reason === 'end_turn' && !hasToolUse) {
      // Got a response but not JSON - prompt again forcefully
      allMessages.push({ role: 'assistant', content: response.content });
      allMessages.push({
        role: 'user',
        content: 'IMPORTANT: You have NOT output the JSON analysis yet. Do NOT explain or discuss - output ONLY the raw JSON object. Start your response with { and end with }. No text before or after. Required format:\n{"summary": "...", "score": N, "issues": [{"severity": "high|medium|low", "title": "...", "description": "...", "fix": "..."}], "recommendations": [{"priority": 1, "title": "...", "description": "...", "impact": "high|medium|low"}]}'
      });
    } else if (response.stop_reason === 'tool_use' || hasToolUse) {
      // Tool use in progress, continue
      allMessages.push({ role: 'assistant', content: response.content });
      allMessages.push({ role: 'user', content: 'Continue. When done with searches, output ONLY the raw JSON analysis object - no markdown, no explanation.' });
    } else {
      // No tool use and no text - something's wrong
      break;
    }

    response = await claude.messages.create({
      ...request,
      messages: allMessages,
    });
    iterations++;
  }

  // Final attempt: extract any text from the last response
  const finalText = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');

  if (finalText) {
    return finalText;
  }
  throw new Error('No text response from Claude');
}

function hasServerToolUse(content: Anthropic.ContentBlock[]): boolean {
  return content.some(block => block.type === 'server_tool_use');
}
