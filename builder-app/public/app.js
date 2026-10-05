import {
  availableActions, decisionInfo, eventLine, firstLine, formatCost, parseDiff, parseMarkdown, relativeTime, statusInfo,
} from '/lib.js'

const $ = (id) => document.getElementById(id)

const state = {
  projects: [],
  projectId: null,
  runs: [],
  selectedId: null,
  run: null,
  events: [],
  diff: '',
  source: null,
}

/* ---------- small helpers ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function chip(info) {
  return el('span', { class: `chip ${info.tone}` }, info.label)
}

function toast(message, bad = false) {
  const node = el('div', { class: `toast${bad ? ' bad' : ''}` }, message)
  $('toasts').append(node)
  setTimeout(() => node.remove(), bad ? 8000 : 4000)
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || ERROR_TEXT[body?.error] || 'Er ging iets mis.')
    this.status = status
    this.code = body?.error
  }
}

const ERROR_TEXT = {
  unauthorized: 'Je bent niet ingelogd.',
  forbidden: 'Dit mag niet.',
  wrong_password: 'Onjuist wachtwoord.',
  too_many_attempts: 'Te veel pogingen. Probeer het later opnieuw.',
  body_too_large: 'De opdracht is te lang.',
  invalid_effort: 'Kies een van de opties bij "Hoe grondig?".',
  project_busy: 'Er loopt al een opdracht voor dit project.',
  too_many_runs: 'Er lopen al te veel opdrachten tegelijk.',
  not_running: 'Deze opdracht loopt niet meer.',
  already_decided: 'Hierover is al besloten.',
}

async function api(path, { method = 'GET', body, text = false } = {}) {
  const init = { method, headers: {} }
  if (method !== 'GET') {
    init.headers = { 'content-type': 'application/json', 'x-dig-builder': '1' }
    init.body = JSON.stringify(body ?? {})
  }
  const response = await fetch(path, init)
  if (response.status === 401 && !path.startsWith('/api/login')) {
    showLogin()
    throw new ApiError(401, { error: 'unauthorized' })
  }
  if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null))
  return text ? response.text() : response.json()
}

function remember(key, value) {
  try { localStorage.setItem(key, value) } catch { /* private mode */ }
}
function recall(key) {
  try { return localStorage.getItem(key) } catch { return null }
}

/* ---------- login / session ---------- */

function showLogin() {
  closeStream()
  $('app-view').hidden = true
  $('login-view').hidden = false
  $('password').focus()
}

async function showApp() {
  $('login-view').hidden = true
  $('app-view').hidden = false
  await loadProjects()
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  $('login-error').textContent = ''
  try {
    await api('/api/login', { method: 'POST', body: { password: $('password').value } })
    $('password').value = ''
    await showApp()
  } catch (error) {
    $('login-error').textContent = error.message
  }
})

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: {} }).catch(() => {})
  showLogin()
})

/* ---------- projects and runs ---------- */

async function loadProjects() {
  const { projects } = await api('/api/projects')
  state.projects = projects
  const select = $('project')
  select.replaceChildren(...projects.map((p) => el('option', { value: p.id }, p.name)))
  const saved = recall('dig-builder-project')
  state.projectId = projects.some((p) => p.id === saved) ? saved : projects[0]?.id ?? null
  select.value = state.projectId ?? ''
  applyProject()
  await loadRuns()
  const running = state.runs.find((r) => r.state === 'running')
  if (running && !state.selectedId) await selectRun(running.id)
}

function currentProject() {
  return state.projects.find((p) => p.id === state.projectId) ?? null
}

function applyProject() {
  const project = currentProject()
  $('base-branch').textContent = project ? `"${project.baseBranch}"` : 'de hoofdversie'
  const link = $('preview-link')
  link.hidden = !project?.previewUrl
  if (project?.previewUrl) link.href = project.previewUrl
}

$('project').addEventListener('change', async (event) => {
  state.projectId = event.target.value
  remember('dig-builder-project', state.projectId)
  state.selectedId = null
  state.run = null
  closeStream()
  applyProject()
  renderDetail()
  await loadRuns()
})

async function loadRuns() {
  if (!state.projectId) return
  const { runs } = await api(`/api/runs?project=${encodeURIComponent(state.projectId)}`)
  state.runs = runs
  renderRunList()
}

function renderRunList() {
  const list = $('run-list')
  list.replaceChildren(
    ...state.runs.map((run) =>
      el('li', {},
        el('button', { class: 'run-item', type: 'button', 'aria-current': String(run.id === state.selectedId), onclick: () => selectRun(run.id) },
          el('span', { class: 'title' }, firstLine(run.task)),
          el('span', { class: 'meta' },
            chip(statusInfo(run)),
            decisionInfo(run) ? chip(decisionInfo(run)) : null,
            el('span', {}, formatCost(run.estimatedCostUsd)),
            el('span', {}, relativeTime(run.createdAt)),
          ),
        ),
      ),
    ),
  )
  $('run-list-empty').hidden = state.runs.length > 0
}

