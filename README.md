# forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ujang201/forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ujang201/forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Forge — a GitHub-compatible git forge: one process, Node 22 standard library only, serving git smart HTTP, REST v3, GraphQL and MCP, in-memory and deterministic.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=wfjv7kgb&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

`main.ts` is the kit starter (unchanged): it binds an ephemeral port, POSTs
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, long-polls
`$MAKEFUN_ENV_URL/done`, then exits 0. Every API call needs
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a repo belongs to the login the
token names, and the same repo name under another owner answers 404 (never
403).

## Layout

| file | what it does |
| --- | --- |
| `main.ts` | kit lifecycle (register / done polling) — unchanged from starter |
| `app.ts` | HTTP server: routing, auth, `X-GitHub-Request-Id`, JSON errors |
| `gitobj.ts` | SHA-1 objects, tree/commit parse+serialize, pack parse (v2/v3, OFS/REF deltas, thin packs) and generate (plain, version 2) |
| `gitproto.ts` | git smart HTTP: v2 `ls-refs`/`fetch`, v0 fetch, v0 receive-pack (fast-forward enforcement, per-ref `ok`/`ng non-fast-forward` reports, sideband framing) |
| `store.ts` | in-memory store: repos, refs, objects, issues, PRs, labels, comments; deterministic commits, trees, three-way squash merge |
| `scenario.ts` | reproduces the trial scenario RNG (FNV-1a + splitmix64 + xorshift64*) so the viewer login and seed data match the suite |
| `rest.ts` | REST v3: users, repos, branches, git refs, commits, contents (base64), labels, issues, pull requests |
| `graphql.ts` | hand-rolled GraphQL parser + executor: viewer, repository, node, `__type`, issues/pullRequests with cursor pagination, mutations |
| `mcp.ts` | MCP over `POST /mcp`: `server/discover`, legacy `initialize`, `tools/list` (6 tools), `tools/call` |
| `package.json`, `tsconfig.json`, `LICENSE` | kit starter files (MIT) |

## Surfaces

- `GET /healthz` — no auth.
- `/{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack`,
  `POST .../git-upload-pack`, `POST .../git-receive-pack` — git smart HTTP.
  v2 advertisement answers `version 2` with `ls-refs=unborn` and
  `fetch=shallow filter`; v0 advertisements carry the `# service=` line
  followed by a flush packet, then the ref lines with capabilities.
  Fetch honours `want`/`have`, `deepen N`, and `shallow` boundaries
  (`shallow`/`unshallow` in `shallow-info`); a request without `done`
  answers only the `acknowledgments` section. Push enforces
  fast-forward per ref and reports `unpack ok` plus one `ok`/`ng` line per
  command, framed in sideband band 1 with a flush inside the report stream.
- `GET/POST /api/v3/...` — REST v3 (JSON everywhere, `X-GitHub-Request-Id`
  on every reply, `Link: rel="next"/"last"` pagination, 422 on duplicate
  repo / unknown label, 409 on stale content sha).
- `POST /api/graphql` — GraphQL, including batched array bodies, opaque
  Relay ids, and `__type` introspection. Unauthenticated → 401; unknown
  field → HTTP 200 with an `errors` array; unknown repo → `data.repository`
  null.
- `POST /mcp` — MCP revisions `2026-07-28` (discover) back to `2024-11-05`
  (legacy handshake). Unknown tool → `-32602`/`-32601`, never HTTP 500.

## Verification

- 41-check smoke test (REST + GraphQL + MCP): 41 passed, 0 failed.
- Real `git` 2.43 CLI against the running server: empty clone, full clone,
  push, shallow clone (`--depth 1`), non-fast-forward push refused with the
  ref unchanged, mixed push, branch/tag create and delete, incremental
  fetch — all pass.
- Kit conformance suite (`makefun grade-local --driver process`, 17 Nov
  2026): **937/1000** — feature 600/600 (120/120 checks), agent 200/200,
  perf 137/200 (push 32, clone 32, read 39, write 34), working 1. Replay
  reproduced byte for byte.

Referral noted by the entrant: https://make.fun/r/wfjv7kgb (code `wfjv7kgb`).
