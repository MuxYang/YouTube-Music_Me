# YouTube Music Me

[English](README.md)

面向 Windows、Linux 和 macOS 的非官方 YouTube Music Electron 桌面客户端。客户端加载官方 YouTube Music 网页，并增加原生桌面集成、同步歌词、歌词翻译和可配置的窗口行为。

**应用类型：** 使用 Electron 与 `WebContentsView` 构建的非官方桌面客户端。

## 功能

### 桌面集成

- 为歌曲和音乐视频提供 Windows SMTC 与 Chromium Media Session 信息，包括歌名、艺术家或频道、封面、播放状态和独立于上一首歌曲的时间轴。
- 无边框主窗口支持导航栏拖动，并提供最小化、最大化/还原和关闭按钮。
- 可将关闭行为设为每次询问、最小化到系统托盘或退出应用。
- 持久保存 YouTube Music 会话、PWA 存储、缓存、最后访问的 URL 和窗口位置。
- 使用带系统边框的独立 Google 登录窗口，登录后刷新主页面会话。
- 音量图标支持悬浮滚轮调节，每次增减 5%。
- 使用自定义细滚动条、Material 风格右键菜单和关闭确认弹窗。

### 歌词与翻译

- 同步歌词默认关闭，仅在用户明确同意后发送请求。
- 普通歌曲在开启网易云歌词后优先查询网易云音乐，LRCLIB 仅作为 fallback。
- 音乐视频优先使用 YouTube CC，再查询用户配置的歌词服务。
- 使用歌名和艺术家别名、专辑、时长、双语标题及 `Artist - Song` 视频标题进行确定性匹配。
- 自然切歌时清除上一首时间轴，并自动重新获取歌词。
- 支持 Google 翻译和 DeepL API Free；DeepL 密钥使用操作系统加密保存。
- 非简体中文用户可选择使用已对齐的网易云中文歌词作为翻译输入，无法使用时回退到原文。
- 在服务限制允许时，整首歌词只使用一次翻译请求；超出限制后仅在完整歌词行之间分片。

### 界面

- 使用官方 YouTube Music 平台标识的纯黑启动动画，并在网页准备完成前显示 Material 加载层。
- 在设置页加入“其他”分类，用于配置透明效果、动画、歌词服务、翻译和关闭行为。
- 可为设置、账号菜单、搜索建议、播放器底栏和当前队列项启用半透明效果。
- 使用接近 YouTube 官方样式的自定义设置 Picker，并在设置页滚动时关闭。
- 注入界面的翻译存放在 `src/i18n/<lang>.json`，目前包含 `en-us`、`zh-cn` 和 `zh-tw`。
- 更改 YouTube Music 语言或执行刷新操作时重启应用，确保网页和注入控件使用相同语言。
- 服务条款和隐私政策链接使用系统浏览器打开。

## 第三方服务

只有在用户开启对应设置并通过确认提示后，可选功能才会连接以下服务：

- **LRCLIB：** 接收歌曲标题、艺术家、专辑和时长，用于搜索同步歌词。
- **网易云音乐：** 接收歌曲搜索信息，并可能返回原文歌词和翻译歌词。
- **Google 翻译或 DeepL：** 在用户请求翻译时接收歌词文本；DeepL 需要用户自己的 API Free 密钥。

仓库不包含歌曲、视频或歌词文件。功能可用性和返回结果取决于上游服务。

## 开发

```powershell
npm install
npm start
```

运行测试：

```powershell
npm test
```

## 打包

Windows：

```powershell
npm run dist:win
```

Windows、Linux 和 macOS 软件包由 GitHub Actions 的 `Build desktop packages` 工作流构建。任意 commit push 和 `v*` Tag push 都会触发，也可以在 Actions 页面手动运行。

Linux 构建使用 Debian 13 容器。若要在本地 Linux 环境构建：

```bash
npm ci
npm run dist:linux
```

Linux 构建会生成 AppImage、Debian 软件包、RPM 软件包和便携 tarball 四种产物。构建产物输出到 `release/`。Linux 托盘功能依赖桌面环境提供 StatusNotifier/AppIndicator 支持。

工作流还会生成未签名的 macOS Universal DMG 和 ZIP。这些实验性产物未经 Apple 公证，可能需要用户在 macOS Gatekeeper 中手动允许。

## 维护性警告

> [!WARNING]
> 本项目的大部分代码由 AI 辅助生成或重写，可能存在抽象不一致、隐藏耦合、冗余逻辑、缺少文档说明的隐含假设，以及难以理解和维护的行为。在将代码用于其他项目、继续扩展或部署之前，请完整审查实现并进行充分测试。

## 免责声明

YouTube Music Me 是独立开发的非官方开源项目，与 YouTube、Google、LRCLIB、网易云音乐或 DeepL 没有隶属、授权、赞助或背书关系。YouTube、YouTube Music、Google 及其他产品名称和商标均归其各自权利人所有。

本应用依赖的第三方网页和服务可能随时变更、限制访问或停止工作。用户应自行遵守适用法律，以及所启用服务的条款和隐私政策。本项目按现状提供，不对服务可用性、内容准确性或特定用途适用性作出保证。
