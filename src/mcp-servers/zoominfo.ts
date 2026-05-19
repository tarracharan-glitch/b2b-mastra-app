import { MCPServer } from '@mastra/mcp';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ── Mock B2B data ────────────────────────────────────────────────────────────

const COMPANIES: Record<string, {
  name: string;
  domain: string;
  industry: string;
  headcount: number;
  revenueUSD: string;
  hq: string;
  techStack: string[];
}> = {
  stripe: {
    name: 'Stripe',
    domain: 'stripe.com',
    industry: 'Fintech / Payments',
    headcount: 8000,
    revenueUSD: '$1.5B ARR',
    hq: 'San Francisco, CA',
    techStack: ['Ruby', 'Go', 'React', 'AWS', 'Kafka', 'PostgreSQL'],
  },
  notion: {
    name: 'Notion',
    domain: 'notion.so',
    industry: 'Productivity SaaS',
    headcount: 600,
    revenueUSD: '$400M ARR',
    hq: 'San Francisco, CA',
    techStack: ['TypeScript', 'React', 'Node.js', 'GCP', 'CockroachDB'],
  },
  figma: {
    name: 'Figma',
    domain: 'figma.com',
    industry: 'Design Tools SaaS',
    headcount: 1200,
    revenueUSD: '$750M ARR',
    hq: 'San Francisco, CA',
    techStack: ['C++', 'TypeScript', 'React', 'AWS', 'Redis', 'MySQL'],
  },
  linear: {
    name: 'Linear',
    domain: 'linear.app',
    industry: 'Project Management SaaS',
    headcount: 90,
    revenueUSD: '$50M ARR',
    hq: 'San Francisco, CA',
    techStack: ['TypeScript', 'React', 'Node.js', 'Electron', 'PostgreSQL'],
  },
};

const CONTACTS: Record<string, Array<{
  name: string;
  title: string;
  email: string;
  linkedIn: string;
}>> = {
  stripe: [
    { name: 'Patrick Collison', title: 'CEO & Co-Founder', email: 'patrick@stripe.com', linkedIn: 'https://linkedin.com/in/patrickcollison' },
    { name: 'John Collison', title: 'President & Co-Founder', email: 'john@stripe.com', linkedIn: 'https://linkedin.com/in/johncollison' },
    { name: 'Claire Hughes Johnson', title: 'COO', email: 'claire@stripe.com', linkedIn: 'https://linkedin.com/in/clairehughesjohnson' },
  ],
  notion: [
    { name: 'Ivan Zhao', title: 'CEO & Co-Founder', email: 'ivan@notion.so', linkedIn: 'https://linkedin.com/in/ivanz' },
    { name: 'Simon Last', title: 'CTO & Co-Founder', email: 'simon@notion.so', linkedIn: 'https://linkedin.com/in/simonlast' },
    { name: 'Akshay Kothari', title: 'COO', email: 'akshay@notion.so', linkedIn: 'https://linkedin.com/in/akshaykothari' },
  ],
  figma: [
    { name: 'Dylan Field', title: 'CEO & Co-Founder', email: 'dylan@figma.com', linkedIn: 'https://linkedin.com/in/dylanfield' },
    { name: 'Evan Wallace', title: 'CTO & Co-Founder', email: 'evan@figma.com', linkedIn: 'https://linkedin.com/in/evanwallace' },
    { name: 'Yuhki Yamashita', title: 'CPO', email: 'yuhki@figma.com', linkedIn: 'https://linkedin.com/in/yuhkiyamashita' },
  ],
  linear: [
    { name: 'Karri Saarinen', title: 'CEO & Co-Founder', email: 'karri@linear.app', linkedIn: 'https://linkedin.com/in/karrisaarinen' },
    { name: 'Jori Lallo', title: 'CTO & Co-Founder', email: 'jori@linear.app', linkedIn: 'https://linkedin.com/in/jorilallo' },
    { name: 'Tuomas Artman', title: 'CPO & Co-Founder', email: 'tuomas@linear.app', linkedIn: 'https://linkedin.com/in/tuomasartman' },
  ],
};

