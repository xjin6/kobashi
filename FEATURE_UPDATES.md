# Kobashi Feature Updates

这份文件是 Kobashi 的能力清单和增量更新记录，供后续维护及 TokenX 对齐使用。
它记录实际行为、实现入口、验证方式和适用范围；TokenX 可以先按稳定的 `KB-*`
编号核对能力，再阅读上次同步日期之后的更新。

基线核对日期：**2026-11-28**。基线来自仓库源码、测试和 Git 历史，版本字段当前为
**2.4.1**（本次 Fast 更新；macOS/Windows 发布包均已生成，远端发布状态见更新记录）。这里的“源码已具备”不代表所有改动
都已发布或在每个平台实测，具体构建与验证状态见最新更新记录。
本文没有检查 TokenX 当前源码，因此不预设它缺少哪些能力。

## 每次更新的维护规则

每次新增功能、修复用户可见问题、调整兼容性、UI/尺寸/交互或打包与生命周期行为，
都要在同一次改动中维护本文：新增日期记录，并同步修改受影响的基线条目。
保留既有记录及能力编号；删除或替代的行为也要明确注明。

每条更新至少包含：**能力编号、问题/触发条件、更新后的行为、实现入口、实际验证、
限制/生效条件、TokenX 对齐要点**。版本、打包、发布状态分别记录，不把测试文件的
存在写成“本次测试已通过”。纯文档整理可以补充已有条目，无须制造功能更新。
此约定同时写入 [AGENTS.md](AGENTS.md) 和 [CLAUDE.md](CLAUDE.md)。

## 当前能力基线

### KB-001 · GitHub 登录、额度与代理连接

- **状态：源码已具备。** 支持 GitHub device flow 和 token 登录，保存连接状态并刷新
  Copilot token；面板显示从服务取得的实际额度信息，而非用本地请求数估算。
- 识别系统 HTTP/HTTPS/SOCKS5 代理；直连失败时可发现常用本地代理端口。代理设置
  作用于 Kobashi 自己的上游请求，不改系统全局配置；本地桥接请求保持直连。
- **实现：** [index.js](index.js) 的登录、`ensureCopilotToken`、`getCopilotUsage`
  及上游连接逻辑；[assets/ui.html](assets/ui.html) 的账户及额度面板。
- **TokenX 对齐：** 核对登录恢复、失效 token 的有限重试、真实额度来源、系统代理和
  loopback 例外；不要复制凭证、账户信息或过时的计费倍率假设。

### KB-002 · Codex 实时模型目录与能力验证

- **状态：源码已具备。** 使用当前 Copilot 账号返回的模型目录，按协议、策略和能力
  筛选；新模型必须完成一次真实的流式工具调用验证，HTTP 200 本身不足以入选。
- 每次 Codex 客户端启动执行一次发现/验证轮次，普通对话和重复读取列表复用快照；
  无定时远端探测循环。能力缓存按账户及能力指纹隔离，瞬时失败保留已验证结果。
- 根据模型实际窗口设置上下文与压缩阈值；支持百万上下文的模型采用安全的 1M 上限。
  Ultra 由原生 Codex 元数据和上游推理力度共同确认，不能仅根据模型名称虚构。
- **生效条件：** Codex 原生 picker 在进程启动时读取目录。后台生成的新目录供下次
  完整启动采用；`/v1/models` 可先反映验证结果。Kobashi 不自动重启客户端。
- **实现：** [lib/codex-model-catalog.js](lib/codex-model-catalog.js)、
  [lib/codex-model-capabilities.js](lib/codex-model-capabilities.js)、
  [lib/codex-model-probe.js](lib/codex-model-probe.js)、
  [lib/codex-client-lifecycle.js](lib/codex-client-lifecycle.js)。
- **验证入口：** `test/codex-model-*.test.js`、`test/codex-catalog-startup.test.js`、
  `test/codex-native-picker.test.js`。TokenX 需同时对齐目录、验证、缓存和刷新时机。

### KB-003 · Codex 协议适配与流式稳定性

- **状态：源码已具备。** 依据明确的上游校验错误协商 reasoning context、effort、
  summary、verbosity；兼容重试与认证重试分别限次。保留用户输入和工具定义。
