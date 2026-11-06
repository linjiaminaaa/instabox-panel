#!/usr/bin/env node
/**
 * InstaBox 机器监控面板 —— 本地后端
 * 零依赖：node:http + global fetch（Node >= 18，本项目按 Node 24 开发）
 *
 * 数据都在 ./data：
 *   machines.json   API key 与监控列表（仅本机）
 *   settings.json   面板口令、SMTP、通知开关、轮询间隔
 *   history.jsonl   状态/指标历史（默认保留 24h）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vlessHttpThroughProxy } from './lib/vless.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_BASE = (process.env.INSTABOX_API_BASE || 'https://api.instabox.sh').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 5174);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '1.2.0';
const HISTORY_MINUTES = 24 * 60;

const DEFAULT_SETTINGS = {
  passwordHash: null,
  passwordSalt: null,
  pollSec: 8,
  metricsSec: 8,
  notify: { onStateChange: true, onError: true, onKeepalive: true },
  smtp: { enabled: false, host: 'smtp.qq.com', port: 465, secure: true, user: '', pass: '', from: '', to: '' },
  proxy: { machineId: '', sshHost: 'instabox', port: 8080, path: '/ws' },
};

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------------------------- utils ---------------------------------- */

const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maskKey = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '');
const iso = (t = Date.now()) => new Date(t).toISOString();
const fmtBytes = (n) => {
  if (n == null || Number.isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/* ---------------------------------- state ---------------------------------- */

let settings = { ...DEFAULT_SETTINGS, ...readJSON(path.join(DATA_DIR, 'settings.json'), {}) };
settings.smtp = { ...DEFAULT_SETTINGS.smtp, ...(settings.smtp || {}) };
settings.notify = { ...DEFAULT_SETTINGS.notify, ...(settings.notify || {}) };
settings.proxy = { ...DEFAULT_SETTINGS.proxy, ...(settings.proxy || {}) };

const persisted = readJSON(path.join(DATA_DIR, 'machines.json'), { keys: [], machines: [] });
let keys = Array.isArray(persisted.keys) ? persisted.keys : [];
const machineList = Array.isArray(persisted.machines) ? persisted.machines : [];

/** runtime machines: persisted {id,keyId,addedAt,kl} + live api object + metrics + samples */
const machines = machineList.map((m) => ({
  id: m.id,
  keyId: m.keyId,
  addedAt: m.addedAt || now(),
  kl: { enabled: !!m.kl?.enabled, ttl: m.kl?.ttl || 900, leaseUntil: 0, lastError: null, lastRenewAt: 0 },
  api: null,
  metrics: null,
  samples: [],
  lastSeenAt: 0,
  lastNotifiedState: null,
}));

const keyById = (id) => keys.find((k) => k.id === id);
const keyOf = (machine) => keyById(machine.keyId);
const findMachine = (id) => machines.find((m) => m.id === id);

function persist() {
  writeJSON(path.join(DATA_DIR, 'machines.json'), {
    keys: keys.map((k) => ({ id: k.id, key: k.key, label: k.label || '', addedAt: k.addedAt })),
    machines: machines.map((m) => ({ id: m.id, keyId: m.keyId, addedAt: m.addedAt, kl: { enabled: m.kl.enabled, ttl: m.kl.ttl } })),
  });
}

/* ---------------------------------- auth ---------------------------------- */

const sessions = new Map(); // sid -> {exp, ip}
const loginAttempts = new Map(); // ip -> {count, resetAt}

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const got = Buffer.from(scryptHash(password, salt), 'hex');
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function setPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  settings.passwordSalt = salt;
  settings.passwordHash = scryptHash(password, salt);
  delete settings._firstRun;
  writeJSON(path.join(DATA_DIR, 'settings.json'), settings);
  try { fs.rmSync(path.join(DATA_DIR, 'FIRST_RUN_PASSWORD.txt'), { force: true }); } catch {}
}

function ensureInitialPassword() {
  const envPw = process.env.PANEL_PASSWORD;
  if (envPw && !settings.passwordHash) {
    setPassword(envPw);
    console.log(`[panel] 已使用环境变量 PANEL_PASSWORD 设置面板口令`);
    return;
  }
  if (settings.passwordHash) return;
  const pw = crypto.randomBytes(7).toString('base64url').slice(0, 10);
  setPassword(pw);
  const file = path.join(DATA_DIR, 'FIRST_RUN_PASSWORD.txt');
  fs.writeFileSync(file, [
    'InstaBox 监控面板 —— 初始登录口令',
    '',
    `口令: ${pw}`,
    '',
    '首次登录后用右上角「设置」修改口令，这个文件会被删除。',
    '也可以用环境变量 PANEL_PASSWORD 指定初始口令（仅在未设置过口令时生效）。',
  ].join('\r\n'));
  console.log('\n==============================================');
  console.log('  初始面板口令:  ' + pw);
  console.log('  （已写入 data/FIRST_RUN_PASSWORD.txt）');
  console.log('==============================================\n');
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function getSession(req) {
  const sid = parseCookies(req).panel_sid;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s || s.exp < now()) { sessions.delete(sid); return null; }
  return s;
}
function requireAuth(req, res) {
  if (getSession(req)) return true;
  sendJSON(res, 401, { error: '未登录' });
  return false;
}

/* ---------------------------------- SMTP ---------------------------------- */

class SmtpClient {
  constructor(cfg, timeoutMs = 20000) {
    this.cfg = cfg;
    this.timeoutMs = timeoutMs;
    this.buf = '';
    this.replyQueue = [];
    this.onReply = null;
  }

  _attach(sock) {
    this.sock = sock;
    sock.setTimeout(this.timeoutMs, () => { this._fail(new Error('SMTP 连接超时')); });
    sock.on('data', (d) => this._onData(d));
    sock.once('error', (e) => this._fail(e));
    sock.once('close', () => this._fail(new Error('SMTP 连接被关闭')));
  }
  _fail(err) {
    if (this.failed) return;
    this.failed = err;
    const cb = this.onReply;
    this.onReply = null;
    if (cb) cb({ error: err });
  }
  _onData(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\r\n')) !== -1) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      if (!this.replyLines) this.replyLines = [];
      this.replyLines.push(line);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (m && m[2] === ' ') {
        const reply = { code: Number(m[1]), text: this.replyLines.join('\n') };
        this.replyLines = null;
        const cb = this.onReply;
        if (cb) { this.onReply = null; cb(reply); } else this.replyQueue.push(reply);
      }
    }
  }
  waitReply() {
    return new Promise((resolve) => {
      if (this.failed) return resolve({ error: this.failed });
      if (this.replyQueue.length) return resolve(this.replyQueue.shift());
      this.onReply = resolve;
    });
  }
  async cmd(line) {
    if (this.failed) throw this.failed;
    this.sock.write(`${line}\r\n`);
    const r = await this.waitReply();
    if (r.error) throw r.error;
    return r;
  }
  expect(r, codes, what) {
    if (!codes.includes(r.code)) throw new Error(`SMTP ${what} 失败: ${r.code} ${String(r.text).split('\n').slice(-1)[0]}`);
    return r;
  }
  async connect() {
    const { host, port, secure } = this.cfg;
    await new Promise((resolve, reject) => {
      const sock = secure
        ? tls.connect({ host, port, servername: host }, resolve)
        : net.connect({ host, port }, resolve);
      sock.once('error', reject);
      this._attach(sock);
    });
    this.expect(await this.waitReply(), [220], '问候');
  }
  async starttls() {
    const upgraded = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: this.sock, servername: this.cfg.host }, () => resolve(s));
      s.once('error', reject);
    });
    this.sock = upgraded;
    this.buf = '';
    this._attach(upgraded);
  }
  async send({ from, to, subject, text }) {
    await this.connect();
    let ehlo = await this.cmd('EHLO instabox-panel');
    if (!this.cfg.secure && this.cfg.port === 587) {
      this.expect(await this.cmd('STARTTLS'), [220], 'STARTTLS');
      await this.starttls();
      ehlo = await this.cmd('EHLO instabox-panel');
    }
    // AUTH LOGIN
    this.expect(await this.cmd('AUTH LOGIN'), [334], 'AUTH');
    this.expect(await this.cmd(Buffer.from(this.cfg.user).toString('base64')), [334], '用户名');
    this.expect(await this.cmd(Buffer.from(this.cfg.pass).toString('base64')), [235, 503], '密码');
    this.expect(await this.cmd(`MAIL FROM:<${from}>`), [250], 'MAIL FROM');
    this.expect(await this.cmd(`RCPT TO:<${to}>`), [250, 251], 'RCPT TO');
    this.expect(await this.cmd('DATA'), [354], 'DATA');

    const b64 = Buffer.from(String(text || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject || '').toString('base64')}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@instabox-panel>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
    ].join('\r\n');
    this.expect(await this.cmd(`${headers}\r\n${b64}\r\n.`), [250], '发送正文');
    await this.cmd('QUIT').catch(() => {});
    try { this.sock.end(); } catch {}
  }
}

