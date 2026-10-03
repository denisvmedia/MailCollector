# Mail Collector

Mail Collector 是一个自建的多邮箱聚合客户端。当前架构以 **VPS 作为长期在线的邮件同步核心**，Windows 和 Android 是地位相同的客户端。

## 架构

```text
Gmail / Outlook / QQ / 163 / IMAP
                 │
                 │ IMAP / SMTP / OAuth
                 ▼
          VPS Mail Collector
      同步调度 · 账户凭据 · API
                 │
          HTTPS  │
        ┌────────┴────────┐
        ▼                 ▼
  Windows Client     Android Client
  本地邮件缓存        本地邮件缓存
  独立登录            独立登录
```

核心原则：

- Windows 和 Android 都不依赖另一台设备在线。
- 两端都直接连接同一个 VPS。
- 邮件服务商只由 VPS 负责同步，避免每台设备都建立一套 IMAP IDLE/轮询连接。
- 客户端会把已经读取的账户、邮件列表、邮件正文和标签数据缓存到本地，网络不可用时可回读最近缓存。
- VPS 保留同步所需的服务端数据库和加密凭据，是设备之间的一致性来源。
- Windows 安装包不再内置 Node 邮件服务、SQLite 邮件主库或 FRP。
- 不再需要“电脑批准手机”或“VPS FRP Relay”才能使用 Android。

旧的 `v0.10.1-vps-relay-preview.1` 架构仍可作为历史版本使用，但它要求 Windows 在线；新架构不再使用该依赖关系。

## VPS 一键部署

准备一台 Ubuntu/Debian VPS、一个已经解析到该 VPS 的域名，并放行 TCP 80/443。无论 VPS 是否已经安装 1Panel/OpenResty，都只运行这一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/ArronHC/MailCollector/main/scripts/install-vps.sh | sudo bash
```

脚本只会询问一次公网域名，例如 `mail.example.com`，其余工作全部自动完成：

- 安装 Docker Engine 与 Compose
- 生成加密密钥、API Key 和管理员邀请码
- 80/443 空闲时配置 Caddy 与自动 HTTPS
- 检测到 1Panel/OpenResty 等现有 Web 服务时，自动改用本机回环端口并显示反向代理目标
- 拉取并启动最新 GHCR 镜像
- 等待服务健康后显示客户端地址和管理员邀请码
- 安装 `mailcollector` 管理命令

安装完成后，终端会集中显示：

```text
URL:                  https://mail.example.com/
Administrator invite: <管理员邀请码>
Administrator exists: no
Service version:      0.12.0
```

以后无需再寻找 `.env`，直接使用：

```bash
sudo mailcollector info      # 查看地址和管理员邀请码
sudo mailcollector update    # 更新到最新镜像并等待服务恢复
sudo mailcollector status    # 查看容器状态
sudo mailcollector logs      # 查看实时日志
sudo mailcollector restart   # 重启服务
```

需要无人值守或自定义目录时，仍可传入参数：

```bash
sudo bash install-vps.sh --domain mail.example.com
sudo bash install-vps.sh --domain mail.example.com --email you@example.com --dir /opt/mail-collector
```

已有安装再次运行一键命令时，会自动读取原域名并保留已有密钥与数据，只更新部署配置和镜像。

如果 80/443 已被 1Panel/OpenResty 占用，安装器不会停止现有网站服务，也不会启动自带 Caddy。Mail Collector 会自动绑定到 `127.0.0.1:18080`（端口冲突时顺延选择空闲端口），终端会显示需要填写到 1Panel 反向代理中的目标地址。以后执行 `sudo mailcollector update` 或 `restart` 会持续沿用该模式。

## 首次注册与登录

VPS 第一次启动后还没有管理员账户。

Windows 或 Android 第一次连接 VPS 时：

1. 填写 `https://mail.example.com`。
2. 进入注册界面。
3. 输入邮箱、密码和安装完成页显示的管理员邀请码；之后可用 `sudo mailcollector info` 重新查看。
4. 注册成功后，该客户端会得到独立的登录 session token。
5. 另一台设备直接连接同一个 VPS 并使用同一账户登录即可。

原生客户端使用 Bearer session，不依赖跨域 Cookie，因此 Windows 和 Android 的认证模型一致。

## 添加邮箱

### Gmail

推荐 OAuth。