- 对 Responses SSE 的工具调用标识进行一致性处理；中断的上游流会结束/关闭本地
  连接，避免客户端无限等待。历史 agent 密文解密失败仅触发有明确错误证据的降级，
  本地原始会话不被改写。
- **实现：** [lib/codex-request-compat.js](lib/codex-request-compat.js)、
  [lib/responses-sse-normalizer.js](lib/responses-sse-normalizer.js)、[index.js](index.js)。
- **验证入口：** `test/codex-request-compat.test.js`、`test/codex-proxy.test.js`、
  `test/responses-sse-normalizer.test.js`。TokenX 需核对错误匹配边界及重试次数，
  避免把任意 400 错误都当认证失败重发。

### KB-004 · 原生 ChatGPT 登录与配置恢复

- **状态：源码已具备。** 默认保留原生 ChatGPT 账户/工作区登录，推理通过 Kobashi
  转到 Copilot。自动迁移旧版精确匹配的桥接占位凭证；不覆盖正常原生凭证。
- 配置注入和恢复只管理桥接拥有的字段，保留其他工具、插件及用户运行期间的修改；
  禁用或退出后恢复之前的 provider。GitHub 上游请求不携带客户端的 ChatGPT 凭证。
- **范围：** Remote 仍由官方客户端及其账户权限提供。Kobashi 不授予 Remote 权限，
  不需要旧的独立 shared-daemon/Python adapter。
- **实现：** [lib/codex-config.js](lib/codex-config.js)、
  [lib/codex-native-auth.js](lib/codex-native-auth.js)、[index.js](index.js)。
- **验证入口：** `test/codex-native-auth-migration.test.js`、
  `test/codex-native-config-lifecycle.test.js`、`test/codex-config.test.js`。
  TokenX 需对齐字段所有权及恢复行为，不能只复制启动配置。

### KB-005 · Claude Code / Claude Desktop 桥接与推理力度

- **状态：源码已具备。** 提供 Anthropic 兼容网关，把 Claude Code 和 Claude Desktop
  的请求路由到账号支持的 Copilot 模型，并按实际端点使用 Messages、Responses 或
  Chat Completions；处理流式输出、图片、工具调用和结果转换。
- Claude Desktop 通过独立受管理配置展示动态模型目录；非 Claude 模型使用稳定的
  桥接别名回到准确的 Copilot 模型 ID。推理力度来自上游枚举，并映射到 Desktop
  原生控件，避免旧版本形状的别名把 `xhigh` 静默降成 `high`。
- 配置恢复保留原有网关、用户选用的其他 profile 和无关字段。
- **实现：** [lib/claude-gateway.js](lib/claude-gateway.js)、
  [lib/claude-routes.js](lib/claude-routes.js)、[lib/claude-input.js](lib/claude-input.js)、
  [lib/claude-output.js](lib/claude-output.js)、[lib/claude-effort.js](lib/claude-effort.js)、
  [lib/claude-desktop-config.js](lib/claude-desktop-config.js)。
- **验证入口：** `test/claude-gateway.test.js`、`test/claude-input.test.js`、
  `test/claude-output.test.js`、`test/claude-effort*.test.js`、
  `test/claude-desktop-config.test.js`。TokenX 应对齐完整交互及恢复流程。

### KB-006 · Claude Code WebSearch

- **状态：源码已具备；v2.3.0 更新包含此能力。** Claude Code 的 WebSearch 使用
  Copilot 托管搜索，并把来源链接转换回原生工具结果。
- 所选模型不能直接完成搜索时，只把搜索问题及约束交给同账号符合要求的 Responses
  模型；主对话继续使用用户所选模型。搜索消耗 Copilot 用量。
- **实现：** [lib/claude-web-search.js](lib/claude-web-search.js)、
  [lib/claude-web-search-result.js](lib/claude-web-search-result.js)。
- **验证入口：** `test/claude-web-search-gateway.test.js`、
  `test/claude-web-search-result.test.js`。TokenX 需对齐引用、搜索限制和主对话路由。

### KB-007 · Grok Bridge 与独立桌面 profile

