/**
 * 最小 VLESS-over-WS 客户端（仅用于测速，无依赖）
 *
 * 只支持明文 TCP 目标（测速用 http:// 目标）：隧道里是裸 TCP，
 * 如果目标要 TLS，客户端得自己完成 TLS 握手，这里不实现。
 */

const WS_OPEN_TIMEOUT = 15000;

export function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('UUID 格式不对');
  return Buffer.from(hex, 'hex');
}

/** VLESS v1 请求头：version + uuid + addonLen + command(TCP) + port + addrType(domain) + addr */
export function vlessRequestHeader(uuid, targetHost, targetPort) {
  const hostBuf = Buffer.from(targetHost, 'ascii');
  const buf = Buffer.alloc(23 + hostBuf.length);
  buf[0] = 0; // version
  uuidToBytes(uuid).copy(buf, 1);
  buf[17] = 0; // addon length
  buf[18] = 1; // command: TCP
  buf.writeUInt16BE(targetPort, 19);
  buf[21] = 2; // address type: domain
  buf[22] = hostBuf.length;
  hostBuf.copy(buf, 23);
  return buf;
}

function openWs(wsUrl, timeoutMs = WS_OPEN_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (err) { reject(new Error(`WS 创建失败：${err.message}`)); return; }
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('连接代理超时'));
    }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接代理失败')); }, { once: true });
  });
}

/**
 * 通过 VLESS/WS 发起一次 HTTP/1.1 请求并统计首字节时间、总耗时、正文字节数。
 * @returns {{ttfbMs:number|null, elapsedMs:number, bodyBytes:number, statusCode:number, limited?:boolean}}
 */
export async function vlessHttpThroughProxy(opts) {
  const {
    wsUrl, uuid, targetHost, targetPort = 80, requestPath = '/', method = 'GET',
    hostHeader = targetHost, maxBytes = 0, timeoutMs = 40000, onProgress, resolveOnTimeout = false,
  } = opts;

  const ws = await openWs(wsUrl);
  const started = performance.now();

  return await new Promise((resolve, reject) => {
    let settled = false;
    let ttfb = null;
    let vlessHdrLeft = -1;
    let buf = Buffer.alloc(0);
    let headParsed = false;
    let contentLength = -1;
    let statusCode = 0;
    let bodyBytes = 0;

    const timer = setTimeout(() => {
      if (resolveOnTimeout && bodyBytes > 0) finish(null, true);
      else finish(new Error('测速超时'));
    }, timeoutMs);

    function finish(err, timedOut = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      const elapsedMs = performance.now() - started;
      if (err) reject(err);
      else resolve({ ttfbMs: ttfb, elapsedMs, bodyBytes, statusCode, timedOut });
    }

    function feed(chunk) {
      body: {
        if (!chunk.length) break body;
        buf = Buffer.concat([buf, chunk]);

        if (vlessHdrLeft < 0) {
          if (buf.length < 2) break body;
          vlessHdrLeft = 2 + buf[1];
          if (buf.length < vlessHdrLeft) break body;
          buf = buf.subarray(vlessHdrLeft);
          vlessHdrLeft = 0;
        } else if (vlessHdrLeft > 0) {
          if (buf.length < vlessHdrLeft) { vlessHdrLeft -= buf.length; break body; }
          buf = buf.subarray(vlessHdrLeft);
          vlessHdrLeft = 0;
        }

        if (!buf.length) break body;

        if (ttfb === null) ttfb = performance.now() - started;

        if (!headParsed) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) break body;
          const head = buf.subarray(0, idx).toString('latin1');
          statusCode = Number((head.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0);
          const cl = head.match(/content-length:\s*(\d+)/i);
          contentLength = cl ? Number(cl[1]) : -1;
          headParsed = true;
          bodyBytes += buf.length - idx - 4;
          buf = Buffer.alloc(0);
          if (statusCode >= 400) return finish(new Error(`目标返回 HTTP ${statusCode}`));
          if (maxBytes && bodyBytes >= maxBytes) return finish(null);
          if (contentLength >= 0 && bodyBytes >= contentLength) return finish(null);
          if (onProgress) onProgress(bodyBytes);
          break body;
        }

        bodyBytes += buf.length;
        buf = Buffer.alloc(0);
        if (onProgress) onProgress(bodyBytes);
        if (maxBytes && bodyBytes >= maxBytes) return finish(null);
        if (contentLength >= 0 && bodyBytes >= contentLength) return finish(null);
      }
    }

    ws.addEventListener('message', (ev) => {
      try { feed(Buffer.from(ev.data)); } catch (err) { finish(err); }
    });
    ws.addEventListener('close', () => {
      if (!settled) {
        if (!headParsed) finish(new Error('隧道提前关闭（没收到响应）'));
        else finish(null);
      }
    });

    const request =
      `${method} ${requestPath} HTTP/1.1\r\n` +
      `Host: ${hostHeader}\r\n` +
      'User-Agent: instabox-speedtest\r\n' +
      'Accept: */*\r\n' +
      'Connection: close\r\n\r\n';
    try {
      ws.send(Buffer.concat([vlessRequestHeader(uuid, targetHost, targetPort), Buffer.from(request, 'latin1')]));
    } catch (err) {
      finish(new Error(`发送失败：${err.message}`));
    }
  });
}
