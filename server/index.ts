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
  bracket_group: 'single' | 'winners' | 'losers' | 'grand_final'
  round: number
  position: number
  player1_id: number | null
  player2_id: number | null
  player1_score: number | null
  player2_score: number | null
  winner_id: number | null
  next_match_id: number | null
  next_slot: 1 | 2 | null
  loser_next_match_id: number | null
  loser_next_slot: 1 | 2 | null
  is_reset_final: 0 | 1
}

type ParticipantRow = {
  id: number
  tournament_id: number
  seed: number
  name: string
}

type BracketEntrant =
  | { type: 'participant'; id: number }
  | { type: 'match'; matchId: number }
  | { type: 'bye' }

const maxBracketSize = 16
const tournamentFormats = ['Single Elimination', 'Double Elimination'] as const
type TournamentFormat = (typeof tournamentFormats)[number]

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
  format: z.enum(tournamentFormats).default('Single Elimination'),
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
      bracket_group TEXT NOT NULL DEFAULT 'single',
      round INTEGER NOT NULL,
      position INTEGER NOT NULL,
      player1_id INTEGER REFERENCES participants(id),
      player2_id INTEGER REFERENCES participants(id),
      player1_score INTEGER,
      player2_score INTEGER,
      winner_id INTEGER REFERENCES participants(id),
      next_match_id INTEGER REFERENCES matches(id),
      next_slot INTEGER CHECK(next_slot IN (1, 2)),
      loser_next_match_id INTEGER REFERENCES matches(id),
      loser_next_slot INTEGER CHECK(loser_next_slot IN (1, 2)),
      is_reset_final INTEGER NOT NULL DEFAULT 0
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

  const matchColumns = db.prepare('PRAGMA table_info(matches)').all() as { name: string }[]
  if (!matchColumns.some((column) => column.name === 'bracket_group')) {
    db.exec("ALTER TABLE matches ADD COLUMN bracket_group TEXT NOT NULL DEFAULT 'single'")
  }
  if (!matchColumns.some((column) => column.name === 'loser_next_match_id')) {
    db.exec('ALTER TABLE matches ADD COLUMN loser_next_match_id INTEGER REFERENCES matches(id)')
  }
  if (!matchColumns.some((column) => column.name === 'loser_next_slot')) {
    db.exec('ALTER TABLE matches ADD COLUMN loser_next_slot INTEGER CHECK(loser_next_slot IN (1, 2))')
  }
  if (!matchColumns.some((column) => column.name === 'is_reset_final')) {
    db.exec('ALTER TABLE matches ADD COLUMN is_reset_final INTEGER NOT NULL DEFAULT 0')
  }

  const tournamentsWithoutJoinCodes = db
    .prepare("SELECT id FROM tournaments WHERE join_code IS NULL OR join_code = ''")
    .all() as { id: number }[]
  tournamentsWithoutJoinCodes.forEach((tournament) => {
    db.prepare('UPDATE tournaments SET join_code = ? WHERE id = ?').run(createJoinCode(), tournament.id)
  })
}

function getState(tournamentId: number) {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId)
  if (!tournament) return null

  const participants = db
    .prepare('SELECT * FROM participants WHERE tournament_id = ? ORDER BY seed')
    .all(tournamentId)
  const matches = db
    .prepare(
      `SELECT * FROM matches
       WHERE tournament_id = ?
       ORDER BY
        CASE bracket_group
          WHEN 'single' THEN 0
          WHEN 'winners' THEN 1
          WHEN 'losers' THEN 2
          WHEN 'grand_final' THEN 3
          ELSE 4
        END,
        round,
        position`,
    )
    .all(tournamentId) as MatchRow[]

  return {
    tournament,
    participants,
    matches: matches.map((match) => ({
      ...match,
      status: match.winner_id ? 'completed' : match.player1_id && match.player2_id ? 'ready' : 'pending',
    })),
  }
}

function createJoinCode() {
  return randomBytes(4).toString('hex')
}

