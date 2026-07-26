# Fab Content Downloader

> ⚠️ AI Slope
>
> 这是个纯 Vibe、低维护的 throw-away 项目。它不是 Epic Games 或 Fab 的官方产品，不会上架 Chrome Web Store，也不保证持续更新、兼容性或技术支持。
>
> Use at your own risk.
>
> 只下载你有权访问的内容。账号、数据、许可证、平台条款和本地文件风险由使用者自行判断和承担。
>
> 有任何疑问，让你的 Ai 看 [SPECS.md](SPECS.md)。

![image-example](./images/page-example.webp)

## 它是做什么的？

有相当一部分 UE 内容是无法在 Fab 网页下载的。你需要装一个不知道哪天作妖的 Epic games launcher，装上特定版本的引擎，创建一个特定版本的项目，仅仅为了下载一个资产包。也许 Epic 觉得我们都是傻子，不知道该下哪个版本。

Anyway，把这个插件装到你的 chrome，你可以浏览 Fab UE 库中的内容并选择任意版本下载到本地。

## 依赖项

- 桌面版 Chrome 103 或更高版本。
- 一个能够正常登录、并且已经拥有相关内容的 Epic Games/Fab 账号。
- 足够保存下载结果的磁盘空间和可用内存。
- 能够解压 `.tar` 文件的工具。

不需要安装 Epic Games Launcher 或 Unreal Engine。

## 怎么用

### 安装

1. 下载并解压完整项目，确认 `manifest.json` 位于目录根部。
2. 在 Chrome 打开 `chrome://extensions/`。
3. 打开右上角的 **Developer mode**。
4. 点击 **Load unpacked**，选择包含 `manifest.json` 的目录。
5. 可选：将扩展固定到工具栏。

本项目没有 Chrome Web Store 版本。更新时请替换完整扩展目录，然后在 `chrome://extensions/` 中重新加载扩展。

### 下载

1. 首先在 Fab 官网登录。
2. 点击扩展图标，再点击 **Login with Epic Games**。
3. 登录完成后，点击 **Open Library**。
4. 在 Library 中找到资产并选择需要的版本。
5. 点击下载，并允许扩展写入你选择的本地目录。
6. 下载结果是一个 `.tar` 文件，请自行检查并解压。

## License

GPL-3.0
