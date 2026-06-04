# Simple Bracket

A small Challonge-inspired single-elimination bracket app with React, Tailwind, shadcn-style UI components, Express, and local SQLite persistence.

## Run Locally

```bash
npm install
npm run dev
```

The React app runs through Vite and proxies `/api` requests to the local Express server. SQLite data is stored at `data/bracket.db` and is ignored by git.

Open the admin view at `/tournaments/:id`, the participant join page at `/join/:joinCode`, and the read-only live view at `/tournaments/:id/display`.

## Useful Commands

```bash
npm run lint
npm run build
```

## Features

- Multiple saved tournaments
- Host-created join links for participant registration
- Public participant join page
- Host-controlled bracket start
- Start with open slots as TBD/byes
- Direct tournament URLs
- Read-only display mode that refreshes every 4 seconds
- Editable participant names
- Editable scores
- Match status badges for pending, ready, and completed matches
- Automatic winner selection from non-tied scores
- Tie warning with manual winner selection
- Winner advancement into future rounds
- Champion display
- Tournament completion when the final winner is selected
- Completed bracket edit lock with manual unlock
- Per-tournament reset that preserves participant names
- Tournament deletion
- Local SQLite-backed data model
