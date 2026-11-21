// AEIOU LINE <-> Google Drive bot (class template)
// One small server doing two jobs for ONE LINE Official Account:
//   A) Logger: every message in the chats the OA is in -> text files in Drive ("Note from LINE")
//   B) Relay:  Google Docs an AI assistant prepares in Drive ("Comment from Dots") -> ONE LINE group
// No AI inside and no replies of its own: the thinking happens between A and B,
// in whatever assistant reads the notes and writes the comments.
//
// File contract for the assistant (part B):
//   - Google Docs in the comment folder named "YYYY-MM-DD HH.MM — <anything>"
//     (while writing, start the name with DRAFT, so it is ignored)
//   - the whole doc is the message; first line "[ไม่ส่ง]" means skip
//   - a line of only "---" splits it into separate chat bubbles (max 5)
//   - "@nickname" becomes a real LINE mention (see MENTIONS), "@ทุกคน" becomes @All

const crypto = require('crypto');
const express = require('express');
const { google } = require('googleapis');

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const LINE_CHANNEL_ID = required('LINE_CHANNEL_ID');
const LINE_CHANNEL_SECRET = required('LINE_CHANNEL_SECRET');
// OAuth as the owner's own Google account (see scripts/google-login.js).
// Scopes: drive.file (write only what this bot created) + drive.readonly
// (read the docs the assistant writes). The bot can never edit or delete
// anything else in the owner's Drive.
const GOOGLE_OAUTH_CLIENT_ID = required('GOOGLE_OAUTH_CLIENT_ID');
const GOOGLE_OAUTH_CLIENT_SECRET = required('GOOGLE_OAUTH_CLIENT_SECRET');
const GOOGLE_OAUTH_REFRESH_TOKEN = required('GOOGLE_OAUTH_REFRESH_TOKEN');
// Guards the admin endpoints (/check, /groups, /run).
const ADMIN_KEY = required('ADMIN_KEY');
// Folders are created by the bot on first start (it can only write into folders
// it created). The owner may rename or move them later: the bot finds them by a
// hidden tag, not by name or location.
const NOTE_FOLDER_NAME = process.env.NOTE_FOLDER_NAME || 'Note from LINE';
const COMMENT_FOLDER_NAME = process.env.COMMENT_FOLDER_NAME || 'Comment from Dots';
// The single group the bot may post to. Sending stays OFF until this is set
// (get the id from /groups after the OA has been invited and someone has typed).
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID || '';
// Nickname -> LINE user id, e.g. {"มะลิ":"U…","ต้น":"U…"}. "@มะลิ" in a doc becomes
// "มะลิ @<her LINE name>" with a real mention. Unknown names stay plain text.
const MENTIONS = parseMentions(process.env.MENTIONS);
// Round hours allowed in file names, per weekday (0 = Sunday), e.g.
// "1-5=9-18,0=14-18": Mon–Fri rounds 09.00–18.00, Sunday 14.00–18.00.
// Docs are sent from the first hour until hh:59 of the last; days not listed
// send nothing. A doc that misses its day is never carried over to the next.
const DEFAULT_SCHEDULE = '0-6=7-20';
const SCHEDULE = parseSchedule(process.env.SCHEDULE || DEFAULT_SCHEDULE);

// File names and the schedule use Thailand time (UTC+7, no DST).
const UTC_OFFSET_HOURS = 7;
const POLL_MS = 60 * 1000;
const FLUSH_MS = 15 * 1000;
// Extra guard on top of DRAFT -> rename: don't send a doc touched in the last minute.
const SETTLE_MS = 60 * 1000;
// Give up on a doc after this many failed push attempts.
const MAX_ATTEMPTS = 5;
// Statuses after which a doc is never looked at again.
const FINAL = new Set(['sent', 'skipped', 'failed']);
// Send history older than this is dropped from _sent.json.
const KEEP_SENT_DAYS = 60;

// "2026-10-08 09.00 — Morning Brief"
const NAME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2})\.(\d{2}) [—–-] /;

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function parseMentions(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    // A typo here must not stop deliveries; the messages just go out untagged.
    console.error(`MENTIONS is not valid JSON, tagging disabled: ${err.message}`);
    return {};
  }
}

