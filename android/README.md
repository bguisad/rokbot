# RokBot Android 原生补丁器 (`android/`)

[English](README.en.md)

本目录提供参考 `ios/`（`GBBootstrap.m` + `patch-app.py`）架构的 **官方 Android React Native `.apk` / `.xapk` / `.apks` 补丁器**（目标包名 `ai.x.grok.bot`，亦兼容 `co.anysphere.sand`，对齐官方 `1.16.0` / build `1075`）：完整保留官方 RN 客户端原生的 Bot 列表、对话、语音通话界面、连接器市场、搜索与设置 UI/交互，零自制主界面重写、零悬浮工具栏劫持，仅注入轻量化 Native Companion 运行时（Companion DEX + 16KB 对齐 Tailcat `.so` + Hermes 字节补丁）及与 iOS 对齐的 6 个原生模态页面、系统分享面板接收与后台通知服务。

> 仅限非商业、授权开发/学习/自建部署用途。请勿在任何提交或日志中包含密钥、配对码、密码或私人 Host 地址。

## 核心能力

- **官方 Split XAPK/APKS 合并与 Google Play Pairip 去校验**
  - **多分包合并 (`xapk.mjs` & `arsc.mjs`)**：纯 Node.js 解包官方 `.xapk` / `.apks` / `.apk`，剥离 `libpairipcore.so`，合并基础包、`arm64-v8a` 原生库与密度/语言分包的 `resources.arsc` 与资源文件，输出单一通用签名 APK（推荐 `android/output/rokbot-android-patched.apk`）。
  - **Pairip 防篡改中和 (`pairip-dex.mjs`, `pairip-elf.mjs`, `PairipVmBridge`, `GrokBotAppComponentFactory`)**：中和 Pairip DEX 签名/授权校验并接管 `VMRunner` 调度，清理原生 `.so` 的 `DT_NEEDED libpairipcore.so`、`DT_INIT` 跳板、`ExecuteProgram` 重定位与固定 `.data` 加密区，并移除清单中的 Pairip 与 Play 分包元数据。
- **安全配对与多传输连接 (`PairingActivity`)**
  - 支持直接填写 `http://` / `https://` 地址、**6 位配对码 / 管理员密码**切换、**局域网 / mDNS (`_grokbot._tcp.`) 自动扫描**，以及内置 **Tailcat 加密隧道（`tailcat://connect/...`）**。
  - 原生封装 `arm64-v8a` `libgroktailcat.so` + `libgroktailcatjni.so`（强制 **16KB 页对齐**，兼容 Android 15/16），支持自动重连、健康探测与网络切换恢复。
  - 设备凭证与 Tailcat 节点身份均通过 **Android Keystore (`AES/GCM/NoPadding`)** 硬件级加密存储。
- **完全对齐 iOS `GBBootstrap` 的 6 个原生界面（无自制主界面、无悬浮工具栏劫持）**
  - 保留官方 RN 主启动器 `MainActivity` 及原版 Bot 列表 / 对话 / 语音 / 连接器 UI，仅拦截对应 iOS `GBBootstrap.m` 的 6 个入口：
    1. **连接 / 登录 (`PairingActivity`)**：对齐官方 Connect UI（`connect.html`）与 iOS `GBConnection.m`。
    2. **个人资料 (`ProfileActivity`)**：查看/编辑自建 Host 个人资料并自动将 RN 中的 `dev-gateway@localhost` 文本替换为 Host 显示名。
    3. **通知设置 (`PushSettingsActivity`)**：支持测试推送、UnifiedPush / ntfy / Webhook / FCM 配置。
    4. **Bot 资料库 (`LibraryActivity`)**：通过 `NetworkInterceptor` 自动追踪 `/api/openAgentWindowed`、`/api/getAgentTranscriptTail`、`/api/getAgentTranscript` 与 `/api/sendPrompt` 中的当前 `agentId`，按 Bot 管理文件上传、预览与删除。
    5. **Bot 电脑 (`ComputersActivity` & `ComputerViewerActivity`)**：查询 `/api/getForeverBoxStatus`、唤醒 `/api/ensureForeverBox` 并通过内置回环代理加载交互式 noVNC 桌面。
    6. **用量统计 (`UsageActivity`)**：展示 Host 当日 Token 用量统计。
- **后台通知、深链接、语音、系统分享与 Hermes 补丁**
  - **后台推送 (`NotificationService` & `PushManager`)**：前台服务常驻长连接 SSE（`/notifications/events`），支持 256 条游标去重、系统通知栏推送，点击通知或外部深链接自动将 `grokbot-local://agent/<id>` 规范化为 `grokbot://app/v1/chat?id=<id>` 并拉起主 `MainActivity`（对齐 iOS `GBDeepLinks.m`）。
