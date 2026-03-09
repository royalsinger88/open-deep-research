import FirecrawlApp from '@mendable/firecrawl-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { generateObject } from 'ai';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';

import { getModel, trimPrompt } from './ai/providers';
import { systemPrompt } from './prompt';

function log(...args: any[]) {
  console.log(...args);
}

export type ResearchProgress = {
  currentDepth: number;
  totalDepth: number;
  currentBreadth: number;
  totalBreadth: number;
  currentQuery?: string;
  totalQueries: number;
  completedQueries: number;
};

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

type SearchDocument = {
  url?: string;
  markdown?: string;
  provider?: string;
};

type SearchResult = {
  data: SearchDocument[];
};

type SearchProvider = 'firecrawl' | 'tavily' | 'exa-mcp' | 'tavily+exa-mcp';

const rawSearchProvider = (
  process.env.SEARCH_PROVIDER || 'tavily+exa-mcp'
).toLowerCase();
const searchProvider = rawSearchProvider as SearchProvider;
const SearchResultLimit = Number(process.env.SEARCH_RESULTS_LIMIT) || 5;
const SearchTimeoutMs = Number(process.env.SEARCH_TIMEOUT_MS) || 15_000;
const ConcurrencyLimit =
  Number(process.env.SEARCH_CONCURRENCY || process.env.FIRECRAWL_CONCURRENCY) ||
  2;
const ExaMcpTimeoutMs = Number(process.env.EXA_MCP_TIMEOUT_MS) || 25_000;
const ExaContextMaxCharacters =
  Number(process.env.EXA_CONTEXT_MAX_CHARACTERS) || 12_000;
const TavilyApiUrl =
  process.env.TAVILY_BASE_URL || 'https://api.tavily.com/search';
const ExaMcpCommand = process.env.EXA_MCP_COMMAND || 'npx';
const ExaMcpArgsDefault = '-y mcp-remote https://mcp.exa.ai/mcp';
const ExaMcpArgsText = process.env.EXA_MCP_ARGS || ExaMcpArgsDefault;
const SameUrlSimilarityThreshold =
  Number(process.env.SEARCH_SAME_URL_SIMILARITY_THRESHOLD) || 0.9;
const CrossUrlSimilarityThreshold =
  Number(process.env.SEARCH_CROSS_URL_SIMILARITY_THRESHOLD) || 0.95;

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_KEY ?? '',
  apiUrl: process.env.FIRECRAWL_BASE_URL,
});

