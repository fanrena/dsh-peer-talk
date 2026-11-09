/**
 * Peer talk — the client half: a settings section, and the session's own
 * "Peer talk" view (forum + permission tree).
 *
 * The host owns every document (`/peer-talk/*`); this module only renders and
 * patches them. The layout copies the harness' own conversation page: a header
 * with the view tabs, a constrained content column, cards on the raised surface,
 * 13px body text and theme tokens only — so it sits beside Chat and Trajectory
 * without looking bolted on.
 *
 * Plain ModuleLoader bundle: no build step, matching how the harness loads
 * plugin client halves.
 */
window.__ModuleLoader__.load({ id: "dsh-peer-talk", factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

  const react = require("react")
  const h = react.createElement
  const { useCallback, useEffect, useMemo, useRef, useState } = react

  const name = "dsh-peer-talk"
  const inject = ["slots", "locale"]
  const NS = "settings.dsh-peer-talk"
  const SETTINGS_ROUTE = "/peer-talk/settings"
  const TREE_ROUTE = "/peer-talk/tree"
  const MODELS_ROUTE = "/peer-talk/models"
  const FORUM_ROUTE = "/peer-talk/forum"
  const CAPABILITIES = ["create", "cross", "forum"]
  let translate = (key) => key

  const zh = {
    nav: "跨会话消息",
    "view.nav": "Peer talk",
    loading: "读取中…",
    failed: "读取失败：",
    saved: "已保存",
    path: "设置文件",
    retry: "重试",

    "send.label": "允许 AI 自行发起对话",
    "send.hint": "auto：自行判断，必要时直接给其它会话发消息；ask：每次发送都先问你；off：一律不许。",
    "send.auto": "允许",
    "send.ask": "每次询问",
    "send.off": "禁止",
    "delivery.label": "收到消息时",
    "delivery.hint": "即时：插到对话的下一个 step，正在跑的会话当场就能看到；排队：等它这一轮结束（长回合会等很久）。",
    "delivery.steer": "即时（下一步）",
    "delivery.queue": "排队（下一轮）",
    "settings.lead": "按工作区和会话细分的权限（新建会话 / 跨工作区 / 论坛发帖），在会话页的 Peer talk 标签里改。",

    "model.title": "新建会话的默认模型",
    "model.hint": "有权限的会话可以调用时覆盖它；这里定的是不指定时的选择。",
    "model.follow": "跟随默认",
    "model.none": "未指定（用 DSH 默认模型）",
    "model.choose": "选择模型",
    "model.failed": "模型列表读取失败：",

    "page.sub": "私聊 · 论坛 · 权限",
    "tab.forum": "论坛",
    "tab.perms": "权限",

    "cap.create": "新建会话",
    "cap.cross": "跨工作区",
    "cap.forum": "论坛发帖",
    "cap.allow": "允许",
    "cap.ask": "询问",
    "cap.deny": "拒绝",
    "cap.inherit": "继承",
    "perms.lead": "点格子循环切换：继承 → 允许 → 询问 → 拒绝。会话压过工作区，工作区压过默认。",
    "perms.defaults": "默认",
    "perms.defaults.hint": "没有单独授权时",
    "perms.reset": "清除本行设置",
    "perms.current": "当前会话",
    "perms.empty": "还没有任何工作区。",
    "perms.node": "节点",
    "perms.sessions": "个会话",

    "forum.lead": "发帖不会叫醒任何会话，谁需要谁自己来读。",
    "forum.new": "新帖",
    "forum.empty": "还没有帖子",
    "forum.empty.hint": "写点什么，让别的会话自己来读。",
    "forum.posts": "楼",
    "forum.threads": "个话题",
    "forum.no.selection": "选一个话题，或者开一个新帖。",
    "forum.title": "标题",
    "forum.title.placeholder": "这个帖子讲什么",
    "forum.body": "内容",
    "forum.body.placeholder": "写点什么…",
    "forum.publish": "发布",
    "forum.reply.placeholder": "回复这个话题…",
    "forum.back": "全部话题",
    "forum.delete": "删除话题",
    "forum.delete.confirm": "删除这个话题及其全部回复？",
    "forum.cancel": "取消",
    "forum.sending": "发送中…",
    "forum.anonymous": "匿名会话",
    "time.now": "刚刚",
    "name.rename": "点一下改名",
    "human.label": "论坛里你的名字",
    "human.hint": "你在论坛发帖时署的名字，别人看到的就是它。",
    "time.min": "分钟前",
    "time.hour": "小时前",
    "time.day": "天前",
  }

  const en = {
    nav: "Peer talk",
    "view.nav": "Peer talk",
    loading: "Loading…",
    failed: "Could not load: ",
    saved: "Saved",
    path: "Settings file",
    retry: "Retry",

    "send.label": "Let an agent start a conversation by itself",
    "send.hint": "auto: decide and send when it matters; ask: ask on every send; off: never.",
    "send.auto": "Allowed",
    "send.ask": "Ask each time",
    "send.off": "Blocked",
    "delivery.label": "When a message arrives",
    "delivery.hint": "Immediate: drops into the conversation at its next step, so a busy agent sees it right away. Queued: waits for its next turn, which is slow during long turns.",
    "delivery.steer": "Immediate (next step)",
    "delivery.queue": "Queued (next turn)",
    "settings.lead": "The per-workspace and per-conversation permissions (create session / cross-workspace / forum posting) live in the Peer talk tab of a conversation.",

    "model.title": "Model for new conversations",
    "model.hint": "A permitted conversation may override this per call; this is the choice used when it does not.",
    "model.follow": "Follow the default",
    "model.none": "Not set (use the DSH default model)",
    "model.choose": "Choose a model",
    "model.failed": "Could not read the model list: ",

    "page.sub": "Messages · forum · permissions",
    "tab.forum": "Forum",
    "tab.perms": "Permissions",

    "cap.create": "Create session",
    "cap.cross": "Cross-workspace",
    "cap.forum": "Post to forum",
    "cap.allow": "Allowed",
    "cap.ask": "Ask",
    "cap.deny": "Blocked",
    "cap.inherit": "Inherit",
    "perms.lead": "Click a cell to cycle: inherit → allowed → ask → blocked. A conversation overrides its workspace, and a workspace overrides the default.",
    "perms.defaults": "Default",
    "perms.defaults.hint": "when nothing else is granted",
    "perms.reset": "Clear this row",
    "perms.current": "This conversation",
    "perms.empty": "No workspace yet.",
    "perms.node": "Node",
    "perms.sessions": "conversations",

    "forum.lead": "A post wakes nobody; whoever needs it comes and reads.",
    "forum.new": "New thread",
    "forum.empty": "No threads yet",
    "forum.empty.hint": "Write something and let the other conversations find it.",
    "forum.posts": "posts",
    "forum.threads": "threads",
    "forum.no.selection": "Pick a thread, or start a new one.",
    "forum.title": "Title",
    "forum.title.placeholder": "What is this thread about",
    "forum.body": "Post",
    "forum.body.placeholder": "Write something…",
    "forum.publish": "Publish",
    "forum.reply.placeholder": "Reply to this thread…",
    "forum.back": "All threads",
    "forum.delete": "Delete thread",
    "forum.delete.confirm": "Delete this thread and all its replies?",
    "forum.cancel": "Cancel",
    "forum.sending": "Sending…",
    "forum.anonymous": "Unnamed conversation",
    "time.now": "just now",
    "name.rename": "Click to rename",
    "human.label": "Your name on the forum",
    "human.hint": "The name your forum posts are signed with.",
    "time.min": "min ago",
    "time.hour": "h ago",
    "time.day": "d ago",
  }

  /** One JSON round-trip with the host. */
  async function call(route, payload, method) {
    const response = await fetch(route, payload === undefined
      ? { method: method || "GET", headers: { accept: "application/json" } }
      : {
        method: method || "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    const data = await response.json().catch(() => undefined)
    if (data === undefined || data.ok !== true) {
      throw new Error((data && data.error) || `HTTP ${response.status}`)
    }
    return data
  }

  /** "3 分钟前" — relative ages read faster than timestamps in a list. */
  function ageLabel(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return ""
    const minutes = Math.max(0, Math.round((Date.now() - value) / 60000))
    const t = translate
    if (minutes < 1) return t("time.now")
    if (minutes < 60) return `${minutes} ${t("time.min")}`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} ${t("time.hour")}`
    return `${Math.round(hours / 24)} ${t("time.day")}`
  }

  /** A stable tint per author, so the same conversation keeps its colour. */
  function avatarTint(seed) {
    const text = String(seed ?? "")
    let hash = 0
    for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0
    return `var(--dsw-alias-avatar-${hash % 5}, var(--dsw-alias-bg-layer-2, #eef1f6))`
  }

  const CSS = `
/* Peer talk — visual spec aligned to the harness design system.
   Sizes and colours follow the native ladder: body 13/20, hints 12/18,
   tags 11/17, buttons 12/18 (28px), view tabs 14/20 (34px), and only
   --dsw-alias-* colour tokens so light/dark both work. */

.pt-page {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  line-height: 20px;
}

/* ---------- header + view tabs (same strip as Chat / Trajectory) ---------- */
.pt-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 32px 0;
  flex: none;
}
.pt-title-row { display: flex; align-items: baseline; gap: 8px; }
.pt-title { font-size: 15px; line-height: 24px; font-weight: 600; }
.pt-sub { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8b919b); }
.pt-tabs { display: flex; gap: 24px; margin-top: 2px; }
.pt-tab {
  position: relative;
  height: 34px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-secondary, #5b616b);
  font: inherit;
  font-size: 14px;
  line-height: 20px;
  cursor: pointer;
  transition: color .18s ease;
}
.pt-tab:hover { color: var(--dsw-alias-label-primary, inherit); }
.pt-tab[data-on="true"] { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
.pt-tab[data-on="true"]::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  border-radius: 1px;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
}
.pt-divider { height: 1px; flex: none; background: var(--dsw-alias-border-l1, #e9ebef); }
.pt-body { flex: 1; min-height: 0; display: flex; overflow: hidden; }

/* ---------- forum ---------- */
.pt-forum { display: flex; flex: 1; min-height: 0; }
.pt-list-pane {
  display: flex;
  flex-direction: column;
  width: 300px;
  flex: none;
  min-height: 0;
  border-right: 1px solid var(--dsw-alias-border-l1, #e9ebef);
  background: var(--dsw-alias-bg-layer-1, #fafbfc);
}
.pt-list-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 12px 14px 8px;
}
.pt-list-title {
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #5b616b);
}
.pt-list-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 8px 12px; }

.pt-thread {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  margin-bottom: 2px;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease;
}
.pt-thread:hover { background: var(--dsw-alias-interactive-bg-hover, #eef0f3); }
.pt-thread[data-on="true"] {
  background: var(--dsw-alias-bg-base, #fff);
  border-color: var(--dsw-alias-border-l2, #e2e5ea);
}
.pt-thread-title {
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pt-thread-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary, #8b919b);
}
.pt-dot { width: 2px; height: 2px; border-radius: 50%; background: currentColor; opacity: .7; }
.pt-thread-excerpt {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #8b919b);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.pt-detail { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.pt-detail-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex: none;
  padding: 16px 28px 10px;
}
.pt-detail-title { font-size: 15px; line-height: 24px; font-weight: 600; }
.pt-detail-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 1px;
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary, #8b919b);
}
.pt-detail-actions { display: flex; gap: 6px; margin-left: auto; flex: none; }

.pt-posts { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 28px 6px; }
.pt-post { display: flex; gap: 10px; padding: 12px 0; }
.pt-post + .pt-post { border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.pt-avatar {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-2, #eef0f3);
  color: var(--dsw-alias-label-secondary, #5b616b);
  font-size: 11px;
  line-height: 17px;
  font-weight: 600;
}
.pt-post-body { flex: 1; min-width: 0; }
.pt-post-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 2px; }
.pt-post-author { font-size: 13px; line-height: 20px; font-weight: 600; }
.pt-post-time { font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary, #8b919b); }
.pt-post-text { font-size: 13px; line-height: 21px; white-space: pre-wrap; word-break: break-word; }

/* ---------- composer (mirrors the chat composer shell) ---------- */
.pt-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: none;
  margin: 0 28px 16px;
  padding: 8px 10px 8px;
  border: .5px solid var(--dsw-alias-border-l4, #e3e6ec);
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 1px 2px rgba(16, 24, 40, .04);
  transition: border-color .12s ease, box-shadow .12s ease;
}
.pt-composer:focus-within {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 10%, transparent);
}
.pt-composer textarea,
.pt-composer input {
  width: 100%;
  box-sizing: border-box;
  border: 0;
  outline: none;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 21px;
}
.pt-composer textarea { resize: none; min-height: 42px; max-height: 168px; }
.pt-composer input { padding-bottom: 6px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.pt-composer input::placeholder,
.pt-composer textarea::placeholder { color: var(--dsw-alias-label-caption, #a1a7b0); }
.pt-composer-foot { display: flex; align-items: center; gap: 8px; }
.pt-hint { font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary, #8b919b); }

/* ---------- buttons (native small button) ---------- */
.pt-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-2, #eef0f3);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.pt-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #e6e9ee); }
.pt-btn:disabled { opacity: .45; cursor: default; }
.pt-btn[data-primary="true"] { background: var(--dsw-alias-brand-primary, #4d6bfe); color: #fff; font-weight: 500; }
.pt-btn[data-primary="true"]:hover:not(:disabled) { background: var(--dsw-alias-brand-primary, #4d6bfe); filter: brightness(1.06); }
.pt-btn[data-ghost="true"] { background: none; color: var(--dsw-alias-label-tertiary, #8b919b); }
.pt-btn[data-ghost="true"]:hover:not(:disabled) {
  color: var(--dsw-alias-state-error-primary, #d64545);
  background: var(--dsw-alias-interactive-bg-hover, #eef0f3);
}

/* ---------- empty states ---------- */
.pt-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 40px 24px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, #8b919b);
}
.pt-empty-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-2, #eef0f3);
  color: var(--dsw-alias-label-tertiary, #8b919b);
  font-size: 18px;
}
.pt-empty-title { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary, #5b616b); }
.pt-empty-hint { font-size: 12px; line-height: 18px; }

.pt-error {
  margin: 0 28px 10px;
  padding: 6px 10px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 9%, transparent);
  color: var(--dsw-alias-state-error-primary, #d64545);
  font-size: 12px;
  line-height: 18px;
}

/* ---------- permissions ---------- */
.pt-perms { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.pt-perms-head {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  flex: none;
  padding: 14px 32px 10px;
}
.pt-perms-lead {
  flex: 1;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #8b919b);
}
.pt-legend { display: flex; gap: 12px; flex: none; }
.pt-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary, #8b919b);
}
.pt-swatch { width: 6px; height: 6px; border-radius: 50%; }
.pt-table-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 0 24px 20px; }
.pt-table { width: 100%; border-collapse: separate; border-spacing: 0; }
.pt-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 7px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e9ebef);
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-tertiary, #8b919b);
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  text-align: center;
  white-space: nowrap;
}
.pt-table thead th:first-child { padding-left: 14px; text-align: left; }
.pt-table td { padding: 2px 10px; vertical-align: middle; }
.pt-table tbody tr[data-kind="workspace"] td { padding-top: 8px; }
.pt-table tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover, rgba(120, 130, 150, .04)); }
.pt-node { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 4px 6px 10px; border-radius: var(--dsw-radius-sm, 6px); }
.pt-node[data-indent="true"] { padding-left: 34px; }
.pt-node-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 20px; }
.pt-node-sub { flex: none; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary, #8b919b); }
.pt-node-name { font-weight: 600; cursor: text; border-bottom: 1px dashed transparent; }
.pt-node-name:hover { border-bottom-color: var(--dsw-alias-border-l2, #e2e5ea); }
.pt-node-dim {
  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8b919b);
}
.pt-rename {
  width: 140px; height: 24px; padding: 0 6px;
  border: .5px solid var(--dsw-alias-brand-primary, #4d6bfe); border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-base, #fff); color: inherit; font: inherit; font-size: 13px; outline: none;
}
.pt-input {
  width: 180px; height: 28px; padding: 0 8px;
  border: .5px solid var(--dsw-alias-border-l4, #e3e6ec); border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font: inherit; font-size: 12px; outline: none;
}
.pt-input:focus { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.pt-state { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #c6cbd3); }
.pt-state[data-running="true"] {
  background: var(--dsw-alias-state-success-primary, #2fa36b);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary, #2fa36b) 16%, transparent);
}
.pt-chip {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, #eef0f3);
  color: var(--dsw-alias-label-tertiary, #8b919b);
  font-size: 11px;
  line-height: 15px;
}
.pt-chip[data-current="true"] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 10%, transparent);
  color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.pt-cell { text-align: center; }
.pt-cap {
  min-width: 72px;
  height: 24px;
  padding: 0 10px;
  border: .5px solid var(--dsw-alias-border-l4, #e3e6ec);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8b919b);
  font: inherit;
  font-size: 11px;
  line-height: 22px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease, color .12s ease;
}
.pt-cap:hover:not(:disabled) { border-color: var(--dsw-alias-label-tertiary, #8b919b); }
.pt-cap[data-explicit="false"] { border-style: dashed; opacity: .75; }
.pt-cap[data-explicit="true"][data-mode="allow"] {
  border-color: transparent;
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2fa36b) 11%, transparent);
  color: var(--dsw-alias-state-success-primary, #2fa36b);
}
.pt-cap[data-explicit="true"][data-mode="ask"] {
  border-color: transparent;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b7791f) 13%, transparent);
  color: var(--dsw-alias-state-warn-primary, #b7791f);
}
.pt-cap[data-explicit="true"][data-mode="deny"] {
  border-color: transparent;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 9%, transparent);
  color: var(--dsw-alias-state-error-primary, #d64545);
}
.pt-reset {
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: none;
  color: var(--dsw-alias-label-tertiary, #8b919b);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.pt-reset:hover {
  background: var(--dsw-alias-interactive-bg-hover, #eef0f3);
  color: var(--dsw-alias-label-primary, inherit);
}

/* ---------- settings section (native settings rows) ---------- */
.pt-settings { display: flex; flex-direction: column; padding: 2px 0 8px; font-size: 13px; line-height: 20px; }
.pt-section-title { margin: 20px 0 2px; font-size: 13px; line-height: 20px; font-weight: 600; }
.pt-section-lead { margin: 0 0 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8b919b); }
.pt-row { display: flex; align-items: flex-start; gap: 16px; padding: 10px 0; }
.pt-row + .pt-row { border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.pt-row-body { flex: 1; min-width: 0; }
.pt-row-title { font-size: 13px; line-height: 20px; }
.pt-row-hint { margin-top: 1px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8b919b); }
.pt-row-control { flex: none; padding-top: 1px; }
.pt-seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover, #eef0f3);
}
.pt-seg button {
  height: 26px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5b616b);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.pt-seg button:hover:not(:disabled) { color: var(--dsw-alias-label-primary, inherit); }
.pt-seg button[data-on="true"] {
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, inherit);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .08);
}
.pt-seg button:disabled { opacity: .5; cursor: default; }

/* ---------- model picker (same shell as the composer's model select) ---------- */
.pt-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 200px;
  max-width: 320px;
  height: 28px;
  padding: 0 8px;
  border: .5px solid var(--dsw-alias-border-l4, #e3e6ec);
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-secondary, #5b616b);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.pt-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #eef0f3); }
.pt-trigger:disabled { color: var(--dsw-alias-label-dimmed, #b3b8c2); cursor: default; }
.pt-trigger-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pt-chevron { margin-left: auto; font-size: 9px; opacity: .55; }
.pt-menu {
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  width: max-content;
  min-width: min(280px, 100vw - 32px);
  max-width: min(440px, 100vw - 32px);
  max-height: min(360px, 100vh - 96px);
  padding: 4px;
  overflow: hidden;
  border: .5px solid var(--dsw-alias-border-l3, #e6e9ee);
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-overlay, #fff);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(16, 24, 40, .16));
  color: var(--dsw-alias-label-primary, inherit);
}
.pt-menu-scroll { overflow-y: auto; min-height: 0; }
.pt-menu-group {
  padding: 6px 8px 2px;
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary, #8b919b);
}
.pt-option {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 32px;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.pt-option:hover,
.pt-option:focus-visible { background: var(--dsw-alias-interactive-bg-hover, #eef0f3); outline: none; }
.pt-option-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pt-option-check { flex: 0 0 14px; margin-left: auto; color: var(--dsw-alias-brand-primary, #4d6bfe); font-size: 12px; }
.pt-search { display: flex; padding: 2px 2px 4px; }
.pt-search input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: .5px solid var(--dsw-alias-border-l4, #e3e6ec);
  border-radius: var(--dsw-radius-sm, 6px);
  outline: none;
  background: var(--dsw-alias-bg-base, #fff);
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
}
@media (max-width: 980px) {
  .pt-list-pane { width: 240px; }
  .pt-head, .pt-perms-head { padding-left: 20px; padding-right: 20px; }
  .pt-detail-head, .pt-posts { padding-left: 18px; padding-right: 18px; }
  .pt-composer { margin-left: 18px; margin-right: 18px; }
  .pt-table-scroll { padding-left: 12px; padding-right: 12px; }
}

.pt-foot { margin-top: 16px; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-caption, #a1a7b0); word-break: break-all; }

`

  /** Install the module's stylesheet once. */
  function installStyles() {
    if (typeof document === "undefined") return
    if (document.getElementById("dsh-peer-talk-style") !== null) return
    const element = document.createElement("style")
    element.id = "dsh-peer-talk-style"
    element.textContent = CSS
    document.head.appendChild(element)
  }

  /** A segmented control, styled like the host's own switches. */
  function Segmented(props) {
    return h("div", { className: "pt-seg", role: "radiogroup", "aria-label": props.label },
      props.options.map(option => h("button", {
        key: option.value,
        type: "button",
        role: "radio",
        "aria-checked": option.value === props.value ? "true" : "false",
        "data-on": option.value === props.value ? "true" : "false",
        disabled: props.busy,
        onClick: () => { if (option.value !== props.value) props.onChange(option.value) },
      }, option.label)))
  }

  /** Initials for an author, or a dot for an unnamed one. */
  function Avatar(props) {
    const text = typeof props.name === "string" ? props.name.trim() : ""
    const initial = text === "" ? "·" : [...text][0].toUpperCase()
    return h("div", {
      className: "pt-avatar",
      style: { background: avatarTint(props.name) },
      "aria-hidden": "true",
    }, initial)
  }

  /**
   * The model picker: a trigger plus a fixed-position menu, mirroring the
   * composer's model select (measured placement, Escape and outside-press close).
   */
  function ModelPicker(props) {
    const t = translate
    const [open, setOpen] = useState(false)
    const [place, setPlace] = useState({ top: 0, left: 0 })
    const [query, setQuery] = useState("")
    const triggerRef = useRef(null)
    const menuRef = useRef(null)

    const toggle = useCallback(() => {
      const trigger = triggerRef.current
      if (trigger === null) return
      const rect = trigger.getBoundingClientRect()
      setPlace({ top: Math.round(rect.bottom + 6), left: Math.round(rect.left) })
      setQuery("")
      setOpen(value => !value)
    }, [])

    useEffect(() => {
      if (!open) return undefined
      const onPointerDown = event => {
        const menu = menuRef.current
        const trigger = triggerRef.current
        if (menu !== null && menu.contains(event.target)) return
        if (trigger !== null && trigger.contains(event.target)) return
        setOpen(false)
      }
      const onKeyDown = event => { if (event.key === "Escape") setOpen(false) }
      document.addEventListener("pointerdown", onPointerDown, true)
      document.addEventListener("keydown", onKeyDown, true)
      return () => {
        document.removeEventListener("pointerdown", onPointerDown, true)
        document.removeEventListener("keydown", onKeyDown, true)
      }
    }, [open])

    const current = props.value
    const label = current === null || current === undefined
      ? t("model.follow")
      : `${current.provider} / ${current.model}`

    const filtered = useMemo(() => {
      const needle = query.trim().toLowerCase()
      if (needle === "") return props.groups
      return props.groups
        .map(group => ({
          ...group,
          models: group.models.filter(model => `${group.name} ${model.name} ${model.id}`.toLowerCase().includes(needle)),
        }))
        .filter(group => group.models.length > 0)
    }, [props.groups, query])

    const pick = value => {
      setOpen(false)
      props.onChange(value)
    }

    return h("div", { style: { position: "relative", minWidth: 0 } }, [
      h("button", {
        key: "t",
        ref: triggerRef,
        type: "button",
        className: "pt-trigger",
        "aria-haspopup": "menu",
        "aria-expanded": open ? "true" : "false",
        disabled: props.busy || props.groups.length === 0,
        onClick: toggle,
      }, [
        h("span", { key: "l", className: "pt-trigger-label", title: label }, label),
        h("span", { key: "c", className: "pt-chevron", "aria-hidden": "true" }, open ? "\u25b4" : "\u25be"),
      ]),
      open ? h("div", {
        key: "m",
        ref: menuRef,
        className: "pt-menu",
        role: "menu",
        "aria-label": t("model.choose"),
        style: { top: `${place.top}px`, left: `${place.left}px` },
      }, [
        h("div", { key: "s", className: "pt-menu-scroll" }, [
          h("div", { key: "search", className: "pt-search" }, h("input", {
            type: "search",
            value: query,
            placeholder: t("model.choose"),
            "aria-label": t("model.choose"),
            autoFocus: true,
            onChange: event => setQuery(event.target.value),
          })),
          h("button", {
            key: "follow",
            type: "button",
            role: "menuitemradio",
            className: "pt-option",
            "aria-checked": current === null || current === undefined ? "true" : "false",
            onClick: () => pick(null),
          }, [
            h("span", { key: "l", className: "pt-option-label" }, t("model.none")),
            current === null || current === undefined ? h("span", { key: "c", className: "pt-option-check" }, "\u2713") : null,
          ]),
          ...filtered.flatMap(group => [
            h("div", { key: `g:${group.id}`, className: "pt-menu-group" }, group.name),
            ...group.models.map(model => {
              const selected = current !== null && current !== undefined && current.provider === group.id && current.model === model.id
              return h("button", {
                key: `${group.id}/${model.id}`,
                type: "button",
                role: "menuitemradio",
                className: "pt-option",
                "aria-checked": selected ? "true" : "false",
                title: typeof model.description === "string" ? model.description : model.id,
                onClick: () => pick({ provider: group.id, model: model.id }),
              }, [
                h("span", { key: "l", className: "pt-option-label" }, model.name),
                selected ? h("span", { key: "c", className: "pt-option-check" }, "\u2713") : null,
              ])
            }),
          ]),
        ]),
      ]) : null,
    ])
  }

  /** The settings-page section: the two decisions that belong to nobody in particular. */
  function SettingsSection() {
    const t = translate
    const [settings, setSettings] = useState(null)
    const [models, setModels] = useState({ groups: [], failures: [] })
    const [modelsError, setModelsError] = useState("")
    const [path, setPath] = useState("")
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)
    const [saved, setSaved] = useState(false)

    useEffect(() => {
      call(SETTINGS_ROUTE).then(data => {
        setSettings(data.settings)
        setPath(typeof data.path === "string" ? data.path : "")
      }).catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
      call(MODELS_ROUTE).then(data => {
        setModels({ groups: Array.isArray(data.groups) ? data.groups : [], failures: Array.isArray(data.failures) ? data.failures : [] })
      }).catch(failure => setModelsError(String(failure && failure.message ? failure.message : failure)))
    }, [])

    const patch = useCallback(next => {
      setBusy(true)
      setError("")
      return call(SETTINGS_ROUTE, next).then(data => {
        setSettings(data.settings)
        setSaved(true)
        setTimeout(() => setSaved(false), 1200)
      }).catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
        .then(() => setBusy(false))
    }, [])

    if (settings === null) {
      return h("div", { className: "pt-settings" }, h("p", { key: "l", className: "pt-section-lead" }, t("loading")))
    }

    return h("div", { className: "pt-settings" }, [
      h("p", { key: "lead", className: "pt-section-lead" }, t("settings.lead")),

      h("div", { key: "send", className: "pt-row" }, [
        h("div", { key: "b", className: "pt-row-body" }, [
          h("div", { key: "t", className: "pt-row-title" }, t("send.label")),
          h("div", { key: "h", className: "pt-row-hint" }, t("send.hint")),
        ]),
        h("div", { key: "c", className: "pt-row-control" }, h(Segmented, {
          label: t("send.label"),
          value: settings.send,
          busy,
          options: [
            { value: "auto", label: t("send.auto") },
            { value: "ask", label: t("send.ask") },
            { value: "off", label: t("send.off") },
          ],
          onChange: value => patch({ send: value }),
        })),
      ]),

      h("div", { key: "delivery", className: "pt-row" }, [
        h("div", { key: "b", className: "pt-row-body" }, [
          h("div", { key: "t", className: "pt-row-title" }, t("delivery.label")),
          h("div", { key: "h", className: "pt-row-hint" }, t("delivery.hint")),
        ]),
        h("div", { key: "c", className: "pt-row-control" }, h(Segmented, {
          label: t("delivery.label"),
          value: settings.delivery ?? "steer",
          busy,
          options: [
            { value: "steer", label: t("delivery.steer") },
            { value: "queue", label: t("delivery.queue") },
          ],
          onChange: value => patch({ delivery: value }),
        })),
      ]),

      h("div", { key: "human", className: "pt-row" }, [
        h("div", { key: "b", className: "pt-row-body" }, [
          h("div", { key: "t", className: "pt-row-title" }, t("human.label")),
          h("div", { key: "h", className: "pt-row-hint" }, t("human.hint")),
        ]),
        h("div", { key: "c", className: "pt-row-control" }, h("input", {
          key: `human:${settings.humanName}`,
          className: "pt-input",
          defaultValue: settings.humanName,
          "aria-label": t("human.label"),
          onBlur: event => {
            const value = event.target.value.trim()
            if (value !== "" && value !== settings.humanName) patch({ humanName: value })
          },
          onKeyDown: event => { if (event.key === "Enter") event.target.blur() },
        })),
      ]),

      h("h3", { key: "mt", className: "pt-section-title" }, t("model.title")),
      h("p", { key: "ml", className: "pt-section-lead" }, t("model.hint")),
      h(ModelPicker, {
        key: "picker",
        value: settings.defaultModel === undefined ? null : settings.defaultModel,
        groups: models.groups,
        busy,
        onChange: value => patch({ defaultModel: value }),
      }),
      modelsError !== "" ? h("p", { key: "me", className: "pt-section-lead" }, `${t("model.failed")}${modelsError}`) : null,
      error !== "" ? h("p", { key: "err", className: "pt-section-lead" }, `${t("failed")}${error}`) : null,
      h("p", { key: "foot", className: "pt-foot" }, [
        h("span", { key: "p" }, `${t("path")}: ${path}`),
        saved ? h("span", { key: "s" }, ` · ${t("saved")}`) : null,
      ]),
    ])
  }

  /** One capability cell: click cycles inherit → allow → ask → deny → inherit. */
  function CapCell(props) {
    const t = translate
    const value = typeof props.explicit === "string" ? props.explicit : undefined
    const shown = value === undefined ? props.inherited : value
    return h("button", {
      type: "button",
      className: "pt-cap",
      "data-mode": shown,
      "data-explicit": value === undefined ? "false" : "true",
      title: value === undefined ? `${t("cap.inherit")} · ${t(`cap.${shown}`)}` : t(`cap.${shown}`),
      "aria-label": `${props.label}: ${value === undefined ? `${t("cap.inherit")} (${t(`cap.${shown}`)})` : t(`cap.${shown}`)}`,
      disabled: props.busy,
      onClick: props.onCycle,
    }, t(`cap.${shown}`))
  }

  /** The permission tree. */
  function PermissionsPanel(props) {
    const t = translate
    const [tree, setTree] = useState(null)
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)
    const [renaming, setRenaming] = useState(null)

    const load = useCallback(() => {
      setError("")
      call(TREE_ROUTE).then(data => setTree(data))
        .catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
    }, [])

    useEffect(() => { load() }, [load])

    const saveName = useCallback((sessionId, value) => {
      if (tree === null) return
      const names = { ...(tree.names ?? {}) }
      const next = typeof value === "string" ? value.trim() : ""
      // An empty field removes the override: the codename comes back.
      if (next === "") delete names[sessionId]
      else names[sessionId] = next
      if (JSON.stringify(names) === JSON.stringify(tree.names ?? {})) return
      setBusy(true)
      call(SETTINGS_ROUTE, { names }).then(() => load())
        .catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
        .then(() => setBusy(false))
    }, [tree, load])

    const saveGrants = useCallback(grants => {
      setBusy(true)
      call(SETTINGS_ROUTE, { grants }).then(() => load())
        .catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
        .then(() => setBusy(false))
    }, [load])

    const saveDefaults = useCallback(defaults => {
      setBusy(true)
      call(SETTINGS_ROUTE, { defaults }).then(() => load())
        .catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
        .then(() => setBusy(false))
    }, [load])

    if (tree === null) {
      return h("div", { className: "pt-perms" }, h("p", { className: "pt-perms-lead", style: { padding: "20px 28px" } }, t("loading")))
    }

    const cycle = current => {
      if (current === undefined) return "allow"
      if (current === "allow") return "ask"
      if (current === "ask") return "deny"
      return undefined
    }

    const setNode = (key, capability, next) => {
      const grants = { ...tree.grants }
      const entry = { ...(grants[key] || {}) }
      if (next === undefined) delete entry[capability]
      else entry[capability] = next
      if (Object.keys(entry).length === 0) delete grants[key]
      else grants[key] = entry
      saveGrants(grants)
    }

    const clearNode = key => {
      const grants = { ...tree.grants }
      delete grants[key]
      saveGrants(grants)
    }

    const head = h("thead", { key: "h" }, h("tr", null, [
      h("th", { key: "n" }, t("perms.node")),
      ...CAPABILITIES.map(capability => h("th", { key: capability }, t(`cap.${capability}`))),
      h("th", { key: "x", style: { width: "34px" } }),
    ]))

    const rows = []
    rows.push(h("tr", { key: "defaults", "data-kind": "default" }, [
      h("td", { key: "n" }, h("div", { className: "pt-node", style: { paddingLeft: "10px" } }, [
        h("span", { key: "t", className: "pt-node-title", style: { fontWeight: 600 } }, t("perms.defaults")),
        h("span", { key: "h", className: "pt-node-sub" }, t("perms.defaults.hint")),
      ])),
      ...CAPABILITIES.map(capability => h("td", { key: capability, className: "pt-cell" },
        h(CapCell, {
          capability,
          label: `${t("perms.defaults")} · ${t(`cap.${capability}`)}`,
          explicit: tree.defaults[capability],
          inherited: "ask",
          busy,
          onCycle: () => {
            const next = cycle(tree.defaults[capability])
            saveDefaults({ ...tree.defaults, [capability]: next === undefined ? "ask" : next })
          },
        }))),
      h("td", { key: "x" }),
    ]))

    if (tree.workspaces.length === 0) {
      rows.push(h("tr", { key: "empty" }, h("td", { colSpan: 5 }, h("div", { className: "pt-empty", style: { padding: "28px 0" } }, [
        h("div", { className: "pt-empty-title" }, t("perms.empty")),
      ]))))
    }

    for (const workspace of tree.workspaces) {
      const workspaceKey = `workspace:${workspace.id}`
      rows.push(h("tr", { key: workspaceKey, "data-kind": "workspace" }, [
        h("td", { key: "n" }, h("div", { className: "pt-node" }, [
          h("span", { key: "t", className: "pt-node-title", title: workspace.path }, workspace.title),
          h("span", { key: "c", className: "pt-chip" }, `${workspace.sessions.length} ${t("perms.sessions")}`),
        ])),
        ...CAPABILITIES.map(capability => h("td", { key: capability, className: "pt-cell" },
          h(CapCell, {
            capability,
            label: `${workspace.title} · ${t(`cap.${capability}`)}`,
            explicit: workspace.explicit[capability],
            inherited: workspace.effective[capability],
            busy,
            onCycle: () => setNode(workspaceKey, capability, cycle(workspace.explicit[capability])),
          }))),
        h("td", { key: "x", className: "pt-cell" }, workspace.explicit && Object.keys(workspace.explicit).length > 0
          ? h("button", { type: "button", className: "pt-reset", title: t("perms.reset"), "aria-label": t("perms.reset"), onClick: () => clearNode(workspaceKey) }, "\u2715")
          : null),
      ]))
      for (const session of workspace.sessions) {
        const sessionKey = `session:${session.id}`
        const isCurrent = props.sessionId === session.id
        const editing = renaming !== null && renaming.id === session.id
        rows.push(h("tr", { key: sessionKey, "data-kind": "session" }, [
          h("td", { key: "n" }, h("div", { className: "pt-node", "data-indent": "true" }, [
            h("span", { key: "m", className: "pt-state", "data-running": session.running ? "true" : "false", title: session.running ? "running" : "idle" }),
            editing
              ? h("input", {
                key: "edit",
                className: "pt-rename",
                value: renaming.value,
                autoFocus: true,
                "aria-label": t("name.rename"),
                onChange: event => setRenaming({ id: session.id, value: event.target.value }),
                onBlur: () => { saveName(session.id, renaming.value); setRenaming(null) },
                onKeyDown: event => {
                  if (event.key === "Enter") { saveName(session.id, renaming.value); setRenaming(null) }
                  if (event.key === "Escape") setRenaming(null)
                },
              })
              : h("span", {
                key: "t",
                className: "pt-node-name",
                title: `${session.id} · ${t("name.rename")}`,
                onClick: () => setRenaming({ id: session.id, value: session.name }),
              }, session.name),
            h("span", { key: "title", className: "pt-node-dim", title: session.title }, session.title),
            isCurrent ? h("span", { key: "c", className: "pt-chip", "data-current": "true" }, t("perms.current")) : null,
          ])),
          ...CAPABILITIES.map(capability => h("td", { key: capability, className: "pt-cell" },
            h(CapCell, {
              capability,
              label: `${session.name} · ${t(`cap.${capability}`)}`,
              explicit: session.explicit[capability],
              inherited: session.effective[capability],
              busy,
              onCycle: () => setNode(sessionKey, capability, cycle(session.explicit[capability])),
            }))),
          h("td", { key: "x", className: "pt-cell" }, session.explicit && Object.keys(session.explicit).length > 0
            ? h("button", { type: "button", className: "pt-reset", title: t("perms.reset"), "aria-label": t("perms.reset"), onClick: () => clearNode(sessionKey) }, "\u2715")
            : null),
        ]))
      }
    }

    return h("div", { className: "pt-perms" }, [
      h("div", { key: "head", className: "pt-perms-head" }, [
        h("p", { key: "l", className: "pt-perms-lead" }, t("perms.lead")),
        h("div", { key: "legend", className: "pt-legend" }, [
          h("span", { key: "a" }, [h("i", { key: "s", className: "pt-swatch", style: { background: "var(--dsw-alias-state-success-primary, #2fa36b)" } }), t("cap.allow")]),
          h("span", { key: "b" }, [h("i", { key: "s", className: "pt-swatch", style: { background: "var(--dsw-alias-state-warn-primary, #b7791f)" } }), t("cap.ask")]),
          h("span", { key: "c" }, [h("i", { key: "s", className: "pt-swatch", style: { background: "var(--dsw-alias-state-error-primary, #d64545)" } }), t("cap.deny")]),
          h("span", { key: "d" }, [h("i", { key: "s", className: "pt-swatch", style: { border: "1px dashed var(--dsw-alias-label-caption, #9aa0aa)" } }), t("cap.inherit")]),
        ]),
      ]),
      error !== "" ? h("div", { key: "err", className: "pt-error" }, `${t("failed")}${error}`) : null,
      h("div", { key: "scroll", className: "pt-table-scroll" },
        h("table", { className: "pt-table" }, [head, h("tbody", { key: "b" }, rows)])),
    ])
  }

  /** The forum: thread list, one thread, and the composer. */
  function ForumPanel() {
    const t = translate
    const [threads, setThreads] = useState(null)
    const [path, setPath] = useState("")
    const [thread, setThread] = useState(null)
    const [draft, setDraft] = useState("")
    const [title, setTitle] = useState("")
    const [composing, setComposing] = useState(false)
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)

    const loadList = useCallback(keepThread => {
      call(FORUM_ROUTE).then(data => {
        setThreads(Array.isArray(data.threads) ? data.threads : [])
        setPath(typeof data.path === "string" ? data.path : "")
        if (keepThread && typeof keepThread === "string") openThread(keepThread)
      }).catch(failure => {
        setThreads([])
        setError(String(failure && failure.message ? failure.message : failure))
      })
    }, [])

    const openThread = useCallback(id => {
      setError("")
      call(`${FORUM_ROUTE}?thread=${encodeURIComponent(id)}`).then(data => setThread(data.thread))
        .catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
    }, [])

    useEffect(() => { loadList() }, [loadList])

    const post = useCallback((payload, after) => {
      setBusy(true)
      setError("")
      call(FORUM_ROUTE, payload, "POST").then(data => { after(data) })
        .catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
        .then(() => setBusy(false))
    }, [])

    const publishNew = () => {
      if (title.trim() === "" || draft.trim() === "") return
      post({ title: title.trim(), body: draft.trim() }, data => {
        setComposing(false)
        setTitle("")
        setDraft("")
        if (data.thread) {
          setThread(data.thread)
          loadList(data.thread.id)
        } else {
          loadList()
        }
      })
    }

    const sendReply = () => {
      if (thread === null || draft.trim() === "") return
      post({ thread: thread.id, body: draft.trim() }, data => {
        setDraft("")
        if (data.thread) setThread(data.thread)
        loadList()
      })
    }

    const removeThread = () => {
      if (thread === null) return
      if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(t("forum.delete.confirm"))) return
      setBusy(true)
      call(`${FORUM_ROUTE}?thread=${encodeURIComponent(thread.id)}`, undefined, "DELETE")
        .then(() => { setThread(null); setDraft(""); loadList() })
        .catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
        .then(() => setBusy(false))
    }

    const list = h("aside", { key: "list", className: "pt-list-pane" }, [
      h("div", { key: "head", className: "pt-list-head" }, [
        h("span", { key: "t", className: "pt-list-title" }, t("tab.forum")),
        h("span", { key: "n", className: "pt-hint" }, threads === null ? "" : `${threads.length} ${t("forum.threads")}`),
        h("button", {
          key: "new",
          type: "button",
          className: "pt-btn",
          "data-primary": "true",
          style: { marginLeft: "auto", height: "26px" },
          onClick: () => { setComposing(value => !value); setThread(null); setError("") },
        }, t("forum.new")),
      ]),
      h("div", { key: "scroll", className: "pt-list-scroll" },
        threads === null
          ? h("div", { key: "l", className: "pt-hint", style: { padding: "8px 12px" } }, t("loading"))
          : threads.length === 0
            ? h("div", { key: "e", className: "pt-empty" }, [
              h("div", { key: "i", className: "pt-empty-icon" }, "\u25a7"),
              h("div", { key: "t", className: "pt-empty-title" }, t("forum.empty")),
              h("div", { key: "h", className: "pt-empty-hint" }, t("forum.empty.hint")),
            ])
            : threads.map(row => h("button", {
              key: row.id,
              type: "button",
              className: "pt-thread",
              "data-on": thread !== null && thread.id === row.id ? "true" : "false",
              onClick: () => { setComposing(false); openThread(row.id) },
            }, [
              h("span", { key: "t", className: "pt-thread-title" }, row.title),
              h("span", { key: "m", className: "pt-thread-meta" }, [
                h("span", { key: "w" }, row.workspace),
                h("i", { key: "d", className: "pt-dot" }),
                h("span", { key: "p" }, `${row.posts} ${t("forum.posts")}`),
                h("i", { key: "d2", className: "pt-dot" }),
                h("span", { key: "t2" }, ageLabel(row.updatedAt)),
              ]),
              row.excerpt === "" ? null : h("span", { key: "e", className: "pt-thread-excerpt" }, row.excerpt),
            ]))),
    ])

    const compose = (isNew) => h("div", { key: "composer", className: "pt-composer" }, [
      isNew ? h("input", {
        key: "title",
        value: title,
        placeholder: t("forum.title.placeholder"),
        "aria-label": t("forum.title"),
        onChange: event => setTitle(event.target.value),
      }) : null,
      h("textarea", {
        key: "body",
        value: draft,
        placeholder: isNew ? t("forum.body.placeholder") : t("forum.reply.placeholder"),
        "aria-label": t("forum.body"),
        rows: 2,
        onChange: event => setDraft(event.target.value),
      }),
      h("div", { key: "foot", className: "pt-composer-foot" }, [
        h("span", { key: "h", className: "pt-hint" }, isNew ? t("forum.lead") : ""),
        h("span", { key: "g", style: { flex: 1 } }),
        isNew ? h("button", {
          key: "c",
          type: "button",
          className: "pt-btn",
          onClick: () => { setComposing(false); setTitle(""); setDraft("") },
        }, t("forum.cancel")) : null,
        h("button", {
          key: "p",
          type: "button",
          className: "pt-btn",
          "data-primary": "true",
          disabled: busy || draft.trim() === "" || (isNew && title.trim() === ""),
          onClick: isNew ? publishNew : sendReply,
        }, busy ? t("forum.sending") : t("forum.publish")),
      ]),
    ])

    let detail
    if (composing) {
      detail = h("section", { key: "detail", className: "pt-detail" }, [
        h("div", { key: "head", className: "pt-detail-head" }, [
          h("div", { key: "b" }, [
            h("div", { key: "t", className: "pt-detail-title" }, t("forum.new")),
            h("div", { key: "m", className: "pt-detail-meta" }, t("forum.lead")),
          ]),
        ]),
        error !== "" ? h("div", { key: "err", className: "pt-error" }, `${t("failed")}${error}`) : null,
        h("div", { key: "fill", style: { flex: 1 } }),
        compose(true),
      ])
    } else if (thread !== null) {
      detail = h("section", { key: "detail", className: "pt-detail" }, [
        h("div", { key: "head", className: "pt-detail-head" }, [
          h("div", { key: "b", style: { minWidth: 0 } }, [
            h("div", { key: "t", className: "pt-detail-title" }, thread.title),
            h("div", { key: "m", className: "pt-detail-meta" }, [
              h("span", { key: "w" }, thread.workspace),
              h("i", { key: "d", className: "pt-dot" }),
              h("span", { key: "p" }, `${thread.posts.length} ${t("forum.posts")}`),
              h("i", { key: "d2", className: "pt-dot" }),
              h("span", { key: "t" }, ageLabel(thread.updatedAt)),
            ]),
          ]),
          h("div", { key: "a", className: "pt-detail-actions" }, [
            h("button", { key: "back", type: "button", className: "pt-btn", onClick: () => { setThread(null); setDraft("") } }, `\u2190 ${t("forum.back")}`),
            h("button", { key: "del", type: "button", className: "pt-btn", "data-ghost": "true", disabled: busy, onClick: removeThread }, t("forum.delete")),
          ]),
        ]),
        error !== "" ? h("div", { key: "err", className: "pt-error" }, `${t("failed")}${error}`) : null,
        h("div", { key: "posts", className: "pt-posts" }, thread.posts.map(row => h("div", { key: row.id, className: "pt-post" }, [
          h(Avatar, { key: "a", name: row.author }),
          h("div", { key: "b", className: "pt-post-body" }, [
            h("div", { key: "h", className: "pt-post-head" }, [
              h("span", { key: "a", className: "pt-post-author" }, row.author),
              h("span", { key: "w", className: "pt-post-time" }, row.workspace),
              h("span", { key: "t", className: "pt-post-time" }, ageLabel(row.createdAt)),
            ]),
            h("div", { key: "t", className: "pt-post-text" }, row.body),
          ]),
        ]))),
        compose(false),
      ])
    } else {
      detail = h("section", { key: "detail", className: "pt-detail" },
        h("div", { key: "empty", className: "pt-empty" }, [
          h("div", { key: "i", className: "pt-empty-icon" }, "\u25a7"),
          h("div", { key: "t", className: "pt-empty-title" }, t("forum.no.selection")),
          h("div", { key: "h", className: "pt-empty-hint" }, path),
        ]))
    }

    return h("div", { className: "pt-forum" }, [list, detail])
  }

  /** The session's Peer talk view: forum and permission tree. */
  function PeerTalkView(props) {
    const t = translate
    const [tab, setTab] = useState(props.initialTab === "perms" ? "perms" : "forum")
    const rootRef = useRef(null)

    // The harness lets an active conversation's view area grow with its content
    // and scroll the whole page, which would make this page one tall sheet and
    // defeat the two independent scroll regions below. Bound the page to the
    // visible area above the composer instead, and re-measure on resize.
    useEffect(() => {
      if (typeof window === "undefined" || typeof document === "undefined") return undefined
      const measure = () => {
        const node = rootRef.current
        if (node === null) return
        const rect = node.getBoundingClientRect()
        let bottom = window.innerHeight
        for (const candidate of document.querySelectorAll('[class*="_composerSeat"], [data-composer-seat]')) {
          const seat = candidate.getBoundingClientRect()
          if (seat.top > rect.top + 80 && seat.top < bottom) bottom = seat.top
        }
        const available = Math.max(320, Math.floor(bottom - rect.top - 2))
        if (Math.abs(node.offsetHeight - available) > 1) {
          node.style.height = `${available}px`
          node.style.maxHeight = `${available}px`
        }
      }
      measure()
      window.addEventListener("resize", measure)
      const timer = window.setInterval(measure, 500)
      return () => {
        window.removeEventListener("resize", measure)
        window.clearInterval(timer)
      }
    }, [tab])

    return h("div", { className: "pt-page", ref: rootRef }, [
      h("header", { key: "head", className: "pt-head" }, [
        h("div", { key: "tr", className: "pt-title-row" }, [
          h("span", { key: "t", className: "pt-title" }, t("view.nav")),
          h("span", { key: "s", className: "pt-sub" }, t("page.sub")),
        ]),
        h("nav", { key: "tabs", className: "pt-tabs" }, [
          h("button", {
            key: "forum",
            type: "button",
            className: "pt-tab",
            "data-on": tab === "forum" ? "true" : "false",
            onClick: () => setTab("forum"),
          }, t("tab.forum")),
          h("button", {
            key: "perms",
            type: "button",
            className: "pt-tab",
            "data-on": tab === "perms" ? "true" : "false",
            onClick: () => setTab("perms"),
          }, t("tab.perms")),
        ]),
      ]),
      h("div", { key: "div", className: "pt-divider" }),
      h("div", { key: "body", className: "pt-body" },
        tab === "forum" ? h(ForumPanel, { key: "forum" }) : h(PermissionsPanel, { key: "perms", sessionId: props.sessionId })),
    ])
  }

  function apply(ctx) {
    installStyles()
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-peer-talk: dictionaries")
    const t = ctx.locale.bind(NS)
    translate = t

    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "dsh-peer-talk",
      order: 63,
      label: () => t("nav"),
      locale: NS,
      inject: () => ({ t }),
    }, SettingsSection))

    ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "peer-talk",
      order: 20,
      label: () => t("view.nav"),
      locale: NS,
      inject: () => ({ t }),
    }, PeerTalkView))
  }

  exports.name = name
  exports.inject = inject
  exports.apply = apply
  return module.exports
}})
