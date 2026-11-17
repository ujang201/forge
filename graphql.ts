// GitHub GraphQL v4 at /api/graphql: a small hand-rolled executor for exactly
// the documents gh and github-mcp-server send. No GraphQL library exists in the
// trial; the parser covers operation definitions, variables, aliases, inline
// enum/object/list arguments and inline fragments.

import type { Issue, Pull, Repo, Store } from './store.ts';

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections?: SelectionNode[];
}

type SelectionNode = { kind: 'field'; field: FieldNode } | { kind: 'fragment'; type: string; selections: SelectionNode[] };

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: { name: string; type: string }[];
  selections: SelectionNode[];
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    return this.tokens[this.pos++];
  }
  expect(tok: string): void {
    const t = this.next();
    if (t !== tok) throw new Error(`expected ${tok}, got ${t}`);
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | undefined;
    if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{' && /^[A-Za-z_]/.test(this.peek()!)) {
      name = this.next();
    }
    const variables: { name: string; type: string }[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const vname = this.next();
        this.expect(':');
        const typeParts: string[] = [];
        while (this.peek() !== undefined && this.peek() !== ')' && this.peek() !== ',' && this.peek() !== '$') {
          typeParts.push(this.next());
        }
        variables.push({ name: vname, type: typeParts.join('') });
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    const selections = this.parseSelections();
    return { kind, name, variables, selections };
  }

  parseSelections(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const type = this.next();
          out.push({ kind: 'fragment', type, selections: this.parseSelections() });
        } else {
          throw new Error('named fragments unsupported');
        }
      } else {
        out.push({ kind: 'field', field: this.parseField() });
      }
    }
    this.expect('}');
    return out;
  }

  parseField(): FieldNode {
    const first = this.next();
    let alias: string | undefined;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const aname = this.next();
        this.expect(':');
        args.push({ name: aname, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    let selections: SelectionNode[] | undefined;
    if (this.peek() === '{') selections = this.parseSelections();
    return { alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t === '$') return { kind: 'variable', name: this.next() };
    if (t === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== ']') {
        items.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t === 'true') return { kind: 'boolean', value: true };
    if (t === 'false') return { kind: 'boolean', value: false };
    if (t === 'null') return { kind: 'null' };
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: parseInt(t, 10) };
    if (/^-?\d+\.\d+$/.test(t)) return { kind: 'float', value: parseFloat(t) };
    return { kind: 'enum', value: t };
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((i) => evalValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ values

interface Ctx {
  store: Store;
  viewer: string;
}

type AnyObj = { __typename: string; [key: string]: unknown };

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'];
const PR_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'createdAt', 'author'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url'];

function repoObj(repo: Repo): AnyObj {
  return { __typename: 'Repository', repo };
}
function issueObj(repo: Repo, issue: Issue): AnyObj {
  return { __typename: 'Issue', repo, issue };
}
function pullObj(repo: Repo, pull: Pull): AnyObj {
  return { __typename: 'PullRequest', repo, pull };
}

function decodeGlobalId(id: string): { kind: string; owner: string; name: string; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'forge' || parts.length < 4) return null;
    return { kind: parts[1], owner: parts[2], name: parts[3], number: parts.length > 4 ? parseInt(parts[4], 10) : 0 };
  } catch {
    return null;
  }
}

function findByGlobalId(ctx: Ctx, id: string): { repo: Repo; kind: string; number: number } | null {
  const d = decodeGlobalId(id);
  if (d === null) return null;
  const repo = ctx.store.getRepo(d.owner, d.name);
  if (repo === undefined) return null;
  return { repo, kind: d.kind, number: d.number };
}

function cursorFor(n: number): string {
  return Buffer.from(`n:${n}`, 'utf8').toString('base64url');
}
function numberAfterCursor(after: unknown): number | null {
  if (typeof after !== 'string' || after === '') return null;
  try {
    const text = Buffer.from(after, 'base64url').toString('utf8');
    if (!text.startsWith('n:')) return null;
    const n = parseInt(text.slice(2), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ resolvers

type Resolver = (parent: AnyObj, args: Record<string, unknown>, ctx: Ctx) => unknown;

const resolvers: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: 'viewer' }),
    repository: (_p, args, ctx) => {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== ctx.viewer) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoObj(repo);
    },
    node: (_p, args, ctx) => {
      const found = findByGlobalId(ctx, String(args.id ?? ''));
      if (found === null || found.kind !== 'repo') return null;
      return repoObj(found.repo);
    },
    __type: (_p, args) => ({ __typename: '__Type', name: String(args.name ?? '') }),
  },
  User: {
    login: (_p, _a, ctx) => ctx.viewer,
  },
  Repository: {
    id: (p) => (p.repo as Repo).id !== undefined ? globalRepoId(p.repo as Repo) : null,
    databaseId: (p) => (p.repo as Repo).id,
    name: (p) => (p.repo as Repo).name,
    nameWithOwner: (p) => `${(p.repo as Repo).owner}/${(p.repo as Repo).name}`,
    owner: (p) => ({ __typename: 'User', login: (p.repo as Repo).owner }),
    defaultBranchRef: (p) => ({ __typename: 'Ref', name: (p.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (p) => (p.repo as Repo).description,
    issue: (p, args, ctx) => {
      const repo = p.repo as Repo;
      const issue = ctx.store.getIssue(repo, Number(args.number));
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (p, args) => {
      const repo = p.repo as Repo;
      let list = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (states !== undefined && states.length > 0) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy?.field === 'CREATED_AT') {
        list.sort((a, b) => (orderBy.direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      } else {
        list.sort((a, b) => b.number - a.number);
      }
      const afterNum = numberAfterCursor(args.after);
      if (afterNum !== null) list = list.filter((i) => i.number < afterNum);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      const hasNext = list.length > first;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((i) => issueObj(repo, i)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, endCursor },
      };
    },
    pullRequests: (p, args) => {
      const repo = p.repo as Repo;
      let list = [...repo.pulls].sort((a, b) => b.number - a.number);
      const first = typeof args.first === 'number' ? args.first : list.length;
      list = list.slice(0, first);
      return { __typename: 'PullRequestConnection', nodes: list.map((x) => pullObj(repo, x)) };
    },
    pullRequest: (p, args, ctx) => {
      const repo = p.repo as Repo;
      const pull = ctx.store.getPull(repo, Number(args.number));
      return pull === undefined ? null : pullObj(repo, pull);
    },
  },
  Issue: {
    id: (p) => (p.issue as Issue).id,
    number: (p) => (p.issue as Issue).number,
    title: (p) => (p.issue as Issue).title,
    state: (p) => (p.issue as Issue).state.toUpperCase(),
    body: (p) => (p.issue as Issue).body,
  },
  PullRequest: {
    id: (p) => (p.pull as Pull).id,
    number: (p) => (p.pull as Pull).number,
    title: (p) => (p.pull as Pull).title,
    body: (p) => (p.pull as Pull).body,
    state: (p) => {
      const pull = p.pull as Pull;
      if (pull.merged) return 'MERGED';
      return pull.state.toUpperCase();
    },
    merged: (p) => (p.pull as Pull).merged,
    headRefName: (p) => (p.pull as Pull).headRef,
    baseRefName: (p) => (p.pull as Pull).baseRef,
    mergeable: (p, _a, ctx) => {
      const repo = p.repo as Repo;
      const pull = p.pull as Pull;
      return ctx.store.wouldConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (p, args) => {
      const pull = p.pull as Pull;
      const first = typeof args.first === 'number' ? args.first : pull.files.length;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: pull.files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename })),
      };
    },
  },
  __Type: {
    fields: (p) => {
      const name = p.name as string;
      const list = name === 'Issue' ? ISSUE_FIELDS : name === 'PullRequest' ? PR_FIELDS : name === 'Repository' ? REPO_FIELDS : [];
      return list.map((n) => ({ __typename: '__Field', name: n }));
    },
    enumValues: (p) => {
      const name = p.name as string;
      if (name !== 'SearchType') return [];
      return ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'].map((n) => ({ __typename: '__EnumValue', name: n }));
    },
  },
  Mutation: {
    createIssue: (_p, args, ctx) => {
      const input = args.input as { repositoryId?: string; title?: string; body?: string };
      const found = findByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (found === null || found.kind !== 'repo') throw new Error('repository not found');
      const issue = ctx.store.createIssue(found.repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueObj(found.repo, issue) };
    },
    closeIssue: (_p, args, ctx) => {
      const input = args.input as { issueId?: string };
      const found = findByGlobalId(ctx, String(input.issueId ?? ''));
      if (found === null) throw new Error('issue not found');
      const issue = ctx.store.getIssue(found.repo, found.number);
      if (issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, issue) };
    },
    createPullRequest: (_p, args, ctx) => {
      const input = args.input as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
      const found = findByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (found === null || found.kind !== 'repo') throw new Error('repository not found');
      const repo = found.repo;
      const base = String(input.baseRefName ?? repo.defaultBranch);
      const head = String(input.headRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) throw new Error('head or base branch does not exist');
      const files = ctx.store.diffFiles(repo, baseSha, headSha);
      const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, headSha, base, baseSha, files);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
    },
    mergePullRequest: (_p, args, ctx) => {
      const input = args.input as { pullRequestId?: string };
      const found = findByGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (found === null) throw new Error('pull request not found');
      const pull = ctx.store.getPull(found.repo, found.number);
      if (pull === undefined) throw new Error('pull request not found');
      const sha = ctx.store.squashMerge(found.repo, pull);
      if (sha === null) throw new Error('Merge conflict');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, pull) };
    },
    addComment: (_p, args, ctx) => {
      const input = args.input as { subjectId?: string; body?: string };
      const found = findByGlobalId(ctx, String(input.subjectId ?? ''));
      if (found === null) throw new Error('subject not found');
      const issue = ctx.store.getIssue(found.repo, found.number);
      if (issue === undefined) throw new Error('issue not found');
      const comment = ctx.store.addComment(found.repo, issue, String(input.body ?? ''));
      const cid = Buffer.from(`forge:comment:${found.repo.owner}:${found.repo.name}:${issue.number}:${comment.id}`, 'utf8').toString('base64url');
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node: { __typename: 'Comment', id: cid, body: comment.body } } };
    },
  },
};

