# Forge — a GitHub-compatible git forge for github-core-clone-01

A standalone, single-process git forge with no UI and no dependencies beyond Node's standard
library. It serves, from one shared in-memory store:

| Route | Surface |
| --- | --- |
| `GET /healthz` | boot probe: `200 {"ok":true}` |
| `/<owner>/<repo>.git/...` | git smart HTTP: upload-pack protocol v2 (ls-refs, fetch with shallow support), a v0 fetch fallback, and receive-pack v0 with report-status |
| `/api/v3/...` | REST v3: repositories, branches, git refs, commits, contents, labels, issues, comments, pull requests and merges |
| `POST /api/graphql` | GraphQL v4: the documents `gh` and github-mcp-server send, Relay global ids, cursor pagination, and `__type` introspection |
| `POST /mcp` | Model Context Protocol (2026-07-28 `server/discover`, legacy `initialize` fallback): create_repo, get_repo, list_repos, create_issue, list_issues, create_pull_request, merge_pull_request |

Repositories are created over REST (a push cannot invent one). Issues and pull requests share one
number counter per repository, as on GitHub. Contents, merges and pull-request files all operate
on the real git object store, so an object written by a push is the same object the APIs read.

The token's login is learned from the first owner-named request that reaches an existing
repository; from then on the same repository name under another owner is 404, never 403.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry <-> env lifecycle (bind an ephemeral port, register it with
`$MAKEFUN_ENV_URL`, poll `/done`, exit 0). `app.ts` builds the server; the surfaces live in
`githttp.ts`, `rest.ts`, `graphql.ts` and `mcp.ts` over the store in `store.ts` and the git
object/pack codecs in `git.ts`. There is nothing to install.
