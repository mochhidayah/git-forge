// graphql.ts — GitHub GraphQL v4 for the 18 documents gh / github-mcp-server send.
// Hand-rolled parser + executor over the store. Unknown fields -> errors array (HTTP 200).

import {
  Store,
  VIEWER,
  getObject,
  parseCommit,
  flattenTree,
  mergeBase,
  squashMerge,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { tipOf } from './gitproto.ts';
import { diffTrees } from './rest.ts';

// ------------------------------------------------------------------ tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (c === '.' && input[i + 1] === '.' && input[i + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@=&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const e = input[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === '/') out += '/';
          else if (e === '\\') out += '\\';
          else if (e === '"') out += '"';
          else if (e === 'u') { out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e;
          j += 2;
        } else {
          out += input[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j++;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j++;
        if (input[j] === '+' || input[j] === '-') j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j])) j++;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; required: boolean }>;
  selection: SelectionNode[];
}

export class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of query');
    this.pos++;
    return t;
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${JSON.stringify(t)}`);
  }

  private acceptPunct(v: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === v) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ operation: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        this.next();
        const op = t.value as 'query' | 'mutation';
        let name: string | null = null;
        const nt = this.peek();
        if (nt && nt.kind === 'name') name = this.next().value as string;
        const variables: Array<{ name: string; required: boolean }> = [];
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) {
            this.expectPunct('$');
            const vname = this.expectName();
            this.expectPunct(':');
            // Type: [Name] / Name, optional ! — skip tokens until the next
            // variable ('$'), the closing ')', or a ',' (the tokenizer drops
            // commas as insignificant, so '$' is the real separator).
            let required = false;
            let depth = 0;
            while (true) {
              const tt = this.next();
              if (tt.kind === 'punct' && tt.value === '[') depth++;
              else if (tt.kind === 'punct' && tt.value === ']') depth--;
              else if (tt.kind === 'punct' && tt.value === '!' && depth === 0) required = true;
              else if (tt.kind === 'punct' && (tt.value === ',' || tt.value === ')' || tt.value === '$')) {
                if (tt.value !== ',') this.pos--; // ')' or '$' is re-read by the outer loop
                break;
              } else if (tt.kind === 'punct' && tt.value === '=') {
                // default value: skip one value node
                this.parseValue();
                break;
              }
            }
            variables.push({ name: vname, required });
            const sep = this.peek();
            if (sep && sep.kind === 'punct' && sep.value === ',') this.next();
          }
        }
        const selection = this.parseSelectionSet();
        operations.push({ operation: op, name, variables, selection });
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const fname = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type name
        fragments.set(fname, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(t)} at top level`);
    }
    return { operations, fragments };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (true) {
      const t = this.peek();
      if (!t) throw new Error('unterminated selection set');
      if (t.kind === 'punct' && t.value === '}') {
        this.next();
        return out;
      }
      if (t.kind === 'spread') {
        this.next();
        const nt = this.peek();
        if (nt && nt.kind === 'name' && nt.value === 'on') {
          this.next();
          const typeName = this.expectName();
          out.push({ kind: 'inlineFragment', typeCondition: typeName, selection: this.parseSelectionSet() });
        } else if (nt && nt.kind === 'name') {
          out.push({ kind: 'fragmentSpread', name: this.next().value as string });
        } else {
          out.push({ kind: 'inlineFragment', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      out.push({ kind: 'field', field: this.parseField() });
    }
  }

  parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const aname = this.expectName();
        this.expectPunct(':');
        args.push({ name: aname, value: this.parseValue() });
        const sep = this.peek();
        if (sep && sep.kind === 'punct' && sep.value === ',') this.next();
      }
    }
    // Directives (@...) — skip.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const tt = this.next();
          if (tt.kind === 'punct' && tt.value === '(') depth++;
          else if (tt.kind === 'punct' && tt.value === ')') depth--;
        }
      }
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue());
        const sep = this.peek();
        if (sep && sep.kind === 'punct' && sep.value === ',') this.next();
      }
      this.next();
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const fname = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fname, value: this.parseValue() });
        const sep = this.peek();
        if (sep && sep.kind === 'punct' && sep.value === ',') this.next();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

// ------------------------------------------------------------------ executor

export interface GqlContext {
  store: Store;
}

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name] ?? null;
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'labels', 'comments', 'url', 'repository'];
const PR_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url'];

