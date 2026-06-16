# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start both Vite dev server and Express server concurrently
npm run build      # tsc -b && vite build && npm run build:server
npm run lint       # ESLint across the codebase
npm run start      # Run production server (node server-dist/index.js)
```

There is no test suite.

## Architecture

This is a full-stack TypeScript app: a React SPA (Vite) with a local Express + SQLite backend.

**Frontend** (`src/`) — React 19 + React Router 7. Five routes handled in `src/App.tsx`:
- `/` — CreateBracketPage
- `/brackets` — BracketsPage
- `/tournaments/:id` — AdminPage (scores, participants, reset, delete)
- `/tournaments/:id/display` — DisplayPage (read-only, refreshes every 4s)
- `/join/:joinCode` — JoinPage (public participant registration)

UI primitives live in `src/components/ui/` (shadcn-style: Card, Badge, Button, Input). Tailwind CSS 4 is used via `@tailwindcss/vite`.

**Backend** (`server/index.ts`) — a single-file Express 5 server with all route handlers, Zod validation, and the SQLite schema + migration inline. No ORM — raw `better-sqlite3` queries throughout. The DB schema has three tables: `tournaments`, `participants`, `matches`. Foreign keys are on; `participants` and `matches` cascade-delete with their tournament.

**Bracket logic** lives entirely in `server/index.ts`: seeding, match-tree construction (linking each match to its `next_match_id`/`next_slot`), winner advancement, and tie detection. Bracket sizes are fixed to [2, 4, 8, 16].

**Dev proxy** — Vite proxies `/api` to `http://localhost:5174` (the Express port). In production, Express serves the built `dist/` as static files and handles `/api` routes on the same port.

**Data** — SQLite file at `data/bracket.db` (git-ignored). Location overridden by `DATA_DIR` env var. Port overridden by `PORT` env var.

## TypeScript config

Three tsconfig files in a project-references setup:
- `tsconfig.json` — root references
- `tsconfig.app.json` — client (ES2023, bundler module resolution, react-jsx)
- `tsconfig.server.json` — server (Node target)
