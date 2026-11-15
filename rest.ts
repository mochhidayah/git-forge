// rest.ts — GitHub REST v3 surface (repos, branches, commits, contents, issues, labels, PRs).
// Shapes follow the kit's checks-rest.ts exactly; extra GitHub-like fields are harmless.

import {
  Store,
  VIEWER,
  ZERO_OID,
  OID_RE,
  getObject,
  putObject,
  parseCommit,
  parseTree,
  flattenTree,
  buildTreeFromFlat,
  reachableCommits,
  isAncestor,
  mergeBase,
  squashMerge,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import {
  isCommit,
  tipOf,
} from './gitproto.ts';

export interface RestContext {
  store: Store;
  expectedToken: string | null; // null => any non-empty Bearer accepted
  reqCounter: { n: number };
}

export function nextRequestId(ctx: RestContext): string {
  ctx.reqCounter.n += 1;
  return `req-${ctx.reqCounter.n}`;
}

export function checkAuth(ctx: RestContext, authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  const m = /^Bearer\s+(.+)$/.exec(authHeader.trim());
  if (!m) return false;
  const token = m[1].trim();
  if (token.length === 0) return false;
  if (ctx.expectedToken) return token === ctx.expectedToken;
  return true;
}

// ------------------------------------------------------------------ JSON shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: Store.gid('repo', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
    default_branch: repo.defaultBranch,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.dbId * 100000 + issue.number,
    node_id: Store.gid('issue', repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: repo.dbId * 100000 + pr.number,
    node_id: Store.gid('pull', repo.owner, repo.name, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}

// ------------------------------------------------------------------ git helpers for REST

function tipCommitTree(repo: Repo, branch: string): { tip: string; tree: string } | null {
  const tip = tipOf(repo.git, `refs/heads/${branch}`);
  if (!tip) return null;
  const obj = getObject(repo.git, tip);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  if (!c) return null;
  return { tip, tree: c.tree };
}

/** Line multiset diff counts (added/removed lines). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (t: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const line of t.split('\n')) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

export interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff between two trees (by oid). Paths compared on flattened maps. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(repo.git, baseTree);
  const head = flattenTree(repo.git, headTree);
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (!b && h) {
      const data = getObject(repo.git, h.oid)?.data?.toString('utf8') ?? '';
      const lines = data === '' ? 0 : data.split('\n').length;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (b && !h) {
      const data = getObject(repo.git, b.oid)?.data?.toString('utf8') ?? '';
      const lines = data === '' ? 0 : data.split('\n').length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = getObject(repo.git, b.oid)?.data?.toString('utf8') ?? '';
      const newText = getObject(repo.git, h.oid)?.data?.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// ------------------------------------------------------------------ route handling

export type SendFn = (status: number, body: unknown, extraHeaders?: Record<string, string>) => void;

export interface RouteResult {
  handled: boolean;
}

/**
 * Handle a REST request. `segments` are the path segments under /api/v3 (decoded).
 * Returns true when the route was handled (a response was sent).
 */
export function handleRest(
  ctx: RestContext,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  send: SendFn,
  reqUrl: string,
): boolean {
  const store = ctx.store;
  const seg = segments;
  const notFound = (): void => {
    send(404, { message: 'Not Found' });
  };
  const badRequest = (msg: string): void => {
    send(400, { message: msg });
  };

  // GET /api/v3/ (root) — public.
  if (seg.length === 0) {
    if (method === 'GET') {
      send(200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    return false;
  }

  // GET /api/v3/meta — public.
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method === 'GET') {
      send(200, { installed_version: '1.0.0' });
      return true;
    }
    return false;
  }

  // Auth is required for everything else under /api/v3. (Checked by the caller via
  // ctx.authOk; this function assumes the caller already enforced it except for the
  // two public routes above.)
  const owner = VIEWER.login;

  // GET /api/v3/user
  if (seg.length === 1 && seg[0] === 'user') {
    if (method === 'GET') {
      send(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
      return true;
    }
    return false;
  }

  // /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') {
      const b = (body ?? {}) as Record<string, unknown>;
      const name = typeof b.name === 'string' ? b.name : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        send(422, { message: 'Invalid repository name' });
        return true;
      }
      if (store.getRepo(owner, name)) {
        send(422, { message: 'Repository already exists' });
        return true;
      }
      const repo = store.createRepo(owner, name, typeof b.description === 'string' ? b.description : '', b.private === true);
      send(201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const repos = store.listReposByOwner(owner);
      return sendPaginated(ctx, repos.map(repoJson), query, reqUrl, send);
    }
    return false;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    const repoOwner = seg[1];
    const repoName = seg[2];
    // Foreign owner: 404, never 403.
    if (repoOwner !== owner) {
      send(404, { message: 'Not Found' });
      return true;
    }
    const repo = store.getRepo(repoOwner, repoName);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (seg.length === 3) {
      if (method === 'GET') {
        if (!repo) {
          send(404, { message: 'Not Found' });
          return true;
        }
        send(200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (!repo) {
          send(404, { message: 'Not Found' });
          return true;
        }
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.description === 'string') repo.description = b.description;
        send(200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        if (!repo) {
          send(404, { message: 'Not Found' });
          return true;
        }
        store.deleteRepo(repoOwner, repoName);
        send(204, null);
        return true;
      }
      return false;
    }

    if (!repo) {
      send(404, { message: 'Not Found' });
      return true;
    }

    // POST /repos/{o}/{r}/git/refs
    if (seg.length === 5 && seg[3] === 'git' && seg[4] === 'refs' && method === 'POST') {
      const b = (body ?? {}) as Record<string, unknown>;
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!ref.startsWith('refs/heads/') || !OID_RE.test(sha) || !isCommit(repo.git, sha)) {
        send(422, { message: 'Invalid ref or SHA' });
        return true;
      }
      if (repo.git.refs.has(ref)) {
        send(422, { message: 'Reference already exists' });
        return true;
      }
      repo.git.refs.set(ref, sha);
      send(201, { ref, object: { sha, type: 'commit' } });
      return true;
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (seg.length === 7 && seg[3] === 'git' && seg[4] === 'refs' && seg[5] === 'heads' && method === 'GET') {
      const ref = `refs/heads/${seg[6]}`;
      const tip = tipOf(repo.git, ref);
      if (!tip) {
        send(404, { message: 'Not Found' });
        return true;
      }
      send(200, { ref, object: { sha: tip, type: 'commit' } });
      return true;
    }

    // GET /repos/{o}/{r}/branches
    if (seg.length === 4 && seg[3] === 'branches') {
      if (method === 'GET') {
        const out: Array<Record<string, unknown>> = [];
        for (const ref of [...repo.git.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort()) {
          out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.git.refs.get(ref) }, protected: false });
        }
        send(200, out);
        return true;
      }
      return false;
    }

    // GET /repos/{o}/{r}/branches/{branch}
    if (seg.length === 5 && seg[3] === 'branches' && method === 'GET') {
      const tip = tipOf(repo.git, `refs/heads/${seg[4]}`);
      if (!tip) {
        send(404, { message: 'Not Found' });
        return true;
      }
      send(200, { name: seg[4], commit: { sha: tip }, protected: false });
      return true;
    }

    // GET /repos/{o}/{r}/commits
    if (seg.length === 4 && seg[3] === 'commits' && method === 'GET') {
      const shaParam = query.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        tip = tipOf(repo.git, `refs/heads/${shaParam}`) ?? (OID_RE.test(shaParam) ? shaParam : undefined);
      } else {
        tip = tipOf(repo.git, `refs/heads/${repo.defaultBranch}`);
      }
      if (!tip || !getObject(repo.git, tip)) {
        send(200, []);
        return true;
      }
      const out: Array<Record<string, unknown>> = [];
      for (const oid of reachableCommits(repo.git, tip)) {
        const obj = getObject(repo.git, oid)!;
        const c = parseCommit(obj.data)!;
        out.push({
          sha: oid,
          commit: {
            message: c.message,
            author: { name: VIEWER.name, email: VIEWER.email },
            committer: { name: VIEWER.name, email: VIEWER.email },
          },
          parents: c.parents.map((p) => ({ sha: p })),
        });
      }
      send(200, out);
      return true;
    }

    // Contents: /repos/{o}/{r}/contents[/{path...}]
    if (seg.length >= 4 && seg[3] === 'contents') {
      const path = seg.slice(4).join('/');
      if (method === 'PUT') return putContents(ctx, repo, path, query, body, send);
      if (method === 'GET') return getContents(repo, path, query, send);
      if (method === 'DELETE') return deleteContents(ctx, repo, path, body, send);
      return false;
    }

    // Labels
    if (seg.length === 4 && seg[3] === 'labels') {
      if (method === 'POST') {
        const b = (body ?? {}) as Record<string, unknown>;
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name) {
          send(422, { message: 'Invalid label name' });
          return true;
        }
        repo.labels.set(name, { name, color: typeof b.color === 'string' ? b.color : 'ededed' });
        send(201, { name, color: repo.labels.get(name)!.color });
        return true;
      }
      if (method === 'GET') {
        send(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
        return true;
      }
      return false;
    }

    // Issues
    if (seg.length >= 4 && seg[3] === 'issues') {
      // POST /issues, GET /issues
      if (seg.length === 4) {
        if (method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          const title = typeof b.title === 'string' ? b.title : '';
          const labelsIn = Array.isArray(b.labels) ? (b.labels as unknown[]).map(String) : [];
          for (const l of labelsIn) {
            if (!repo.labels.has(l)) {
              send(422, { message: `Label does not exist: ${l}` });
              return true;
            }
          }
          const issue: Issue = {
            number: repo.nextIssue++,
            title,
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open',
            labels: labelsIn,
            comments: [],
            seq: repo.issues.length,
          };
          repo.issues.push(issue);
          send(201, issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = repo.issues;
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          // state=all or anything else: everything
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') {
            list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          return sendPaginated(ctx, list.map((i) => issueJson(repo, i)), query, reqUrl, send);
        }
        return false;
      }
      // /issues/{n}
      const num = Number(seg[4]);
      const issue = Number.isInteger(num) ? repo.issues.find((i) => i.number === num) : undefined;
      if (seg.length === 5) {
        if (!issue) {
          send(404, { message: 'Not Found' });
          return true;
        }
        if (method === 'GET') {
          send(200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const b = (body ?? {}) as Record<string, unknown>;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          send(200, issueJson(repo, issue));
          return true;
        }
        return false;
      }
      // /issues/{n}/comments
      if (seg.length === 6 && seg[5] === 'comments') {
        if (!issue) {
          send(404, { message: 'Not Found' });
          return true;
        }
        if (method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          const comment = { id: ctx.store.nextCommentId++, body: typeof b.body === 'string' ? b.body : '' };
          issue.comments.push(comment);
          send(201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: '2025-01-01T00:00:00Z' });
          return true;
        }
        if (method === 'GET') {
          send(200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: '2025-01-01T00:00:00Z' })));
          return true;
        }
        return false;
      }
      return false;
    }

    // Pull requests
    if (seg.length >= 4 && seg[3] === 'pulls') {
      if (seg.length === 4) {
        if (method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : '';
          const headSha = tipOf(repo.git, `refs/heads/${head}`);
          const baseSha = tipOf(repo.git, `refs/heads/${base}`);
          if (!headSha || !baseSha) {
            send(422, { message: 'Invalid head or base branch' });
            return true;
          }
          const pr: Pull = {
            number: repo.nextPull++,
            title: typeof b.title === 'string' ? b.title : '',
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
            seq: repo.pulls.length,
          };
          repo.pulls.push(pr);
          send(201, pullJson(repo, pr));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state');
          let list = repo.pulls;
          if (state === 'all') {
            // everything
          } else if (state === 'closed') {
            list = list.filter((p) => p.state === 'closed');
          } else {
            list = list.filter((p) => p.state === 'open');
          }
          return sendPaginated(ctx, list.map((p) => pullJson(repo, p)), query, reqUrl, send);
        }
        return false;
      }
      const num = Number(seg[4]);
      const pr = Number.isInteger(num) ? repo.pulls.find((p) => p.number === num) : undefined;
      if (seg.length === 5) {
        if (!pr) {
          send(404, { message: 'Not Found' });
          return true;
        }
        if (method === 'GET') {
          send(200, pullJson(repo, pr));
          return true;
        }
        return false;
      }
      if (seg.length === 6 && seg[5] === 'files' && method === 'GET') {
        if (!pr) {
          send(404, { message: 'Not Found' });
          return true;
        }
        const mb = mergeBase(repo.git, pr.headSha, pr.baseSha);
        if (!mb) {
          send(200, []);
          return true;
        }
        const mbCommit = parseCommit(getObject(repo.git, mb)!.data)!;
        const headCommit = parseCommit(getObject(repo.git, pr.headSha)!.data)!;
        send(200, diffTrees(repo, mbCommit.tree, headCommit.tree));
        return true;
      }
      if (seg.length === 6 && seg[5] === 'merge' && method === 'PUT') {
        return mergePull(ctx, repo, pr, send);
      }
      return false;
    }
  }

  notFound();
  return true;
}

