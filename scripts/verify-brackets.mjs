import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const port = 6200 + Math.floor(Math.random() * 1000)
const dataDir = mkdtempSync(path.join(tmpdir(), 'simple-bracket-verify-'))
const logPath = path.join(dataDir, 'server.log')
const server = spawn(process.execPath, ['server-dist/index.js'], {
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
  stdio: ['ignore', 'ignore', 'pipe'],
})

const logChunks = []
server.stderr.on('data', (chunk) => logChunks.push(chunk))

async function request(pathname, options = {}) {
  const response = await fetch(`http://localhost:${port}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${pathname} failed: ${response.status} ${await response.text()}`)
  }

  return response.json()
}

async function waitForServer() {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    try {
      await request('/api/tournaments')
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  throw new Error('Server did not start in time.')
}

async function verifyCount(count) {
  let state = await request('/api/tournaments', {
    method: 'POST',
    body: JSON.stringify({ name: `Verify ${count}` }),
  })

  for (let index = 1; index <= count; index += 1) {
    state = await request(`/api/tournaments/${state.tournament.id}/participants`, {
      method: 'POST',
      body: JSON.stringify({ name: String(index) }),
    })
  }

  state = await request(`/api/tournaments/${state.tournament.id}/start`, {
    method: 'POST',
    body: JSON.stringify({}),
  })

  const participantsById = new Map(state.participants.map((participant) => [participant.id, participant]))
  const roundOne = state.matches.filter((match) => match.round === 1)
  const expectedRoundOneMatches = Math.floor(count / 2)

  if (roundOne.length !== expectedRoundOneMatches) {
    throw new Error(`Count ${count}: expected ${expectedRoundOneMatches} round-one matches, got ${roundOne.length}.`)
  }

  for (const match of roundOne) {
    if (!match.player1_id || !match.player2_id) {
      throw new Error(`Count ${count}: round-one match ${match.position} has an empty player slot.`)
    }
    if (match.winner_id) {
      throw new Error(`Count ${count}: round-one match ${match.position} was auto-completed.`)
    }
  }

  const roundOnePairs = roundOne.map((match) => [
    participantsById.get(match.player1_id)?.name,
    participantsById.get(match.player2_id)?.name,
  ])
  const expectedPairs = []
  const pairedParticipantCount = count % 2 === 0 ? count : count - 1
  for (let seed = 1; seed <= pairedParticipantCount; seed += 2) {
    expectedPairs.push([String(seed), String(seed + 1)])
  }

  if (JSON.stringify(roundOnePairs) !== JSON.stringify(expectedPairs)) {
    throw new Error(
      `Count ${count}: expected round-one pairs ${JSON.stringify(expectedPairs)}, got ${JSON.stringify(roundOnePairs)}.`,
    )
  }

  if (count === 5) {
    const seedFive = state.participants.find((participant) => participant.seed === 5)
    const laterSeedFiveMatch = state.matches.find(
      (match) => match.round > 1 && (match.player1_id === seedFive.id || match.player2_id === seedFive.id),
    )
    if (!laterSeedFiveMatch) {
      throw new Error('Count 5: seed 5 was not carried forward as the bye entrant.')
    }
  }
}

try {
  await waitForServer()
  for (let count = 2; count <= 16; count += 1) {
    await verifyCount(count)
  }
  console.log('Bracket verification passed for participant counts 2 through 16.')
} catch (error) {
  console.error(error)
  if (logChunks.length > 0) {
    console.error(Buffer.concat(logChunks).toString())
  }
  try {
    console.error(readFileSync(logPath, 'utf8'))
  } catch {
    // No file log is expected; stderr is captured above.
  }
  process.exitCode = 1
} finally {
  server.kill()
}
