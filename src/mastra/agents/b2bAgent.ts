import { google } from '@ai-sdk/google';
import { MCPClient } from '@mastra/mcp';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { getTavilyAuthHeader } from '../../auth/resolveTavilyAuth';

const USER_ID = process.env.USER_ID ?? 'default';

const mcp = new MCPClient({
  id: 'b2b-mcp-client',
  servers: {
    tavily: {
      url: new URL('https://mcp.tavily.com/mcp/'),
      fetch: async (url, init) => {
        const authHeader = await getTavilyAuthHeader(USER_ID);
        const headers = new Headers(init?.headers);
        headers.set('Authorization', authHeader);
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
  instructions: `You are a B2B sales intelligence assistant. You help sales teams research companies, surface recent news, funding rounds, hiring signals, and public updates, and draft outreach. Use Tavily to search the web for real-time information. Be concise and structured in your responses.`,
  model: google('gemini-2.0-flash'),
  tools: await mcp.listTools(),
  memory,
});
