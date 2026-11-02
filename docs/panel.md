# InstaBox 控制台

本地/局域网用的 InstaBox 机器监控面板：添加/移除监控的机器、看状态与资源、启动 / 恢复 / 暂停 / 停止、可选保活、邮件通知。

- 后端：Node.js（零依赖，`node:http`），需要 Node 18+
- 前端：原生 HTML/CSS/JS，无构建
- 数据：`data/` 下三个文件，全在本机

## 启动 / 停止

- **启动**：双击 `start.bat`（会自动打开浏览器；弹出的控制台窗口不要关，关掉就等于停止）。
- **停止**：双击 `stop.bat`，或直接关掉 `start.bat` 的控制台窗口，或 `Ctrl+C`。
- 命令行：
  ```powershell
  cd <解压目录>
  node server.mjs              # 启动（前台运行，Ctrl+C 停止）
  ```
- 检查是否在跑：打开 <http://127.0.0.1:5174>，能看到登录页就说明服务正常。
- 端口被占用时启动会报 `EADDRINUSE`，先跑一次 `stop.bat` 再启动。

然后打开 <http://127.0.0.1:5174>（局域网设备用控制台里打印的 `http://<局域网IP>:5174`）。

**初始口令**：首次运行会随机生成，打印在服务端控制台，也写入 `data/FIRST_RUN_PASSWORD.txt`。登录后到「设置 → 修改面板口令」改掉，文件会自动删除。也可以在启动前设环境变量：

```powershell
$env:PANEL_PASSWORD = 'your-password'; node server.mjs
```

## 添加机器

1. 打开 <https://instabox.sh>，登录后右上角账号菜单 → **Profile → API keys** → **Create Key**
2. 权限选 **Restricted**，勾 `machines:read` + `machines:write` 即可（不要用 Full access）
3. 复制 `ibk_...`（只显示一次），在面板「＋ 添加机器」粘贴

一把 key 会自动发现该账号/工作区下的全部机器；多把 key 分多次添加。

## 功能

- **卡片**：状态、规格、运行时长、空闲暂停倒计时、冷却倒计时、CPU/内存/磁盘/网络、错误信息
- **启停**：启动 / 恢复 / 暂停 / 停止，操作中按钮禁用并自动轮询到完成；冷却期（409）会提示剩余时间
- **保活**：activity lease 自动续租（默认 TTL 900s），机器意外暂停 / 停止时先自动恢复再续租；面板关闭则保活停止
- **删除**：只从面板移除监控，**不会**删除云端机器
- **历史**：近 24 小时状态条 + CPU/内存/网络曲线（面板运行期间记录）
- **通知**：状态变化（暂停 / 停止 / 错误 / 恢复）、保活异常，走 SMTP 邮件
- **代理开关**：卡片上启动 / 停止机器里的 Xray（VLESS-WS-TLS），运行中显示公网链接和 `vless://` 二维码，可直接用 FlClash 扫码导入
- **测速**：经代理实测延迟（3 次取平均）和下载速度（4 连接并发、最多 15 秒 / 约 5 MB 采样），同时显示入口 RTT
- **一键导入**：二维码（`vless://`）、下载 YAML、复制 vless 链接三种方式；`https://` 入口地址只是端口地址，不能导入客户端

## 邮件通知（QQ 邮箱）

QQ 邮箱 → 设置 → 账户 → 开启「POP3/SMTP 服务」→ 生成**授权码**。

面板「设置」里填：

| 字段 | 值 |
| --- | --- |
| 服务器 | `smtp.qq.com` |
| 端口 | `465` |
| SSL | 勾选 |
| 发件邮箱 / 发件人 | 你的 QQ 邮箱 |
| 授权码 | 上一步生成的授权码（不是 QQ 密码） |
| 收件人 | 接收通知的邮箱（可以就是自己） |

保存后点「发送测试邮件」验证。

## 数据与安全

| 文件 | 内容 |
| --- | --- |
| `data/machines.json` | API key 与监控列表（明文存储，仅本机；页面只显示掩码） |
| `data/settings.json` | 面板口令哈希（scrypt）、SMTP 配置、轮询间隔、代理控制配置（机器 / SSH 别名 / 端口 / WS 路径） |
| `data/history.jsonl` | 状态/指标历史（24h 滚动） |

- 页面与 `ibk_` key 都不出本机；后端代理调 `api.instabox.sh`（浏览器直连会被 CORS 拒绝）。
- 默认监听 `0.0.0.0` 供局域网访问，**一定要改掉初始口令**；局域网是 HTTP 明文，不要在不可信网络里用。
- 不想开放局域网：`$env:HOST='127.0.0.1'; node server.mjs`

## 唤醒休眠的机器

按"为什么睡"分三种，面板会自动用对的方式：

