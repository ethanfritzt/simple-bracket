import Database from 'better-sqlite3'
import cors from 'cors'
import express from 'express'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const app = express()
const port = Number(process.env.PORT ?? 5174)
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
const dbPath = path.join(dataDir, 'bracket.db')
const distDir = path.join(process.cwd(), 'dist')

mkdirSync(dataDir, { recursive: true })

const db = new Database(dbPath)
db.pragma('foreign_keys = ON')

type MatchRow = {
  id: number
  tournament_id: number
  round: number
  position: number
  player1_id: number | null
  player2_id: number | null
  player1_score: number | null
  player2_score: number | null
  winner_id: number | null
  next_match_id: number | null
  next_slot: 1 | 2 | null
}

type ParticipantRow = {
  id: number
  tournament_id: number
  seed: number
  name: string
}

const bracketSizes = [2, 4, 8, 16] as const
const maxBracketSize = bracketSizes[bracketSizes.length - 1]

const participantSchema = z.object({
  name: z.string().trim().min(1).max(80),
})

const matchSchema = z.object({
  player1Score: z.number().int().min(0).max(999).nullable(),
  player2Score: z.number().int().min(0).max(999).nullable(),
  winnerId: z.number().int().positive().nullable(),
})

const createTournamentSchema = z.object({
  name: z.string().trim().min(1).max(100),
})

