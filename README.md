<div align="center">

# Elsewhere

去「**别的地方**」玩，不要耽误 AGI 训练

<p>
  <img src="docs/assets/go-play-elsewhere.jpg" alt="去别的地方玩，不要耽误 AGI 训练" width="420" />
</p>

[![Release](https://img.shields.io/github/v/release/LiJiaHua1024/deepseek-elsewhere?style=flat-square&color=2563eb&label=Release)](https://github.com/LiJiaHua1024/deepseek-elsewhere/releases/latest)
[![Platform](https://img.shields.io/badge/Platform-Android%2010%2B-3DDC84?style=flat-square&logo=android&logoColor=white)](https://github.com/LiJiaHua1024/deepseek-elsewhere)
[![License](https://img.shields.io/badge/License-GPL%20v3-blue?style=flat-square)](LICENSE)

<br />

[**📥 下载安装包**](https://github.com/LiJiaHua1024/deepseek-elsewhere/releases/latest) · [**设计原则**](docs/PRINCIPLES.md) · [**参与贡献**](CONTRIBUTING.md) · [**反馈问题**](https://github.com/LiJiaHua1024/deepseek-elsewhere/issues)

</div>

---

Elsewhere 是一个面向日常与深度对话的纯粹 AI 聊天客户端，基于 [deepseek-app-replica](https://github.com/LiJiaHua1024/deepseek-app-replica) 独立演进。

它保留了接近 DeepSeek 官方移动端的顺滑手感与克制界面，不依赖官方账号限额，直接使用个人 API Key 或自定义兼容端点，所有会话与附件保存在本地，并可与官方 App 及 `deepseek-app-replica` 共存安装。关于本项目做什么与不做什么，见 [设计原则](docs/PRINCIPLES.md)。

## 下载与安装

前往 [GitHub Releases](https://github.com/LiJiaHua1024/deepseek-elsewhere/releases) 下载最新 APK 并安装至 Android 设备（支持 Android 10 / API 29 及以上）。

## 使用步骤

1. 安装并打开 Elsewhere，点击左上角抽屉菜单进入「设置」。
2. 在「账号与数据」中填入 DeepSeek 开放平台 API Key，或在高级设置中配置自定义模型、协议与端点。
3. 返回主页面即可开始对话，支持深度思考、联网搜索、语音对讲、多模态附件与官方历史记录导入导出。

---

## 技术架构

项目采用 Android 原生容器承载高性能 Web 交互内核的架构：

- **Android 原生层**：基于 Java 17 与 Android SDK 37（最低兼容 Android 10 / API 29），使用独立包名 `io.github.lijiahua1024.elsewhere`。封装 Keystore 加密存储、原生录音（`AudioRecord`）、系统相册快速预取、应用内更新与内置网页浏览器（`SourceBrowserActivity`）。
- **Web 交互层**：React 18 + TypeScript + Zustand 状态管理，CSS Modules 样式体系，集成 KaTeX、Mermaid 与 Prism.js 排版渲染。
- **构建系统**：Rspack 2 高速打包，与 Gradle `buildWeb` 任务联动。

## 源码构建

### 环境要求
- Node.js 22.12+ 与 pnpm
- JDK 17+
- Android SDK Platform 37

### 构建步骤
```powershell
# 1. 克隆代码并安装前端依赖
git clone https://github.com/LiJiaHua1024/deepseek-elsewhere.git
cd deepseek-elsewhere
pnpm install

# 2. 编译生成 Android Debug APK（会自动触发前端构建打包）
.\android\gradlew.bat -p android :app:assembleDebug
```

编译输出路径：`android/app/build/outputs/apk/debug/app-debug.apk`

### 前端校验
```powershell
pnpm type
pnpm lint
pnpm build
```

---

## 项目结构

```text
├── android/            # Android 原生容器源码与 Gradle 工程
│   └── app/src/main/   # 原生代码（Keystore 存储、录音、相册、更新、浏览器）
├── docs/               # 项目设计原则与文档
├── src/
│   ├── app/            # 应用布局、主题体系与 Android 平台适配
│   ├── components/     # UI 组件库（聊天流、输入框、搜索抽屉、设置面板等）
│   ├── services/       # 业务逻辑（API 请求、流式解析、会话存储与备份）
│   ├── i18n/           # 多语言文案（中/英）
│   └── utils/          # 通用工具函数
├── rspack.config.ts    # Rspack 打包配置
└── package.json        # 项目配置与脚本入口
```

---

## 免责声明

本项目为独立开源客户端，非 DeepSeek 官方发布版本。项目内提及的第三方商标、标识及版权均归其各自所有者所有。

## 开源协议

本项目采用 [GPL-3.0 许可证](LICENSE)，衍生自 [deepseek-app-replica](https://github.com/LiJiaHua1024/deepseek-app-replica)（GPL-3.0）。部分基础代码源自 DeepSeek 官方开源的 [chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT 许可证），依其条款保留原作者版权声明。