function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] || '';
    if (!quote && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
    if (quote && ch === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function normalizeUrl(url?: string): string {
  if (!url) {
    return '';
  }
  try {
    const u = new URL(url);
    u.hash = '';
    const normalizedPath = u.pathname.replace(/\/+$/, '');
    const normalized = `${u.protocol}//${u.host.toLowerCase()}${normalizedPath}${u.search}`;
    return normalized || url.trim();
  } catch {
    return url.trim();
  }
}

function normalizeContent(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNgramSet(text: string, n = 5): Set<string> {
  const compactText = normalizeContent(text).replace(/\s+/g, '');
  if (!compactText) {
    return new Set();
  }
  if (compactText.length <= n) {
    return new Set([compactText]);
  }
  const grams = new Set<string>();
  for (let i = 0; i <= compactText.length - n; i += 1) {
    grams.add(compactText.slice(i, i + n));
    if (grams.size >= 4000) {
      break;
    }
  }
  return grams;
}

function calcContentSimilarity(a: string, b: string): number {
  const na = normalizeContent(a);
  const nb = normalizeContent(b);
  if (!na || !nb) {
    return 0;
  }
  if (na === nb) {
    return 1;
  }
  const setA = buildNgramSet(na);
  const setB = buildNgramSet(nb);
  if (!setA.size || !setB.size) {
    return 0;
  }
  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  if (union <= 0) {
    return 0;
  }
  return intersection / union;
}

function mergeProviders(left?: string, right?: string): string | undefined {
  const providers = new Set(
    [left, right]
      .flatMap(item => (item ? item.split(',') : []))
      .map(item => item.trim())
      .filter(Boolean),
  );
  if (!providers.size) {
    return undefined;
  }
  return [...providers].sort().join(',');
}

function choosePreferredDoc(
  a: SearchDocument,
  b: SearchDocument,
): SearchDocument {
  const aLen = (a.markdown || '').length;
  const bLen = (b.markdown || '').length;
  const chosen = bLen > aLen ? b : a;
  return {
    ...chosen,
    url: chosen.url || a.url || b.url,
    provider: mergeProviders(a.provider, b.provider),
  };
}

function dedupeSearchDocuments(docs: SearchDocument[]): SearchDocument[] {
  const unique: SearchDocument[] = [];

  for (const doc of docs) {
    const current = {
      ...doc,
      markdown: (doc.markdown || '').trim(),
      url: doc.url?.trim(),
    };
    if (!current.markdown) {
      continue;
    }

    const currentUrl = normalizeUrl(current.url);
    const currentText = current.markdown;

    let merged = false;

    for (let i = 0; i < unique.length; i += 1) {
      const existing = unique[i]!;
      const existingUrl = normalizeUrl(existing.url);
      const similarity = calcContentSimilarity(
        existing.markdown || '',
        currentText,
      );

      if (
        currentUrl &&
        existingUrl &&
        currentUrl === existingUrl &&
        similarity >= SameUrlSimilarityThreshold
      ) {
        unique[i] = choosePreferredDoc(existing, current);
        merged = true;
        break;
      }

      if (
        (!currentUrl || !existingUrl || currentUrl !== existingUrl) &&
        similarity >= CrossUrlSimilarityThreshold
      ) {
        unique[i] = choosePreferredDoc(existing, current);
        merged = true;
        break;
      }
    }

    if (!merged) {
      unique.push(current);
    }
  }

  return unique;
}

function getValidatedSearchProvider() {
  if (
    searchProvider !== 'firecrawl' &&
    searchProvider !== 'tavily' &&
    searchProvider !== 'exa-mcp' &&
    searchProvider !== 'tavily+exa-mcp'
  ) {
    throw new Error(
      `Unsupported SEARCH_PROVIDER: "${process.env.SEARCH_PROVIDER}". Use "firecrawl", "tavily", "exa-mcp", or "tavily+exa-mcp".`,
    );
  }
  return searchProvider;
}

async function searchWithFirecrawl(query: string): Promise<SearchResult> {
  const result = await firecrawl.search(query, {
    timeout: SearchTimeoutMs,
    limit: SearchResultLimit,
    scrapeOptions: { formats: ['markdown'] },
  });

  return result;
}

async function searchWithTavily(query: string): Promise<SearchResult> {
  if (!process.env.TAVILY_KEY) {
    throw new Error('TAVILY_KEY is required when SEARCH_PROVIDER=tavily');
  }

  const response = await fetch(TavilyApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: process.env.TAVILY_KEY,
      query,
      search_depth: process.env.TAVILY_SEARCH_DEPTH || 'advanced',
      include_raw_content: true,
      include_answer: false,
      include_images: false,
      max_results: SearchResultLimit,
    }),
    signal: AbortSignal.timeout(SearchTimeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tavily search failed (${response.status}): ${errorText}`);
  }

  const body = (await response.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      raw_content?: string;
    }>;
  };

  const data = (body.results || []).map(item => {
    const content = item.raw_content || item.content || '';
    const titlePrefix = item.title ? `# ${item.title}\n\n` : '';
    return {
      url: item.url,
      markdown: `${titlePrefix}${content}`.trim(),
      provider: 'tavily',
    };
  });

  return { data };
}

function parseExaSearchText(text: string): SearchDocument[] {
  if (!text.trim()) {
    return [];
  }

  const parsed: SearchDocument[] = [];
  const pattern =
    /Title:\s*([\s\S]*?)\nAuthor:\s*([\s\S]*?)\nPublished Date:\s*([\s\S]*?)\nURL:\s*(https?:\/\/\S+)\nText:\s*([\s\S]*?)(?=\nTitle:\s*|$)/g;

  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const title = match[1]?.trim() || '';
    const url = match[4]?.trim() || '';
    const body = match[5]?.trim() || '';
    const markdown = `${title ? `# ${title}\n\n` : ''}${body}`.trim();
    if (markdown) {
      parsed.push({
        url,
        markdown,
        provider: 'exa-mcp',
      });
    }
    match = pattern.exec(text);
  }

  if (parsed.length > 0) {
    return parsed;
  }

  const urls = text.match(/https?:\/\/\S+/g) || [];
  if (!urls.length) {
    return [{ markdown: text.trim(), provider: 'exa-mcp' }];
  }

  return urls.map(url => ({
    url,
    markdown: text.trim(),
    provider: 'exa-mcp',
  }));
}

