/**
 * Peer talk — conversations talking to conversations.
 *
 * Three channels, one permission story:
 *
 *   1. private messages between conversations (`peer_send`), now including
 *      conversations in OTHER workspaces when the sender is allowed to cross;
 *   2. starting a new conversation (`peer_create`), which the user grants per
 *      workspace or per conversation;
 *   3. a forum (`forum_*`): threads anyone may read, posts gated the same way.
 *      Nothing in the forum wakes anyone — a conversation reads it when it
 *      chooses, which is the whole point of a board over a broadcast.
 *
 * Permissions are a tree: capability defaults at the root, overridable per
 * workspace and per conversation. Every tool consults it, and no tool can edit
 * it — the user owns that page (Settings → Peer talk, the session's Peer talk
 * view, or `/peer`).
 *
 * @module dsh-peer-talk
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Plugin identity used by loader diagnostics. */
export const name = 'peer-talk'

/** The tool registry is the one hard dependency: everything else is optional. */
export const inject = ['tools']

/** Capabilities the permission tree manages. */
export const CAPABILITIES = ['create', 'cross', 'forum']
/** Values one capability node may hold. */
export const MODES = ['allow', 'ask', 'deny']
/** Marker that prefixes every delivered message, so a receiver can recognise one. */
const MARKER = '[peer-message]'
/** Forum keeps this many threads / posts before trimming the oldest. */
const FORUM_MAX_THREADS = 300
const FORUM_MAX_POSTS = 300
const FORUM_MAX_BODY = 8000

/** Defaults, also used as the seed for a profile that has no settings file yet. */
const DEFAULTS = {
  send: 'auto',
  defaults: { create: 'ask', cross: 'ask', forum: 'ask' },
  grants: {},
  names: {},
  humanName: '鹿',
  receiver: { mode: 'handler', canInterrupt: true, model: null },
  defaultModel: null,
  maxSendsPerMinute: 8,
  maxMessageChars: 4000,
}

/** What an unreadable settings document resolves to: the restrictive reading. */
const RESTRICTIVE = {
  send: 'off',
  defaults: { create: 'deny', cross: 'deny', forum: 'deny' },
  grants: {},
  names: {},
  receiver: { mode: 'queue', canInterrupt: false },
}

/** How many receiver subagents one conversation may run at the same time. */
const RECEIVER_CONCURRENCY = 2

/**
 * Codename vocabulary: every conversation gets a short, stable, human-readable
 * name, because a forum post signed with a truncated session title ("我希望创建
 * 一个插件，允许同") tells the reader nothing. The name is derived from the
 * session id, so it survives restarts without any stored state, and the user can
 * override it in the permission page.
 */
const NAME_WORDS = [
  '青柠', '白露', '灰鲸', '海盐', '松子', '麦冬', '琥珀', '砂砾', '暮云', '赤豆',
  '青禾', '墨鱼', '银杏', '霜降', '竹青', '秋分', '烟灰', '石榴', '藤萝', '黛蓝',
  '茶白', '桔梗', '薄荷', '雾白', '砖红', '桐花', '湖蓝', '藕荷', '豆绿', '花青',
  '赭石', '月白', '酡颜', '鸦青', '胭脂', '藤黄', '青碧', '绛紫', '米白', '苍青',
]

/** FNV-1a over the session id, so the name never changes for the same session. */
function hashOf(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/**
 * The stable codename of one conversation.
 * @param sessionId - the session id.
 * @returns a short name such as "青柠-42".
 */
export function deriveName(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId : ''
  if (id === '') return '未命名'
  const hash = hashOf(id)
  return `${NAME_WORDS[hash % NAME_WORDS.length]}-${String(10 + ((hash >>> 7) % 90))}`
}

/**
 * Display name of one conversation: the user's override, else the codename.
 * @param settings - the resolved settings document.
 * @param sessionId - the session id.
 * @returns the name to show in the forum and in peer listings.
 */
export function nameFor(settings, sessionId) {
  const override = settings?.names?.[sessionId]
  return typeof override === 'string' && override !== '' ? override : deriveName(sessionId)
}

/**
 * The author line of one forum post, resolved at read time so renaming a
 * conversation also updates what history shows.
 * @param settings - the resolved settings document.
 * @param post - the stored post.
 * @returns the author to display.
 */
function authorOf(settings, post) {
  const session = typeof post?.session === 'string' ? post.session : ''
  if (/^session-/.test(session)) return nameFor(settings, session)
  // Posts the human wrote through the page, including the ones stored before
  // the forum had a name for them.
  if (session === 'human' || post?.author === 'the user') return settings?.humanName ?? 'you'
  if (typeof post?.author === 'string' && post.author !== '') return post.author
  return 'someone'
}

/**
 * Absolute path of the plugin's settings document.
 * Kept beside the other plugin state rather than inside a profile, so switching
 * profiles keeps the user's answers.
 * @returns the settings file path.
 */
export function settingsPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'peer-talk', 'settings.json')
}

/** Absolute path of the forum document. */
export function forumPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'peer-talk', 'forum.json')
}

/** Coerce one member of a fixed vocabulary, keeping the fallback otherwise. */
function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** Coerce one positive integer, keeping the fallback when unusable. */
function positiveInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  return floored > 0 ? floored : fallback
}

/** Keep only plausible session ids, de-duplicated and bounded. */
function sessionIdList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const ids = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (!/^session-[A-Za-z0-9][A-Za-z0-9-]*$/.test(id) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= 500) break
  }
  return ids
}

/** Read one `{ provider, model, reasoningEffort? }` record, or null. */
function modelRef(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') return null
  const reasoningEffort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
  return { provider, model, ...reasoningEffort === '' ? {} : { reasoningEffort } }
}

/**
 * Sanitize the grant map: `session:<id>` / `workspace:<id>` keys, capability
 * values from the vocabulary, everything else dropped. This map is the
 * security-relevant part of the document, so a typo must not become a grant.
 * @param value - whatever the document held.
 * @returns the usable map.
 */
function grantMap(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!/^(session|workspace):[A-Za-z0-9][A-Za-z0-9-]*$/.test(key)) continue
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = {}
    for (const capability of CAPABILITIES) {
      const mode = raw[capability]
      if (typeof mode === 'string' && MODES.includes(mode)) entry[capability] = mode
    }
    if (Object.keys(entry).length > 0) result[key] = entry
  }
  return result
}

/**
 * Resolve a raw settings document over a seed (the patch row's config).
 * Reads the retired flat keys too (`createSession`, `allowedSessions`), so an
 * upgrade keeps the user's earlier answers.
 * @param raw - the parsed file contents, or undefined when no file exists.
 * @param seed - defaults from the plugin configuration.
 * @returns the resolved settings document.
 */
export function resolveSettings(raw, seed = {}) {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const seedSource = typeof seed === 'object' && seed !== null ? seed : {}
  const readDefaults = origin => {
    const block = typeof origin.defaults === 'object' && origin.defaults !== null && !Array.isArray(origin.defaults)
      ? origin.defaults
      : {}
    return {
      create: oneOf(block.create ?? origin.createSession, MODES, DEFAULTS.defaults.create),
      cross: oneOf(block.cross, MODES, DEFAULTS.defaults.cross),
      forum: oneOf(block.forum, MODES, DEFAULTS.defaults.forum),
    }
  }
  const baseDefaults = readDefaults(seedSource)
  const defaults = {
    create: oneOf(source.defaults?.create ?? source.createSession, MODES, baseDefaults.create),
    cross: oneOf(source.defaults?.cross, MODES, baseDefaults.cross),
    forum: oneOf(source.defaults?.forum, MODES, baseDefaults.forum),
  }

  const seedGrants = grantMap(seedSource.grants)
  for (const id of sessionIdList(seedSource.allowedSessions)) seedGrants[`session:${id}`] = { ...seedGrants[`session:${id}`], create: 'allow' }
  const grants = source.grants === undefined ? seedGrants : grantMap(source.grants)
  // The v1 document recorded per-session creation grants as a flat list.
  for (const id of sessionIdList(source.allowedSessions)) grants[`session:${id}`] = { ...grants[`session:${id}`], create: 'allow' }

  return {
    send: oneOf(source.send, ['auto', 'ask', 'off'], oneOf(seedSource.send, ['auto', 'ask', 'off'], DEFAULTS.send)),
    defaults,
    grants,
    names: nameMap(source.names === undefined ? seedSource.names : source.names),
    humanName: humanNameOf(source.humanName ?? seedSource.humanName),
    receiver: receiverSettingsOf(source.receiver ?? seedSource.receiver),
    defaultModel: source.defaultModel === undefined
      ? modelRef(seedSource.defaultModel)
      : modelRef(source.defaultModel),
    maxSendsPerMinute: positiveInt(source.maxSendsPerMinute ?? seedSource.maxSendsPerMinute, DEFAULTS.maxSendsPerMinute),
    maxMessageChars: positiveInt(source.maxMessageChars ?? seedSource.maxMessageChars, DEFAULTS.maxMessageChars),
  }
}

/**
 * Sanitize the receive mode. `handler` spawns a receiver subagent per message;
 * `queue` keeps the old next-turn inbox behaviour.
 * @param value - whatever the document held for `receiver`.
 * @returns the resolved receive settings.
 */