async function sendMail({ subject, text }) {
  const cfg = settings.smtp;
  if (!cfg?.enabled) return { ok: false, error: '邮件通知未启用' };
  if (!cfg.host || !cfg.user || !cfg.pass || !cfg.from || !cfg.to) {
    return { ok: false, error: 'SMTP 配置不完整' };
  }
  const client = new SmtpClient(cfg);
  try {
    await client.send({ from: cfg.from, to: cfg.to, subject, text });
    return { ok: true };
  } catch (e) {
    console.error('[mail] 发送失败:', e.message);
    return { ok: false, error: e.message };
  }
}

/* -------------------------------- InstaBox API ----------------------------- */

async function api(key, method, apiPath, body, extraHeaders = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${apiPath}`, {
      method,
      headers: {
        'X-API-Key': key,
        'Content-Type': 'application/json',
        'User-Agent': `instabox-panel/${VERSION}`,
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, ok: res.ok, json, text };
  } catch (e) {
    return { status: 0, ok: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

const machineListOf = (json) => {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  return json.machines || json.data || json.items || [];
};
const metricsOf = (json) => {
  if (!json) return null;
  const arr = Array.isArray(json.metrics) ? json.metrics : (Array.isArray(json) ? json : null);
  const latest = arr && arr.length ? arr[arr.length - 1] : (json.metrics && !Array.isArray(json.metrics) ? json.metrics : json);
  return { ...latest, disk: json.disk || null };
};

/* -------------------------------- polling --------------------------------- */

let pollInFlight = false;
let historyTimer = 0;

function stateOfMachine(m) { return m.api?.state || 'unknown'; }

function recordSample(m, force = false) {
  const t = now();
  const last = m.samples[m.samples.length - 1];
  if (!force && last && t - last.t < 60000) return;
  const met = m.metrics || {};
  m.samples.push({
    t,
    state: stateOfMachine(m),
    cpu: met.cpuUsedPct ?? null,
    memUsed: met.memUsed ?? null,
    memTotal: met.memTotal ?? null,
    diskUsed: met.diskUsed ?? null,
    diskTotal: met.diskTotal ?? null,
    netIn: met.netInBytesPerSec ?? null,
    netOut: met.netOutBytesPerSec ?? null,
  });
  if (m.samples.length > 2000) m.samples.splice(0, m.samples.length - 2000);
  appendHistory(m);
}

function appendHistory(m) {
  const s = m.samples[m.samples.length - 1];
  if (!s) return;
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'history.jsonl'), `${JSON.stringify({ id: m.id, ...s })}\n`);
  } catch {}
}

function pruneHistoryFile() {
  const file = path.join(DATA_DIR, 'history.jsonl');
  if (!fs.existsSync(file)) return;
  const cutoff = now() - HISTORY_MINUTES * 60000;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const keep = lines.filter((line) => {
    try { return JSON.parse(line).t >= cutoff; } catch { return false; }
  });
  fs.writeFileSync(file, keep.length ? `${keep.join('\n')}\n` : '');
}

function loadHistory() {
  const file = path.join(DATA_DIR, 'history.jsonl');
  if (!fs.existsSync(file)) return;
  const cutoff = now() - HISTORY_MINUTES * 60000;
  const byId = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const s = JSON.parse(line);
      if (s.t < cutoff) continue;
      if (!byId.has(s.id)) byId.set(s.id, []);
      byId.get(s.id).push(s);
    } catch {}
  }
  for (const m of machines) {
    if (byId.has(m.id)) m.samples = byId.get(m.id).slice(-2000);
  }
}

function applyApiMachine(m, raw) {
  const prev = stateOfMachine(m);
  m.api = { ...(m.api || {}), ...raw };
  m.lastSeenAt = now();
  const next = raw.state;
  if (prev !== 'unknown' && next && prev !== next) {
    recordSample(m, true);
    notifyStateChange(m, prev, next);
  } else if (prev === 'unknown') {
    m.lastNotifiedState = next;
  }
  if (raw.state === 'error' && raw.lastError) {
    // error 也不重复轰炸：只在状态切入 error 时通知，上面已处理
  }
}

async function pollMachines() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    for (const k of keys) {
      const r = await api(k.key, 'GET', '/v1/machines');
      if (r.status === 401) {
        k.lastError = 'API key 无效或已吊销';
        k.lastOkAt = 0;
        continue;
      }
      if (!r.ok) {
        k.lastError = r.error || `HTTP ${r.status}`;
        continue;
      }
      k.lastError = null;
      k.lastOkAt = now();
      const seen = new Set();
      for (const raw of machineListOf(r.json)) {
        if (!raw?.id) continue;
        seen.add(raw.id);
        const m = findMachine(raw.id);
        if (m) applyApiMachine(m, raw);
      }
    }
    // metrics for running machines
    const runnings = machines.filter((m) => m.api?.state === 'running' && keyOf(m));
    await Promise.all(runnings.slice(0, 30).map(async (m) => {
      const r = await api(keyOf(m).key, 'GET', `/v1/machines/${m.id}/metrics`);
      if (r.ok) m.metrics = metricsOf(r.json);
    }));
    const t = now();
    if (t - historyTimer > 30000) { historyTimer = t; machines.forEach((m) => recordSample(m)); }
  } finally {
    pollInFlight = false;
  }
}

/* ------------------------------ notifications ------------------------------ */

const mailQueue = [];
let mailBusy = false;

function enqueueMail(subject, text) {
  if (!settings.smtp.enabled) return;
  mailQueue.push({ subject, text, at: now() });
  if (mailQueue.length > 50) mailQueue.splice(0, mailQueue.length - 50);
  pumpMail();
}
async function pumpMail() {
  if (mailBusy) return;
  if (!settings.smtp.enabled) { mailQueue.length = 0; return; }
  mailBusy = true;
  while (mailQueue.length) {
    const item = mailQueue.shift();
    const r = await sendMail({ subject: item.subject, text: item.text });
    if (!r.ok) console.warn('[mail]', r.error);
  }
  mailBusy = false;
}

function notifyStateChange(m, from, to) {
  if (!settings.notify.onStateChange) return;
  if (from === to) return;
  const name = m.api?.name || m.id;
  const bad = ['suspended', 'stopped', 'error'];
  const recovering = bad.includes(from) && to === 'running';
  if (!bad.includes(to) && !recovering) return;
  if (to === 'error' && !settings.notify.onError) return;
  const lines = [
    `机器: ${name}`,
    `ID: ${m.id}`,
    `状态: ${from} → ${to}`,
    `时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
  ];
  if (m.api?.cooldownUntil) lines.push(`冷却至: ${m.api.cooldownUntil}`);
  if (m.api?.lastError) lines.push(`错误: ${m.api.lastError}`);
  if (m.metrics?.memTotal) lines.push(`内存: ${fmtBytes(m.metrics.memUsed)} / ${fmtBytes(m.metrics.memTotal)}`);
  if (m.api?.spec) lines.push(`规格: ${m.api.spec.vcpus} vCPU / ${fmtBytes((m.api.spec.memMiB || 0) * 1024 * 1024)}`);
  enqueueMail(`[InstaBox] ${name}: ${from} → ${to}`, lines.join('\n'));
  m.lastNotifiedState = to;
}