const TYPE_INFO: Record<string, { fields: string[]; enumValues: string[] | null }> = {
  Issue: { fields: ISSUE_FIELDS, enumValues: null },
  PullRequest: { fields: PR_FIELDS, enumValues: null },
  Repository: { fields: REPO_FIELDS, enumValues: null },
  SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueState: { fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
}

function decodeCursor(c: string): number | null {
  try {
    const text = Buffer.from(c, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function repoObject(repo: Repo): GqlObject {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: Store.gid('repo', repo.owner, repo.name),
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: Store.gid('issue', repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
  };
}

function prObject(repo: Repo, pr: Pull): GqlObject {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pr: pr,
    id: Store.gid('pull', repo.owner, repo.name, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    mergeable: 'MERGEABLE',
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
  };
}

class Executor {
  errors: Array<{ message: string }> = [];
  private ctx: GqlContext;
  private variables: Record<string, unknown>;
  private fragments: Map<string, SelectionNode[]>;
  constructor(ctx: GqlContext, variables: Record<string, unknown>, fragments: Map<string, SelectionNode[]>) {
    this.ctx = ctx;
    this.variables = variables;
    this.fragments = fragments;
  }

  executeSelection(parent: GqlObject | null, selections: SelectionNode[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'fragmentSpread') {
        const frag = this.fragments.get(sel.name);
        if (!frag) {
          this.errors.push({ message: `Unknown fragment "${sel.name}"` });
          continue;
        }
        Object.assign(out, this.executeSelection(parent, frag));
        continue;
      }
      if (sel.kind === 'inlineFragment') {
        if (sel.typeCondition && parent && parent.__typename !== sel.typeCondition) continue;
        Object.assign(out, this.executeSelection(parent, sel.selection));
        continue;
      }
      const field = sel.field;
      const key = field.alias ?? field.name;
      const value = this.resolveField(parent, field);
      if (value === Executor.FIELD_ERROR) continue;
      out[key] = this.resolveSubselection(value, field.selection);
    }
    return out;
  }

  private static FIELD_ERROR = Symbol('field-error');

  private resolveSubselection(value: unknown, selection: SelectionNode[] | null): unknown {
    if (selection === null || selection === undefined) return value;
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      return value.map((v) => (v && typeof v === 'object' ? this.executeSelection(v as GqlObject, selection) : v));
    }
    if (typeof value === 'object') {
      return this.executeSelection(value as GqlObject, selection);
    }
    return value;
  }

  private resolveField(parent: GqlObject | null, field: FieldNode): unknown {
    const typename = parent?.__typename ?? 'Query';
    const args = argsOf(field, this.variables);
    if (typename === 'Query') return this.resolveQuery(field, args);
    if (typename === 'Repository') return this.resolveRepository(parent!, field, args);
    if (typename === 'Issue') return this.resolveIssue(parent!, field, args);
    if (typename === 'PullRequest') return this.resolvePullRequest(parent!, field, args);
    if (typename === 'User') {
      if (field.name === 'login') return (parent as GqlObject)['login'];
    }
    // Mutation payloads: gh reads the created object back off the payload.
    if (typename === 'CreateIssuePayload' || typename === 'CloseIssuePayload') {
      if (field.name === 'issue') return (parent as GqlObject)['issue'];
    }
    if (typename === 'CreatePullRequestPayload' || typename === 'MergePullRequestPayload') {
      if (field.name === 'pullRequest') return (parent as GqlObject)['pullRequest'];
    }
    if (typename === 'AddCommentPayload') {
      if (field.name === 'commentEdge') return (parent as GqlObject)['commentEdge'];
    }
    if (typename === 'IssueCommentEdge') {
      if (field.name === 'node') return (parent as GqlObject)['node'];
    }
    if (typename === 'IssueComment') {
      if (field.name === 'id') return (parent as GqlObject)['id'];
      if (field.name === 'body') return (parent as GqlObject)['body'];
    }
    if (typename === 'PullRequestChangedFile') {
      if (field.name === 'path') return (parent as GqlObject)['path'];
    }
    if (typename === '__Type') {
      if (field.name === 'fields') {
        const info = TYPE_INFO[(parent as GqlObject)['name'] as string];
        return (info?.fields ?? []).map((n) => ({ __typename: '__Field', name: n }));
      }
      if (field.name === 'enumValues') {
        const info = TYPE_INFO[(parent as GqlObject)['name'] as string];
        return (info?.enumValues ?? []).map((n) => ({ __typename: '__EnumValue', name: n }));
      }
      if (field.name === 'name') return (parent as GqlObject)['name'];
    }
    if (typename === '__Field' || typename === '__EnumValue') {
      if (field.name === 'name') return (parent as GqlObject)['name'];
    }
    if (typename === 'IssueConnection' || typename === 'PullRequestConnection' || typename === 'PullRequestChangedFileConnection') {
      if (field.name === 'nodes') return (parent as GqlObject)['nodes'];
      if (field.name === 'pageInfo') return (parent as GqlObject)['pageInfo'];
    }
    if (typename === 'PageInfo') {
      if (field.name === 'hasNextPage') return (parent as GqlObject)['hasNextPage'];
      if (field.name === 'endCursor') return (parent as GqlObject)['endCursor'];
    }
    if (typename === 'Ref') {
      if (field.name === 'name') return (parent as GqlObject)['name'];
    }
    if (field.name === '__typename') return typename;
    this.errors.push({ message: `Cannot query field "${field.name}" on type "${typename}"` });
    return Executor.FIELD_ERROR;
  }

  private resolveQuery(field: FieldNode, args: Record<string, unknown>): unknown {
    const store = this.ctx.store;
    if (field.name === 'viewer') {
      return { __typename: 'User', login: VIEWER.login, id: VIEWER.id };
    }
    if (field.name === 'repository') {
      const owner = String(args['owner'] ?? '');
      const name = String(args['name'] ?? '');
      const repo = store.getRepo(owner, name);
      return repo ? repoObject(repo) : null;
    }
    if (field.name === 'node') {
      const id = String(args['id'] ?? '');
      const decoded = Store.decodeGid(id);
      if (decoded && decoded.kind === 'repo' && decoded.parts.length === 2) {
        const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
        return repo ? repoObject(repo) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args['name'] ?? '');
      return { __typename: '__Type', name };
    }
    if (field.name === 'createIssue') return this.mutationCreateIssue(args);
    if (field.name === 'closeIssue') return this.mutationCloseIssue(args);
    if (field.name === 'createPullRequest') return this.mutationCreatePullRequest(args);
    if (field.name === 'mergePullRequest') return this.mutationMergePullRequest(args);
    if (field.name === 'addComment') return this.mutationAddComment(args);
    this.errors.push({ message: `Cannot query field "${field.name}" on type "Query"` });
    return Executor.FIELD_ERROR;
  }

  private resolveRepository(parent: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    const repo = parent['__repo'] as Repo;
    switch (field.name) {
      case 'id': return parent['id'];
      case 'databaseId': return parent['databaseId'];
      case 'name': return parent['name'];
      case 'nameWithOwner': return parent['nameWithOwner'];
      case 'viewerPermission': return parent['viewerPermission'];
      case 'hasIssuesEnabled': return parent['hasIssuesEnabled'];
      case 'owner': return { __typename: 'User', login: repo.owner, id: VIEWER.id };
      case 'defaultBranchRef': return { __typename: 'Ref', name: repo.defaultBranch };
      case 'issue': {
        const num = Number(args['number']);
        const issue = repo.issues.find((i) => i.number === num);
        return issue ? issueObject(repo, issue) : null;
      }
      case 'issues': return this.issuesConnection(repo, args);
      case 'pullRequests': {
        const first = typeof args['first'] === 'number' ? args['first'] : undefined;
        let list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
        if (first !== undefined) list = list.slice(0, first);
        return { __typename: 'PullRequestConnection', nodes: list.map((p) => prObject(repo, p)), pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null } };
      }
      case 'pullRequest': {
        const num = Number(args['number']);
        const pr = repo.pulls.find((p) => p.number === num);
        return pr ? prObject(repo, pr) : null;
      }
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "Repository"` });
        return Executor.FIELD_ERROR;
    }
  }

  private issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    let list = [...repo.issues];
    const states = args['states'];
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      list = list.filter((i) => wanted.has(i.state));
    }
    const orderBy = args['orderBy'] as Record<string, unknown> | undefined;
    const direction = orderBy && typeof orderBy['direction'] === 'string' ? orderBy['direction'] : 'DESC';
    list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
    const first = typeof args['first'] === 'number' ? args['first'] : undefined;
    const after = typeof args['after'] === 'string' && args['after'] ? decodeCursor(args['after']) : null;
    if (after !== null) {
      // Issues are ordered DESC by number; cursor holds the last seen number.
      list = list.filter((i) => i.number < after);
    }
    const total = list.length;
    const page = first !== undefined ? list.slice(0, first) : list;
    const hasNextPage = first !== undefined ? total > first : false;
    const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
    return {
      __typename: 'IssueConnection',
      nodes: page.map((i) => issueObject(repo, i)),
      pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
    };
  }

  private resolveIssue(parent: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    const issue = parent['__issue'] as Issue;
    switch (field.name) {
      case 'id': return parent['id'];
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "Issue"` });
        return Executor.FIELD_ERROR;
    }
  }

  private resolvePullRequest(parent: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    const repo = parent['__repo'] as Repo;
    const pr = parent['__pr'] as Pull;
    switch (field.name) {
      case 'id': return parent['id'];
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'state': return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return pr.merged;
      case 'mergeable': return 'MERGEABLE';
      case 'headRefName': return pr.headRef;
      case 'baseRefName': return pr.baseRef;
      case 'files': {
        const first = typeof args['first'] === 'number' ? args['first'] : undefined;
        const mb = mergeBase(repo.git, pr.headSha, pr.baseSha);
        let paths: string[] = [];
        if (mb) {
          const mbTree = parseCommit(getObject(repo.git, mb)!.data)!.tree;
          const headTree = parseCommit(getObject(repo.git, pr.headSha)!.data)!.tree;
          paths = diffTrees(repo, mbTree, headTree).map((f) => f.filename);
        }
        if (first !== undefined) paths = paths.slice(0, first);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: paths.map((p) => ({ __typename: 'PullRequestChangedFile', path: p })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
        };
      }
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest"` });
        return Executor.FIELD_ERROR;
    }
  }

  // ---------------------------------------------------------- mutations

  private mutationCreateIssue(args: Record<string, unknown>): unknown {
    const input = (args['input'] ?? {}) as Record<string, unknown>;
    const repoId = String(input['repositoryId'] ?? '');
    const decoded = Store.decodeGid(repoId);
    if (!decoded || decoded.kind !== 'repo' || decoded.parts.length !== 2) {
      this.errors.push({ message: 'Could not resolve repository id' });
      return Executor.FIELD_ERROR;
    }
    const repo = this.ctx.store.getRepo(decoded.parts[0], decoded.parts[1]);
    if (!repo) {
      this.errors.push({ message: 'Could not resolve repository id' });
      return Executor.FIELD_ERROR;
    }
    const issue: Issue = {
      number: repo.nextIssue++,
      title: typeof input['title'] === 'string' ? input['title'] : '',
      body: typeof input['body'] === 'string' ? input['body'] : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: repo.issues.length,
    };
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
  }

  private mutationCloseIssue(args: Record<string, unknown>): unknown {
    const input = (args['input'] ?? {}) as Record<string, unknown>;
    const issueId = String(input['issueId'] ?? '');
    const decoded = Store.decodeGid(issueId);
    if (!decoded || decoded.kind !== 'issue' || decoded.parts.length !== 3) {
      this.errors.push({ message: 'Could not resolve issue id' });
      return Executor.FIELD_ERROR;
    }
    const repo = this.ctx.store.getRepo(decoded.parts[0], decoded.parts[1]);
    const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[2]));
    if (!repo || !issue) {
      this.errors.push({ message: 'Could not resolve issue id' });
      return Executor.FIELD_ERROR;
    }
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
  }

  private mutationCreatePullRequest(args: Record<string, unknown>): unknown {
    const input = (args['input'] ?? {}) as Record<string, unknown>;
    const repoId = String(input['repositoryId'] ?? '');
    const decoded = Store.decodeGid(repoId);
    if (!decoded || decoded.kind !== 'repo' || decoded.parts.length !== 2) {
      this.errors.push({ message: 'Could not resolve repository id' });
      return Executor.FIELD_ERROR;
    }
    const repo = this.ctx.store.getRepo(decoded.parts[0], decoded.parts[1]);
    if (!repo) {
      this.errors.push({ message: 'Could not resolve repository id' });
      return Executor.FIELD_ERROR;
    }
    const baseRef = String(input['baseRefName'] ?? '');
    const headRef = String(input['headRefName'] ?? '');
    const headSha = tipOf(repo.git, `refs/heads/${headRef}`);
    const baseSha = tipOf(repo.git, `refs/heads/${baseRef}`);
    if (!headSha || !baseSha) {
      this.errors.push({ message: 'Invalid head or base branch' });
      return Executor.FIELD_ERROR;
    }
    const pr: Pull = {
      number: repo.nextPull++,
      title: typeof input['title'] === 'string' ? input['title'] : '',
      body: typeof input['body'] === 'string' ? input['body'] : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: repo.pulls.length,
    };
    repo.pulls.push(pr);
    return { __typename: 'CreatePullRequestPayload', pullRequest: prObject(repo, pr) };
  }

  private mutationMergePullRequest(args: Record<string, unknown>): unknown {
    const input = (args['input'] ?? {}) as Record<string, unknown>;
    const prId = String(input['pullRequestId'] ?? '');
    const decoded = Store.decodeGid(prId);
    if (!decoded || decoded.kind !== 'pull' || decoded.parts.length !== 3) {
      this.errors.push({ message: 'Could not resolve pull request id' });
      return Executor.FIELD_ERROR;
    }
    const repo = this.ctx.store.getRepo(decoded.parts[0], decoded.parts[1]);
    const pr = repo?.pulls.find((p) => p.number === Number(decoded.parts[2]));
    if (!repo || !pr) {
      this.errors.push({ message: 'Could not resolve pull request id' });
      return Executor.FIELD_ERROR;
    }
    const res = squashMerge(this.ctx.store, repo, pr);
    if (!res.ok) {
      this.errors.push({ message: 'Pull request cannot be merged' });
      return Executor.FIELD_ERROR;
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: prObject(repo, pr) };
  }

  private mutationAddComment(args: Record<string, unknown>): unknown {
    const input = (args['input'] ?? {}) as Record<string, unknown>;
    const subjectId = String(input['subjectId'] ?? '');
    const body = typeof input['body'] === 'string' ? input['body'] : '';
    const decoded = Store.decodeGid(subjectId);
    if (!decoded || decoded.kind !== 'issue' || decoded.parts.length !== 3) {
      this.errors.push({ message: 'Could not resolve subject id' });
      return Executor.FIELD_ERROR;
    }
    const repo = this.ctx.store.getRepo(decoded.parts[0], decoded.parts[1]);
    const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[2]));
    if (!repo || !issue) {
      this.errors.push({ message: 'Could not resolve subject id' });
      return Executor.FIELD_ERROR;
    }
    const commentId = this.ctx.store.nextCommentId++;
    issue.comments.push({ id: commentId, body });
    const node = {
      __typename: 'IssueComment',
      id: Store.gid('comment', repo.owner, repo.name, issue.number, commentId),
      body,
    };
    return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node } };
  }
}