function receiverSettingsOf(value) {
  const block = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  return {
    mode: oneOf(block.mode, ['handler', 'queue'], DEFAULTS.receiver.mode),
    // A permission switch: only an explicit `false` removes the right to interrupt.
    canInterrupt: block.canInterrupt === undefined ? DEFAULTS.receiver.canInterrupt : block.canInterrupt === true,
    // Optional model for the receiver itself, as "provider/model"; empty means
    // the deployment default.
    model: typeof block.model === 'string' && block.model.trim() !== '' ? block.model.trim() : null,
  }
}

/**
 * Sanitize the name overrides: `session:<id>` keys and short display names.
 * @param value - whatever the document held for `names`.
 * @returns the usable map.
 */
function nameMap(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!/^session-[A-Za-z0-9][A-Za-z0-9-]*$/.test(key)) continue
    if (typeof raw !== 'string') continue
    const name = raw.trim().slice(0, 24)
    if (name === '') continue
    result[key] = name
  }
  return result
}

/** The user's own forum name. */
function humanNameOf(value) {
  if (typeof value !== 'string') return DEFAULTS.humanName
  const name = value.trim().slice(0, 24)
  return name === '' ? DEFAULTS.humanName : name
}

/**
 * Resolve one capability for one conversation: the most specific node wins.
 * @param settings - the resolved settings document.
 * @param node - `{ sessionId, workspaceId }` for the asking conversation.
 * @param capability - one of {@link CAPABILITIES}.
 * @returns `allow` | `ask` | `deny`.
 */
export function capabilityFor(settings, node, capability) {
  const session = node.sessionId === undefined ? undefined : settings.grants[`session:${node.sessionId}`]?.[capability]
  if (session !== undefined) return session
  const workspace = node.workspaceId === undefined ? undefined : settings.grants[`workspace:${node.workspaceId}`]?.[capability]
  if (workspace !== undefined) return workspace
  return settings.defaults?.[capability] ?? 'ask'
}

/**
 * Split `provider/model` — or accept a bare model id for the single-provider case.
 * @param raw - the model string a caller passed.
 * @returns the parts, or null for an empty value.
 */
export function parseModelSpec(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null
  const slash = text.indexOf('/')
  if (slash > 0 && slash < text.length - 1) {
    return { provider: text.slice(0, slash).trim(), model: text.slice(slash + 1).trim() }
  }
  return { model: text, provider: undefined }
}

/** Patches for these keys replace the stored value instead of merging into it,
 *  because their entries are removed as well as added (a grant must be able to
 *  disappear). */
const REPLACE_KEYS = new Set(['grants', 'defaults', 'names'])

/**
 * Merge a partial patch into the stored document.
 * @param base - the current document.
 * @param patch - fields to change.
 * @returns the merged, unresolved document.
 */
function mergePatch(base, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return base
  const merged = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key]
    if (!REPLACE_KEYS.has(key)
      && typeof value === 'object' && value !== null && !Array.isArray(value)
      && typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
      merged[key] = { ...existing, ...value }
    } else {
      merged[key] = value
    }
  }
  return merged
}

/**
 * File-backed settings with an in-memory snapshot.
 *
 * The document is re-read when its mtime changes, so a hand edit takes effect
 * without a restart. Writes are atomic (temporary file + rename) because a torn
 * write here would flip a permission.
 */
export class SettingsStore {
  /** @param seed - defaults from the plugin configuration. @param file - override path (tests). */
  constructor(seed = {}, file = settingsPath()) {
    this.seed = seed
    this.file = file
    this.cached = undefined
    this.cachedMtimeMs = -1
  }

  /** @returns the file this store reads and writes. */
  path() {
    return this.file
  }

  /**
   * Current settings, re-read when the file changed on disk.
   * @returns the resolved document.
   */
  get() {
    let mtimeMs = -1
    try {
      mtimeMs = statSync(this.file).mtimeMs
    } catch {
      mtimeMs = -1
    }
    if (this.cached !== undefined && mtimeMs === this.cachedMtimeMs) return this.cached

    let text
    if (mtimeMs !== -1) {
      try {
        text = readFileSync(this.file, 'utf8')
      } catch {
        this.cached = { ...resolveSettings({}, this.seed), ...RESTRICTIVE }
        this.cachedMtimeMs = mtimeMs
        return this.cached
      }
    }
    try {
      const body = text === undefined ? undefined : text.replace(/^\uFEFF/, '')
      this.cached = body === undefined ? resolveSettings({}, this.seed) : resolveSettings(JSON.parse(body), this.seed)
    } catch {
      this.cached = { ...resolveSettings({}, this.seed), ...RESTRICTIVE }
    }
    this.cachedMtimeMs = mtimeMs
    return this.cached
  }

  /**
   * Merge a patch into the stored document and persist it.
   * @param patch - the fields to change.
   * @returns the settings after the merge.
   */
  update(patch) {
    const current = this.get()
    const merged = resolveSettings(mergePatch(current, patch), this.seed)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileAtomic(this.file, `${JSON.stringify(merged, null, 2)}\n`)
    } catch (error) {
      this.cached = undefined
      this.cachedMtimeMs = -1
      throw new Error(`peer-talk: settings could not be saved: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.cached = merged
    try {
      this.cachedMtimeMs = statSync(this.file).mtimeMs
    } catch {
      this.cachedMtimeMs = -1
    }
    return merged
  }
}

/**
 * Write a file atomically: a uniquely named sibling, then rename over the target.
 * @param file - target path.
 * @param contents - complete new contents.
 */
function writeFileAtomic(file, contents) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    writeFileSync(temporary, contents)
    renameSync(temporary, file)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* the temporary is already the least of it */ }
    throw error
  }
}

/** Strip trailing separators so two spellings of one directory compare equal. */
function normalizePath(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const trimmed = value.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** Human-readable age of a timestamp in milliseconds. */
function age(now, then) {
  if (typeof then !== 'number' || !Number.isFinite(then)) return undefined
  return Math.max(0, Math.round((now - then) / 60000))
}

/** One conversation's display title, from the list projection. */
function titleOf(summary) {
  const title = summary?.projections?.values?.title
  return typeof title === 'string' && title !== '' ? title : undefined
}

/**
 * The caller's effective working directory.
 * @param ctx - the plugin context.
 * @param selfId - the calling session id.
 * @param summaries - session summaries, used as the fallback source.
 * @returns the directory, or undefined when the deployment cannot tell.
 */
function callerDirectory(ctx, selfId, summaries) {
  const session = ctx.get('sessions')?.get(selfId)
  if (session !== undefined) {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined) {
      try {
        const directory = workingDirectory.get(session)
        if (typeof directory === 'string' && directory !== '') return directory
      } catch { /* fall through to the header */ }
    }
    if (typeof session.header?.cwd === 'string') return session.header.cwd
  }
  return summaries.find(summary => summary.sessionId === selfId)?.cwd
}

/**
 * Every conversation in a place the caller may address, with workspace identity.
 * @param ctx - the plugin context.
 * @param selfId - the calling session id.
 * @param signal - caller cancellation.
 * @param scope - `workspace` (default) or `all`.
 * @returns the caller's workspace, its directory, and the visible peers.
 */
async function peerView(ctx, selfId, signal, scope = 'workspace', nameOf = id => id) {
  const controller = ctx.get('sessionController')
  if (controller === undefined) throw new Error('peer-talk: this deployment has no session service, so peers cannot be listed')
  const listed = await controller.list({}, signal)
  const summaries = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : []
  const registry = ctx.get('workspaceRegistry')
  const workspaces = registry === undefined ? [] : registry.list()
  const own = workspaces.find(candidate => candidate.sessionIds.includes(selfId))
  const selfCwd = callerDirectory(ctx, selfId, summaries)
  const byId = new Map(summaries.map(summary => [summary.sessionId, summary]))

  const memberIds = own !== undefined
    ? own.sessionIds
    : summaries
      .filter(summary => normalizePath(summary.cwd) !== undefined && normalizePath(summary.cwd) === normalizePath(selfCwd))
      .map(summary => summary.sessionId)

  const now = Date.now()
  const peers = []
  const seen = new Set()
  for (const id of memberIds) {
    if (id === selfId) continue
    const summary = byId.get(id)
    if (summary === undefined) continue
    if (summary.origin === 'subagent') continue
    if (summary.blank === true) continue
    if (summary.formatStatus === 'migration-required') continue
    seen.add(id)
    peers.push({
      session: id,
      name: nameOf(id),
      ...titleOf(summary) === undefined ? {} : { title: titleOf(summary) },
      running: summary.running === true,
      ...age(now, summary.updatedAt) === undefined ? {} : { minutes_ago: age(now, summary.updatedAt) },
      workspace: own?.title ?? '(none)',
      cross: false,
    })
  }

  if (scope === 'all') {
    for (const workspace of workspaces) {
      if (workspace.id === own?.id) continue
      for (const id of workspace.sessionIds) {
        if (id === selfId || seen.has(id)) continue
        const summary = byId.get(id)
        if (summary === undefined) continue
        if (summary.origin === 'subagent') continue
        if (summary.blank === true) continue
        if (summary.formatStatus === 'migration-required') continue
        seen.add(id)
        peers.push({
          session: id,
          name: nameOf(id),
          ...titleOf(summary) === undefined ? {} : { title: titleOf(summary) },
          running: summary.running === true,
          ...age(now, summary.updatedAt) === undefined ? {} : { minutes_ago: age(now, summary.updatedAt) },
          workspace: workspace.title,
          cross: true,
        })
      }
    }
  }

  peers.sort((left, right) => (left.minutes_ago ?? Infinity) - (right.minutes_ago ?? Infinity))
  return { workspace: own, selfCwd, peers, workspaces }
}

/**
 * Build the text a receiving conversation reads.
 * @param sender - the sending session id.
 * @param senderTitle - the sending conversation's title, when it has one.
 * @param senderWorkspace - the sending workspace's title.
 * @param message - the message body.
 * @returns the delivered text.
 */
function composeMessage(sender, senderTitle, senderWorkspace, message) {
  const from = typeof senderTitle === 'string' && senderTitle !== ''
    ? `"${senderTitle}" (${sender})`
    : sender
  const where = typeof senderWorkspace === 'string' && senderWorkspace !== '' ? ` in workspace "${senderWorkspace}"` : ''
  return [
    `${MARKER} from ${from}${where}.`,
    `Reply with \`peer_send\` to ${sender} only if a reply changes what the other conversation does next; otherwise ignore this and finish.`,
    '-----',
    message,
  ].join('\n')
}

/**
 * Resolve one requested model against the deployment's routable catalog.
 * @param ctx - the plugin context.
 * @param spec - `{ provider?, model, reasoningEffort? }`.
 * @returns the resolved `{ provider, model, reasoningEffort? }`.
 */
async function resolveModelSelection(ctx, spec) {
  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.modelCatalog !== 'function') {
    throw new Error('peer-talk: this deployment cannot enumerate models, so a model cannot be chosen here')
  }
  const catalog = await controller.modelCatalog()
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  const effort = spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort }
  if (typeof spec.provider === 'string' && spec.provider !== '') {
    const group = groups.find(candidate => candidate.id === spec.provider)
    if (group === undefined) {
      throw new Error(`peer-talk: unknown provider "${spec.provider}". Providers here: ${groups.map(entry => entry.id).join(', ') || '(none)'}`)
    }
    const model = group.models.find(candidate => candidate.id === spec.model)
    if (model === undefined) {
      throw new Error(`peer-talk: provider "${spec.provider}" has no model "${spec.model}". Its models: ${group.models.map(entry => entry.id).join(', ')}`)
    }
    return { provider: group.id, model: model.id, ...effort }
  }
  const matches = []
  for (const group of groups) {
    for (const model of group.models) {
      if (model.id === spec.model) matches.push({ provider: group.id, model: model.id })
    }
  }
  if (matches.length === 1) return { ...matches[0], ...effort }
  if (matches.length === 0) {
    const all = groups.flatMap(group => group.models.map(model => `${group.id}/${model.id}`))
    throw new Error(`peer-talk: no routable model "${spec.model}". Available: ${all.slice(0, 40).join(', ')}${all.length > 40 ? ', …' : ''}`)
  }
  throw new Error(`peer-talk: "${spec.model}" exists under several providers (${matches.map(match => match.provider).join(', ')}); pass "provider/model"`)
}

