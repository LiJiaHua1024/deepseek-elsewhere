# 参与贡献

在提交 Issue 或 Pull Request 之前，请先阅读 [设计原则](docs/PRINCIPLES.md)。

## 提交新功能前先对齐

- 准备开发新功能或调整交互结构前，先开一个 Issue 说明要解决的实际痛点和大致方案，确认符合项目范围后再动手，避免白费功夫。
- 偏离聊天主线、需要引入持久化工作区、本地终端或外层自治流程的功能不在本项目范围内。

## Pull Request 约定

- 每个 PR 尽量只聚焦一件事，说明改动原因和验证方式。
- 提交前请在本地通过基础检查：

```powershell
pnpm type
pnpm lint
pnpm build
```

- 如果改动涉及 `android/` 目录或构建配置，请一并确认 Debug 包可正常构建：

```powershell
.\android\gradlew.bat -p android :app:assembleDebug
```

## 提交信息规范

提交信息使用英文，格式为 `prefix: what changed`：

- 前缀一律小写，仅使用 `feat`、`fix`、`refactor`、`perf`、`docs`、`test`、`build`、`ci`、`chore`，不自造前缀，也不加 scope 括号（不写 `feat(auth):` 这类形式）。
- 标题用一句话概括，控制在十个词左右，不写长句。
- 正文按改动性质处理：多项独立改动使用一级 Markdown 无序列表（`-`），各条互不重复；单个较大的改动直接写一到两段连贯段落；单个小改动只写标题，不写正文。
- 正文不按 72/80 字符手动硬换行。

## 开源协议

本仓库采用 [GPL-3.0 许可证](LICENSE)，提交的代码默认遵循相同协议。