function notifyKeepaliveProblem(m, reason) {
  if (!settings.notify.onKeepalive) return;
  const name = m.api?.name || m.id;
  enqueueMail(`[InstaBox] 保活异常: ${name}`, [
    `机器: ${name}`,
    `ID: ${m.id}`,
    `问题: ${reason}`,
    `时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
  ].join('\n'));
}

/* -------------------------------- keepalive ------------------------------- */

const LEASE_TTL_SEC = 900;

/** 提交生命周期操作；operation_conflict（已有操作在跑）时等 3s 重试一次 */
async function lifecyclePost(key, m, action, { timeoutMs = 15000, retries = 1 } = {}) {
  const body = action === 'stop' ? { timeoutSeconds: 60 } : undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const r = await api(key, 'POST', `/v1/machines/${m.id}/${action}`, body, { 'Idempotency-Key': crypto.randomUUID() }, timeoutMs);
    if (r.status === 409 && r.json?.error?.code === 'operation_conflict' && attempt < retries) {
      await sleep(3000);
      continue;
    }
    return r;
  }
}

/**
 * 按暂停类型选择唤醒方式：
 * - 空闲自动暂停（autoSuspendedAt 有值）→ wake（平台文档：自暂停用 wake，等待 ≤45s）
 * - 手动暂停 → resume；停止 / error → start
 */
async function ensureRunning(m) {
  const key = keyOf(m)?.key;
  if (!key) return false;
  const st = stateOfMachine(m);
  if (st === 'running') return true;
  let action = null;
  if (st === 'stopped' || st === 'error') action = 'start';
  else if (st === 'suspended') action = m.api?.autoSuspendedAt ? 'wake' : 'resume';
  if (!action) return false;

  const r = await lifecyclePost(key, m, action, { timeoutMs: action === 'wake' ? 70000 : 20000, retries: 1 });
  if (!r.ok && r.status !== 202) return false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1500);
    const g = await api(key, 'GET', `/v1/machines/${m.id}`);
    if (g.ok) applyApiMachine(m, g.json);
    const s = stateOfMachine(m);
    if (s === 'running') return true;
    if (s === 'error') return false;
  }
  return false;
}

let keepaliveInFlight = false;
async function keepaliveTick() {
  if (keepaliveInFlight) return;
  keepaliveInFlight = true;
  try {
    for (const m of machines.filter((x) => x.kl.enabled && keyOf(x))) {
      const key = keyOf(m).key;
      const ttl = m.kl.ttl || LEASE_TTL_SEC;
      if (m.kl.leaseUntil - now() > ttl * 500) continue;
      const cooldown = m.api?.cooldownUntil ? Date.parse(m.api.cooldownUntil) : 0;
      if (cooldown > now()) {
        m.kl.lastError = `平台冷却中，${Math.ceil((cooldown - now()) / 60000)} 分钟后重试`;
        continue;
      }
      if (stateOfMachine(m) !== 'running') {
        if (stateOfMachine(m) === 'suspended' || stateOfMachine(m) === 'stopped') {
          if (await ensureRunning(m)) {
            // 继续走到续租
          } else {
            m.kl.lastError = '机器未运行，自动唤醒失败';
            notifyKeepaliveProblem(m, '机器未运行，自动唤醒失败');
            continue;
          }
        } else {
          continue;
        }
      }
      const r = await api(key, 'PUT', `/v1/machines/${m.id}/activity-leases/panel-keepalive`, { ttlSeconds: ttl });
      if (r.ok) {
        m.kl.leaseUntil = now() + ttl * 1000;
        m.kl.lastRenewAt = now();
        m.kl.lastError = null;
      } else if (r.status === 409) {
        const code = r.json?.error?.code;
        if (code === 'machine_cooldown') {
          const ra = r.json?.error?.retryAfterSeconds || 300;
          m.kl.lastError = `平台冷却中，约 ${Math.ceil(ra / 60)} 分钟后重试`;
        } else if (code === 'machine_not_running') {
          if (await ensureRunning(m)) {
            const rr = await api(key, 'PUT', `/v1/machines/${m.id}/activity-leases/panel-keepalive`, { ttlSeconds: ttl });
            if (rr.ok) { m.kl.leaseUntil = now() + ttl * 1000; m.kl.lastRenewAt = now(); m.kl.lastError = null; }
            else m.kl.lastError = `续租失败: ${rr.json?.error?.message || rr.status}`;
          } else {
            m.kl.lastError = '机器未运行，自动唤醒失败';
            notifyKeepaliveProblem(m, '机器未运行，自动唤醒失败');
          }
        } else {
          m.kl.lastError = r.json?.error?.message || '续租冲突';
        }
      } else {
        m.kl.lastError = `续租失败 HTTP ${r.status}`;
      }
    }
  } finally {
    keepaliveInFlight = false;
  }
}

async function releaseLease(m) {
  if (!m.kl.enabled) return;
  const key = keyOf(m)?.key;
  m.kl.enabled = false;
  m.kl.leaseUntil = 0;
  if (key) await api(key, 'DELETE', `/v1/machines/${m.id}/activity-leases/panel-keepalive`);
  persist();
}

/* -------------------------------- lifecycle ------------------------------- */

const TARGET_STATE = { start: 'running', resume: 'running', wake: 'running', suspend: 'suspended', stop: 'stopped' };

async function runAction(id, action) {
  const m = findMachine(id);
  if (!m) return { ok: false, error: '机器不在监控列表中' };
  const key = keyOf(m)?.key;
  if (!key) return { ok: false, error: '找不到对应的 API key' };
  if (!TARGET_STATE[action]) return { ok: false, error: `未知操作 ${action}` };

  // 自暂停用 wake，手动暂停用 resume；前端传错时这里兜底纠正
  const st0 = stateOfMachine(m);
  let eff = action;
  if (action === 'resume' && m.api?.autoSuspendedAt) eff = 'wake';
  if (action === 'wake' && !m.api?.autoSuspendedAt && st0 === 'suspended') eff = 'resume';

  const r = await lifecyclePost(key, m, eff, { timeoutMs: eff === 'wake' ? 70000 : 20000, retries: 1 });
  if (r.status === 202) {
    const target = TARGET_STATE[eff] || 'running';
    const deadline = now() + (eff === 'wake' ? 130000 : eff === 'stop' ? 90000 : 75000);
    while (now() < deadline) {
      await sleep(1500);
      const g = await api(key, 'GET', `/v1/machines/${id}`);
      if (g.ok) applyApiMachine(m, g.json);
      const st = stateOfMachine(m);
      if (st === target) return { ok: true, state: st };
      if (st === 'error') return { ok: false, error: m.api?.lastError || '操作失败（error）' };
    }
    return { ok: false, error: '操作超时，请刷新查看最新状态' };
  }
  if (r.status === 409) {
    const err = r.json?.error || {};
    return { ok: false, error: err.message || '409 冲突', code: err.code, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (r.status === 401) return { ok: false, error: 'API key 无效或已吊销', code: 'invalid_key' };
  return { ok: false, error: r.json?.error?.message || r.error || `HTTP ${r.status}` };
}

/* -------------------------------- HTTP utils ------------------------------ */

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* --------------------------------- proxy --------------------------------- */

const PROXY_DEFAULT = { machineId: '', sshHost: 'instabox', port: 8080, path: '/ws' };
const proxySettings = () => ({ ...PROXY_DEFAULT, ...(settings.proxy || {}) });
const proxyMachine = () => findMachine(proxySettings().machineId);

function proxyHost(m = proxyMachine()) {
  if (!m) return null;
  return `${proxySettings().port}-${String(m.id).replace(/^m_/, '')}.instabox.tech`;
}
function proxyUrl(m = proxyMachine()) {
  const host = proxyHost(m);
  return host ? `https://${host}/` : null;
}
function proxyVless(uuid, m = proxyMachine()) {
  const host = proxyHost(m);
  if (!host || !uuid) return null;
  const q = new URLSearchParams({
    encryption: 'none', security: 'tls', sni: host, fp: 'chrome', type: 'ws', host, path: proxySettings().path,
  });
  return `vless://${uuid}@${host}:443?${q.toString()}#instabox`;
}

let mockXrayActive = false;
function mockSsh(cmd) {
  if (cmd.includes('/tmp/ibt-rotate.py')) return { code: 0, stdout: 'ROTATED 1 /root/xray-config.bak.mock\n', stderr: '' };
  if (cmd.includes('systemctl start xray')) { mockXrayActive = true; return { code: 0, stdout: '', stderr: '' }; }
  if (cmd.includes('systemctl stop xray')) { mockXrayActive = false; return { code: 0, stdout: '', stderr: '' }; }
  if (cmd.includes('systemctl is-active')) {
    const out = mockXrayActive ? 'active' : 'inactive';
    const extra = cmd.includes('config.json') ? '\n---\n        "id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"\n' : '';
    return { code: mockXrayActive ? 0 : 3, stdout: `${out}${extra}`, stderr: '' };
  }
  if (cmd.includes('config.json')) return { code: 0, stdout: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
}

/** 只跑固定命令，不拼用户输入；测试时设 PROXY_SSH_MODE=mock */
function runSsh(host, remoteCmd, timeoutMs = 60000) {
  if (process.env.PROXY_SSH_MODE === 'mock') return Promise.resolve(mockSsh(remoteCmd));
  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=60', '-o', 'StrictHostKeyChecking=accept-new', host, remoteCmd],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
}

let proxyCache = { at: 0, value: null };

async function proxyStatus(force = false) {
  const p = proxySettings();
  const m = proxyMachine();
  const base = {
    configured: !!m,
    machineId: p.machineId || '',
    sshHost: p.sshHost,
    port: p.port,
    path: p.path,
    url: m ? proxyUrl(m) : null,
    uuid: null,
    vless: null,
    state: m ? 'unknown' : 'unconfigured',
    error: null,
    machine: m ? { id: m.id, name: sanitizedMachine(m).name, state: stateOfMachine(m) } : null,
  };
  if (!m) return base;
  if (!force && proxyCache.value && now() - proxyCache.at < 5000) return proxyCache.value;

  // 机器已暂停/停止时不做 SSH 探测，避免每隔 15 秒把机器唤醒
  const mstate = stateOfMachine(m);
  if (mstate !== 'running' && mstate !== 'unknown') {
    const value = { ...base, state: 'paused' };
    proxyCache = { at: now(), value };
    return value;
  }

  const r = await runSsh(
    p.sshHost,
    `systemctl is-active xray 2>/dev/null || true; echo '---'; sudo grep -oE '"id"[[:space:]]*:[[:space:]]*"[0-9a-f-]{36}"' /usr/local/etc/xray/config.json 2>/dev/null | head -1 || true`,
    45000,
  );
  const active = (r.stdout.split(/\r?\n/)[0] || '').trim();
  const uuid = (r.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0] || null;
  let state = 'unknown';
  if (active === 'active') state = 'running';
  else if (['inactive', 'failed', 'activating', 'deactivating'].includes(active)) state = 'stopped';
  else if (r.code === 255 || /connection|timed out|permission denied|could not resolve|no route|host key/i.test(`${r.stderr}\n${r.stdout}`)) state = 'unreachable';

  const value = { ...base, state, uuid, vless: proxyVless(uuid, m) };
  if (state !== 'unreachable') proxyCache = { at: now(), value };
  return value;
}

async function proxyStart() {
  const p = proxySettings();
  const m = proxyMachine();
  if (!m) return { ok: false, error: '先在设置里选择代理机器' };
  if (stateOfMachine(m) !== 'running' && keyOf(m)) {
    const woke = await ensureRunning(m);
    if (!woke) return { ok: false, error: `机器当前 ${stateOfMachine(m)}，无法启动代理` };
  }
  const r = await runSsh(p.sshHost, `sudo systemctl start xray && instabox-port publish ${Number(p.port)} --public`, 120000);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || `ssh 执行失败 (${r.code})`).trim().slice(0, 300) };
  proxyCache = { at: 0, value: null };
  await sleep(300);
  return { ok: true, status: await proxyStatus(true) };
}

async function proxyStop() {
  const p = proxySettings();
  if (!proxyMachine()) return { ok: false, error: '先在设置里选择代理机器' };
  const r = await runSsh(p.sshHost, 'sudo systemctl stop xray', 60000);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || `ssh 执行失败 (${r.code})`).trim().slice(0, 300) };
  proxyCache = { at: 0, value: null };
  await sleep(300);
  return { ok: true, status: await proxyStatus(true) };
}