/**
 * Combine the gates that apply to one send into a single decision.
 * @param settings - the resolved settings document.
 * @param node - the sending conversation's identity.
 * @param cross - whether the target lives in another workspace.
 * @returns `allow` | `ask` | `deny`.
 */
function sendPolicy(settings, node, cross) {
  if (settings.send === 'off') return 'deny'
  if (cross && capabilityFor(settings, node, 'cross') === 'deny') return 'deny'
  if (settings.send === 'ask') return 'ask'
  if (cross && capabilityFor(settings, node, 'cross') === 'ask') return 'ask'
  return 'allow'
}

/**
 * Enforce one decision, asking the user through the host's approval system when
 * the decision is `ask`.
 * @param ctx - the plugin context.
 * @param exec - the tool execution (agent, call id, signal).
 * @param policy - `allow` | `ask` | `deny`.
 * @param reason - the sentence the approval prompt shows.
 * @param displayReason - localized title for the prompt.
 * @returns resolves when the action is permitted.
 */
async function enforce(ctx, exec, policy, reason, displayReason) {
  if (policy === 'deny') {
    throw new Error('peer-talk: this conversation is not allowed to do that. The user grants it per workspace or per conversation in the Peer talk page (or with /peer grant), and it is not granted here.')
  }
  if (policy !== 'ask') return
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error('peer-talk: this action needs the user\'s approval, but this deployment has no approval service — refusing rather than acting unasked.')
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'peer_talk',
    callId: exec.callId,
    reason,
    displayReason,
    signal: exec.signal,
  })
  if (outcome === 'allowed-once') return
  if (outcome === 'rejected') {
    throw new Error('peer-talk: the user declined this request. Do not retry the same call; report the refusal instead.')
  }
  throw new Error(`peer-talk: the approval request ended as "${outcome}" and was not granted, so nothing was done.`)
}

/**
 * The forum document: threads with posts, ordered by last activity.
 *
 * Forums are pull-only by design — writing a post never wakes anyone, so a
 * crowded board cannot turn into a storm of agent turns.
 */
export class ForumStore {
  /** @param file - override path (tests). */
  constructor(file = forumPath()) {
    this.file = file
    this.cached = undefined
    this.cachedMtimeMs = -1
  }

  /** @returns the file this store reads and writes. */
  path() {
    return this.file
  }

  /** @returns `{ threads }`, re-read when the file changed. */
  get() {
    let mtimeMs = -1
    try {
      mtimeMs = statSync(this.file).mtimeMs
    } catch {
      mtimeMs = -1
    }
    if (this.cached !== undefined && mtimeMs === this.cachedMtimeMs) return this.cached
    let document = { threads: [] }
    if (mtimeMs !== -1) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''))
        if (Array.isArray(parsed?.threads)) document = { threads: parsed.threads.filter(thread => this.validThread(thread)) }
      } catch {
        document = { threads: [] }
      }
    }
    this.cached = document
    this.cachedMtimeMs = mtimeMs
    return document
  }

  /** @param thread - candidate thread row. @returns whether it is usable. */
  validThread(thread) {
    return typeof thread === 'object' && thread !== null
      && typeof thread.id === 'string'
      && typeof thread.title === 'string'
      && Array.isArray(thread.posts)
  }

  /**
   * Append one post, creating the thread when `threadId` is absent.
   * @param input - author identity and content.
   * @returns the thread after the write.
   */
  post(input) {
    const document = this.get()
    const now = Date.now()
    let thread = input.threadId === undefined
      ? undefined
      : document.threads.find(candidate => candidate.id === input.threadId)
    if (thread === undefined) {
      if (input.threadId !== undefined) throw new Error(`peer-talk: no forum thread "${input.threadId}"`)
      thread = {
        id: `t-${randomUUID().slice(0, 8)}`,
        title: input.title,
        workspace: input.workspace,
        workspaceId: input.workspaceId,
        createdAt: now,
        updatedAt: now,
        posts: [],
      }
      document.threads.unshift(thread)
    }
    thread.posts.push({
      id: `p-${randomUUID().slice(0, 8)}`,
      session: input.session,
      author: input.author,
      workspace: input.workspace,
      body: input.body.length > FORUM_MAX_BODY ? `${input.body.slice(0, FORUM_MAX_BODY)}…` : input.body,
      createdAt: now,
    })
    thread.updatedAt = now
    if (thread.posts.length > FORUM_MAX_POSTS) thread.posts = thread.posts.slice(-FORUM_MAX_POSTS)
    document.threads.sort((left, right) => right.updatedAt - left.updatedAt)
    if (document.threads.length > FORUM_MAX_THREADS) document.threads = document.threads.slice(0, FORUM_MAX_THREADS)
    this.save(document)
    return thread
  }

  /**
   * Persist one document atomically.
   * @param document - the complete new document.
   */
  save(document) {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileAtomic(this.file, `${JSON.stringify(document, null, 2)}\n`)
    this.cached = document
    try {
      this.cachedMtimeMs = statSync(this.file).mtimeMs
    } catch {
      this.cachedMtimeMs = -1
    }
  }
}

/**
 * Register one tool for the lifetime of the plugin.
 * @param ctx - the plugin context.
 * @param log - diagnostics sink.
 * @param definition - the registry-ready tool definition.
 */
function registerTool(ctx, log, definition) {
  try {
    ctx.effect(() => ctx.tools.register(definition))
  } catch (error) {
    log.warn?.(`peer-talk: could not register ${definition.name} (${String(error)})`)
  }
}

/**
 * Flatten one message's content to a single readable line, for the receiver's
 * context tool.
 * @param message - a derived session message.
 * @returns one line such as `user: …` or `assistant: [tool read]`.
 */
function messageLine(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text.replace(/\s+/g, ' ').trim().slice(0, 180))
    } else if (block?.type === 'tool-call') {
      parts.push(`[${block.name}]`)
    }
  }
  return `${String(message?.role ?? '?')}: ${parts.join(' ') || '(empty)'}`
}

/**
 * The job description handed to one receiver subagent.
 * @param record - who sent what to whom.
 * @param running - whether the target conversation is mid-turn.
 * @returns the prompt text.
 */
