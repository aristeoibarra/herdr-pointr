# Contributing

Needs Go and Node.

```bash
npm install && npm run build
herdr plugin link .
```

Before opening a PR: `npm run typecheck && npm test`. CI runs the same.

- Commits and PR titles: conventional (`fix:`, `feat:`, `docs:`…).
- Routing changes (`bridge/routing.go`) need a test in `bridge/routing_test.go`: a routing bug
  sends feedback to the wrong agent without failing.
- `CLAUDE.md` explains how the pieces fit.