- **状态：源码已具备；v2.4.0 更新包含此能力。** 主面板新增 Grok Bridge 开关并保存
  状态；网关仅发布当前账号启用且协议兼容的 xAI Grok 模型，校验精确模型及端点。
- macOS 点击 Grok 图标准备并打开独立 desktop/CLI profile，刷新可选模型和推理力度，
  复用已有聊天；已启动且身份可确认的窗口直接前置。profile 不确定时提示正常退出后
  再打开，不强停应用。
- Grok App 使用本地网关密钥，GitHub 凭证保留在 Kobashi。语音、Imagine 等官方服务
  仍使用 Grok 自己的连接。桌面 profile 启动流程目前以 macOS 为已实现平台。
- **实现：** [lib/grok-gateway.js](lib/grok-gateway.js)、
  [lib/grok-launch-profile.js](lib/grok-launch-profile.js)、
  [lib/grok-desktop-launcher.js](lib/grok-desktop-launcher.js)、
  [lib/grok-local.js](lib/grok-local.js)、[scripts/grok-desktop.js](scripts/grok-desktop.js)。
- **验证入口：** `test/grok-*.test.js`。TokenX 需同时对齐开关持久化、网关鉴权、
  原生 composer 选项、profile 隔离及窗口复用。

### KB-008 · 三个桌面启动图标

- **状态：源码已具备；v2.4.0 更新包含此能力。** 保持原有 32×32 图标块，点击
  Claude/Codex/Grok 图标打开或前置相应桌面应用；桥接开关与启动动作独立。
- Claude/Codex 桌面启动支持 macOS 和 Windows；Grok 的受管理 profile 启动见 KB-007。
  Codex 的 macOS 启动可为该应用传递当前系统代理环境，Windows 支持 Store 应用身份
  和独立安装。重复点击合并正在进行的启动，不以 CLI 代替 Desktop。
- 启动失败通过图标简短提示展示，不新增配置面板；本地启动 API 限定 loopback、
  同源 POST 和空请求，不接受任意可执行路径或命令。
- **实现：** `lib/*-desktop-launcher.js`、[lib/codex-windows-launcher.js](lib/codex-windows-launcher.js)、
  [lib/desktop-open-handler.js](lib/desktop-open-handler.js)、[assets/ui.html](assets/ui.html)。
- **验证入口：** `test/*-desktop-launcher.test.js`、`test/codex-windows-launcher.test.js`、
  `test/codex-launch-ui.test.js`。TokenX 需核对应用识别、已有窗口和失败提示。

### KB-009 · 面板尺寸、主题与 hover glow

- **状态：源码已具备。** 当前面板内容区目标为 **400×576**；macOS 原生窗口使用
  该内容尺寸，Windows 会计算窗口装饰及 DPI 并限制在显示器工作区内。普通浏览器
  fallback 里的卡片也保持紧凑，不随整个大窗口铺满。
- 登录、已连接视图共享布局；三条 Bridge 卡片、账户额度、主题切换和底部动画共同
  适配该尺寸。支持系统明暗主题跟随及手动切换。
- 可点击启动图标在 hover 时使用蓝色柔光 `0 0 20px rgba(88,166,255,.16)`，禁用态
  不触发，过渡为 0.2 秒。**2026-11-27 的提交明确是对齐 TokenX 的既有光效**，
  不能据此认定 TokenX 还缺少它。
- **实现：** [assets/ui.html](assets/ui.html)、[macos/main.swift](macos/main.swift)、
  [lib/windows-dashboard.js](lib/windows-dashboard.js)。
- **验证入口：** `test/windows-dashboard.test.js`、`test/grok-ui.test.js`；外观仍需在
  明/暗主题、原生窗口及浏览器 fallback 中检查。TokenX 对齐时核对最终尺寸和互动，
  不只比较单个 CSS 值。

### KB-010 · 窗口生命周期与可移植打包

- **状态：源码已具备。** macOS 关闭红色窗口按钮后桥接继续运行，Dock 可恢复同一
  窗口及状态；只有正常 Quit 才结束桥接并执行配置恢复。
