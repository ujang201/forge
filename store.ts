// The forge's store: repositories, git objects, refs, issues, pull requests,
// labels and comments. All in memory; one process, one trial. Deterministic:
// no wall clock and no Math.random anywhere — ordering comes from counters and
// timestamps derive from a fixed epoch plus a sequence number.

import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTree,
  serializeCommit,
  serializeTree,
  type CommitData,
  type TreeEntry,
} from './gitobj.ts';

export const DEFAULT_BRANCH = 'main';
const FIXED_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z
const GIT_IDENTITY = 'forge <forge@example.invalid>';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  id: string; // opaque Relay id
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number; // creation order
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string; // base tip at creation (merge-base)
  files: PullFile[];
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, { type: string; payload: Buffer }>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  seq: number; // shared issue+PR number counter
  createdSeq: number;
  gitVersion: number; // bumped on every object/ref change; invalidates the fetch pack cache
}

function globalId(kind: string, parts: string[]): string {
  return Buffer.from(`forge:${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

function isoAt(seq: number): string {
  return new Date((FIXED_EPOCH_SEC + seq) * 1000).toISOString();
}

export class Store {
  repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextCommentId = 1;
  private clock = 0;

  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const k = this.key(owner, name);
    if (this.repos.has(k)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      seq: 0,
      createdSeq: this.tick(),
      gitVersion: 0,
    };
    this.repos.set(k, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()]
      .filter((r) => r.owner === owner)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ------------------------------------------------------------ git objects

  /** Bump after any change to objects or refs (invalidates the fetch cache). */
  bumpGit(repo: Repo): void {
    repo.gitVersion += 1;
  }

  putObject(repo: Repo, type: string, payload: Buffer): string {
    const oid = hashObject(type, payload);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, payload });
      this.bumpGit(repo);
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): { type: string; payload: Buffer } | undefined {
    return repo.objects.get(oid);
  }

  putBlob(repo: Repo, content: Buffer): string {
    return this.putObject(repo, 'blob', content);
  }

  /** Build (or fetch) a tree from a flat path->oid map, creating intermediate trees. */
  buildTree(repo: Repo, files: Map<string, string>): string {
    // files: full path -> blob oid (or tree oid for subdirs handled recursively)
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, string>>();
      for (const [path, oid] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: '100644', name: rest, oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (sub === undefined) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, oid);
        }
      }
      for (const [dir, sub] of dirs) {
        const treeOid = build(`${prefix}${dir}/`);
        void sub;
        entries.push({ mode: '40000', name: dir, oid: treeOid });
      }
      const payload = serializeTree(entries);
      return this.putObject(repo, 'tree', payload);
    };
    return build('');
  }

  /** Flatten a tree into path -> {mode, oid}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.payload)) {
      if (e.mode === '40000') {
        for (const [p, v] of this.flattenTree(repo, e.oid, `${prefix}${e.name}/`)) out.set(p, v);
      } else {
        out.set(`${prefix}${e.name}`, { mode: e.mode, oid: e.oid });
      }
    }
    return out;
  }

  /** Apply path changes (oid, or null to delete) onto a base tree; returns new tree oid. */
  updateTree(repo: Repo, baseTreeOid: string | null, changes: Map<string, string | null>): string {
    const files = new Map<string, string>();
    if (baseTreeOid !== null) {
      for (const [p, v] of this.flattenTree(repo, baseTreeOid)) files.set(p, v.oid);
    }
    for (const [p, v] of changes) {
      if (v === null) files.delete(p);
      else files.set(p, v);
    }
    return this.buildTree(repo, files);
  }

  createCommit(
    repo: Repo,
    tree: string,
    parents: string[],
    message: string,
    epochSec?: number,
  ): string {
    const ts = epochSec ?? FIXED_EPOCH_SEC + this.tick();
    const ident = `${GIT_IDENTITY} ${ts} +0000`;
    const data: CommitData = { tree, parents, author: ident, committer: ident, message };
    return this.putObject(repo, 'commit', serializeCommit(data));
  }

  getCommit(repo: Repo, oid: string): CommitData | undefined {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return parseCommit(obj.payload);
  }

  /** True when `anc` is reachable from `desc` (or equal). */
  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === anc) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const c = this.getCommit(repo, cur);
      if (c !== undefined) stack.push(...c.parents);
    }
    return false;
  }

  /** Commits newest-first from a tip, following first parents only for listing. */
  listCommits(repo: Repo, tip: string, limit = 100): { sha: string; message: string }[] {
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const c = this.getCommit(repo, cur);
      if (c === undefined) continue;
      out.push({ sha: cur, message: c.message });
      stack.push(...c.parents);
    }
    return out;
  }

  /** All objects reachable from the given tips (commits, trees, blobs). */
  reachableObjects(repo: Repo, tips: string[]): Map<string, { type: string; payload: Buffer }> {
    const out = new Map<string, { type: string; payload: Buffer }>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      out.set(oid, obj);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.payload);
        stack.push(c.tree, ...c.parents);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.payload)) stack.push(e.oid);
      }
    }
    return out;
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  // ------------------------------------------------------------ files at ref

  /** Read a file's blob at a ref (branch name, ref, or commit oid). */
  readFileAt(repo: Repo, ref: string, path: string): { oid: string; content: Buffer } | undefined {
    const tip = this.resolveRefToCommit(repo, ref);
    if (tip === undefined) return undefined;
    const commit = this.getCommit(repo, tip);
    if (commit === undefined) return undefined;
    const flat = this.flattenTree(repo, commit.tree);
    const entry = flat.get(path);
    if (entry === undefined) return undefined;
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined || blob.type !== 'blob') return undefined;
    return { oid: entry.oid, content: blob.payload };
  }

  /** List a directory's entries at a ref. */
  listDirAt(
    repo: Repo,
    ref: string,
    path: string,
  ): { type: 'file' | 'dir'; name: string; path: string; oid: string }[] | undefined {
    const tip = this.resolveRefToCommit(repo, ref);
    if (tip === undefined) return undefined;
    const commit = this.getCommit(repo, tip);
    if (commit === undefined) return undefined;
    const flat = this.flattenTree(repo, commit.tree);
    const prefix = path === '' ? '' : `${path}/`;
    const out = new Map<string, { type: 'file' | 'dir'; name: string; path: string; oid: string }>();
    for (const [p, v] of flat) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        out.set(rest, { type: 'file', name: rest, path: p, oid: v.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!out.has(dir)) {
          // tree oid for the directory: rebuild path lookup
          const dirOid = this.dirOidAt(repo, commit.tree, `${prefix}${dir}`);
          out.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, oid: dirOid ?? ZERO_OID });
        }
      }
    }
    return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private dirOidAt(repo: Repo, treeOid: string, dirPath: string): string | undefined {
    const parts = dirPath.split('/').filter((p) => p !== '');
    let cur = treeOid;
    for (const part of parts) {
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'tree') return undefined;
      const e = parseTree(obj.payload).find((x) => x.name === part && x.mode === '40000');
      if (e === undefined) return undefined;
      cur = e.oid;
    }
    return cur;
  }

  /** Resolve a branch name, full ref, or commit oid to a commit oid. */
  resolveRefToCommit(repo: Repo, ref: string): string | undefined {
    if (repo.objects.has(ref)) {
      const o = repo.objects.get(ref)!;
      return o.type === 'commit' ? ref : undefined;
    }
    const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
    for (const c of candidates) {
      const oid = repo.refs.get(c);
      if (oid !== undefined) return oid;
    }
    return undefined;
  }

  // ------------------------------------------------------------ contents API

  /**
   * Write a file on a branch (creating the branch's first commit when unborn).
   * Returns {blobOid, commitOid, created} or {error:'stale-sha'}.
   */
  writeFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { blobOid: string; commitOid: string; created: boolean } | { error: 'stale-sha' } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    let baseTree: string | null = null;
    let parents: string[] = [];
    let created = true;
    if (tip !== undefined) {
      const commit = this.getCommit(repo, tip);
      if (commit === undefined) return { error: 'stale-sha' };
      baseTree = commit.tree;
      parents = [tip];
      const flat = this.flattenTree(repo, commit.tree);
      const existing = flat.get(path);
      if (expectedSha !== undefined) {
        if (existing === undefined || existing.oid.toLowerCase() !== expectedSha.toLowerCase()) {
          return { error: 'stale-sha' };
        }
        created = false;
      } else if (existing !== undefined) {
        created = false;
      }
    } else {
      // A new branch forks from the default branch's tip when the repo has one.
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) {
        const commit = this.getCommit(repo, defaultTip);
        if (commit !== undefined) {
          baseTree = commit.tree;
          parents = [defaultTip];
        }
      }
    }
    const blobOid = this.putBlob(repo, content);
    const treeOid = this.updateTree(repo, baseTree, new Map([[path, blobOid]]));
    const commitOid = this.createCommit(repo, treeOid, parents, message);
    repo.refs.set(ref, commitOid);
    this.bumpGit(repo);
    return { blobOid, commitOid, created };
  }

  /** Delete a file on a branch. Returns the new commit oid, or null when absent. */
  deleteFile(repo: Repo, branch: string, path: string, message: string, expectedSha?: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const commit = this.getCommit(repo, tip);
    if (commit === undefined) return null;
    const flat = this.flattenTree(repo, commit.tree);
    const existing = flat.get(path);
    if (existing === undefined) return null;
    if (expectedSha !== undefined && existing.oid.toLowerCase() !== expectedSha.toLowerCase()) return null;
    const treeOid = this.updateTree(repo, commit.tree, new Map([[path, null]]));
    const commitOid = this.createCommit(repo, treeOid, [tip], message);
    repo.refs.set(ref, commitOid);
    this.bumpGit(repo);
    return commitOid;
  }

  // ------------------------------------------------------------ issues / PRs

  nextNumber(repo: Repo): number {
    repo.seq += 1;
    return repo.seq;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = this.nextNumber(repo);
    const seq = this.tick();
    const issue: Issue = {
      id: globalId('issue', [repo.owner, repo.name, String(number)]),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq,
      createdAt: isoAt(seq),
      updatedAt: isoAt(seq),
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body };
    issue.comments.push(comment);
    return comment;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    headSha: string,
    baseRef: string,
    baseSha: string,
    files: PullFile[],
  ): Pull {
    const number = this.nextNumber(repo);
    const pull: Pull = {
      id: globalId('pull', [repo.owner, repo.name, String(number)]),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      files,
      seq: this.tick(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  /** Compute the file diff between base commit and head commit (path -> head blob oid). */
  diffFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
    const base = this.getCommit(repo, baseSha);
    const head = this.getCommit(repo, headSha);
    if (base === undefined || head === undefined) return [];
    const baseFlat = this.flattenTree(repo, base.tree);
    const headFlat = this.flattenTree(repo, head.tree);
    const files: PullFile[] = [];
    for (const [path, entry] of headFlat) {
      const b = baseFlat.get(path);
      if (b === undefined) {
        const blob = repo.objects.get(entry.oid);
        files.push({ filename: path, status: 'added', additions: countLines(blob?.payload), deletions: 0, changes: countLines(blob?.payload) });
      } else if (b.oid !== entry.oid) {
        const oldBlob = repo.objects.get(b.oid);
        const newBlob = repo.objects.get(entry.oid);
        const add = countLines(newBlob?.payload);
        const del = countLines(oldBlob?.payload);
        files.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del });
      }
    }
    return files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  }

  /** True when a squash merge of this pull would conflict. */
  wouldConflict(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return true;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseCommit = this.getCommit(repo, pull.baseSha);
    const headCommit = this.getCommit(repo, headTip);
    const tipCommit = this.getCommit(repo, baseTip);
    if (baseCommit === undefined || headCommit === undefined || tipCommit === undefined) return true;
    const baseFlat = this.flattenTree(repo, baseCommit.tree);
    const headFlat = this.flattenTree(repo, headCommit.tree);
    const tipFlat = this.flattenTree(repo, tipCommit.tree);
    const changed = new Set<string>();
    for (const [p] of headFlat) changed.add(p);
    for (const [p] of baseFlat) changed.add(p);
    for (const p of changed) {
      const b = baseFlat.get(p)?.oid;
      const h = headFlat.get(p)?.oid;
      const t = tipFlat.get(p)?.oid;
      if (h === b) continue;
      if (t === b || t === h) continue;
      return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit
   * oid, or null when the merge conflicts (a file changed on both sides differently).
   */
  squashMerge(repo: Repo, pull: Pull): string | null {
    if (this.wouldConflict(repo, pull)) return null;
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseTip = repo.refs.get(baseRef);
    if (baseTip === undefined) return null;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseCommit = this.getCommit(repo, pull.baseSha);
    const headCommit = this.getCommit(repo, headTip);
    const tipCommit = this.getCommit(repo, baseTip);
    if (baseCommit === undefined || headCommit === undefined || tipCommit === undefined) return null;
    const baseFlat = this.flattenTree(repo, baseCommit.tree);
    const headFlat = this.flattenTree(repo, headCommit.tree);
    const tipFlat = this.flattenTree(repo, tipCommit.tree);
    const merged = new Map<string, string>();
    for (const [p, v] of tipFlat) merged.set(p, v.oid);
    // Apply each head-side change with three-way conflict detection.
    const changed = new Set<string>();
    for (const [p] of headFlat) changed.add(p);
    for (const [p] of baseFlat) changed.add(p);
    for (const p of changed) {
      const b = baseFlat.get(p)?.oid;
      const h = headFlat.get(p)?.oid;
      const t = tipFlat.get(p)?.oid;
      if (h === b) continue; // unchanged on head side
      if (t === b || t === h) {
        // tip untouched since base, or tip already equals head: take head
        if (h === undefined) merged.delete(p);
        else merged.set(p, h);
      } else {
        return null; // both sides changed it differently: conflict
      }
    }
    const treeOid = this.buildTree(repo, merged);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const commitOid = this.createCommit(repo, treeOid, [baseTip], message);
    repo.refs.set(baseRef, commitOid);
    this.bumpGit(repo);
    pull.state = 'closed';
    pull.merged = true;
    const seq = this.tick();
    pull.mergedAt = isoAt(seq);
    pull.mergeCommitSha = commitOid;
    return commitOid;
  }
}

function countLines(payload: Buffer | undefined): number {
  if (payload === undefined || payload.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < payload.length; i++) if (payload[i] === 0x0a) n += 1;
  return n + 1;
}
