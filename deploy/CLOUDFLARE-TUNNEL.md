# 用 Cloudflare Tunnel + Access 安全地开放 InstaBox 控制台

目标：外网访问 `https://panel.example.com`，**不需要公网 IP、不需要路由器端口映射**，并且先过 Cloudflare Access 登录，再过面板口令。

```
浏览器 ──HTTPS──> Cloudflare 边缘（Access 登录 + TLS 终止）
                      │
                      │ 出站连接（cloudflared，无入站端口）
                      ▼
              你 Windows 上的 cloudflared
                      │ http://127.0.0.1:5174
                      ▼
               InstaBox 控制台（node server.mjs）
```

> 重要顺序：**先创建 Access 应用，再创建 DNS 路由**。官方文档明确说：没有 Access 应用时，挂上隧道的域名任何人都能访问。

---

## 0. 先决条件

- 一个已接入 Cloudflare 的域名（免费套餐即可）：在 Cloudflare 添加站点 → 到域名注册商把 NS 改成 Cloudflare 给的两个地址。
- 面板能在本机跑起来（`start.bat` 或 `node server.mjs`）。
- Windows 管理员权限（安装 cloudflared、装服务）。

没有域名？见文末「备选方案」，不要用临时隧道长期挂带 key 的面板。

---

## 1. 安装 cloudflared

任选一种：

```powershell
# winget
winget install --id Cloudflare.cloudflared

# 或到官方下载 exe，放到 C:\Program Files\cloudflared\
# https://github.com/cloudflare/cloudflared/releases/latest
```

验证：

```powershell
cloudflared --version
```

---

## 2. 让面板只监听本机（推荐）

双击 [start-tunnel.bat](../start-tunnel.bat) 启动面板（它设置 `HOST=127.0.0.1`），这样只有本机的 cloudflared 能连，局域网/公网都碰不到 5174。

> 如果你还要局域网访问，可以继续用 `start.bat`（监听 0.0.0.0），隧道走 `127.0.0.1:5174` 一样通；但多一层暴露面，自己权衡。

先确认本机可访问：<http://127.0.0.1:5174>。

---

## 3. 创建命名隧道

```powershell
# 打开浏览器授权，选择你的域名所在 zone
cloudflared tunnel login

# 创建隧道（名字随意，这里叫 instabox-panel）
cloudflared tunnel create instabox-panel
```

`create` 会输出一个 Tunnel ID（形如 `6ff42ae2-...`），并在 `%USERPROFILE%\.cloudflared\` 生成 `<TUNNEL_ID>.json` 凭证文件。`login` 还会生成 `cert.pem`。

创建配置文件 `%USERPROFILE%\.cloudflared\config.yml`（可直接复制 [cloudflared-config.example.yml](cloudflared-config.example.yml) 再改）：

```yaml
tunnel: <上一步的 TUNNEL_ID>
credentials-file: C:\Users\<你的用户名>\.cloudflared\<TUNNEL_ID>.json

ingress:
  - hostname: panel.example.com
    service: http://127.0.0.1:5174
  - service: http_status:404
```

---

## 4. 先建 Cloudflare Access（顺序别反）

1. 打开 <https://one.dash.cloudflare.com>，首次会让你起一个 team name（团队域名，形如 `yourname.cloudflareaccess.com`）。
2. 左侧 **Access → Applications → Add an application → Self-hosted**。
3. 填：
   - **Application name**：`InstaBox 控制台`
   - **Session duration**：`24 hours`（免费套餐上限 24h）
   - **Application domain**：`panel.example.com`（子域名 + 域名，路径留空）
4. **Add policy**：
   - Action：`Allow`
   - Include → **Emails** → 填你自己的邮箱（多个就多条）
   - 不要加 Bypass 策略
5. **Login method**：保持 `One-time PIN`（默认启用，会往邮箱发验证码）；想用 Google/GitHub 登录就再启用对应项。
6. Save，回到应用列表确认状态是 `Enabled`。

此时还没加 DNS 路由，域名暂时访问不到，正常。

---

## 5. 建 DNS 路由并启动隧道

```powershell
cloudflared tunnel route dns instabox-panel panel.example.com
```

这会在 Cloudflare 里创建一条**代理（橙色云）CNAME** 指向 `<TUNNEL_ID>.cfargotunnel.com`。如果提示记录已存在，先删掉同名记录，或加 `--overwrite-dns` 重跑。

前台试跑：

```powershell
cloudflared tunnel run instabox-panel
```

看到 `Registered tunnel connection` 即成功。浏览器打开 `https://panel.example.com`：

1. 先跳 Cloudflare Access 登录页 → 收邮箱验证码 → 通过；
2. 再看到面板自己的口令登录页 → 输入面板口令；
3. 进入控制台。