$('new-run').addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = $('start')
  button.disabled = true
  try {
    const run = await api(`/api/projects/${encodeURIComponent(state.projectId)}/runs`, {
      method: 'POST',
      body: { task: $('task').value, effort: $('effort').value, maxCostUsd: Number($('cost').value) },
    })
    $('task').value = ''
    await loadRuns()
    await selectRun(run.id)
  } catch (error) {
    toast(error.message, true)
  } finally {
    button.disabled = false
  }
})

/* ---------- one run: live progress, result, decision ---------- */

function closeStream() {
  if (state.source) state.source.close()
  state.source = null
}

async function selectRun(id) {
  closeStream()
  state.selectedId = id
  state.events = []
  state.diff = ''
  state.run = null
  // Clear at once: the previous run's buttons must not stay clickable while the new one loads.
  renderDetail()
  renderRunList()
  try {
    await refreshRun()
  } catch (error) {
    toast(error.message, true)
    return
  }
  openStream(id)
}

async function refreshRun() {
  if (!state.selectedId) return
  const run = await api(`/api/runs/${state.selectedId}`)
  const wasRunning = state.run?.running
  state.run = run
  if (run.state !== 'running' && (state.diff === '' || wasRunning)) {
    state.diff = await api(`/api/runs/${run.id}/diff`, { text: true }).catch(() => '')
  }
  renderDetail()
}

function openStream(id) {
  const source = new EventSource(`/api/runs/${id}/events`)
  state.source = source
  // The server replays the whole backlog on every (re)connect.
  source.addEventListener('open', () => {
    state.events = []
  })
  source.addEventListener('run', (message) => {
    state.events.push(JSON.parse(message.data))
    renderProgress()
  })
  source.addEventListener('end', async () => {
    source.close()
    if (state.source === source) state.source = null
    try {
      await refreshRun()
      await loadRuns()
    } catch { /* shown by the next poll */ }
  })
}

function renderDetail() {
  const detail = $('detail')
  const run = state.run
  if (!run) {
    detail.replaceChildren(el('p', { id: 'detail-empty', class: 'muted' }, 'Kies links een opdracht, of geef een nieuwe.'))
    return
  }
  const project = state.projects.find((p) => p.id === run.projectId)
  const info = statusInfo(run)
  const decision = decisionInfo(run)
  const actions = availableActions(run)
  const base = project?.baseBranch ?? 'de hoofdversie'

  const banners = []
  if (run.state === 'failed' || run.status === 'error') {
    banners.push(el('p', { class: 'banner bad' }, `Er ging iets mis: ${run.error ?? 'onbekende fout'}`))
  } else if (run.state === 'finished' && run.status !== 'done') {
    banners.push(el('p', { class: 'banner warn' }, `De agent is gestopt voordat hij klaar was (${info.label.toLowerCase()}). Bekijk de wijzigingen goed voordat je goedkeurt.`))
  }
  if (run.decision === 'approved') {
    banners.push(el('p', { class: 'banner good' }, `Samengevoegd in ${base}${run.mergeCommit ? ` (commit ${run.mergeCommit.slice(0, 7)})` : ''}.`))
  } else if (run.decision === 'rejected') {
    banners.push(el('p', { class: 'banner' }, run.commit ? 'Afgewezen: de branch met deze wijzigingen is verwijderd.' : 'Opgeruimd: de lege branch is verwijderd.'))
  } else if (run.state === 'finished' && !run.commit) {
    banners.push(el('p', { class: 'banner' }, 'De agent heeft niets gewijzigd.'))
  }

  const head = el('div', { class: 'card detail-head' },
    el('div', { class: 'chips' },
      chip(info),
      decision ? chip(decision) : null,
      el('span', { class: 'muted' }, `ca. ${formatCost(run.estimatedCostUsd)} van max ${formatCost(run.maxCostUsd)} · ${run.turns} stappen · ${relativeTime(run.createdAt)}`),
    ),
    el('p', { class: 'task' }, run.task),
    el('div', { class: 'actions' },
      actions.stop ? el('button', { type: 'button', class: 'inline', onclick: () => stopRun(run.id) }, 'Stoppen') : null,
      actions.approve ? el('button', { type: 'button', class: 'primary inline', onclick: () => decide(run.id, 'approve', base) }, `Goedkeuren en samenvoegen in ${base}`) : null,
      actions.reject ? el('button', { type: 'button', class: 'danger', onclick: () => decide(run.id, 'reject', base) }, run.commit ? 'Afwijzen' : 'Opruimen') : null,
    ),
  )

  const sections = [head, ...banners, el('div', { class: 'card', id: 'progress-card' })]
  if (run.state !== 'running' && run.summary) sections.push(resultCard(run))
  const files = parseDiff(state.diff)
  if (run.state !== 'running' && files.length) sections.push(diffCard(files))
  detail.replaceChildren(...sections)
  renderProgress()
}

