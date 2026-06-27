# Teams 通知设置

在 Teams 网页（含 `teams.live.com/v2` 个人版）过滤群组通知，私信始终放行；支持聊天内群链接 / 邀请链接网页直达。

## 功能

- **通知过滤**：替换页面内 `window.Notification`，按白名单/黑名单 + 关键词控制群通知
- **群组列表**：从左侧聊天列表 DOM + IndexedDB 读取
- **链接直达**：拦截聊天内 `/l/invite/`、群链接，解析后在网页内打开（不唤起桌面版）
- **隐私**：邀请链接缓存仅存本机，可关闭缓存或一键清除

## 使用

1. 安装扩展，打开 Teams 并登录
2. 点击工具栏图标展开 **Teams 通知设置**
3. 选择工作模式，添加要放行/屏蔽的群组
4. 点击聊天里的群链接或邀请链接 → 自动在网页内跳转

### 白名单模式说明

默认 **「只提醒列表中的群」**：若列表为空，**所有群通知都会被屏蔽**，私信不受影响。请先添加群组。

### 邀请链接打不开的兜底

若提示「无法解析邀请链接」：

- 向群主索取群 ID（`19:...@thread.v2`）粘贴到面板手动添加
- 或在面板搜索群名（需你已在该群中）

## 开发

```bash
# 语法检查
node --check teams-nav.js
node --check teams-invite-resolver.js
node --check teams-link-page.js
```

Chrome / Brave → `chrome://extensions` → 加载已解压的扩展程序 → 选择本目录。

## 版本

**5.6.6** — `teams.live.com` 邀请链接改用 v2 哈希路由 `#/l/invite/<token>?launchType=web&deeplinkId=…&laExpId=…`（参数取自真实「在网页版继续」流程），让已登录网页应用直接解析 token、加入并打开群聊；不再走 launcher，不再唤起桌面版，也不会只停在 `/v2/` 首页。邀请页脚本在 v2 应用内改为「被动模式」（仅拦截桌面版跳转），避免误扫聊天列表跳错群。

**5.6.5** — 针对 `teams.live.com` 邀请链接改用 launcher 网页流（关闭 `msLaunch/directDl`），避免只刷新 Teams 首页
