// Local smoke test for the peer-talk host half: settings resolution (including the
// v1 → v2 migration), the capability tree, the forum store, model specs, admission.
// No harness services involved.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SettingsStore,
  ForumStore,
  resolveSettings,
  capabilityFor,
  parseModelSpec,
  deriveName,
  nameFor,
  admitted,
  CAPABILITIES,
  MODES,
} from '../index.js'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.log(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'peer-talk-'))
const file = join(dir, 'settings.json')
const forumFile = join(dir, 'forum.json')

const BASE = {
  send: 'auto',
  defaults: { create: 'ask', cross: 'ask', forum: 'ask' },
  grants: {},
  names: {},
  humanName: '鹿',
  delivery: 'steer',
  defaultModel: null,
  maxSendsPerMinute: 8,
  maxMessageChars: 4000,
}

check('capability vocabulary', CAPABILITIES, ['create', 'cross', 'forum'])
check('mode vocabulary', MODES, ['allow', 'ask', 'deny'])
check('delivery: queue is kept', resolveSettings({ delivery: 'queue' }).delivery, 'queue')
check('delivery: unknown falls back to steer', resolveSettings({ delivery: 'now' }).delivery, 'steer')
check('defaults', resolveSettings({}), BASE)

check('defaults are overridable', resolveSettings({ defaults: { create: 'deny' } }).defaults,
  { create: 'deny', cross: 'ask', forum: 'ask' })
check('unknown default keeps fallback', resolveSettings({ defaults: { cross: 'maybe' } }).defaults.cross, 'ask')

check('grants are sanitized', resolveSettings({
  grants: {
    'session:abc': { create: 'allow', bogus: 'x' },
    'session:': { create: 'allow' },
    'team:abc': { create: 'allow' },
    'workspace:ws-1': { cross: 'deny', forum: 'ask' },
    'session:def': 'nope',
  },
}).grants, {
  'session:abc': { create: 'allow' },
  'workspace:ws-1': { cross: 'deny', forum: 'ask' },
})

check('v1 allowedSessions migrates to a create grant', resolveSettings({ allowedSessions: ['session-a'] }).grants,
  { 'session:session-a': { create: 'allow' } })
check('v1 createSession becomes the create default', resolveSettings({ createSession: 'deny' }).defaults.create, 'deny')
check('v2 defaults win over v1 keys', resolveSettings({ createSession: 'deny', defaults: { create: 'ask' } }).defaults.create, 'ask')

const settings = resolveSettings({
  grants: {
    'workspace:ws-1': { create: 'allow', cross: 'deny' },
    'session:s-2': { create: 'deny' },
  },
})
check('session grant beats workspace grant', capabilityFor(settings, { sessionId: 's-2', workspaceId: 'ws-1' }, 'create'), 'deny')
check('workspace grant beats default', capabilityFor(settings, { sessionId: 's-3', workspaceId: 'ws-1' }, 'create'), 'allow')
check('default applies with no grant', capabilityFor(settings, { sessionId: 's-3', workspaceId: 'ws-2' }, 'create'), 'ask')
check('capabilities are independent', capabilityFor(settings, { sessionId: 's-3', workspaceId: 'ws-1' }, 'cross'), 'deny')

check('explicit model spec', parseModelSpec('opencode-go/deepseek-v4.1-flash'), { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
check('bare model spec', parseModelSpec('gemini-3.8-flash'), { model: 'gemini-3.8-flash', provider: undefined })
check('empty spec is null', parseModelSpec('   '), null)

check('names are stable per session', deriveName('session-abc'), deriveName('session-abc'))
check('different sessions get different names', deriveName('session-abc') === deriveName('session-xyz'), false)
check('name shape', /^[\u4e00-\u9fa5]{2}-\d{2}$/.test(deriveName('session-4f600ea4-787b-4d8c-b42a-c809bbdecf62')), true)
check('name override wins', nameFor({ names: { 'session-abc': '大肥鱼' } }, 'session-abc'), '大肥鱼')
check('name override falls back', nameFor({ names: {} }, 'session-abc'), deriveName('session-abc'))
check('names are sanitized', resolveSettings({ names: { 'session-ok': '  小鹿  ', 'session-bad': '', nope: 'x', 'session-x': 42 } }).names,
  { 'session-ok': '小鹿' })
check('humanName default', resolveSettings({}).humanName, '鹿')
check('humanName sanitized', resolveSettings({ humanName: '   ' }).humanName, '鹿')
check('humanName override', resolveSettings({ humanName: ' 鹿鹿 ' }).humanName, '鹿鹿')

const store = new SettingsStore({ defaults: { create: 'deny' } }, file)
check('no file uses seed', store.get().defaults.create, 'deny')
const updated = store.update({ grants: { 'session:s-1': { forum: 'allow' } } })
check('update persisted grants', updated.grants, { 'session:s-1': { forum: 'allow' } })
check('file on disk', JSON.parse(readFileSync(file, 'utf8')).grants, { 'session:s-1': { forum: 'allow' } })

writeFileSync(file, '{ not json')
store.cachedMtimeMs = -1
check('corrupt document refuses everything', [
  store.get().send,
  store.get().defaults.create,
  store.get().defaults.cross,
  store.get().defaults.forum,
], ['off', 'deny', 'deny', 'deny'])

const forum = new ForumStore(forumFile)
check('empty forum', forum.get().threads, [])
const thread = forum.post({ title: 'Hello', body: 'first post', session: 'session-a', author: 'A', workspace: 'W1', workspaceId: 'ws-1' })
check('thread created', [thread.title, thread.posts.length, thread.workspace], ['Hello', 1, 'W1'])
const replied = forum.post({ threadId: thread.id, title: '', body: 'second post', session: 'session-b', author: 'B', workspace: 'W2' })
check('reply appended', replied.posts.length, 2)
check('reply authored', replied.posts[1].author, 'B')
check('forum persisted', JSON.parse(readFileSync(forumFile, 'utf8')).threads[0].posts.length, 2)

let missing = null
try { forum.post({ threadId: 'nope', body: 'x', session: 's', author: 'a', workspace: 'w' }) } catch (error) { missing = String(error.message) }
check('unknown thread refused', missing !== null && missing.includes('no forum thread'), true)

check('GET without headers admitted', admitted({ headers: {} }, false), true)
check('write without headers refused', admitted({ headers: {} }, true), false)
check('renderer write admitted', admitted({ headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)', 'accept-language': 'zh-CN' } }, true), true)
check('foreign-origin write refused', admitted({ headers: { origin: 'https://evil.example', host: '127.0.0.1:57077' } }, true), false)

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
