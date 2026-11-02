#!/usr/bin/env bash
# 在 InstaBox 机器里运行，安装 Xray-core（VLESS + WebSocket 入站）并注册 systemd 服务。
#   bash install.sh
#   PORT=9090 WS_PATH=/abc123 bash install.sh
#   ROTATE=1 bash install.sh          # 换新 UUID（会让旧客户端失效）
#
# 说明：InstaBox 公网端口是 HTTPS 反向代理，TLS 在边缘终止，
#       所以这里只跑明文 WS，不要在本配置里加 TLS。
set -euo pipefail

PORT="${PORT:-8080}"
WS_PATH="${WS_PATH:-/ws}"
CONF_DIR="/usr/local/etc/xray"
CONF="$CONF_DIR/config.json"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "PORT 不合法: $PORT" >&2
  exit 1
fi

echo "==> 安装依赖"
sudo apt-get update -y >/dev/null
sudo apt-get install -y curl unzip ca-certificates >/dev/null

# 官方脚本依赖 GitHub API，共享出口 IP 容易被 403；失败时直连下载 release 资源。
install_xray_manual() {
  local tmp url code
  tmp="$(mktemp -d)"
  url="https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip"
  code="$(curl -sSL -o "$tmp/xray.zip" -w '%{http_code}' "$url" || true)"
  if [ "$code" != "200" ]; then
    echo "==> 直连下载失败($code)，尝试镜像"
    url="https://gh-proxy.com/https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip"
    code="$(curl -sSL -o "$tmp/xray.zip" -w '%{http_code}' "$url" || true)"
  fi
  if [ "$code" != "200" ]; then
    echo "下载 Xray 失败 (HTTP $code)" >&2
    rm -rf "$tmp"
    return 1
  fi
  unzip -oq "$tmp/xray.zip" -d "$tmp/xray"
  sudo install -m 755 "$tmp/xray/xray" /usr/local/bin/xray
  sudo mkdir -p /usr/local/share/xray
  sudo install -m 644 "$tmp/xray/geoip.dat" "$tmp/xray/geosite.dat" /usr/local/share/xray/
  rm -rf "$tmp"
  sudo tee /etc/systemd/system/xray.service >/dev/null <<'UNIT'
[Unit]
Description=Xray Service
After=network.target

[Service]
ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray/config.json
Restart=on-failure
RestartPreventExitStatus=23
Environment=XRAY_LOCATION_ASSET=/usr/local/share/xray

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable xray >/dev/null 2>&1 || true
}

if ! command -v xray >/dev/null 2>&1; then
  echo "==> 安装 Xray-core（官方脚本）"
  if ! sudo bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install; then
    echo "==> 官方脚本失败，改用直连下载 + systemd"
    install_xray_manual
  fi
fi

XRAY_BIN="$(command -v xray || true)"
if [ -z "$XRAY_BIN" ] && [ -x /usr/local/bin/xray ]; then
  XRAY_BIN=/usr/local/bin/xray
fi
if [ -z "$XRAY_BIN" ]; then
  echo "Xray 安装失败：找不到 xray 可执行文件" >&2
  exit 1
fi

echo "==> 生成/复用配置"
EXISTING_UUID=""
if [ -f "$CONF" ]; then
  EXISTING_UUID="$(grep -oE '"id"[[:space:]]*:[[:space:]]*"[0-9a-fA-F-]{36}"' "$CONF" | head -1 | grep -oE '[0-9a-fA-F-]{36}' || true)"
fi
if [ -n "${ROTATE:-}" ] || [ -z "$EXISTING_UUID" ]; then
  UUID="$("$XRAY_BIN" uuid)"
else
  UUID="$EXISTING_UUID"
fi

sudo mkdir -p "$CONF_DIR"
sudo tee "$CONF" >/dev/null <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "listen": "0.0.0.0",
      "port": ${PORT},
      "protocol": "vless",
      "settings": {
        "clients": [{ "id": "${UUID}" }],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "ws",
        "wsSettings": { "path": "${WS_PATH}" }
      }
    }
  ],
  "outbounds": [
    { "protocol": "freedom", "settings": {} },
    { "protocol": "blackhole", "settings": {}, "tag": "block" }
  ],
  "routing": {
    "rules": [
      { "type": "field", "ip": ["geoip:private"], "outboundTag": "block" }
    ]
  }
}
EOF
sudo chmod 600 "$CONF"

echo "==> 启动服务"
sudo systemctl enable xray >/dev/null 2>&1 || true
sudo systemctl restart xray
sleep 1
if ! systemctl is-active --quiet xray; then
  echo "Xray 启动失败，看日志：" >&2
  sudo journalctl -u xray -n 30 --no-pager >&2 || true
  exit 1
fi

# 本机自检
LOCAL_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" || true)"

cat <<EOF

============================================================
Xray 已运行：0.0.0.0:${PORT}，WS 路径 ${WS_PATH}
本机 HTTP 自检状态码：${LOCAL_CODE}（404/400 都是正常的，说明 Xray 在听）

UUID: ${UUID}

下一步（在能调用 InstaBox API 的电脑上）：
  \$env:INSTABOX_API_KEY = 'ibk_...'
  npx instabox@latest port publish <machine> ${PORT} --private

拿到 https://${PORT}-<机器ID去掉m_>.instabox.tech 后：
  1) curl 验证 /${WS_PATH} 能返回 101
  2) 把域名/UUID/路径填进 FlClash 配置

注意：机器空闲 30 分钟会被暂停，下一次请求会自动唤醒（首包等 ≤45 秒）。
============================================================
EOF
