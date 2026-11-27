# Kobashi Feature Updates

这份文件是 Kobashi 的能力清单和增量更新记录，供后续维护及 TokenX 对齐使用。
它记录实际行为、实现入口、验证方式和适用范围；TokenX 可以先按稳定的 `KB-*`
编号核对能力，再阅读上次同步日期之后的更新。

基线核对日期：**2026-11-28**。基线来自仓库源码、测试和 Git 历史，版本字段当前为
**2.4.3**；本次无密钥图片工具兼容修复已在源码实现，构建/发布状态见最新记录。
macOS/Windows 安装包已通过 `v2.4.3` 正式发布。这里的
“源码已具备”不代表所有历史能力都在每个平台重新实测，具体构建与验证状态见最新
更新记录。
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

- **状态：源码已实现；v2.4.1 首次加入，v2.4.2 收敛 picker 行为。** 当前已确认
  Copilot 的 `gpt-5.6-sol-fast` 可调用。目录允许公开 OpenAI 基础模型的精确 `-fast`
  同系变体参加验证，即使其标签为 `Experimental` / `Internal only`；其他内部或
  实验型号仍遵循现有筛选规则，不因这个例外全部放行。
- 基础模型与 Fast 变体分别通过流式工具调用验证后，且 Fast 保留基础模型的推理
  力度、上下文/输入/输出上限及所需关键能力，才给基础模型发布 Fast 速度档。
  Fast 变体保留在内部验证与请求注册表，但不再发布为独立 picker 或 `/v1/models`
  条目；用户只通过基础模型的闪电/Fast 控件选择它。手动指定精确 Fast ID 的旧请求
  仍按已验证端点处理，以保持兼容。
- 对所有符合条件的 OpenAI 型号采用同一套发现与精确配对规则，没有单型号白名单。
  原生目录的 `additional_speed_tiers: ["fast"]` 闪电能力标记与
  `service_tiers` 中的 Fast 选项同时发布；未验证、无权限、能力较窄或没有同系
  Fast 的基础模型，两者均为空。Fast endpoint 自身始终隐藏，不发布二次 Fast 开关。
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
  Ultra 对应的底层力度；隐藏的 Fast endpoint 不会因此虚构独立 Ultra picker 模式。
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
  失效作为同一组能力实现；Fast endpoint 留在内部 registry、从所有用户模型列表
  隐藏。只显示闪电或删除 `service_tier` 并不等于支持 Fast。

### KB-012 · Codex 图片生成与编辑

- **状态：2.4.2 加入 Images gateway；2.4.3 增加无感本地工具。** 图片能力与聊天模型目录
  分开发现：只接受当前 Copilot 账号返回、policy 可用、`capabilities.type` 为
  `image` 且声明 `/v1/images/generations` 或 `/v1/images/edits` 的 GPT Image 型号。
  `model_picker_enabled: false` 是专用图片 endpoint 的正常状态，不会把它放进 picker。
- Codex 会话继续使用用户选择的推理模型；原生 `image_gen.imagegen` 工具按需调用
  Images API。客户端固定别名 `gpt-image-2` 只在图片路由中解析为账号真实型号，
  当前为 `gpt-image-2.5-flare`；未知型号、能力缺失或多候选不明确时本地拒绝，
  不跨到聊天模型或任意猜测。prompt、quality、size、background、未来字段以及 edit
  的 JSON `images` 引用均保持，仅替换必要的 model ID。
- Codex 客户端会对原生 ChatGPT `PlanType::Free` 隐藏官方 `image_gen`，GitHub Copilot
  订阅不会改变这个客户端 entitlement。2.4.3 因此随 Kobashi 自动注入本地 stdio
  MCP `kobashi_image`：官方工具可用时仍优先，否则模型直接调用
  `mcp__kobashi_image__imagegen`。该工具只请求 loopback Kobashi gateway，不读取或
  要求 `OPENAI_API_KEY`，也不安装/连接 Visual Sandbox 或第三方图片插件。