- **网络与语音兼容层 (`R8OkHttpHook`, `R8OkHttpInterceptor`, `LegacyOkHttpHook`, `NetworkInterceptor` & `VoiceManager`)**：Hook R8 混淆 OkHttp 工厂（`t8.f` / `Ae.k`）与传统 `OkHttpClientProvider`；拦截遥测上报（Sentry、Braze、AppsFlyer、Statsig 及 `/aiserver.v1.AnalyticsService/*`）；重定向 API/WebSocket、`/aiserver.v1.AiService/TranscribeAudio` -> `/local/audio/transcriptions`、`/aiserver.v1.GrokBotService/MintSandVoiceCallSecret` -> `/local/voice/session`、`/local/app-intents/*`、`/local/mobile-rpc/*` 及 SkillSheet 发布（`https://grokbot.local/skill-publication`）；提供 24kHz PCM + 硬件 `AcousticEchoCanceler` / `NoiseSuppressor` 原生音频支持。
  - **Hermes 运行时 (`HermesPatcher` & `hermes.mjs`)**：匹配固定 HBC 指纹时应用 `recipes/*.gbp.gz` 字节补丁，注入 `assets/recipes/{unpaired.hbc,gateway-template.hbc,gateway-template.json}`（并在需要时注入 `assets/recipes/pairip-strings.json`），禁用 Expo Updates，并 Hook `ReactNativeHost` 与 New Architecture `ReactHost`。
  - **系统分享面板接收 (`ShareTargetActivity`)**：支持 `ACTION_SEND` / `ACTION_SEND_MULTIPLE` 直接分片上传并发给指定 Bot，完成后通过规范化深链接返回对话页。

## 目录结构

```text
android/
├── bin/
│   ├── classes2.dex                   # 编译好的 Companion DEX（注入目标 APK 顺序下一槽位，如 1.16.0 中的 classes6.dex）
│   ├── grokbot-native-base.apk        # 轻量 RN 补丁器测试基准 APK
│   └── jniLibs/arm64-v8a/             # 预编译 Tailcat Go Mobile JNI 动态库
├── companion/                         # 原生 Java Companion 源码、compile-stubs 与 build.sh
├── patchers/                          # 纯 Node AXML、ARSC、XAPK/APKS 合并、Pairip DEX/ELF 去校验、DEX/JNI、Hermes(HBC/bytepatch)、16KB Zipalign 与 APK v2/v3 签名器
├── recipes/                           # 固定包指纹（1.16.0 / 1075）、.gbp.gz Hermes 字节补丁及 Pairip ELF/字符串配方
├── release/                           # CLI 自动化补丁入口（patch-android.mjs 与 Python 包装 patch-android.py）
├── test-target/                       # 轻量 RN 基准目标 APK 构建脚本
├── tests/ & adversarial/              # 单元测试、MockHost 协议测试、对抗测试与模拟器 E2E
└── output/                            # 默认签名 APK 输出目录（rokbot-android-patched.apk 与 patch-report.json）
```

## 快速开始

### 前置依赖

- Node.js `>= 20`（运行 `patch-android.mjs` 仅依赖 Node.js）
- 可选（仅重编 `companion/build.sh`、`test-target/build-base.sh` 或运行 JVM/模拟器测试时需要）：
  - JDK 17+（`javac`、`jar`）
  - Android SDK（`platforms/android-36/android.jar`、`build-tools` 中的 `d8`/`aapt2`/`apksigner` 及 `platform-tools/adb`）

### 对官方 Android React Native APK / XAPK 执行补丁

```bash
# 如修改了 companion/ 原生代码，可先重新编译 classes2.dex
bash android/companion/build.sh

# 对官方 1.16.0 .xapk / .apks / .apk 执行补丁并输出到 output/rokbot-android-patched.apk
node android/release/patch-android.mjs \
  --input-apk /path/to/grok-bot-1.16.0.xapk \
  --output-apk android/output/rokbot-android-patched.apk \
  --force
```

常用 CLI 参数：

- `--input-apk <path>`（别名 `--input`、`--apk`）：官方 React Native `.xapk` / `.apks` / `.apk`（`ai.x.grok.bot` / `co.anysphere.sand` `1.16.0`）
- `--output-apk <path>`（别名 `--output`）：输出 16KB 对齐并 v2/v3 签名后的 APK 路径（非 `--verify-only` 时必填；每次补丁都会在同目录写入 `patch-report.json`）
- `--package-name <id>`（别名 `--bundle-id`）：重写 Android 包名 / `applicationId`（保留原 `MainActivity` 全限定名并自动重写 `provider.authorities` 与自定义权限前缀）
- `--host <url>`：预置 Host 地址（`http://...`、`https://...` 或 `tailcat://connect/<node>?port=<port>`）
- `--pairing-code <code>`（别名 `--pairing-key`）：预置 6 位配对码（大写字母数字，不含 `I`/`O`/`1`/`0`）
- `--keystore <path>`：指定持久化签名密钥 JSON（默认 `~/.grokbot-local/android-signing.json`，严禁写入 `android/`）
- `--force-hbc`：当 HBC SHA-256 与配方指纹不一致时强制偏移拼接
- `--unsigned`：输出 16KB 对齐的未签名 APK
- `--verify-only`：仅校验输入归档与配方指纹，不写入输出 APK
- `--force`：覆盖已存在的输出 APK
- `--verbose`：在标准输出打印完整 JSON 补丁报告
- `-h` / `--help`：查看完整帮助

## 验证与测试

```bash
# 1. 核心与边界协议测试 (MockHost)
node android/tests/runner.mjs

# 2. 对抗性安全性与 16KB 对齐/签名篡改测试
node android/adversarial/run-adversarial.mjs

# 3. 补丁管线、多 DEX 与功能单元测试
node --test android/patchers/patcher.test.mjs \
  android/tests/adversarial-cli-multidex.test.mjs

# 4. Android 模拟器真实 UI 端到端测试（默认安装 android/output/rokbot-android-patched.apk，包名 ai.x.grok.bot；可通过 PATCHED_APK / TARGET_PKG 覆盖；RN MainActivity 使用 dumpsys activity top + screencap -p，原生模态页使用受限 uiautomator dump）
ANDROID_SERIAL=emulator-5554 node android/tests/emulator-e2e.mjs
```
