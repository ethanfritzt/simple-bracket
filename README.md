# Simple Bracket

A small Challonge-inspired single-elimination bracket app with React, Tailwind, shadcn-style UI components, Express, and local SQLite persistence.

## Run Locally

```bash
npm install
npm run dev
```

The React app runs through Vite and proxies `/api` requests to the local Express server. SQLite data is stored at `data/bracket.db` and is ignored by git.

Open the create page at `/`, the saved brackets page at `/brackets`, a bracket admin view at `/tournaments/:id`, the participant join page at `/join/:joinCode`, and the read-only live view at `/tournaments/:id/display`.

## Environment Variables

- `PORT`: Express server port. Defaults to `5174`.
- `DATA_DIR`: Directory used for the SQLite database. Defaults to `data` in the current working directory.

## Useful Commands

```bash
npm run lint
npm run build
```

## Features

- Dedicated create page for new brackets
- Saved brackets page for past and active brackets
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

## Main Routes

- `/`: Create a new bracket and generate a join link.
- `/brackets`: Browse saved, active, and completed brackets.
- `/tournaments/:id`: Manage a selected bracket, participant registration, scores, display mode, reset, and deletion.
- `/tournaments/:id/display`: Read-only live bracket display that refreshes every 4 seconds.
- `/join/:joinCode`: Public participant registration page.

## API Overview

- `GET /api/tournaments`: List saved brackets with participant counts.
- `POST /api/tournaments`: Create a new bracket registration page.
- `GET /api/tournaments/:id`: Load bracket state, participants, and matches.
- `POST /api/tournaments/:id/start`: Start a bracket after at least two participants join.
- `POST /api/tournaments/:id/reset`: Reset scores and winners for a bracket.
- `DELETE /api/tournaments/:id`: Delete a bracket.
- `GET /api/join/:joinCode`: Load public join page data.
- `POST /api/join/:joinCode`: Register a participant.
- `PUT /api/participants/:id`: Rename a participant.
- `DELETE /api/participants/:id`: Remove a participant before the bracket starts.
- `PUT /api/matches/:id`: Save scores and winners.