- 本地 MCP 支持 generation 与最多 5 张 PNG/JPEG/WebP 参考图的 edit；单张参考图
  上限 20 MiB、合计上限 80 MiB、结果上限 32 MiB。原始结果以 0600 保存到
  `~/.kobashi/generated_images`，同时返回 MCP image content、保存路径与结构化元数据。
  参考图只允许来自该受管目录，并用 realpath 阻止 symlink 越界读取；参数、取消或
  上游失败以 `isError` 工具结果返回，不终止 stdio server。取消 turn 或关闭 stdio
  会中止在途 fetch，十分钟上限覆盖完整 response body；无 Content-Length 时也逐块
  执行响应上限，且禁用重定向，避免图片额度或内存继续消耗。
  工作区或其他目录的图片必须先通过 Codex 正常、受权限控制的文件操作复制到该目录。
- 独立图片 gateway 使用 Kobashi Copilot token，不转发客户端 ChatGPT 凭证；401 或
  明确认证型 400 最多重试一次。请求上限 128 MiB、响应上限 64 MiB、默认超时十分钟；
  客户端断开或账号/bridge generation 改变会销毁上下游，旧账号图片字节不会返回。
  图片错误不读写 Codex 聊天 capability registry，也不会移除普通或 Fast 模型。
- 成功响应保留原始 JSON/base64 字节及 `content-type`、`retry-after`、
  `x-codex-imagegen-request-id`。Codex 负责保存及展示；Kobashi 不重新编码图片，避免
  无意移除 C2PA provenance。启动目录刷新只读图片元数据，不自动生图或消耗图片额度。
- **实现：** [lib/codex-image-generation.js](lib/codex-image-generation.js)、
  [lib/codex-image-gateway.js](lib/codex-image-gateway.js)、
  [lib/codex-image-mcp.js](lib/codex-image-mcp.js)、[lib/codex-config.js](lib/codex-config.js)、
  [lib/codex-model-catalog.js](lib/codex-model-catalog.js)、[index.js](index.js)。验证入口为
  `test/codex-image-*.test.js`、`test/codex-native-image-*.test.js`、
  [test/codex-config.test.js](test/codex-config.test.js)、[test/codex-proxy.test.js](test/codex-proxy.test.js)。
- **限制：** 当前以 Codex 原生 JSON generations/edits 为范围，不提供独立图片模型
  picker，也未扩展 Claude/Grok 或通用 multipart Images 客户端。GitHub 图片生成仍是
  preview，受账号计划、组织 policy、安全检查和单独 AI credits 计费影响。实测当前
  Flare quality 接受 `low`、`medium`、`high`、`auto`；不能照搬其他 OpenAI endpoint
  的所有可选值。
- **TokenX 对齐：** 应对齐独立图片目录、严格别名、原生工具路径、凭证隔离、账号
  切换取消、body/response 上限、原始图片字节和 C2PA 保留；若客户端同样按原生
  订阅隐藏工具，还要自动管理本地 MCP 与模型提示，不能要求 API key/第三方插件。
  不要把图片型号伪装成 `/responses` 聊天模型。

## 更新记录

### 2026-11-28 · v2.4.3：Free entitlement 下自动提供 Kobashi 图片工具

- **涉及：** KB-004、KB-010、KB-012。
- **触发与根因：** 用户安装 2.4.2 后，imagegen skill 能读取但当前 turn 没有官方
  `image_gen.imagegen`，因而建议 `OPENAI_API_KEY` CLI；随后插件搜索又把第三方
  Visual Sandbox 中同名 `image/gpt-image-2.5-flare` 误认成 Kobashi 入口。只读核对
  当前工具快照、keyring 及 OpenAI Codex 源码后确认，运行账户被客户端识别为
  `PlanType::Free`，`image_generation_available()` 会在请求到达 Kobashi 前过滤工具。
  Visual Sandbox 只是未安装、需另行认证的远程第三方插件，与 GitHub Flare 无关。
