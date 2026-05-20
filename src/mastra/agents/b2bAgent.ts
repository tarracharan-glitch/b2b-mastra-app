import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from '@ai-sdk/google';
import { MCPClient } from '@mastra/mcp';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';

// mastra dev bundles this file into .mastra/output/index.mjs and runs it with
// cwd set to src/mastra/public/. import.meta.url reliably points to the bundle
// file at <project>/.mastra/output/index.mjs, so "../.." gives the project root.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const mcp = new MCPClient({
  id: 'b2b-mcp-client',
  servers: {
    zoominfo: {
      command: 'npx',
      args: ['tsx', path.join(projectRoot, 'src/mcp-servers/zoominfo.ts')],
    },
    clay: {
      command: 'npx',
      args: ['tsx', path.join(projectRoot, 'src/mcp-servers/clay.ts')],
    },
  },
});

const memory = new Memory({
  storage: new LibSQLStore({ id: 'b2b-memory', url: 'file:memory.db' }),
});

export const b2bAgent = new Agent({
  id: 'b2b-agent',
  name: 'B2B Sales Intelligence Agent',
  instructions: `You are a B2B sales intelligence assistant. You help sales teams research companies, enrich leads, find contacts, and craft outreach using ZoomInfo and Clay data. Be concise and structured in your responses.`,
  model: google('gemini-2.0-flash'),
  tools: await mcp.listTools(),
  memory,
});