| 睡眠原因 | 卡片显示 | 唤醒方式 |
| --- | --- | --- |
| 空闲自动暂停 | 空闲暂停于 … | 「唤醒」→ `POST /wake`，平台最长等 45 秒 |
| 你手动暂停 | 手动暂停 | 「恢复」→ `POST /resume` |
| 手动停止 | 已停止 | 「启动」→ `POST /start`（冷启动，内存里的程序不保留） |
| 480 分钟最大运行时长 | 冷却倒计时 | 平台强制冷却 5–20 分钟，期间 wake/resume/start/SSH 全部 `409 machine_cooldown`，结束后再点 |

- 空闲自动暂停的机器也支持"用就醒"（exec、读文件、SSH、公开 URL），但面板的查询/监控流量**不会**唤醒它，所以需要显式点「唤醒」。
- 保活本身不唤醒机器：租约只防止进入空闲暂停；如果已经暂停，续租会 `409 machine_not_running`，面板会自动按上表先唤醒/恢复/启动，再续租。
- `wake` 请求最多会等 45 秒，点「唤醒」后按钮会一直显示"操作中…"，属于正常现象。

## 代理开关（Xray / FlClash）

机器卡片上的「代理」区块是本机通过 **SSH** 控制那台机器里的 Xray 服务，不依赖 InstaBox API：

1. 「设置 → 代理」选机器、填 SSH 别名（例如 `instabox`（你的 SSH 别名））、端口 `8080`、WS 路径 `/ws`，保存。
2. 卡片出现「代理 运行中 / 已停止 / 机器已暂停」，可点 **启动 / 停止**。
3. 运行中显示入口地址（可复制）和三个导入入口：**二维码导入**（`vless://`，FlClash / Shadowrocket / v2rayNG 可扫）、**下载 YAML**（FlClash 用文件导入，最稳）、**复制 vless**（FlClash「从剪贴板导入」）。
4. **测速**：点「测速」会经代理请求 `gstatic` 测 3 次延迟，再通过 4 个并发连接从 `speed.cloudflare.com` 下载最多 5 MB / 15 秒，显示延迟和 Mbps。测速走本机 → 边缘 → 机器整条链路，本机到边缘线路差时数字会很低（不代表机器出口差；机器侧实测可到 40+ Mbps）。
5. 后端只执行固定命令：`sudo systemctl start xray`、`sudo systemctl stop xray`、`instabox-port publish <port> --public`；SSH 别名来自设置，命令不拼接用户输入。
6. 机器暂停时面板**不会**做 SSH 探测（避免把机器唤醒）；点启动会先按 API 唤醒机器（需要已加 `ibk_` key），再启动 Xray。
7. 停止只停 Xray，公网入口保留、链接不变；下次启动即恢复。彻底关入口：`instabox-port unpublish 8080`。

前提：面板所在电脑能用 `ssh <别名>` 免密登录机器（`~/.ssh/config` 配好），且机器上已装好 Xray。部署方法见 [../proxy/README.md](../proxy/README.md)。

> 为什么用 SSH 而不是 InstaBox exec API：exec 走 `ibk_` key 要额外权限，SSH 用现成的免密登录即可，且面板只跑固定命令。

## 公网访问（可选）

需要从外网打开面板，按 [deploy/CLOUDFLARE-TUNNEL.md](deploy/CLOUDFLARE-TUNNEL.md) 配 Cloudflare Tunnel + Access：不需要公网 IP 和端口映射，访问时先过 Cloudflare 邮箱验证码、再过面板口令。面板用 [start-tunnel.bat](start-tunnel.bat) 启动（只监听 `127.0.0.1`）。

没有域名、只想自己几台设备用，更推荐 Tailscale / ZeroTier 组网，公网不暴露。

## 已知边界

- 面板无法关闭平台的空闲休眠（普通账号锁死 30 分钟），只能用 activity lease 保活；
- 测速数字走「本机 → 边缘 → 机器」，本机到边缘的线路差时会很低，不代表机器出口差；每次测速约消耗 5 MB 出口流量；
- 免费机连续运行 480 分钟后暂停 + 5–20 分钟冷却，面板只能显示倒计时，不能绕过；
- 停止会结束机器里的进程（文件保留），停止后需「启动」才能恢复；
- 只支持 `ibk_` API key；`ibssh_` SSH 令牌是另一套凭证（只能 SSH 登录，不能启停），暂未接入。

## 目录

```
instabox-panel/
  server.mjs            后端
  public/               页面 / 前端逻辑 / 样式
  lib/vless.mjs         测速用的 VLESS 客户端
  node.exe              内置 Node.js 运行时
  start.bat             双击启动
  stop.bat              停止
  start-tunnel.bat      只监听 127.0.0.1（配合内网穿透）
  deploy/               公网访问（Cloudflare Tunnel）说明
  proxy/                可选：机器上的 Xray 代理
  data/                 运行时生成：machines.json / settings.json / history.jsonl
```

## 自测

发行包不带测试脚本；开发目录里的 
ode test/smoke.mjs / 	est/layout.mjs / 	est/visual.mjs 需要 mock 环境，普通用户可忽略。
