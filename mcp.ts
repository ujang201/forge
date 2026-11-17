// Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP.
// Speaks the modern revision 2026-07-28 (server/discover, no handshake) and
// the legacy handshake (initialize + notifications/initialized) for older clients.
// Tools act on the same store as REST.

import type { Store } from './store.ts';

export interface McpCtx {
  store: Store;
  viewer: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the viewer)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0];
      if (repo === '') repo = parts[1];
    }
  }
  return { owner, repo };
}

function toolResult(data: unknown): Record<string, unknown> {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(ctx: McpCtx, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const def = TOOLS.find((t) => t.name.replace(/[^a-z0-9]/g, '') === norm || t.name.replace(/[^a-z0-9]/g, '').endsWith(norm) || norm.endsWith(t.name.replace(/[^a-z0-9]/g, '')));
  if (def === undefined) return { error: { code: -32602, message: `unknown tool ${name}` } };
  for (const req of def.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return { result: toolError(`missing required argument: ${req}`) };
    }
  }
  const { store, viewer } = ctx;
  switch (def.name) {
    case 'create_repo': {
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : viewer;
      const repoName = String(args.name);
      const created = store.createRepo(owner, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (created === null) return { result: toolError(`repository ${owner}/${repoName} already exists`) };
      return { result: toolResult({ id: created.id, name: created.name, full_name: `${owner}/${repoName}`, owner, private: created.private, default_branch: created.defaultBranch }) };
    }
    case 'get_repo': {
      const { owner, repo } = splitFullName(args);
      const found = store.getRepo(owner, repo);
      if (found === undefined) return { result: toolError(`repository ${owner}/${repo} not found`) };
      return { result: toolResult({ id: found.id, name: found.name, full_name: `${owner}/${repo}`, owner, private: found.private, default_branch: found.defaultBranch, description: found.description }) };
    }
    case 'create_issue': {
      const { owner, repo } = splitFullName(args);
      const found = store.getRepo(owner, repo);
      if (found === undefined) return { result: toolError(`repository ${owner}/${repo} not found`) };
      const issue = store.createIssue(found, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return { result: toolResult({ id: issue.id, number: issue.number, title: issue.title, state: issue.state }) };
    }
    case 'list_issues': {
      const { owner, repo } = splitFullName(args);
      const found = store.getRepo(owner, repo);
      if (found === undefined) return { result: toolError(`repository ${owner}/${repo} not found`) };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = found.issues.filter((i) => state === 'all' || i.state === state);
      return { result: toolResult({ issues: list.map((i) => ({ id: i.id, number: i.number, title: i.title, state: i.state })) }) };
    }
    case 'create_pull_request': {
      const { owner, repo } = splitFullName(args);
      const found = store.getRepo(owner, repo);
      if (found === undefined) return { result: toolError(`repository ${owner}/${repo} not found`) };
      const head = String(args.head);
      const base = String(args.base);
      const headSha = found.refs.get(`refs/heads/${head}`);
      const baseSha = found.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return { result: toolError('head or base branch does not exist') };
      const files = store.diffFiles(found, baseSha, headSha);
      const pull = store.createPull(found, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, headSha, base, baseSha, files);
      return { result: toolResult({ id: pull.id, number: pull.number, pull_number: pull.number, title: pull.title, head, base, state: pull.state }) };
    }
    case 'merge_pull_request': {
      const { owner, repo } = splitFullName(args);
      const found = store.getRepo(owner, repo);
      if (found === undefined) return { result: toolError(`repository ${owner}/${repo} not found`) };
      const pull = store.getPull(found, Number(args.pull_number));
      if (pull === undefined) return { result: toolError(`pull request ${String(args.pull_number)} not found`) };
      const sha = store.squashMerge(found, pull);
      if (sha === null) return { result: toolError('Merge conflict') };
      return { result: toolResult({ merged: true, number: pull.number, pull_number: pull.number, sha, state: pull.state }) };
    }
    default:
      return { error: { code: -32602, message: `unknown tool ${name}` } };
  }
}

export interface McpOutcome {
  status: number;
  body: unknown; // JSON value, or null for no body (notification)
  headers?: Record<string, string>;
}

/**
 * Handle one POST /mcp body. `rawBody` is the exact request text (for the
 * parse-error check); `protocolVersion` is the MCP-Protocol-Version header.
 */
export function handleMcp(ctx: McpCtx, rawBody: string, protocolVersion: string | undefined): McpOutcome {
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    msg = parsed as Record<string, unknown>;
  } catch {
    // Modern transport: HTTP 400 with JSON-RPC -32700.
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as Record<string, unknown>;
  const version = protocolVersion ?? '2026-07-28';

  const ok = (result: unknown): McpOutcome => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result },
    headers: { 'mcp-protocol-version': version },
  });
  const rpcErr = (code: number, message: string): McpOutcome => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
    headers: { 'mcp-protocol-version': version },
  });

  if (method === 'server/discover') {
    return ok({
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'initialize') {
    const offered = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? String((params as Record<string, unknown>).protocolVersion) : '2025-11-25';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      body: { jsonrpc: '2.0', id, result: { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO } },
      headers: { 'mcp-protocol-version': negotiated },
    };
  }
  if (method === 'notifications/initialized') {
    return { status: 202, body: null };
  }
  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    const out = callTool(ctx, name, args);
    if (out.error !== undefined) return rpcErr(out.error.code, out.error.message);
    return ok(out.result);
  }
  return rpcErr(-32601, `method not found: ${method}`);
}