// ------------------------------------------------------------------ contents

function putContents(ctx: RestContext, repo: Repo, path: string, query: URLSearchParams, body: unknown, send: SendFn): boolean {
  const b = (body ?? {}) as Record<string, unknown>;
  const message = typeof b.message === 'string' ? b.message : '';
  const contentB64 = typeof b.content === 'string' ? b.content : '';
  const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
  const sha = typeof b.sha === 'string' ? b.sha : undefined;
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  } catch {
    send(422, { message: 'Invalid base64 content' });
    return true;
  }
  const ref = `refs/heads/${branch}`;
  const tip = tipOf(repo.git, ref);
  // Branch must exist unless this is the default branch on an unborn repo.
  if (!tip && !(branch === repo.defaultBranch && repo.git.refs.size === 0)) {
    send(404, { message: 'Not Found' });
    return true;
  }
  let flat = new Map<string, { oid: string; mode: string }>();
  let parents: string[] = [];
  if (tip) {
    const c = parseCommit(getObject(repo.git, tip)!.data)!;
    flat = flattenTree(repo.git, c.tree);
    parents = [tip];
  }
  const existing = flat.get(path);
  if (sha !== undefined) {
    if (!existing || existing.oid !== sha) {
      send(409, { message: 'SHA does not match the current blob' });
      return true;
    }
  }
  const isCreate = !existing;
  const blobOid = putObject(repo.git, 'blob', content);
  flat.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = buildTreeFromFlat(repo.git, flat);
  const commitOid = ctx.store.makeCommit(repo, treeOid, parents, message);
  repo.git.refs.set(ref, commitOid);
  send(isCreate ? 201 : 200, {
    content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64', content: content.toString('base64') },
    commit: { sha: commitOid },
  });
  return true;
}

