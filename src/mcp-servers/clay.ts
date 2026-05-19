import { MCPServer } from '@mastra/mcp';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ── Mock lead database ───────────────────────────────────────────────────────

type Seniority = 'C-Suite' | 'VP' | 'Director' | 'Manager' | 'Individual Contributor';

interface Lead {
  name: string;
  company: string;
  title: string;
  seniority: Seniority;
  department: string;
  email: string;
  phone: string;
}

const LEADS: Lead[] = [
  // Stripe
  { name: 'Patrick Collison',   company: 'Stripe', title: 'CEO & Co-Founder',              seniority: 'C-Suite',                department: 'Executive',   email: 'patrick@stripe.com',       phone: '+1-415-555-0101' },
  { name: 'John Collison',      company: 'Stripe', title: 'President & Co-Founder',         seniority: 'C-Suite',                department: 'Executive',   email: 'john@stripe.com',          phone: '+1-415-555-0102' },
  { name: 'Dhivya Suryadevara', company: 'Stripe', title: 'CFO',                            seniority: 'C-Suite',                department: 'Finance',     email: 'dhivya@stripe.com',        phone: '+1-415-555-0103' },
  { name: 'Will Gaybrick',      company: 'Stripe', title: 'Chief Product Officer',          seniority: 'C-Suite',                department: 'Product',     email: 'will@stripe.com',          phone: '+1-415-555-0104' },
  { name: 'Jeanne DeWitt Grossi', company: 'Stripe', title: 'Head of Revenue — Americas', seniority: 'VP',                     department: 'Sales',       email: 'jeanne@stripe.com',        phone: '+1-415-555-0105' },
  // Notion
  { name: 'Ivan Zhao',          company: 'Notion', title: 'CEO & Co-Founder',               seniority: 'C-Suite',                department: 'Executive',   email: 'ivan@notion.so',           phone: '+1-628-555-0201' },
  { name: 'Akshay Kothari',     company: 'Notion', title: 'COO',                            seniority: 'C-Suite',                department: 'Operations',  email: 'akshay@notion.so',         phone: '+1-628-555-0202' },
  { name: 'Madhu Muthukumar',   company: 'Notion', title: 'VP of Product',                  seniority: 'VP',                     department: 'Product',     email: 'madhu@notion.so',          phone: '+1-628-555-0203' },
  { name: 'Camille Ricketts',   company: 'Notion', title: 'VP of Marketing',                seniority: 'VP',                     department: 'Marketing',   email: 'camille@notion.so',        phone: '+1-628-555-0204' },
  // Figma
  { name: 'Dylan Field',        company: 'Figma',  title: 'CEO & Co-Founder',               seniority: 'C-Suite',                department: 'Executive',   email: 'dylan@figma.com',          phone: '+1-415-555-0301' },
  { name: 'Yuhki Yamashita',    company: 'Figma',  title: 'Chief Product Officer',          seniority: 'C-Suite',                department: 'Product',     email: 'yuhki@figma.com',          phone: '+1-415-555-0302' },
  { name: 'Amanda Kleha',       company: 'Figma',  title: 'Chief Customer Officer',         seniority: 'C-Suite',                department: 'Customer Success', email: 'amanda@figma.com',    phone: '+1-415-555-0303' },
  { name: 'Noah Levin',         company: 'Figma',  title: 'VP of Design',                   seniority: 'VP',                     department: 'Design',      email: 'noah@figma.com',           phone: '+1-415-555-0304' },
  // Linear
  { name: 'Karri Saarinen',     company: 'Linear', title: 'CEO & Co-Founder',               seniority: 'C-Suite',                department: 'Executive',   email: 'karri@linear.app',         phone: '+1-415-555-0401' },
  { name: 'Jori Lallo',         company: 'Linear', title: 'CTO & Co-Founder',               seniority: 'C-Suite',                department: 'Engineering', email: 'jori@linear.app',          phone: '+1-415-555-0402' },
  { name: 'Tuomas Artman',      company: 'Linear', title: 'CPO & Co-Founder',               seniority: 'C-Suite',                department: 'Product',     email: 'tuomas@linear.app',        phone: '+1-415-555-0403' },
  // Vercel
  { name: 'Guillermo Rauch',    company: 'Vercel', title: 'CEO & Founder',                  seniority: 'C-Suite',                department: 'Executive',   email: 'rauchg@vercel.com',        phone: '+1-415-555-0501' },
  { name: 'Malte Ubl',          company: 'Vercel', title: 'CTO',                            seniority: 'C-Suite',                department: 'Engineering', email: 'malte@vercel.com',         phone: '+1-415-555-0502' },
  { name: 'Lee Robinson',       company: 'Vercel', title: 'VP of Developer Experience',     seniority: 'VP',                     department: 'Engineering', email: 'lee@vercel.com',           phone: '+1-415-555-0503' },
  { name: 'Tom Knickrehm',      company: 'Vercel', title: 'VP of Sales',                    seniority: 'VP',                     department: 'Sales',       email: 'tom@vercel.com',           phone: '+1-415-555-0504' },
  // Airtable
  { name: 'Howie Liu',          company: 'Airtable', title: 'CEO & Co-Founder',             seniority: 'C-Suite',                department: 'Executive',   email: 'howie@airtable.com',       phone: '+1-415-555-0601' },
  { name: 'Andrew Ofstad',      company: 'Airtable', title: 'CPO & Co-Founder',             seniority: 'C-Suite',                department: 'Product',     email: 'andrew@airtable.com',      phone: '+1-415-555-0602' },
  { name: 'Evan Patterson',     company: 'Airtable', title: 'VP of Engineering',            seniority: 'VP',                     department: 'Engineering', email: 'evan@airtable.com',        phone: '+1-415-555-0603' },
  { name: 'April Underwood',    company: 'Airtable', title: 'Chief Product Officer',        seniority: 'C-Suite',                department: 'Product',     email: 'april@airtable.com',       phone: '+1-415-555-0604' },
];