在 Google Cloud 创建“桌面应用”类型的 OAuth Client ID，然后在 Windows 客户端打开“设置 → 邮箱 OAuth”，填写 Google Client ID。添加 Gmail 时，Windows 会通过系统浏览器和本机随机回环端口完成 PKCE 授权，再通过已登录的 HTTPS 会话把续期凭据交给 VPS。VPS加密保存 refresh token 和该账户对应的公开 Client ID，负责后续 IMAP/SMTP 同步；手机不需要 Client ID。

也可以使用 Google 支持的应用专用密码方式连接 IMAP/SMTP。

### Outlook / Microsoft 365

推荐 OAuth：

在 Microsoft Entra 应用注册中启用公共客户端流和 `http://localhost` 回调，添加 IMAP/SMTP delegated scopes，然后在 Windows 客户端“设置 → 邮箱 OAuth”中填写 Microsoft Client ID。首次授权在 Windows 本地完成；VPS和手机都不需要单独配置 Client ID。

Windows 添加完成后，账户立即进入 VPS 主库。VPS持续向邮件服务商同步，Windows和Android从同一 VPS 获取账户与邮件；这不是要求 Windows 长期在线。

### QQ / 163 / 126 / iCloud

先在邮件服务商后台开启 IMAP/SMTP，并使用服务商生成的授权码或 App 专用密码。

## 客户端缓存

Windows 和 Android 使用相同的前端缓存层。

当前缓存策略：

- 账户列表：本地缓存
- 标签：本地缓存
- 邮件列表：按查询条件缓存
- 已打开的邮件正文：本地缓存
- 在线读取成功后自动刷新缓存
- 网络请求失败时，GET 请求会尝试返回最近一次本地缓存

缓存只是客户端副本，不是新的同步主库。已读、星标、移动、删除、发信等修改操作仍提交到 VPS，再由 VPS 同邮件服务商同步。

## Windows 客户端

Windows 现在是纯客户端：

```text
Tauri
  └─ React UI
       ├─ HTTPS → VPS
       └─ IndexedDB 本地缓存
```

安装包不再启动本地 Node sidecar，也不会因为关闭 Windows 导致 Android 离线。

## Android 客户端

Android 与 Windows 使用同一套 API、认证和缓存逻辑：

```text
Capacitor
  └─ React UI
       ├─ HTTPS → VPS
       └─ 本地 WebView / IndexedDB 缓存
```

首次启动只需要填写 VPS 地址并登录，不再输入电脑生成的 6 位配对码。

## 更新

- Windows 客户端检测到新版本后，可在应用内下载安装器与 SHA-256 校验文件，校验通过后静默覆盖安装并重新启动，不需要进入 GitHub 手动下载安装包。
- VPS 执行 `sudo mailcollector update` 即可更新；Docker 只拉取发生变化的镜像层，数据库和配置卷保持不变。
- Android 暂不提供应用内增量更新；每次客户端 Release 会同时发布版本化 APK 与 SHA-256 校验文件，可直接下载安装。

## 开发

服务端开发和测试还需安装 [Ptah 0.12.0](https://github.com/stokaro/ptah/releases/tag/v0.12.0)，将 `ptah` 放入 `PATH`，或通过 `PTAH_BIN` 指定可执行文件路径。Docker 镜像已包含该工具；Windows 和 Android 客户端不需要安装。数据库升级与搜索索引说明见 [Database migrations](migrations/README.md)。

安装依赖：

```bash
npm ci
```

类型检查：

```bash
npm run typecheck
```

测试：

```bash
npm test
```

构建 VPS 服务和 Web：

```bash
npm run build
```

运行 VPS 服务：

```bash
npm start
```

开发 Web：

```bash
npm run dev:web
```

构建 Windows：

```bash
npm run dist:win
```

## 数据与安全

VPS 的 `data` 目录需要持久化和备份，其中包含：

- SQLite 同步数据库
- 加密后的邮箱账户信息
- OAuth refresh token 加密存储
- 邮件同步状态

不要公开 `API_KEY`、`ENCRYPTION_KEY` 或注册邀请码。

原生客户端只保存自己的登录 session 和本地邮件缓存，不保存 VPS 的主 API Key。

## 从旧 VPS Relay 预览版迁移

旧架构：

```text
Android → HTTPS → VPS/frps → Windows/frpc → Windows sidecar
```

新架构：

```text
Windows ─┐
         ├→ HTTPS → VPS Mail Collector → 邮件服务商
Android ─┘
```

迁移时保留旧 Windows 数据作为备份，然后在 VPS 部署新的服务端数据目录并重新连接邮箱。确认 VPS 同步正常后，再让 Windows 和 Android 都指向新的 HTTPS 地址。