- macOS Apple Silicon/Intel 打包为 ZIP，解压后复验三个可执行文件权限、架构及完整
  bundle 签名；Windows 生成单一 EXE。Windows 本机构建会执行 runtime 自检及核对
  assets，跨平台构建会验证 x64 GUI PE 结构；两者均保存源码快照。
- 所有编译、版本标记、临时 bundle 均在 checkout/OneDrive 以外的临时目录完成。
  成功后才把最终包及校验和写回 `dist`，失败保留旧包；版本取自 `package.json`。
- **实现：** [macos/main.swift](macos/main.swift)、[scripts/build-local.js](scripts/build-local.js)、
  [scripts/build-mac-app.sh](scripts/build-mac-app.sh)、[scripts/build-win.sh](scripts/build-win.sh)、
  [scripts/verify-mac-package.js](scripts/verify-mac-package.js)、
  [scripts/verify-win-package.js](scripts/verify-win-package.js)。
- **验证入口：** `test/build-local.test.js`、`test/mac-package.test.js`、`npm run test:mac`。
  原生检查使用隔离测试应用；不得终止用户正在使用的 Kobashi 来做验证。

### KB-011 · Codex Fast 服务档适配

- **状态：源码已实现；本次完整验证、打包和发布状态见下方日期记录。** 当前已确认
  Copilot 的 `gpt-5.6-sol-fast` 可调用。目录允许公开 OpenAI 基础模型的精确 `-fast`
  同系变体参加验证，即使其标签为 `Experimental` / `Internal only`；其他内部或
  实验型号仍遵循现有筛选规则，不因这个例外全部放行。
- 基础模型与 Fast 变体分别通过流式工具调用验证后，且 Fast 保留基础模型的推理
  力度、上下文/输入/输出上限及所需关键能力，才给基础模型发布 Fast 速度档。
  Fast 变体也可作为独立条目选择，但不再附加一层 Fast 速度档。
- 对所有符合条件的 OpenAI 型号采用同一套发现与精确配对规则，没有单型号白名单。
  原生目录的 `additional_speed_tiers: ["fast"]` 闪电能力标记与
  `service_tiers` 中的 Fast 选项同时发布；未验证、无权限、能力较窄或没有同系
  Fast 的基础模型，两者均为空。直接选择 `-fast` 条目时也不发布二次 Fast 开关。
  2026-11-28 重新取得的账号目录共 39 条，唯一的 Fast ID 仍为
  `gpt-5.6-sol-fast`；原生 OpenAI 目录给其他型号标注 Fast 不能代表 Copilot 可用。
- Codex 的 `service_tier: "priority"` 或 `"fast"` 映射到准确的同系 Fast ID；
  当前实例为 `gpt-5.6-sol` → `gpt-5.6-sol-fast`。输入、工具及 token 预算保持原值，
  不把 6 Astra 等其他型号改成 5.6 Sol。普通档 `default` / `auto` / `null` 只移除
  这个 Copilot 不接受的字段；没有服务档字段的请求保持正常路由。
- 无已验证同系 Fast 或收到未知速度档时，在本地返回明确的 400 错误，不发送上游
  请求、不静默退回普通速度。兼容规则、重试及权限失效按实际 Fast 目标处理，
  Fast 失效不会连带移除基础模型的普通档。
- 清除从原生 OpenAI 目录继承但 Copilot 未确认的速度档。Fast 验证会覆盖基础模型
  Ultra 对应的底层力度；独立 Fast 条目不会因此虚构其原生 Ultra 模式。
  仅已知的流式响应型号别名在 `OpenAI-Model` 头与 SSE 中还原为用户选择的型号，
  意外的上游型号原样保留，避免掩盖异常路由。
- **生效条件：** 使用包含该实现的新 Kobashi 程序，并按 KB-002 的启动/目录刷新
  流程读取新 picker。Fast 倍率、计费和底层加速机制没有在本次实现中作保证；
  Daybreak Blue 不属于本次范围。
- **实现：** [lib/codex-service-tier.js](lib/codex-service-tier.js)、
  [lib/codex-model-catalog.js](lib/codex-model-catalog.js)、
  [lib/codex-model-capabilities.js](lib/codex-model-capabilities.js)、
  [lib/responses-sse-normalizer.js](lib/responses-sse-normalizer.js)、[index.js](index.js)。