function getContents(repo: Repo, path: string, query: URLSearchParams, send: SendFn): boolean {
  const branch = query.get('ref') ?? repo.defaultBranch;
  const tip = tipOf(repo.git, `refs/heads/${branch}`);
  if (!tip) {
    send(404, { message: 'Not Found' });
    return true;
  }
  const c = parseCommit(getObject(repo.git, tip)!.data)!;
  const flat = flattenTree(repo.git, c.tree);
  const file = flat.get(path);
  if (file) {
    const data = getObject(repo.git, file.oid)?.data ?? Buffer.alloc(0);
    send(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop(),
      path,
      content: data.toString('base64'),
      sha: file.oid,
    });
    return true;
  }
  // Directory listing: immediate children under `path` ("" = root).
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
  for (const [p, v] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split('/')[0];
    const childPath = prefix + first;
    if (rest.includes('/')) {
      if (!children.has(childPath)) {
        // Directory: compute its subtree tree oid.
        const sub = new Map<string, { oid: string; mode: string }>();
        for (const [p2, v2] of flat) {
          if (p2.startsWith(`${childPath}/`)) sub.set(p2.slice(childPath.length + 1), v2);
        }
        const treeOid = buildTreeFromFlat(repo.git, sub);
        children.set(childPath, { type: 'dir', name: first, path: childPath, sha: treeOid });
      }
    } else {
      children.set(childPath, { type: 'file', name: first, path: childPath, sha: v.oid });
    }
  }
  if (children.size === 0) {
    send(404, { message: 'Not Found' });
    return true;
  }
  send(200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
  return true;
}

