# Local 模式网络审计（保留上游联网行为）

审计基线：管理器 `aliasmode/aliasmode`，commit `0361bf4d4c53c993e5df80f1e7a2b6e9eb8a3538`（0.1.0-beta.74）。这是源码路径审计和自动化测试，不是 macOS 安装包抓包结果，也不是对浏览器内核、依赖包或所有第三方服务的完整安全认证。

## 结论

“Continue locally” 会保存 Local 模式并重启桌面进程。后续启动不会构建 Cloud 登录、同步、设备连接和远程 MCP 通道；`cloudRuntimeConfiguration` 在非 Cloud 模式返回 null。已有 Cloud 会话切换时，在途请求不能被撤回，需等重启完成。默认 `localAnalytics` 为 false。商城事件收集也由 Cloud 商城状态控制。

但是原版 Local **并非零外连**。无需登录也能发生更新检查、运行时预下载、服务推荐目录请求；公开脚本库仍会访问 Cloud 的匿名接口。未发现 Local 模式常规启动把整个 Profile、cookie 或浏览历史上传到 Cloud 的代码路径，但不能把这一静态结论当作“绝无泄漏”的保证。

## 本 fork 的联网策略（保持上游原版）

- 按用户最新要求，**保留 GitHub 更新检查及安装、引擎/字体/Python 正常下载和预下载**，没有禁用这些正常功能。
- 按用户最新要求，**恢复 Services 原版联网方式**：Local 和 Cloud 打开页面时均请求在线目录，使用 15 分钟缓存，失败时回退随包目录。推荐链接仍会访问外部站点。此前的 Local 内置目录限制已移除。
- 没有删除 Cloud、同步、商城或脚本功能；明确选择 Cloud 时原功能仍可运行。这不是系统级网络阻断器。
- **更新风险**：原版签名更新安装包可能覆盖本 fork 的 URL 分流和设备随机化修改。当前按要求保留更新功能，但本 fork 尚未配置自有签名发布通道；需要保留定制功能时应从 fork 构建安装。

相关实现：`ui.ts`、`services-directory.ts`，Services 的网络请求和缓存行为与上游一致。测试覆盖 Local 请求在线目录，以及原 Services API 的隐藏/显示操作。

## 仍可能发生的非浏览器网络交互