function buildReceiverPrompt(record, running) {
  return [
    `You are the peer-talk RECEIVER for the conversation "${record.targetName}" (${record.targetId}) in workspace "${record.targetWorkspace}".`,
    `A message arrived for it while it was ${running ? 'BUSY (running a turn)' : 'idle'}.`,
    `Sender: "${record.senderName}" (${record.senderId}) in workspace "${record.senderWorkspace}".`,
    '--- message ---',
    record.message,
    '--- end of message ---',
    '',
    'Decide what to do, then stop. Your tools:',
    '- `peer_context`: what that conversation is doing right now (recent messages and whether it is running). Read it before deciding to interrupt.',
    '- `peer_reply`: answer the sender directly, as the target conversation. Use it whenever a short answer is enough — the conversation stays undisturbed.',
    '- `peer_handoff`: give the conversation a 2–4 sentence summary (delivery "steer" reaches it at its next step, "queue" waits for its next turn). Use it when it should know but nothing is at risk.',
    '- `peer_interrupt`: cancel the conversation\'s current turn, then deliver a summary. Use it ONLY when the message contradicts or invalidates what it is doing right now, so continuing would waste work or go the wrong way. Never for new ideas, unrelated requests, or anything it could pick up later.',
    '',
    'Never do the task yourself. Keep every message short. When unsure, prefer peer_reply or peer_handoff over interrupting.',
    'Use `peer_reply` rather than `peer_send`: `peer_send` would start another receiver on the far side and the two conversations would bounce subagents at each other.',
    'Your final message is not shown to the conversation: act through the tools, then answer with a single word.',
  ].join('\n')
}

/**
 * Give one receiver subagent its own tools. They are registered on the child's
 * agent context, so no other conversation sees them and disposal removes them.
 * @param agentCtx - the child agent's scoped context.
 * @param record - the message this receiver owns.
 * @param deps - plugin context and settings store.
 */
