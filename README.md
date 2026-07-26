# Fab Content Downloader

Fab Content Downloader 是一个通过 Chrome 开发者模式安装的非官方工具。它用于浏览当前 Epic/Fab 账号已经拥有的 Unreal Engine 内容，并将选定版本下载为本地 `.tar` 归档，无需为了下载而安装对应版本的 Unreal Engine。

> [!WARNING]
> 这是一个低维护、按现状提供的 throw-away 工具，不是 Epic Games 或 Fab 的官方产品，不会发布到 Chrome Web Store，也不承诺自动更新、兼容性或技术支持。使用者需要自行判断账号、数据、许可证和平台条款风险，并自行承担使用后果。

![Library page example](./images/page-example.webp)

## 能做什么

- 浏览当前账号的 Fab Unreal Engine 资源库。
- 查看资产可用的 artifact、引擎版本和目标平台。
- 选择一个版本，直接从 Epic CDN 下载并组装文件。
- 将结果保存成单个 TAR，避免浏览器逐个创建 `.dll`、`.exe` 等文件时受到限制。

它不会授予新的资产权限，也不应用于下载当前账号无权访问的内容。

## 环境要求

- Chrome 103 或更高版本。
- 能正常登录 Epic Games/Fab 的账号。
- 足够存放 TAR 和下载中临时数据的磁盘空间。
- 对所选目录的 Chrome 写入授权。

## 通过开发者模式安装

本项目没有 Chrome Web Store 版本。请从你信任的仓库副本或手动发布 ZIP 安装：

1. 解压完整项目，确认 `manifest.json` 位于目录根部。
2. 在 Chrome 打开 `chrome://extensions/`。
3. 打开右上角的 **Developer mode**。
4. 点击 **Load unpacked**，选择包含 `manifest.json` 的目录。
5. 可选：将扩展固定到工具栏。

更新时，用新文件替换整个扩展目录，再在 `chrome://extensions/` 中点击扩展卡片上的刷新按钮。不要只覆盖部分文件。

## 使用方法

1. 在浏览器中正常登录 Epic Games/Fab。
2. 点击扩展图标，再选择 **Login with Epic Games**。
3. 在 Epic 打开的授权页完成登录。扩展只接受它刚刚创建、与该标签页绑定且尚未使用的登录回调。
4. 打开 **Library**，等待资产列表加载完成。
5. 选择资产版本并点击下载。
6. Chrome 出现目录选择器时选择输出目录。取消选择不会启动 Manifest 或 CDN 请求。
7. 下载完成后，用可信的归档工具检查并解压生成的 `.tar`。

同一资产一次只运行一个下载任务，整个 Library 页最多同时运行两个任务。输出名称包含版本、稳定资产标识和一个随机的 96-bit 后缀。这个后缀用于避开多标签页和外部程序之间没有“原子独占创建”接口的问题；扩展仍会先检查同名文件，但 File System Access API 无法提供数学意义上的跨进程不覆盖保证。

## OAuth 客户端凭据说明

源代码包含 Epic Launcher 使用的 `launcherAppClient2` OAuth client ID 和 client secret。这里的 client secret：

- 是 OAuth 客户端向 Epic token endpoint 表明“客户端身份”时使用的字符串；
- 不是 SSL/TLS 私钥、证书或用于加密下载内容的密钥；
- 是固定的客户端标识，不会根据安装电脑或每次安装自动变化；
- 随源代码或客户端程序分发后，无法像服务端专用秘密那样真正保密。

本工具依赖该客户端身份与现有 Epic 接口交互。公开传播可能增加它被复制、滥用、限流、识别、轮换或撤销的概率，任何一种情况都可能让登录功能失效。因此建议将工作仓库保持为 private，并避免在日志、截图或讨论中再次传播凭据。

目前没有在本项目中确认 Epic 是否对该共享客户端凭据施加了可执行的保密或禁止复用义务。这里的说明不是法律意见，也不代表 Epic 授权使用；使用者应自行核对适用于自己的 Epic/Fab 条款和当地法律。

## 本地数据与登录状态

扩展不使用开发者服务器，也不包含分析或遥测。它只与清单中列出的 Epic、Fab 和 Epic CDN HTTPS 主机通信。

| 数据 | 保存位置 | 生命周期 |
| --- | --- | --- |
| Access token、账号显示信息 | `chrome.storage.session` | 当前浏览器会话；Service Worker 重启不会丢失 |
| Refresh token、账号 ID、刷新过期时间 | `chrome.storage.local` | 持久保存，用于下次启动恢复登录 |
| 待处理 OAuth 事务、认证代次 | `chrome.storage.session` | 最长 5 分钟或单次使用 |
| 精简资源库缓存 | 扩展 IndexedDB | 按账号隔离，正常有效期 24 小时；旧的完整快照只用于显式 stale fallback |

