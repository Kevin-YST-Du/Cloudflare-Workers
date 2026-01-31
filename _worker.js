/**
 * WorkerS Pro Editor V7.6 - D1 独立运行修复版
 * * * * 历史版本锁定说明 * *
 * [基础架构]: 基于 V7.5 (UI 细节修复版)。
 * * * * V7.6 变更说明 * *
 * 1. [核心修复] 修复了"未绑定 KV_STORAGE"报错问题。
 * - 旧逻辑：Token 登录强制检查 KV_STORAGE。
 * - 新逻辑：只要检测到 DB (D1) 或 KV_STORAGE 任意一个存在，即可正常运行。
 * 2. [兼容] 完美支持仅绑定 D1 数据库的场景，无需再额外部署 KV。
 * 3. [继承] 保留了之前所有的名称自动解析、UI 优化等功能。
 */

export default {
  async fetch(request, env) {
    // 统一 JSON 响应辅助函数
    const jsonRes = (obj) => new Response(JSON.stringify(obj), {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8'
      }
    });

    // --- 存储层核心逻辑 (D1 + KV 双驱) ---

    // 初始化 D1 表结构 (懒加载)
    const initDB = async () => {
      if (env.DB) {
        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS user_tokens (
              id TEXT PRIMARY KEY,
              token TEXT,
              created INTEGER,
              expiry INTEGER,
              boundAccountId TEXT,
              boundApiToken TEXT
            )
          `).run();
        } catch (e) {
          console.error("DB Init Failed:", e);
        }
      }
    };

    // 获取所有 Token (优先 D1，降级 KV，自动同步)
    const getAllTokens = async () => {
      await initDB();
      let tokens = [];
      let loadedFromD1 = false;

      // 1. 尝试从 D1 读取
      if (env.DB) {
        try {
          const { results } = await env.DB.prepare('SELECT * FROM user_tokens ORDER BY created ASC').all();
          if (results && results.length > 0) {
            // 映射字段名，防止 D1 返回小写字段导致读取失败
            tokens = results.map(row => ({
              id: row.id,
              token: row.token,
              created: row.created,
              expiry: row.expiry,
              boundAccountId: row.boundAccountId || row.boundaccountid,
              boundApiToken: row.boundApiToken || row.boundapitoken
            }));
            loadedFromD1 = true;
          }
        } catch (e) {
          console.error("D1 Read Error:", e);
        }
      }

      // 2. 如果 D1 为空，尝试从 KV 读取 (备份/迁移)
      if (!loadedFromD1 && env.KV_STORAGE) {
        const kvTokens = await env.KV_STORAGE.get('user_tokens_list', {
          type: 'json'
        }) || [];
        
        if (kvTokens.length > 0) {
          tokens = kvTokens;
          // [同步] 检测到 KV 有数据但 D1 没有，触发自动回写 D1
          if (env.DB) {
            for (const t of tokens) {
              try {
                await env.DB.prepare('INSERT OR IGNORE INTO user_tokens (id, token, created, expiry, boundAccountId, boundApiToken) VALUES (?, ?, ?, ?, ?, ?)')
                  .bind(t.id, t.token, t.created, t.expiry, t.boundAccountId, t.boundApiToken)
                  .run();
              } catch (e) {}
            }
          }
        }
      }
      return tokens;
    };

    // 保存 Token (双写模式)
    const saveToken = async (tokenObj) => {
      await initDB();
      // 1. 写入 D1
      if (env.DB) {
        try {
          await env.DB.prepare('INSERT OR REPLACE INTO user_tokens (id, token, created, expiry, boundAccountId, boundApiToken) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(tokenObj.id, tokenObj.token, tokenObj.created, tokenObj.expiry, tokenObj.boundAccountId, tokenObj.boundApiToken)
            .run();
        } catch (e) {
          console.error("D1 Write Error:", e);
        }
      }
      // 2. 写入 KV
      if (env.KV_STORAGE) {
        let current = await getAllTokens();
        if (!current.find(t => t.id === tokenObj.id)) {
          current.push(tokenObj);
        }
        await env.KV_STORAGE.put('user_tokens_list', JSON.stringify(current));
      }
    };

    // 删除 Token (双删模式)
    const deleteTokenById = async (id) => {
      await initDB();
      // 1. 删除 D1
      if (env.DB) {
        try {
          await env.DB.prepare('DELETE FROM user_tokens WHERE id = ?').bind(id).run();
        } catch (e) {
          console.error("D1 Delete Error:", e);
        }
      }
      // 2. 删除 KV
      if (env.KV_STORAGE) {
        let current = await getAllTokens();
        const newTokens = current.filter(t => t.id !== id);
        await env.KV_STORAGE.put('user_tokens_list', JSON.stringify(newTokens));
      }
    };

    // --- Token 生成辅助函数 ---
    const generateComplexToken = async () => {
    // 120 字节 = 240 位 hex
    const array = new Uint8Array(120);
    crypto.getRandomValues(array);

    const randomPart = Array.from(array, d =>
    d.toString(16).padStart(2, '0')
  ).join('');

    const uuid = crypto.randomUUID().replace(/-/g, '');

    return `tk_${uuid.slice(0, 8)}${randomPart}${uuid.slice(24)}`;
};


    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const action = formData.get("action");

        let accountId = formData.get("accountId");
        let apiToken = formData.get("apiToken");
        const loginToken = formData.get("loginToken");
        let isRootAdmin = false;
        let isTokenUser = false;

        if (loginToken) {
          // [V7.6 核心修复] 允许 DB 或 KV_STORAGE 任意一个存在
          if (!env.KV_STORAGE && !env.DB) {
             return jsonRes({ success: false, errors: [{ message: "未绑定存储资源 (需绑定 KV_STORAGE 或 DB)" }] });
          }

          const tokens = await getAllTokens();
          const matchedToken = tokens.find(t => t.token === loginToken);

          if (!matchedToken) {
            return jsonRes({ success: false, errors: [{ message: "无效的 Token (未找到)" }] });
          }
          
          if (matchedToken.expiry !== -1 && Date.now() > matchedToken.expiry) {
            return jsonRes({ success: false, errors: [{ message: "Token 已过期" }] });
          }

          accountId = matchedToken.boundAccountId;
          apiToken = matchedToken.boundApiToken;
          isTokenUser = true;
        } else if (accountId && apiToken) {
          isRootAdmin = true;
        }

        const hasAuth = isRootAdmin || isTokenUser;

        // --- Token 管理 ---
        if (['listTokens', 'createToken', 'deleteToken'].includes(action)) {
          if (!hasAuth) {
            return jsonRes({ success: false, errors: [{ message: "权限验证失败" }] });
          }

          if (action === 'listTokens') {
            let tokens = await getAllTokens();
            const now = Date.now();
            tokens.sort((a, b) => a.created - b.created);
            
            tokens = tokens.map(t => ({
              ...t,
              boundApiToken: '***',
              isExpired: t.expiry !== -1 && now > t.expiry
            }));
            
            return jsonRes({ success: true, result: tokens });
          }

          if (action === 'createToken') {
            const expiryInput = parseInt(formData.get('expiryDays') || '-1');
            if (expiryInput > 365) {
              return jsonRes({ success: false, errors: [{ message: "自定义天数不能超过 365 天" }] });
            }

            const created = Date.now();
            let expiry = -1;
            if (expiryInput > 0) {
              expiry = created + (expiryInput * 24 * 60 * 60 * 1000);
            }

            const newToken = {
              id: crypto.randomUUID(),
              token: await generateComplexToken(),
              created: created,
              expiry: expiry,
              boundAccountId: accountId,
              boundApiToken: apiToken
            };

            await saveToken(newToken);
            return jsonRes({ success: true, result: newToken });
          }

          if (action === 'deleteToken') {
            const tokenId = formData.get('tokenId');
            await deleteTokenById(tokenId);
            return jsonRes({ success: true });
          }
        }

        // --- 编辑器核心业务 ---
        if (!accountId || !apiToken) {
          if (action === 'verifyLogin') {
            return jsonRes({ success: false, errors: [{ message: "Account ID 或 Token 不能为空" }] });
          }
          return jsonRes({ success: false, errors: [{ message: "缺少认证信息" }] });
        }

        const authHeader = {
          'Authorization': `Bearer ${apiToken}`
        };
        const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

        // [V6.4 智能错误翻译]
        const safeFetch = async (url, options = {}) => {
          try {
            const res = await fetch(url, options);
            const text = await res.text();
            let data;

            try { 
              data = JSON.parse(text); 
            } catch (e) {
              // JSON 解析失败时的兜底
              if (text.includes("Could not route") || text.includes("object identifier is invalid")) {
                data = { success: false, errors: [{ message: "Account ID 或 API 填写错误，无法登录" }] };
              } else if (res.status === 400 || res.status === 403) {
                data = { success: false, errors: [{ message: "API Token 无效或权限不足，请检查 Token 是否有 Workers 相关权限" }] };
              } else {
                data = { success: false, errors: [{ message: "API 响应异常: " + text.substring(0, 50) }] };
              }
            }

            // 翻译标准 JSON 错误
            if (data && !data.success && data.errors && data.errors.length > 0) {
              const rawMsg = (data.errors[0].message || "").toString();

              if (
                rawMsg.includes("Could not route") ||
                rawMsg.includes("object identifier is invalid")
              ) {
                data.errors[0].message = "Account ID 或 API 填写错误，无法登录";
              } else if (rawMsg.includes("Invalid access token")) {
                data.errors[0].message = "API Token 无效，请检查";
              } else if (rawMsg.includes("Actor not authorized")) {
                data.errors[0].message = "Account ID 与 Token 不匹配";
              } else if (
                /authentication/i.test(rawMsg) ||
                /invalid.*token/i.test(rawMsg) ||
                /permission/i.test(rawMsg) ||
                /forbidden/i.test(rawMsg)
              ) {
                data.errors[0].message = "API Token 无效或权限不足";
              }
            }

            return { ok: res.ok, status: res.status, data };
          } catch (err) {
            return { ok: false, data: { success: false, errors: [{ message: "网络请求失败: " + err.message }] } };
          }
        };

        if (action === 'verifyLogin') {
          const res = await safeFetch(`${baseUrl}/workers/scripts?per_page=1`, {
            headers: authHeader
          });

          if (res.ok) {
            return jsonRes({ success: true, role: isRootAdmin ? 'root' : 'token' });
          } else {
            const errorMsg = res.data.errors && res.data.errors[0] ? res.data.errors[0].message : "验证失败，凭证无效";
            return jsonRes({ success: false, errors: [{ message: errorMsg }] });
          }
        }


        // [V7.0] 创建资源接口
        if (action === "createResource") {
           const type = formData.get("type");
           const name = formData.get("name");
           if (!name) return jsonRes({ success: false, errors: [{ message: "名称不能为空" }] });

           let url = "";
           let body = {};

           // 目前仅支持 KV 和 D1 的快速创建
           if (type === 'kv_namespace') {
             url = `${baseUrl}/storage/kv/namespaces`;
             body = { title: name };
           } else if (type === 'd1') {
             url = `${baseUrl}/d1/database`;
             body = { name: name };
           } else {
             return jsonRes({ success: false, errors: [{ message: "暂不支持创建此类型资源，请前往控制台创建" }] });
           }

           const res = await safeFetch(url, {
             method: 'POST',
             headers: { ...authHeader, 'Content-Type': 'application/json' },
             body: JSON.stringify(body)
           });
           
           return jsonRes(res.data);
        }

        // 资源列表查询
        if (action === "listResources") {
          const type = formData.get("type");
          let url = "";

          if (type === 'kv_namespace') url = `${baseUrl}/storage/kv/namespaces`;
          else if (type === 'd1') url = `${baseUrl}/d1/database`;
          else if (type === 'r2_bucket') url = `${baseUrl}/r2/buckets`;
          else if (type === 'service') url = `${baseUrl}/workers/scripts`;
          else if (type === 'queue') url = `${baseUrl}/queues`;
          else if (type === 'durable_object_namespace') url = `${baseUrl}/workers/durable_objects/namespaces`;
          else if (type === 'vectorize') url = `${baseUrl}/vectorize/indexes`;
          else if (type === 'hyperdrive') url = `${baseUrl}/hyperdrive/configs`;
          else if (type === 'dispatch_namespace') url = `${baseUrl}/workers/dispatch/namespaces`;
          else if (type === 'analytics_engine') url = `${baseUrl}/analytics_engine/datasets`;

          if (!url) {
            return jsonRes({ success: true, result: [] });
          }

          const res = await safeFetch(url, { headers: authHeader });
          return jsonRes(res.data);
        }

        if (action === "listScripts") {
          const res = await safeFetch(`${baseUrl}/workers/scripts`, { headers: authHeader });
          return jsonRes(res.data);
        }

        if (action === "fetch") {
          const scriptName = formData.get("scriptName");
          if (!scriptName) {
            return jsonRes({ success: false, errors: [{ message: "脚本名称为空" }] });
          }

          const contentRes = await fetch(`${baseUrl}/workers/scripts/${scriptName}`, {
            headers: authHeader
          });
          
          let code = "";
          const ct = contentRes.headers.get("content-type") || "";
          
          if (ct.includes("multipart")) {
            const multi = await contentRes.formData();
            let entry = multi.get("worker.js") || multi.get("index.js");
            code = (typeof entry === 'string') ? entry : await entry.text();
          } else {
            code = await contentRes.text();
          }

          const settingsRes = await safeFetch(`${baseUrl}/workers/scripts/${scriptName}/settings`, {
            headers: { ...authHeader, 'Content-Type': 'application/json' }
          });
          
          let bindings = settingsRes.ok && settingsRes.data.result ? settingsRes.data.result.bindings || [] : [];

          return jsonRes({ success: true, code, bindings });
        }

        if (action === "deploy") {
          const scriptName = formData.get("scriptName");
          const code = formData.get("code");
          const incomingBindings = formData.get("bindings");
          
          let bindings = incomingBindings ? JSON.parse(incomingBindings) : [];

          const cfFormData = new FormData();
          cfFormData.append('worker.js', new Blob([code], {
            type: 'application/javascript+module'
          }), 'worker.js');
          
          cfFormData.append('metadata', JSON.stringify({
            main_module: 'worker.js',
            compatibility_date: '2024-01-01',
            bindings: bindings
          }));

          const deployRes = await safeFetch(`${baseUrl}/workers/scripts/${scriptName}`, {
            method: 'PUT',
            headers: authHeader,
            body: cfFormData
          });
          return jsonRes(deployRes.data);
        }

      } catch (err) {
        return jsonRes({ success: false, errors: [{ message: `系统错误: ${err.message}` }] });
      }
    }

    return new Response(renderUI(), {
      headers: {
        "Content-Type": "text/html;charset=UTF-8"
      }
    });
  },
};

function renderUI() {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Workers Pro Editor V7.6</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M13%202L3%2014H12L11%2022L21%2010H12L13%202Z%22%20stroke%3D%22%23F59E0B%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
    <style>
      /* --- [核心] 隐藏滚动条 --- */
      ::-webkit-scrollbar {
        width: 0px !important;
        height: 0px !important;
        background: transparent !important;
      }
      * {
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }
      .hidden {
        display: none !important;
      }
      
      /* --- 动画 --- */
      @keyframes fadeOutUp {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(-20px); }
      }
      
      @keyframes fadeIn {
        from { opacity: 0; filter: blur(4px); }
        to { opacity: 1; filter: blur(0); }
      }

      @keyframes shake {
        0%, 100% { transform: translateX(0); }
        20%, 60% { transform: translateX(-5px); }
        40%, 80% { transform: translateX(5px); }
      }

      .animate-fade-out {
        animation: fadeOutUp 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards;
      }

      .animate-fade-in {
        animation: fadeIn 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards;
      }

      .animate-shake {
        animation: shake 0.4s ease-in-out;
      }

      /* --- 基础样式 --- */
      :root {
        --bg: #f1f5f9;
        --card: #ffffff;
        --text: #1e293b;
        --border: #e2e8f0;
        --input-bg: #f8fafc;
        --input-text: #1e293b;
        --btn-bg: #e2e8f0;
        --error-red: #ef4444;
        --success-green: #10b981;
      }

      .dark {
        --bg: #0f172a;
        --card: #1e293b;
        --text: #f8fafc;
        --border: #334155;
        --input-bg: #0f172a;
        --input-text: #f8fafc;
        --btn-bg: #334155;
      }

      body {
        background-color: var(--bg);
        color: var(--text);
        font-family: 'Inter', sans-serif;
        padding: 2rem 1rem;
        margin: 0;
        min-height: 100vh;
        display: flex;
        justify-content: center;
        transition: 0.3s;
      }

      .custom-content-wrapper {
        position: relative;
        width: 85% !important;
        max-width: 1400px;
        padding: 2rem;
        border-radius: 1.5rem;
        background: var(--card);
        border: 1px solid var(--border);
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.15);
        display: flex;
        flex-direction: column;
        opacity: 0;
      }

      @media (max-width: 768px) {
        .custom-content-wrapper {
          width: 100% !important;
          padding: 1.25rem;
        }
      }

      .header-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 2rem;
        flex-wrap: wrap;
        gap: 1rem;
      }

      .header-title {
        font-size: 1.875rem;
        font-weight: 900;
        color: #2563eb;
        letter-spacing: -0.05em;
        text-transform: uppercase;
      }

      .header-actions {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .action-icon-btn {
        width: 2.5rem;
        height: 2.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 0.75rem;
        background: var(--btn-bg);
        border: 1px solid var(--border);
        cursor: pointer;
        transition: all 0.2s;
        color: var(--text);
      }

      .action-icon-btn:hover {
        opacity: 0.8;
        transform: translateY(-1px);
      }

      input,
      select,
      textarea {
        background-color: var(--input-bg) !important;
        color: var(--input-text) !important;
        border: 1px solid var(--border) !important;
        outline: none;
        appearance: none;
        -webkit-appearance: none;
      }

      select {
        background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e");
        background-position: right 0.5rem center;
        background-repeat: no-repeat;
        background-size: 1.5em 1.5em;
        padding-right: 2.5rem;
      }

      #monaco-container {
        height: 50vh;
        border-radius: 0.75rem;
        border: 2px solid var(--border);
        overflow: hidden;
        margin: 0.5rem 0 1rem 0;
      }

      .toast {
        position: fixed;
        bottom: 2rem;
        left: 50%;
        transform: translateX(-50%);
        padding: 0.8rem 2rem;
        border-radius: 1rem;
        color: white;
        opacity: 0;
        transition: 0.3s;
        z-index: 2000;
      }

      .toast.show {
        opacity: 1;
      }

      .mobile-action-btn {
        font-size: 0.75rem;
        padding: 0.25rem 0.75rem;
        border-radius: 0.5rem;
        margin-right: 0.5rem;
        color: white;
        font-weight: bold;
        transition: opacity 0.2s;
      }

      .mobile-action-btn:active {
        transform: scale(0.95);
      }

      .footer-signature {
        margin-top: 1.5rem;
        padding-top: 1.2rem;
        border-top: 1px solid var(--border);
        text-align: center;
      }

      .footer-link {
        color: #2563eb;
        font-weight: 700;
        font-size: 0.9rem;
        text-decoration: none;
      }

      .footer-link:hover {
        text-decoration: underline;
      }

      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 1000;
        display: none;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(4px);
      }

      .modal-backdrop.active {
        display: flex;
      }

      .token-modal {
        background: var(--card);
        width: 90%;
        max-width: 800px;
        max-height: 90vh;
        border-radius: 1.5rem;
        padding: 2rem;
        overflow-y: auto;
        border: 1px solid var(--border);
      }

      .login-box {
        background: var(--card);
        width: 100%;
        max-width: 420px;
        padding: 2.5rem;
        border-radius: 2rem;
        border: 1px solid var(--border);
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
        text-align: center;
        transition: all 0.5s;
        position: relative;
      }

      .login-error-msg {
        color: var(--error-red);
        font-size: 0.875rem;
        margin-bottom: 1rem;
        font-weight: 600;
        display: none;
      }

      .tab-btn {
        padding: 0.75rem;
        flex: 1;
        border-bottom: 2px solid transparent;
        color: #94a3b8;
        font-weight: 600;
        cursor: pointer;
        transition: 0.2s;
      }

      .tab-btn.active {
        color: #2563eb;
        border-color: #2563eb;
      }

      .delete-box {
        background: var(--card);
        width: 100%;
        max-width: 360px;
        padding: 2rem;
        border-radius: 1.5rem;
        border: 1px solid var(--border);
        text-align: center;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
      }

      .token-card {
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 1rem;
        padding: 1rem;
        margin-bottom: 1rem;
        position: relative;
        display: flex;
        justify-content: space-between;
        align-items: center;
        word-break: break-all;
      }

      .token-info {
        flex: 1;
        padding-right: 1rem;
      }

      .token-val {
        font-family: monospace;
        font-weight: bold;
        color: #3b82f6;
        cursor: pointer;
        margin-bottom: 0.25rem;
      }

      .token-meta {
        font-size: 0.75rem;
        color: #94a3b8;
      }

      .token-del-btn {
        color: #ef4444;
        cursor: pointer;
        padding: 0.5rem;
        border-radius: 0.5rem;
        transition: 0.2s;
      }

      .token-del-btn:hover {
        background: #fee2e2;
      }

      .badge {
        display: inline-block;
        padding: 0.2rem 0.6rem;
        border-radius: 999px;
        font-size: 0.75rem;
        font-weight: 700;
      }

      .delete-btn {
        position: absolute;
        top: 1rem;
        right: 1rem;
        color: #ef4444;
        cursor: pointer;
        padding: 4px;
        border-radius: 6px;
        transition: 0.2s;
      }

      .delete-btn:hover {
        background: #fee2e2;
      }

      .add-binding-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.5rem;
        height: 1.5rem;
        border-radius: 999px;
        background: #3b82f6;
        color: white;
        cursor: pointer;
        font-size: 1.2rem;
        line-height: 1;
        transition: 0.2s;
      }

      .add-binding-btn:hover {
        background: #2563eb;
        transform: scale(1.1);
      }

      .toolbar-container {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-bottom: 0.5rem;
      }

      .tool-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .binding-row {
        display: flex;
        flex-direction: column; 
        gap: 0.5rem;
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 0.75rem;
        padding: 0.75rem;
        min-height: 4rem;
      }

      /* [V7.2 新增] 详细绑定卡片样式 */
      .binding-card {
        display: flex;
        flex-direction: column;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 0.75rem;
        padding: 0.75rem;
        margin-bottom: 0.5rem;
        position: relative;
        transition: all 0.2s;
        border-left-width: 4px; /* 色条 */
      }
      
      .binding-card:hover {
        transform: translateX(2px);
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
      }

      .binding-card.type-resource { border-left-color: #3b82f6; }
      .binding-card.type-var { border-left-color: #a855f7; }
      .binding-card.type-secret { border-left-color: #f97316; }

      .binding-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.5rem;
        /* [V7.5 修复] 增加右侧内边距，防止徽章与绝对定位的删除按钮重叠 */
        padding-right: 2.5rem;
      }

      .binding-name {
        font-family: monospace;
        font-weight: 700;
        font-size: 1rem;
        color: var(--text);
      }

      .binding-type-badge {
        font-size: 0.7rem;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--bg);
        color: #64748b;
        font-weight: 600;
        border: 1px solid var(--border);
        /* 防止文本过长时不换行导致布局混乱 */
        white-space: nowrap; 
      }

      .binding-details {
        font-size: 0.8rem;
        color: #64748b;
        word-break: break-all;
        background: var(--bg);
        padding: 0.5rem;
        border-radius: 0.5rem;
      }

      .detail-row {
        display: flex;
        margin-bottom: 2px;
      }
      .detail-label {
        font-weight: bold;
        margin-right: 6px;
        min-width: 60px;
        color: #475569;
      }
      .dark .detail-label { color: #94a3b8; }

      .card-del-btn {
        position: absolute;
        top: 0.75rem; /* 与卡片 padding 对齐 */
        right: 0.5rem;
        width: 1.5rem;
        height: 1.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #ef4444;
        cursor: pointer;
        border-radius: 4px;
        opacity: 0.6;
        transition: 0.2s;
      }
      .card-del-btn:hover {
        background: #fee2e2;
        opacity: 1;
      }

      .modal-tabs {
        display: flex;
        margin-bottom: 1rem;
        border-bottom: 2px solid var(--border);
      }

      .modal-tab {
        flex: 1;
        text-align: center;
        padding: 0.75rem;
        cursor: pointer;
        font-weight: 600;
        color: #94a3b8;
        transition: 0.2s;
      }

      .modal-tab.active {
        color: #2563eb;
        border-bottom: 2px solid #2563eb;
        margin-bottom: -2px;
      }
      
      .create-btn {
          margin-top: 0.5rem;
          width: 100%;
          padding: 0.5rem;
          border-radius: 0.5rem;
          background: #dcfce7;
          color: #166534;
          font-size: 0.8rem;
          font-weight: bold;
          cursor: pointer;
          border: 1px solid #bbf7d0;
          transition: 0.2s;
      }
      .create-btn:hover {
          background: #bbf7d0;
      }
      .dark .create-btn {
          background: #064e3b;
          color: #a7f3d0;
          border-color: #065f46;
      }
      .dark .create-btn:hover {
          background: #065f46;
      }
    </style>
  </head>
  <body class="light">

    <div id="login-gateway" class="fixed inset-0 bg-slate-100 dark:bg-slate-900 z-[5000] flex items-center justify-center p-4">
      <div id="login-box-inner" class="login-box">
        <h1 class="text-3xl font-black mb-6 text-blue-600 tracking-tighter uppercase">WORKERS PRO IDE</h1>

        <div class="flex mb-6 border-b border-slate-200 dark:border-slate-700">
          <div onclick="switchTab('admin')" id="tab-admin" class="tab-btn active">Root 登录</div>
          <div onclick="switchTab('token')" id="tab-token" class="tab-btn">Token 登录</div>
        </div>

        <div id="form-admin">
          <input id="login-aid" type="text" placeholder="Account ID" class="w-full p-4 mb-3 rounded-xl outline-none shadow-sm">
          <input id="login-key" type="password" placeholder="API Token" class="w-full p-4 mb-6 rounded-xl outline-none shadow-sm">
        </div>

        <div id="form-token" class="hidden">
          <input id="login-ck" type="password" placeholder="粘贴 Access Token (tk_...)" class="w-full p-4 mb-6 rounded-xl outline-none shadow-sm text-center font-mono">
        </div>

        <div id="login-msg" class="login-error-msg"></div>

        <button onclick="doLogin()" id="login-btn" class="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-xl font-bold text-lg shadow-lg active:scale-95 transition">
          进入系统
        </button>
      </div>
    </div>

    <div class="custom-content-wrapper" id="main-interface">

      <div class="header-row">
        <h1 class="header-title">WORKERS PRO IDE <span class="text-sm font-normal text-slate-400">V7.6</span></h1>
        <div class="header-actions">
          <div id="user-badge" class="px-3 py-1 bg-slate-200 dark:bg-slate-700 rounded-lg text-xs font-bold text-slate-500 whitespace-nowrap">未登录</div>
          <button id="btn-manage-token" onclick="openTokenModal()" class="action-icon-btn" title="Token 管理" style="color: #F59E0B;">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
          </button>
          <button onclick="doLogout()" class="action-icon-btn" title="退出登录">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
          </button>
          <button onclick="toggleTheme()" class="action-icon-btn" id="theme-icon">☀️</button>
        </div>
      </div>

      <div class="flex gap-2 mb-4">
        <select id="script-select" class="flex-1 p-4 rounded-xl text-lg outline-none cursor-pointer appearance-none">
          <option value="">-- 请刷新脚本列表 --</option>
        </select>
        <button onclick="doAction('listScripts')" class="bg-emerald-500 hover:bg-emerald-600 text-white px-8 rounded-xl font-black active:scale-95 transition">刷新列表</button>
      </div>

      <div class="toolbar-container">
        <div class="tool-row">
          <button onclick="doAction('fetch')" class="text-blue-500 font-black hover:underline text-sm uppercase mr-2">验证并拉取代码</button>
          <button onclick="editorSelectAll()" class="mobile-action-btn bg-green-500">全选</button>
          <button onclick="editorCopyAll()" class="mobile-action-btn bg-green-500">复制</button>
          <button onclick="editorPaste()" class="mobile-action-btn bg-green-500">粘贴</button>
        </div>
        <div class="binding-row">
            <div class="flex justify-between items-center mb-2">
               <span class="text-xs font-bold text-slate-500 uppercase">环境变量与资源绑定</span>
               <div onclick="openAddBindingModal()" class="add-binding-btn" title="添加新绑定">+</div>
            </div>
            <div id="binding-container" class="flex flex-col w-full"></div>
        </div>
      </div>

      <div id="monaco-container"></div>

      <button id="p-btn" onclick="openDeployModal()" class="w-full mt-2 bg-blue-600 hover:bg-blue-700 text-white py-5 rounded-2xl font-black text-xl shadow-2xl transition active:scale-95">
        🚀 立即部署 (Deploy)
      </button>

      <div class="footer-signature">
        <a href="https://github.com/Kevin-YST-Du/Cloudflare-Workers" target="_blank" class="footer-link">Powered by Kevin-YST-Du/Cloudflare-Workers</a>
      </div>
    </div>

    <div id="deploy-modal" class="modal-backdrop">
      <div class="bg-white dark:bg-slate-900 w-full max-w-sm rounded-3xl p-8 border border-slate-200 text-center shadow-2xl">
        <div class="text-red-500 mb-4">
          <svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mx-auto"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path></svg>
        </div>
        <h3 class="text-2xl font-black mb-2 text-slate-800 dark:text-slate-100">确认同步部署？</h3>
        <p class="text-slate-500 text-sm mb-6">您当前编辑器中的代码和绑定配置将覆盖云端。</p>
        <div class="flex gap-3">
          <button onclick="closeModal('deploy-modal')" class="flex-1 py-4 rounded-xl font-bold bg-slate-100 dark:bg-slate-800 text-slate-600">取消</button>
          <button onclick="executeDeploy()" class="flex-1 py-4 rounded-xl font-bold bg-red-600 text-white hover:bg-red-700">确认部署</button>
        </div>
      </div>
    </div>

    <div id="remove-binding-modal" class="modal-backdrop">
      <div class="delete-box">
        <div class="text-red-500 mb-4">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mx-auto"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        </div>
        <h3 class="text-xl font-bold mb-2 text-slate-800 dark:text-slate-100">确认移除此项绑定?</h3>
        <p class="text-slate-500 text-sm mb-6">此移除操作将在下次同步部署后正式生效。</p>
        <div class="flex gap-3">
          <button onclick="closeModal('remove-binding-modal')" class="flex-1 py-3 rounded-xl font-bold bg-slate-100 dark:bg-slate-700 text-slate-600">取消</button>
          <button onclick="executeRemoveBinding()" class="flex-1 py-3 rounded-xl font-bold bg-red-600 text-white hover:bg-red-700">确认移除</button>
        </div>
      </div>
    </div>

    <div id="add-binding-modal" class="modal-backdrop">
      <div class="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl p-6 border border-slate-200 shadow-2xl">
        <h3 class="text-xl font-bold mb-4 text-slate-800 dark:text-slate-100">添加资源绑定</h3>
        
        <div class="modal-tabs">
           <div onclick="switchBindTab('resource')" id="tab-bind-resource" class="modal-tab active">Cloudflare 资源</div>
           <div onclick="switchBindTab('variable')" id="tab-bind-variable" class="modal-tab">环境变量 (Vars)</div>
        </div>

        <div class="space-y-4">
          <div id="panel-resource">
             <div>
                <label class="block text-xs font-bold text-slate-500 mb-1">资源类型</label>
                <select id="bind-type" class="w-full p-3 rounded-lg" onchange="updateBindInputs()">
                   <optgroup label="存储 (Storage)">
                      <option value="d1">D1 数据库</option>
                      <option value="kv_namespace">KV 命名空间</option>
                      <option value="r2_bucket">R2 存储桶</option>
                      <option value="images">Images</option>
                      <option value="browser_rendering">浏览器呈现 (Browser)</option>
                   </optgroup>
                   <optgroup label="计算与服务 (Compute)">
                      <option value="service">服务绑定 (Service)</option>
                      <option value="queue">Queue (队列)</option>
                      <option value="durable_object_namespace">耐用对象 (Durable Object)</option>
                      <option value="workflows">工作流 (Workflows)</option>
                      <option value="ai">Workers AI</option>
                   </optgroup>
                   <optgroup label="配置与扩展 (Config)">
                      <option value="vectorize">Vectorize 索引</option>
                      <option value="hyperdrive">Hyperdrive</option>
                      <option value="analytics_engine">Analytics Engine</option>
                      <option value="mtls_certificate">mTLS 证书</option>
                      <option value="ratelimit">速率限制器</option>
                      <option value="secret_store">Secrets Store</option>
                      <option value="version_metadata">版本元数据</option>
                      <option value="dispatch_namespace">分派命名空间</option>
                   </optgroup>
                </select>
             </div>
          </div>

          <div id="panel-variable" class="hidden">
             <div>
                <label class="block text-xs font-bold text-slate-500 mb-1">变量类型</label>
                <select id="var-type" class="w-full p-3 rounded-lg" onchange="updateVarInputs()">
                   <option value="plain_text">文本 (Text)</option>
                   <option value="json">JSON</option>
                   <option value="secret_text">密钥 (Secret)</option>
                </select>
             </div>
          </div>
          
          <div>
            <label class="block text-xs font-bold text-slate-500 mb-1">变量名 (Variable Name)</label>
            <input id="bind-var" type="text" placeholder="例如: DB, API_KEY" class="w-full p-3 rounded-lg font-mono">
          </div>

          <div id="id-input-container">
            <label id="bind-id-label" class="block text-xs font-bold text-slate-500 mb-1">选择资源</label>
            <div id="res-loading" class="text-xs text-blue-500 hidden mb-1">正在获取资源列表...</div>
            <select id="bind-select" class="w-full p-3 rounded-lg hidden font-mono"></select>
            
            <div id="create-res-container" class="hidden">
               <button onclick="openCreateResModal()" class="create-btn">+ 新建资源</button>
            </div>
            
            <input id="bind-id" type="text" placeholder="或手动粘贴 ID..." class="w-full p-3 rounded-lg font-mono mt-2">
          </div>

          <div id="val-input-container" class="hidden">
             <label class="block text-xs font-bold text-slate-500 mb-1">变量值 (Value)</label>
             <textarea id="var-value" rows="3" placeholder="输入值..." class="w-full p-3 rounded-lg font-mono"></textarea>
             <p id="secret-tip" class="text-xs text-orange-500 mt-1 hidden">注意: 添加密钥绑定仅建立引用，具体值需在 Cloudflare 后台设置。</p>
          </div>

        </div>

        <div class="flex gap-3 mt-6">
          <button onclick="closeModal('add-binding-modal')" class="flex-1 py-3 rounded-xl font-bold bg-slate-100 dark:bg-slate-800 text-slate-600">取消</button>
          <button onclick="confirmAddBinding()" class="flex-1 py-3 rounded-xl font-bold bg-blue-600 text-white">添加</button>
        </div>
      </div>
    </div>
    
    <div id="create-res-modal" class="modal-backdrop">
      <div class="delete-box">
        <h3 class="text-xl font-bold mb-4 text-slate-800 dark:text-slate-100">新建 <span id="create-res-type"></span></h3>
        <input id="new-res-name" type="text" placeholder="输入资源名称..." class="w-full p-3 rounded-lg font-mono mb-4 border border-slate-300">
        <div class="flex gap-3">
          <button onclick="closeModal('create-res-modal')" class="flex-1 py-3 rounded-xl font-bold bg-slate-100 dark:bg-slate-700 text-slate-600">取消</button>
          <button onclick="executeCreateResource()" class="flex-1 py-3 rounded-xl font-bold bg-green-600 text-white">创建并选中</button>
        </div>
      </div>
    </div>

    <div id="token-modal" class="modal-backdrop">
      <div class="token-modal">
        <div class="flex justify-between items-center mb-6">
          <h2 class="text-2xl font-black text-blue-600">🔑 Token 管理中心</h2>
          <button onclick="closeModal('token-modal')" class="text-2xl opacity-50 hover:opacity-100">&times;</button>
        </div>
        
        <div class="p-6 rounded-xl bg-slate-100 dark:bg-slate-800 mb-8">
          <h4 class="font-bold mb-4">生成新 Token</h4>
          <div class="flex flex-col md:flex-row gap-3">
            <select id="token-expiry" onchange="toggleCustomExpiry()" class="p-3 rounded-lg flex-1">
              <option value="-1">永不过期</option>
              <option value="1">1 天后过期</option>
              <option value="7">7 天后过期</option>
              <option value="custom">自定义天数...</option>
            </select>
            <input id="custom-days" type="number" min="1" max="365" placeholder="输入天数" class="p-3 rounded-lg flex-1 hidden border border-blue-400">
            <button onclick="generateToken()" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-bold transition">生成</button>
          </div>
        </div>
        
        <h4 class="font-bold mb-4">Token 列表</h4>
        <div id="token-list" class="space-y-3 max-h-[400px] overflow-y-auto">
          <div class="text-center text-slate-400 py-4">加载中...</div>
        </div>
      </div>
    </div>

    <div id="delete-modal" class="modal-backdrop">
      <div class="delete-box">
        <div class="text-red-500 mb-4">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mx-auto"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </div>
        <h3 class="text-xl font-bold mb-2">确认删除此 Token?</h3>
        <div class="flex gap-3 mt-4">
          <button onclick="closeModal('delete-modal')" class="flex-1 py-3 rounded-xl bg-slate-100">取消</button>
          <button onclick="confirmDeleteToken()" class="flex-1 py-3 rounded-xl bg-red-600 text-white hover:bg-red-700">确认删除</button>
        </div>
      </div>
    </div>

    <div id="toast" class="toast"></div>

    <script>
      const $ = id => document.getElementById(id);
      let editor = null;
      let authState = { mode: 'none', data: {} };
      let tokenToDelete = null;
      let currentBindings = [];
      let bindingToRemoveIndex = null;
      let activeBindTab = 'resource';
      // [V7.4] 全局资源名称缓存 Map { 'id': 'name' }
      let resourceMap = {};

      function init() {
         checkUrlAndLogin(); 
         if (typeof require !== 'undefined') {
             require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }});
             require(['vs/editor/editor.main'], () => {
                const savedTheme = localStorage.getItem('theme');
                if(savedTheme === 'dark') { document.body.classList.add('dark'); $('theme-icon').innerText = '🌙'; }
                editor = monaco.editor.create($('monaco-container'), { value: '// 请先登录...', language: 'javascript', automaticLayout: false, minimap: { enabled: false }, fontSize: 14, theme: document.body.classList.contains('dark') ? 'vs-dark' : 'vs' });
                new ResizeObserver(() => editor.layout()).observe($('monaco-container'));
                window.addEventListener('resize', () => editor.layout());
             });
         } else {
             $('monaco-container').innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:red;">⚠️ 编辑器资源加载失败 (请检查网络/CDN)</div>';
         }
      }
      window.onload = init;

      function checkUrlAndLogin() {
         const urlParams = new URLSearchParams(window.location.search);
         const magicToken = urlParams.get('token');
         const path = window.location.pathname;
         
         if (path.startsWith('/tk_') || magicToken) {
             switchTab('token'); 
             const tokenVal = magicToken || path.substring(1);
             $('login-ck').value = tokenVal; 
             
             const btn = $('login-btn');
             btn.innerText = "验证中...";
             btn.disabled = true;
             
             showToast("检测到 Token，正在登录...", false); 
             setTimeout(doLogin, 500);
         } else {
             checkLogin();
         }
      }

      function checkLogin() { 
          const sess = localStorage.getItem('wpe_session'); 
          if(sess) { 
              authState = JSON.parse(sess); 
              showInterface(); 
          } else { 
              $('login-gateway').classList.remove('hidden'); 
          } 
      }

      function switchTab(tab) {
         if(tab === 'admin') {
            $('tab-admin').classList.add('active'); $('tab-token').classList.remove('active');
            $('form-admin').classList.remove('hidden'); $('form-token').classList.add('hidden');
         } else {
            $('tab-token').classList.add('active'); $('tab-admin').classList.remove('active');
            $('form-token').classList.remove('hidden'); $('form-admin').classList.add('hidden');
         }
         showLoginError("");
      }

      function switchBindTab(tab) {
         activeBindTab = tab;
         if(tab === 'resource') {
            $('tab-bind-resource').classList.add('active'); $('tab-bind-variable').classList.remove('active');
            $('panel-resource').classList.remove('hidden'); $('panel-variable').classList.add('hidden');
            $('id-input-container').classList.remove('hidden'); $('val-input-container').classList.add('hidden');
            updateBindInputs();
         } else {
            $('tab-bind-variable').classList.add('active'); $('tab-bind-resource').classList.remove('active');
            $('panel-variable').classList.remove('hidden'); $('panel-resource').classList.add('hidden');
            $('id-input-container').classList.add('hidden'); $('val-input-container').classList.remove('hidden');
            updateVarInputs();
         }
      }

      function updateVarInputs() {
         const type = $('var-type').value;
         if(type === 'secret_text') {
             $('var-value').classList.add('hidden');
             $('secret-tip').classList.remove('hidden');
         } else {
             $('var-value').classList.remove('hidden');
             $('secret-tip').classList.add('hidden');
         }
      }

      async function apiCall(data) {
         const fd = new FormData(); for(let k in data) fd.append(k, data[k]);
         if(data.action !== 'verifyLogin' && authState.mode !== 'none') {
             if(authState.mode === 'token') fd.append('loginToken', authState.data.loginToken);
             else { fd.append('accountId', authState.data.accountId); fd.append('apiToken', authState.data.apiToken); }
         }
         const response = await fetch(location.href, { method: 'POST', body: fd });
         return await response.json();
      }

      // [V7.4] 核心逻辑：自动反查资源名称
      async function autoResolveResourceNames() {
          if (!currentBindings || currentBindings.length === 0) return;
          
          const typesToFetch = new Set();
          currentBindings.forEach(b => {
              if (b.type === 'd1' || b.type === 'kv_namespace' || b.type === 'r2_bucket' || b.type === 'service' || b.type === 'queue') {
                  // 如果缓存里没有这个ID对应的名字，就加入待查询队列
                  const id = b.id || b.namespace_id || b.bucket_name || b.service || b.queue_name;
                  if (id && !resourceMap[id]) {
                      typesToFetch.add(b.type);
                  }
              }
          });

          // 并行获取缺失的资源列表
          const promises = Array.from(typesToFetch).map(type => 
              apiCall({ action: 'listResources', type: type }).then(res => {
                  if (res.success && res.result) {
                      res.result.forEach(r => {
                          const name = r.title || r.name || r.queue_name || r.script_name;
                          const val = r.uuid || r.id || r.queue_name || r.script_name || r.name;
                          if (val && name) resourceMap[val] = name;
                      });
                  }
              })
          );

          if (promises.length > 0) {
              await Promise.all(promises);
              renderBindings(); // 重新渲染以显示名称
          }
      }

      async function updateBindInputs() {
         const type = $('bind-type').value;
         const select = $('bind-select'); const loading = $('res-loading'); 
         const idContainer = $('id-input-container'); const idInput = $('bind-id');
         const createBtn = $('create-res-container');

         const noIdTypes = ['ai', 'browser_rendering', 'version_metadata', 'ratelimit'];
         if (noIdTypes.includes(type)) { 
            idContainer.classList.add('hidden'); idInput.value = "enabled"; return; 
         } else { 
            idContainer.classList.remove('hidden'); idInput.value = ""; 
         }
         
         select.classList.add('hidden'); loading.classList.remove('hidden'); select.innerHTML = '';
         if(createBtn) createBtn.classList.add('hidden');

         const fetchableTypes = ['kv_namespace', 'd1', 'r2_bucket', 'service', 'queue', 'durable_object_namespace', 'vectorize', 'hyperdrive', 'dispatch_namespace'];
         if (!fetchableTypes.includes(type)) { loading.classList.add('hidden'); idInput.placeholder = "手动输入资源 ID 或配置..."; return; }

         // [V7.0] 显示创建按钮 (仅支持 KV 和 D1)
         if (type === 'kv_namespace' || type === 'd1') {
             if(createBtn) createBtn.classList.remove('hidden');
         }

         try {
             const res = await apiCall({ action: 'listResources', type: type });
             if (res.success && res.result && res.result.length > 0) {
                 select.classList.remove('hidden');
                 select.innerHTML = res.result.map(r => {
                     const name = r.title || r.name || r.queue_name || r.script_name || r.id; 
                     const val = r.uuid || r.id || r.queue_name || r.script_name || r.name;
                     // [V7.4] 顺便缓存一下
                     if(val && name) resourceMap[val] = name;
                     return \`<option value="\${val}">\${name} (\${val ? val.substring(0,8) : ''}...)</option>\`;
                 }).join('');
                 if(select.options.length > 0) $('bind-id').value = select.options[0].value;
                 select.onchange = () => { $('bind-id').value = select.value; };
             } else { select.innerHTML = '<option value="">未找到资源 (请手动输入或创建)</option>'; select.classList.remove('hidden'); }
         } catch(e) {} finally { loading.classList.add('hidden'); }
      }
      
      // [V7.0] 打开创建弹窗
      function openCreateResModal() {
         const type = $('bind-type').value;
         const typeName = type === 'kv_namespace' ? 'KV 命名空间' : 'D1 数据库';
         $('create-res-type').innerText = typeName;
         $('new-res-name').value = '';
         $('create-res-modal').classList.add('active');
      }

      // [V7.0] 执行创建逻辑
      async function executeCreateResource() {
         const type = $('bind-type').value;
         const name = $('new-res-name').value.trim();
         if (!name) return showToast("名称不能为空", true);

         const btn = event.target;
         const originalText = btn.innerText;
         btn.innerText = "创建中...";
         btn.disabled = true;

         try {
             const res = await apiCall({ action: 'createResource', type: type, name: name });
             if (res.success) {
                 showToast("创建成功!");
                 closeModal('create-res-modal');
                 // 自动刷新列表并尝试选中
                 await updateBindInputs();
                 setTimeout(() => {
                     const select = $('bind-select');
                     for (let i = 0; i < select.options.length; i++) {
                         if (select.options[i].text.includes(name)) {
                             select.selectedIndex = i;
                             $('bind-id').value = select.value;
                             break;
                         }
                     }
                 }, 500);
             } else {
                 showToast("创建失败: " + (res.errors?.[0]?.message || "未知错误"), true);
             }
         } catch (e) {
             showToast("请求失败", true);
         } finally {
             btn.innerText = originalText;
             btn.disabled = false;
         }
      }

      async function doAction(action, extra = {}) {
        const scriptName = $('script-select').value;
        if ((action === 'fetch' || action === 'deploy') && !scriptName) return showToast("请选择脚本", true);
        const res = await apiCall({ action, scriptName, ...extra });
        if(res.success || res.result) {
            if(action === 'listScripts') { $('script-select').innerHTML = res.result.map(s => \`<option value="\${s.id}">\${s.id}</option>\`).join(''); showToast("已更新"); }
            else if(action === 'fetch') { 
                if(editor) { editor.getModel().setValue(res.code); }
                currentBindings = res.bindings || []; 
                renderBindings(); 
                showToast("拉取成功"); 
                // [V7.4] 拉取成功后，自动反查资源名称
                autoResolveResourceNames();
            }
            else if(action === 'deploy') showToast("🎉 部署成功");
        } else showToast(res.errors?.[0]?.message || "失败", true);
        return res;
      }

      function getFriendlyType(type) {
         if (type === 'd1') return 'D1数据库';
         if (type === 'kv_namespace') return 'KV空间';
         if (type === 'r2_bucket') return 'R2存储';
         if (type === 'service') return 'Service';
         if (type === 'queue') return 'Queue 队列';
         if (type === 'plain_text') return 'Plain Text';
         if (type === 'secret_text') return 'Secret Key';
         if (type === 'json') return 'JSON';
         return type;
      }

      // [V7.4 重构] 渲染绑定列表：优先显示缓存中的友好名称
      function renderBindings() {
         const container = $('binding-container');
         if (!currentBindings || currentBindings.length === 0) { 
            container.innerHTML = '<div class="text-center text-slate-400 italic py-4">暂无绑定，点击右上方 + 添加</div>'; 
            return; 
         }
         
         container.innerHTML = currentBindings.map((b, index) => {
             const type = b.type;
             let val = '';
             let cardClass = 'type-resource'; // 默认资源蓝
             
             // 1. 提取 Value / Resource ID
             if (type === 'plain_text' || type === 'json') {
                 val = b.text;
                 cardClass = 'type-var'; // 变量紫
             } else if (type === 'secret_text') {
                 val = '(受保护的密钥)';
                 cardClass = 'type-secret'; // 密钥橙
             } else if (type === 'kv_namespace') {
                 val = b.namespace_id;
             } else if (type === 'd1') {
                 val = b.id;
             } else if (type === 'r2_bucket') {
                 val = b.bucket_name;
             } else if (type === 'service') {
                 val = b.service;
             } else if (type === 'queue') {
                 val = b.queue_name;
             } else {
                 val = b.id || b.namespace_id || b.bucket_name || b.name || 'enabled';
             }

             // [V7.4] 尝试从全局缓存中获取友好名称
             const friendlyName = resourceMap[val];
             const displayVal = friendlyName ? friendlyName : val;
             const showId = friendlyName && (val !== friendlyName); // 如果有友好名称且不等于ID，则显示ID辅助

             return \`
               <div class="binding-card \${cardClass}">
                  <div class="card-del-btn" onclick="confirmRemoveBinding(\${index})" title="移除">&times;</div>
                  <div class="binding-header">
                     <span class="binding-name">\${b.name || b.binding}</span>
                     <span class="binding-type-badge">\${getFriendlyType(type)}</span>
                  </div>
                  <div class="binding-details">
                     <div class="detail-row">
                        <span class="detail-label">\${friendlyName ? '资源名:' : '资源/值:'}</span>
                        <span class="text-slate-600 dark:text-slate-300 font-mono font-bold">\${displayVal}</span>
                     </div>
                     \${showId ? \`<div class="text-xs text-slate-400 mt-1 break-all">(ID: \${val})</div>\` : ''}
                  </div>
               </div>
             \`;
         }).join('');
      }

      function confirmRemoveBinding(index) { bindingToRemoveIndex = index; $('remove-binding-modal').classList.add('active'); }
      function executeRemoveBinding() { if(bindingToRemoveIndex !== null) currentBindings.splice(bindingToRemoveIndex, 1); renderBindings(); closeModal('remove-binding-modal'); }
      function openDeployModal() { if(!$('script-select').value) return showToast("请先选择脚本", true); $('deploy-modal').classList.add('active'); }
      
      // [V7.3] 部署时清洗数据: 移除 _resourceName 字段 (虽然 V7.4 主要靠 resourceMap，但保留清洗逻辑是好习惯)
      async function executeDeploy() { 
          closeModal('deploy-modal'); 
          const btn = $('p-btn'); 
          btn.disabled = true; 
          btn.innerText = "⌛ 正在部署..."; 
          
          // 清洗数据，防止将 UI 辅助字段发送给 Cloudflare
          const cleanBindings = currentBindings.map(b => {
             const { _resourceName, ...rest } = b;
             return rest;
          });

          await doAction('deploy', { code: editor ? editor.getValue() : '', bindings: JSON.stringify(cleanBindings) }); 
          btn.disabled = false; 
          btn.innerText = "🚀 立即部署 (Deploy)"; 
      }
      
      function confirmAddBinding() {
         let newBind = {};
         const name = $('bind-var').value.trim();
         
         if (activeBindTab === 'resource') {
             const type = $('bind-type').value; 
             const idVal = $('bind-id').value.trim();
             const noIdTypes = ['ai', 'browser_rendering', 'version_metadata', 'ratelimit'];
             
             if(!name || (!idVal && !noIdTypes.includes(type))) return showToast("信息不全", true);
             
             newBind = { type: type, name: name };
             if(type === 'd1') { newBind.id = idVal; newBind.binding = name; }
             else if(type === 'kv_namespace') newBind.namespace_id = idVal;
             else if(type === 'r2_bucket') newBind.bucket_name = idVal;
             else if(type === 'service') newBind.service = idVal;
             else if(type === 'queue') newBind.queue_name = idVal;
             else if(type === 'durable_object_namespace') newBind.namespace_id = idVal;
             else if(type === 'vectorize') newBind.index_name = idVal;
             else if(type === 'hyperdrive') newBind.id = idVal;
             else if(type === 'dispatch_namespace') newBind.namespace = idVal;
             else if(type === 'ai') newBind.binding = name; 
             else if(type === 'version_metadata') newBind.binding = name;
             else if(type === 'browser_rendering') newBind.binding = name;

             // [V7.4] 尝试捕获并缓存资源名称
             const select = $('bind-select');
             if (!select.classList.contains('hidden') && select.value === idVal) {
                 const selectedText = select.options[select.selectedIndex].text;
                 // 格式通常是 "Name (ID_PREFIX...)"
                 const rName = selectedText.split(' (')[0];
                 resourceMap[idVal] = rName; // 存入全局缓存
             }

         } else {
             const type = $('var-type').value;
             const val = $('var-value').value;
             if(!name) return showToast("变量名不能为空", true);
             if(type !== 'secret_text' && !val) return showToast("变量值不能为空", true);
             newBind = { type: type, name: name };
             if(type === 'plain_text' || type === 'json') newBind.text = val; 
             else if(type === 'secret_text') newBind.text = name; 
         }
         currentBindings.push(newBind); renderBindings(); closeModal('add-binding-modal');
      }

      function closeModal(id) { $(id).classList.remove('active'); }
      function openAddBindingModal() { $('add-binding-modal').classList.add('active'); if(activeBindTab==='resource') updateBindInputs(); }
      function showToast(m, isE = false) { const t = $('toast'); t.innerText = m; t.className = 'toast '+(isE?'bg-red-500':'bg-emerald-600')+' show'; setTimeout(()=>t.classList.remove('show'), 3000); }
      
      function showLoginError(msg) {
          const el = $('login-msg');
          if (msg) {
              el.innerText = msg;
              el.style.display = 'block';
              $('login-box-inner').classList.add('animate-shake');
              setTimeout(() => $('login-box-inner').classList.remove('animate-shake'), 400);
          } else {
              el.style.display = 'none';
          }
      }

      async function doLogin() {
          const isTokenMode = $('tab-token').classList.contains('active');
          const btn = $('login-btn');
          const originalText = "进入系统";
          
          showLoginError(""); 
          btn.innerText = "验证中...";
          btn.disabled = true;

          let payload = { action: 'verifyLogin' };
          
          if(isTokenMode) {
              payload.loginToken = $('login-ck').value.trim();
              if(!payload.loginToken) {
                  btn.innerText = originalText; btn.disabled = false;
                  return showLoginError("请输入 Token"); 
              }
          } else { 
              payload.accountId = $('login-aid').value.trim(); 
              payload.apiToken = $('login-key').value.trim(); 
              if(!payload.accountId || !payload.apiToken) {
                  btn.innerText = originalText; btn.disabled = false;
                  return showLoginError("请输入完整凭证"); 
              }
          }
          
          try {
              const res = await apiCall(payload);
              if(res.success) { 
                  authState = { mode: isTokenMode ? 'token' : 'root', data: payload }; 
                  localStorage.setItem('wpe_session', JSON.stringify(authState)); 
                  showInterface(); 
              } else {
                  showLoginError(res.errors && res.errors[0] ? res.errors[0].message : "验证失败，请检查凭证");
                  btn.innerText = originalText; btn.disabled = false;
              }
          } catch(e) {
              showLoginError("网络连接失败，请检查网络");
              btn.innerText = originalText; btn.disabled = false;
          }
      }

      function showInterface() { 
          const gateway = $('login-gateway');
          const main = $('main-interface');
          const badge = $('user-badge');

          if(authState.mode === 'root') {
              badge.innerHTML = "Root 管理员";
              badge.className = "px-3 py-1 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold";
          } else if (authState.mode === 'token') {
              badge.innerHTML = "Token 管理员";
              badge.className = "px-3 py-1 bg-green-100 text-green-700 rounded-lg text-xs font-bold border border-green-200";
          }

          gateway.classList.add('animate-fade-out');
          setTimeout(() => {
              gateway.classList.add('hidden');
              main.classList.add('animate-fade-in'); 
          }, 450); 
      }

      // 退出登录：清除本地 session 并刷新页面
      function doLogout() {
        localStorage.removeItem('wpe_session');
        location.reload();
      }

      // 切换暗色 / 亮色主题，并同步 Monaco 编辑器主题
      function toggleTheme() {
        const isDark = document.body.classList.toggle('dark');

        if (editor) {
          monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
        }

        localStorage.setItem('theme', isDark ? 'dark' : 'light');
      }

      // 编辑器全选
      function editorSelectAll() {
        if (editor) {
          editor.focus();
          editor.setSelection(editor.getModel().getFullModelRange());
        }
      }

      // 复制编辑器全部内容
      function editorCopyAll() {
        if (editor) {
          navigator.clipboard
            .writeText(editor.getValue())
            .then(() => showToast("已复制"));
        }
      }

      // 从剪贴板读取并粘贴到编辑器当前选区
      async function editorPaste() {
        if (editor) {
          try {
            const t = await navigator.clipboard.readText();
            if (t) {
              editor.executeEdits('p', [
                {
                  range: editor.getSelection(),
                  text: t
                }
              ]);
            }
          } catch (e) {
            // 可能是权限/浏览器不支持读剪贴板
          }
        }
      }

      // 复制指定文本
      function copyText(t) {
        navigator.clipboard
          .writeText(t)
          .then(() => showToast("已复制"));
      }

      // 打开 Token 弹窗并拉取列表
      function openTokenModal() {
        $('token-modal').classList.add('active');
        fetchTokens();
      }

      // 请求 Token 列表
      async function fetchTokens() {
        try {
          const res = await apiCall({ action: 'listTokens' });
          if (res.success) {
            renderTokenList(res.result);
          }
        } catch (e) {
          // 请求失败忽略
        }
      }

      // 渲染 Token 列表到页面
      function renderTokenList(tokens) {
        const container = $('token-list');
        container.replaceChildren();

        if (!tokens || tokens.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'text-center text-slate-400';
          empty.textContent = '无 Token';
          container.append(empty);
          return;
        }

        function formatTime(ts) {
          const d = new Date(ts);
          return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
        }

        function svgTrashIcon() {
          const svgNS = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(svgNS, 'svg');
          svg.setAttribute('width', '20');
          svg.setAttribute('height', '20');
          svg.setAttribute('viewBox', '0 0 24 24');
          svg.setAttribute('fill', 'none');
          svg.setAttribute('stroke', 'currentColor');
          svg.setAttribute('stroke-width', '2');
          svg.setAttribute('stroke-linecap', 'round');
          svg.setAttribute('stroke-linejoin', 'round');

          const polyline = document.createElementNS(svgNS, 'polyline');
          polyline.setAttribute('points', '3 6 5 6 21 6');

          const path = document.createElementNS(svgNS, 'path');
          path.setAttribute('d', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');

          svg.append(polyline, path);
          return svg;
        }

        tokens.forEach(function (t) {
          const card = document.createElement('div');
          card.className = 'token-card';

          const info = document.createElement('div');
          info.className = 'token-info';

          const val = document.createElement('div');
          val.className = 'token-val';
          val.textContent = t.token;
          val.onclick = function () {
            copyText(t.token);
          };

          const meta = document.createElement('div');
          meta.className = 'token-meta';

          const createdLabel = document.createElement('span');
          createdLabel.textContent = '创建: ';

          const createdVal = document.createElement('span');
          createdVal.textContent = formatTime(t.created);

          const sep = document.createElement('span');
          sep.textContent = ' | ';

          const expiryLabel = document.createElement('span');
          expiryLabel.textContent = '过期: ';

          const expiryVal = document.createElement('span');
          expiryVal.textContent = t.expiry === -1 ? '永久' : formatTime(t.expiry);

          meta.append(createdLabel, createdVal, sep, expiryLabel, expiryVal);

          info.append(val, meta);

          const del = document.createElement('div');
          del.className = 'token-del-btn';
          del.title = '删除';
          del.onclick = function () {
            openDeleteModal(t.id);
          };

          del.append(svgTrashIcon());

          card.append(info, del);
          container.append(card);
        });
      }

      // 切换自定义过期天数输入框显示/隐藏
      function toggleCustomExpiry() {
        const val = $('token-expiry').value;
        if (val === 'custom') {
          $('custom-days').classList.remove('hidden');
        } else {
          $('custom-days').classList.add('hidden');
        }
      }

      // 生成 Token
      async function generateToken() {
        let expiry = $('token-expiry').value;

        if (expiry === 'custom') {
          expiry = $('custom-days').value;
        }

        const res = await apiCall({
          action: 'createToken',
          expiryDays: expiry
        });

        if (res.success) {
          showToast("生成成功");
          fetchTokens();
        }
      }

      // 打开删除确认弹窗
      function openDeleteModal(id) {
        tokenToDelete = id;
        $('delete-modal').classList.add('active');
      }

      // 确认删除 Token
      async function confirmDeleteToken() {
        if (tokenToDelete) {
          await apiCall({
            action: 'deleteToken',
            tokenId: tokenToDelete
          });
          closeModal('delete-modal');
          fetchTokens();
        }
      }

    </script>
  </body>
  </html>
  `;
}