| 触发 | 目的方 | 可见数据及说明 |
| --- | --- | --- |
| 启动自动/手动检查更新，显式安装更新 | `api.github.com/repos/aliasmode/aliasmode/releases`，`github.com/aliasmode/aliasmode/releases/...` | 版本/平台相关资源请求、来源 IP 和常规 HTTP 元数据。安装仍使用上游签名发行包，可能覆盖 fork 定制功能。 |
| 启动/保存 Profile 后预下载，首次打开缺少组件的 Profile，显式安装引擎 | `github.com/aliasmode/aliasmode-chromium`、`github.com/CloakHQ/CloakBrowser`，部分下载回退 `cloakbrowser.dev`；GitHub 下载可能重定向到资产 CDN | 请求的引擎版本/系统/架构和来源 IP。下载按现有固定版本/hash 校验机制验证，不向服务商提供 Profile 内容。Mac Chromium 使用的实际二进制由现有平台 manifest 决定。 |
| Profile 创建/导入/启动时预下载，以及 Firefox 跨系统字体缺失 | `github.com/aliasmode/aliasmode-firefox/releases/...` | 字体包系统/版本和来源 IP，可预下载或首次启动按需下载。已打包 Firefox 本体与字体下载不是同一回事。 |
| 已保存 Python 脚本的启动/列表/保存预下载，运行脚本或显式安装 Python | `github.com/astral-sh/python-build-standalone`、`files.pythonhosted.org`；Windows 另有 `www.python.org` | Python/轮子资源路径、版本、平台和来源 IP。源码模式用系统 Python。运行的用户脚本本身可能另行联网。 |
| 配置代理、创建/编辑/批量替换代理 Profile、某些导入、打开代理 Profile、恢复仍运行的 Profile | `get.geojs.io/v1/ip/geo.json`、`http://ip-api.com/json/...`，回退 `v6.ipinfo.io/json` | 通过代理查询出口 IP、时区和国家；服务看到代理出口和请求元数据，代理运营商处理认证。`ip-api.com` 路径仍是明文 HTTP，保留原兼容行为，网络中间人可能看到/篡改查询响应。 |
| 启动时处理已排队的 inbox 导入 / inbox 文件新增 | 同上地理定位服务 | 对新提供/变化且缺时区的 Chromium 代理可能自动做查询。有待处理导入或存活浏览器时也不能声称启动绝无外连。见 `inbox.ts`、`geoip.ts`。 |
| 手动代理检查 / 诊断 | `ipinfo.io/json`、`api64.ipify.org`（可由 `ALIASMODE_EGRESS_ENDPOINTS` 配置） | 可能同时检测本机直连与代理，直连检测服务看到真实公网 IP。某些诊断另由被管理浏览器执行。 |
| 打开 Public library、搜索、查看/导入公开脚本 | 默认 `cloud.aliasmode.com` 的公开脚本 API，可由配置改变 | 匿名请求仍泄露来源 IP、搜索文本、语言、分页和脚本 ID。Local 脚本编辑/保存为本地；发布要求 Cloud。见 `scripts.ts`、`cloud-client.ts`，匿名路径已有测试。 |
| 打开 Services 页面（缓存过期时） | `aliasmode.com/_am/services` | 来源 IP 和常规 HTTP 元数据；请求不带 cookie 或用户参数。15 分钟缓存，失败时使用随包目录。Local 与 Cloud 一致。 |
| 点击 Services 的 Visit | `aliasmode.com/go/<slug>`，然后跳转合作服务 | 服务 slug、来源 IP 和点击时间；上游明确说明会统计点击。`nobleproxy.com`、`xreacher.com` 链接带推广归因参数。此行为保持上游原版。 |
| 点击支持/条款/隐私/社区等链接 | `aliasmode.com`、GitHub、Telegram、Xreacher 等 | 常规网页访问。通常交由系统/选择的浏览器打开，属于明确点击，而非后台遥测。 |
| 从 Chrome Web Store 安装扩展 | `clients2.google.com/service/update2/crx` 及其下载跳转 | 扩展 ID、版本相关参数和来源 IP；本地 ZIP 导入不需要这一下载。扩展安装后自行发起的流量需另查。 |
| 源码环境显式 setup / 构建安装 | `nodejs.org`、Bun/npm 包仓库、Rust crates、构建脚本中的运行时资源站点 | 开发安装流量，不应与已安装管理器的日常后台流量混为一谈。 |

`web` 中大部分 `/ui/api/...` 请求是到本机回环服务器，并不直接意味着外部传输；需要看对应服务端实现。内置字体本地打包，Services 图标只接受内联 data 图片。

## 验证和建议

自动化覆盖了 Services 在线请求、缓存、离线回退，以及 Local Services API。下载、更新及 Cloud 相关已有测试由项目测试集覆盖。这不替代集成抓包。

发布前在 macOS 实机分别测试：全新 Local 安装、重新启动、有/无已运行 Profile、有/无 inbox 文件、打开 Services、保存代理 Profile、启动 Profile、手动版本检查、运行脚本。用系统连接监控或代理抓取按进程区分管理器 sidecar、Tauri 与浏览器。不要把浏览器的网站、Safe Browsing、扩展、更新或 DNS 流量算作已经被管理器策略覆盖。

如果目标是严格不访问开发者/第三方服务，需要另设明确的离线/出口白名单模式，并决定是否牺牲公开脚本库、代理自动时区/检测、下载和更新检查；本次没有通过删除大量代码或关闭身份安全检查来伪装零外连。