- **更新后：** Kobashi 在受管理 Codex 配置中自动注册 `[mcp_servers.kobashi_image]`，
  以当前 Kobashi 可执行文件的 `--image-mcp` stdio 模式启动。模型目录明确把它视为
  Kobashi 内置图片路径：官方工具存在时优先，否则直接用 MCP；禁止索要 API key
  或搜索/安装 Visual Sandbox。用户无需为每个会话安装或连接任何内容。
- **配置所有权：** 注入使用精确管理标记；重复启动幂等，退出/禁用只移除 Kobashi
  自己的 MCP，保留其他 MCP 和运行期间修改。若用户已经拥有同名 section，完整保留
  并跳过注入。源码运行使用 Node + `index.js --image-mcp`，打包后重入当前平台的
  Kobashi 可执行文件；stdout 只输出 JSON-RPC，诊断写 stderr。
- **源码验证（构建前）：** 设置本机原生 Codex 入口执行完整 `npm test`：322 项，
  320 通过、2 项 Windows 原生检查按平台跳过、0 失败；macOS WebKit 布局与生命周期
  12 项全部通过。覆盖 MCP 协议、generation/edit、文件/结果上限、错误恢复、source
  entrypoint、配置注入/恢复和两种模型 instruction shape。隔离启动本机原生
  app-server 后，`kobashi_image` 从 `starting` 进入 `ready`，新线程工具快照包含
  Kobashi 图片入口。本条不伪造/修改 ChatGPT plan claim。
- **用户验收：** 安装 2.4.3 并完整重开应用、新建 chat 后，用户实测图片生成效果
  正常；无需配置 `OPENAI_API_KEY`，也未安装或连接 Visual Sandbox。
- **构建与发布：** 已用同一源码快照生成本地 macOS/Windows 2.4.3 包。
  `dist/Kobashi.zip` 为 37,494,415 bytes，SHA-256
  `daf24683a9476f2e403847eaba42ecb7f6233626a682bb847d434cd59237a301`；解压后
  三个入口均为 755，包含 arm64/x86_64，完整 bundle 的 ad-hoc 签名有效。直接运行
  包内 arm64 runtime 的 `--image-mcp`，初始化返回 2.4.3、列出 `imagegen` 且 stderr
  为空。`dist/Kobashi.exe` 为 58,399,048 bytes，SHA-256
  `0bca0d0cdc9c2fd866ca771d578d216649d9caccaee0d54fa25e74595ead97f2`；
  已读回 x64 GUI PE、7 个图标资源及 2.4.3.0 文件/产品版本。本轮在 macOS
  交叉构建，未执行 Windows 本机 self-test。`dist/SHA256SUMS.txt` 与两项产物一致，
  构建来源分别记录在 `output/last-mac-build.json`、`output/last-windows-build.json`。
  GitHub Release `v2.4.3` 已发布，标签指向源码提交 `a8798b9`；远端
  `Kobashi.zip`、`Kobashi.exe`、`SHA256SUMS.txt` 和 `BUILDINFO.json` 的大小及
  SHA-256 均与本地产物一致。运行中的应用未被自动替换或重启。
- **生效条件：** 安装新包后完整退出并重开 ChatGPT/Codex，再创建新 chat；旧 thread
  的工具快照不会自动获得新 MCP。Kobashi Codex Bridge 必须保持启用。
- **TokenX 对齐：** 核对客户端 entitlement gate；不能把 capability RPC 为 true
  误当成工具已挂载。若使用相同客户端，需同步本地 MCP、外科式配置生命周期与
  “禁止 API key/第三方插件回退”的模型指令。

### 2026-11-28 · v2.4.2：原生生图路由与隐藏 Fast endpoint

