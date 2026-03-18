#!/usr/bin/env npx tsx
/**
 * n8n.ts — n8n REST API client + n8n.io template search
 *
 * Replaces the n8n MCP server. One script, all operations.
 *
 * CLI:  npx tsx n8n.ts <domain>.<action> '{"param":"value"}'
 * Code: import { n8n } from "./n8n"; await n8n("workflows.list", {});
 *
 * Auth: N8N_API_KEY in .env
 * Host: N8N_API_URL in .env (default: https://n8n.tutero.dev)
 */

import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolve, join } from 'path';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ─── Load .env ─────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const envPath = resolve(import.meta.dirname ?? __dirname, '.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {}
}
loadEnv();

// ─── Config ────────────────────────────────────────────────────────────

const API_URL = (process.env.N8N_API_URL ?? 'https://n8n.tutero.dev').replace(/\/$/, '');
const API_KEY = process.env.N8N_API_KEY;
const TEMPLATE_API = 'https://api.n8n.io/api/templates';

// ─── HTTP ──────────────────────────────────────────────────────────────

async function http<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, unknown>,
): Promise<T> {
  if (!API_KEY) throw new Error('N8N_API_KEY not set');

  const url = new URL(`${API_URL}/api/v1${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      'X-N8N-API-KEY': API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);

  try { return JSON.parse(text) as T; }
  catch { return text as T; }
}

/** Unauthenticated call to n8n.io public template API */
async function templateApi<T = unknown>(
  path: string,
  query?: Record<string, unknown>,
): Promise<T> {
  const url = new URL(`${TEMPLATE_API}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  try { return JSON.parse(text) as T; }
  catch { return text as T; }
}

// ─── Route Table ───────────────────────────────────────────────────────

type Handler = (p: Record<string, any>) => Promise<unknown>;

const routes: Record<string, Handler> = {

  // ── Health ──
  'health': async () => http('GET', '/'),

  // ── Workflows ──
  'workflows.list':       async (p) => http('GET', '/workflows', undefined, { limit: p.limit, cursor: p.cursor, active: p.active, tags: p.tags }),
  'workflows.get':        async (p) => http('GET', `/workflows/${p.id}`),
  'workflows.create':     async (p) => http('POST', '/workflows', p),
  'workflows.update':     async (p) => { const { id, ...body } = p; return http('PUT', `/workflows/${id}`, body); },
  'workflows.delete':     async (p) => http('DELETE', `/workflows/${p.id}`),
  'workflows.activate':   async (p) => http('POST', `/workflows/${p.id}/activate`),
  'workflows.deactivate': async (p) => http('POST', `/workflows/${p.id}/deactivate`),
  'workflows.transfer':   async (p) => http('PUT', `/workflows/${p.id}/transfer`, { destinationProjectId: p.projectId }),

  // ── Executions ──
  'executions.list':   async (p) => http('GET', '/executions', undefined, { workflowId: p.workflowId, status: p.status, limit: p.limit, cursor: p.cursor }),
  'executions.get':    async (p) => http('GET', `/executions/${p.id}`, undefined, { includeData: p.includeData }),
  'executions.delete': async (p) => http('DELETE', `/executions/${p.id}`),

  // ── Webhook trigger ──
  'workflows.trigger': async (p) => {
    const { id, path, method, data, headers: hdrs } = p;
    // Resolve the webhook URL: either by explicit path or by fetching the workflow
    let webhookPath = path;
    if (!webhookPath) {
      const wf: any = await http('GET', `/workflows/${id}`);
      const trigger = wf.nodes?.find((n: any) =>
        n.type === 'n8n-nodes-base.webhook' ||
        n.type === 'n8n-nodes-base.formTrigger' ||
        n.type === '@n8n/n8n-nodes-langchain.chatTrigger'
      );
      if (!trigger) throw new Error('No webhook/form/chat trigger found in workflow');
      webhookPath = trigger.parameters?.path;
      if (!webhookPath) throw new Error('Trigger node has no path configured');
    }
    const url = `${API_URL}/webhook/${webhookPath}`;
    const res = await fetch(url, {
      method: method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...hdrs },
      body: data ? JSON.stringify(data) : undefined,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  },

  // ── Test webhook (uses /webhook-test/ path for inactive workflows) ──
  'workflows.test': async (p) => {
    const { id, path, method, data, headers: hdrs } = p;
    let webhookPath = path;
    if (!webhookPath) {
      const wf: any = await http('GET', `/workflows/${id}`);
      const trigger = wf.nodes?.find((n: any) =>
        n.type === 'n8n-nodes-base.webhook' ||
        n.type === 'n8n-nodes-base.formTrigger'
      );
      webhookPath = trigger?.parameters?.path;
      if (!webhookPath) throw new Error('No webhook trigger with path found');
    }
    const url = `${API_URL}/webhook-test/${webhookPath}`;
    const res = await fetch(url, {
      method: method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...hdrs },
      body: data ? JSON.stringify(data) : undefined,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  },

  // ── Credentials ──
  'credentials.list':   async (p) => http('GET', '/credentials', undefined, { limit: p.limit, cursor: p.cursor }),
  'credentials.create': async (p) => http('POST', '/credentials', p),
  'credentials.delete': async (p) => http('DELETE', `/credentials/${p.id}`),

  // ── Tags ──
  'tags.list':   async (p) => http('GET', '/tags', undefined, { limit: p.limit, cursor: p.cursor }),
  'tags.create': async (p) => http('POST', '/tags', p),

  // ── Templates (n8n.io public API — no auth needed) ──
  'templates.search': async (p) => templateApi('/search', { rows: p.limit ?? 20, search: p.query, category: p.category }),
  'templates.get':    async (p) => templateApi(`/${p.templateId}`),
  'templates.deploy': async (p) => {
    // Fetch template → create workflow on instance
    const tmpl: any = await templateApi(`/${p.templateId}`);
    const wf = tmpl.workflow ?? tmpl;
    return http('POST', '/workflows', {
      name: p.name ?? wf.name ?? `Template ${p.templateId}`,
      nodes: wf.nodes,
      connections: wf.connections,
      settings: wf.settings,
    });
  },
};

// ─── Exported function (for use as a module) ───────────────────────────

export async function n8n(route: string, params: Record<string, any> = {}): Promise<unknown> {
  const handler = routes[route];
  if (!handler) {
    const available = Object.keys(routes).sort().join('\n  ');
    throw new Error(`Unknown route: ${route}\n\nAvailable:\n  ${available}`);
  }
  return handler(params);
}

// ─── Cache ──────────────────────────────────────────────────────────────

interface CacheEntry<T> { data: T; ts: number; }

const cache = {
  executions: new Map<string, CacheEntry<any>>(),   // forever
  workflows:  new Map<string, CacheEntry<any>>(),   // 30s TTL
  stats:      new Map<string, CacheEntry<any>>(),   // 60s TTL
  schemas:    new Map<string, CacheEntry<any>>(),   // 120s TTL
};

function cacheGet<T>(store: Map<string, CacheEntry<T>>, key: string, ttl: number): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (ttl > 0 && Date.now() - entry.ts > ttl) { store.delete(key); return null; }
  return entry.data;
}

function cacheSet<T>(store: Map<string, CacheEntry<T>>, key: string, data: T) {
  store.set(key, { data, ts: Date.now() });
}

// ─── Deep Search ────────────────────────────────────────────────────────

interface SearchMatch {
  nodeName: string; nodeType: string; direction: 'input' | 'output';
  itemIndex: number; fieldPath: string; value: string; context: string;
}

function deepSearchValue(obj: unknown, path: string, term: string, matches: Omit<SearchMatch, 'nodeName' | 'nodeType' | 'direction' | 'itemIndex'>[]): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      deepSearchValue(v, path ? `${path}.${k}` : k, term, matches);
    }
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => deepSearchValue(v, `${path}[${i}]`, term, matches));
  } else {
    const str = String(obj);
    const lower = str.toLowerCase();
    const idx = lower.indexOf(term);
    if (idx !== -1) {
      const start = Math.max(0, idx - 30);
      const end = Math.min(str.length, idx + term.length + 30);
      const before = (start > 0 ? '...' : '') + str.slice(start, idx);
      const matched = str.slice(idx, idx + term.length);
      const after = str.slice(idx + term.length, end) + (end < str.length ? '...' : '');
      matches.push({ fieldPath: path, value: str, context: `${before}<<${matched}>>${after}` });
    }
  }
}