const joinSchema = z.object({
  name: z.string().trim().min(1).max(80),
})

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      format TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      seed INTEGER NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      position INTEGER NOT NULL,
      player1_id INTEGER REFERENCES participants(id),
      player2_id INTEGER REFERENCES participants(id),
      player1_score INTEGER,
      player2_score INTEGER,
      winner_id INTEGER REFERENCES participants(id),
      next_match_id INTEGER REFERENCES matches(id),
      next_slot INTEGER CHECK(next_slot IN (1, 2))
    );
  `)

  const columns = db.prepare('PRAGMA table_info(tournaments)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'bracket_size')) {
    db.exec('ALTER TABLE tournaments ADD COLUMN bracket_size INTEGER NOT NULL DEFAULT 8')
  }
  if (!columns.some((column) => column.name === 'completed_at')) {
    db.exec('ALTER TABLE tournaments ADD COLUMN completed_at TEXT')
  }
  if (!columns.some((column) => column.name === 'join_code')) {
    db.exec('ALTER TABLE tournaments ADD COLUMN join_code TEXT')
  }
  if (!columns.some((column) => column.name === 'registration_status')) {
    db.exec("ALTER TABLE tournaments ADD COLUMN registration_status TEXT NOT NULL DEFAULT 'started'")
  }

  const tournamentsWithoutJoinCodes = db
    .prepare("SELECT id FROM tournaments WHERE join_code IS NULL OR join_code = ''")
    .all() as { id: number }[]
  tournamentsWithoutJoinCodes.forEach((tournament) => {
    db.prepare('UPDATE tournaments SET join_code = ? WHERE id = ?').run(createJoinCode(), tournament.id)
  })
}

function bracketSizeForParticipantCount(count: number) {
  return bracketSizes.find((size) => count <= size) ?? maxBracketSize
}

function getState(tournamentId: number) {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId)
  if (!tournament) return null

  const participants = db
    .prepare('SELECT * FROM participants WHERE tournament_id = ? ORDER BY seed')
    .all(tournamentId)
  const matches = db
    .prepare('SELECT * FROM matches WHERE tournament_id = ? ORDER BY round, position')
    .all(tournamentId) as MatchRow[]

  return {
    tournament,
    participants,
    matches: matches.map((match) => ({
      ...match,
      status: match.winner_id ? 'completed' : match.player1_id || match.player2_id ? 'ready' : 'pending',
    })),
  }
}

function createJoinCode() {
  return randomBytes(4).toString('hex')
}

function createTournament(name: string, rawParticipants: string[] = []) {
  const create = db.transaction(() => {
    const bracketSize = rawParticipants.length > 0
      ? bracketSizeForParticipantCount(rawParticipants.length)
      : maxBracketSize
    const tournamentId = Number(
      db
        .prepare(
          'INSERT INTO tournaments (name, format, status, bracket_size, join_code, registration_status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          name,
          'Single Elimination',
          rawParticipants.length > 0 ? 'In Progress' : 'Registration',
          bracketSize,
          createJoinCode(),
          rawParticipants.length > 0 ? 'started' : 'open',
        ).lastInsertRowid,
    )

    rawParticipants.forEach((participantName, index) => {
      db.prepare('INSERT INTO participants (tournament_id, seed, name) VALUES (?, ?, ?)').run(
        tournamentId,
        index + 1,
        participantName,
      )
    })
    if (rawParticipants.length > 0) generateMatches(tournamentId, bracketSize)

    return tournamentId
  })

  return create()
}

function getTournamentSeeds(size: number): number[] {
  let seeds = [1, 2]
  let currentSize = 2
  while (currentSize < size) {
    currentSize *= 2
    seeds = seeds.flatMap(s => [s, currentSize + 1 - s])
  }
  return seeds
}

function generateMatches(tournamentId: number, size: number) {
  db.prepare('DELETE FROM matches WHERE tournament_id = ?').run(tournamentId)

  const participantIdsBySeed = new Map<number, number>()
  const participants = db
    .prepare('SELECT * FROM participants WHERE tournament_id = ? ORDER BY seed')
    .all(tournamentId) as ParticipantRow[]

  const participantIds = participants.map(p => p.id)
  for (let i = participantIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [participantIds[i], participantIds[j]] = [participantIds[j], participantIds[i]]
  }
  participantIds.forEach((id, index) => participantIdsBySeed.set(index + 1, id))

  const seeds = getTournamentSeeds(size)
  const insertMatch = db.prepare(`
    INSERT INTO matches
      (tournament_id, round, position, player1_id, player2_id, player1_score, player2_score, winner_id, next_match_id, next_slot)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
  `)
  const matchIds = new Map<string, number>()
  const totalRounds = Math.log2(size)

  for (let round = 1; round <= totalRounds; round += 1) {
    const matchCount = size / 2 ** round
    for (let position = 1; position <= matchCount; position += 1) {
      const player1Id = round === 1 ? participantIdsBySeed.get(seeds[(position - 1) * 2]) ?? null : null
      const player2Id = round === 1 ? participantIdsBySeed.get(seeds[(position - 1) * 2 + 1]) ?? null : null
      const id = Number(
        insertMatch.run(tournamentId, round, position, player1Id, player2Id).lastInsertRowid,
      )
      matchIds.set(`${round}:${position}`, id)
    }
  }

  const updateProgression = db.prepare(
    'UPDATE matches SET next_match_id = ?, next_slot = ? WHERE id = ?',
  )
  for (let round = 1; round < totalRounds; round += 1) {
    const matchCount = size / 2 ** round
    for (let position = 1; position <= matchCount; position += 1) {
      const matchId = matchIds.get(`${round}:${position}`)
      const nextMatchId = matchIds.get(`${round + 1}:${Math.ceil(position / 2)}`)
      if (matchId && nextMatchId) {
        updateProgression.run(nextMatchId, position % 2 === 1 ? 1 : 2, matchId)
      }
    }
  }

  const byeMatches = db
    .prepare(
      `SELECT * FROM matches WHERE tournament_id = ? AND round = 1
       AND ((player1_id IS NOT NULL AND player2_id IS NULL) OR (player1_id IS NULL AND player2_id IS NOT NULL))`,
    )
    .all(tournamentId) as MatchRow[]

  for (const match of byeMatches) {
    const winnerId = match.player1_id ?? match.player2_id
    db.prepare('UPDATE matches SET winner_id = ? WHERE id = ?').run(winnerId, match.id)
    if (match.next_match_id && match.next_slot) {
      const slotColumn = match.next_slot === 1 ? 'player1_id' : 'player2_id'
      db.prepare(`UPDATE matches SET ${slotColumn} = ? WHERE id = ?`).run(winnerId, match.next_match_id)
    }
  }

  updateTournamentStatus(tournamentId)
}

function joinTournament(joinCode: string, name: string) {
  const join = db.transaction(() => {
    const tournament = db
      .prepare('SELECT id, registration_status FROM tournaments WHERE join_code = ?')
      .get(joinCode) as
      | { id: number; registration_status: string }
      | undefined
    if (!tournament || tournament.registration_status !== 'open') return null

    const count = db
      .prepare('SELECT COUNT(*) as count FROM participants WHERE tournament_id = ?')
      .get(tournament.id) as { count: number }
    if (count.count >= maxBracketSize) return null

    db.prepare('INSERT INTO participants (tournament_id, seed, name) VALUES (?, ?, ?)').run(
      tournament.id,
      count.count + 1,
      name,
    )

    return tournament.id
  })

  return join()
}

function removeParticipant(participantId: number) {
  const remove = db.transaction(() => {
    const participant = db
      .prepare('SELECT tournament_id FROM participants WHERE id = ?')
      .get(participantId) as { tournament_id: number } | undefined
    if (!participant) return null

    const tournament = db
      .prepare('SELECT registration_status FROM tournaments WHERE id = ?')
      .get(participant.tournament_id) as { registration_status: string } | undefined
    if (!tournament || tournament.registration_status === 'started') return null

    db.prepare('DELETE FROM participants WHERE id = ?').run(participantId)
    const participants = db
      .prepare('SELECT id FROM participants WHERE tournament_id = ? ORDER BY seed, id')
      .all(participant.tournament_id) as { id: number }[]
    participants.forEach((row, index) => {
      db.prepare('UPDATE participants SET seed = ? WHERE id = ?').run(index + 1, row.id)
    })

    return participant.tournament_id
  })

  return remove()
}

function startTournament(tournamentId: number) {
  const start = db.transaction(() => {
    const tournament = db
      .prepare('SELECT registration_status FROM tournaments WHERE id = ?')
      .get(tournamentId) as { registration_status: string } | undefined
    if (!tournament || tournament.registration_status === 'started') return false

    const count = db
      .prepare('SELECT COUNT(*) as count FROM participants WHERE tournament_id = ?')
      .get(tournamentId) as { count: number }
    if (count.count < 2) return false

    const bracketSize = bracketSizeForParticipantCount(count.count)
    db.prepare(
      "UPDATE tournaments SET status = 'In Progress', registration_status = 'started', bracket_size = ?, completed_at = NULL WHERE id = ?",
    ).run(bracketSize, tournamentId)
    generateMatches(tournamentId, bracketSize)

    return true
  })

  return start()
}

function resetTournament(tournamentId: number) {
  const reset = db.transaction(() => {
    const tournament = db
      .prepare('SELECT bracket_size FROM tournaments WHERE id = ?')
      .get(tournamentId) as { bracket_size: number } | undefined
    if (!tournament) return false

    db.prepare('UPDATE tournaments SET status = ?, completed_at = NULL WHERE id = ?').run(
      'In Progress',
      tournamentId,
    )
    generateMatches(tournamentId, tournament.bracket_size)

    return true
  })

  return reset()
}

function deleteTournament(tournamentId: number) {
  const result = db.prepare('DELETE FROM tournaments WHERE id = ?').run(tournamentId)
  return result.changes > 0
}

function updateTournamentStatus(tournamentId: number) {
  const final = db
    .prepare(
      'SELECT winner_id FROM matches WHERE tournament_id = ? ORDER BY round DESC, position ASC LIMIT 1',
    )
    .get(tournamentId) as { winner_id: number | null } | undefined

  if (final?.winner_id) {
    db.prepare(
      "UPDATE tournaments SET status = 'Completed', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ?",
    ).run(tournamentId)
    return
  }

  db.prepare("UPDATE tournaments SET status = 'In Progress', completed_at = NULL WHERE id = ?").run(
    tournamentId,
  )
}

function ensureSeeded() {
  const count = db.prepare('SELECT COUNT(*) as count FROM tournaments').get() as { count: number }
  if (count.count === 0) {
    createTournament('Friday Night Bracket', [
      'Atlas',
      'Blitz',
      'Comet',
      'Drift',
      'Echo',
      'Flux',
      'Glitch',
      'Havoc',
    ])
  }
}

function clearMatchAndChildren(matchId: number) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as MatchRow | undefined
  if (!match) return

  db.prepare(`
    UPDATE matches
    SET player1_score = NULL, player2_score = NULL, winner_id = NULL
    WHERE id = ?
  `).run(matchId)

  if (!match.next_match_id || !match.next_slot) return

  const slotColumn = match.next_slot === 1 ? 'player1_id' : 'player2_id'
  db.prepare(`UPDATE matches SET ${slotColumn} = NULL WHERE id = ?`).run(match.next_match_id)
  clearMatchAndChildren(match.next_match_id)
}

function saveMatch(
  matchId: number,
  player1Score: number | null,
  player2Score: number | null,
  winnerId: number | null,
) {
  const update = db.transaction(() => {
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as MatchRow | undefined
    if (!match) return null

    const resolvedWinnerId =
      winnerId ??
      (player1Score !== null &&
      player2Score !== null &&
      player1Score !== player2Score &&
      match.player1_id &&
      match.player2_id
        ? player1Score > player2Score
          ? match.player1_id
          : match.player2_id
        : null)

    const validWinner =
      resolvedWinnerId === null || resolvedWinnerId === match.player1_id || resolvedWinnerId === match.player2_id
    if (!validWinner) return null

    if (match.winner_id !== resolvedWinnerId && match.next_match_id && match.next_slot) {
      const slotColumn = match.next_slot === 1 ? 'player1_id' : 'player2_id'
      db.prepare(`UPDATE matches SET ${slotColumn} = NULL WHERE id = ?`).run(match.next_match_id)
      clearMatchAndChildren(match.next_match_id)
    }

    db.prepare(`
      UPDATE matches
      SET player1_score = ?, player2_score = ?, winner_id = ?
      WHERE id = ?
    `).run(player1Score, player2Score, resolvedWinnerId, matchId)

    if (resolvedWinnerId && match.next_match_id && match.next_slot) {
      const slotColumn = match.next_slot === 1 ? 'player1_id' : 'player2_id'
      db.prepare(`UPDATE matches SET ${slotColumn} = ? WHERE id = ?`).run(
        resolvedWinnerId,
        match.next_match_id,
      )
    }

    updateTournamentStatus(match.tournament_id)

    return match.tournament_id
  })

  return update()
}

migrate()
ensureSeeded()

app.use(cors())
app.use(express.json())

app.get('/api/tournaments', (_request, response) => {
  response.json(
    db
      .prepare(
        `SELECT
          tournaments.id,
          tournaments.name,
          tournaments.format,
          tournaments.status,
          tournaments.bracket_size,
          tournaments.created_at,
          tournaments.completed_at,
          tournaments.join_code,
          tournaments.registration_status,
          COUNT(participants.id) as participant_count
        FROM tournaments
        LEFT JOIN participants ON participants.tournament_id = tournaments.id
        GROUP BY tournaments.id
        ORDER BY tournaments.created_at DESC, tournaments.id DESC`,
      )
      .all(),
  )
})

app.get('/api/tournament', (_request, response) => {
  const latest = db.prepare('SELECT id FROM tournaments ORDER BY id DESC LIMIT 1').get() as
    | { id: number }
    | undefined
  response.json(latest ? getState(latest.id) : null)
})

app.get('/api/tournaments/:id', (request, response) => {
  const id = Number(request.params.id)
  const state = Number.isInteger(id) ? getState(id) : null

  if (!state) {
    response.status(404).json({ error: 'Tournament not found.' })
    return
  }

  response.json(state)
})

app.post('/api/tournaments', (request, response) => {
  const parsed = createTournamentSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid tournament setup.' })
    return
  }

  const tournamentId = createTournament(parsed.data.name)
  response.status(201).json(getState(tournamentId))
})

app.get('/api/join/:joinCode', (request, response) => {
  const tournament = db
    .prepare('SELECT id FROM tournaments WHERE join_code = ?')
    .get(request.params.joinCode) as { id: number } | undefined
  const state = tournament ? getState(tournament.id) : null

  if (!state) {
    response.status(404).json({ error: 'Join link not found.' })
    return
  }

  response.json(state)
})

app.post('/api/join/:joinCode', (request, response) => {
  const parsed = joinSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: 'Enter a participant name.' })
    return
  }

  const tournamentId = joinTournament(request.params.joinCode, parsed.data.name)
  if (!tournamentId) {
    response.status(400).json({ error: 'Registration is closed or the bracket is full.' })
    return
  }

  response.status(201).json(getState(tournamentId))
})

app.post('/api/tournaments/:id/start', (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id) || !startTournament(id)) {
    response.status(400).json({ error: 'Tournament needs at least two participants and open registration.' })
    return
  }

  response.json(getState(id))
})

app.put('/api/participants/:id', (request, response) => {
  const id = Number(request.params.id)
  const parsed = participantSchema.safeParse(request.body)

  if (!Number.isInteger(id) || !parsed.success) {
    response.status(400).json({ error: 'Invalid participant update.' })
    return
  }

  const participant = db
    .prepare('SELECT tournament_id FROM participants WHERE id = ?')
    .get(id) as { tournament_id: number } | undefined
  if (!participant) {
    response.status(404).json({ error: 'Participant not found.' })
    return
  }

  db.prepare('UPDATE participants SET name = ? WHERE id = ?').run(parsed.data.name, id)
  response.json(getState(participant.tournament_id))
})

app.delete('/api/participants/:id', (request, response) => {
  const id = Number(request.params.id)
  const tournamentId = Number.isInteger(id) ? removeParticipant(id) : null
  if (!tournamentId) {
    response.status(400).json({ error: 'Participant not found or registration has started.' })
    return
  }

  response.json(getState(tournamentId))
})

app.put('/api/matches/:id', (request, response) => {
  const id = Number(request.params.id)
  const parsed = matchSchema.safeParse(request.body)

  if (!Number.isInteger(id) || !parsed.success) {
    response.status(400).json({ error: 'Invalid match update.' })
    return
  }

  const tournamentId = saveMatch(
    id,
    parsed.data.player1Score,
    parsed.data.player2Score,
    parsed.data.winnerId,
  )
  if (!tournamentId) {
    response.status(404).json({ error: 'Match not found or winner is invalid.' })
    return
  }

  response.json(getState(tournamentId))
})

app.post('/api/tournaments/:id/reset', (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id) || !resetTournament(id)) {
    response.status(404).json({ error: 'Tournament not found.' })
    return
  }

  response.json(getState(id))
})

app.delete('/api/tournaments/:id', (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id) || !deleteTournament(id)) {
    response.status(404).json({ error: 'Tournament not found.' })
    return
  }

  const latest = db.prepare('SELECT id FROM tournaments ORDER BY id DESC LIMIT 1').get() as
    | { id: number }
    | undefined
  response.json({ nextTournament: latest ? getState(latest.id) : null })
})

app.post('/api/reset', (_request, response) => {
  const latest = db.prepare('SELECT id FROM tournaments ORDER BY id DESC LIMIT 1').get() as
    | { id: number }
    | undefined
  if (!latest || !resetTournament(latest.id)) {
    response.status(404).json({ error: 'Tournament not found.' })
    return
  }

  response.json(getState(latest.id))
})

app.use(express.static(distDir))

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(distDir, 'index.html'))
})

app.listen(port, () => {
  console.log(`Bracket API listening on http://localhost:${port}`)
})