// ── Mock company enrichment data ─────────────────────────────────────────────

const COMPANY_DATA: Record<string, {
  domain: string;
  techStack: string[];
  recentNews: string[];
  topContacts: string[];
}> = {
  stripe: {
    domain: 'stripe.com',
    techStack: ['Ruby', 'Go', 'React', 'AWS', 'Kafka', 'PostgreSQL', 'Terraform'],
    recentNews: [
      'Stripe launches Stablecoin Financial Accounts for 101 countries (May 2025)',
      'Stripe acquires Lemon Squeezy to expand into creator economy payments (Mar 2025)',
      'Stripe raises $694M at $70B valuation (Feb 2025)',
    ],
    topContacts: ['Patrick Collison', 'Will Gaybrick', 'Jeanne DeWitt Grossi'],
  },
  notion: {
    domain: 'notion.so',
    techStack: ['TypeScript', 'React', 'Node.js', 'GCP', 'CockroachDB', 'Elasticsearch'],
    recentNews: [
      'Notion launches Notion AI Q&A with enterprise-grade memory (Apr 2025)',
      'Notion surpasses 100M users globally (Jan 2025)',
      'Notion acquires Cron calendar app team (Dec 2024)',
    ],
    topContacts: ['Ivan Zhao', 'Akshay Kothari', 'Madhu Muthukumar'],
  },
  figma: {
    domain: 'figma.com',
    techStack: ['C++', 'TypeScript', 'React', 'AWS', 'Redis', 'MySQL', 'WebAssembly'],
    recentNews: [
      'Figma launches Figma Make — AI-powered UI-to-code tool (Mar 2025)',
      'Figma files for IPO, targeting $12B valuation (Feb 2025)',
      'Figma introduces enterprise dev mode with MCP support (Jan 2025)',
    ],
    topContacts: ['Dylan Field', 'Yuhki Yamashita', 'Amanda Kleha'],
  },
  linear: {
    domain: 'linear.app',
    techStack: ['TypeScript', 'React', 'Node.js', 'Electron', 'PostgreSQL', 'GraphQL'],
    recentNews: [
      'Linear raises $35M Series B at $400M valuation (Apr 2025)',
      'Linear launches AI-powered roadmap planning (Feb 2025)',
      'Linear crosses 10,000 paying teams milestone (Nov 2024)',
    ],
    topContacts: ['Karri Saarinen', 'Jori Lallo', 'Tuomas Artman'],
  },
  vercel: {
    domain: 'vercel.com',
    techStack: ['TypeScript', 'Next.js', 'Rust', 'Go', 'AWS', 'Cloudflare Workers', 'Turborepo'],
    recentNews: [
      'Vercel launches AI SDK 4.0 with multi-provider streaming (May 2025)',
      'Vercel acquires NuxtLabs to expand framework support (Mar 2025)',
      'Vercel raises $250M Series F at $3.25B valuation (Jan 2025)',
    ],
    topContacts: ['Guillermo Rauch', 'Lee Robinson', 'Tom Knickrehm'],
  },
  airtable: {
    domain: 'airtable.com',
    techStack: ['TypeScript', 'React', 'Node.js', 'AWS', 'MySQL', 'Redis', 'Snowflake'],
    recentNews: [
      'Airtable launches AI agent builder for no-code automation (Apr 2025)',
      'Airtable reaches $735M ARR, eyes profitability path (Feb 2025)',
      'Airtable expands enterprise API with 200+ native integrations (Dec 2024)',
    ],
    topContacts: ['Howie Liu', 'April Underwood', 'Evan Patterson'],
  },
};