/** 一键轮换 Xray 的 client UUID：备份 → 改写配置 → 原本在运行就重启 → 返回新状态 */
const ROTATE_SCRIPT = `import json, shutil, sys, time, uuid
p = "/usr/local/etc/xray/config.json"
bak = "/root/xray-config.bak." + str(int(time.time()))
shutil.copy2(p, bak)
with open(p, "r", encoding="utf-8") as f:
    conf = json.load(f)
count = 0
for inbound in conf.get("inbounds", []):
    for client in inbound.get("settings", {}).get("clients", []):
        client["id"] = str(uuid.uuid4())
        count += 1
if count == 0:
    print("NO_CLIENTS")
    sys.exit(1)
with open(p, "w", encoding="utf-8") as f:
    json.dump(conf, f, ensure_ascii=False, indent=2)
print("ROTATED", count, bak)`;

async function proxyRotateUuid() {
  const p = proxySettings();
  if (!proxyMachine()) return { ok: false, error: '先在设置里选择代理机器' };
  const b64 = Buffer.from(ROTATE_SCRIPT, 'utf8').toString('base64');
  const remote = `was=$(systemctl is-active xray 2>/dev/null || true); printf '%s' '${b64}' | base64 -d > /tmp/ibt-rotate.py && sudo python3 /tmp/ibt-rotate.py && rm -f /tmp/ibt-rotate.py && case "$was" in active) sudo systemctl restart xray ;; esac; systemctl is-active xray 2>/dev/null || true`;
  const r = await runSsh(p.sshHost, remote, 120000);
  if (!/ROTATED/.test(r.stdout)) {
    return { ok: false, error: (r.stderr || r.stdout || '换 UUID 失败').trim().slice(0, 300) };
  }
  proxyCache = { at: 0, value: null };
  await sleep(400);
  return { ok: true, status: await proxyStatus(true) };
}