function deleteContents(ctx: RestContext, repo: Repo, path: string, body: unknown, send: SendFn): boolean {
  const b = (body ?? {}) as Record<string, unknown>;
  const message = typeof b.message === 'string' ? b.message : '';
  const sha = typeof b.sha === 'string' ? b.sha : undefined;
  const tip = tipOf(repo.git, `refs/heads/${repo.defaultBranch}`);
  if (!tip) {
    send(404, { message: 'Not Found' });
    return true;
  }
  const c = parseCommit(getObject(repo.git, tip)!.data)!;
  const flat = flattenTree(repo.git, c.tree);
  const existing = flat.get(path);
  if (!existing) {
    send(404, { message: 'Not Found' });
    return true;
  }
  if (sha !== undefined && existing.oid !== sha) {
    send(409, { message: 'SHA does not match the current blob' });
    return true;
  }
  flat.delete(path);
  const treeOid = buildTreeFromFlat(repo.git, flat);
  const commitOid = ctx.store.makeCommit(repo, treeOid, [tip], message);
  repo.git.refs.set(`refs/heads/${repo.defaultBranch}`, commitOid);
  send(200, { commit: { sha: commitOid } });
  return true;
}

// ------------------------------------------------------------------ PR merge

function mergePull(ctx: RestContext, repo: Repo, pr: Pull | undefined, send: SendFn): boolean {
  if (!pr) {
    send(404, { message: 'Not Found' });
    return true;
  }
  const res = squashMerge(ctx.store, repo, pr);
  if (!res.ok) {
    if (res.reason === 'conflict') {
      send(405, { message: 'Merge conflict' });
    } else if (res.reason === 'already-merged') {
      send(405, { message: 'Pull request is already merged' });
    } else {
      send(405, { message: 'Cannot merge pull request' });
    }
    return true;
  }
  send(200, { merged: true, sha: res.sha, message: 'Pull request successfully merged' });
  return true;
}

// ------------------------------------------------------------------ pagination

export function sendPaginated(
  ctx: RestContext,
  items: unknown[],
  query: URLSearchParams,
  reqUrl: string,
  send: SendFn,
): boolean {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (items.length > perPage) {
    const base = reqUrl.split('?')[0];
    const linkParts: string[] = [];
    const mk = (p: number, rel: string): string => {
      const q = new URLSearchParams(query);
      q.set('page', String(p));
      q.set('per_page', String(perPage));
      return `<${base}?${q.toString()}>; rel="${rel}"`;
    };
    if (page < totalPages) linkParts.push(mk(page + 1, 'next'));
    if (page > 1) linkParts.push(mk(page - 1, 'prev'));
    linkParts.push(mk(1, 'first'));
    linkParts.push(mk(totalPages, 'last'));
    headers.link = linkParts.join(', ');
  }
  send(200, slice, headers);
  return true;
}