function registerReceiverTools(agentCtx, record, deps) {
  const { ctx, store } = deps
  const add = definition => {
    try {
      agentCtx.effect(() => agentCtx.tools.register(definition))
    } catch { /* scoped registration is best effort; the prompt already says what to do */ }
  }
  const controller = () => {
    const service = ctx.get('sessionController')
    if (service === undefined) throw new Error('peer-talk receiver: no session service')
    return service
  }

  add({
    name: 'peer_context',
    description: 'Read what the conversation this receiver serves is doing right now: its recent messages and whether it is running a turn. Read this before deciding to interrupt.',
    parameters: {
      type: 'object',
      properties: { tail: { type: 'number', description: 'How many recent messages to include. Default 8, maximum 30.' } },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          running: { type: 'boolean' },
          messages: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'running', 'messages'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Conversation "${value.name}" is ${value.running ? 'running' : 'idle'}. Recent messages:\n${value.messages.join('\n') || '(none)'}`,
      }],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const count = typeof args?.tail === 'number' && args.tail > 0 ? Math.min(30, Math.floor(args.tail)) : 8
      const session = ctx.get('sessions')?.get(record.targetId)
      const live = ctx.get('agents')?.get(record.targetId)
      let messages = []
      if (session !== undefined && typeof session.deriveMessages === 'function') {
        messages = session.deriveMessages().slice(-count).map(messageLine)
      }
      return {
        name: record.targetName,
        running: live?.status === 'running',
        messages,
      }
    },
  })

  add({
    name: 'peer_reply',
    description: 'Answer the sender of the message directly, as the conversation this receiver serves. The main conversation is not disturbed. Use it when a short answer is enough.',
    parameters: {
      type: 'object',
      properties: { body: { type: 'string', description: 'The reply text.' } },
      required: ['body'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { sent: { type: 'boolean' }, to: { type: 'string' } },
        required: ['sent', 'to'],
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: `Replied to ${record.senderName}.` }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const body = typeof args?.body === 'string' ? args.body.trim() : ''
      if (body === '') throw new Error('peer_reply needs a non-empty body')
      const settings = store.get()
      const text = composeMessage(record.targetId, nameFor(settings, record.targetId), record.targetWorkspace, body)
      await controller().prompt({
        requestId: randomUUID(),
        sessionId: record.senderId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, exec.signal)
      record.handled = true
      return { sent: true, to: record.senderId }
    },
  })

  add({
    name: 'peer_handoff',
    description: 'Deliver a short summary of the incoming message to the conversation this receiver serves. "steer" reaches it at its next step (immediate); "queue" waits for its next turn. Use it when the conversation should know but nothing is at risk.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two to four sentences: what the sender wants and why it matters.' },
        delivery: { type: 'string', enum: ['steer', 'queue'], description: 'steer (default) = next step; queue = next turn.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { delivered: { type: 'boolean' }, delivery: { type: 'string', enum: ['steer', 'queue'] } },
        required: ['delivered', 'delivery'],
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: `Summary handed to ${record.targetName}.` }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
      if (summary === '') throw new Error('peer_handoff needs a non-empty summary')
      const delivery = args?.delivery === 'queue' ? 'queue' : 'steer'
      const text = `[peer-handoff] from "${record.senderName}" (${record.senderWorkspace}) — summary for this conversation:\n${summary}`
      await controller().prompt({
        requestId: randomUUID(),
        sessionId: record.targetId,
        mode: delivery,
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, exec.signal)
      record.handled = true
      return { delivered: true, delivery }
    },
  })

  add({
    name: 'peer_interrupt',
    description: 'Cancel the conversation\'s current turn, then deliver a summary of the message. Only when the message contradicts what the conversation is doing right now, so that continuing would waste work or go the wrong way.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'One line: why continuing would be wrong.' },
        summary: { type: 'string', description: 'What the conversation must know before it continues.' },
      },
      required: ['reason', 'summary'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { interrupted: { type: 'boolean' }, delivered: { type: 'boolean' } },
        required: ['interrupted', 'delivered'],
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: `Interrupted ${record.targetName} and handed it the summary.` }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
      const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
      if (summary === '') throw new Error('peer_interrupt needs a non-empty summary')
      if (!record.canInterrupt) {
        throw new Error('peer_interrupt is disabled by the user; use peer_handoff instead')
      }
      const live = ctx.get('agents')?.get(record.targetId)
      let interrupted = false
      if (live !== undefined && live.status === 'running' && typeof live.cancel === 'function') {
        live.cancel({ kind: 'hook', reason: `peer-talk receiver: ${reason || 'the incoming message conflicts with the current work'}` }, { keepInbox: true })
        interrupted = true
      }
      const text = `[peer-interrupt] from "${record.senderName}" (${record.senderWorkspace}) — ${reason === '' ? 'the incoming message conflicts with what you are doing.' : reason}\n\n${summary}`
      await controller().prompt({
        requestId: randomUUID(),
        sessionId: record.targetId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, exec.signal)
      record.handled = true
      return { interrupted, delivered: true }
    },
  })
}

/**
 * Spawn one receiver subagent for a target conversation.
 *
 * Returns null when this deployment cannot host one (no subagent service, no
 * `spawn` provider, the target cannot be resolved, or its receiver budget is
 * full) — the caller then falls back to the plain inbox delivery.
 * @param deps - plugin context, settings store, and receiver accounting.
 * @param input - sender, target, and message.
 * @returns the receiver child id, or null.
 */
async function startReceiver(deps, input) {
  const { ctx, store, receivers, receiversByTarget } = deps
  const subagents = ctx.get('subagents')
  const controller = ctx.get('sessionController')
  if (subagents === undefined || controller === undefined) return null
  if (typeof subagents.startActivation !== 'function' || typeof subagents.list !== 'function') return null
  if (!subagents.list().includes('spawn')) return null

  // A receiver must never parent another receiver: its own reply would bounce
  // back as a new hand-off and the two sides would ping-pong subagents forever.
  if (receivers.has(input.senderId)) return null

  const active = receiversByTarget.get(input.targetId) ?? 0
  if (active >= RECEIVER_CONCURRENCY) return null

  let targetAgent
  try {
    const resolved = await controller.resolveAgent(input.targetId)
    if (resolved === undefined || resolved.agent === undefined) return null
    targetAgent = resolved.agent
  } catch {
    return null
  }

  const running = targetAgent.status === 'running'
  receiversByTarget.set(input.targetId, active + 1)

  const settings = store.get()
  const receiverModel = parseModelSpec(settings.receiver.model)
  let activation
  try {
    activation = await subagents.startActivation({
      provider: 'spawn',
      label: 'peer-talk receiver',
      request: {
        prompt: [{ type: 'text', text: buildReceiverPrompt(input, running) }],
        parent: targetAgent,
        ...input.cwd === undefined ? {} : { cwd: input.cwd },
        // A receiver runs the same preset as its parent; an explicit model keeps
        // a cheap/fast backend available for these short decisions.
        ...receiverModel === null ? {} : {
          agentOptions: {
            ...receiverModel.provider === undefined ? {} : { provider: receiverModel.provider },
            model: receiverModel.model,
          },
        },
      },
      signal: input.signal,
      delivery: 'caller',
    })
  } catch {
    receiversByTarget.set(input.targetId, active)
    return null
  }

  const record = {
    ...input,
    canInterrupt: settings.receiver.canInterrupt !== false,
    childId: activation.childId,
    createdAt: Date.now(),
  }
  receivers.set(activation.childId, record)
  const settle = () => {
    receivers.delete(activation.childId)
    const left = (receiversByTarget.get(input.targetId) ?? 1) - 1
    if (left <= 0) receiversByTarget.delete(input.targetId)
    else receiversByTarget.set(input.targetId, left)
    // The receiver never acted (model error, rate limit, refused): fall back to
    // the plain inbox so the message is delivered after all.
    if (record.handled !== true) {
      const service = ctx.get('sessionController')
      if (service !== undefined) {
        service.prompt({
          requestId: randomUUID(),
          sessionId: input.targetId,
          mode: 'queue',
          content: [{ type: 'text', text: input.fallbackText }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }, AbortSignal.timeout(30_000)).catch(() => {})
      }
    }
  }
  activation.result.then(settle, settle)

  const child = ctx.get('agents')?.get(activation.childId)
  if (child !== undefined && child.ctx !== undefined) {
    registerReceiverTools(child.ctx, record, { ctx, store })
  } else {
    // The child may not be published yet; retry once on the next tick.
    setTimeout(() => {
      const late = ctx.get('agents')?.get(activation.childId)
      if (late !== undefined && late.ctx !== undefined) registerReceiverTools(late.ctx, record, { ctx, store })
    }, 0)
  }
  return { childId: activation.childId }
}

/**
 * Mount the plugin.
 * @param ctx - the host context.
 * @param config - the patch row's configuration; seeds the settings document.
 */
export function apply(ctx, config) {
  const log = ctx.logger ?? console
  const store = new SettingsStore(typeof config === 'object' && config !== null ? config : {})
  const forum = new ForumStore()
  /** Send timestamps per target session, for the per-minute budget. */
  const sentAt = new Map()
  /** Live receiver subagents: child session id → what it is handling. */
  const receivers = new Map()
  /** Receiver count per target session, so one conversation cannot be flooded. */
  const receiversByTarget = new Map()

  /** The caller's workspace node, used to resolve capabilities. */
  const nodeFor = (sessionId, workspaceId) => ({ sessionId, workspaceId })

  /** Reserve one send slot against the per-target budget, or refuse. */
  const reserveSend = targetId => {
    const settings = store.get()
    const now = Date.now()
    const window = (sentAt.get(targetId) ?? []).filter(time => now - time < 60_000)
    if (window.length >= settings.maxSendsPerMinute) {
      throw new Error(`peer-talk: ${window.length} messages already went to that conversation this minute (limit ${settings.maxSendsPerMinute}). Wait, or let the user raise the limit in Settings → Peer talk.`)
    }
    window.push(now)
    sentAt.set(targetId, window)
  }

  registerTool(ctx, log, {
    name: 'peer_list',
    description: 'List the other conversations you can reach: their session ids, titles, whether each is busy, when it was last active, and which workspace it lives in. Pass scope "all" to include conversations in other workspaces (sending to one of those needs the cross-workspace permission). The result also reports this conversation\'s permissions.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['workspace', 'all'],
          description: 'workspace (default) lists this workspace only; all adds every other workspace the user keeps.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          workspace: { type: 'string' },
          workspace_title: { type: 'string' },
          current: { type: 'string' },
          you_name: { type: 'string', description: 'Your own display name as other conversations see it.' },
          permissions: {
            type: 'object',
            properties: {
              send: { type: 'string', enum: ['auto', 'ask', 'off'] },
              create_session: { type: 'string', enum: MODES },
              cross_workspace: { type: 'string', enum: MODES },
              forum_post: { type: 'string', enum: MODES },
            },
            required: ['send', 'create_session', 'cross_workspace', 'forum_post'],
            additionalProperties: false,
          },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                session: { type: 'string' },
                name: { type: 'string' },
                title: { type: 'string' },
                running: { type: 'boolean' },
                minutes_ago: { type: 'number' },
                workspace: { type: 'string' },
                cross: { type: 'boolean' },
              },
              required: ['session', 'name', 'running', 'workspace', 'cross'],
              additionalProperties: false,
            },
          },
        },
        required: ['current', 'you_name', 'permissions', 'sessions'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = [
          `Workspace: ${value.workspace_title ?? value.workspace ?? '(none)'}`,
          `You: ${value.current} (name: ${value.you_name})`,
          `Peers: ${value.sessions.length}`,
        ]
        for (const peer of value.sessions) {
          const state = peer.running ? 'busy' : 'idle'
          const when = peer.minutes_ago === undefined ? '' : ` · ${peer.minutes_ago}m ago`
          const where = peer.cross ? ` @${peer.workspace}` : ''
          lines.push(`- [${state}${when}] ${peer.name}${peer.title === undefined ? '' : ` — "${peer.title}"`} (${peer.session})${where}`)
        }
        const p = value.permissions
        lines.push(`Permissions: send=${p.send} · create=${p.create_session} · cross=${p.cross_workspace} · forum=${p.forum_post}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('peer_list must run inside a session')
      const scope = args?.scope === 'all' ? 'all' : 'workspace'
      const view = await peerView(ctx, exec.agent.id, exec.signal, scope, id => nameFor(store.get(), id))
      const settings = store.get()
      const node = nodeFor(exec.agent.id, view.workspace?.id)
      return {
        ...view.workspace === undefined ? {} : { workspace: view.workspace.path, workspace_title: view.workspace.title },
        current: exec.agent.id,
        you_name: nameFor(settings, exec.agent.id),
        permissions: {
          send: settings.send,
          create_session: capabilityFor(settings, node, 'create'),
          cross_workspace: capabilityFor(settings, node, 'cross'),
          forum_post: capabilityFor(settings, node, 'forum'),
        },
        sessions: view.peers,
      }
    },
  })

  registerTool(ctx, log, {
    name: 'peer_name',
    description: 'Set the codename of THIS CONVERSATION — the handle other agents see in peer lists, forum posts and incoming messages. Any short name you like (a nickname, a word, whatever), as long as it is not the assistant\'s model name and not another conversation\'s. Rename whenever you feel like it; until you choose, a generated codename is used.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '1–24 characters: any name you like. It names this conversation, not the assistant.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          previous: { type: 'string' },
          changed: { type: 'boolean' },
        },
        required: ['name', 'previous', 'changed'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.changed
          ? `You are now "${value.name}" (was "${value.previous}").`
          : `Your name is already "${value.name}".`,
      }],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('peer_name must run inside a session')
      const name = typeof args?.name === 'string' ? args.name.trim().replace(/\s+/g, ' ') : ''
      if (name === '') throw new Error('peer_name needs a non-empty name')
      if (name.length > 24) throw new Error('peer_name: keep the name to 24 characters or fewer')
      const settings = store.get()
      const previous = nameFor(settings, exec.agent.id)
      if (previous === name) return { name, previous, changed: false }
      store.update({ names: { ...settings.names, [exec.agent.id]: name } })
      return { name, previous, changed: true }
    },
  })

  registerTool(ctx, log, {
    name: 'peer_send',
    description: 'Send one message into another conversation, in this workspace or — when your cross-workspace permission allows it — in another one. A busy receiver reads it at its next step; an idle one starts a turn for it. The receiver sees who sent it and may answer with the same tool.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Target session id, exactly as peer_list (scope all included) reports it.' },
        message: { type: 'string', description: 'What to tell the other conversation. Plain text; it arrives as a user message.' },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: 'queue (default) delivers it as the next turn; steer folds it into the receiver\'s current step, which is only useful when that conversation is mid-work.',
        },
      },
      required: ['session', 'message'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          delivered: { type: 'boolean' },
          session: { type: 'string' },
          title: { type: 'string' },
          workspace: { type: 'string' },
          cross: { type: 'boolean' },
          mode: { type: 'string', enum: ['queue', 'steer'] },
          receiver: { type: 'string', description: 'The receiver subagent handling this message, when the handler receive mode is on.' },
        },
        required: ['delivered', 'session', 'mode'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.receiver === undefined
          ? `Delivered to ${value.title === undefined ? value.session : `"${value.title}" (${value.session})`}${value.workspace === undefined ? '' : ` in ${value.workspace}`} as a ${value.mode === 'steer' ? 'steering' : 'queued'} message.`
          : `Handed to a receiver for ${value.title === undefined ? value.session : `"${value.title}" (${value.session})`}; it will answer or forward the message without waiting for that conversation's turn to end.`,
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('peer_send must run inside a session')
      const selfId = exec.agent.id
      const target = typeof args?.session === 'string' ? args.session.trim() : ''
      const message = typeof args?.message === 'string' ? args.message.trim() : ''
      if (target === '') throw new Error('peer_send needs a target session id from peer_list')
      if (target === selfId) throw new Error('peer_send cannot address your own conversation')
      if (message === '') throw new Error('peer_send needs a non-empty message')
      const mode = args?.mode === 'steer' ? 'steer' : 'queue'

      const view = await peerView(ctx, selfId, exec.signal, 'all', id => nameFor(store.get(), id))
      const peer = view.peers.find(candidate => candidate.session === target)
      if (peer === undefined) {
        throw new Error(`peer_send: "${target}" is not a conversation this host can address (check peer_list; sub-agent and blank sessions are not addressable)`)
      }
      const settings = store.get()
      if (message.length > settings.maxMessageChars) {
        throw new Error(`peer_send: the message is ${message.length} characters; the user's limit is ${settings.maxMessageChars}`)
      }
      const node = nodeFor(selfId, view.workspace?.id)
      const policy = sendPolicy(settings, node, peer.cross === true)
      await enforce(ctx, exec, policy,
        `peer_send → ${peer.title === undefined ? target : `"${peer.title}"`}${peer.cross ? ` (workspace "${peer.workspace}")` : ''}`,
        { en: 'Send this message to another conversation?', zh: '允许把这条消息发给另一个会话吗？' })

      const controller = ctx.get('sessionController')
      if (controller === undefined) throw new Error('peer-talk: this deployment has no session service')
      const text = composeMessage(selfId, nameFor(settings, selfId), view.workspace?.title, message)

      reserveSend(target)

      // Receive mode `handler`: a receiver subagent decides how the message is
      // handled, so a busy conversation reacts at once instead of waiting for
      // its next turn. Anything that prevents the spawn falls back to the inbox.
      // A receiver's own messages are always delivered plainly (no chaining).
      if (settings.receiver.mode === 'handler' && !receivers.has(selfId)) {
        const receiver = await startReceiver(
          { ctx, store, receivers, receiversByTarget },
          {
            targetId: target,
            targetName: nameFor(settings, target),
            targetWorkspace: peer.workspace,
            senderId: selfId,
            senderName: nameFor(settings, selfId),
            senderWorkspace: view.workspace?.title ?? '(no workspace)',
            message,
            fallbackText: text,
            signal: exec.signal,
          },
        )
        if (receiver !== null) {
          return {
            delivered: true,
            session: target,
            ...peer.title === undefined ? {} : { title: peer.title },
            ...peer.cross ? { workspace: peer.workspace, cross: true } : {},
            mode,
            receiver: receiver.childId,
          }
        }
      }

      await controller.prompt({
        requestId: randomUUID(),
        sessionId: target,
        mode,
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, exec.signal)
      return {
        delivered: true,
        session: target,
        ...peer.title === undefined ? {} : { title: peer.title },
        ...peer.cross ? { workspace: peer.workspace, cross: true } : {},
        mode,
      }
    },
  })

  registerTool(ctx, log, {
    name: 'peer_create',
    description: 'Start a new conversation in this workspace and hand it an opening message. Only conversations the user granted that right may do this without asking; the grant also carries the right to pick the new conversation\'s model.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The opening task or note for the new conversation. Plain text.' },
        agent_preset: { type: 'string', description: 'Optional agent preset id for the new conversation; the deployment default applies when omitted.' },
        name: { type: 'string', description: 'Optional codename for the new conversation — any short name; it can rename itself with peer_name later.' },
        model: {
          type: 'string',
          description: 'Optional model for the new conversation, as "provider/model" (for example "opencode-go/deepseek-v4.1-flash") or a bare model id when only one provider offers it.',
        },
        reasoning_effort: { type: 'string', description: 'Optional reasoning effort id for that model, when the model has several.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          created: { type: 'boolean' },
          session: { type: 'string' },
          workspace: { type: 'string' },
          delivered: { type: 'boolean' },
          model: { type: 'string' },
        },
        required: ['created', 'session', 'delivered'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Created ${value.session}${value.workspace === undefined ? '' : ` in ${value.workspace}`}${value.model === undefined ? '' : ` on ${value.model}`} and delivered the opening message.`,
      }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('peer_create must run inside a session')
      const selfId = exec.agent.id
      const message = typeof args?.message === 'string' ? args.message.trim() : ''
      if (message === '') throw new Error('peer_create needs a non-empty opening message')
      const settings = store.get()
      if (message.length > settings.maxMessageChars) {
        throw new Error(`peer_create: the message is ${message.length} characters; the user's limit is ${settings.maxMessageChars}`)
      }

      // Resolve the model BEFORE creating anything: an unusable model name must
      // not leave a half-configured conversation behind.
      const requestedEffort = typeof args?.reasoning_effort === 'string' && args.reasoning_effort.trim() !== ''
        ? args.reasoning_effort.trim()
        : undefined
      const requestedModel = parseModelSpec(args?.model)
      const desired = requestedModel !== null
        ? { ...requestedModel, ...requestedEffort === undefined ? {} : { reasoningEffort: requestedEffort } }
        : settings.defaultModel === null
          ? null
          : { ...settings.defaultModel, ...requestedEffort === undefined ? {} : { reasoningEffort: requestedEffort } }
      const selection = desired === null ? null : await resolveModelSelection(ctx, desired)
      const modelLabel = selection === null ? '' : ` on ${selection.provider}/${selection.model}`

      const view = await peerView(ctx, selfId, exec.signal, 'workspace', id => nameFor(store.get(), id))
      const node = nodeFor(selfId, view.workspace?.id)
      await enforce(ctx, exec, capabilityFor(settings, node, 'create'),
        `Create a new session${modelLabel} and deliver: ${message.slice(0, 120)}`,
        { en: 'Start a new conversation in this workspace?', zh: '允许在当前工作区新建一个会话吗？' })

      const chosenName = typeof args?.name === 'string' ? args.name.trim().replace(/\s+/g, ' ').slice(0, 24) : ''
      const controller = ctx.get('sessionController')
      if (controller === undefined) throw new Error('peer-talk: this deployment has no session service')
      const created = await controller.create({
        ...view.workspace === undefined ? {} : { workspaceId: view.workspace.id },
        ...view.workspace !== undefined || view.selfCwd === undefined ? {} : { cwd: view.selfCwd },
        ...typeof args?.agent_preset === 'string' && args.agent_preset !== '' ? { agentPreset: args.agent_preset } : {},
      })
      if (chosenName !== '') {
        const current = store.get()
        store.update({ names: { ...current.names, [created.sessionId]: chosenName } })
      }
      if (selection !== null) {
        // The public selectModel path also saves the choice as the deployment
        // DEFAULT (that is what the composer's model switch does). A conversation
        // spawning another one must not quietly rewrite the user's default, so
        // the previous selection is put back right after.
        const defaults = ctx.get('agentDefaultModel')
        const previous = defaults?.currentSelection?.()
        try {
          await controller.selectModel({ sessionId: created.sessionId, ...selection })
        } catch (error) {
          throw new Error(`peer-talk: ${created.sessionId} was created but the model could not be switched: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (defaults !== undefined && previous !== undefined
          && (previous.provider !== selection.provider || previous.model !== selection.model)) {
          try {
            await defaults.saveSelection(previous)
          } catch { /* the default is a convenience; the session already runs on the chosen model */ }
        }
      }
      const text = composeMessage(selfId, nameFor(settings, selfId), view.workspace?.title, message)
        + (chosenName === '' ? '' : `\n-----\nYour name in peer-talk is "${chosenName}"; \`peer_name\` changes it.`)
      await controller.prompt({
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, exec.signal)
      return {
        created: true,
        session: created.sessionId,
        ...view.workspace === undefined ? {} : { workspace: view.workspace.path },
        delivered: true,
        ...selection === null ? {} : { model: `${selection.provider}/${selection.model}` },
      }
    },
  })

  registerTool(ctx, log, {
    name: 'forum_threads',
    description: 'List forum threads: title, author, workspace, reply count and last activity. The forum is pull-only — reading or posting never wakes another conversation, so check it when it helps and say nothing otherwise.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['workspace', 'all'],
          description: 'workspace (default) lists threads started in this workspace; all lists every thread.',
        },
        limit: { type: 'number', description: 'How many threads to return, newest activity first. Default 20.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          threads: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                thread: { type: 'string' },
                title: { type: 'string' },
                author: { type: 'string' },
                workspace: { type: 'string' },
                posts: { type: 'number' },
                minutes_ago: { type: 'number' },
                excerpt: { type: 'string' },
              },
              required: ['thread', 'title', 'author', 'workspace', 'posts'],
              additionalProperties: false,
            },
          },
          total: { type: 'number' },
        },
        required: ['threads', 'total'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.threads.length === 0) return [{ type: 'text', text: 'The forum has no threads yet.' }]
        const lines = [`Forum threads (${value.threads.length} of ${value.total}):`]
        for (const thread of value.threads) {
          const when = thread.minutes_ago === undefined ? '' : ` · ${thread.minutes_ago}m ago`
          lines.push(`- ${thread.thread} [${thread.posts} post${thread.posts === 1 ? '' : 's'}${when}] "${thread.title}" — ${thread.author} @${thread.workspace}`)
          if (thread.excerpt !== undefined) lines.push(`    ${thread.excerpt}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const scope = args?.scope === 'all' ? 'all' : 'workspace'
      const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(100, Math.floor(args.limit)) : 20
      const view = await peerView(ctx, exec.agent?.id, exec.signal, 'workspace', id => nameFor(store.get(), id))
      const own = view.workspace?.title
      const document = forum.get()
      const now = Date.now()
      const visible = scope === 'all' || own === undefined
        ? document.threads
        : document.threads.filter(thread => thread.workspace === own)
      const rows = visible.slice(0, limit).map(thread => {
        const last = thread.posts[thread.posts.length - 1]
        return {
          thread: thread.id,
          title: thread.title,
          author: authorOf(store.get(), last),
          workspace: thread.workspace,
          posts: thread.posts.length,
          ...age(now, thread.updatedAt) === undefined ? {} : { minutes_ago: age(now, thread.updatedAt) },
          ...last === undefined ? {} : { excerpt: last.body.length > 120 ? `${last.body.slice(0, 120)}…` : last.body },
        }
      })
      return { threads: rows, total: visible.length }
    },
  })

  registerTool(ctx, log, {
    name: 'forum_read',
    description: 'Read one forum thread: its posts in order, newest last. Reading never wakes anyone.',
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread id from forum_threads.' },
        offset: { type: 'number', description: 'Index of the first post to return. Default: the last 20.' },
        limit: { type: 'number', description: 'How many posts to return. Default 20, maximum 50.' },
      },
      required: ['thread'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          thread: { type: 'string' },
          title: { type: 'string' },
          workspace: { type: 'string' },
          total_posts: { type: 'number' },
          omitted_before: { type: 'number' },
          posts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                post: { type: 'string' },
                author: { type: 'string' },
                session: { type: 'string' },
                body: { type: 'string' },
                minutes_ago: { type: 'number' },
              },
              required: ['post', 'author', 'session', 'body'],
              additionalProperties: false,
            },
          },
        },
        required: ['thread', 'title', 'workspace', 'total_posts', 'posts'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = [`Thread "${value.title}" (${value.thread}) · ${value.total_posts} posts · ${value.workspace}`]
        if (value.omitted_before > 0) lines.push(`(${value.omitted_before} earlier posts omitted)` )
        for (const post of value.posts) {
          lines.push('', `— ${post.author} (${post.session})`)
          lines.push(post.body)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const threadId = typeof args?.thread === 'string' ? args.thread.trim() : ''
      const document = forum.get()
      const thread = document.threads.find(candidate => candidate.id === threadId)
      if (thread === undefined) throw new Error(`forum_read: no thread "${threadId}" (check forum_threads)`)
      const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(50, Math.floor(args.limit)) : 20
      const total = thread.posts.length
      const start = typeof args?.offset === 'number' && args.offset >= 0
        ? Math.min(Math.floor(args.offset), total)
        : Math.max(0, total - limit)
      const now = Date.now()
      return {
        thread: thread.id,
        title: thread.title,
        workspace: thread.workspace,
        total_posts: total,
        ...start > 0 ? { omitted_before: start } : {},
        posts: thread.posts.slice(start, start + limit).map(post => ({
          post: post.id,
          author: authorOf(store.get(), post),
          session: post.session,
          body: post.body,
          ...age(now, post.createdAt) === undefined ? {} : { minutes_ago: age(now, post.createdAt) },
        })),
      }
    },
  })

  registerTool(ctx, log, {
    name: 'forum_post',
    description: 'Post to the forum: a reply when `thread` is given, otherwise a new thread. Nothing is broadcast — other conversations find it when they read the forum. Posting is a permission the user grants; a refusal is a decision.',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The post text.' },
        title: { type: 'string', description: 'New thread title. Required when `thread` is omitted; ignored on a reply.' },
        thread: { type: 'string', description: 'Thread id to reply in. Omit to start a thread.' },
      },
      required: ['body'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          posted: { type: 'boolean' },
          thread: { type: 'string' },
          title: { type: 'string' },
          post: { type: 'string' },
          total_posts: { type: 'number' },
        },
        required: ['posted', 'thread', 'title', 'total_posts'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Posted ${value.post === undefined ? '' : `${value.post} `}to thread "${value.title}" (${value.thread}); it now has ${value.total_posts} post${value.total_posts === 1 ? '' : 's'}.`,
      }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('forum_post must run inside a session')
      const body = typeof args?.body === 'string' ? args.body.trim() : ''
      if (body === '') throw new Error('forum_post needs a non-empty body')
      const threadId = typeof args?.thread === 'string' && args.thread.trim() !== '' ? args.thread.trim() : undefined
      const title = typeof args?.title === 'string' ? args.title.trim() : ''
      if (threadId === undefined && title === '') throw new Error('forum_post needs a title when it starts a thread')
      const settings = store.get()
      const view = await peerView(ctx, exec.agent.id, exec.signal, 'workspace', id => nameFor(store.get(), id))
      const node = nodeFor(exec.agent.id, view.workspace?.id)
      await enforce(ctx, exec, capabilityFor(settings, node, 'forum'),
        `forum_post: ${threadId === undefined ? `new thread "${title}"` : `reply in ${threadId}`} (${body.length} chars)`,
        { en: 'Post this to the forum?', zh: '允许把这条内容发到论坛吗？' })

      const selfSession = ctx.get('sessions')?.get(exec.agent.id)
      const author = nameFor(settings, exec.agent.id)
      const thread = forum.post({
        threadId,
        title,
        body,
        session: exec.agent.id,
        author,
        workspace: view.workspace?.title ?? '(no workspace)',
        workspaceId: view.workspace?.id,
      })
      const created = thread.posts[thread.posts.length - 1]
      return {
        posted: true,
        thread: thread.id,
        title: thread.title,
        ...created === undefined ? {} : { post: created.id },
        total_posts: thread.posts.length,
      }
    },
  })

  // Model-facing guidance. Kept short: the tools say what they do, this says when.
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'peer-talk',
      order: 88,
      text: [
        '## Conversations and the forum',
        'Other conversations may run in this workspace, and possibly in others. `peer_list` shows the ones you can reach; `peer_send` delivers one message to one of them, and that agent decides what to do with it.',
        'The forum is a shared board (`forum_threads`, `forum_read`, `forum_post`). It is pull-only: a post wakes nobody, so read it when it helps and post when the answer is worth keeping. Never expect the forum to notify you.',
        'Speak when it changes what the other conversation will do next — not to announce, to confirm, or to keep a thread alive. Incoming messages appear as user turns starting with [peer-message]: answer at most once, and only when the answer carries information.',
        '`peer_name` sets this CONVERSATION\'s codename — any short name you like (a nickname, a word, whatever), as long as it is not the assistant\'s model name and not another conversation\'s name. It is a handle for this session, not your own identity. A generated codename is used until you choose.',
        '`peer_create` starts a new conversation and `forum_post` publishes to the board; both are permissions the user grants per workspace or per conversation, so a refusal is a decision, not an error to work around.',
      ].join('\n'),
    }))
  })

  // The human's own switchboard: `/peer`. The same state the pages edit.
  ctx.inject(['commands'], (scoped) => {
    scoped.effect(() => scoped.commands.register({
      name: 'peer',
      description: '跨会话消息的权限（peer-talk）：查看状态；给当前会话授权/收回 建会话 / 跨工作区 / 论坛发帖。',
      input: { hint: 'status | grant create|cross|forum | revoke create|cross|forum | grants' },
      handler: (invocation) => {
        const [verb = 'status', value = ''] = invocation.rawInput.trim().split(/\s+/)
        const selfId = invocation.agent.id
        const settings = store.get()
        const workspace = (() => {
          const registry = ctx.get('workspaceRegistry')
          return registry === undefined ? undefined : registry.list().find(candidate => candidate.sessionIds.includes(selfId))
        })()
        const node = nodeFor(selfId, workspace?.id)
        if (verb === 'status' || verb === '') {
          const effective = CAPABILITIES.map(capability => `${capability}=${capabilityFor(settings, node, capability)}`)
          return {
            kind: 'success',
            text: [
              'peer-talk 状态',
              `· 本会话名字：${nameFor(settings, selfId)}`,
              `· 本会话权限：${effective.join(' · ')}`,
              `· 自行发起对话（send）：${settings.send}   （auto/ask/off）`,
              `· 新建会话默认模型：${settings.defaultModel === null ? '跟随默认' : `${settings.defaultModel.provider}/${settings.defaultModel.model}`}`,
              `· 授权节点：${Object.keys(settings.grants).length}`,
              `· 论坛：${forum.get().threads.length} 个主题`,
              '用法：/peer grant create|cross|forum · /peer revoke create|cross|forum · /peer grants',
            ].join('\n'),
          }
        }
        if (verb === 'name') {
          const wanted = invocation.rawInput.trim().replace(/^name\s*/i, '').trim().replace(/\s+/g, ' ').slice(0, 24)
          if (wanted === '') return { kind: 'error', text: '用法：/peer name 新名字（1–24 字）' }
          store.update({ names: { ...settings.names, [selfId]: wanted } })
          return { kind: 'success', text: `本会话现在叫「${wanted}」。` }
        }
        if (verb === 'grant' || verb === 'revoke') {
          if (!CAPABILITIES.includes(value)) {
            return { kind: 'error', text: `要指定权限：${CAPABILITIES.join(' / ')}` }
          }
          const key = `session:${selfId}`
          const current = settings.grants[key] ?? {}
          const next = { ...settings.grants }
          const entry = { ...current }
          if (verb === 'grant') entry[value] = 'allow'
          else delete entry[value]
          if (Object.keys(entry).length === 0) delete next[key]
          else next[key] = entry
          store.update({ grants: next })
          return {
            kind: 'success',
            text: verb === 'grant'
              ? `已给本会话授权：${value}=allow（${selfId}）`
              : `已收回本会话的 ${value} 权限（${selfId}）`,
          }
        }
        if (verb === 'grants') {
          const keys = Object.keys(settings.grants)
          if (keys.length === 0) return { kind: 'success', text: '目前没有任何节点被单独授权。' }
          return {
            kind: 'success',
            text: ['单独授权的节点：', ...keys.map(key => `· ${key}: ${Object.entries(settings.grants[key]).map(([capability, mode]) => `${capability}=${mode}`).join(', ')}`)].join('\n'),
          }
        }
        return { kind: 'error', text: '用法：/peer [status | grant create|cross|forum | revoke create|cross|forum | grants]' }
      },
    }))
  })

  // The pages read and write this state through these routes.
  ctx.inject(['webServer'], (host) => {
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/peer-talk/settings',
      handler: (request, response) => handleSettingsRequest(request, response, store),
    }, 'peer-talk: settings'))
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/peer-talk/tree',
      handler: (request, response) => handleTreeRequest(request, response, ctx, store),
    }, 'peer-talk: tree'))
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/peer-talk/models',
      handler: (request, response) => handleModelsRequest(request, response, ctx),
    }, 'peer-talk: models'))
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/peer-talk/forum',
      handler: (request, response) => handleForumRequest(request, response, forum, store),
    }, 'peer-talk: forum'))
  })
}