function searchExecution(exec: any, term: string): SearchMatch[] {
  const results: SearchMatch[] = [];
  const runData = exec?.data?.resultData?.runData;
  if (!runData) return results;
  for (const [nodeName, runs] of Object.entries(runData as Record<string, any[]>)) {
    for (const run of runs) {
      const nodeType = run.executionData?.nodeType ?? '';
      // Search output data
      const mainOutputs: any[][] = run.data?.main ?? [];
      for (const branch of mainOutputs) {
        if (!branch) continue;
        branch.forEach((item: any, itemIndex: number) => {
          const fieldMatches: Omit<SearchMatch, 'nodeName' | 'nodeType' | 'direction' | 'itemIndex'>[] = [];
          deepSearchValue(item?.json, 'json', term, fieldMatches);
          for (const m of fieldMatches) {
            results.push({ nodeName, nodeType, direction: 'output', itemIndex, ...m });
          }
        });
      }
      // Search input data
      const mainInputs: any[][] = run.inputData?.main ?? [];
      for (const branch of mainInputs) {
        if (!branch) continue;
        branch.forEach((item: any, itemIndex: number) => {
          const fieldMatches: Omit<SearchMatch, 'nodeName' | 'nodeType' | 'direction' | 'itemIndex'>[] = [];
          deepSearchValue(item?.json, 'json', term, fieldMatches);
          for (const m of fieldMatches) {
            results.push({ nodeName, nodeType, direction: 'input', itemIndex, ...m });
          }
        });
      }
    }
  }
  return results;
}