// ── Outreach templates ────────────────────────────────────────────────────────

const TEMPLATES = [
  (name: string, firstName: string, context: string) =>
    `Hi ${firstName},\n\nI noticed ${context} — really impressive work.\n\nI'm reaching out because we help companies like yours streamline their go-to-market motion. Teams at similar-stage B2B SaaS companies have cut their sales cycle by 30% using our platform.\n\nWould you be open to a 20-minute call this week to explore if there's a fit?\n\nBest,\n[Your Name]`,

  (name: string, firstName: string, context: string) =>
    `Hey ${firstName},\n\n${context} caught my attention — congrats on the momentum.\n\nWe work with high-growth SaaS teams to automate their outbound and enrichment workflows. I think there's a real opportunity for ${name.split(' ').pop()} here.\n\nHappy to share a few specific ideas if you have 15 minutes — no deck, just a conversation.\n\nCheers,\n[Your Name]`,

  (name: string, firstName: string, context: string) =>
    `${firstName} —\n\nQuick note: saw that ${context}. That's the kind of signal that usually means the team is ready to scale outbound intentionally.\n\nWe've helped teams at this stage go from 50 to 500 qualified leads/month without adding headcount. Worth a look?\n\nBest,\n[Your Name]`,
];

// ── Lookup helpers ────────────────────────────────────────────────────────────