两层都过才看得到。第一次访问如果直接看到面板口令页，说明 Access 没生效，回第 4 步检查应用 domain 是否完全一致。

---

## 6. 开机自启

### 方案 A：任务计划程序（推荐，配置留在用户目录）

1. `Win+R` → `taskschd.msc` → 创建任务
2. 常规：名称 `InstaBox Tunnel`，勾「不管用户是否登录都要运行」（需要输入 Windows 密码）或「只在用户登录时运行」
3. 触发器：`登录时`（或 `启动时`）
4. 操作：启动程序 `cloudflared`
   - 参数：`tunnel run instabox-panel`
   - 起始于：`C:\Users\<你的用户名>\.cloudflared`
5. 条件：取消「只有在使用交流电源时才启动」；设置里勾「如果任务失败，每 1 分钟重启，最多 999 次」

面板本身也要开机自启，可以同样建一个任务跑 `C:\path\to\instabox-panel\server.mjs`。

### 方案 B：Windows 服务

```powershell
# 管理员终端
cloudflared service install
```

服务以 SYSTEM 运行，默认读取 `C:\Windows\System32\config\systemprofile\.cloudflared\config.yml`。所以要把 `config.yml` 和 `<TUNNEL_ID>.json` 复制到该目录：

```powershell
$dst = "C:\Windows\System32\config\systemprofile\.cloudflared"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "$env:USERPROFILE\.cloudflared\config.yml" $dst
Copy-Item "$env:USERPROFILE\.cloudflared\*.json" $dst
Start-Service cloudflared
```

验证：

```powershell
cloudflared tunnel info instabox-panel
Get-Service cloudflared
```

服务起不来时看「事件查看器 → Windows 日志 → 应用程序」里的 cloudflared 条目，通常就是 config/凭证路径问题。

---

## 7. 加固清单（逐条过一遍）

- [ ] 面板口令改成强口令（`data/FIRST_RUN_PASSWORD.txt` 里的初始口令作废）
- [ ] Access 策略只放你的邮箱，没有 Bypass
- [ ] Tunnel 域名是 HTTPS（Cloudflare 边缘证书自动签发，无需自己配）
- [ ] 不用 `cloudflared tunnel --url ...` 的 trycloudflare 临时隧道长期挂面板（无 Access、URL 每次变）
- [ ] `cloudflared` 保持更新（`winget upgrade Cloudflare.cloudflared`）
- [ ] 看到 Access 日志（Zero Trust → Logs → Access）里没有陌生邮箱反复尝试
- [ ] 面板里的 `data/machines.json` 是 `ibk_` 明文，**备份/共享时注意**

几个要知道的点：

- **Cloudflare 会在边缘解密 TLS**，所以它"看得到"面板流量内容；这是 CDN 类方案的固有属性，介意就别用公网方案。
- 经过 Tunnel 后，面板看到的客户端 IP 全是 `127.0.0.1`，登录限流从"每 IP 8 次/分"变成"全局 8 次/分"——这反而更安全，但要知道。
- Access 保护的是域名；不要同时给同一主机名建别的未受保护记录。
- 免费套餐：Tunnel 免费，Access 免费最多 50 个用户，够个人用。

---

## 8. 备选方案

**没有域名，只想临时看两眼**：

```powershell
cloudflared tunnel --url http://127.0.0.1:5174
```

会得到一个 `https://xxxx.trycloudflare.com` 随机地址，**没有 Access**，只有面板口令一层，且重启就变、无 SLA。只建议在可信网络里临时用，看完就关。

**只想自己几台设备访问、不想公开**：用 Tailscale / ZeroTier 组网，设备间直连，公网根本扫不到；配置比 Tunnel 还简单。这也是我更推荐给"个人自用面板"的方案。

---

## 9. 排错

| 现象 | 排查 |
| --- | --- |
| `502 Bad Gateway` | 面板没启动 / 端口不是 5174 / `config.yml` 的 service 地址写错 |
| `1033` | cloudflared 没连上 Cloudflare：看 `cloudflared tunnel run` 输出、公司网络是否拦 UDP 7844（会自动降级 http2） |
| 域名打不开但无报错 | `cloudflared tunnel info instabox-panel` 看是否有连接；DNS 是否橙色云 |
| Access 登录后循环跳转 | 清 cookie；确认应用 domain 与访问的完全一致（含端口/路径） |
| 服务启动失败 | config/凭证复制到 systemprofile 目录；看事件查看器 |
| 想停掉公网入口 | `Stop-Service cloudflared` 或删除 DNS 路由 / 隧道 |

---

参考：Cloudflare 官方文档 [Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)、[自托管应用 + Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。