- **TokenX 对齐：** 把账号发现、独立验证、速度档声明、请求映射、响应型号及权限
  失效作为同一组能力实现；只显示闪电或删除 `service_tier` 并不等于支持 Fast。

## 更新记录

### 2026-11-28 · v2.4.1 补充：全模型 Fast 配对与条件闪电标记

- **涉及：** KB-002、KB-011。
- **触发与行为：** 用户要求核对其他 OpenAI Fast 并只给支持切换的型号显示闪电。
  重新读取账号目录后确认 39 条中只有 Sol 5.6 Fast；现有通用路由保留，补齐受
  同一验证条件控制的原生闪电能力标记。后续任一 OpenAI 同系 Fast 开放后，按
  正常启动发现/验证流程入选，不需要逐个添加型号。此前对所有型号都清空
  `additional_speed_tiers` 的实现被本条的条件发布替代；无支持时仍清空继承字段。
- **实现入口：** [lib/codex-model-catalog.js](lib/codex-model-catalog.js)、
  [lib/codex-service-tier.js](lib/codex-service-tier.js)；新增跨型号与权限/验证状态
  覆盖见 [test/codex-model-catalog.test.js](test/codex-model-catalog.test.js)、
  [test/codex-proxy.test.js](test/codex-proxy.test.js)、
  [test/codex-native-picker.test.js](test/codex-native-picker.test.js)。
- **实际验证：** 设置本机原生 Codex 测试入口执行完整 `npm test`：290 项，
  288 通过、2 项 Windows 原生检查按平台跳过、0 失败。合成目录验证多个 OpenAI
  系列与 `o3` 的精确 Fast 路由、未验证/禁用/较窄变体不发布标记、变体移除后
  同时移除速度档与闪电能力。隔离原生 app-server 验证其 `model/list` 读到一致
  的速度信息，并在下次启动读取移除结果。
- 真实账号的 Sol 与 Sol Fast 分别以 `max` 完成流式工具调用；用两项新验证结果
  和同账号其他型号既有验证快照生成临时目录，隔离原生 `model/list` 共 11 个
  条目，只有 `gpt-5.6-sol` 具有 `fast` / `priority` 标记，其他条目均为空。
  其他型号本次未重复发起真实推理，合成 Fast 变体测试不表示账号已开放这些型号。
  本次摘要保存在 `output/fast-support/verification.json`，不包含账号或凭证。
- **构建与发布：** 已生成包含本条改动的本地 macOS 与 Windows 2.4.1 安装包。
  `dist/Kobashi.zip`（约 37 MB）解压后的三个入口均为 755，包含 arm64/x86_64，
  完整 bundle 的 ad-hoc 签名复验通过。`dist/Kobashi.exe`（约 56 MB）为 Windows
  x64 GUI PE，图标及 2.4.1 版本资源已写入；本次在 macOS 交叉构建并完成静态 PE
  校验，未在 Windows 本机启动成品。两个构建使用完全相同的源码快照，校验和及
  来源分别在 `dist/SHA256SUMS.txt`、`output/last-mac-build.json` 和
  `output/last-windows-build.json`。远端 release 尚未发布；运行中的应用仍由用户
  自行安装更新。
- **限制与生效：** 验证范围是目录/原生协议和请求路由，未在用户运行中的界面
  重启或截图检查。客户端仍按启动快照显示，需用户在方便时安装新包并完整启动
  Codex。型号可用性依账号变化，Kobashi 不自动替换应用或重启进程。
- **TokenX 对齐：** 将闪电图标、Fast 选项与实际路由共用同一支持条件；分别核对
  多型号配对、无支持时隐藏、直接 Fast 无二次开关，以及移除权限后的目录更新。

### 2026-11-28 · v2.4.1：把 Codex Fast 连接到 Copilot 同系变体

- **涉及：** KB-002、KB-003、KB-011。
- **原问题：** Codex 闪电发送 `service_tier` 后收到不支持参数的错误，而实际可用的
  Sol Fast 又因内部/实验标签被 Kobashi 隐藏；原生目录的速度档与转发接口不一致。