function parseSchedule(raw) {
  const out = {};
  for (const part of raw.split(',')) {
    const m = /^\s*(\d)(?:-(\d))?\s*=\s*(\d{1,2})-(\d{1,2})\s*$/.exec(part);
    if (!m) {
      // A typo must not open odd hours; fall back to the default schedule.
      console.error(`SCHEDULE "${raw}" is invalid, using ${DEFAULT_SCHEDULE}`);
      return parseSchedule(DEFAULT_SCHEDULE);
    }
    for (let d = Number(m[1]); d <= Number(m[2] ?? m[1]); d++) {
      out[d] = { first: Number(m[3]), last: Number(m[4]) };
    }
  }
  return out;
}

// ---------- time helpers ----------
function localNow() {
  return new Date(Date.now() + UTC_OFFSET_HOURS * 60 * 60 * 1000);
}
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function stampFromMs(ms) {
  const d = new Date(ms + UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
function monthKey() {
  return localNow().toISOString().slice(0, 7); // YYYY-MM
}
function roundsFor(date) {
  return SCHEDULE[new Date(`${date}T00:00:00Z`).getUTCDay()] || null;
}

// A doc is ready to send only when its name follows the final format, carries
// today's date and a round hour allowed for that day (any hour on a manual /run).
function parseName(name, date, anyHour = false) {
  const m = NAME_RE.exec(name);
  if (!m || m[1] !== date) return null;
  const hour = Number(m[2]);
  const rounds = anyHour ? { first: 0, last: 23 } : roundsFor(date);
  if (!rounds || hour < rounds.first || hour > rounds.last) return null;
  return { hour, minute: Number(m[3]) };
}

// ---------- Google Drive ----------
const auth = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
auth.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth });

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_TAG = 'aeiouLineDriveBot';
const FOLDERS = { note: NOTE_FOLDER_NAME, comment: COMMENT_FOLDER_NAME };
const folderIds = {};