// ─── Error Extraction ───────────────────────────────────────────────────

function extractErrorMessage(exec: any): string {
  // Try resultData.error first
  const topError = exec?.data?.resultData?.error;
  if (topError?.message) return topError.message;
  // Try to find the first node that errored
  const runData = exec?.data?.resultData?.runData;
  if (runData) {
    for (const [nodeName, runs] of Object.entries(runData as Record<string, any[]>)) {
      for (const run of runs) {
        if (run.error?.message) return `${nodeName}: ${run.error.message}`;
      }
    }
  }
  return 'Execution failed';
}

// ─── Schema Inference ───────────────────────────────────────────────────

interface FieldInfo { path: string; types: Map<string, number>; count: number; example: unknown; }

function collectFields(obj: unknown, path: string, fields: Map<string, FieldInfo>): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const fp = path ? `${path}.${k}` : k;
      collectFields(v, fp, fields);
    }
  } else if (Array.isArray(obj)) {
    const fp = `${path}[]`;
    let info = fields.get(fp);
    if (!info) { info = { path: fp, types: new Map(), count: 0, example: null }; fields.set(fp, info); }
    info.count++;
    info.types.set('array', (info.types.get('array') ?? 0) + 1);
    if (!info.example) info.example = `[${obj.length} items]`;
    obj.forEach((v, i) => collectFields(v, `${path}[${i}]`, fields));
  } else {
    const t = typeof obj;
    let info = fields.get(path);
    if (!info) { info = { path, types: new Map(), count: 0, example: null }; fields.set(path, info); }
    info.count++;
    info.types.set(t, (info.types.get(t) ?? 0) + 1);
    if (!info.example) info.example = obj;
  }
}

async function inferSchema(workflowId: string, sampleSize: number) {
  const wf: any = await n8n('workflows.get', { id: workflowId });
  const execList: any = await n8n('executions.list', { workflowId, limit: sampleSize });
  const executions = execList.data ?? execList;

  const nodeFields = new Map<string, { nodeType: string; samples: Map<string, FieldInfo>[] }>();

  for (const execSummary of executions) {
    let exec: any = cacheGet(cache.executions, String(execSummary.id), 0);
    if (!exec) {
      exec = await n8n('executions.get', { id: execSummary.id, includeData: true });
      cacheSet(cache.executions, String(execSummary.id), exec);
    }
    const runData = exec?.data?.resultData?.runData;
    if (!runData) continue;
    for (const [nodeName, runs] of Object.entries(runData as Record<string, any[]>)) {
      if (!nodeFields.has(nodeName)) {
        const nodeType = runs[0]?.executionData?.nodeType ?? '';
        nodeFields.set(nodeName, { nodeType, samples: [] });
      }
      const entry = nodeFields.get(nodeName)!;
      const fields = new Map<string, FieldInfo>();
      for (const run of runs) {
        const mainOutputs: any[][] = run.data?.main ?? [];
        for (const branch of mainOutputs) {
          if (!branch) continue;
          for (const item of branch) {
            collectFields(item?.json, 'json', fields);
          }
        }
      }
      entry.samples.push(fields);
    }
  }

  const totalSamples = executions.length;
  const nodes = Array.from(nodeFields.entries()).map(([nodeName, { nodeType, samples }]) => {
    const allPaths = new Set<string>();
    for (const s of samples) for (const k of s.keys()) allPaths.add(k);

    const outputShape = Array.from(allPaths).map(path => {
      let freq = 0; let example: unknown = null;
      const types = new Map<string, number>();
      for (const s of samples) {
        const info = s.get(path);
        if (info) {
          freq++;
          if (!example) example = info.example;
          for (const [t, c] of info.types) types.set(t, (types.get(t) ?? 0) + c);
        }
      }
      const typeStr = Array.from(types.entries()).sort((a, b) => b[1] - a[1]).map(([t, c]) => types.size > 1 ? `${t}(${c})` : t).join(', ');
      return { path, type: typeStr, frequency: samples.length > 0 ? freq / samples.length : 0, example: example != null ? String(example).slice(0, 100) : null };
    }).sort((a, b) => b.frequency - a.frequency);

    const avgFreq = outputShape.length > 0 ? outputShape.reduce((s, f) => s + f.frequency, 0) / outputShape.length : 1;
    const drift = outputShape
      .filter(f => f.frequency < 1 || f.type.includes(','))
      .map(f => ({
        field: f.path,
        description: f.frequency < 1
          ? `Not present in ${Math.round((1 - f.frequency) * samples.length)} of ${samples.length} recent runs`
          : `Multiple types: ${f.type}`
      }));

    return { nodeName, nodeType, outputShape, consistency: Math.round(avgFreq * 100) / 100, drift };
  });

  return { workflowId, workflowName: wf.name, sampleSize: totalSamples, nodes };
}

