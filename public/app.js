/* InstaBox 控制台 —— 前端（无构建，原生 ES 模块） */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const S = {
  data: null,
  pollTimer: null,
  ticker: null,
  drawerId: null,
  drawerSamples: null,
  busy: new Set(),
  proxy: null,
  proxyBusy: false,
  proxyTimer: null,
  speedtest: null,
  speedtestBusy: false,
};

/* --------------------------------- 工具 --------------------------------- */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${Number(v).toFixed(0)}%`;
}
function pct(used, total) {
  if (used == null || !total) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}
function fmtDur(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
}
function stateMeta(state) {
  const map = {
    running: ['运行中', 'green'],
    suspended: ['已暂停', 'amber'],
    stopped: ['已停止', 'gray'],
    starting: ['启动中', 'blue'],
    stopping: ['停止中', 'blue'],
    suspending: ['暂停中', 'blue'],
    resuming: ['恢复中', 'blue'],
    creating: ['创建中', 'blue'],
    deleting: ['删除中', 'blue'],
    deleted: ['已删除', 'gray'],
    error: ['错误', 'red'],
    unknown: ['未知', 'gray'],
  };
  const [label, cls] = map[state] || [state, 'gray'];
  return { label, cls };
}
const busyStates = new Set(['starting', 'stopping', 'suspending', 'resuming', 'creating', 'deleting']);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (res.status === 401) {
    showLogin();
    throw new Error('未登录');
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* --------------------------------- 登录 --------------------------------- */

function showLogin() {
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  $('#login-password').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#login-password').value;
  $('#login-error').classList.add('hidden');
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
    $('#login-password').value = '';
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').classList.remove('hidden');
  }
});

$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  showLogin();
});

/* --------------------------------- 轮询 --------------------------------- */

function startPolling() {
  clearInterval(S.pollTimer);
  const sec = Math.max(2, Number(S.data?.settings?.pollSec || 8));
  S.pollTimer = setInterval(loadState, sec * 1000);
  const sel = $('#poll-select');
  if (sel && [...sel.options].some((o) => Number(o.value) === sec)) sel.value = String(sec);
}

async function loadState() {
  try {
    S.data = await api('/api/state');
    render();
  } catch (err) {
    if (err.status !== 401) console.warn('刷新失败', err.message);
  }
}

async function loadProxy() {
  const p = S.data?.settings?.proxy;
  if (!p || !p.machineId) {
    S.proxy = null;
    if (S.data) render();
    return;
  }
  try {
    S.proxy = await api('/api/proxy');
  } catch {
    S.proxy = null;
  }
  if (S.data) render();
}

async function boot() {
  try {
    S.data = await api('/api/state');
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    render();
    startPolling();
    loadProxy();
    if (!S.ticker) {
      S.ticker = setInterval(tickCountdowns, 1000);
    }
    if (!S.proxyTimer) {
      S.proxyTimer = setInterval(loadProxy, 15000);
    }
  } catch (err) {
    if (err.status === 401) showLogin();
  }
}

function tickCountdowns() {
  const t = Date.now();
  $$('[data-until]').forEach((el) => {
    const until = Number(el.dataset.until);
    const label = el.dataset.label || '';
    const left = until - t;
    el.textContent = left > 0 ? `${label}${fmtDur(left)}` : (el.dataset.expired || '');
    if (left <= 0) el.classList.add('muted');
  });
  $$('[data-since]').forEach((el) => {
    const since = Number(el.dataset.since);
    el.textContent = fmtDur(t - since);
  });
}

/* --------------------------------- 渲染 --------------------------------- */

function render() {
  if (!S.data) return;
  const s = S.data.settings || {};
  $('#key-count').textContent = `${S.data.keys.length} 把 key`;
  $('#ver').textContent = `v${S.data.version}`;
  $('#api-hint').textContent = S.data.apiBase;
  const sel = $('#poll-select');
  if (sel) sel.value = String(s.pollSec || 8);

  const machines = S.data.machines || [];
  const counts = {
    running: machines.filter((m) => m.state === 'running').length,
    suspended: machines.filter((m) => m.state === 'suspended').length,
    stopped: machines.filter((m) => m.state === 'stopped').length,
  };
  const summary = $('#summary');
  if (machines.length) {
    summary.innerHTML = `
      <span class="chip">共 <b>${machines.length}</b> 台</span>
      <span class="chip">运行中 <b>${counts.running}</b></span>
      <span class="chip">已暂停 <b>${counts.suspended}</b></span>
      <span class="chip">已停止 <b>${counts.stopped}</b></span>`;
    summary.classList.remove('hidden');
  } else {
    summary.innerHTML = '';
  }

  const grid = $('#cards');
  if (!machines.length) {
    grid.innerHTML = '';
    $('#empty').classList.remove('hidden');
  } else {
    $('#empty').classList.add('hidden');
    grid.innerHTML = machines.map(renderCard).join('');
  }

  // 重新打开抽屉时保持内容较新
  if (S.drawerId) {
    const m = machines.find((x) => x.id === S.drawerId);
    if (m) updateDrawerHeader(m);
  }
}

function renderCard(m) {
  const meta = stateMeta(m.state);
  const busy = S.busy.has(m.id) || busyStates.has(m.state);
  const proxyCfg = S.data?.settings?.proxy || {};
  const proxyBlock = proxyCfg.machineId === m.id ? renderProxy(m) : '';
  const cd = m.cooldownUntil ? Date.parse(m.cooldownUntil) : 0;
  const cooling = cd > Date.now();
  const spec = m.spec || {};
  const mem = (spec.memMiB || 0) * 1024 * 1024;
  const uptime = m.state === 'running' && m.runStartedAt ? Date.parse(m.runStartedAt) : 0;
  const cpu = pct(m.metrics?.cpuUsedPct, 100);
  const memPct = pct(m.metrics?.memUsed, m.metrics?.memTotal);
  const diskPct = pct(m.metrics?.diskUsed, m.metrics?.diskTotal);
  const kl = m.keepalive || {};
  const leaseLeft = kl.enabled && kl.leaseUntil ? kl.leaseUntil - Date.now() : 0;

  const btn = (act, label, cls = 'btn sm', disabled = false, title = '') =>
    `<button class="${cls}" data-act="${act}" data-id="${esc(m.id)}" ${disabled || busy ? 'disabled' : ''} ${title ? `title="${esc(title)}"` : ''}>${label}</button>`;

  let actions = '';
  if (m.state === 'running') {
    actions = btn('suspend', '暂停') + btn('stop', '停止', 'btn sm danger');
  } else if (m.state === 'suspended') {
    const auto = !!m.autoSuspendedAt;
    actions = btn(auto ? 'wake' : 'resume', auto ? '唤醒' : '恢复', 'btn sm primary', cooling, cooling ? '冷却中' : '') +
      btn('stop', '停止', 'btn sm danger', true, '先恢复再停止');
  } else if (m.state === 'stopped' || m.state === 'error') {
    actions = btn('start', '启动', 'btn sm primary', cooling, cooling ? '冷却中' : '');
  } else if (busy) {
    actions = '<span class="pill blue">操作中…</span>';
  } else {
    actions = btn('wake', '唤醒', 'btn sm', cooling);
  }
  actions += btn('detail', '详情', 'btn sm ghost');

  const idleText = m.state === 'suspended'
    ? (m.autoSuspendedAt ? `空闲暂停于 ${fmtTime(m.autoSuspendedAt)}` : '手动暂停')
    : (m.autoSuspendAfterSeconds ? `空闲 ${Math.round(m.autoSuspendAfterSeconds / 60)}m 后暂停` : '空闲暂停：未知');

  const cooldownText = cooling
    ? `<span class="pill amber tiny" data-until="${cd}" data-label="冷却 ">冷却 ${fmtDur(cd - Date.now())}</span>`
    : '';
  const klText = kl.enabled
    ? (kl.lastError
      ? `<span class="warn" title="${esc(kl.lastError)}">保活异常</span>`
      : `<span class="lease" data-until="${kl.leaseUntil}" data-label="租约 " data-expired="租约到期">租约 ${fmtDur(leaseLeft)}</span>`)
    : '<span class="lease">保活关</span>';

  return `
  <article class="card" data-card="${esc(m.id)}">
    <div class="card-top">
      <div>
        <h3 class="card-name">${esc(m.name)} <span class="pill ${meta.cls}"><span class="dot"></span>${meta.label}</span>${cooldownText}</h3>
        <div class="card-id">${esc(m.id)}</div>
      </div>
    </div>
    <div class="card-spec">${spec.vcpus ? `${spec.vcpus} vCPU` : '—'} · ${fmtBytes(mem)} · /data ${spec.persistentDiskGiB ? `${spec.persistentDiskGiB}G` : '—'} · 根盘 ${spec.rootDiskGiB ? `${spec.rootDiskGiB}G` : '—'}</div>
    <div class="card-meta">
      <span>${m.state === 'running' ? `已运行 <b data-since="${uptime}">${fmtDur(Date.now() - uptime)}</b>` : `状态 <b>${meta.label}</b>`}</span>
      <span>${idleText}</span>
      <span>${m.metrics?.netInBytesPerSec != null ? `NET ↓${fmtBytes(m.metrics.netInBytesPerSec)}/s ↑${fmtBytes(m.metrics.netOutBytesPerSec)}/s` : 'NET —'}</span>
    </div>
    <div class="bars">
      <div class="bar-row"><span>CPU</span><span class="bar"><i style="width:${cpu ?? 0}%"></i></span><span class="bar-val">${cpu == null ? '—' : fmtPct(cpu)}</span></div>
      <div class="bar-row"><span>内存</span><span class="bar"><i class="mem" style="width:${memPct ?? 0}%"></i></span><span class="bar-val">${m.metrics?.memUsed != null ? `${fmtBytes(m.metrics.memUsed)} / ${fmtBytes(m.metrics.memTotal)}` : '—'}</span></div>
      <div class="bar-row"><span>磁盘</span><span class="bar"><i class="disk" style="width:${diskPct ?? 0}%"></i></span><span class="bar-val">${m.metrics?.diskUsed != null ? fmtPct(diskPct) : '—'}</span></div>
    </div>
    ${m.lastError ? `<div class="alert">${esc(m.lastError)}</div>` : ''}
    <div class="card-actions">${actions}</div>
    <div class="card-foot">
      <div class="kl">
        <label><input type="checkbox" data-kl="${esc(m.id)}" ${kl.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}> 保活</label>
        ${klText}
      </div>
      <button class="btn sm danger" data-remove="${esc(m.id)}">移除</button>
    </div>
    ${proxyBlock}
  </article>`;
}

function renderProxy(m) {
  const pr = S.proxy && S.proxy.machineId === m.id ? S.proxy : null;
  const st = pr?.state || 'unknown';
  const meta = {
    running: ['运行中', 'green'],
    stopped: ['已停止', 'gray'],
    paused: ['机器已暂停', 'amber'],
    unreachable: ['无法连接', 'amber'],
    unconfigured: ['未配置', 'gray'],
    unknown: ['检查中', 'gray'],
  }[st] || ['未知', 'gray'];
  const busy = S.proxyBusy;
  const canStart = !busy && st !== 'running' && st !== 'unreachable';
  const canStop = !busy && st === 'running';
  const running = st === 'running' && pr?.url;
  return `
    <div class="proxy">
      <div class="proxy-head">
        <span class="proxy-title">代理 <span class="pill ${meta[1]}"><span class="dot"></span>${esc(meta[0])}</span></span>
        <span class="proxy-actions">
          <button class="btn sm primary" data-proxy="start" ${canStart ? '' : 'disabled'}>启动</button>
          <button class="btn sm danger" data-proxy="stop" ${canStop ? '' : 'disabled'}>停止</button>
        </span>
      </div>
      ${running ? `
      <div class="proxy-body">
        <div class="proxy-link">
          <span class="proxy-label">入口</span>
          <code title="${esc(pr.url)}">${esc(pr.url)}</code>
          <button class="btn sm ghost" data-copy="${esc(pr.url)}">复制</button>
        </div>
        <div class="proxy-btns">
          <button class="btn sm primary" data-qr="1">二维码导入</button>
          <button class="btn sm" data-yaml="1">下载 YAML</button>
          <button class="btn sm ghost" data-copy="${esc(pr.vless || '')}">复制 vless</button>
          <button class="btn sm" data-speed="1" ${S.speedtestBusy ? 'disabled' : ''}>${S.speedtestBusy ? '测速中…' : '测速'}</button>
        </div>
        <div class="proxy-speed">${speedText()}</div>
        <div class="proxy-note muted small">「入口」只是端口地址，浏览器打开 404 属正常，不能导入客户端；导入请用二维码 / vless / YAML。</div>
      </div>` : ''}
      ${pr?.error ? `<div class="alert">${esc(pr.error)}</div>` : ''}
    </div>`;
}

function speedText() {
  if (S.speedtestBusy) return '测速中…（最多约 20 秒，经代理下载约 5 MB）';
  const st = S.speedtest;
  if (!st) return '延迟 / 下载：未测速';
  const lat = st.latency || {};
  const dl = st.download || {};
  const part = dl.limited ? '（15 秒采样）' : '';
  return `延迟 ${lat.avg ?? '—'} ms（入口 ${st.edgeMs ?? '—'} ms） · 下载 ${dl.mbps ?? '—'} Mbps${part}`;
}

async function doSpeedtest() {
  if (S.speedtestBusy) return;
  S.speedtestBusy = true;
  render();
  try {
    S.speedtest = await api('/api/speedtest', { method: 'POST' });
    const dl = S.speedtest.download || {};
    toast(`测速完成：${dl.mbps ?? '—'} Mbps / ${S.speedtest.latency?.avg ?? '—'} ms`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    S.speedtestBusy = false;
    render();
  }
}

async function doProxy(action) {
  if (action === 'stop' && !confirm('停止代理？\n\nXray 服务会停止，公网地址暂时不可用；下次点「启动」即恢复，链接不变。')) return;
  S.proxyBusy = true;
  render();
  try {
    const r = await api(`/api/proxy/${action}`, { method: 'POST' });
    S.proxy = r.status || null;
    S.speedtest = null;
    toast(action === 'start' ? '代理已启动' : '代理已停止', 'ok');
  } catch (err) {
    toast(err.message, 'error');
    try { S.proxy = await api('/api/proxy'); } catch {}
  } finally {
    S.proxyBusy = false;
    render();
  }
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('已复制', 'ok');
    } catch {
      toast('复制失败', 'error');
    }
    ta.remove();
  }
}

function openProxyQr() {
  const pr = S.proxy;
  if (!pr?.vless) return;
  $('#proxy-dialog-vless').textContent = pr.vless;
  $('#proxy-dialog-link').textContent = pr.url || '';
  const box = $('#proxy-qr');
  box.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(pr.vless);
    qr.make();
    box.innerHTML = qr.createSvgTag(4, 2);
    const svg = box.querySelector('svg');
    if (svg) { svg.setAttribute('width', '180'); svg.setAttribute('height', '180'); }
  } catch (err) {
    box.textContent = `二维码生成失败：${err.message}`;
  }
  $('#proxy-dialog').showModal();
}

/* --------------------------------- 操作 --------------------------------- */

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const { act, id } = btn.dataset;
    if (act === 'detail') return openDrawer(id);
    await doAction(id, act);
    return;
  }
  const pbtn = e.target.closest('button[data-proxy]');
  if (pbtn) return doProxy(pbtn.dataset.proxy);
  const qbtn = e.target.closest('button[data-qr]');
  if (qbtn) return openProxyQr();
  const ybtn = e.target.closest('button[data-yaml]');
  if (ybtn) { window.location.href = '/api/proxy/config'; return; }
  const sbtn = e.target.closest('button[data-speed]');
  if (sbtn) return doSpeedtest();
  const cbtn = e.target.closest('button[data-copy]');
  if (cbtn) return copyText(cbtn.dataset.copy);
  const rm = e.target.closest('button[data-remove]');
  if (rm) {
    const id = rm.dataset.remove;
    const m = (S.data?.machines || []).find((x) => x.id === id);
    if (!confirm(`移除监控「${m?.name || id}」？\n\n只从面板移除，不会删除云端机器。`)) return;
    try {
      await api(`/api/machines/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('已移除监控', 'ok');
      await loadState();
    } catch (err) { toast(err.message, 'error'); }
  }
});

