// GitHub REST v3 API under /api/v3. Handlers are plain functions taking a
// request context; app.ts owns HTTP plumbing, auth and the request id.

import { isOid } from './gitobj.ts';
import { viewerLogin } from './scenario.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

export interface RestCtx {
  store: Store;
  viewer: string;
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: unknown; // parsed JSON body, or undefined when no body
  bodyMalformed: boolean;
  host: string; // request Host header, for absolute pagination links
}

export interface RestResult {
  status: number;
  body: unknown; // JSON value; undefined => empty body
  headers?: Record<string, string>;
}

const noContent = (status: number, headers?: Record<string, string>): RestResult => ({ status, body: undefined, headers });
const json = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => json(status, { message });

function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: 1000, type: 'User' },
    private: r.private,
    description: r.description,
    default_branch: r.defaultBranch,
    has_issues: true,
    html_url: `https://github.example/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function issueJson(i: Issue): Record<string, unknown> {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((name) => ({ name })),
    comments: i.comments.length,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
  };
}

function pullJson(p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    number: p.number,
    state: p.state,
    title: p.title,
    body: p.body,
    head: { ref: p.headRef, sha: p.headSha, label: p.headRef },
    base: { ref: p.baseRef, sha: p.baseSha, label: p.baseRef },
    merged: p.merged,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
  };
}

function asObject(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function intParam(q: URLSearchParams, name: string, fallback: number): number {
  const v = q.get(name);
  if (v === null) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build a Link header for pagination (rel next/last), or '' when one page. */
function pageLink(ctx: RestCtx, page: number, perPage: number, totalPages: number): string {
  if (totalPages <= 1) return '';
  const base = `http://${ctx.host}/api/v3/${ctx.segments.join('/')}`;
  const mk = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${base}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${mk(page + 1)}>; rel="next"`);
  parts.push(`<${mk(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(ctx: RestCtx, items: T[]): { page: T[]; link: string } {
  const perPage = intParam(ctx.query, 'per_page', 30);
  const page = intParam(ctx.query, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), link: pageLink(ctx, page, perPage, totalPages) };
}

/** Look a repo up; a name under any owner other than the viewer is 404, never 403. */
function findRepo(ctx: RestCtx, owner: string, name: string): Repo | undefined {
  if (owner !== ctx.viewer) return undefined;
  return ctx.store.getRepo(owner, name);
}

export function handleRest(ctx: RestCtx): RestResult {
  const { method, segments: s } = ctx;

  // API root and meta need no auth (the suite calls them either way).
  if (method === 'GET' && s.length === 0) {
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (method === 'GET' && s.length === 1 && s[0] === 'meta') {
    return json(200, { installed_version: '1.0.0' });
  }
  if (method === 'GET' && s.length === 1 && s[0] === 'user') {
    return json(200, { login: ctx.viewer, id: 1000, type: 'User' });
  }

  if (ctx.bodyMalformed) return err(400, 'Problems parsing JSON');

  // ---- /user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(ctx, ctx.store.listRepos(ctx.viewer));
      return json(200, page.map(repoJson), link === '' ? {} : { link });
    }
    if (method === 'POST') {
      const b = asObject(ctx.body);
      const name = str(b?.name);
      if (name === '') return err(400, 'name is required');
      const created = ctx.store.createRepo(ctx.viewer, name, str(b?.description), b?.private === true);
      if (created === null) return err(422, 'Repository creation failed. Name already exists on this account.');
      return json(201, repoJson(created));
    }
  }

  // ---- /repos/{owner}/{repo}...
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = decodeURIComponent(s[1]);
    const name = decodeURIComponent(s[2]);
    const repo = findRepo(ctx, owner, name);
    const rest = s.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (repo === undefined) return err(404, 'Not Found');
        return json(200, repoJson(repo));
      }
      if (method === 'PATCH') {
        if (repo === undefined) return err(404, 'Not Found');
        const b = asObject(ctx.body);
        if (b !== null && typeof b.description === 'string') repo.description = b.description;
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (repo === undefined) return err(404, 'Not Found');
        ctx.store.deleteRepo(owner, name);
        return noContent(204);
      }
      return err(404, 'Not Found');
    }

    if (repo === undefined) return err(404, 'Not Found');

    // branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const list: { name: string; commit: { sha: string } }[] = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) list.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      list.sort((a, b) => (a.name < b.name ? -1 : 1));
      return json(200, list);
    }
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      const branch = decodeURIComponent(rest[1]);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return json(200, { name: branch, commit: { sha } });
    }

    // git refs
    if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const b = asObject(ctx.body);
        const ref = str(b?.ref);
        const sha = str(b?.sha);
        if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'Invalid ref or sha');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (repo.objects.get(sha)?.type !== 'commit') return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        repo.gitVersion += 1;
        return json(201, { ref, object: { sha } });
      }
      if (method === 'GET' && rest.length >= 3) {
        const refPath = rest.slice(2).map(decodeURIComponent).join('/');
        const ref = `refs/${refPath}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return err(404, 'Not Found');
        return json(200, { ref, object: { sha } });
      }
      return err(404, 'Not Found');
    }

    // commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const shaParam = ctx.query.get('sha');
      const tip = shaParam !== null ? ctx.store.resolveRefToCommit(repo, shaParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return json(200, []);
      const list = ctx.store.listCommits(repo, tip).map((c) => ({ sha: c.sha, commit: { message: c.message } }));
      return json(200, list);
    }

    // contents
    if (rest.length >= 2 && rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      const branch = ctx.query.get('ref') ?? str(asObject(ctx.body)?.branch) ?? repo.defaultBranch;
      if (method === 'GET') {
        const ref = ctx.query.get('ref') ?? repo.defaultBranch;
        const file = ctx.store.readFileAt(repo, ref, path);
        if (file !== undefined) {
          return json(200, {
            type: 'file',
            encoding: 'base64',
            content: file.content.toString('base64'),
            sha: file.oid,
            size: file.content.length,
            name: path.split('/').pop() ?? path,
            path,
          });
        }
        const dir = ctx.store.listDirAt(repo, ref, path);
        if (dir !== undefined && dir.length > 0) {
          return json(200, dir.map((d) => ({ type: d.type, name: d.name, path: d.path, sha: d.oid })));
        }
        return err(404, 'Not Found');
      }
      if (method === 'PUT') {
        const b = asObject(ctx.body);
        if (b === null || typeof b.content !== 'string' || typeof b.message !== 'string') return err(400, 'content and message are required');
        const content = Buffer.from(b.content.replace(/[\r\n\t ]+/g, ''), 'base64');
        const result = ctx.store.writeFile(repo, branch || repo.defaultBranch, path, content, b.message, typeof b.sha === 'string' ? b.sha : undefined);
        if ('error' in result) return err(409, 'Conflict: stale sha');
        return json(result.created ? 201 : 200, { content: { sha: result.blobOid, encoding: 'base64' }, commit: { sha: result.commitOid } });
      }
      if (method === 'DELETE') {
        const b = asObject(ctx.body);
        const sha = ctx.store.deleteFile(repo, branch || repo.defaultBranch, path, str(b?.message), typeof b?.sha === 'string' ? b.sha : undefined);
        if (sha === null) return err(404, 'Not Found');
        return json(200, { commit: { sha } });
      }
      return err(404, 'Not Found');
    }

    // labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      if (method === 'POST') {
        const b = asObject(ctx.body);
        const name = str(b?.name);
        if (name === '') return err(400, 'name is required');
        const label = { name, color: typeof b?.color === 'string' ? b.color : 'ededed' };
        repo.labels.set(name, label);
        return json(201, { name: label.name, color: label.color });
      }
    }

    // issues
    if (rest.length >= 1 && rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { page } = paginate(ctx, list);
          return json(200, page.map(issueJson));
        }
        if (method === 'POST') {
          const b = asObject(ctx.body);
          const title = str(b?.title);
          if (title === '') return err(400, 'title is required');
          const labels: string[] = Array.isArray(b?.labels) ? (b.labels as unknown[]).map((l) => String(l)) : [];
          for (const l of labels) if (!repo.labels.has(l)) return err(422, `Label "${l}" does not exist`);
          const issue = ctx.store.createIssue(repo, title, str(b?.body), labels);
          return json(201, issueJson(issue));
        }
      }
      const num = parseInt(rest[1] ?? '', 10);
      if (Number.isInteger(num)) {
        const issue = ctx.store.getIssue(repo, num);
        if (rest.length === 2) {
          if (method === 'GET') {
            if (issue === undefined) return err(404, 'Not Found');
            return json(200, issueJson(issue));
          }
          if (method === 'PATCH') {
            if (issue === undefined) return err(404, 'Not Found');
            const b = asObject(ctx.body);
            if (b !== null && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
            return json(200, { number: issue.number, state: issue.state });
          }
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (issue === undefined) return err(404, 'Not Found');
          if (method === 'GET') return json(200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
          if (method === 'POST') {
            const b = asObject(ctx.body);
            const comment = ctx.store.addComment(repo, issue, str(b?.body));
            return json(201, { id: comment.id, body: comment.body });
          }
        }
      }
      return err(404, 'Not Found');
    }

    // pulls
    if (rest.length >= 1 && rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          const { page } = paginate(ctx, list);
          return json(200, page.map(pullJson));
        }
        if (method === 'POST') {
          const b = asObject(ctx.body);
          const head = str(b?.head);
          const base = str(b?.base) || repo.defaultBranch;
          if (head === '') return err(400, 'head is required');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch does not exist');
          const files = ctx.store.diffFiles(repo, baseSha, headSha);
          const pull = ctx.store.createPull(repo, str(b?.title), str(b?.body), head, headSha, base, baseSha, files);
          return json(201, pullJson(pull));
        }
      }
      const num = parseInt(rest[1] ?? '', 10);
      if (Number.isInteger(num)) {
        const pull = ctx.store.getPull(repo, num);
        if (rest.length === 2) {
          if (method === 'GET') {
            if (pull === undefined) return err(404, 'Not Found');
            return json(200, pullJson(pull));
          }
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          if (pull === undefined) return err(404, 'Not Found');
          return json(200, pull.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })));
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (pull === undefined) return err(404, 'Not Found');
          if (pull.merged) return json(200, { merged: true, sha: pull.mergeCommitSha, message: 'Pull request already merged' });
          const sha = ctx.store.squashMerge(repo, pull);
          if (sha === null) return err(405, 'Merge conflict');
          return json(200, { merged: true, sha, message: `Merged pull request #${pull.number}` });
        }
      }
      return err(404, 'Not Found');
    }
  }

  return err(404, 'Not Found');
}

/** The viewer login (scenario users[0]); exported for app.ts auth. */
export function defaultViewer(): string {
  return viewerLogin();
}