// ------------------------------------------------------------------ entry point

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(ctx: GqlContext, queryText: string, variables: Record<string, unknown>): GqlResult {
  let doc;
  try {
    doc = new Parser(tokenize(queryText)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const op = doc.operations[0];
  if (!op) return { data: null, errors: [{ message: 'No operation provided' }] };
  const executor = new Executor(ctx, variables, doc.fragments);
  const data = executor.executeSelection(null, op.selection);
  if (executor.errors.length > 0) {
    return { data: null, errors: executor.errors };
  }
  return { data };
}

/** Handle one POST /api/graphql body (single op or batch array). */
export function handleGraphQL(ctx: GqlContext, body: unknown): { status: number; payload: unknown } {
  if (Array.isArray(body)) {
    const out: GqlResult[] = [];
    for (const item of body) {
      const op = (item ?? {}) as Record<string, unknown>;
      const query = typeof op['query'] === 'string' ? op['query'] : '';
      const variables = (op['variables'] ?? {}) as Record<string, unknown>;
      out.push(executeGraphQL(ctx, query, variables));
    }
    return { status: 200, payload: out };
  }
  const op = (body ?? {}) as Record<string, unknown>;
  const query = typeof op['query'] === 'string' ? op['query'] : '';
  const variables = (op['variables'] ?? {}) as Record<string, unknown>;
  return { status: 200, payload: executeGraphQL(ctx, query, variables) };
}
