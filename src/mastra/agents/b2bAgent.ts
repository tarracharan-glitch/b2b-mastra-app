import { google } from '@ai-sdk/google';
import { MCPClient } from '@mastra/mcp';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { getTavilyAuthHeader } from '../../auth/resolveTavilyAuth.ts';
import { getOAuthAuthHeader } from '../../auth/resolveOAuthAuth.ts';

const USER_ID = process.env.USER_ID ?? 'default';

const mcp = new MCPClient({
  id: 'b2b-mcp-client',
  servers: {
    tavily: {
      url: new URL('https://mcp.tavily.com/mcp/'),
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', await getTavilyAuthHeader(USER_ID));
        return fetch(url, { ...init, headers });
      },
    },
    notion: {
      url: new URL('https://mcp.notion.com/mcp'),
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', await getOAuthAuthHeader(USER_ID, 'notion'));
        return fetch(url, { ...init, headers });
      },
    },
  },
});

const memory = new Memory({
  storage: new LibSQLStore({ id: 'b2b-memory', url: 'file:memory.db' }),
});

export const b2bAgent = new Agent({
  id: 'b2b-agent',
  name: 
  'B2B Sales Intelligence Agent',
  instructions: `You are a B2B sales intelligence assistant. Use Notion to read internal documents, pages, and databases. Use Tavily to search the web for real-time information (news, funding, hiring signals, public updates). Combine both sources when relevant. Be concise and structured in your responses.`,
  model: google('gemini-2.0-flash'),
  tools: await mcp.listTools(),
  memory,
});