/* ------------------------------- 测速 / 配置 ------------------------------ */
let speedtestBusy = false;

function proxyWsUrl() {
  const p = proxySettings();
  const host = proxyHost();
  if (!host) return null;
  const wsPath = String(p.path || '/ws').startsWith('/') ? p.path : `/${p.path}`;
  return `wss://${host}${wsPath}`;
}

function proxyYaml(st) {
  const host = proxyHost();
  const p = proxySettings();
  const wsPath = String(p.path || '/ws').startsWith('/') ? p.path : `/${p.path}`;
  return `# InstaBox 代理配置（面板生成，${new Date().toISOString()}）
# 用法：FlClash → 配置 → 添加 → 从文件导入本 YAML
mixed-port: 7890
allow-lan: true
bind-address: "*"
mode: rule
log-level: info
ipv6: false
unified-delay: true
tcp-concurrent: true

dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - https://223.5.5.5/dns-query
    - https://1.1.1.1/dns-query
  proxy-server-nameserver:
    - https://223.5.5.5/dns-query

proxies:
  - name: instabox
    type: vless
    server: ${host}
    port: 443
    uuid: ${st.uuid}
    tls: true
    servername: ${host}
    client-fingerprint: chrome
    network: ws
    ws-opts:
      path: ${wsPath}
      headers:
        Host: ${host}
    udp: true
    skip-cert-verify: false

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - instabox

rules:
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
`;
}