async function searchWithExaMcp(query: string): Promise<SearchResult> {
  const transport = new StdioClientTransport({
    command: ExaMcpCommand,
    args: parseShellArgs(ExaMcpArgsText),
    stderr: 'pipe',
  });

  const client = new Client(
    {
      name: 'deep-research-exa-client',
      version: '0.0.1',
    },
    {
      capabilities: {},
    },
  );

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutError = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Exa MCP timeout after ${ExaMcpTimeoutMs}ms`));
    }, ExaMcpTimeoutMs);
  });

  const run = async () => {
    await client.connect(transport);
    const result = (await client.callTool({
      name: 'web_search_exa',
      arguments: {
        query,
        numResults: SearchResultLimit,
        contextMaxCharacters: ExaContextMaxCharacters,
      },
    })) as {
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    };

    const texts = (result.content || [])
      .filter(
        (item): item is { type: string; text?: string } => item.type === 'text',
      )
      .map(item => item.text || '')
      .filter(Boolean);

    const data = dedupeSearchDocuments(
      texts.flatMap(text => parseExaSearchText(text)),
    );

    return { data };
  };

  try {
    return await Promise.race([run(), timeoutError]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    await client.close().catch(() => undefined);
  }
}

function mergeSearchResults(results: SearchResult[]): SearchResult {
  return {
    data: dedupeSearchDocuments(results.flatMap(result => result.data)),
  };
}

async function runSearch(query: string): Promise<SearchResult> {
  const provider = getValidatedSearchProvider();
  if (provider === 'tavily') {
    return searchWithTavily(query);
  }
  if (provider === 'exa-mcp') {
    return searchWithExaMcp(query);
  }
  if (provider === 'tavily+exa-mcp') {
    const results = await Promise.allSettled([
      searchWithTavily(query),
      searchWithExaMcp(query),
    ]);

    const successes = results
      .filter(
        (item): item is PromiseFulfilledResult<SearchResult> =>
          item.status === 'fulfilled',
      )
      .map(item => item.value);

    const failures = results
      .filter(
        (item): item is PromiseRejectedResult => item.status === 'rejected',
      )
      .map(item => item.reason);

    failures.forEach(error => {
      log(`Search provider failed for query "${query}":`, error);
    });

    if (successes.length === 0) {
      throw new Error(`All search providers failed for query: ${query}`);
    }

    return mergeSearchResults(successes);
  }
  return searchWithFirecrawl(query);
}

// take en user query, return a list of SERP queries
async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
}: {
  query: string;
  numQueries?: number;

  // optional, if provided, the research will continue from the last learning
  learnings?: string[];
}) {
  const res = await generateObject({
    model: getModel(),
    system: systemPrompt(),
    prompt: `Given the following prompt from the user, generate a list of SERP queries to research the topic. Return a maximum of ${numQueries} queries, but feel free to return less if the original prompt is clear. Make sure each query is unique and not similar to each other: <prompt>${query}</prompt>\n\n${
      learnings
        ? `Here are some learnings from previous research, use them to generate more specific queries: ${learnings.join(
            '\n',
          )}`
        : ''
    }`,
    schema: z.object({
      queries: z
        .array(
          z.object({
            query: z.string().describe('The SERP query'),
            researchGoal: z
              .string()
              .describe(
                'First talk about the goal of the research that this query is meant to accomplish, then go deeper into how to advance the research once the results are found, mention additional research directions. Be as specific as possible, especially for additional research directions.',
              ),
          }),
        )
        .describe(`List of SERP queries, max of ${numQueries}`),
    }),
  });
  log(`Created ${res.object.queries.length} queries`, res.object.queries);

  return res.object.queries.slice(0, numQueries);
}

async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
}: {
  query: string;
  result: SearchResult;
  numLearnings?: number;
  numFollowUpQuestions?: number;
}) {
  const contents = compact(
    result.data.map(item => {
      const providerTag = item.provider ? `provider=${item.provider}` : '';
      const urlTag = item.url ? `url=${item.url}` : '';
      const metadata = [providerTag, urlTag].filter(Boolean).join(', ');
      const contentPrefix = metadata ? `[source ${metadata}]\n` : '';
      return item.markdown ? `${contentPrefix}${item.markdown}` : '';
    }),
  ).map(content => trimPrompt(content, 25_000));
  log(`Ran ${query}, found ${contents.length} contents`);

  const res = await generateObject({
    model: getModel(),
    abortSignal: AbortSignal.timeout(60_000),
    system: systemPrompt(),
    prompt: trimPrompt(
      `Given the following contents from a SERP search for the query <query>${query}</query>, generate a list of learnings from the contents. Return a maximum of ${numLearnings} learnings, but feel free to return less if the contents are clear. Make sure each learning is unique and not similar to each other. The learnings should be concise and to the point, as detailed and information dense as possible. Make sure to include any entities like people, places, companies, products, things, etc in the learnings, as well as any exact metrics, numbers, or dates. The learnings will be used to research the topic further.\n\n<contents>${contents
        .map(content => `<content>\n${content}\n</content>`)
        .join('\n')}</contents>`,
    ),
    schema: z.object({
      learnings: z
        .array(z.string())
        .describe(`List of learnings, max of ${numLearnings}`),
      followUpQuestions: z
        .array(z.string())
        .describe(
          `List of follow-up questions to research the topic further, max of ${numFollowUpQuestions}`,
        ),
    }),
  });
  log(`Created ${res.object.learnings.length} learnings`, res.object.learnings);

  return res.object;
}

export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
}) {
  const learningsString = learnings
    .map(learning => `<learning>\n${learning}\n</learning>`)
    .join('\n');

  const res = await generateObject({
    model: getModel(),
    system: systemPrompt(),
    prompt: trimPrompt(
      `Given the following prompt from the user, write a final report on the topic using the learnings from research. Make it as as detailed as possible, aim for 3 or more pages, include ALL the learnings from research:\n\n<prompt>${prompt}</prompt>\n\nHere are all the learnings from previous research:\n\n<learnings>\n${learningsString}\n</learnings>`,
    ),
    schema: z.object({
      reportMarkdown: z
        .string()
        .describe('Final report on the topic in Markdown'),
    }),
  });

  // Append the visited URLs section to the report
  const urlsSection = `\n\n## Sources\n\n${visitedUrls.map(url => `- ${url}`).join('\n')}`;
  return res.object.reportMarkdown + urlsSection;
}