function renderProgress() {
  const card = $('progress-card')
  if (!card || !state.run) return
  const lines = state.events.map(eventLine).filter(Boolean)
  const running = state.run.state === 'running'
  const list = el('ul', { class: 'timeline' },
    lines.map((line) =>
      el('li', {},
        el('span', { class: `mark ${line.mark === 'ok' ? 'ok' : line.mark === 'fail' ? 'fail' : ''}` }, line.mark === 'ok' ? '✓' : line.mark === 'fail' ? '✗' : '•'),
        el('span', {}, line.text, line.code ? ' ' : null, line.code ? el('code', {}, line.code) : null),
      ),
    ),
    running ? el('li', {}, el('span', { class: 'mark' }, el('span', { class: 'spinner' })), el('span', { class: 'muted' }, 'Bezig…')) : null,
  )
  card.replaceChildren(el('h2', {}, 'Voortgang'), lines.length || running ? list : el('p', { class: 'muted' }, 'Geen voortgang bewaard voor deze opdracht.'))
  list.scrollTop = list.scrollHeight
}

function inline(tokens) {
  return tokens.map((token) => (token.t === 'strong' ? el('strong', {}, token.v) : token.t === 'code' ? el('code', {}, token.v) : token.v))
}

function resultCard(run) {
  const blocks = parseMarkdown(run.summary).map((block) =>
    block.type === 'ul' ? el('ul', {}, block.items.map((item) => el('li', {}, inline(item)))) : el('p', {}, inline(block.inline)),
  )
  return el('div', { class: 'card' },
    el('h2', {}, 'Resultaat'),
    el('div', { class: 'summary' }, blocks),
    run.changedFiles.length
      ? el('div', {}, el('h3', {}, 'Gewijzigde bestanden'), el('ul', { class: 'files' }, run.changedFiles.map((file) => el('li', {}, el('code', {}, file)))))
      : null,
  )
}

const MAX_DIFF_LINES = 3000

function diffCard(files) {
  return el('div', { class: 'card' },
    el('h2', {}, `Wijzigingen (${files.length} ${files.length === 1 ? 'bestand' : 'bestanden'})`),
    files.map((file, index) => {
      const shown = file.lines.slice(0, MAX_DIFF_LINES)
      return el('details', { class: 'diff-file', open: files.length <= 3 || index === 0 },
        el('summary', {}, el('code', {}, file.path), el('span', { class: 'count' }, el('span', { class: 'plus' }, `+${file.added}`), ' ', el('span', { class: 'minus' }, `−${file.removed}`))),
        el('pre', { class: 'diff' },
          shown.map((line) => el('span', { class: `line ${line.kind}` }, line.text === '' ? ' ' : line.text)),
          file.lines.length > shown.length ? el('span', { class: 'line hunk' }, `… nog ${file.lines.length - shown.length} regels niet getoond`) : null,
        ),
      )
    }),
  )
}

async function stopRun(id) {
  try {
    await api(`/api/runs/${id}/stop`, { method: 'POST', body: {} })
    toast('Stoppen… de agent rondt de huidige stap af.')
  } catch (error) {
    toast(error.message, true)
  }
}

// The buttons carry the id of the run they were drawn for, never "whatever is selected now".
async function decide(id, kind, base) {
  const question = kind === 'approve'
    ? `De wijzigingen worden samengevoegd in "${base}" van dit project. Doorgaan?`
    : 'De branch met deze wijzigingen wordt verwijderd. Doorgaan?'
  if (!window.confirm(question)) return
  try {
    await api(`/api/runs/${id}/${kind}`, { method: 'POST', body: {} })
    toast(kind === 'approve' ? `Samengevoegd in ${base}.` : 'Branch verwijderd.')
    if (state.selectedId === id) await refreshRun()
    await loadRuns()
  } catch (error) {
    toast(error.message, true)
  }
}

/* ---------- start ---------- */

setInterval(async () => {
  if (document.hidden || $('app-view').hidden) return
  try {
    await loadRuns()
    if (state.run?.state === 'running' && !state.source) await refreshRun()
  } catch { /* the next poll tries again */ }
}, 5000)

try {
  const { authenticated } = await api('/api/session')
  if (authenticated) await showApp()
  else showLogin()
} catch {
  showLogin()
}