async function speedtest() {
  if (speedtestBusy) return { ok: false, error: '测速进行中，稍等几秒' };
  const m = proxyMachine();
  if (!m) return { ok: false, error: '先在设置里选择代理机器' };

  if (process.env.PROXY_SSH_MODE === 'mock') {
    await sleep(200);
    return {
      ok: true, mock: true, at: new Date().toISOString(),
      edgeMs: 12, edgeSamples: [12, 13, 15],
      latency: { min: 18, avg: 21, samples: [18, 21, 24] },
      download: { mbps: 88.8, bytes: 5_000_000, ms: 450, limited: false },
      url: proxyUrl(m),
    };
  }

  speedtestBusy = true;
  try {
    const st = await proxyStatus(true);
    if (st.state !== 'running') return { ok: false, error: `代理未运行（${st.state}），先点启动` };
    const host = proxyHost();
    const wsUrl = proxyWsUrl();

    const edgeSamples = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      try { await fetch(`https://${host}/`, { signal: AbortSignal.timeout(8000) }); } catch {}
      edgeSamples.push(performance.now() - t);
    }
    const edgeMs = Math.round(Math.min(...edgeSamples));

    const latSamples = [];
    for (let i = 0; i < 3; i++) {
      const r = await vlessHttpThroughProxy({
        wsUrl, uuid: st.uuid, targetHost: 'www.gstatic.com', targetPort: 80,
        requestPath: '/generate_204', timeoutMs: 8000,
      });
      latSamples.push(r.ttfbMs ?? r.elapsedMs);
    }

    let dl;
    const CONNS = 4;
    const PER = 1_250_000; // 4 个连接合计最多 5 MB
    const t0 = performance.now();
    const parts = await Promise.all(Array.from({ length: CONNS }, () => vlessHttpThroughProxy({
      wsUrl, uuid: st.uuid, targetHost: 'speed.cloudflare.com', targetPort: 80,
      requestPath: `/__down?bytes=${PER}`, maxBytes: PER, timeoutMs: 15000, resolveOnTimeout: true,
    }).catch(() => null)));
    const bytes = parts.reduce((a, r) => a + (r ? r.bodyBytes : 0), 0);
    const elapsedMs = Math.max(1, performance.now() - t0);
    if (!bytes) return { ok: false, error: '下载测速失败：4 个连接都没拿到数据' };
    dl = { bodyBytes: bytes, elapsedMs, limited: parts.some((r) => !r || r.timedOut || r.bodyBytes >= PER) };

    return {
      ok: true,
      at: new Date().toISOString(),
      url: st.url,
      edgeMs,
      edgeSamples: edgeSamples.map((v) => Math.round(v)),
      latency: {
        min: Math.round(Math.min(...latSamples)),
        avg: Math.round(latSamples.reduce((a, b) => a + b, 0) / latSamples.length),
        samples: latSamples.map((v) => Math.round(v)),
      },
      download: {
        mbps: Math.round(((dl.bodyBytes * 8 / 1e6) / (elapsedMs / 1000)) * 100) / 100,
        bytes: dl.bodyBytes,
        ms: Math.round(elapsedMs),
        connections: CONNS,
        limited: !!dl.limited,
      },
    };
  } finally {
    speedtestBusy = false;
  }
}

/* --------------------------------- settings ------------------------------- */

function settingsPublic() {
  return {
    pollSec: settings.pollSec,
    notify: settings.notify,
    smtp: {
      enabled: settings.smtp.enabled,
      host: settings.smtp.host,
      port: settings.smtp.port,
      secure: settings.smtp.secure,
      user: settings.smtp.user,
      from: settings.smtp.from,
      to: settings.smtp.to,
      hasPassword: !!settings.smtp.pass,
    },
    proxy: {
      machineId: settings.proxy.machineId || '',
      sshHost: settings.proxy.sshHost || 'instabox',
      port: settings.proxy.port || 8080,
      path: settings.proxy.path || '/ws',
    },
  };
}

function saveSettings() {
  writeJSON(path.join(DATA_DIR, 'settings.json'), settings);
}

/* ------------------------------- API routes ------------------------------- */

function sanitizedMachine(m) {
  const a = m.api || {};
  const met = m.metrics || {};
  return {
    id: m.id,
    keyId: m.keyId,
    addedAt: m.addedAt,
    name: a.name || m.id,
    state: a.state || 'unknown',
    desiredState: a.desiredState,
    spec: a.spec || null,
    runtime: a.runtime,
    runStartedAt: a.runStartedAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    autoSuspendAfterSeconds: a.autoSuspendAfterSeconds,
    autoSuspendedAt: a.autoSuspendedAt,
    maxRunMinutes: a.maxRunMinutes,
    cooldownUntil: a.cooldownUntil,
    lastError: a.lastError,
    free: a.free,
    storage: a.storage,
    operationId: a.operationId,
    metadata: a.metadata,
    lastSeenAt: m.lastSeenAt,
    metrics: {
      cpuUsedPct: met.cpuUsedPct ?? null,
      cpuCount: met.cpuCount ?? null,
      memUsed: met.memUsed ?? null,
      memTotal: met.memTotal ?? null,
      diskUsed: met.diskUsed ?? null,
      diskTotal: met.diskTotal ?? null,
      netInBytesPerSec: met.netInBytesPerSec ?? null,
      netOutBytesPerSec: met.netOutBytesPerSec ?? null,
      timestamp: met.timestamp ?? null,
    },
    keepalive: {
      enabled: m.kl.enabled,
      ttl: m.kl.ttl,
      leaseUntil: m.kl.enabled && m.kl.leaseUntil > now() ? m.kl.leaseUntil : 0,
      lastRenewAt: m.kl.lastRenewAt || 0,
      lastError: m.kl.lastError || null,
    },
  };
}

