# 可选：把 InstaBox 机器变成 FlClash 可用的代理

> 只做监控不需要这一节。代理与面板相互独立：面板的「启动 / 停止 / 二维码 / 测速」只是通过 SSH 帮你操作机器里的 Xray。

InstaBox 的公网端口是 **HTTPS 反向代理**，不是裸 TCP/UDP，所以标准 SS/Trojan/VLESS-TCP/Hysteria2 都不行。
能用的方案是 **VLESS + WebSocket + TLS**：TLS 在 InstaBox 边缘终止，机器里跑明文 WS，客户端连 443。

```
FlClash ──VLESS/WS over TLS(443)──> InstaBox 边缘 HTTPS 反向代理
                                          │ 明文 HTTP/WS
                                          ▼
                              机器内 Xray (0.0.0.0:8080, ws path /ws)
                                          │ freedom 出站
                                          ▼
                                      目标网站
```

## 1. 机器里装 Xray

把 `server/install.sh` 传到机器（机器空闲暂停时 SSH 会自动唤醒它）：

```bash
scp proxy/server/install.sh instabox:/data/home/install.sh
ssh instabox 'bash /data/home/install.sh'
```

脚本会：装依赖 → 装 Xray-core（官方脚本失败时直连 release 兜底）→ 生成 UUID 写入
`/usr/local/etc/xray/config.json`（监听 `0.0.0.0:8080`，WS 路径 `/ws`）→ 注册并启动 systemd 服务，最后打印 **UUID**。

自定义端口 / 路径：

```bash
PORT=9090 WS_PATH=/random-path bash /data/home/install.sh
```

## 2. 发布 8080 成 HTTPS 地址

机器里已预装 `instabox-port`，不需要额外 API key：

```bash
instabox-port publish 8080 --public
```

得到 `https://8080-<机器ID去掉m_>.instabox.tech`。重新发布 URL 不变。

## 3. 验证链路

```powershell
# 普通请求：期望 404（Xray 对非 WS 请求的正常响应）
curl.exe -i https://8080-<id>.instabox.tech/

# WebSocket 升级：期望 101
curl.exe -i -N --max-time 5 `
  -H "Connection: Upgrade" -H "Upgrade: websocket" `
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" `
  https://8080-<id>.instabox.tech/ws
```

> 第一次请求如果机器在空闲暂停，等 30–45 秒；返回 404 是正常的，浏览器打开这个地址看到 404 不代表坏。

## 4. 客户端配置

**方式 A：面板（推荐）**：设置 → 代理 → 选机器 / SSH 别名 / 端口 8080 / 路径 /ws → 卡片「启动」→
「二维码导入」或「下载 YAML」或「复制 vless」→ FlClash 对应导入。
注意 `https://` 入口地址**不能**导入客户端，它只是端口入口。

**方式 B：手动**：复制 `client/flclash-config.example.yaml`，替换 `<PORT>` / `<MACHINE_ID_WITHOUT_m_>` / `<UUID>` / `<WS_PATH>`，
FlClash → 配置 → 添加 → 从文件导入。

核心配置：

```yaml
proxies:
  - name: instabox
    type: vless
    server: 8080-<机器ID去掉m_>.instabox.tech
    port: 443
    uuid: <UUID>
    tls: true
    servername: 8080-<机器ID去掉m_>.instabox.tech
    client-fingerprint: chrome
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: 8080-<机器ID去掉m_>.instabox.tech
    udp: true
```

## 5. 面板里的测速

卡片「测速」会经代理请求 gstatic（3 次延迟），再用 4 个并发连接从 Cloudflare 下载最多 5 MB / 15 秒采样。
它测的是「本机 → 边缘 → 机器」整条链路；本机到边缘线路差时数字会低，不代表机器出口差。
每次测速约消耗 5 MB 机器出口流量。

## 限制（免费机）

| 限制 | 影响 |
| --- | --- |
| 连续运行 480 分钟 | 强制暂停，冷却 5–20 分钟，期间代理断开 |
| 空闲 30 分钟 | 平台暂停；下一个请求唤醒，首包等最多 45 秒 |
| 出口 100 GiB/月 | 大流量很快用完 |
| 约 50 Mbit/s | 峰值约 6 MB/s |
| 1 台免费机 | 拿它当代理就占了唯一一台 |

## 排错

| 现象 | 查什么 |
| --- | --- |
| 打开入口是 502 / 平台错误页 | 机器里 Xray 没起：`systemctl status xray`、`ss -ltnp | grep 8080` |
| 普通请求 404，WS 也 404 | 客户端 `path` 与配置 `wsSettings.path` 不一致 |
| 101 但客户端连不上 | UUID 错、`servername` 与域名不一致 |
| 503 Sandbox offline | 机器被暂停/停止，或 480 分钟冷却 |
| 面板显示「无法连接」 | 面板所在电脑 `ssh <别名>` 不通，或服务名不是 `xray` |
| 速度很慢 | 先看面板测速的「入口 RTT」；线路问题换网络/时段再测 |

## 安全

- **UUID 就是密码**：泄露后改机器上的 Xray 配置并 `sudo systemctl restart xray`，再更新所有客户端；
- 公开端口 URL 不是秘密，但没有 UUID 连不上；
- 把 WS 路径改成随机串可降低被扫描概率；
- 公网入口随时可 `instabox-port unpublish 8080` 关掉。