function createTournament(name: string, format: TournamentFormat, rawParticipants: string[] = []) {
  const create = db.transaction(() => {
    const bracketSize = rawParticipants.length > 0 ? rawParticipants.length : maxBracketSize
    const tournamentId = Number(
      db
        .prepare(
          'INSERT INTO tournaments (name, format, status, bracket_size, join_code, registration_status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          name,
          format,
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
    if (rawParticipants.length > 0) generateMatches(tournamentId)

    return tournamentId
  })

  return create()
}

function generateMatches(tournamentId: number) {
  const tournament = db
    .prepare('SELECT format FROM tournaments WHERE id = ?')
    .get(tournamentId) as { format: TournamentFormat } | undefined

  if (tournament?.format === 'Double Elimination') {
    generateDoubleEliminationMatches(tournamentId)
    return
  }

  generateSingleEliminationMatches(tournamentId)
}

function generateSingleEliminationMatches(tournamentId: number) {
  db.prepare('DELETE FROM matches WHERE tournament_id = ?').run(tournamentId)

  const participants = db
    .prepare('SELECT * FROM participants WHERE tournament_id = ? ORDER BY seed')
    .all(tournamentId) as ParticipantRow[]

  let entrants: BracketEntrant[] = participants.map((participant) => ({
    type: 'participant',
    id: participant.id,
  }))

  const insertMatch = db.prepare(`
    INSERT INTO matches
      (tournament_id, bracket_group, round, position, player1_id, player2_id, player1_score, player2_score, winner_id, next_match_id, next_slot)
    VALUES (?, 'single', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
  `)
  const updateProgression = db.prepare(
    'UPDATE matches SET next_match_id = ?, next_slot = ? WHERE id = ?',
  )
  let round = 1

  while (entrants.length > 1) {
    const roundEntrants = [...entrants]
    const nextEntrants: BracketEntrant[] = []

    if (roundEntrants.length % 2 === 1) {
      const [byeEntrant] = roundEntrants.splice(roundEntrants.length - 1, 1)
      nextEntrants.push(byeEntrant)
    }

    let position = 1
    for (let index = 0; index < roundEntrants.length; index += 2) {
      const player1 = roundEntrants[index]
      const player2 = roundEntrants[index + 1]
      const player1Id = player1.type === 'participant' ? player1.id : null
      const player2Id = player2.type === 'participant' ? player2.id : null
      const matchId = Number(
        insertMatch.run(tournamentId, round, position, player1Id, player2Id).lastInsertRowid,
      )

      if (player1.type === 'match') {
        updateProgression.run(matchId, 1, player1.matchId)
      }
      if (player2.type === 'match') {
        updateProgression.run(matchId, 2, player2.matchId)
      }

      nextEntrants.push({ type: 'match', matchId })
      position += 1
    }

    entrants = nextEntrants
    round += 1
  }

  assertBracketShape(tournamentId, participants.length)
  updateTournamentStatus(tournamentId)
}

function generateDoubleEliminationMatches(tournamentId: number) {
  db.prepare('DELETE FROM matches WHERE tournament_id = ?').run(tournamentId)

  const participants = db
    .prepare('SELECT * FROM participants WHERE tournament_id = ? ORDER BY seed')
    .all(tournamentId) as ParticipantRow[]
  const size = participants.length
  const bracketSize = nextPowerOfTwo(size)

  const insertMatch = db.prepare(`
    INSERT INTO matches
      (tournament_id, bracket_group, round, position, player1_id, player2_id, player1_score, player2_score, winner_id, next_match_id, next_slot, loser_next_match_id, loser_next_slot, is_reset_final)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)
  `)
  const updateWinnerProgression = db.prepare(
    'UPDATE matches SET next_match_id = ?, next_slot = ? WHERE id = ?',
  )
  const updateLoserProgression = db.prepare(
    'UPDATE matches SET loser_next_match_id = ?, loser_next_slot = ? WHERE id = ?',
  )

  const winnersRounds: number[][] = []
  let entrants = createDoubleEliminationEntrants(participants, bracketSize)
  let round = 1

  while (entrants.length > 1) {
    const roundMatches: number[] = []
    const nextEntrants: BracketEntrant[] = []

    for (let index = 0; index < entrants.length; index += 2) {
      const player1 = entrants[index]
      const player2 = entrants[index + 1]
      const player1Id = entrantParticipantId(player1)
      const player2Id = entrantParticipantId(player2)
      const matchId = Number(
        insertMatch.run(tournamentId, 'winners', round, index / 2 + 1, player1Id, player2Id, 0)
          .lastInsertRowid,
      )

      if (player1.type === 'match') updateWinnerProgression.run(matchId, 1, player1.matchId)
      if (player2.type === 'match') updateWinnerProgression.run(matchId, 2, player2.matchId)

      roundMatches.push(matchId)
      nextEntrants.push({ type: 'match', matchId })
    }

    winnersRounds.push(roundMatches)
    entrants = nextEntrants
    round += 1
  }

  const winnersFinalId = winnersRounds[winnersRounds.length - 1]?.[0]
  const losersRounds: number[][] = []

  if (bracketSize > 2) {
    for (let losersRound = 1; losersRound <= winnersRounds.length * 2 - 2; losersRound += 1) {
      const matchCount = bracketSize / 2 ** (Math.floor((losersRound + 1) / 2) + 1)
      const roundMatches: number[] = []

      for (let position = 1; position <= matchCount; position += 1) {
        const matchId = Number(
          insertMatch.run(tournamentId, 'losers', losersRound, position, null, null, 0).lastInsertRowid,
        )
        roundMatches.push(matchId)
      }

      losersRounds.push(roundMatches)
    }

    winnersRounds.forEach((roundMatches, roundIndex) => {
      const winnersRound = roundIndex + 1
      if (winnersRound === winnersRounds.length) return

      const targetLosersRound = winnersRound === 1 ? 1 : winnersRound * 2 - 2
      const targetMatches = losersRounds[targetLosersRound - 1]

      roundMatches.forEach((matchId, index) => {
        if (winnersRound === 1) {
          updateLoserProgression.run(targetMatches[Math.floor(index / 2)], (index % 2) + 1, matchId)
        } else {
          updateLoserProgression.run(targetMatches[index], 2, matchId)
        }
      })
    })

    losersRounds.forEach((roundMatches, roundIndex) => {
      const nextRoundMatches = losersRounds[roundIndex + 1]
      if (!nextRoundMatches) return

      roundMatches.forEach((matchId, index) => {
        if ((roundIndex + 1) % 2 === 1) {
          updateWinnerProgression.run(nextRoundMatches[index], 1, matchId)
        } else {
          updateWinnerProgression.run(nextRoundMatches[Math.floor(index / 2)], (index % 2) + 1, matchId)
        }
      })
    })
  }

  const grandFinalId = Number(
    insertMatch.run(tournamentId, 'grand_final', 1, 1, null, null, 0).lastInsertRowid,
  )
  insertMatch.run(tournamentId, 'grand_final', 2, 1, null, null, 1)

  if (winnersFinalId) {
    updateWinnerProgression.run(grandFinalId, 1, winnersFinalId)
    if (bracketSize === 2) {
      updateLoserProgression.run(grandFinalId, 2, winnersFinalId)
    } else {
      updateLoserProgression.run(losersRounds[losersRounds.length - 1][0], 2, winnersFinalId)
      updateWinnerProgression.run(grandFinalId, 2, losersRounds[losersRounds.length - 1][0])
    }
  }

  autoAdvanceByes(tournamentId)
  updateTournamentStatus(tournamentId)
}

function nextPowerOfTwo(value: number) {
  return 2 ** Math.ceil(Math.log2(value))
}

function createDoubleEliminationEntrants(participants: ParticipantRow[], bracketSize: number) {
  const entrants: BracketEntrant[] = []
  const byes = bracketSize - participants.length
  let participantIndex = 0

  for (let byeIndex = 0; byeIndex < byes; byeIndex += 1) {
    entrants.push({ type: 'participant', id: participants[participantIndex].id }, { type: 'bye' })
    participantIndex += 1
  }

  while (participantIndex < participants.length) {
    entrants.push({ type: 'participant', id: participants[participantIndex].id })
    participantIndex += 1
  }

  return entrants
}

function entrantParticipantId(entrant: BracketEntrant) {
  return entrant.type === 'participant' ? entrant.id : null
}

function assertBracketShape(tournamentId: number, participantCount: number) {
  const roundOneMatches = db
    .prepare('SELECT * FROM matches WHERE tournament_id = ? AND round = 1 ORDER BY position')
    .all(tournamentId) as MatchRow[]
  const expectedRoundOneMatches = Math.floor(participantCount / 2)

  if (roundOneMatches.length !== expectedRoundOneMatches) {
    throw new Error(
      `Generated ${roundOneMatches.length} round-one matches for ${participantCount} participants; expected ${expectedRoundOneMatches}.`,
    )
  }

  const fakeByeMatch = roundOneMatches.find(
    (match) => (match.player1_id === null) !== (match.player2_id === null),
  )
  if (fakeByeMatch) {
    throw new Error(`Generated invalid single-player round-one match ${fakeByeMatch.position}.`)
  }
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

function addParticipant(tournamentId: number, name: string) {
  const add = db.transaction(() => {
    const tournament = db
      .prepare('SELECT registration_status, format FROM tournaments WHERE id = ?')
      .get(tournamentId) as { registration_status: string; format: TournamentFormat } | undefined
    if (!tournament) return false

    const count = db
      .prepare('SELECT COUNT(*) as count FROM participants WHERE tournament_id = ?')
      .get(tournamentId) as { count: number }
    if (count.count >= maxBracketSize) return false

    const nextCount = count.count + 1
    if (tournament.registration_status !== 'open') {
      const completedOrScoredMatches = db
        .prepare(
          `SELECT COUNT(*) as count
           FROM matches
           WHERE tournament_id = ?
             AND (
              player1_score IS NOT NULL
              OR player2_score IS NOT NULL
              OR (winner_id IS NOT NULL AND player1_id IS NOT NULL AND player2_id IS NOT NULL)
             )`,
        )
        .get(tournamentId) as { count: number }
      if (completedOrScoredMatches.count > 0) return false
    }

    db.prepare('INSERT INTO participants (tournament_id, seed, name) VALUES (?, ?, ?)').run(
      tournamentId,
      nextCount,
      name,
    )

    if (tournament.registration_status !== 'open') {
      db.prepare('UPDATE tournaments SET bracket_size = ?, completed_at = NULL, status = ? WHERE id = ?').run(
        nextCount,
        'In Progress',
        tournamentId,
      )
      generateMatches(tournamentId)
    }

    return true
  })

  return add()
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

// Randomly reassigns seeds 1..N so bracket pairings are a fresh draw rather than
// registration order. Fisher–Yates over the participant ids.
function shuffleParticipantSeeds(tournamentId: number) {
  const participants = db
    .prepare('SELECT id FROM participants WHERE tournament_id = ?')
    .all(tournamentId) as { id: number }[]

  for (let i = participants.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[participants[i], participants[j]] = [participants[j], participants[i]]
  }

  const update = db.prepare('UPDATE participants SET seed = ? WHERE id = ?')
  participants.forEach((participant, index) => update.run(index + 1, participant.id))
}

function startTournament(tournamentId: number) {
  const start = db.transaction(() => {
    const tournament = db
      .prepare('SELECT registration_status, format FROM tournaments WHERE id = ?')
      .get(tournamentId) as { registration_status: string; format: TournamentFormat } | undefined
    if (!tournament || tournament.registration_status === 'started') return false

    const count = db
      .prepare('SELECT COUNT(*) as count FROM participants WHERE tournament_id = ?')
      .get(tournamentId) as { count: number }
    if (count.count < 2) return false
    db.prepare(
      "UPDATE tournaments SET status = 'In Progress', registration_status = 'started', bracket_size = ?, completed_at = NULL WHERE id = ?",
    ).run(count.count, tournamentId)
    shuffleParticipantSeeds(tournamentId)
    generateMatches(tournamentId)

    return true
  })

  return start()
}

function resetTournament(tournamentId: number) {
  const reset = db.transaction(() => {
    const tournament = db
      .prepare('SELECT id, format FROM tournaments WHERE id = ?')
      .get(tournamentId) as { id: number; format: TournamentFormat } | undefined
    if (!tournament) return false

    const count = db
      .prepare('SELECT COUNT(*) as count FROM participants WHERE tournament_id = ?')
      .get(tournamentId) as { count: number }
    if (count.count < 2) return false
    db.prepare('UPDATE tournaments SET status = ?, bracket_size = ?, completed_at = NULL WHERE id = ?').run(
      'In Progress',
      count.count,
      tournamentId,
    )
    generateMatches(tournamentId)

    return true
  })

  return reset()
}

function deleteTournament(tournamentId: number) {
  const result = db.prepare('DELETE FROM tournaments WHERE id = ?').run(tournamentId)
  return result.changes > 0
}

function updateTournamentStatus(tournamentId: number) {
  const tournament = db
    .prepare('SELECT format FROM tournaments WHERE id = ?')
    .get(tournamentId) as { format: TournamentFormat } | undefined

  if (tournament?.format === 'Double Elimination') {
    const grandFinal = db
      .prepare(
        "SELECT * FROM matches WHERE tournament_id = ? AND bracket_group = 'grand_final' AND is_reset_final = 0 LIMIT 1",
      )
      .get(tournamentId) as MatchRow | undefined
    const resetFinal = db
      .prepare(
        "SELECT * FROM matches WHERE tournament_id = ? AND bracket_group = 'grand_final' AND is_reset_final = 1 LIMIT 1",
      )
      .get(tournamentId) as MatchRow | undefined

    const grandFinalWinnerFromWinnersBracket =
      grandFinal?.winner_id && grandFinal.player1_id && grandFinal.winner_id === grandFinal.player1_id
    const resetFinalWinner = resetFinal?.winner_id

    if (grandFinalWinnerFromWinnersBracket || resetFinalWinner) {
      db.prepare(
        "UPDATE tournaments SET status = 'Completed', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ?",
      ).run(tournamentId)
      return
    }

    db.prepare("UPDATE tournaments SET status = 'In Progress', completed_at = NULL WHERE id = ?").run(
      tournamentId,
    )
    return
  }

  const final = db
    .prepare(
      "SELECT winner_id FROM matches WHERE tournament_id = ? AND bracket_group = 'single' ORDER BY round DESC, position ASC LIMIT 1",
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

// Resolves the 1st-place finisher (champion) of a tournament, or null if not yet
// crowned. Mirrors the completion logic in updateTournamentStatus.
function championIdFor(tournamentId: number, format: TournamentFormat) {
  if (format === 'Double Elimination') {
    const resetFinal = db
      .prepare(
        "SELECT winner_id FROM matches WHERE tournament_id = ? AND bracket_group = 'grand_final' AND is_reset_final = 1 LIMIT 1",
      )
      .get(tournamentId) as { winner_id: number | null } | undefined
    if (resetFinal?.winner_id) return resetFinal.winner_id

    const grandFinal = db
      .prepare(
        "SELECT player1_id, winner_id FROM matches WHERE tournament_id = ? AND bracket_group = 'grand_final' AND is_reset_final = 0 LIMIT 1",
      )
      .get(tournamentId) as { player1_id: number | null; winner_id: number | null } | undefined
    if (grandFinal?.winner_id && grandFinal.player1_id && grandFinal.winner_id === grandFinal.player1_id) {
      return grandFinal.winner_id
    }

    return null
  }

  const final = db
    .prepare(
      "SELECT winner_id FROM matches WHERE tournament_id = ? AND bracket_group = 'single' ORDER BY round DESC, position ASC LIMIT 1",
    )
    .get(tournamentId) as { winner_id: number | null } | undefined

  return final?.winner_id ?? null
}

// Tallies championships across all completed tournaments, grouped by participant
// name. Read-only — computed on demand, no schema changes.
function getLeaderboard() {
  const completed = db
    .prepare(
      "SELECT id, format, completed_at FROM tournaments WHERE status = 'Completed'",
    )
    .all() as { id: number; format: TournamentFormat; completed_at: string | null }[]

  const tally = new Map<string, { name: string; wins: number; lastWonAt: string | null }>()

  for (const tournament of completed) {
    const championId = championIdFor(tournament.id, tournament.format)
    if (!championId) continue

    const champion = db
      .prepare('SELECT name FROM participants WHERE id = ?')
      .get(championId) as { name: string } | undefined
    if (!champion) continue

    const existing = tally.get(champion.name)
    if (existing) {
      existing.wins += 1
      if ((tournament.completed_at ?? '') > (existing.lastWonAt ?? '')) {
        existing.lastWonAt = tournament.completed_at
      }
    } else {
      tally.set(champion.name, {
        name: champion.name,
        wins: 1,
        lastWonAt: tournament.completed_at,
      })
    }
  }

  return Array.from(tally.values()).sort(
    (a, b) => b.wins - a.wins || (b.lastWonAt ?? '').localeCompare(a.lastWonAt ?? ''),
  )
}

function ensureSeeded() {
  const count = db.prepare('SELECT COUNT(*) as count FROM tournaments').get() as { count: number }
  if (count.count === 0) {
    createTournament('Friday Night Bracket', 'Single Elimination', [
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

function clearMatchAndChildren(matchId: number, visited = new Set<number>()) {
  if (visited.has(matchId)) return
  visited.add(matchId)

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as MatchRow | undefined
  if (!match) return

  db.prepare(`
    UPDATE matches
    SET player1_score = NULL, player2_score = NULL, winner_id = NULL
    WHERE id = ?
  `).run(matchId)

  if (match.next_match_id && match.next_slot) {
    const slotColumn = match.next_slot === 1 ? 'player1_id' : 'player2_id'
    db.prepare(`UPDATE matches SET ${slotColumn} = NULL WHERE id = ?`).run(match.next_match_id)
    clearMatchAndChildren(match.next_match_id, visited)
  }

  if (match.loser_next_match_id && match.loser_next_slot) {
    const slotColumn = match.loser_next_slot === 1 ? 'player1_id' : 'player2_id'
    db.prepare(`UPDATE matches SET ${slotColumn} = NULL WHERE id = ?`).run(match.loser_next_match_id)
    clearMatchAndChildren(match.loser_next_match_id, visited)
  }

  if (match.bracket_group === 'grand_final' && match.is_reset_final === 0) {
    const resetFinal = db
      .prepare(
        "SELECT id FROM matches WHERE tournament_id = ? AND bracket_group = 'grand_final' AND is_reset_final = 1",
      )
      .get(match.tournament_id) as { id: number } | undefined
    if (resetFinal) {
      db.prepare('UPDATE matches SET player1_id = NULL, player2_id = NULL WHERE id = ?').run(resetFinal.id)
      clearMatchAndChildren(resetFinal.id, visited)
    }
  }
}

function loserFor(match: MatchRow, winnerId: number | null) {
  if (!winnerId || !match.player1_id || !match.player2_id) return null
  if (winnerId === match.player1_id) return match.player2_id
  if (winnerId === match.player2_id) return match.player1_id
  return null
}

function autoAdvanceByes(tournamentId: number) {
  let advanced = true

  while (advanced) {
    advanced = false
    const matches = db
      .prepare('SELECT * FROM matches WHERE tournament_id = ? AND winner_id IS NULL ORDER BY bracket_group, round, position')
      .all(tournamentId) as MatchRow[]

    for (const match of matches) {
      const hasOnlyPlayer1 = Boolean(match.player1_id && !match.player2_id)
      const hasOnlyPlayer2 = Boolean(match.player2_id && !match.player1_id)
      if (!hasOnlyPlayer1 && !hasOnlyPlayer2) continue

      const missingSlot: 1 | 2 = hasOnlyPlayer1 ? 2 : 1
      if (slotCanStillReceiveEntrant(match.id, missingSlot, new Set())) continue

      const winnerId = hasOnlyPlayer1 ? match.player1_id : match.player2_id
      if (!winnerId) continue

      db.prepare('UPDATE matches SET winner_id = ?, player1_score = NULL, player2_score = NULL WHERE id = ?').run(
        winnerId,
        match.id,
      )

      if (match.next_match_id && match.next_slot) {
        const slotColumn = match.next_slot === 1 ? 'player1_id' : 'player2_id'
        db.prepare(`UPDATE matches SET ${slotColumn} = ? WHERE id = ?`).run(winnerId, match.next_match_id)
      }

      advanced = true
    }
  }
}

function slotCanStillReceiveEntrant(matchId: number, slot: 1 | 2, visited: Set<string>): boolean {
  const key = `${matchId}:${slot}`
  if (visited.has(key)) return false
  visited.add(key)

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as MatchRow | undefined
  if (!match) return false

  if ((slot === 1 && match.player1_id) || (slot === 2 && match.player2_id)) return true

  const winnerSources = db
    .prepare('SELECT * FROM matches WHERE next_match_id = ? AND next_slot = ?')
    .all(matchId, slot) as MatchRow[]
  if (winnerSources.some((source) => matchCanProduceWinner(source, visited))) return true

  const loserSources = db
    .prepare('SELECT * FROM matches WHERE loser_next_match_id = ? AND loser_next_slot = ?')
    .all(matchId, slot) as MatchRow[]
  return loserSources.some((source) => matchCanProduceLoser(source, visited))
}

function matchCanProduceWinner(match: MatchRow, visited: Set<string>): boolean {
  if (match.winner_id) return true
  return (
    Boolean(match.player1_id) ||
    slotCanStillReceiveEntrant(match.id, 1, visited) ||
    Boolean(match.player2_id) ||
    slotCanStillReceiveEntrant(match.id, 2, visited)
  )
}

function matchCanProduceLoser(match: MatchRow, visited: Set<string>): boolean {
  if (loserFor(match, match.winner_id)) return true

  const player1CanExist: boolean = Boolean(match.player1_id) || slotCanStillReceiveEntrant(match.id, 1, visited)
  const player2CanExist: boolean = Boolean(match.player2_id) || slotCanStillReceiveEntrant(match.id, 2, visited)
  return player1CanExist && player2CanExist
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

    if (match.winner_id !== resolvedWinnerId) {
      if (match.next_match_id && match.next_slot) {
        const slotColumn = match.next_slot === 1 ? 'player1_id' : 'player2_id'
        db.prepare(`UPDATE matches SET ${slotColumn} = NULL WHERE id = ?`).run(match.next_match_id)
        clearMatchAndChildren(match.next_match_id)
      }

      if (match.loser_next_match_id && match.loser_next_slot) {
        const slotColumn = match.loser_next_slot === 1 ? 'player1_id' : 'player2_id'
        db.prepare(`UPDATE matches SET ${slotColumn} = NULL WHERE id = ?`).run(match.loser_next_match_id)
        clearMatchAndChildren(match.loser_next_match_id)
      }

      if (match.bracket_group === 'grand_final' && match.is_reset_final === 0) {
        const resetFinal = db
          .prepare(
            "SELECT id FROM matches WHERE tournament_id = ? AND bracket_group = 'grand_final' AND is_reset_final = 1",
          )
          .get(match.tournament_id) as { id: number } | undefined
        if (resetFinal) {
          db.prepare('UPDATE matches SET player1_id = NULL, player2_id = NULL WHERE id = ?').run(
            resetFinal.id,
          )
          clearMatchAndChildren(resetFinal.id)
        }
      }
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

    const resolvedLoserId = loserFor(match, resolvedWinnerId)
    if (resolvedLoserId && match.loser_next_match_id && match.loser_next_slot) {
      const slotColumn = match.loser_next_slot === 1 ? 'player1_id' : 'player2_id'
      db.prepare(`UPDATE matches SET ${slotColumn} = ? WHERE id = ?`).run(
        resolvedLoserId,
        match.loser_next_match_id,
      )
    }

    if (match.bracket_group === 'grand_final' && match.is_reset_final === 0) {
      const resetFinal = db
        .prepare(
          "SELECT id FROM matches WHERE tournament_id = ? AND bracket_group = 'grand_final' AND is_reset_final = 1",
        )
        .get(match.tournament_id) as { id: number } | undefined

      if (resetFinal) {
        if (resolvedWinnerId && resolvedWinnerId === match.player2_id && match.player1_id && match.player2_id) {
          db.prepare('UPDATE matches SET player1_id = ?, player2_id = ? WHERE id = ?').run(
            match.player1_id,
            match.player2_id,
            resetFinal.id,
          )
        } else {
          db.prepare('UPDATE matches SET player1_id = NULL, player2_id = NULL WHERE id = ?').run(
            resetFinal.id,
          )
          clearMatchAndChildren(resetFinal.id)
        }
      }
    }

    autoAdvanceByes(match.tournament_id)
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

app.get('/api/leaderboard', (_request, response) => {
  response.json(getLeaderboard())
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

  const tournamentId = createTournament(parsed.data.name, parsed.data.format)
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

app.post('/api/tournaments/:id/participants', (request, response) => {
  const id = Number(request.params.id)
  const parsed = participantSchema.safeParse(request.body)

  if (!Number.isInteger(id) || !parsed.success) {
    response.status(400).json({ error: 'Enter a participant name.' })
    return
  }

  if (!addParticipant(id, parsed.data.name)) {
    response.status(400).json({
      error:
        'Could not add participant. Reset the bracket before adding after scores, and keep the bracket at 16 players or fewer.',
    })
    return
  }

  response.status(201).json(getState(id))
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
