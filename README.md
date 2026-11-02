# InstaBox 面板

本地监控 InstaBox 沙箱机器：状态 / CPU / 内存 / 磁盘 / 网络、启动 / 恢复 / 暂停 / 停止、保活、邮件通知。
可选：控制机器里的 Xray 代理（VLESS-WS-TLS），生成 vless 链接 / 二维码 / YAML 给 FlClash 导入，并测延迟和下载速度。

> 除了你自己的 InstaBox API key，其余数据都只存本机（`data/`），不上传。

## 两种用法

- **开箱即用（不用装 Node）**：到 [Releases](https://github.com/linjiaminaaa/instabox-panel/releases/latest) 下载 `instabox-panel-v1.2.0.zip`，
  解压后双击 `start.bat`。压缩包内置了 Windows x64 的 Node 运行时。
- **源码运行**：克隆本仓库，安装 Node.js 18+（建议 24），然后 `node server.mjs`（或双击 `start.bat`，没有内置 node.exe 时会用系统 node）。

## 1. 准备

- Windows 10/11 64 位（Linux / macOS 也能跑：`node server.mjs`）
- InstaBox 账号 → 右上角账号菜单 → **Profile → API keys → Create Key**
  - 权限选 **Restricted**，勾 `machines:read` + `machines:write`
  - 复制 `ibk_...`（只显示一次）

## 2. 启动

双击 `start.bat`（Release 包内置 Node；源码仓库会回退到系统 node）。首次运行会自动生成面板口令。

浏览器打开 <http://127.0.0.1:5174>。

- **首次口令**：启动后的控制台会打印，也写在 `data/FIRST_RUN_PASSWORD.txt`
- 登录后到 **设置 → 修改面板口令** 改掉；改完该文件会自动删除

## 3. 配置 key

右上角 **＋ 添加机器** → 粘贴 `ibk_...` → 自动发现该账号/工作区下的全部机器。

一把 key 对应一个账号；多个账号就多加几把 key。之后卡片上就能看状态、启停、保活。

## 停止

双击 `stop.bat`，或关闭 `start.bat` 的控制台窗口。

## 可选：代理（FlClash）

只用监控不需要这一步。需要时见 [proxy/README.md](proxy/README.md)：

1. 在机器里装 Xray 并发布 8080（脚本 `proxy/install.sh`）
2. 本机配好 SSH 免密别名（例如 `instabox`）
3. 面板 **设置 → 代理**：选机器、填 SSH 别名、端口 `8080`、WS 路径 `/ws`
4. 卡片上点 **启动** → 二维码导入 / 下载 YAML / 复制 vless；点 **测速** 看延迟和下载

## 目录

```
server.mjs            后端（零依赖，node:http）
public/               前端（原生 HTML/CSS/JS，无构建）
lib/vless.mjs         测速用的最小 VLESS 客户端
start.bat             启动（会打开浏览器）
stop.bat              停止（按端口 5174）
start-tunnel.bat      只监听 127.0.0.1，给内网穿透用
deploy/               Cloudflare Tunnel + Access 部署说明
proxy/                可选：机器上的 Xray 代理（安装脚本 + 示例配置）
docs/panel.md         面板详细说明
data/                 运行时生成：口令哈希、key、历史（不要外传）
```

Release 包比源码多一个 `node.exe`（内置 Node 运行时）。源码仓库不含它，`start.bat` 会自动回退到系统 node。

## 详细说明

- 面板功能 / 邮件通知 / 数据与安全：[docs/panel.md](docs/panel.md)
- 代理安装与客户端配置：[proxy/README.md](proxy/README.md)
- 公网访问（Cloudflare Tunnel，可选）：[deploy/CLOUDFLARE-TUNNEL.md](deploy/CLOUDFLARE-TUNNEL.md)

## 已知限制

- 免费机连续运行 480 分钟会被平台强制暂停（冷却 5–20 分钟），面板只能倒计时；
- 免费机空闲 30 分钟自动暂停，面板可用 activity lease 保活（面板关掉就停）；
- 免费出口 100 GiB/月、约 50 Mbit/s；
- 面板本身是局域网 HTTP，公网暴露请务必先改口令并套 Cloudflare Access 或 Tailscale。

## License

[MIT](LICENSE)
