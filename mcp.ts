// mcp.ts — Model Context Protocol over streamable HTTP (POST /mcp).
// Modern server/discover (2026-07-28) + legacy initialize fallback, tools/list, tools/call.

import {
  Store,
  VIEWER,
  squashMerge,
  type Repo,
} from './store.ts';
import { tipOf } from './gitproto.ts';

export const MCP_VERSION = '2026-07-28';
export const MCP_LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const S = (description: string): { type: 'string'; description: string } => ({ type: 'string', description });
const B = (description: string): { type: 'boolean'; description: string } => ({ type: 'boolean', description });

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the given owner.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: S('Owner login of the new repository'),
        name: S('Name of the new repository'),
        description: S('Description of the repository'),
        private: B('Whether the repository is private'),
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
        owner: S('Owner login of the repository'),
        repo: S('Name of the repository'),
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
        owner: S('Owner login of the repository'),
        repo: S('Name of the repository'),
        title: S('Title of the issue'),
        body: S('Body of the issue'),
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
        owner: S('Owner login of the repository'),
        repo: S('Name of the repository'),
        state: S('Issue state filter: open, closed, or all'),
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
        owner: S('Owner login of the repository'),
        repo: S('Name of the repository'),
        title: S('Title of the pull request'),
        body: S('Body of the pull request'),
        head: S('Head branch name'),
        base: S('Base branch name'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: S('Owner login of the repository'),
        repo: S('Name of the repository'),
        pull_number: { type: 'number', description: 'Number of the pull request' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ------------------------------------------------------------------ tool execution

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(result: unknown): ToolResult {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

function errResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function strArg(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === 'string' ? v : undefined;
}

function numArg(args: Record<string, unknown>, name: string): number | undefined {
  const v = args[name];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  return undefined;
}

export function executeTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const owner = strArg(args, 'owner') ?? VIEWER.login;
  if (name === 'create_repo') {
    const repoName = strArg(args, 'name');
    if (!repoName) return errResult('name is required');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return errResult('Invalid repository name');
    if (store.getRepo(owner, repoName)) return errResult('Repository already exists');
    const description = strArg(args, 'description') ?? '';
    const isPrivate = args['private'] === true;
    const repo = store.createRepo(owner, repoName, description, isPrivate);
    return okResult({
      id: repo.dbId,
      node_id: Store.gid('repo', owner, repoName),
      name: repoName,
      full_name: `${owner}/${repoName}`,
      private: isPrivate,
      description,
      default_branch: repo.defaultBranch,
    });
  }
  if (name === 'get_repo') {
    const repoName = strArg(args, 'repo');
    if (!repoName) return errResult('repo is required');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errResult('Repository not found');
    return okResult({
      id: repo.dbId,
      node_id: Store.gid('repo', owner, repoName),
      name: repoName,
      full_name: `${owner}/${repoName}`,
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      owner: { login: owner },
    });
  }
  if (name === 'create_issue') {
    const repoName = strArg(args, 'repo');
    const title = strArg(args, 'title');
    if (!repoName) return errResult('repo is required');
    if (!title) return errResult('title is required');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errResult('Repository not found');
    const issue = {
      number: repo.nextIssue++,
      title,
      body: strArg(args, 'body') ?? '',
      state: 'open' as const,
      labels: [] as string[],
      comments: [] as Array<{ id: number; body: string }>,
      seq: repo.issues.length,
    };
    repo.issues.push(issue);
    return okResult({
      id: Store.gid('issue', owner, repoName, issue.number),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: 'open',
      full_name: `${owner}/${repoName}`,
    });
  }
  if (name === 'list_issues') {
    const repoName = strArg(args, 'repo');
    if (!repoName) return errResult('repo is required');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errResult('Repository not found');
    const state = strArg(args, 'state') ?? 'open';
    let list = repo.issues;
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    return okResult({
      issues: list.map((i) => ({
        id: Store.gid('issue', owner, repoName, i.number),
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
      })),
    });
  }
  if (name === 'create_pull_request') {
    const repoName = strArg(args, 'repo');
    const title = strArg(args, 'title');
    const head = strArg(args, 'head');
    const base = strArg(args, 'base');
    if (!repoName) return errResult('repo is required');
    if (!title) return errResult('title is required');
    if (!head) return errResult('head is required');
    if (!base) return errResult('base is required');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errResult('Repository not found');
    const headSha = tipOf(repo.git, `refs/heads/${head}`);
    const baseSha = tipOf(repo.git, `refs/heads/${base}`);
    if (!headSha || !baseSha) return errResult('Invalid head or base branch');
    const pr = {
      number: repo.nextPull++,
      title,
      body: strArg(args, 'body') ?? '',
      state: 'open' as const,
      merged: false,
      mergedAt: null as string | null,
      mergeCommitSha: null as string | null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      seq: repo.pulls.length,
    };
    repo.pulls.push(pr);
    return okResult({
      id: Store.gid('pull', owner, repoName, pr.number),
      number: pr.number,
      pull_number: pr.number,
      title: pr.title,
      body: pr.body,
      state: 'open',
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      head_ref: head,
      base_ref: base,
    });
  }
  if (name === 'merge_pull_request') {
    const repoName = strArg(args, 'repo');
    const pullNumber = numArg(args, 'pull_number');
    if (!repoName) return errResult('repo is required');
    if (pullNumber === undefined) return errResult('pull_number is required');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errResult('Repository not found');
    const pr = repo.pulls.find((p) => p.number === pullNumber);
    if (!pr) return errResult('Pull request not found');
    const res = squashMerge(store, repo, pr);
    if (!res.ok) return errResult('Pull request cannot be merged');
    return okResult({
      id: Store.gid('pull', owner, repoName, pr.number),
      number: pr.number,
      pull_number: pr.number,
      merged: true,
      state: 'closed',
      merge_commit_sha: res.sha,
    });
  }
  return errResult(`Unknown tool: ${name}`);
}

// ------------------------------------------------------------------ JSON-RPC handling

export interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * Handle one POST /mcp JSON-RPC request object.
 * Returns {status, payload} — payload null means "no response" (notification).
 */
export function handleMcpRpc(store: Store, req: RpcRequest): { status: number; payload: Record<string, unknown> | null } {
  const id = req.id;
  const isNotification = id === undefined || id === null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (method === 'notifications/initialized') {
    return { status: 202, payload: {} };
  }
  if (isNotification) {
    // Unknown notification: no reply.
    return { status: 202, payload: {} };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      payload: rpcResult(id, {
        supportedVersions: [MCP_VERSION, ...MCP_LEGACY],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    };
  }

  if (method === 'initialize') {
    const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : MCP_VERSION;
    return {
      status: 200,
      payload: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }

  if (method === 'tools/list') {
    return { status: 200, payload: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    if (!name) {
      return { status: 200, payload: rpcError(id, -32602, 'Invalid params: tool name is required') };
    }
    if (!TOOL_MAP.has(name)) {
      return { status: 200, payload: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    if (typeof params['arguments'] !== 'object' || params['arguments'] === null) {
      return { status: 200, payload: rpcError(id, -32602, 'Invalid params: arguments must be an object') };
    }
    const result = executeTool(store, name, args);
    return { status: 200, payload: rpcResult(id, result) };
  }

  if (method === 'ping') {
    return { status: 200, payload: rpcResult(id, {}) };
  }

  return { status: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
}

/** Parse error response (HTTP 400, JSON-RPC -32700). */
export function mcpParseError(): { status: number; payload: Record<string, unknown> } {
  return { status: 400, payload: rpcError(null, -32700, 'Parse error') };
}

export function isKnownTool(name: string): boolean {
  return TOOL_MAP.has(name);
}

export type { Repo };