- **涉及：** KB-002、KB-003、KB-010、KB-011、KB-012。
- **触发与行为：** 用户要求普通聊天模型在需要时调用账号图片模型，同时让所有
  `-fast` sibling 只作为基础模型的速度后端。图片模型不进入 picker；Codex 原生
  `image_gen` 调用由独立 gateway 把 `gpt-image-2` 精确映射到已发现的 Flare。
  Fast sibling 继续独立验证及承接请求，但从原生 picker 和 `/v1/models` 隐藏；
  基础模型只有验证兼容时显示闪电。
- **实现入口：** [lib/codex-image-generation.js](lib/codex-image-generation.js)、
  [lib/codex-image-gateway.js](lib/codex-image-gateway.js)、
  [lib/codex-model-catalog.js](lib/codex-model-catalog.js)、[index.js](index.js) 及对应测试。
- **实际验证：** 设置本机原生 Codex 测试入口执行完整 `npm test`：306 项，304 通过、
  2 项 Windows 原生检查按平台跳过、0 失败；macOS WebKit 布局与生命周期 12 项
  全部通过。图片 resolver/gateway、入口分流、Fast 目录及原生 provider capability
  均纳入回归。真实账号以 Codex 原生别名完成一次
  `low`、1024×1024 generation 和一次同规格 edit，均映射到
  `gpt-image-2.5-flare` 并返回 HTTP 200、有效 PNG。generation 使用 30 个文本输入
  token / 196 个图片输出 token；edit 使用 42 个文本与 1024 个图片输入 token /
  196 个图片输出 token。两张原始文件均含 `caBX` provenance 容器，未重新编码，
  摘要及探针文件保存在忽略提交的 `output/image-generation-probe/`。
- **构建与发布：** 已用同一源码快照生成本地 macOS/Windows 2.4.2 包。
  `dist/Kobashi.zip` 为 37,458,781 bytes，SHA-256
  `44fe052f92576c8730cf3c516f18a4f1ae1b574494fbbf196f34e972e54ae169`；解压后
  三个入口均为 755，包含 arm64/x86_64，完整 bundle 的 ad-hoc 签名有效。
  `dist/Kobashi.exe` 为 58,376,409 bytes，SHA-256
  `2933e4ef5c18ef5468d1fbb5460f473e52f5e49c21b62ff3b9e4d80bf6d0c69c`；
  已读回 x64 GUI PE、7 个图标资源及 2.4.2.0 文件/产品版本。本轮在 macOS
  交叉构建，未执行 Windows 本机 self-test。`dist/SHA256SUMS.txt` 与两项产物一致，
  构建来源分别记录在 `output/last-mac-build.json`、`output/last-windows-build.json`。
  尚未发布远端 release，运行中的应用未被替换或重启。
- **TokenX 对齐：** 先核对是否已有原生 image tool/Images API；若有，复用同一
  gateway 语义。Fast 必须是内部 endpoint 加基础型号速度控件，不能形成重复模型行。

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
  `output/last-windows-build.json`。GitHub Release `v2.4.1` 已发布，标签指向源码
  提交 `eca84a8`；远端 `Kobashi.zip`、`Kobashi.exe`、`SHA256SUMS.txt` 和
  `BUILDINFO.json` 的大小及 SHA-256 均与本地产物一致。运行中的应用仍由用户自行
  安装更新。
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
| 2026-11-28 | `a8798b9` / v2.4.3 | KB-004、012：Free entitlement 下自动注册 Kobashi 图片 MCP，禁止 API key/Visual Sandbox 回退 | MCP 生命周期、取消/路径/内存边界、模型工具指令 |
| 2026-11-28 | v2.4.2（本地构建，未发布） | KB-011、012：Codex 原生生图/编辑；Fast endpoint 从用户模型列表隐藏 | 图片工具路由、原始字节与账号隔离；基础模型闪电、内部 Fast registry |
| 2026-11-28 | `eca84a8` / v2.4.1 | KB-002、003、011：Copilot Fast 精确路由、条件闪电标记及双平台发布 | 全型号动态配对、无支持时隐藏、Standard/Fast 失效隔离 |
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