const INTENT_SIGNALS: Record<string, {
  topics: Array<{ topic: string; score: number }>;
  summary: string;
}> = {
  stripe: {
    topics: [
      { topic: 'Revenue Recognition Software', score: 92 },
      { topic: 'Fraud Detection & Prevention', score: 87 },
      { topic: 'Global Payroll Solutions', score: 74 },
      { topic: 'Data Warehouse Modernization', score: 68 },
    ],
    summary: 'High buying intent around financial compliance and international expansion tooling.',
  },
  notion: {
    topics: [
      { topic: 'AI Writing Assistants', score: 95 },
      { topic: 'Enterprise SSO / SAML', score: 88 },
      { topic: 'Knowledge Management Platforms', score: 81 },
      { topic: 'API Integration Tools', score: 65 },
    ],
    summary: 'Strong intent signals around AI-augmented productivity and enterprise security.',
  },
  figma: {
    topics: [
      { topic: 'Design System Management', score: 90 },
      { topic: 'Accessibility Testing Tools', score: 83 },
      { topic: 'CDN & Asset Delivery', score: 76 },
      { topic: 'User Research Platforms', score: 70 },
    ],
    summary: 'Active research into design operations tooling and enterprise infrastructure.',
  },
  linear: {
    topics: [
      { topic: 'Developer Productivity Analytics', score: 89 },
      { topic: 'CI/CD Pipeline Optimization', score: 84 },
      { topic: 'Incident Management Software', score: 72 },
      { topic: 'Remote Team Collaboration', score: 66 },
    ],
    summary: 'High intent around engineering efficiency and DevOps tooling.',
  },
};

// ── Lookup helper ────────────────────────────────────────────────────────────

function resolveKey(input: string): string | null {
  const normalized = input.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const key of Object.keys(COMPANIES)) {
    const company = COMPANIES[key]!;
    if (
      normalized.includes(key) ||
      normalized.includes(company.domain.replace(/[^a-z0-9]/g, ''))
    ) {
      return key;
    }
  }
  return null;
}

// ── Tools ────────────────────────────────────────────────────────────────────

const searchCompaniesTool = createTool({
  id: 'search_companies',
  description: 'Search for firmographic data by company name or domain. Returns industry, headcount, revenue, HQ location, and tech stack.',
  inputSchema: z.object({
    query: z.string().describe('Company name or domain (e.g. "Stripe" or "stripe.com")'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    company: z.object({
      name: z.string(),
      domain: z.string(),
      industry: z.string(),
      headcount: z.number(),
      revenueUSD: z.string(),
      hq: z.string(),
      techStack: z.array(z.string()),
    }).optional(),
    message: z.string().optional(),
  }),
  execute: async ({ query }) => {
    const key = resolveKey(query);
    if (!key) {
      return { found: false, message: `No data found for "${query}". Available companies: Stripe, Notion, Figma, Linear.` };
    }
    return { found: true, company: COMPANIES[key] };
  },
});

const getContactsTool = createTool({
  id: 'get_contacts',
  description: 'Get key contacts at a company including name, title, email, and LinkedIn URL.',
  inputSchema: z.object({
    company: z.string().describe('Company name (e.g. "Notion")'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    company: z.string().optional(),
    contacts: z.array(z.object({
      name: z.string(),
      title: z.string(),
      email: z.string(),
      linkedIn: z.string(),
    })).optional(),
    message: z.string().optional(),
  }),
  execute: async ({ company }) => {
    const key = resolveKey(company);
    if (!key) {
      return { found: false, message: `No contacts found for "${company}". Available companies: Stripe, Notion, Figma, Linear.` };
    }
    return { found: true, company: COMPANIES[key]!.name, contacts: CONTACTS[key] };
  },
});

const getIntentSignalsTool = createTool({
  id: 'get_intent_signals',
  description: 'Get buying intent signals and scores for a company, indicating what solutions they are actively researching.',
  inputSchema: z.object({
    company: z.string().describe('Company name (e.g. "Linear")'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    company: z.string().optional(),
    summary: z.string().optional(),
    topics: z.array(z.object({
      topic: z.string(),
      score: z.number().describe('Intent score 0–100; higher means stronger buying signal'),
    })).optional(),
    message: z.string().optional(),
  }),
  execute: async ({ company }) => {
    const key = resolveKey(company);
    if (!key) {
      return { found: false, message: `No intent data found for "${company}". Available companies: Stripe, Notion, Figma, Linear.` };
    }
    const data = INTENT_SIGNALS[key]!;
    return { found: true, company: COMPANIES[key]!.name, summary: data.summary, topics: data.topics };
  },
});

// ── Server ───────────────────────────────────────────────────────────────────

const server = new MCPServer({
  name: 'ZoomInfo Mock MCP Server',
  version: '1.0.0',
  description: 'Mock B2B data enrichment server exposing firmographic data, contacts, and buying intent signals for B2B SaaS companies.',
  tools: {
    searchCompaniesTool,
    getContactsTool,
    getIntentSignalsTool,
  },
});

await server.startStdio();
