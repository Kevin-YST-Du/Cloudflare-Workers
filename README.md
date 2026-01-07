# Workers Pro IDE (Editor) 部署与使用指南

## 这是一个轻量级的 Cloudflare Workers 在线集成开发环境 (IDE)。它允许你通过 API 直接拉取自己账号下的所有 Worker 脚本，在 Monaco Editor（VS Code 同款内核）中进行实时编辑，并一键同步部署回 Cloudflare。

## ✨ 核心功能

### 脚本管理：一键刷新列表，支持查看账号下所有的 Worker 脚本。

### 代码拉取：实时获取指定脚本的源代码及环境绑定 (Bindings)。

### 专业编辑：集成 Monaco Editor，支持语法高亮、自动补全。

### 移动端补丁：针对手机端优化，新增 [全选] [复制] [粘贴] 独立按钮，解决移动端编辑器无法呼出原生菜单的痛点。

### 双色主题：支持明亮/暗黑模式切换，保护视力。

### 同步部署：一键式 PUT 提交，直接更新 Cloudflare 生产环境脚本。

## 🛠️ 部署流程

### 创建主控 Worker：在 Cloudflare 中新建一个 Worker（例如命名为 worker-editor）。

### 粘贴代码：将 editor.js 中的代码完整粘贴并保存。

### 设置路由/域名：建议绑定一个自定义域名以方便访问。

### 无需绑定 KV：该编辑器直接调用 Cloudflare 官方 API，不产生本地数据存储。

## 🔑 使用说明 (凭证获取)

### 使用本编辑器需要填写以下两个核心参数：

## 1. Account ID (账户 ID)

### 获取路径：登录 Cloudflare 仪表板，点击进入任意一个域名或 Worker 页面，在右侧侧边栏即可找到 “Account ID”。

## 2. API Token (API 令牌)

### 获取路径：[My Profile] -> [API Tokens] -> [Create Token]。

### 权限要求：选择 "Edit Cloudflare Workers" 模板，确保该 Token 拥有对 Workers Scripts 的 Edit 权限。

## 📱 移动端增强补丁说明

### 在手机或平板设备上，Monaco Editor 往往难以触发系统的“全选”或“粘贴”弹出框。本版本特别新增了三个逻辑按钮：

### 全选 (Select All)：强制编辑器选中所有代码并聚焦。

### 复制 (Copy)：将编辑器内容提取并写入系统剪贴板（需浏览器支持 navigator.clipboard）。

### 粘贴 (Paste)：尝试读取系统剪贴板内容并覆盖/插入当前光标位置（首次使用需点击浏览器弹出的“允许访问剪贴板”提示）。

## ❓ 常见问题 (FAQ)

## Q: 为什么输入 ID 和 Token 后列表刷新不出来？
### A: 请检查你的 API Token 权限。Token 必须包含 Account - Workers Scripts - Edit 和 Account - Workers - Read 权限。另外，请确保你的网络环境可以正常访问 api.cloudflare.com。

## Q: 点击“同步部署”会覆盖我之前的配置吗？
### A: 本编辑器在部署时会尝试获取并保留原有的 Bindings（变量绑定、KV 绑定等），但建议在进行重大修改前先通过“验证并拉取代码”功能备份你的原始代码。

## Q: 为什么被称为“红色警告版”？
### A: 因为该工具具备直接修改并覆盖生产环境代码的能力。点击“确认部署”是一个高危操作，请务必确认代码无误后再执行。

## Q: 是否可以在编辑器里新建脚本？
### A: 目前版本仅支持编辑已存在的脚本。如需新建，请先在 Cloudflare 官方后台创建一个空白脚本。

## 📄 法律说明

### 本项目仅供网络技术研究和学习使用。操作涉及 Cloudflare 核心 API，请妥善保管你的 API Token，切勿泄露给他人

# 许可证
## 本项目基于 MIT 许可证开源。
