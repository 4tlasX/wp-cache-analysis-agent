/**
 * MCP Server
 * Exposes cache analysis tools via Model Context Protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { httpClient, httpClientTool } from './tools/http-client.js';
import { cacheTester, cacheTesterTool } from './tools/cache-tester.js';
import { dnsLookup, dnsLookupTool } from './tools/dns-lookup.js';
import { wpscan, wpscanTool } from './tools/wpscan.js';
import { wpSiteHealth, wpSiteHealthTool } from './tools/wp-site-health.js';
import { analyzeImages, imageAnalyzerTool } from './tools/image-analyzer.js';

const tools = [httpClientTool, cacheTesterTool, dnsLookupTool, wpscanTool, wpSiteHealthTool, imageAnalyzerTool];

export function createServer(): Server {
  const server = new Server(
    {
      name: 'wp-analysis',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'http-client': {
          const input = args as { url: string; timeout?: number };
          result = await httpClient(input.url, { timeout: input.timeout });
          break;
        }

        case 'cache-tester': {
          const input = args as { url: string; testBypass?: boolean; timeout?: number };
          result = await cacheTester(input.url, {
            testBypass: input.testBypass,
            timeout: input.timeout,
          });
          break;
        }

        case 'dns-lookup': {
          const input = args as { url: string; resolveCnames?: boolean };
          result = await dnsLookup(input.url, { resolveCnames: input.resolveCnames });
          break;
        }

        case 'wpscan': {
          const input = args as { url: string; apiToken?: string; timeout?: number };
          result = await wpscan(input.url, {
            apiToken: input.apiToken,
            timeout: input.timeout,
          });
          break;
        }

        case 'wp-site-health': {
          const input = args as { url: string; timeout?: number };
          result = await wpSiteHealth(input.url, {
            timeout: input.timeout,
          });
          break;
        }

        case 'image-analyzer': {
          const input = args as { url: string; html: string; maxImages?: number };
          result = analyzeImages(input.html, input.url, {
            maxImages: input.maxImages,
          });
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : 'Unknown error',
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function runServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run if executed directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runServer().catch(console.error);
}