local/session storage 都限制为可信扩展上下文，Content Script 不能直接读取。但 `chrome.storage.local` 不是密码保险库：refresh token 会以 Chrome 配置文件数据的形式留在磁盘上，能够访问操作系统账号或 Chrome 配置文件的程序可能取得它。

点击注销会立即清除 access token、refresh token、待处理登录事务，以及刚才登录账号的资源库缓存；已经打开的 Library 页也会清空旧卡片并中止当前下载。超过 24 小时的完整缓存不会自动跨账号显示，但在注销、切换账号或卸载扩展前可能继续留在 IndexedDB 中。不要将 Chrome 配置文件、扩展存储、带查询参数的 CDN URL、真实 token 或授权码提交到仓库或发送给他人。

## 文件与下载安全

- 目录权限只在用户点击下载并选择目录后申请。
- CDN URL 必须使用 HTTPS，并同时通过静态主机白名单和本次下载 descriptor 的来源检查。
- Manifest、chunk 和文件长度会校验；chunk SHA-1 在格式提供时校验，最终每个文件都必须通过非零 SHA-1，失败会终止下载。
- JSON Manifest 为 32 MiB、二进制 Manifest 响应为 64 MiB、解压后 Manifest 为 128 MiB；结构数量、解压数据、并发请求、chunk 缓存以及最终归档估算也有硬上限。
- 预计 TAR 或最坏 CDN fallback 流量超过 32 GiB 时，会在创建输出和请求 chunk 前再次要求确认；描述超过 512 GiB 文件、512 GiB chunk 流量上界或 520 GiB TAR 的 Manifest 会直接拒绝。
- 归档路径会拒绝绝对路径、父目录跳转、Windows 保留名和规范化冲突；合法长路径使用 PAX。
- 取消或失败会中止网络请求和 writable stream；不会把未完成文件报告为成功。若浏览器或文件系统拒绝清理，错误会显示实际随机文件名，使用者需要手动删除它。

TAR 仍然可能包含可执行文件、插件或脚本。只下载你信任的资产，先查看归档内容，再解压到独立目录；不要直接覆盖重要项目或系统目录。

## 手动 Chrome smoke test

每次准备手动发行前，在一个测试 Chrome profile 中完成以下检查：

- 从干净目录 **Load unpacked**，确认 popup、Library 和控制台没有启动错误。
- 登录成功；重新加载或重复提交同一个 OAuth 回调不能再次完成登录。
- 关闭并重新打开 Chrome，确认 refresh token 能恢复会话，且 `storage.local` 中没有 access token。
- 注销后确认 popup 回到未登录状态、token 被清除、原账号缓存不再显示。
- 使用两个不同账号分别刷新 Library，确认缓存不会交叉显示。
- 正常加载多页 Library；断网刷新时保留并标记旧的完整缓存，而不是显示虚假的成功。
- 在目录选择器中取消，确认没有 Manifest/CDN 请求，也没有创建文件。
- 分别下载至少一个 JSON Manifest 资产和一个未加密 binary Manifest 资产，记录其 feature/header 版本，解包并核对文件数量与下载完成提示。当前实现会安全拒绝 binary feature 22+ 和 chunk header v4+，在取得真实格式样本前不要放宽。
- 下载同一资产的两个版本，确认输出名不同；重复下载同一版本，确认随机后缀不同且旧文件没有被覆盖。
- 在下载中途取消，确认实际网络请求停止，未完成输出不会被当作成功归档；若清理被系统拒绝，确认 UI 明确提示需手动删除的文件名。
- 用一个较大资产观察 Chrome task manager，确认并发请求不超过 6，chunk 内存预算不会持续无界增长。
- 用本地合成数据确认 TAR 或 chunk 流量估算超过 32 GiB 时会要求二次确认，拒绝后不创建 TAR、也不请求 chunk。
- 对真实签名 CDN 分发点验证查询参数兼容策略、是否需要 HTTP 重定向，以及 Fab 返回的 `manifestHash` 格式和含义；测试记录必须移除 token 和签名查询内容。

畸形 Manifest、错误 hash、危险 TAR 路径和超限响应使用本地合成数据验证，不要故意向 Epic/Fab 服务发送异常负载。

## 手动发布

项目不使用自动 CI、自动 Release 或 Chrome Web Store 发布。维护者在本地完成检查后手动创建 ZIP，ZIP 根目录必须直接包含 `manifest.json`。

发布包使用显式清单，只包含运行时代码和资源，以及：

- `README.md`
- `SPECS.md`
- `LICENSE`

不要打包 `.git`、`.github`、下载产物、日志、Chrome profile、临时测试文件、真实 token、授权码或完整签名 URL。发布前应再次检查归档文件列表，并从解压后的 ZIP 执行一次 **Load unpacked** smoke test。

## 技术说明

最终架构、信任边界、消息 ACL、缓存模型和下载校验规则见 [SPECS.md](SPECS.md)。

## License

本项目按 [GNU General Public License v3.0](LICENSE) 分发。
