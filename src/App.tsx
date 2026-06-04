import { useEffect, useState } from 'react'
import { Copy, Crown, Database, Lock, Plus, RotateCcw, Save, Trash2, Trophy } from 'lucide-react'
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom'

import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card'
import { Input } from './components/ui/input'
import { cn } from './lib/utils'

type Tournament = {
  id: number
  name: string
  format: string
  status: string
  bracket_size: number
  created_at: string
  completed_at: string | null
  join_code: string
  registration_status: 'open' | 'locked' | 'started'
}

type Participant = {
  id: number
  tournament_id: number
  seed: number
  name: string
}

type Match = {
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
  status: 'pending' | 'ready' | 'completed'
}

type BracketState = {
  tournament: Tournament
  participants: Participant[]
  matches: Match[]
}

const bracketSizes = [4, 8, 16]

function App() {
  return (
    <Routes>
      <Route path="/" element={<AdminPage />} />
      <Route path="/tournaments/:id" element={<AdminPage />} />
      <Route path="/tournaments/:id/display" element={<DisplayPage />} />
      <Route path="/join/:joinCode" element={<JoinPage />} />
    </Routes>
  )
}

function AdminPage() {
  const params = useParams()
  const navigate = useNavigate()
  const [bracket, setBracket] = useState<BracketState | null>(null)
  const [tournaments, setTournaments] = useState<Tournament[]>([])
  const [error, setError] = useState<string | null>(null)
  const [savingMatchId, setSavingMatchId] = useState<number | null>(null)
  const [newName, setNewName] = useState('Weekend Bracket')
  const [newSize, setNewSize] = useState(8)
  const [allowCompletedEdits, setAllowCompletedEdits] = useState(false)
  const routeTournamentId = params.id ? Number(params.id) : null

  useEffect(() => {
    const controller = new AbortController()
    const bracketUrl = routeTournamentId ? `/api/tournaments/${routeTournamentId}` : '/api/tournament'

    Promise.all([
      fetch('/api/tournaments', { signal: controller.signal }),
      fetch(bracketUrl, { signal: controller.signal }),
    ])
      .then(async ([tournamentsResponse, bracketResponse]) => {
        if (!tournamentsResponse.ok || !bracketResponse.ok) {
          throw new Error('Could not load the local bracket API. Is npm run dev active?')
        }

        return {
          tournaments: (await tournamentsResponse.json()) as Tournament[],
          bracket: (await bracketResponse.json()) as BracketState | null,
        }
      })
      .then((state) => {
        setError(null)
        setTournaments(state.tournaments)
        setBracket(state.bracket)
        if (!routeTournamentId && state.bracket) {
          navigate(`/tournaments/${state.bracket.tournament.id}`, { replace: true })
        }
      })
      .catch((caughtError: unknown) => {
        if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return
        setError(caughtError instanceof Error ? caughtError.message : 'Could not load bracket.')
      })

    return () => controller.abort()
  }, [navigate, routeTournamentId])

  async function refreshTournaments() {
    const response = await fetch('/api/tournaments')
    if (response.ok) setTournaments(await response.json())
  }

  async function loadTournament(id: number) {
    const response = await fetch(`/api/tournaments/${id}`)
    if (!response.ok) {
      setError('Could not load that tournament.')
      return
    }

    setError(null)
    setBracket(await response.json())
    setAllowCompletedEdits(false)
    navigate(`/tournaments/${id}`)
  }

  async function createTournament() {
    const response = await fetch('/api/tournaments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newName,
        size: newSize,
      }),
    })

    if (!response.ok) {
      setError('Could not create tournament. Check the name and participant list.')
      return
    }

    setError(null)
    const created = (await response.json()) as BracketState
    setBracket(created)
    setAllowCompletedEdits(false)
    navigate(`/tournaments/${created.tournament.id}`)
    await refreshTournaments()
  }

  async function startBracket() {
    if (!bracket) return

    const response = await fetch(`/api/tournaments/${bracket.tournament.id}/start`, { method: 'POST' })
    if (!response.ok) {
      setError('A bracket needs at least two participants before it can start.')
      return
    }

    setError(null)
    setBracket(await response.json())
    await refreshTournaments()
  }

  async function removeParticipant(id: number) {
    const response = await fetch(`/api/participants/${id}`, { method: 'DELETE' })
    if (!response.ok) {
      setError('Could not remove that participant. Registration may have already started.')
      return
    }

    setError(null)
    setBracket(await response.json())
    await refreshTournaments()
  }

  async function updateParticipant(id: number, name: string) {
    if (!name.trim()) return

    const response = await fetch(`/api/participants/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })

    if (response.ok) {
      setBracket(await response.json())
      await refreshTournaments()
    }
  }

  async function updateMatch(match: Match, winnerId = match.winner_id) {
    setSavingMatchId(match.id)
    setError(null)

    const response = await fetch(`/api/matches/${match.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player1Score: match.player1_score,
        player2Score: match.player2_score,
        winnerId,
      }),
    })

    setSavingMatchId(null)

    if (!response.ok) {
      setError('Could not save that match. Pick a player currently assigned to the match.')
      return
    }

    setBracket(await response.json())
    await refreshTournaments()
  }

  async function resetBracket() {
    if (!bracket) return
    if (!window.confirm(`Reset scores and winners for ${bracket.tournament.name}?`)) return

    const response = await fetch(`/api/tournaments/${bracket.tournament.id}/reset`, { method: 'POST' })
    if (response.ok) {
      setBracket(await response.json())
      setAllowCompletedEdits(false)
      await refreshTournaments()
    }
  }

  async function deleteSelectedTournament() {
    if (!bracket) return
    if (!window.confirm(`Delete ${bracket.tournament.name}? This cannot be undone.`)) return

    const response = await fetch(`/api/tournaments/${bracket.tournament.id}`, { method: 'DELETE' })
    if (!response.ok) {
      setError('Could not delete that tournament.')
      return
    }

    const result = (await response.json()) as { nextTournament: BracketState | null }
    setBracket(result.nextTournament)
    setAllowCompletedEdits(false)
    navigate(result.nextTournament ? `/tournaments/${result.nextTournament.tournament.id}` : '/')
    await refreshTournaments()
  }

  function patchMatch(matchId: number, patch: Partial<Match>) {
    setBracket((current) => {
      if (!current) return current

      return {
        ...current,
        matches: current.matches.map((match) =>
          match.id === matchId ? { ...match, ...patch } : match,
        ),
      }
    })
  }

  function participantFor(id: number | null) {
    return bracket?.participants.find((participant) => participant.id === id) ?? null
  }

  const maxRound = bracket?.matches.reduce((max, match) => Math.max(max, match.round), 0) ?? 0
  const champion = participantFor(
    bracket?.matches.find((match) => match.round === maxRound)?.winner_id ?? null,
  )
  const rounds = Array.from({ length: maxRound }, (_, index) => index + 1).map((round) => ({
    round,
    matches: bracket?.matches.filter((match) => match.round === round) ?? [],
  }))
  const isCompleted = bracket?.tournament.status === 'Completed'
  const editingLocked = Boolean(isCompleted && !allowCompletedEdits)
  const joinUrl = bracket ? `${window.location.origin}/join/${bracket.tournament.join_code}` : ''
  const registrationOpen = bracket?.tournament.registration_status === 'open'

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,#fed7aa,transparent_32rem),linear-gradient(135deg,#fff7ed,#f8fafc_45%,#e0f2fe)] text-slate-950">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="grid gap-5 rounded-3xl border border-white/70 bg-white/75 p-5 shadow-xl shadow-orange-200/30 backdrop-blur lg:grid-cols-[1fr_22rem] lg:p-8">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-orange-500">Single Elimination</Badge>
              <Badge className={registrationOpen ? 'bg-sky-600' : isCompleted ? 'bg-emerald-600' : 'bg-slate-900'}>
                {bracket?.tournament.status ?? 'Loading'}
              </Badge>
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
                <Database className="h-3.5 w-3.5" /> SQLite persisted
              </span>
            </div>
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-orange-600">
                Simple Bracket
              </p>
              <h1 className="mt-2 max-w-3xl text-4xl font-black tracking-tight text-slate-950 sm:text-6xl">
                {bracket?.tournament.name ?? 'Bracket Manager'}
              </h1>
            </div>
            <p className="max-w-2xl text-base leading-7 text-slate-600">
              Create a bracket, share the join link, let participants register themselves, then
              start when the field is ready. Empty slots become TBD/byes.
              {bracket?.tournament.completed_at
                ? ` Completed ${formatDate(bracket.tournament.completed_at)}.`
                : ''}
            </p>
          </div>

          <Card className="border-orange-200 bg-orange-50/90">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Trophy className="h-5 w-5 text-orange-600" /> Champion
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-2xl bg-white p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Current winner
                </p>
                <p className="mt-2 text-2xl font-black text-slate-950">
                  {champion?.name ?? 'TBD'}
                </p>
              </div>
              {bracket && registrationOpen ? (
                <Button className="w-full" onClick={startBracket} disabled={bracket.participants.length < 2}>
                  Start bracket ({bracket.participants.length}/{bracket.tournament.bracket_size})
                </Button>
              ) : null}
              {isCompleted ? (
                <Button
                  variant={allowCompletedEdits ? 'secondary' : 'outline'}
                  className="w-full bg-white"
                  onClick={() => setAllowCompletedEdits((current) => !current)}
                >
                  <Lock className="h-4 w-4" /> {allowCompletedEdits ? 'Lock bracket' : 'Unlock edits'}
                </Button>
              ) : null}
              <Button variant="outline" className="w-full bg-white" onClick={resetBracket} disabled={!bracket}>
                <RotateCcw className="h-4 w-4" /> Reset selected bracket
              </Button>
              {bracket ? (
                <Link
                  className="inline-flex h-10 w-full items-center justify-center rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 transition-colors hover:bg-slate-200"
                  to={`/tournaments/${bracket.tournament.id}/display`}
                >
                  Open display mode
                </Link>
              ) : null}
              <Button
                variant="ghost"
                className="w-full text-red-600 hover:bg-red-50 hover:text-red-700"
                onClick={deleteSelectedTournament}
                disabled={!bracket}
              >
                <Trash2 className="h-4 w-4" /> Delete tournament
              </Button>
            </CardContent>
          </Card>
        </header>

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <section className="grid gap-6 lg:grid-cols-[22rem_1fr]">
          <aside className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Create Bracket</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <label className="space-y-1 text-sm font-medium text-slate-700">
                  Tournament name
                  <Input value={newName} onChange={(event) => setNewName(event.currentTarget.value)} />
                </label>
                <label className="space-y-1 text-sm font-medium text-slate-700">
                  Bracket size
                  <select
                    value={newSize}
                    className="flex h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                    onChange={(event) => setNewSize(Number(event.currentTarget.value))}
                  >
                    {bracketSizes.map((size) => (
                      <option key={size} value={size}>
                        {size} players
                      </option>
                    ))}
                  </select>
                </label>
                <Button className="w-full" onClick={createTournament}>
                  <Plus className="h-4 w-4" /> Create join link
                </Button>
              </CardContent>
            </Card>

            {bracket ? (
              <Card>
                <CardHeader>
                  <CardTitle>Join Link</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Input value={joinUrl} readOnly className="bg-slate-50 text-xs" />
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full bg-white"
                    onClick={() => navigator.clipboard.writeText(joinUrl)}
                  >
                    <Copy className="h-4 w-4" /> Copy join link
                  </Button>
                  <p className="text-xs leading-5 text-slate-500">
                    Share this with participants. They can join until the bracket is started.
                  </p>
                </CardContent>
              </Card>
            ) : null}

            {bracket ? (
              <Card>
                <CardHeader>
                  <CardTitle>
                    Participants ({bracket.participants.length}/{bracket.tournament.bracket_size})
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {bracket.participants.length === 0 ? (
                    <p className="text-sm text-slate-500">Waiting for participants to join.</p>
                  ) : null}
                  {bracket.participants.map((participant) => (
                    <div
                      key={participant.id}
                      className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    >
                      <span className="font-semibold">
                        {participant.seed}. {participant.name}
                      </span>
                      {registrationOpen ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-red-600 hover:bg-red-50 hover:text-red-700"
                          onClick={() => removeParticipant(participant.id)}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  ))}
                  {registrationOpen ? (
                    <Button className="w-full" onClick={startBracket} disabled={bracket.participants.length < 2}>
                      Start bracket
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Saved Tournaments</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {tournaments.map((tournament) => (
                  <button
                    key={tournament.id}
                    type="button"
                    className={cn(
                      'w-full rounded-xl border p-3 text-left text-sm transition-colors hover:border-orange-300 hover:bg-orange-50',
                      bracket?.tournament.id === tournament.id
                        ? 'border-orange-300 bg-orange-50'
                        : 'border-slate-200 bg-white',
                    )}
                    onClick={() => loadTournament(tournament.id)}
                  >
                    <span className="block font-bold text-slate-900">{tournament.name}</span>
                    <span className="mt-1 block text-xs text-slate-500">
                      {tournament.bracket_size} players · {tournament.status}
                    </span>
                  </button>
                ))}
              </CardContent>
            </Card>
          </aside>

          <section className="overflow-x-auto pb-6">
            {bracket && bracket.matches.length === 0 ? (
              <Card className="border-sky-200 bg-white/85">
                <CardContent className="space-y-5 p-8">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-600">
                      Registration Open
                    </p>
                    <h2 className="mt-2 text-3xl font-black text-slate-950">
                      Share the join link to fill the bracket
                    </h2>
                  </div>
                  <p className="max-w-2xl text-slate-600">
                    {bracket.participants.length}/{bracket.tournament.bracket_size} participants have joined.
                    You can start once at least two people are registered. Any remaining slots stay TBD.
                  </p>
                  <div className="grid max-w-3xl gap-2 sm:grid-cols-2">
                    {bracket.participants.map((participant) => (
                      <div key={participant.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3 font-semibold">
                        {participant.seed}. {participant.name}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ) : bracket ? (
              <div
                className="grid gap-8"
                style={{
                  gridTemplateColumns: `repeat(${rounds.length}, 19rem) 16rem`,
                  minWidth: `${rounds.length * 336 + 256}px`,
                }}
              >
                {rounds.map(({ round, matches }) => (
                  <div key={round} className="space-y-5">
                    <div className="sticky left-0 flex items-center justify-between rounded-full border border-slate-200 bg-white px-4 py-2 shadow-sm">
                      <h2 className="text-sm font-black uppercase tracking-[0.2em] text-slate-700">
                        {roundName(round, maxRound)}
                      </h2>
                      <span className="text-xs font-semibold text-slate-400">Round {round}</span>
                    </div>

                    <div
                      className="grid"
                      style={{
                        gap: `${20 + (2 ** (round - 1) - 1) * 76}px`,
                        paddingTop: `${(2 ** (round - 1) - 1) * 70}px`,
                      }}
                    >
                      {matches.map((match) => (
                        <MatchCard
                          key={match.id}
                          match={match}
                          player1={participantFor(match.player1_id)}
                          player2={participantFor(match.player2_id)}
                          saving={savingMatchId === match.id}
                          editingLocked={editingLocked}
                          onPatch={patchMatch}
                          onSave={updateMatch}
                          onUpdateParticipant={updateParticipant}
                        />
                      ))}
                    </div>
                  </div>
                ))}

                <div className="space-y-5" style={{ paddingTop: `${(2 ** maxRound - 1) * 35}px` }}>
                  <div className="flex items-center justify-between rounded-full border border-slate-200 bg-white px-4 py-2 shadow-sm">
                    <h2 className="text-sm font-black uppercase tracking-[0.2em] text-slate-700">
                      Winner
                    </h2>
                  </div>
                  <Card className="border-amber-200 bg-gradient-to-br from-amber-50 to-white">
                    <CardContent className="p-5">
                      <div className="flex items-center gap-3">
                        <div className="grid h-11 w-11 place-items-center rounded-full bg-amber-400 text-white">
                          <Crown className="h-6 w-6" />
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                            Champion
                          </p>
                          <p className="text-xl font-black">{champion?.name ?? 'Awaiting final'}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            ) : (
              <Card className="border-slate-200 bg-white/80">
                <CardContent className="p-8 text-sm text-slate-600">
                  Loading the latest tournament from SQLite...
                </CardContent>
              </Card>
            )}
          </section>
        </section>
      </section>
    </main>
  )
}

function JoinPage() {
  const params = useParams()
  const [bracket, setBracket] = useState<BracketState | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)
  const joinCode = params.joinCode ?? ''

  useEffect(() => {
    const controller = new AbortController()

    fetch(`/api/join/${joinCode}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('This join link is not valid.')
        return response.json() as Promise<BracketState>
      })
      .then((state) => {
        setError(null)
        setBracket(state)
      })
      .catch((caughtError: unknown) => {
        if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return
        setError(caughtError instanceof Error ? caughtError.message : 'Could not load join page.')
      })

    return () => controller.abort()
  }, [joinCode])

  async function joinBracket() {
    const response = await fetch(`/api/join/${joinCode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      setError(body?.error ?? 'Could not join this bracket.')
      return
    }

    setError(null)
    setJoined(true)
    setBracket(await response.json())
  }

  const spotsRemaining = bracket
    ? Math.max(0, bracket.tournament.bracket_size - bracket.participants.length)
    : 0
  const registrationOpen = bracket?.tournament.registration_status === 'open'

  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top,#fed7aa,transparent_34rem),linear-gradient(135deg,#fff7ed,#eff6ff)] px-4 py-8 text-slate-950">
      <Card className="w-full max-w-xl border-white/80 bg-white/85 shadow-xl backdrop-blur">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={registrationOpen ? 'bg-sky-600' : 'bg-slate-700'}>
              {registrationOpen ? 'Registration open' : 'Registration closed'}
            </Badge>
            {bracket ? <Badge className="bg-orange-500">{spotsRemaining} spots left</Badge> : null}
          </div>
          <CardTitle className="pt-3 text-3xl font-black">
            Join {bracket?.tournament.name ?? 'Bracket'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {joined ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              You are in. Waiting for the host to start the bracket.
            </div>
          ) : null}

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <label className="space-y-2 text-sm font-medium text-slate-700">
            Display name
            <Input
              value={name}
              disabled={!registrationOpen || joined}
              placeholder="Your name"
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <Button className="w-full" disabled={!registrationOpen || joined || !name.trim()} onClick={joinBracket}>
            Join bracket
          </Button>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-700">
              {bracket?.participants.length ?? 0}/{bracket?.tournament.bracket_size ?? '-'} joined
            </p>
            <div className="mt-3 grid gap-2">
              {bracket?.participants.map((participant) => (
                <div key={participant.id} className="rounded-lg bg-white px-3 py-2 text-sm font-medium">
                  {participant.seed}. {participant.name}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}

function DisplayPage() {
  const params = useParams()
  const [bracket, setBracket] = useState<BracketState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tournamentId = params.id ? Number(params.id) : null

  useEffect(() => {
    if (!tournamentId) return

    const controller = new AbortController()

    async function loadDisplay() {
      try {
        const response = await fetch(`/api/tournaments/${tournamentId}`, { signal: controller.signal })
        if (!response.ok) {
          setError('Could not load this tournament display.')
          return
        }

        setError(null)
        setBracket(await response.json())
      } catch (caughtError) {
        if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return
        setError('Could not refresh this tournament display.')
      }
    }

    loadDisplay()
    const interval = window.setInterval(loadDisplay, 4000)

    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [tournamentId])

  function participantFor(id: number | null) {
    return bracket?.participants.find((participant) => participant.id === id) ?? null
  }

  const maxRound = bracket?.matches.reduce((max, match) => Math.max(max, match.round), 0) ?? 0
  const champion = participantFor(
    bracket?.matches.find((match) => match.round === maxRound)?.winner_id ?? null,
  )
  const rounds = Array.from({ length: maxRound }, (_, index) => index + 1).map((round) => ({
    round,
    matches: bracket?.matches.filter((match) => match.round === round) ?? [],
  }))

  return (
    <main className="min-h-screen overflow-hidden bg-slate-950 text-white">
      <section className="mx-auto flex w-full max-w-[96rem] flex-col gap-8 px-5 py-6 sm:px-8">
        <header className="grid gap-5 rounded-3xl border border-white/10 bg-white/10 p-6 shadow-2xl shadow-black/30 backdrop-blur lg:grid-cols-[1fr_22rem]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-orange-500">Display Mode</Badge>
              <Badge className={bracket?.tournament.status === 'Completed' ? 'bg-emerald-600' : 'bg-slate-700'}>
                {bracket?.tournament.status ?? 'Loading'}
              </Badge>
              <span className="rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-slate-300">
                Refreshes every 4 seconds
              </span>
            </div>
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.32em] text-orange-300">
                Live Bracket
              </p>
              <h1 className="mt-2 text-5xl font-black tracking-tight sm:text-7xl">
                {bracket?.tournament.name ?? 'Loading Tournament'}
              </h1>
            </div>
            {error ? <p className="text-sm text-red-300">{error}</p> : null}
          </div>

          <Card className="border-amber-300/30 bg-amber-300/10 text-white">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Trophy className="h-5 w-5 text-amber-300" /> Champion
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-4xl font-black">{champion?.name ?? 'TBD'}</p>
              {bracket ? (
                <Link
                  className="mt-5 inline-flex rounded-md bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                  to={`/tournaments/${bracket.tournament.id}`}
                >
                  Admin view
                </Link>
              ) : null}
            </CardContent>
          </Card>
        </header>

        {bracket ? (
          <section className="overflow-x-auto pb-6">
            <div
              className="grid gap-8"
              style={{
                gridTemplateColumns: `repeat(${rounds.length}, 21rem) 18rem`,
                minWidth: `${rounds.length * 368 + 288}px`,
              }}
            >
              {rounds.map(({ round, matches }) => (
                <div key={round} className="space-y-5">
                  <div className="flex items-center justify-between rounded-full border border-white/10 bg-white/10 px-4 py-2">
                    <h2 className="text-sm font-black uppercase tracking-[0.22em] text-slate-200">
                      {roundName(round, maxRound)}
                    </h2>
                    <span className="text-xs font-semibold text-slate-400">Round {round}</span>
                  </div>
                  <div
                    className="grid"
                    style={{
                      gap: `${22 + (2 ** (round - 1) - 1) * 84}px`,
                      paddingTop: `${(2 ** (round - 1) - 1) * 78}px`,
                    }}
                  >
                    {matches.map((match) => (
                      <DisplayMatchCard
                        key={match.id}
                        match={match}
                        player1={participantFor(match.player1_id)}
                        player2={participantFor(match.player2_id)}
                      />
                    ))}
                  </div>
                </div>
              ))}

              <div className="space-y-5" style={{ paddingTop: `${(2 ** maxRound - 1) * 39}px` }}>
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  <h2 className="text-sm font-black uppercase tracking-[0.22em] text-slate-200">
                    Winner
                  </h2>
                </div>
                <Card className="border-amber-300/40 bg-gradient-to-br from-amber-300/25 to-white/10 text-white">
                  <CardContent className="p-6">
                    <div className="flex items-center gap-4">
                      <div className="grid h-14 w-14 place-items-center rounded-full bg-amber-400 text-slate-950">
                        <Crown className="h-8 w-8" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-200">
                          Champion
                        </p>
                        <p className="text-3xl font-black">{champion?.name ?? 'Awaiting final'}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </section>
        ) : (
          <Card className="border-white/10 bg-white/10 text-white">
            <CardContent className="p-8 text-sm text-slate-300">
              Loading display bracket...
            </CardContent>
          </Card>
        )}
      </section>
    </main>
  )
}

type DisplayMatchCardProps = {
  match: Match
  player1: Participant | null
  player2: Participant | null
}

function DisplayMatchCard({ match, player1, player2 }: DisplayMatchCardProps) {
  return (
    <Card className={cn('relative overflow-hidden bg-white/10 text-white', displayStatusClass(match.status))}>
      <div
        className={cn(
          'absolute inset-x-0 top-0 h-1',
          match.status === 'completed'
            ? 'bg-emerald-400'
            : match.status === 'ready'
              ? 'bg-orange-400'
              : 'bg-slate-500',
        )}
      />
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm">
          <span>Match {match.position}</span>
          <span className="capitalize text-slate-300">{match.status}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <DisplayPlayerRow
          participant={player1}
          score={match.player1_score}
          isWinner={match.winner_id === player1?.id}
        />
        <DisplayPlayerRow
          participant={player2}
          score={match.player2_score}
          isWinner={match.winner_id === player2?.id}
        />
      </CardContent>
    </Card>
  )
}

type DisplayPlayerRowProps = {
  participant: Participant | null
  score: number | null
  isWinner: boolean
}

function DisplayPlayerRow({ participant, score, isWinner }: DisplayPlayerRowProps) {
  return (
    <div
      className={cn(
        'grid grid-cols-[2rem_1fr_3.5rem] items-center gap-3 rounded-xl border px-3 py-3',
        isWinner ? 'border-emerald-300/40 bg-emerald-300/15' : 'border-white/10 bg-white/5',
      )}
    >
      <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-xs font-black text-slate-300">
        {participant?.seed ?? '-'}
      </span>
      <span className={cn('truncate text-lg font-black', participant ? 'text-white' : 'text-slate-500')}>
        {participant?.name ?? 'TBD'}
      </span>
      <span className="text-center text-2xl font-black">{score ?? '-'}</span>
    </div>
  )
}

type MatchCardProps = {
  match: Match
  player1: Participant | null
  player2: Participant | null
  saving: boolean
  editingLocked: boolean
  onPatch: (matchId: number, patch: Partial<Match>) => void
  onSave: (match: Match, winnerId?: number | null) => void
  onUpdateParticipant: (id: number, name: string) => void
}

function MatchCard({
  match,
  player1,
  player2,
  saving,
  editingLocked,
  onPatch,
  onSave,
  onUpdateParticipant,
}: MatchCardProps) {
  return (
    <Card
      className={cn(
        'relative overflow-hidden bg-white/95 shadow-lg shadow-slate-200/50',
        statusClass(match.status),
      )}
    >
      <div
        className={cn(
          'absolute inset-x-0 top-0 h-1',
          match.status === 'completed'
            ? 'bg-emerald-500'
            : match.status === 'ready'
              ? 'bg-orange-500'
              : 'bg-slate-300',
        )}
      />
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm">
          <span>Match {match.position}</span>
          <Badge
            className={cn(
              'capitalize',
              match.status === 'completed'
                ? 'bg-emerald-600'
                : match.status === 'ready'
                  ? 'bg-orange-500'
                  : 'bg-slate-400',
            )}
          >
            {match.status}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {match.player1_score !== null &&
        match.player2_score !== null &&
        match.player1_score === match.player2_score ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
            Tied scores need a manual winner before advancing.
          </div>
        ) : null}
        <PlayerRow
          slot="player1_score"
          match={match}
          participant={player1}
          isWinner={match.winner_id === player1?.id}
          onPatch={onPatch}
          onUpdateParticipant={onUpdateParticipant}
          onPickWinner={(winnerId) => onSave(match, winnerId)}
          disabled={editingLocked}
        />
        <PlayerRow
          slot="player2_score"
          match={match}
          participant={player2}
          isWinner={match.winner_id === player2?.id}
          onPatch={onPatch}
          onUpdateParticipant={onUpdateParticipant}
          onPickWinner={(winnerId) => onSave(match, winnerId)}
          disabled={editingLocked}
        />
        {match.winner_id ? (
          <Button
            size="sm"
            variant="outline"
            className="w-full bg-white"
            disabled={saving || editingLocked}
            onClick={() => onSave({ ...match, winner_id: null }, null)}
          >
            Clear winner
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          className="w-full"
          disabled={saving || editingLocked || match.status === 'pending'}
          onClick={() => onSave(match)}
        >
          <Save className="h-3.5 w-3.5" /> {saving ? 'Saving...' : 'Save scores'}
        </Button>
      </CardContent>
    </Card>
  )
}

type PlayerRowProps = {
  slot: 'player1_score' | 'player2_score'
  match: Match
  participant: Participant | null
  isWinner: boolean
  onPatch: (matchId: number, patch: Partial<Match>) => void
  onUpdateParticipant: (id: number, name: string) => void
  onPickWinner: (winnerId: number) => void
  disabled: boolean
}

function PlayerRow({
  slot,
  match,
  participant,
  isWinner,
  onPatch,
  onUpdateParticipant,
  onPickWinner,
  disabled,
}: PlayerRowProps) {
  const score = match[slot]

  return (
    <div
      className={cn(
        'grid grid-cols-[1fr_4.25rem] gap-2 rounded-xl border p-2 transition-colors',
        isWinner ? 'border-orange-300 bg-orange-50' : 'border-slate-200 bg-slate-50',
      )}
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-xs font-bold text-slate-500 shadow-sm">
            {participant?.seed ?? '-'}
          </span>
          {participant ? (
            <Input
              defaultValue={participant.name}
              className="h-8 bg-white font-semibold"
              disabled={disabled}
              onBlur={(event) => onUpdateParticipant(participant.id, event.currentTarget.value)}
            />
          ) : (
            <div className="flex h-8 items-center rounded-md px-3 text-sm font-semibold text-slate-400">
              TBD
            </div>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant={isWinner ? 'default' : 'outline'}
          className="h-7 w-full bg-white text-xs"
          disabled={!participant || disabled}
          onClick={() => participant && onPickWinner(participant.id)}
        >
          {isWinner ? 'Winner' : 'Advance'}
        </Button>
      </div>
      <Input
        type="number"
        min={0}
        value={score ?? ''}
        placeholder="0"
        className="h-full text-center text-lg font-black"
        onChange={(event) => {
          const value = event.currentTarget.value
          onPatch(match.id, scorePatch(match, slot, value))
        }}
        disabled={disabled || !match.player1_id || !match.player2_id}
      />
    </div>
  )
}

function roundName(round: number, maxRound: number) {
  if (round === maxRound) return 'Final'
  if (round === maxRound - 1) return 'Semifinals'
  if (round === maxRound - 2) return 'Quarterfinals'
  return `Round ${round}`
}

function scorePatch(match: Match, slot: 'player1_score' | 'player2_score', rawValue: string) {
  const nextMatch = {
    ...match,
    [slot]: rawValue === '' ? null : Number(rawValue),
  }

  if (
    nextMatch.player1_score !== null &&
    nextMatch.player2_score !== null &&
    nextMatch.player1_id &&
    nextMatch.player2_id &&
    nextMatch.player1_score !== nextMatch.player2_score
  ) {
    return {
      [slot]: nextMatch[slot],
      winner_id:
        nextMatch.player1_score > nextMatch.player2_score
          ? nextMatch.player1_id
          : nextMatch.player2_id,
    }
  }

  return { [slot]: nextMatch[slot], winner_id: null }
}

function statusClass(status: Match['status']) {
  if (status === 'completed') return 'border-emerald-200'
  if (status === 'ready') return 'border-orange-200'
  return 'border-slate-200 opacity-80'
}

function displayStatusClass(status: Match['status']) {
  if (status === 'completed') return 'border-emerald-300/30'
  if (status === 'ready') return 'border-orange-300/30'
  return 'border-white/10 opacity-80'
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

export default App