function globalRepoId(repo: Repo): string {
  return Buffer.from(`forge:repo:${repo.owner}:${repo.name}`, 'utf8').toString('base64url');
}

const FIELD_SETS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  User: new Set(['login']),
  Repository: new Set(REPO_FIELDS),
  Issue: new Set(ISSUE_FIELDS),
  PullRequest: new Set(PR_FIELDS),
  __Type: new Set(['fields', 'enumValues', 'name']),
  Ref: new Set(['name']),
  IssueConnection: new Set(['nodes', 'pageInfo']),
  PullRequestConnection: new Set(['nodes', 'pageInfo']),
  PullRequestChangedFileConnection: new Set(['nodes']),
  PullRequestChangedFile: new Set(['path']),
  PageInfo: new Set(['hasNextPage', 'endCursor']),
  __Field: new Set(['name']),
  __EnumValue: new Set(['name']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  CommentEdge: new Set(['node']),
  Comment: new Set(['id', 'body']),
};

function selectObject(
  obj: AnyObj,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: Ctx,
  errors: { message: string }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = obj.__typename;
  const typeResolvers = resolvers[typeName] ?? {};
  const allowed = FIELD_SETS[typeName];
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.type === typeName) {
        Object.assign(out, selectObject(obj, sel.selections, variables, ctx, errors));
      }
      continue;
    }
    const f = sel.field;
    const key = f.alias ?? f.name;
    if (allowed !== undefined && !allowed.has(f.name)) {
      errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const resolver = typeResolvers[f.name];
    if (resolver === undefined) {
      // Plain property fallback (Ref.name, PageInfo, __Field.name, Comment...),
      // still resolving any sub-selections (e.g. connection nodes).
      const raw = (obj as Record<string, unknown>)[f.name];
      out[key] = raw === undefined ? null : resolveValue(raw, f.selections, variables, ctx, errors);
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const a of f.args) args[a.name] = evalValue(a.value, variables);
    try {
      const value = resolver(obj, args, ctx);
      out[key] = resolveValue(value, f.selections, variables, ctx, errors);
    } catch (e) {
      errors.push({ message: e instanceof Error ? e.message : String(e) });
      out[key] = null;
    }
  }
  return out;
}

function resolveValue(
  value: unknown,
  selections: SelectionNode[] | undefined,
  variables: Record<string, unknown>,
  ctx: Ctx,
  errors: { message: string }[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, selections, variables, ctx, errors));
  if (typeof value === 'object' && selections !== undefined) {
    return selectObject(value as AnyObj, selections, variables, ctx, errors);
  }
  return value;
}

export interface GraphQLOutcome {
  data: Record<string, unknown> | null;
  errors: { message: string }[];
}

/** Execute one parsed operation. */
export function executeGraphQL(
  query: string,
  variables: Record<string, unknown>,
  ctx: Ctx,
): GraphQLOutcome {
  const errors: { message: string }[] = [];
  let op: Operation;
  try {
    op = new Parser(tokenize(query)).parseOperation();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'parse error' }] };
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyObj = { __typename: rootType };
  const data = selectObject(root, op.selections, variables, ctx, errors);
  return { data, errors };
}