function publicState() {
  return {
    serverTime: now(),
    version: VERSION,
    apiBase: API_BASE,
    machines: machines.map(sanitizedMachine),
    keys: keys.map((k) => ({ id: k.id, label: k.label || '', masked: maskKey(k.key), addedAt: k.addedAt, lastOkAt: k.lastOkAt, lastError: k.lastError || null })),
    settings: settingsPublic(),
    firstRun: !settings.passwordHash,
  };
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const rec = loginAttempts.get(ip);
    if (rec && rec.count >= 8 && now() < rec.resetAt) return sendJSON(res, 429, { error: '尝试次数过多，请 1 分钟后再试' });
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: '请求格式错误' }); }
    if (!body.password || !verifyPassword(String(body.password), settings.passwordHash, settings.passwordSalt)) {
      const r = rec && now() < rec.resetAt ? rec : { count: 0, resetAt: now() + 60000 };
      r.count += 1;
      loginAttempts.set(ip, r);
      return sendJSON(res, 401, { error: '口令不正确' });
    }
    loginAttempts.delete(ip);
    const sid = crypto.randomBytes(24).toString('base64url');
    sessions.set(sid, { exp: now() + 7 * 86400000, ip });
    res.setHeader('Set-Cookie', `panel_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    const sid = parseCookies(req).panel_sid;
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'panel_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return sendJSON(res, 200, { ok: true });
  }

  if (!requireAuth(req, res)) return;

  if (p === '/api/state' && req.method === 'GET') return sendJSON(res, 200, publicState());

  if (p === '/api/proxy' && req.method === 'GET') {
    const force = url.searchParams.get('force') === '1';
    return sendJSON(res, 200, await proxyStatus(force));
  }

  if (p === '/api/proxy/start' && req.method === 'POST') {
    const r = await proxyStart();
    return sendJSON(res, r.ok ? 200 : 502, r);
  }

  if (p === '/api/proxy/stop' && req.method === 'POST') {
    const r = await proxyStop();
    return sendJSON(res, r.ok ? 200 : 502, r);
  }

  if (p === '/api/proxy/rotate-uuid' && req.method === 'POST') {
    const r = await proxyRotateUuid();
    return sendJSON(res, r.ok ? 200 : 502, r);
  }

  if (p === '/api/speedtest' && req.method === 'POST') {
    const r = await speedtest();
    return sendJSON(res, r.ok ? 200 : 502, r);
  }

  if (p === '/api/proxy/config' && req.method === 'GET') {
    const st = await proxyStatus();
    if (!st.uuid) return sendJSON(res, 409, { ok: false, error: `代理未运行或读不到 UUID（${st.state}）` });
    res.writeHead(200, {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="instabox.yaml"',
      'Cache-Control': 'no-store',
    });
    return res.end(proxyYaml(st));
  }

  if (p === '/api/keys' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: '请求格式错误' }); }
    const raw = String(body.key || '').trim();
    if (!/^ibk_/.test(raw)) {
      return sendJSON(res, 400, { error: '目前只支持 ibk_ 开头的 InstaBox API key（ibssh_ 只能 SSH 只读，暂未实现）' });
    }
    if (keys.some((k) => k.key === raw)) return sendJSON(res, 409, { error: '这把 key 已经添加过了' });
    const r = await api(raw, 'GET', '/v1/machines');
    if (!r.ok) {
      const msg = r.status === 401 ? 'key 无效或已吊销（401）' : (r.json?.error?.message || r.error || `HTTP ${r.status}`);
      return sendJSON(res, 400, { error: `校验失败：${msg}` });
    }
    const id = crypto.randomUUID();
    keys.push({ id, key: raw, label: String(body.label || '').slice(0, 60), addedAt: now(), lastOkAt: now(), lastError: null });
    const added = [];
    for (const rawM of machineListOf(r.json)) {
      if (!rawM?.id) continue;
      if (findMachine(rawM.id)) continue;
      const m = {
        id: rawM.id, keyId: id, addedAt: now(),
        kl: { enabled: false, ttl: LEASE_TTL_SEC, leaseUntil: 0, lastError: null, lastRenewAt: 0 },
        api: null, metrics: null, samples: [], lastSeenAt: 0, lastNotifiedState: null,
      };
      applyApiMachine(m, rawM);
      machines.push(m);
      added.push({ id: rawM.id, name: rawM.name });
    }
    persist();
    return sendJSON(res, 200, { ok: true, keyId: id, added, total: machineListOf(r.json).length });
  }

  const delKey = p.match(/^\/api\/keys\/([^/]+)$/);
  if (delKey && req.method === 'DELETE') {
    const kid = decodeURIComponent(delKey[1]);
    const k = keyById(kid);
    if (!k) return sendJSON(res, 404, { error: 'key 不存在' });
    for (const m of machines.filter((x) => x.keyId === kid)) {
      if (m.kl.enabled) await releaseLease(m);
    }
    keys = keys.filter((x) => x.id !== kid);
    machines.splice(0, machines.length, ...machines.filter((m) => m.keyId !== kid));
    persist();
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/machines' && req.method === 'GET') {
    return sendJSON(res, 200, { machines: machines.map(sanitizedMachine) });
  }

  const machineMatch = p.match(/^\/api\/machines\/([^/]+)(?:\/(action|metrics|keepalive|history))?$/);
  if (machineMatch) {
    const id = decodeURIComponent(machineMatch[1]);
    const sub = machineMatch[2];
    const m = findMachine(id);
    if (!m) return sendJSON(res, 404, { error: '机器不在监控列表中' });

    if (!sub && req.method === 'DELETE') {
      if (m.kl.enabled) await releaseLease(m);
      machines.splice(0, machines.length, ...machines.filter((x) => x.id !== id));
      if (!machines.some((x) => x.keyId === m.keyId)) {
        keys = keys.filter((k) => k.id !== m.keyId);
      }
      persist();
      return sendJSON(res, 200, { ok: true });
    }

    if (sub === 'action' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: '请求格式错误' }); }
      const result = await runAction(id, String(body.action || ''));
      return sendJSON(res, 200, result);
    }

    if (sub === 'metrics' && req.method === 'GET') {
      const k = keyOf(m);
      const r = await api(k.key, 'GET', `/v1/machines/${id}/metrics`);
      if (!r.ok) return sendJSON(res, 502, { error: r.json?.error?.message || `HTTP ${r.status}` });
      m.metrics = metricsOf(r.json);
      return sendJSON(res, 200, { ok: true, metrics: sanitizedMachine(m).metrics });
    }

    if (sub === 'keepalive' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: '请求格式错误' }); }
      const enabled = !!body.enabled;
      if (enabled) {
        const k = keyOf(m);
        if (m.api?.cooldownUntil && Date.parse(m.api.cooldownUntil) > now()) {
          return sendJSON(res, 409, { error: `平台冷却中，无法立刻保活，冷却至 ${m.api.cooldownUntil}` });
        }
        if (stateOfMachine(m) !== 'running') {
          const woke = await ensureRunning(m);
          if (!woke) return sendJSON(res, 409, { error: `机器当前为 ${stateOfMachine(m)}，自动唤醒失败，请先手动启动/恢复` });
        }
        m.kl.enabled = true;
        m.kl.ttl = Math.min(3600, Math.max(30, Number(body.ttl) || LEASE_TTL_SEC));
        const r = await api(k.key, 'PUT', `/v1/machines/${id}/activity-leases/panel-keepalive`, { ttlSeconds: m.kl.ttl });
        if (!r.ok) {
          m.kl.enabled = false;
          return sendJSON(res, 409, { error: r.json?.error?.message || `续租失败 HTTP ${r.status}` });
        }
        m.kl.leaseUntil = now() + m.kl.ttl * 1000;
        m.kl.lastRenewAt = now();
        m.kl.lastError = null;
      } else {
        await releaseLease(m);
      }
      persist();
      return sendJSON(res, 200, { ok: true, keepalive: sanitizedMachine(m).keepalive });
    }

    if (sub === 'history' && req.method === 'GET') {
      const minutes = Math.min(1440, Math.max(10, Number(url.searchParams.get('minutes')) || 1440));
      const cutoff = now() - minutes * 60000;
      const samples = m.samples.filter((s) => s.t >= cutoff);
      return sendJSON(res, 200, { ok: true, samples });
    }
  }

  if (p === '/api/settings' && req.method === 'GET') return sendJSON(res, 200, settingsPublic());

  if (p === '/api/settings' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: '请求格式错误' }); }
    if (body.pollSec !== undefined) settings.pollSec = Math.min(60, Math.max(2, Number(body.pollSec) || 8));
    if (body.metricsSec !== undefined) settings.metricsSec = Math.min(60, Math.max(2, Number(body.metricsSec) || 8));
    if (body.notify && typeof body.notify === 'object') {
      settings.notify = {
        onStateChange: !!body.notify.onStateChange,
        onError: !!body.notify.onError,
        onKeepalive: !!body.notify.onKeepalive,
      };
    }
    if (body.smtp && typeof body.smtp === 'object') {
      const s = body.smtp;
      settings.smtp = {
        ...settings.smtp,
        enabled: !!s.enabled,
        host: String(s.host ?? settings.smtp.host).trim().slice(0, 200),
        port: Math.min(65535, Math.max(1, Number(s.port) || settings.smtp.port)),
        secure: !!s.secure,
        user: String(s.user ?? settings.smtp.user).trim().slice(0, 200),
        from: String(s.from ?? settings.smtp.from).trim().slice(0, 200),
        to: String(s.to ?? settings.smtp.to).trim().slice(0, 500),
      };
      if (s.pass) settings.smtp.pass = String(s.pass);
    }
    if (body.proxy && typeof body.proxy === 'object') {
      const pr = body.proxy;
      const mid = String(pr.machineId || '').trim();
      const sshHost = String(pr.sshHost || 'instabox').trim().slice(0, 100);
      settings.proxy = {
        machineId: mid && findMachine(mid) ? mid : '',
        sshHost: /^[A-Za-z0-9._@:-]+$/.test(sshHost) ? sshHost : 'instabox',
        port: Math.min(65535, Math.max(1, Number(pr.port) || 8080)),
        path: String(pr.path || '/ws').trim().slice(0, 200) || '/ws',
      };
      proxyCache = { at: 0, value: null };
    }
    saveSettings();
    return sendJSON(res, 200, { ok: true, settings: settingsPublic() });
  }

  if (p === '/api/settings/password' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: '请求格式错误' }); }
    if (!verifyPassword(String(body.current || ''), settings.passwordHash, settings.passwordSalt)) {
      return sendJSON(res, 400, { error: '当前口令不正确' });
    }
    if (!body.next || String(body.next).length < 4) return sendJSON(res, 400, { error: '新口令至少 4 位' });
    setPassword(String(body.next));
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/smtp/test' && req.method === 'POST') {
    const r = await sendMail({
      subject: '[InstaBox] 测试邮件',
      text: `这是一封来自 InstaBox 监控面板的测试邮件。\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n如果你收到它，SMTP 配置是正确的。`,
    });
    return sendJSON(res, r.ok ? 200 : 502, r);
  }

  if (p === '/api/history' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    const minutes = Math.min(1440, Math.max(10, Number(url.searchParams.get('minutes')) || 1440));
    const m = findMachine(id);
    if (!m) return sendJSON(res, 404, { error: '机器不在监控列表中' });
    const cutoff = now() - minutes * 60000;
    return sendJSON(res, 200, { ok: true, samples: m.samples.filter((s) => s.t >= cutoff) });
  }

  return sendJSON(res, 404, { error: 'not found' });
}

/* --------------------------------- server --------------------------------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error('[api]', e);
      sendJSON(res, 500, { error: e.message || '服务器内部错误' });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

/* --------------------------------- startup -------------------------------- */

ensureInitialPassword();
loadHistory();
pruneHistoryFile();

persist();
setInterval(() => { pruneHistoryFile(); }, 6 * 3600 * 1000);

let pollTimer = null;
function schedulePoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { pollMachines().catch((e) => console.error('[poll]', e.message)); }, settings.pollSec * 1000);
}

server.listen(PORT, HOST, () => {
  console.log(`\nInstaBox 监控面板 v${VERSION}`);
  console.log(`  本机:   http://127.0.0.1:${PORT}`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  局域网: http://${a.address}:${PORT}  (${name})`);
    }
  }
  console.log(`  API:    ${API_BASE}`);
  console.log(`  数据:   ${DATA_DIR}\n`);
  if (!settings.passwordHash) console.log('首次运行：请在控制台或 data/FIRST_RUN_PASSWORD.txt 查看初始口令\n');
  pollMachines().catch(() => {});
  schedulePoll();
  setInterval(() => keepaliveTick().catch((e) => console.error('[keepalive]', e.message)), 20000);
  // 轮询间隔变更时重建定时器
  setInterval(() => {
    if (pollTimer && pollTimer._idleTimeout !== settings.pollSec * 1000) schedulePoll();
  }, 5000);
});