/**
 * Whether a request may touch the plugin's documents.
 *
 * Not authentication — the documents are readable on disk anyway. The rule keeps
 * a hand-written script from flipping permissions over HTTP: a browser-origin
 * request must share this host, and the desktop shell's renderer (which sends no
 * origin at all) is recognised by the headers only a renderer sends.
 * @param request - the incoming request.
 * @param writing - true for writes, which are held to the stricter rule.
 * @returns whether the request is admitted.
 */
export function admitted(request, writing) {
  const origin = String(request.headers.origin ?? '').trim()
  if (origin === '') {
    if (!writing) return true
    const agent = String(request.headers['user-agent'] ?? '')
    const language = String(request.headers['accept-language'] ?? '')
    return /^Mozilla\/5\.0/.test(agent) && language !== ''
  }
  if (origin === 'null') return false
  try {
    return new URL(origin).host.toLowerCase() === String(request.headers.host ?? '').trim().toLowerCase()
  } catch {
    return false
  }
}

/** One JSON reply. */
function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** Read a request body as text. */
async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * One settings round-trip: GET reads, PUT/POST merges a partial patch.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param store - the settings store.
 */
async function handleSettingsRequest(request, response, store) {
  const method = request.method ?? 'GET'
  try {
    if (!admitted(request, method !== 'GET')) {
      reply(response, 403, { ok: false, error: 'cross-origin request refused' })
      return
    }
    if (method === 'GET') {
      reply(response, 200, { ok: true, settings: store.get(), path: store.path() })
      return
    }
    if (method !== 'PUT' && method !== 'POST') {
      response.writeHead(405, { allow: 'GET, PUT' })
      response.end()
      return
    }
    const raw = (await readBody(request)).trim()
    const patch = raw === '' ? {} : JSON.parse(raw)
    reply(response, 200, { ok: true, settings: store.update(patch), path: store.path() })
  } catch (error) {
    reply(response, 400, { ok: false, error: `invalid settings patch: ${error instanceof Error ? error.message : String(error)}` })
  }
}