// ─── Stats ──────────────────────────────────────────────────────────────

async function computeStats(workflowId?: string) {
  let workflows: any[];
  if (workflowId) {
    const wf = await n8n('workflows.get', { id: workflowId });
    workflows = [wf];
  } else {
    const res: any = await n8n('workflows.list', { limit: 250 });
    workflows = res.data ?? res;
  }

  const result = [];
  for (const wf of workflows) {
    const execRes: any = await n8n('executions.list', { workflowId: wf.id, limit: 100 });
    const execs: any[] = execRes.data ?? execRes;

    let successCount = 0, errorCount = 0;
    let lastExec: any = null;
    const recentErrors: any[] = [];

    for (const ex of execs) {
      if (!lastExec) lastExec = ex;
      if (ex.status === 'success') successCount++;
      else if (ex.status === 'error' || ex.status === 'crashed') {
        errorCount++;
        if (recentErrors.length < 5) {
          recentErrors.push({
            id: ex.id,
            startedAt: ex.startedAt,
            errorMessage: ex.data?.resultData?.error?.message ?? ex.stoppedAt ? 'Execution failed' : 'Unknown error',
          });
        }
      }
    }

    const total = successCount + errorCount;
    result.push({
      id: wf.id, name: wf.name, active: wf.active,
      totalExecutions: total, successCount, errorCount,
      errorRate: total > 0 ? Math.round((errorCount / total) * 1000) / 10 : 0,
      lastExecution: lastExec ? { id: lastExec.id, status: lastExec.status, startedAt: lastExec.startedAt } : null,
      recentErrors,
    });
  }

  return { workflows: result };
}

// ─── Chat: Session Store ─────────────────────────────────────────────────

interface ChatSession {
  workflowId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  createdAt: number;
  lastUsedAt: number;
}

const chatSessions = new Map<string, ChatSession>();

