# github-forge-makefun

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bugzeros/github-forge-makefun/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bugzeros/github-forge-makefun/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process with no dependencies: smart-HTTP clone/push (protocol v2 and v0, packfiles with deltas), REST v3 (repositories, branches, commits, contents, issues, labels, pull requests, merges), GraphQL v4 (the documents `gh` and `github-mcp-server` send), and MCP over streamable HTTP (initialize, server/discover, tools/list, tools/call). In-memory store, deterministic state, cached clone packs for speed.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=jw0ack1e&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