- **更新后：** 以账号内已验证的同系 Fast 为依据发布速度档，将显式 Fast 选择转成
  对应模型 ID；普通请求移除无效档位字段，不可用/未知档位明确报错。见 KB-011。
- **实际验证：** 完整 `npm test` 共 287 项，281 通过、6 项按平台/显式开关跳过、
  0 失败。隔离验证分别以 `max` 力度完成 Sol 和 Sol Fast 的真实流式工具调用；
  新 HTTP handler 将 Sol + `priority` 转为 Sol Fast，未转发 `service_tier`，
  保留 `max` 力度，HTTP 200 且工具调用完成。另以临时 Codex home 启动本机原生
  app-server，确认 Sol 同时提供 Ultra 与 Fast，独立 Sol Fast 条目可见。
- **构建与发布：** 后续同日补充记录已覆盖最终双平台构建状态；此段保留首次
  macOS 构建的历史。远端发布状态以最新记录为准，运行中的应用未被自动替换。
- **TokenX 对齐：** 特别核对普通档不误发服务参数、Fast 不跨型号替换、目录未验证
  不入选、直接选 Fast 的响应身份，以及 Fast 失效后基础模型仍能使用。

### 2026-11-28 · 建立能力清单与持续维护约定

- **涉及：** KB-001～KB-010；新增本文及根目录代理约定。
- **行为：** 用稳定能力编号给 TokenX 提供现状和增量入口；以后每次功能、行为、UI
  或兼容性更新都在同次改动更新本文。
- **验证：** 核对现有源码、对应测试入口和 Git 历史。本段是文档核对，不代表重新
  执行了所有历史功能测试，也不改变发布版本。
- **TokenX 对齐：** 逐项与其当前实现比较，标记已具备/需补齐/不适用；不能把这份
  Kobashi 清单直接等同于 TokenX 的缺陷列表。

### 已有更新索引（根据 Git 历史补录）

| 日期 | 提交/版本 | 能力及实际变化 | TokenX 对齐重点 |
| --- | --- | --- | --- |
| 2026-11-27 | `591e59c` | KB-009：启动图标 hover glow 对齐 TokenX | 双方既有视觉保持一致，不重复移植 |
| 2026-11-26 | `2756fce` / v2.4.0 | KB-007、008、009：Grok Bridge、桌面启动图标、面板尺寸和截图 | Grok 全流程、图标交互、400×576 内容区 |
| 2026-11-26 | `c93b5fa` / v2.3.0 | KB-006：Claude Code 的 Copilot WebSearch | 原生工具结果、引用及搜索代理 |
| 2026-11-26 | `4dbf580` | KB-005：Claude Bridge 动态 Copilot 路由与原生 effort 控件 | 模型别名与真实端点、力度不静默降级 |
| 2026-11-25 | `a60907b`、`8213d9e` / v2.2.3～2.2.4 | KB-004、010：原生账户兼容及跨平台打包/启动保障 | 登录保留、配置恢复、Windows 打包验证 |
| 2026-10-01 | `3ad56d9` / v2.1.6 | KB-002：Codex 能力验证和启动目录保留 | 实测入选、缓存及刷新时机 |
| 2026-09-15 | `ae66a97` | KB-010：macOS 关窗口保留桥接运行 | Dock 恢复与 Quit 清理分开 |
| 2026-08-30 | `f541ff6` / v2.1.2 | KB-001、009：真实额度、更窄窗口、动态页脚 | 额度来源与紧凑布局；尺寸以当前基线为准 |
| 2026-04-22 | `a6aa8b4` / v1.5.0 | KB-005：更名 Kobashi，并加入 Claude Bridge | 初始 Claude 能力已由后续路由实现扩展 |

## 给 TokenX 的对齐方式

1. 先按 KB 编号检查现有 TokenX 实现，记录适用平台及缺口；已有能力不重复实现。
2. 从最新更新记录向前读到上次同步点，结合当前基线判断哪些旧方案已被替代。
3. 移植时一并检查配置恢复、鉴权、流式失败、窗口复用及平台差异，不能只复制界面。
4. 完成后在 TokenX 自己的更新记录注明已对齐的 KB 编号、Kobashi 日期/提交和验证结果。