function cleanSessions() {
  const now = Date.now();
  for (const [id, s] of chatSessions) {
    if (now - s.lastUsedAt > 3600_000) chatSessions.delete(id);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 50_000) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function buildChatContext(workflowId: string, executionId?: string): Promise<string> {
  // Fetch workflow
  const wfKey = `wf_${workflowId}`;
  let wf: any = cacheGet(cache.workflows, wfKey, 30_000);
  if (!wf) { wf = await n8n('workflows.get', { id: workflowId }); cacheSet(cache.workflows, wfKey, wf); }

  // Nodes summary (cap at 30)
  const nodes: any[] = (wf.nodes ?? []).slice(0, 30);
  const nodeLines = nodes.map((n: any) => `- ${n.name} (${n.type})`).join('\n');

  // Connections summary
  const conns: string[] = [];
  if (wf.connections) {
    for (const [src, targets] of Object.entries(wf.connections as Record<string, any>)) {
      const main = (targets as any)?.main;
      if (!main) continue;
      for (const branch of main) {
        if (!branch) continue;
        for (const conn of branch) {
          conns.push(`${src} → ${conn.node}`);
        }
      }
    }
  }

  // Stats
  let statsSection = '';
  try {
    const cacheKey = workflowId;
    let stats: any = cacheGet(cache.stats, cacheKey, 60_000);
    if (!stats) { stats = await computeStats(workflowId); cacheSet(cache.stats, cacheKey, stats); }
    const s = stats.workflows?.[0];
    if (s) {
      statsSection = `\n### Execution Stats (last ${s.totalExecutions} runs):\n- ${s.successCount} success, ${s.errorCount} errors (${s.errorRate}% error rate)`;
      if (s.recentErrors?.length) {
        statsSection += '\n- Recent errors:';
        for (const e of s.recentErrors.slice(0, 5)) {
          const msg = (e.errorMessage ?? 'Unknown').slice(0, 200);
          const date = e.startedAt ? e.startedAt.slice(0, 10) : '?';
          statsSection += `\n  - ${date}: ${msg}`;
        }
      }
    }
  } catch {}

  // Execution-specific context (from cache — already fetched by the debug UI)
  let execSection = '';
  if (executionId) {
    try {
      let exec: any = cacheGet(cache.executions, executionId, 0);
      if (!exec) {
        exec = await n8n('executions.get', { id: executionId, includeData: true });
        cacheSet(cache.executions, executionId, exec);
      }
      const status = exec.status ?? 'unknown';
      const started = exec.startedAt ? exec.startedAt.slice(0, 19).replace('T', ' ') : '?';
      execSection = `\n### Selected Execution #${executionId} (${status}, ${started})`;

      if (exec.data?.resultData?.error) {
        execSection += `\n**Top-level Error:** ${exec.data.resultData.error.message?.slice(0, 500)}`;
        if (exec.data.resultData.error.stack) {
          execSection += `\n\`\`\`\n${exec.data.resultData.error.stack.slice(0, 500)}\n\`\`\``;
        }
      }

      const runData = exec.data?.resultData?.runData;
      if (runData) {
        execSection += '\n\n**Node Results:**';
        for (const [nodeName, runs] of Object.entries(runData as Record<string, any[]>)) {
          for (const run of runs) {
            const nodeStatus = run.error ? 'ERROR' : 'success';
            execSection += `\n- ${nodeName}: ${nodeStatus}`;
            if (run.error?.message) execSection += ` — ${run.error.message.slice(0, 300)}`;
            // Output summary: first item's top-level keys
            const mainOutputs: any[][] = run.data?.main ?? [];
            for (const branch of mainOutputs) {
              if (!branch?.length) continue;
              const firstItem = branch[0]?.json;
              if (firstItem && typeof firstItem === 'object') {
                const keys = Object.keys(firstItem).slice(0, 15);
                execSection += `\n  Output keys: ${keys.join(', ')}`;
                // Include small values for context
                for (const k of keys.slice(0, 5)) {
                  const v = firstItem[k];
                  if (v !== null && v !== undefined && typeof v !== 'object') {
                    const s = String(v);
                    if (s.length <= 100) execSection += `\n  ${k}: ${s}`;
                  }
                }
              }
            }
            // Input summary for error nodes
            if (run.error) {
              const mainInputs: any[][] = run.inputData?.main ?? [];
              for (const branch of mainInputs) {
                if (!branch?.length) continue;
                const firstItem = branch[0]?.json;
                if (firstItem && typeof firstItem === 'object') {
                  const keys = Object.keys(firstItem).slice(0, 10);
                  execSection += `\n  Input keys: ${keys.join(', ')}`;
                }
              }
            }
          }
        }
      }
    } catch (e: any) {
      execSection = `\n### Selected Execution #${executionId}\n(Could not load details: ${e.message})`;
    }
  }

  return `## Workflow: "${wf.name}" (ID: ${workflowId}, ${wf.active ? 'active' : 'inactive'})

### Nodes:
${nodeLines}
${conns.length ? '\n### Connections:\n' + conns.join('\n') : ''}
${statsSection}
${execSection}

n8n instance: ${API_URL}
CLI: \`npx tsx n8n.ts <route> '{...}'\` (routes: workflows.get, workflows.update, workflows.activate, workflows.deactivate, executions.list, executions.get)`;
}

// ─── HTTP Server ────────────────────────────────────────────────────────

function parseUrl(url: string): { pathname: string; params: URLSearchParams } {
  const u = new URL(url, 'http://localhost');
  return { pathname: u.pathname, params: u.searchParams };
}

function jsonResponse(res: ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pathParts = pathname.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) return null;
  }
  return params;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const { pathname, params } = parseUrl(req.url ?? '/');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    // ── API: Open chat in Terminal ──
    if (pathname === '/api/chat/terminal' && req.method === 'GET') {
      const workflowId = params.get('workflowId');
      if (!workflowId) return jsonResponse(res, { error: 'Missing workflowId' }, 400);
      const executionId = params.get('executionId') || undefined;
      const context = await buildChatContext(workflowId, executionId);
      // Write context to a temp file, then open Terminal with claude -p reading from it
      const tmpFile = join(import.meta.dirname ?? __dirname, `.chat-context-${workflowId}.tmp`);
      const { writeFileSync } = await import('fs');
      writeFileSync(tmpFile, context);
      const cwd = import.meta.dirname ?? __dirname;
      // Write a launcher script that starts claude with context
      const escapedTmp = tmpFile.replace(/'/g, "'\\''");
      const wfName = (await n8n('workflows.get', { id: workflowId }) as any).name ?? `Workflow ${workflowId}`;
      const sessionName = `debug: ${wfName}`.replace(/'/g, "'\\''");
      const launchScript = tmpFile.replace('.tmp', '.sh');
      const { writeFileSync: writeSync, existsSync, chmodSync } = await import('fs');
      writeSync(launchScript, `#!/bin/zsh\ncd '${cwd.replace(/'/g, "'\\''")}'\nexec claude --append-system-prompt "$(cat '${escapedTmp}')" --name '${sessionName}' --verbose\n`);
      chmodSync(launchScript, 0o755);

      // Ghostty preferred, Terminal.app fallback
      const hasGhostty = existsSync('/Applications/Ghostty.app');
      if (hasGhostty) {
        spawn('open', ['-a', 'Ghostty', '--args', '-e', launchScript], { detached: true, stdio: 'ignore' }).unref();
      } else {
        const script = `tell application "Terminal"\n  activate\n  do script "${launchScript.replace(/"/g, '\\"')}"\nend tell`;
        spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
      }
      return jsonResponse(res, { launched: true });
    }

    // ── API: Chat (Claude CLI streaming) ──
    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { workflowId, sessionId: inSessionId, message, executionId } = body;
      if (!workflowId || !message) return jsonResponse(res, { error: 'Missing workflowId or message' }, 400);

      // Session management
      cleanSessions();
      let sessionId = inSessionId;
      let session = sessionId ? chatSessions.get(sessionId) : undefined;
      if (!session || session.workflowId !== workflowId) {
        sessionId = randomUUID();
        session = { workflowId, messages: [], createdAt: Date.now(), lastUsedAt: Date.now() };
        chatSessions.set(sessionId, session);
      }
      session.lastUsedAt = Date.now();

      // Cap conversation history at 20 message pairs
      if (session.messages.length >= 40) {
        session.messages = session.messages.slice(-38);
      }
      session.messages.push({ role: 'user', content: message });

      // Build context (uses cached data — no extra n8n API calls)
      const context = await buildChatContext(workflowId, executionId);

      // Prepend context to the first message so Claude sees it as data, not instruction
      let fullPrompt = '';
      if (session.messages.length > 1) {
        for (const m of session.messages.slice(0, -1)) {
          fullPrompt += m.role === 'user' ? `User: ${m.content}\n\n` : `Assistant: ${m.content}\n\n`;
        }
        fullPrompt += `User: ${message}`;
      } else {
        fullPrompt = `Here is context about the n8n workflow I'm looking at:\n\n${context}\n\n---\n\n${message}`;
      }

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send('session', { sessionId });

      // Spawn claude CLI — no system prompt, context is in the message
      const claude = spawn('claude', [
        '-p', fullPrompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let assistantText = '';
      let aborted = false;

      req.on('close', () => {
        aborted = true;
        claude.kill();
      });

      let buffer = '';
      let currentToolInput = '';
      let currentToolName = '';
      let inToolInput = false;

      claude.stdout.on('data', (chunk: Buffer) => {
        if (aborted) return;
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            // Streaming deltas: {"type":"stream_event","event":{"type":"content_block_delta",...}}
            if (obj.type === 'stream_event' && obj.event?.type === 'content_block_delta') {
              const text = obj.event.delta?.text;
              if (text) {
                assistantText += text;
                send('delta', { text });
              }
              // Accumulate tool input JSON delta
              const inputDelta = obj.event.delta?.partial_json;
              if (inputDelta && inToolInput) {
                currentToolInput += inputDelta;
              }
            }
            // Surface tool use so the UI can show what Claude is doing
            else if (obj.type === 'stream_event' && obj.event?.type === 'content_block_start' && obj.event.content_block?.type === 'tool_use') {
              currentToolName = obj.event.content_block.name;
              currentToolInput = '';
              inToolInput = true;
              send('tool', { name: currentToolName });
            }
            else if (obj.type === 'stream_event' && obj.event?.type === 'content_block_stop') {
              if (inToolInput) {
                // Parse the accumulated tool input and send a summary
                let inputSummary = '';
                try {
                  const parsed = JSON.parse(currentToolInput);
                  // Show the most useful field depending on tool
                  if (currentToolName === 'Bash') inputSummary = parsed.command || '';
                  else if (currentToolName === 'Read') inputSummary = parsed.file_path || '';
                  else if (currentToolName === 'Edit') inputSummary = parsed.file_path || '';
                  else if (currentToolName === 'Write') inputSummary = parsed.file_path || '';
                  else if (currentToolName === 'Grep') inputSummary = parsed.pattern || '';
                  else if (currentToolName === 'Glob') inputSummary = parsed.pattern || '';
                  else if (currentToolName === 'WebFetch') inputSummary = parsed.url || '';
                  else inputSummary = Object.values(parsed).filter(v => typeof v === 'string').slice(0, 1).join('') || '';
                } catch {}
                if (inputSummary) send('tool_input', { input: inputSummary.slice(0, 120) });
                send('tool_done', { name: currentToolName });
                inToolInput = false;
                currentToolInput = '';
                currentToolName = '';
              }
            }
            // Final result (fallback if no deltas were captured)
            else if (obj.type === 'result' && obj.result && !assistantText) {
              assistantText = obj.result;
              send('delta', { text: obj.result });
            }
          } catch {}
        }
      });

      claude.stderr.on('data', (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) console.error('[chat stderr]', msg);
      });

      claude.on('close', () => {
        // Flush remaining buffer
        if (buffer.trim()) {
          try {
            const obj = JSON.parse(buffer);
            if (obj.type === 'stream_event' && obj.event?.type === 'content_block_delta') {
              const text = obj.event.delta?.text;
              if (text) { assistantText += text; send('delta', { text }); }
            } else if (obj.type === 'result' && obj.result && !assistantText) {
              assistantText = obj.result;
              send('delta', { text: obj.result });
            }
          } catch {}
        }
        if (assistantText) {
          session!.messages.push({ role: 'assistant', content: assistantText });
        }
        send('done', {});
        res.end();
      });

      return;
    }

    // Serve UI
    if (pathname === '/' || pathname === '/index.html') {
      const html = await readFile(join(import.meta.dirname ?? __dirname, 'debug-ui.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    // ── API: Workflows ──
    if (pathname === '/api/workflows') {
      let cached = cacheGet(cache.workflows, '_all', 30_000);
      if (!cached) {
        cached = await n8n('workflows.list', { limit: params.get('limit') ?? 250 });
        cacheSet(cache.workflows, '_all', cached);
      }
      return jsonResponse(res, cached);
    }

    let m: Record<string, string> | null;

    if ((m = matchRoute(pathname, '/api/workflows/:id'))) {
      const key = `wf_${m.id}`;
      let cached = cacheGet(cache.workflows, key, 30_000);
      if (!cached) {
        cached = await n8n('workflows.get', { id: m.id });
        cacheSet(cache.workflows, key, cached);
      }
      return jsonResponse(res, cached);
    }

    // ── API: Executions (SSE streaming — sends pages as they arrive) ──
    if (pathname === '/api/executions/stream') {
      const wfId = params.get('workflowId');
      if (!wfId) return jsonResponse(res, { error: 'Missing workflowId' }, 400);
      const status = params.get('status') ?? undefined;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      let cursor: string | undefined = undefined;
      let total = 0;
      let aborted = false;
      req.on('close', () => { aborted = true; });

      while (!aborted) {
        const page: any = await n8n('executions.list', { workflowId: wfId, status, limit: 100, cursor });
        const list: any[] = page.data ?? page;
        if (!list.length) break;

        // Enrich errors with messages
        for (const ex of list) {
          if ((ex.status === 'error' || ex.status === 'crashed') && !ex.errorMessage) {
            try {
              const key = String(ex.id);
              let full = cacheGet(cache.executions, key, 0);
              if (!full) {
                full = await n8n('executions.get', { id: ex.id, includeData: true });
                cacheSet(cache.executions, key, full);
              }
              ex.errorMessage = extractErrorMessage(full);
            } catch {}
          }
        }

        total += list.length;
        send('page', { executions: list, total });

        cursor = page.nextCursor ?? undefined;
        if (!cursor) break;
      }

      send('done', { total });
      res.end();
      return;
    }

    // ── API: Executions (enriched with error messages) ──
    if (pathname === '/api/executions') {
      const wfId = params.get('workflowId') ?? undefined;
      const status = params.get('status') ?? undefined;
      const limit = params.get('limit') ?? 20;
      const cursorParam = params.get('cursor') ?? undefined;
      const all = params.get('all') === 'true';

      if (all && wfId) {
        // Fetch ALL executions across all pages
        const allExecs: any[] = [];
        let c: string | undefined = undefined;
        while (true) {
          const page: any = await n8n('executions.list', { workflowId: wfId, status, limit: 100, cursor: c });
          const list: any[] = page.data ?? page;
          if (!list.length) break;
          // Enrich with error messages
          for (const ex of list) {
            if ((ex.status === 'error' || ex.status === 'crashed') && !ex.errorMessage) {
              try {
                const key = String(ex.id);
                let full = cacheGet(cache.executions, key, 0);
                if (!full) {
                  full = await n8n('executions.get', { id: ex.id, includeData: true });
                  cacheSet(cache.executions, key, full);
                }
                ex.errorMessage = extractErrorMessage(full);
              } catch {}
            }
          }
          allExecs.push(...list);
          c = page.nextCursor ?? undefined;
          if (!c) break;
        }
        return jsonResponse(res, { data: allExecs });
      }

      const data: any = await n8n('executions.list', { workflowId: wfId, status, limit, cursor: cursorParam });
      const execs: any[] = data.data ?? data;
      // Enrich error executions with error messages
      for (const ex of execs) {
        if ((ex.status === 'error' || ex.status === 'crashed') && !ex.errorMessage) {
          try {
            const key = String(ex.id);
            let full = cacheGet(cache.executions, key, 0);
            if (!full) {
              full = await n8n('executions.get', { id: ex.id, includeData: true });
              cacheSet(cache.executions, key, full);
            }
            ex.errorMessage = extractErrorMessage(full);
          } catch {}
        }
      }
      return jsonResponse(res, data);
    }

    if ((m = matchRoute(pathname, '/api/executions/:id'))) {
      const key = m.id;
      let cached = cacheGet(cache.executions, key, 0);
      if (!cached) {
        cached = await n8n('executions.get', { id: m.id, includeData: true });
        cacheSet(cache.executions, key, cached);
      }
      return jsonResponse(res, cached);
    }

    // ── API: Search (SSE — streams results as they're found) ──
    if (pathname === '/api/search') {
      const q = params.get('q');
      const wfId = params.get('workflowId');

      if (!q) return jsonResponse(res, { error: 'Missing q parameter' }, 400);
      if (!wfId) return jsonResponse(res, { error: 'Missing workflowId parameter' }, 400);

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const term = q.toLowerCase();
      let scanned = 0;
      let totalMatches = 0;
      let cursor: string | undefined = undefined;
      let aborted = false;

      req.on('close', () => { aborted = true; });

      // Paginate through ALL executions, streaming results
      while (!aborted) {
        const execRes: any = await n8n('executions.list', { workflowId: wfId, limit: 100, cursor });
        const execList: any[] = execRes.data ?? execRes;
        if (!execList.length) break;

        for (const execSummary of execList) {
          if (aborted) break;
          const key = String(execSummary.id);
          let exec = cacheGet(cache.executions, key, 0);
          if (!exec) {
            exec = await n8n('executions.get', { id: execSummary.id, includeData: true });
            cacheSet(cache.executions, key, exec);
          }
          scanned++;
          const matches = searchExecution(exec, term);
          if (matches.length > 0) {
            totalMatches += matches.length;
            send('result', {
              executionId: execSummary.id,
              status: exec.status ?? execSummary.status,
              startedAt: exec.startedAt ?? execSummary.startedAt,
              stoppedAt: exec.stoppedAt ?? execSummary.stoppedAt,
              matches,
            });
          }
          // Send progress every 5 executions
          if (scanned % 5 === 0) {
            send('progress', { scanned, totalMatches });
          }
        }

        cursor = execRes.nextCursor ?? undefined;
        if (!cursor) break;
      }

      send('done', { scanned, totalMatches });
      res.end();
      return;
    }

    // ── API: Stats ──
    if (pathname === '/api/stats') {
      const wfId = params.get('workflowId') ?? undefined;
      const cacheKey = wfId ?? '_all';
      let cached = cacheGet(cache.stats, cacheKey, 60_000);
      if (!cached) {
        cached = await computeStats(wfId);
        cacheSet(cache.stats, cacheKey, cached);
      }
      return jsonResponse(res, cached);
    }

    // ── API: Schema ──
    if (pathname === '/api/schema') {
      const wfId = params.get('workflowId');
      if (!wfId) return jsonResponse(res, { error: 'Missing workflowId parameter' }, 400);
      const sampleSize = parseInt(params.get('sampleSize') ?? '10');
      const cacheKey = `${wfId}_${sampleSize}`;
      let cached = cacheGet(cache.schemas, cacheKey, 120_000);
      if (!cached) {
        cached = await inferSchema(wfId, sampleSize);
        cacheSet(cache.schemas, cacheKey, cached);
      }
      return jsonResponse(res, cached);
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (err: any) {
    console.error(`[${pathname}]`, err.message);
    jsonResponse(res, { error: err.message }, 500);
  }
}

async function startServer(port = 3333) {
  const server = createServer(handleRequest);
  server.listen(port, () => {
    console.log(`n8n Debug UI → http://localhost:${port}`);
    console.log(`n8n instance → ${API_URL}`);
  });
}

// ─── CLI ───────────────────────────────────────────────────────────────

async function main() {
  const [route, paramsJson] = process.argv.slice(2);

  if (route === 'serve') {
    const port = paramsJson ? parseInt(paramsJson) : 3333;
    return startServer(port);
  }

  if (!route || route === '--help') {
    console.log(`Usage: npx tsx n8n.ts <domain>.<action> '{"param":"value"}'`);
    console.log(`       npx tsx n8n.ts serve [port]`);
    console.log(`\nRoutes:\n  ${Object.keys(routes).sort().join('\n  ')}`);
    process.exit(0);
  }

  const params = paramsJson ? JSON.parse(paramsJson) : {};
  const result = await n8n(route, params);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