// The bot's two root folders carry a hidden tag (appProperties, visible only to
// this app), so they are found again after a restart even if renamed or moved,
// and a same-named folder the owner made by hand is never mistaken for them.
async function folderId(kind) {
  if (folderIds[kind]) return folderIds[kind];
  const q = `appProperties has { key='${FOLDER_TAG}' and value='${kind}' } and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const { data } = await drive.files.list({ q, fields: 'files(id)' });
  if (data.files.length > 0) {
    folderIds[kind] = data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: { name: FOLDERS[kind], mimeType: FOLDER_MIME, appProperties: { [FOLDER_TAG]: kind } },
      fields: 'id',
    });
    folderIds[kind] = created.data.id;
    console.log(`Created folder "${FOLDERS[kind]}" (${folderIds[kind]})`);
  }
  return folderIds[kind];
}

// Small JSON files the bot keeps next to the logs (names start with "_").
async function openJson(name, fallback) {
  const parent = await folderId('note');
  const q = `name = '${name}' and '${parent}' in parents and trashed = false`;
  const { data } = await drive.files.list({ q, fields: 'files(id)' });
  if (data.files.length > 0) {
    const id = data.files[0].id;
    const res = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'text' });
    return { id, data: JSON.parse(typeof res.data === 'string' ? res.data : JSON.stringify(res.data)) };
  }
  const created = await drive.files.create({
    requestBody: { name, parents: [parent] },
    media: { mimeType: 'application/json', body: JSON.stringify(fallback) },
    fields: 'id',
  });
  return { id: created.data.id, data: fallback };
}

async function saveJson(store) {
  await drive.files.update({
    fileId: store.id,
    media: { mimeType: 'application/json', body: JSON.stringify(store.data, null, 2) },
  });
}

// ---------- LINE ----------
// Stateless channel access token (v3, valid 15 min), issued from channel id +
// secret, so there is no long-lived token to copy or renew. Reused for 10 minutes.
let tokenCache = { value: null, until: 0 };
async function lineToken() {
  if (tokenCache.value && Date.now() < tokenCache.until) return tokenCache.value;
  const res = await fetch('https://api.line.me/oauth2/v3/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: LINE_CHANNEL_ID,
      client_secret: LINE_CHANNEL_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`LINE token issue failed -> ${res.status}`);
  tokenCache = { value: (await res.json()).access_token, until: Date.now() + 10 * 60 * 1000 };
  return tokenCache.value;
}

async function lineGet(apiPath) {
  const res = await fetch(`https://api.line.me${apiPath}`, {
    headers: { Authorization: `Bearer ${await lineToken()}` },
  });
  if (!res.ok) throw new Error(`LINE GET ${apiPath} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// =====================================================================
// A) Logger: LINE -> "Note from LINE"
// =====================================================================
const nameCache = new Map(); // cache display names / group names

async function sourceTitle(source) {
  // Human-readable name for the chat a message came from.
  if (source.type === 'group') {
    const key = `g:${source.groupId}`;
    if (!nameCache.has(key)) {
      try {
        const s = await lineGet(`/v2/bot/group/${source.groupId}/summary`);
        nameCache.set(key, s.groupName || source.groupId);
      } catch {
        nameCache.set(key, `Group ${source.groupId.slice(-6)}`);
      }
    }
    return nameCache.get(key);
  }
  if (source.type === 'room') {
    return `Multi-chat ${source.roomId.slice(-6)}`;
  }
  // 1:1 chat with the OA
  const key = `u:${source.userId}`;
  if (!nameCache.has(key)) {
    try {
      const p = await lineGet(`/v2/bot/profile/${source.userId}`);
      nameCache.set(key, `DM - ${p.displayName || source.userId}`);
    } catch {
      nameCache.set(key, `DM - ${source.userId.slice(-6)}`);
    }
  }
  return nameCache.get(key);
}

async function senderName(source) {
  if (!source.userId) return 'ไม่ทราบชื่อ';
  const key = `m:${source.userId}`;
  if (nameCache.has(key)) return nameCache.get(key);
  try {
    let p;
    if (source.type === 'group') {
      p = await lineGet(`/v2/bot/group/${source.groupId}/member/${source.userId}`);
    } else if (source.type === 'room') {
      p = await lineGet(`/v2/bot/room/${source.roomId}/member/${source.userId}`);
    } else {
      p = await lineGet(`/v2/bot/profile/${source.userId}`);
    }
    nameCache.set(key, p.displayName || source.userId);
  } catch {
    nameCache.set(key, `สมาชิก ${source.userId.slice(-6)}`);
  }
  return nameCache.get(key);
}

// Mapping chatKey -> { folderId, name, members } lives in _groups.json, so
// renaming folders in Drive never breaks anything. `members` collects the user
// ids of people seen talking, which is what MENTIONS needs for tagging.
let groups = null;

async function loadGroups() {
  if (!groups) groups = await openJson('_groups.json', {});
  return groups.data;
}

function chatKey(source) {
  if (source.type === 'group') return source.groupId;
  if (source.type === 'room') return source.roomId;
  return `dm:${source.userId}`;
}

async function folderForSource(source, members) {
  const map = await loadGroups();
  const key = chatKey(source);
  let changed = false;
  if (!map[key]) {
    const name = await sourceTitle(source);
    const created = await drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [await folderId('note')] },
      fields: 'id',
    });
    map[key] = { folderId: created.data.id, name, members: {} };
    changed = true;
    console.log(`Created folder "${name}" for chat ${key}`);
  }
  const known = (map[key].members ||= {});
  for (const [userId, name] of Object.entries(members)) {
    if (known[userId] !== name) {
      known[userId] = name;
      changed = true;
    }
  }
  if (changed) await saveJson(groups);
  return map[key].folderId;
}

// Append lines to the monthly log file in a folder.
async function appendToLog(parent, lines) {
  const fileName = `chat-log-${monthKey()}.txt`;
  const q = `name = '${fileName}' and '${parent}' in parents and trashed = false`;
  const { data } = await drive.files.list({ q, fields: 'files(id)' });
  const block = lines.join('\n') + '\n';
  if (data.files.length === 0) {
    await drive.files.create({
      requestBody: { name: fileName, parents: [parent] },
      media: { mimeType: 'text/plain', body: block },
    });
  } else {
    const fileId = data.files[0].id;
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
    const current = typeof res.data === 'string' ? res.data : String(res.data);
    await drive.files.update({
      fileId,
      media: { mimeType: 'text/plain', body: current + block },
    });
  }
}

function describeMessage(m) {
  switch (m.type) {
    case 'text':
      return m.text;
    case 'image':
      return '[ส่งรูป]';
    case 'video':
      return '[ส่งวิดีโอ]';
    case 'audio':
      return '[ส่งข้อความเสียง]';
    case 'file':
      return `[ส่งไฟล์: ${m.fileName || 'ไม่ทราบชื่อไฟล์'}]`;
    case 'sticker':
      return '[ส่งสติกเกอร์]';
    case 'location':
      return `[แชร์ตำแหน่ง: ${m.title || m.address || ''}]`.trim();
    default:
      return `[${m.type}]`;
  }
}

// Queue: never lose a message even if Drive hiccups. Events are buffered per
// chat and flushed by one worker loop (single replica only — do not scale this
// service beyond 1 instance).
const pending = new Map(); // chatKey -> { source, lines: [], members: {} }
let flushing = false;

function enqueue(source, line, member) {
  const key = chatKey(source);
  if (!pending.has(key)) pending.set(key, { source, lines: [], members: {} });
  const entry = pending.get(key);
  entry.lines.push(line);
  if (member) entry.members[member.userId] = member.name;
}

async function flushLoop() {
  if (flushing) return;
  flushing = true;
  try {
    for (const [key, entry] of [...pending.entries()]) {
      if (entry.lines.length === 0) continue;
      const lines = entry.lines.splice(0, entry.lines.length);
      try {
        const parent = await folderForSource(entry.source, entry.members);
        await appendToLog(parent, lines);
        console.log(`Flushed ${lines.length} line(s) -> ${key}`);
      } catch (err) {
        // put lines back at the front; retry next cycle
        entry.lines.unshift(...lines);
        console.error(`Flush failed for ${key}: ${err.message}`);
      }
    }
  } finally {
    flushing = false;
  }
}
setInterval(flushLoop, FLUSH_MS);

async function handleEvent(ev) {
  if (!ev.source) return;
  const stamp = stampFromMs(ev.timestamp || Date.now());
  if (ev.type === 'message') {
    const name = await senderName(ev.source);
    const member = ev.source.userId && { userId: ev.source.userId, name };
    enqueue(ev.source, `[${stamp}] ${name}: ${describeMessage(ev.message)}`, member);
  } else if (ev.type === 'join') {
    enqueue(ev.source, `[${stamp}] (บอทถูกเชิญเข้ากลุ่มนี้ — เริ่มบันทึกตั้งแต่ตอนนี้)`);
  } else if (ev.type === 'memberJoined') {
    enqueue(ev.source, `[${stamp}] (มีสมาชิกใหม่เข้ากลุ่ม)`);
  } else if (ev.type === 'memberLeft') {
    enqueue(ev.source, `[${stamp}] (มีสมาชิกออกจากกลุ่ม)`);
  } else if (ev.type === 'unsend') {
    enqueue(ev.source, `[${stamp}] (มีการยกเลิกข้อความ 1 ข้อความ)`);
  }
  // Everything else (follow, postback, ...) is intentionally ignored.
}

// =====================================================================
// B) Relay: "Comment from Dots" -> LINE group
// =====================================================================

// Today's ready docs, in round order.
async function listReadyDocs(date, anyHour) {
  const q = [
    `'${await folderId('comment')}' in parents`,
    `name contains '${date}'`,
    `mimeType = 'application/vnd.google-apps.document'`,
    'trashed = false',
  ].join(' and ');
  const { data } = await drive.files.list({
    q,
    fields: 'files(id, name, createdTime, modifiedTime)',
    orderBy: 'createdTime',
    pageSize: 100,
  });
  return data.files
    .map((f) => ({ ...f, round: parseName(f.name, date, anyHour) }))
    .filter((f) => f.round)
    .sort((a, b) => a.round.hour - b.round.hour || a.round.minute - b.round.minute);
}

async function getMeta(fileId) {
  const { data } = await drive.files.get({ fileId, fields: 'id, name, trashed, modifiedTime' });
  return data;
}

async function readDocText(fileId) {
  const res = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
  const text = typeof res.data === 'string' ? res.data : String(res.data);
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// LINE text messages max 5000 chars; a push carries max 5 messages.
// Split on blank lines so sections stay whole.
function splitMessages(text, limit = 4800) {
  const parts = [];
  let cur = '';
  for (const para of text.split('\n\n')) {
    const add = cur ? `${cur}\n\n${para}` : para;
    if (add.length <= limit) {
      cur = add;
      continue;
    }
    if (cur) parts.push(cur);
    cur = para;
    while (cur.length > limit) {
      parts.push(cur.slice(0, limit));
      cur = cur.slice(limit);
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// A line of only dashes/underscores ("---", or "—" if Docs autocorrected it)
// separates sections; each section goes out as its own chat bubble so the team
// sees short messages instead of one long block folded behind "See more".
const SECTION_SEP = /^[ \t]*(?:[-_]{3,}|[-–—_]*—[-–—_]*)[ \t]*$/m;

// Up to 5 bubbles fit one push, which costs the same quota as a single bubble,
// so overflow sections are merged into the 5th bubble when they fit.
function toBubbles(text) {
  const sections = text.split(SECTION_SEP).map((s) => s.trim()).filter(Boolean);
  const bubbles = sections.flatMap((s) => splitMessages(s));
  if (bubbles.length > 5) {
    const tail = bubbles.slice(4).join('\n\n');
    if (tail.length <= 4800) return [...bubbles.slice(0, 4), tail];
  }
  return bubbles;
}

// Turns "@มะลิ" into a real LINE mention (textV2). The nickname must not run into
// another letter, so "@มะลิคะ" is left alone; anything (emoji, space) may precede it.
// Longest nicknames are tried first so "@พี่เอก" never matches a shorter "เอก".
// "@ทุกคน" becomes LINE's @All mention.
const LETTER = /[\p{L}\p{M}\p{N}]/u;
const ALL_NAME = 'ทุกคน';
const ALL_KEY = 'all';
function toLineMessage(text) {
  const names = [...Object.keys(MENTIONS), ALL_NAME].sort((a, b) => b.length - a.length);
  // textV2 treats braces as placeholders, so a bubble containing them is sent untagged.
  if (!text.includes('@') || /[{}]/.test(text)) return { type: 'text', text };

  const keys = new Map(); // userId (or ALL_KEY) -> placeholder key
  let out = '';
  let i = 0;
  while (i < text.length) {
    const name =
      text[i] === '@' &&
      !LETTER.test(text[i - 1] || '') &&
      names.find((n) => text.startsWith(n, i + 1) && !LETTER.test(text[i + 1 + n.length] || ''));
    if (!name) {
      out += text[i++];
      continue;
    }
    if (name === ALL_NAME) {
      keys.set(ALL_KEY, ALL_KEY);
      out += `{${ALL_KEY}}`;
    } else {
      const userId = MENTIONS[name];
      if (!keys.has(userId)) keys.set(userId, `m${keys.size}`);
      out += `${name} {${keys.get(userId)}}`;
    }
    i += 1 + name.length;
  }
  if (!keys.size) return { type: 'text', text };
  const substitution = {};
  for (const [id, key] of keys) {
    substitution[key] = { type: 'mention', mentionee: id === ALL_KEY ? { type: 'all' } : { type: 'user', userId: id } };
  }
  return { type: 'textV2', text: out, substitution };
}

// Deterministic retry key: LINE rejects a second push with the same key (409)
// for 24h, so a restart or double trigger can never post twice.
function retryKeyFor(seed) {
  const h = crypto.createHash('sha256').update(`line-drive-bot:${seed}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function push(to, messages, retryKey) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await lineToken()}`,
      'X-Line-Retry-Key': retryKey,
    },
    body: JSON.stringify({ to, messages }),
  });
  if (res.status === 409) return 'already-sent';
  if (!res.ok) {
    const err = new Error(`LINE push -> ${res.status} ${await res.text()}`);
    err.status = res.status;
    // 429 / 5xx are worth retrying next minute; other 4xx will fail the same way again.
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  return 'sent';
}

// If LINE rejects the tagged version (400), the round still goes out untagged.
// Reusing the retry key is safe: a rejected request was never accepted.
async function pushTagged(to, texts, retryKey) {
  const messages = texts.map(toLineMessage);
  try {
    return await push(to, messages, retryKey);
  } catch (err) {
    if (err.status !== 400 || !messages.some((m) => m.type === 'textV2')) throw err;
    console.error(`tagged push rejected, sending untagged: ${err.message}`);
    return push(to, texts.map((text) => ({ type: 'text', text })), retryKey);
  }
}

// Send history lives in _sent.json in Drive, so it survives restarts and the
// owner can open it to see what went out:
// { docs: { [docId]: { name, date, status, parts: { [i]: 'sent' }, attempts, ... } } }
let sent = null;

async function loadSent() {
  if (!sent) sent = await openJson('_sent.json', { docs: {} });
  return sent.data;
}

async function saveSent() {
  const cutoff = ymd(new Date(localNow().getTime() - KEEP_SENT_DAYS * 24 * 60 * 60 * 1000));
  for (const [id, rec] of Object.entries(sent.data.docs)) {
    if (rec.date < cutoff) delete sent.data.docs[id];
  }
  await saveJson(sent);
}

// Returns the doc's status. 'settling' / 'retry' mean "try again next minute"
// and hold back later docs so rounds stay in order.
async function processDoc(file, date, anyHour) {
  if (Date.now() - Date.parse(file.modifiedTime) < SETTLE_MS) return 'settling';

  // Re-check right before sending: it may have been renamed back to DRAFT or deleted.
  const meta = await getMeta(file.id);
  if (meta.trashed || !parseName(meta.name, date, anyHour)) return 'withdrawn';

  const docs = (await loadSent()).docs;
  const rec = (docs[file.id] ||= { name: meta.name, date, parts: {}, attempts: 0 });
  rec.name = meta.name;

  const text = await readDocText(file.id);
  if (!text || text.split('\n')[0].trim().startsWith('[ไม่ส่ง]')) {
    rec.status = 'skipped';
    rec.reason = text ? 'marked [ไม่ส่ง]' : 'empty';
    await saveSent();
    console.log(`[${date}] skipped (${rec.reason}): "${meta.name}"`);
    return rec.status;
  }

  const bubbles = toBubbles(text);
  for (let i = 0; i * 5 < bubbles.length; i++) {
    if (rec.parts[i] === 'sent') continue;
    try {
      await pushTagged(TARGET_GROUP_ID, bubbles.slice(i * 5, i * 5 + 5), retryKeyFor(`${TARGET_GROUP_ID}:${file.id}:${i}`));
    } catch (err) {
      rec.attempts += 1;
      rec.lastError = err.message.slice(0, 300);
      rec.status = err.permanent || rec.attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
      await saveSent();
      console.error(`[${date}] push failed (${rec.attempts}) "${meta.name}": ${err.message}`);
      return rec.status;
    }
    rec.parts[i] = 'sent';
    await saveSent();
  }

  rec.status = 'sent';
  rec.sentAt = new Date().toISOString();
  await saveSent();
  console.log(`[${date}] sent "${meta.name}" (${bubbles.length} msg)`);
  return rec.status;
}

let running = false;

async function runOnce({ force = false } = {}) {
  const now = localNow();
  const date = ymd(now);
  const hour = now.getUTCHours();
  const rounds = roundsFor(date);
  if (!force && (!rounds || hour < rounds.first || hour > rounds.last)) return { status: 'off-hours' };
  if (!TARGET_GROUP_ID) return { status: 'no-target-group' };

  const docs = (await loadSent()).docs;
  const results = [];
  for (const doc of await listReadyDocs(date, force)) {
    if (docs[doc.id] && FINAL.has(docs[doc.id].status)) continue;
    const status = await processDoc(doc, date, force);
    results.push({ name: doc.name, status });
    if (status === 'settling' || status === 'retry') break;
  }
  return { status: 'ok', date, results };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await runOnce();
  } catch (err) {
    console.error(`tick error: ${err.message}`);
  } finally {
    running = false;
  }
}
setInterval(tick, POLL_MS);

// =====================================================================
// HTTP: LINE webhook + health + admin checks
// =====================================================================
const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

function validSignature(req) {
  const signature = req.get('X-Line-Signature') || '';
  const digest = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(req.rawBody || '').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

function admin(req, res, next) {
  if ((req.get('X-Admin-Key') || req.query.key) !== ADMIN_KEY) return res.sendStatus(403);
  next();
}

const folderLink = (id) => `https://drive.google.com/drive/folders/${id}`;

