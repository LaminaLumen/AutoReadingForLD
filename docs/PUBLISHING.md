# 用户脚本发布指南

根目录的 `Lanyue.user.js` 是唯一发布文件。GitHub `main` 分支用于稳定版本，用户脚本元数据中的下载与更新地址均指向该文件。

## GitHub Raw

稳定安装地址：

<https://raw.githubusercontent.com/LaminaLumen/Lanyue/main/Lanyue.user.js>

更新 `main` 分支后，Tampermonkey、Violentmonkey 和 ScriptCat 可根据 `@updateURL` 检查新版本。

澜阅作为新的脚本条目发布，不沿用 AutoReadingForLD 的发布文件与更新地址。发布说明需提醒旧版用户先停用旧脚本，再安装澜阅。

## Greasy Fork

1. 登录 Greasy Fork 并选择发布新脚本。
2. 粘贴 `Lanyue.user.js` 的完整内容。
3. 描述优先复用 `README.md` 中的功能、隐私和安装说明。
4. 源码同步方式可设置为 GitHub Raw 地址。
5. 每次发布前运行 `npm run check`，并确认版本号高于已发布版本。

建议分类为“实用工具”，不要使用“刷等级、刷帖量、自动互动”等容易误导项目边界的描述。

## ScriptCat

1. 登录 ScriptCat 脚本站并创建普通用户脚本。
2. 上传或粘贴 `Lanyue.user.js`。
3. 填写项目主页和问题反馈地址。
4. 核对平台识别出的权限只有 `none`，匹配范围只有帖子页及 `/new`、`/unread`、`/unseen`、`/latest` 四个列表入口。
5. 发布后分别用 ScriptCat 和 Tampermonkey 做一次安装验证。

## 发布前检查

- [ ] `npm run check` 通过；
- [ ] 亮色、暗色和窄屏人工验证通过；
- [ ] `/t/`、`/n/` 与四个列表入口均可运行；
- [ ] 当前帖、自动帖、连续读及停止/恢复流程均通过；
- [ ] 更新日志包含用户可感知变化；
- [ ] GitHub Raw 返回最新版本；
- [ ] 脚本管理器能够识别安装和后续更新。