document.addEventListener('change', async (e) => {
  const kl = e.target.closest('input[data-kl]');
  if (!kl) return;
  const id = kl.dataset.kl;
  const enabled = kl.checked;
  kl.disabled = true;
  try {
    const r = await api(`/api/machines/${encodeURIComponent(id)}/keepalive`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    toast(enabled ? '保活已开启' : '保活已关闭', enabled ? 'ok' : '');
    void r;
    await loadState();
  } catch (err) {
    toast(err.message, 'error');
    kl.checked = !enabled;
    kl.disabled = false;
  }
});

async function doAction(id, action) {
  S.busy.add(id);
  render();
  try {
    const r = await api(`/api/machines/${encodeURIComponent(id)}/action`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    if (r.ok) {
      toast(actionDoneText(action), 'ok');
    } else {
      const extra = r.retryAfterSeconds ? `，约 ${Math.ceil(r.retryAfterSeconds / 60)} 分钟后重试` : '';
      toast(`${r.error}${extra}`, 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    S.busy.delete(id);
    await loadState();
  }
}
function actionDoneText(a) {
  return { start: '已启动', resume: '已恢复', suspend: '已暂停', stop: '已停止', wake: '已唤醒' }[a] || '操作完成';
}

/* --------------------------------- 详情抽屉 ------------------------------ */

const STATE_COLORS = {
  running: '#16a34a',
  suspended: '#d97706',
  stopped: '#94a3b8',
  error: '#dc2626',
  starting: '#2563eb',
  stopping: '#2563eb',
  suspending: '#2563eb',
  resuming: '#2563eb',
  creating: '#2563eb',
  deleting: '#2563eb',
  unknown: '#e2e8f0',
};

async function openDrawer(id) {
  const m = (S.data?.machines || []).find((x) => x.id === id);
  if (!m) return;
  S.drawerId = id;
  $('#drawer').classList.remove('hidden');
  $('#drawer-title').textContent = m.name;
  $('#drawer-body').innerHTML = '<p class="muted">加载历史数据…</p>';
  let samples = [];
  try {
    const r = await api(`/api/history?id=${encodeURIComponent(id)}&minutes=1440`);
    samples = r.samples || [];
  } catch {}
  S.drawerSamples = samples;
  renderDrawer(m, samples);
}

function updateDrawerHeader(m) {
  if ($('#drawer-title')) $('#drawer-title').textContent = m.name;
}

function renderDrawer(m, samples) {
  const spec = m.spec || {};
  const mem = (spec.memMiB || 0) * 1024 * 1024;
  const meta = stateMeta(m.state);
  const rows = [
    ['状态', `<span class="pill ${meta.cls}">${meta.label}</span>`],
    ['暂停方式', m.state === 'suspended' ? (m.autoSuspendedAt ? '空闲自动暂停（可唤醒）' : '手动暂停（用恢复）') : '—'],
    ['机器 ID', `<code>${esc(m.id)}</code>`],
    ['规格', `${spec.vcpus || '—'} vCPU · ${fmtBytes(mem)} · 根盘 ${spec.rootDiskGiB || '—'}G · /data ${spec.persistentDiskGiB || '—'}G`],
    ['运行开始', fmtTime(m.runStartedAt)],
    ['创建时间', fmtTime(m.createdAt)],
    ['空闲暂停', m.autoSuspendAfterSeconds ? `空闲 ${Math.round(m.autoSuspendAfterSeconds / 60)} 分钟后` : '—'],
    ['最大运行', m.maxRunMinutes ? (m.maxRunMinutes < 0 ? '不限制' : `${m.maxRunMinutes} 分钟`) : '—'],
    ['冷却至', fmtTime(m.cooldownUntil)],
    ['存储同步', m.storage ? (m.storage.synced ? '已同步' : '同步中') : '—'],
    ['计费', m.free ? '免费机' : '付费机'],
    ['最近错误', m.lastError ? `<span class="error">${esc(m.lastError)}</span>` : '无'],
    ['保活', m.keepalive?.enabled ? (m.keepalive.leaseUntil ? `开启（租约至 ${fmtTime(m.keepalive.leaseUntil)}）` : '开启') : '关闭'],
  ];
  const m2 = m.metrics || {};
  const cpu = m2.cpuUsedPct;
  const memPctV = m2.memUsed != null && m2.memTotal ? (m2.memUsed / m2.memTotal) * 100 : null;

  $('#drawer-body').innerHTML = `
    <dl class="detail-grid">
      ${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
    </dl>

    <div class="section-title">近 24 小时状态</div>
    <div class="chart-box"><canvas id="chart-state" height="34"></canvas>
      <div class="legend">
        <span><i style="background:${STATE_COLORS.running}"></i>运行</span>
        <span><i style="background:${STATE_COLORS.suspended}"></i>暂停</span>
        <span><i style="background:${STATE_COLORS.stopped}"></i>停止</span>
        <span><i style="background:${STATE_COLORS.error}"></i>错误</span>
      </div>
    </div>

    <div class="section-title">CPU / 内存</div>
    <div class="chart-box"><canvas id="chart-cpu" height="150"></canvas>
      <div class="legend"><span><i style="background:#2563eb"></i>CPU</span><span><i style="background:#7c3aed"></i>内存</span></div>
    </div>

    <div class="section-title">网络（字节/秒）</div>
    <div class="chart-box"><canvas id="chart-net" height="110"></canvas>
      <div class="legend"><span><i style="background:#0d9488"></i>入</span><span><i style="background:#d97706"></i>出</span></div>
    </div>

    <div class="card-actions">
      ${actionButtonsHtml(m)}
      <button class="btn sm ghost" data-close-drawer>关闭</button>
    </div>
  `;

  requestAnimationFrame(() => {
    drawStateStrip($('#chart-state'), samples, 1440);
    drawLineChart($('#chart-cpu'), samples, ['cpu', 'memPct'], ['#2563eb', '#7c3aed'], { max: 100, unit: '%' });
    drawLineChart($('#chart-net'), samples, ['netIn', 'netOut'], ['#0d9488', '#d97706'], { unit: '/s' });
  });

  // 抽屉里的操作按钮复用全局委托（data-act），但需要绑定到 id
  $$('#drawer-body button[data-act]').forEach((b) => { b.dataset.id = m.id; });
}

function actionButtonsHtml(m) {
  const busy = S.busy.has(m.id) || busyStates.has(m.state);
  const cd = m.cooldownUntil ? Date.parse(m.cooldownUntil) : 0;
  const cooling = cd > Date.now();
  const btn = (act, label, cls = 'btn sm', disabled = false) =>
    `<button class="${cls}" data-act="${act}" data-id="${esc(m.id)}" ${disabled || busy ? 'disabled' : ''}>${label}</button>`;
  if (m.state === 'running') return btn('suspend', '暂停') + btn('stop', '停止', 'btn sm danger');
  if (m.state === 'suspended') {
    const auto = !!m.autoSuspendedAt;
    return btn(auto ? 'wake' : 'resume', auto ? '唤醒' : '恢复', 'btn sm primary', cooling) +
      btn('stop', '停止', 'btn sm danger', true);
  }
  if (m.state === 'stopped' || m.state === 'error') return btn('start', '启动', 'btn sm primary', cooling);
  if (busy) return '<span class="pill blue">操作中…</span>';
  return btn('wake', '唤醒', 'btn sm', cooling);
}

/* --------------------------------- 图表 --------------------------------- */

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(240, Math.round(rect.width || canvas.clientWidth || 480));
  const h = Math.max(24, Math.round(rect.height || canvas.clientHeight || Number(canvas.getAttribute('height')) || 120));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawStateStrip(canvas, samples, minutes) {
  if (!canvas) return;
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const end = Date.now();
  const start = end - minutes * 60000;
  ctx.fillStyle = '#eef2f7';
  ctx.fillRect(0, 0, w, h);
  if (!samples.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillText('暂无历史数据（面板运行后开始记录）', 10, h / 2 + 4);
    return;
  }
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    const next = samples[i + 1] ? samples[i + 1].t : end;
    const x1 = Math.max(0, ((s.t - start) / (end - start)) * w);
    const x2 = Math.min(w, ((next - start) / (end - start)) * w);
    if (x2 <= x1) continue;
    ctx.fillStyle = STATE_COLORS[s.state] || '#e2e8f0';
    ctx.fillRect(x1, 0, Math.max(1.5, x2 - x1), h);
  }
}

function drawLineChart(canvas, samples, fields, colors, opts = {}) {
  if (!canvas) return;
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!samples.length) return;

  const end = Date.now();
  const start = end - 1440 * 60000;
  const padL = 34, padR = 8, padT = 8, padB = 16;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  let maxV = opts.max || 0;
  for (const s of samples) {
    for (const f of fields) {
      const v = fieldValue(s, f);
      if (v != null && v > maxV) maxV = v;
    }
  }
  if (!maxV) maxV = 1;

  // 背景网格
  ctx.strokeStyle = '#eef2f7';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i += 1) {
    const y = padT + (innerH * i) / 3;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
  ctx.fillText(String(Math.round(maxV)), 2, padT + 4);
  ctx.fillText('0', 2, padT + innerH);

  fields.forEach((f, idx) => {
    ctx.strokeStyle = colors[idx] || '#2563eb';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    let started = false;
    for (const s of samples) {
      const v = fieldValue(s, f);
      if (v == null) { started = false; continue; }
      const x = padL + ((s.t - start) / (end - start)) * innerW;
      const y = padT + innerH - (v / maxV) * innerH;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  const fmt = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(fmt(start), padL, h - 3);
  const endLabel = fmt(end);
  ctx.fillText(endLabel, w - padR - ctx.measureText(endLabel).width, h - 3);
}

function fieldValue(s, field) {
  if (field === 'memPct') return s.memUsed != null && s.memTotal ? (s.memUsed / s.memTotal) * 100 : null;
  if (field === 'cpu' || field === 'netIn' || field === 'netOut') return s[field] ?? null;
  return s[field] ?? null;
}

/* --------------------------------- 添加机器 ------------------------------ */

$('#btn-add').addEventListener('click', () => {
  $('#add-key').value = '';
  $('#add-label').value = '';
  $('#add-result').classList.add('hidden');
  $('#add-result').innerHTML = '';
  $('#add-dialog').showModal();
});
$$('[data-open-add]').forEach((b) => b.addEventListener('click', () => $('#btn-add').click()));
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const lines = $('#add-key').value.split(/\s+/).map((t) => t.trim().replace(/^[<>]+|[<>]+$/g, '')).filter(Boolean);
  if (!lines.length) return;
  const label = $('#add-label').value.trim();
  const result = $('#add-result');
  result.classList.remove('hidden');
  result.innerHTML = '<p class="muted">校验中…</p>';

  const out = [];
  for (const key of lines) {
    try {
      const r = await api('/api/keys', { method: 'POST', body: JSON.stringify({ key, label }) });
      out.push({ ok: true, msg: `${key.slice(0, 8)}… 已添加，发现 ${r.total} 台机器${r.added.length ? `（新增 ${r.added.length} 台）` : ''}` });
    } catch (err) {
      out.push({ ok: false, msg: `${key.slice(0, 8)}… ${err.message}` });
    }
  }
  result.innerHTML = `<ul>${out.map((o) => `<li class="${o.ok ? 'ok' : 'fail'}">${o.ok ? '✓' : '✗'} ${esc(o.msg)}</li>`).join('')}</ul>`;
  const anyOk = out.some((o) => o.ok);
  if (anyOk) {
    await loadState();
    setTimeout(() => { if ($('#add-dialog').open) $('#add-dialog').close(); }, 1200);
  }
});

/* --------------------------------- 设置 --------------------------------- */

$('#btn-settings').addEventListener('click', () => {
  const st = S.data.settings;
  $('#set-poll').value = st.pollSec || 8;
  $('#set-metrics').value = st.metricsSec || 8;
  const m = st.smtp || {};
  $('#smtp-host').value = m.host || 'smtp.qq.com';
  $('#smtp-port').value = m.port || 465;
  $('#smtp-secure').checked = !!m.secure;
  $('#smtp-user').value = m.user || '';
  $('#smtp-pass').value = '';
  $('#smtp-pass').placeholder = m.hasPassword ? '已设置（留空不修改）' : 'QQ 邮箱授权码';
  $('#smtp-from').value = m.from || m.user || '';
  $('#smtp-to').value = m.to || '';
  $('#smtp-enabled').checked = !!m.enabled;
  $('#notify-state').checked = !!(st.notify && st.notify.onStateChange);
  $('#notify-error').checked = !!(st.notify && st.notify.onError);
  $('#notify-keepalive').checked = !!(st.notify && st.notify.onKeepalive);
  $('#mail-test-result').textContent = '';
  const pr = st.proxy || {};
  const psel = $('#set-proxy-machine');
  psel.innerHTML = '<option value="">不启用</option>' +
    ((S.data && S.data.machines) || []).map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  psel.value = pr.machineId || '';
  $('#set-proxy-ssh').value = pr.sshHost || 'instabox';
  $('#set-proxy-port').value = pr.port || 8080;
  $('#set-proxy-path').value = pr.path || '/ws';
  $('#pw-current').value = '';
  $('#pw-next').value = '';
  $('#pw-result').textContent = '';
  $('#settings-dialog').showModal();
});

function collectSettings() {
  return {
    pollSec: Number($('#set-poll').value) || 8,
    metricsSec: Number($('#set-metrics').value) || 8,
    notify: {
      onStateChange: $('#notify-state').checked,
      onError: $('#notify-error').checked,
      onKeepalive: $('#notify-keepalive').checked,
    },
    smtp: {
      enabled: $('#smtp-enabled').checked,
      host: $('#smtp-host').value.trim(),
      port: Number($('#smtp-port').value) || 465,
      secure: $('#smtp-secure').checked,
      user: $('#smtp-user').value.trim(),
      pass: $('#smtp-pass').value,
      from: $('#smtp-from').value.trim(),
      to: $('#smtp-to').value.trim(),
    },
    proxy: {
      machineId: $('#set-proxy-machine').value,
      sshHost: $('#set-proxy-ssh').value.trim() || 'instabox',
      port: Number($('#set-proxy-port').value) || 8080,
      path: $('#set-proxy-path').value.trim() || '/ws',
    },
  };
}

async function saveSettings(silent = false) {
  const r = await api('/api/settings', { method: 'POST', body: JSON.stringify(collectSettings()) });
  if (S.data) S.data.settings = r.settings;
  loadProxy();
  if (!silent) { toast('设置已保存', 'ok'); startPolling(); }
  return r;
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await saveSettings();
    $('#settings-dialog').close();
  } catch (err) { toast(err.message, 'error'); }
});

$('#btn-test-mail').addEventListener('click', async () => {
  const out = $('#mail-test-result');
  out.textContent = '发送中…';
  try {
    await saveSettings(true);
    const r = await api('/api/smtp/test', { method: 'POST' });
    out.textContent = r.ok ? '已发送，请查收（也看看垃圾箱）' : `失败：${r.error}`;
  } catch (err) {
    out.textContent = `失败：${err.message}`;
  }
});

$('#btn-save-pw').addEventListener('click', async () => {
  const out = $('#pw-result');
  try {
    await api('/api/settings/password', {
      method: 'POST',
      body: JSON.stringify({ current: $('#pw-current').value, next: $('#pw-next').value }),
    });
    out.textContent = '口令已修改';
    $('#pw-current').value = '';
    $('#pw-next').value = '';
    toast('面板口令已修改', 'ok');
  } catch (err) {
    out.textContent = err.message;
  }
});

$('#poll-select').addEventListener('change', async (e) => {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ pollSec: Number(e.target.value) }) });
    if (S.data) S.data.settings.pollSec = Number(e.target.value);
    startPolling();
    toast(`刷新间隔 ${e.target.value}s`, 'ok');
  } catch (err) { toast(err.message, 'error'); }
});

/* --------------------------------- 提示 --------------------------------- */

function toast(msg, cls = '') {
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 350); }, 4200);
}

/* --------------------------------- 抽屉关闭 ------------------------------ */

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-drawer]')) {
    S.drawerId = null;
    S.drawerSamples = null;
    $('#drawer').classList.add('hidden');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.drawerId) {
    S.drawerId = null;
    $('#drawer').classList.add('hidden');
  }
});

/* --------------------------------- 启动 --------------------------------- */

boot();