function normalizeCompany(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findLeadsByCompany(companyInput: string): Lead[] {
  const norm = normalizeCompany(companyInput);
  return LEADS.filter(l => normalizeCompany(l.company).includes(norm) || norm.includes(normalizeCompany(l.company)));
}

function findLead(nameInput: string, companyInput: string): Lead | undefined {
  const normName = nameInput.toLowerCase();
  const normCo = normalizeCompany(companyInput);
  return LEADS.find(l =>
    l.name.toLowerCase().includes(normName) ||
    (normName.includes(l.name.split(' ')[0]!.toLowerCase()) && normalizeCompany(l.company).includes(normCo))
  );
}

function findCompanyData(companyInput: string) {
  const norm = normalizeCompany(companyInput);
  for (const [key, data] of Object.entries(COMPANY_DATA)) {
    if (norm.includes(key) || key.includes(norm)) return { key, data };
  }
  return null;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const enrichLeadTool = createTool({
  id: 'enrich_lead',
  description: 'Enrich a lead profile by name and company. Returns job title, seniority, department, email, and phone number.',
  inputSchema: z.object({
    name: z.string().describe('Full or partial name of the lead (e.g. "Dylan Field")'),
    company: z.string().describe('Company the lead works at (e.g. "Figma")'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    lead: z.object({
      name: z.string(),
      company: z.string(),
      title: z.string(),
      seniority: z.string(),
      department: z.string(),
      email: z.string(),
      phone: z.string(),
    }).optional(),
    message: z.string().optional(),
  }),
  execute: async ({ name, company }) => {
    const lead = findLead(name, company);
    if (!lead) {
      return {
        found: false,
        message: `No lead found for "${name}" at "${company}". Available companies: Stripe, Notion, Figma, Linear, Vercel, Airtable.`,
      };
    }
    return { found: true, lead };
  },
});

const buildTableTool = createTool({
  id: 'build_table',
  description: 'Build a Clay-style enrichment table for a list of companies. Each row includes company info, key contacts, tech stack, and recent news.',
  inputSchema: z.object({
    companies: z.array(z.string()).min(1).max(6).describe('List of company names to enrich (e.g. ["Stripe", "Vercel"])'),
  }),
  outputSchema: z.object({
    rowCount: z.number(),
    rows: z.array(z.object({
      company: z.string(),
      domain: z.string(),
      topContacts: z.array(z.object({
        name: z.string(),
        title: z.string(),
        email: z.string(),
      })),
      techStack: z.array(z.string()),
      recentNews: z.array(z.string()),
      enrichmentStatus: z.enum(['enriched', 'partial', 'not_found']),
    })),
    skipped: z.array(z.string()),
  }),
  execute: async ({ companies }) => {
    const rows = [];
    const skipped = [];

    for (const name of companies) {
      const match = findCompanyData(name);
      if (!match) {
        skipped.push(name);
        continue;
      }

      const { key, data } = match;
      const contacts = findLeadsByCompany(key)
        .filter(l => data.topContacts.includes(l.name))
        .map(l => ({ name: l.name, title: l.title, email: l.email }));

      rows.push({
        company: key.charAt(0).toUpperCase() + key.slice(1),
        domain: data.domain,
        topContacts: contacts,
        techStack: data.techStack,
        recentNews: data.recentNews,
        enrichmentStatus: 'enriched' as const,
      });
    }

    return { rowCount: rows.length, rows, skipped };
  },
});

const generateOutreachTool = createTool({
  id: 'generate_outreach',
  description: 'Generate a personalized B2B outreach message for a lead based on their name and a context snippet (e.g. recent news, a shared connection, or a company milestone).',
  inputSchema: z.object({
    name: z.string().describe('Full name of the lead (e.g. "Guillermo Rauch")'),
    context: z.string().describe('A short context snippet to personalize the message (e.g. "Vercel just raised a $250M Series F" or "you spoke at Next.js Conf last week")'),
    tone: z.enum(['formal', 'casual', 'direct']).default('casual').describe('Tone of the outreach message'),
  }),
  outputSchema: z.object({
    name: z.string(),
    firstName: z.string(),
    tone: z.string(),
    subject: z.string(),
    body: z.string(),
  }),
  execute: async ({ name, context, tone }) => {
    const resolvedTone = tone ?? 'casual';
    const firstName = name.trim().split(/\s+/)[0]!;

    const toneIndex = { formal: 0, casual: 1, direct: 2 }[resolvedTone];
    const templateFn = TEMPLATES[toneIndex]!;
    const body = templateFn(name, firstName, context);

    const subjects: Record<string, string> = {
      formal: `A quick note for ${firstName} — scaling your GTM at ${name.split(' ').slice(-1)[0]}`,
      casual: `${firstName}, thought this might be relevant`,
      direct: `15 min? Relevant to what's happening at your company`,
    };

    return {
      name,
      firstName,
      tone: resolvedTone,
      subject: subjects[resolvedTone]!,
      body,
    };
  },
});

// ── Server ────────────────────────────────────────────────────────────────────

const server = new MCPServer({
  name: 'Clay Mock MCP Server',
  version: '1.0.0',
  description: 'Mock data enrichment and outreach automation server. Enrich leads, build Clay-style tables, and generate personalized B2B outreach.',
  tools: {
    enrichLeadTool,
    buildTableTool,
    generateOutreachTool,
  },
});

await server.startStdio();