/**
 * The permission tree: workspaces, their conversations, and the effective and
 * explicit capability values for each node.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param ctx - the plugin context.
 * @param store - the settings store.
 */
async function handleTreeRequest(request, response, ctx, store) {
  if (!admitted(request, false)) {
    reply(response, 403, { ok: false, error: 'cross-origin request refused' })
    return
  }
  if ((request.method ?? 'GET') !== 'GET') {
    response.writeHead(405, { allow: 'GET' })
    response.end()
    return
  }
  try {
    const controller = ctx.get('sessionController')
    const listed = controller === undefined ? [] : await controller.list({}, AbortSignal.timeout(15_000))
    const summaries = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : []
    const byId = new Map(summaries.map(summary => [summary.sessionId, summary]))
    const registry = ctx.get('workspaceRegistry')
    const workspaces = registry === undefined ? [] : registry.list()
    const settings = store.get()
    const rows = workspaces.map(workspace => {
      const sessions = []
      for (const id of workspace.sessionIds) {
        const summary = byId.get(id)
        if (summary === undefined) continue
        if (summary.origin === 'subagent') continue
        if (summary.blank === true) continue
        const node = { sessionId: id, workspaceId: workspace.id }
        sessions.push({
          id,
          name: nameFor(settings, id),
          title: titleOf(summary) ?? id,
          running: summary.running === true,
          updated_at: summary.updatedAt,
          effective: Object.fromEntries(CAPABILITIES.map(capability => [capability, capabilityFor(settings, node, capability)])),
          explicit: settings.grants[`session:${id}`] ?? {},
        })
      }
      sessions.sort((left, right) => (right.updated_at ?? 0) - (left.updated_at ?? 0))
      const workspaceNode = { sessionId: undefined, workspaceId: workspace.id }
      return {
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        effective: Object.fromEntries(CAPABILITIES.map(capability => [capability, capabilityFor(settings, workspaceNode, capability)])),
        explicit: settings.grants[`workspace:${workspace.id}`] ?? {},
        sessions,
      }
    })
    rows.sort((left, right) => (right.sessions[0]?.updated_at ?? 0) - (left.sessions[0]?.updated_at ?? 0))
    reply(response, 200, {
      ok: true,
      capabilities: CAPABILITIES,
      defaults: settings.defaults,
      grants: settings.grants,
      names: settings.names,
      humanName: settings.humanName,
      workspaces: rows,
    })
  } catch (error) {
    reply(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The routable model catalog, for the page's model picker.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param ctx - the plugin context.
 */
async function handleModelsRequest(request, response, ctx) {
  if (!admitted(request, false)) {
    reply(response, 403, { ok: false, error: 'cross-origin request refused' })
    return
  }
  try {
    const controller = ctx.get('sessionController')
    if (controller === undefined) {
      reply(response, 200, { ok: true, default: null, groups: [], failures: [] })
      return
    }
    const catalog = await controller.modelCatalog()
    reply(response, 200, {
      ok: true,
      default: catalog?.default ?? null,
      groups: (catalog?.groups ?? []).map(group => ({
        id: group.id,
        name: group.name,
        models: (group.models ?? []).map(model => ({
          id: model.id,
          name: model.name,
          ...typeof model.description === 'string' ? { description: model.description } : {},
          ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
        })),
      })),
      failures: (catalog?.failures ?? []).map(failure => ({
        id: failure.id,
        name: failure.name,
        message: failure.message,
      })),
    })
  } catch (error) {
    reply(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The forum document: GET lists threads (or one thread's posts with `?thread=`),
 * POST appends a post as the human.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param forum - the forum store.
 * @param store - the settings store, for the display names.
 */
async function handleForumRequest(request, response, forum, store) {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', 'http://x')
  const settings = store.get()
  const named = post => ({
    ...post,
    author: authorOf(settings, post),
  })
  try {
    if (!admitted(request, method !== 'GET')) {
      reply(response, 403, { ok: false, error: 'cross-origin request refused' })
      return
    }
    const document = forum.get()
    if (method === 'GET') {
      const threadId = url.searchParams.get('thread')
      if (threadId !== null && threadId !== '') {
        const thread = document.threads.find(candidate => candidate.id === threadId)
        if (thread === undefined) {
          reply(response, 404, { ok: false, error: 'no such thread' })
          return
        }
        reply(response, 200, { ok: true, thread: { ...thread, posts: thread.posts.map(named) }, path: forum.path() })
        return
      }
      reply(response, 200, {
        ok: true,
        threads: document.threads.map(thread => ({
          id: thread.id,
          title: thread.title,
          workspace: thread.workspace,
          posts: thread.posts.length,
          updatedAt: thread.updatedAt,
          excerpt: thread.posts[thread.posts.length - 1]?.body?.slice(0, 160) ?? '',
          author: authorOf(settings, thread.posts[thread.posts.length - 1]),
        })),
        path: forum.path(),
      })
      return
    }
    if (method !== 'POST' && method !== 'DELETE') {
      response.writeHead(405, { allow: 'GET, POST, DELETE' })
      response.end()
      return
    }
    if (method === 'DELETE') {
      const threadId = url.searchParams.get('thread')
      if (threadId === null || threadId === '') {
        reply(response, 400, { ok: false, error: 'thread is required' })
        return
      }
      const remaining = document.threads.filter(candidate => candidate.id !== threadId)
      if (remaining.length === document.threads.length) {
        reply(response, 404, { ok: false, error: 'no such thread' })
        return
      }
      forum.save({ threads: remaining })
      reply(response, 200, { ok: true, removed: threadId })
      return
    }
    const body = JSON.parse((await readBody(request)).trim() || '{}')
    const text = typeof body.body === 'string' ? body.body.trim() : ''
    if (text === '') {
      reply(response, 400, { ok: false, error: 'body is required' })
      return
    }
    const threadId = typeof body.thread === 'string' && body.thread.trim() !== '' ? body.thread.trim() : undefined
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (threadId === undefined && title === '') {
      reply(response, 400, { ok: false, error: 'title is required for a new thread' })
      return
    }
    const thread = forum.post({
      threadId,
      title,
      body: text,
      session: 'human',
      author: typeof body.author === 'string' && body.author.trim() !== '' ? body.author.trim() : store.get().humanName,
      workspace: typeof body.workspace === 'string' && body.workspace !== '' ? body.workspace : '(no workspace)',
      workspaceId: undefined,
    })
    reply(response, 200, { ok: true, thread })
  } catch (error) {
    reply(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