export async function writeFinalAnswer({
  prompt,
  learnings,
}: {
  prompt: string;
  learnings: string[];
}) {
  const learningsString = learnings
    .map(learning => `<learning>\n${learning}\n</learning>`)
    .join('\n');

  const res = await generateObject({
    model: getModel(),
    system: systemPrompt(),
    prompt: trimPrompt(
      `Given the following prompt from the user, write a final answer on the topic using the learnings from research. Follow the format specified in the prompt. Do not yap or babble or include any other text than the answer besides the format specified in the prompt. Keep the answer as concise as possible - usually it should be just a few words or maximum a sentence. Try to follow the format specified in the prompt (for example, if the prompt is using Latex, the answer should be in Latex. If the prompt gives multiple answer choices, the answer should be one of the choices).\n\n<prompt>${prompt}</prompt>\n\nHere are all the learnings from research on the topic that you can use to help answer the prompt:\n\n<learnings>\n${learningsString}\n</learnings>`,
    ),
    schema: z.object({
      exactAnswer: z
        .string()
        .describe(
          'The final answer, make it short and concise, just the answer, no other text',
        ),
    }),
  });

  return res.object.exactAnswer;
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  visitedUrls = [],
  onProgress,
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  visitedUrls?: string[];
  onProgress?: (progress: ResearchProgress) => void;
}): Promise<ResearchResult> {
  const provider = getValidatedSearchProvider();

  const progress: ResearchProgress = {
    currentDepth: depth,
    totalDepth: depth,
    currentBreadth: breadth,
    totalBreadth: breadth,
    totalQueries: 0,
    completedQueries: 0,
  };

  const reportProgress = (update: Partial<ResearchProgress>) => {
    Object.assign(progress, update);
    onProgress?.(progress);
  };

  const serpQueries = await generateSerpQueries({
    query,
    learnings,
    numQueries: breadth,
  });

  reportProgress({
    totalQueries: serpQueries.length,
    currentQuery: serpQueries[0]?.query,
  });

  const limit = pLimit(ConcurrencyLimit);
  log(`Using search provider: ${provider}`);

  const results = await Promise.all(
    serpQueries.map(serpQuery =>
      limit(async () => {
        try {
          const result = await runSearch(serpQuery.query);

          // Collect URLs from this search
          const newUrls = compact(result.data.map(item => item.url));
          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const newLearnings = await processSerpResult({
            query: serpQuery.query,
            result,
            numFollowUpQuestions: newBreadth,
          });
          const allLearnings = [...learnings, ...newLearnings.learnings];
          const allUrls = [...visitedUrls, ...newUrls];

          if (newDepth > 0) {
            log(
              `Researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`,
            );

            reportProgress({
              currentDepth: newDepth,
              currentBreadth: newBreadth,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });

            const nextQuery = `
            Previous research goal: ${serpQuery.researchGoal}
            Follow-up research directions: ${newLearnings.followUpQuestions.map(q => `\n${q}`).join('')}
          `.trim();

            return deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              visitedUrls: allUrls,
              onProgress,
            });
          } else {
            reportProgress({
              currentDepth: 0,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });
            return {
              learnings: allLearnings,
              visitedUrls: allUrls,
            };
          }
        } catch (e: any) {
          if (e.message && e.message.includes('Timeout')) {
            log(`Timeout error running query: ${serpQuery.query}: `, e);
          } else {
            log(`Error running query: ${serpQuery.query}: `, e);
          }
          return {
            learnings: [],
            visitedUrls: [],
          };
        }
      }),
    ),
  );

  return {
    learnings: [...new Set(results.flatMap(r => r.learnings))],
    visitedUrls: [...new Set(results.flatMap(r => r.visitedUrls))],
  };
}