app.get('/', (_req, res) => res.send('LINE <-> Drive bot is running.'));

app.post('/webhook', (req, res) => {
  if (!validSignature(req)) return res.sendStatus(403);
  res.sendStatus(200); // answer LINE fast; process async
  for (const ev of req.body.events || []) {
    handleEvent(ev).catch((err) => console.error(`handleEvent error: ${err.message}`));
  }
});

// Read-only: is everything connected? Each part reports on its own, so one
// broken connection doesn't hide the state of the others.
app.get('/check', admin, async (_req, res) => {
  const date = ymd(localNow());
  const out = { date, schedule: SCHEDULE, roundsToday: roundsFor(date), mentionNames: Object.keys(MENTIONS) };
  try {
    const info = await lineGet('/v2/bot/info');
    out.line = { ok: true, name: info.displayName, basicId: info.basicId };
    const quota = await lineGet('/v2/bot/message/quota');
    const { totalUsage } = await lineGet('/v2/bot/message/quota/consumption');
    out.line.quota = quota.type === 'limited' ? { limit: quota.value, used: totalUsage } : { limit: null, used: totalUsage };
  } catch (err) {
    out.line = { ok: false, error: err.message };
  }
  try {
    out.drive = { ok: true, noteFolder: folderLink(await folderId('note')), commentFolder: folderLink(await folderId('comment')) };
    const docs = (await loadSent()).docs;
    out.readyDocsToday = (await listReadyDocs(date, true)).map((d) => ({ name: d.name, status: docs[d.id]?.status || 'new' }));
  } catch (err) {
    out.drive = { ok: false, error: err.message };
  }
  out.sending = TARGET_GROUP_ID ? { on: true, groupId: TARGET_GROUP_ID } : { on: false, why: 'TARGET_GROUP_ID is not set' };
  if (TARGET_GROUP_ID) {
    try {
      out.sending.groupName = (await lineGet(`/v2/bot/group/${TARGET_GROUP_ID}/summary`)).groupName;
      out.sending.members = (await lineGet(`/v2/bot/group/${TARGET_GROUP_ID}/members/count`)).count;
    } catch (err) {
      out.sending.error = err.message;
    }
  }
  res.json(out);
});

// Read-only: chats the bot has logged, with their ids (for TARGET_GROUP_ID)
// and the user ids of people seen talking (for MENTIONS).
app.get('/groups', admin, async (_req, res) => {
  try {
    const map = await loadGroups();
    res.json(Object.entries(map).map(([id, g]) => ({ id, name: g.name, members: g.members || {} })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual run now, ignoring the schedule (still today's ready docs only, still
// once per doc). For testing.
app.get('/run', admin, async (_req, res) => {
  if (running) return res.status(409).json({ error: 'busy' });
  running = true;
  try {
    res.json(await runOnce({ force: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    running = false;
  }
});

app.listen(PORT, () => {
  console.log(`Bot listening on :${PORT} -> ${TARGET_GROUP_ID ? `group ${TARGET_GROUP_ID.slice(-6)}` : 'sending off (TARGET_GROUP_ID not set)'}`);
  // Create both Drive folders right away, so they exist before the first message.
  Promise.all([folderId('note'), folderId('comment')])
    .then(() => tick())
    .catch((err) => console.error(`Drive setup failed: ${err.message}`));
});
