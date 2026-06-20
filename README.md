# Teams 通知过滤器

## 功能
- **私人消息始终通知**
- **只有「通知文件夹」里的群组才会提醒**
- 其他群组默认静默
- 在 Teams 页面右下角 **「通知管理」** 面板里直接操作，无需手打群名

## 安装（Chrome / Brave / Edge 等 Chromium 浏览器）
1. 打开 `brave://extensions/`（Chrome 为 `chrome://extensions/`）
2. 开启「开发者模式」
3. 加载已解压的扩展程序，选择本项目文件夹

## 使用
1. 重新加载插件
2. 打开 `https://teams.microsoft.com/` 并登录
3. 点击右下角 **「通知管理」**
4. 在 **「其他群组」** 里点击 **「移入通知」**，或拖拽到 **「通知文件夹」**
5. 私人消息在顶部单独显示，始终会通知

## Brave 浏览器必读

Brave 的 **Shields（盾牌）** 会拦截 Microsoft 登录 Cookie，导致：
- 反复弹出登录页
- 已登录仍显示未登录

**请按以下步骤设置（只需一次）：**

1. 打开 `https://teams.microsoft.com/`
2. 点击地址栏右侧的 **狮子图标（Brave Shields）**
3. 将 Shields 设为 **关闭**，或 Advanced → 允许 **All cookies**
4. 对 `login.microsoftonline.com` 登录页重复同样操作（若出现）
5. 刷新页面，完成登录

也可在 `brave://settings/cookies` 添加允许：
- `[*.]teams.microsoft.com`
- `[*.]login.microsoftonline.com`
- `[*.]microsoftonline.com`

## 说明
- 需保持 Teams 网页标签页打开（可切到其他网站）
- 插件启用时会拦截 Teams 网页原生通知，由扩展按规则统一提醒
- 扩展不会自动新建 Teams 标签，只切换到你已打开的标签
