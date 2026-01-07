// ==========================================
// 1. 初始化与配置读取
// ==========================================
require('dotenv').config(); // 读取 .env 文件

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

// 数据存储目录
const DATA_DIR = path.join(process.cwd(), 'data');
const KV_FILE = path.join(DATA_DIR, 'tokens.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ==========================================
// 2. 环境适配层 (模拟 Cloudflare KV & Crypto)
// ==========================================
const KV_STORAGE = {
  async get(key, type = {}) {
    try {
      if (!fs.existsSync(KV_FILE)) return null;
      const data = JSON.parse(fs.readFileSync(KV_FILE, 'utf8'));
      return data[key] || null;
    } catch (e) { return null; }
  },
  async put(key, value) {
    let data = {};
    try {
      if (fs.existsSync(KV_FILE)) data = JSON.parse(fs.readFileSync(KV_FILE, 'utf8'));
    } catch (e) {}
    // value 传入时是字符串，我们解析后再存，方便本地查看，或者直接存字符串也可以
    // 这里为了保持兼容性，模拟 KV 的行为，存入大对象中
    try {
        data[key] = JSON.parse(value); 
    } catch(e) {
        data[key] = value;
    }
    fs.writeFileSync(KV_FILE, JSON.stringify(data, null, 2));
  }
};

// ==========================================
// 3. 核心业务逻辑 (WorkerS Pro Editor V4.7)
// ==========================================
const workerLogic = {
  async fetch(request, env) {
    const jsonRes = (obj) => new Response(JSON.stringify(obj), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });

    // --- Token 生成辅助函数 ---
    const generateComplexToken = async () => {
      const array = new Uint8Array(64);
      crypto.getRandomValues(array);
      const randomPart = Array.from(array, dec => dec.toString(16).padStart(2, "0")).join('');
      const uuid = crypto.randomUUID().replace(/-/g, '');
      return `tk_${uuid.substring(0, 8)}${randomPart}${uuid.substring(24)}`;
    };

    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const action = formData.get("action");
        
        // --- 核心认证中间件 ---
        let accountId = formData.get("accountId");
        let apiToken = formData.get("apiToken");
        const loginToken = formData.get("loginToken");
        let isRootAdmin = false;
        let isTokenUser = false;

        if (loginToken) {
          if (!env.KV_STORAGE) return jsonRes({ success: false, errors: [{ message: "未绑定 KV_STORAGE" }] });
          
          const STORAGE_KEY = 'user_tokens_list';
          const tokens = await env.KV_STORAGE.get(STORAGE_KEY, { type: 'json' }) || [];
          const matchedToken = tokens.find(t => t.token === loginToken);

          if (!matchedToken) return jsonRes({ success: false, errors: [{ message: "无效的 Token" }] });
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
          if (!hasAuth) return jsonRes({ success: false, errors: [{ message: "权限不足" }] });
          if (!env.KV_STORAGE) return jsonRes({ success: false, errors: [{ message: "未绑定 KV_STORAGE" }] });

          const STORAGE_KEY = 'user_tokens_list';
          let tokens = await env.KV_STORAGE.get(STORAGE_KEY, { type: 'json' }) || [];

          if (action === 'listTokens') {
            const now = Date.now();
            
            // [V4.7 关键逻辑] 排序：时间正序 (旧->新)
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
            if (expiryInput > 0) expiry = created + (expiryInput * 24 * 60 * 60 * 1000);

            const newToken = {
              id: crypto.randomUUID(),
              token: await generateComplexToken(),
              created: created,
              expiry: expiry,
              boundAccountId: accountId,
              boundApiToken: apiToken
            };

            // 插入新 Token (push 到末尾，配合正序)
            tokens.push(newToken);
            await env.KV_STORAGE.put(STORAGE_KEY, JSON.stringify(tokens));
            return jsonRes({ success: true, result: newToken });
          }

          if (action === 'deleteToken') {
            const tokenId = formData.get('tokenId');
            tokens = tokens.filter(t => t.id !== tokenId);
            await env.KV_STORAGE.put(STORAGE_KEY, JSON.stringify(tokens));
            return jsonRes({ success: true });
          }
        }
        
        // --- 编辑器核心业务 ---
        if (!accountId || !apiToken) {
           if (action === 'verifyLogin') return jsonRes({ success: false, errors: [{ message: "凭证无效" }] });
           return jsonRes({ success: false, errors: [{ message: "缺少认证信息" }] });
        }

        const authHeader = { 'Authorization': `Bearer ${apiToken}` };
        const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`;

        const safeFetch = async (url, options = {}) => {
          try {
            const res = await fetch(url, options);
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); } catch (e) {
              data = { success: false, errors: [{ message: text || "API 非 JSON 响应" }] };
            }
            return { ok: res.ok, status: res.status, data };
          } catch (err) {
            return { ok: false, data: { success: false, errors: [{ message: err.message }] } };
          }
        };

        if (action === 'verifyLogin') {
            const res = await safeFetch(`${baseUrl}?per_page=1`, { headers: authHeader });
            if (res.ok) return jsonRes({ success: true, role: isRootAdmin ? 'root' : 'token' });
            else return jsonRes({ success: false, errors: res.data.errors });
        }

        if (action === "listScripts") {
          const res = await safeFetch(baseUrl, { headers: authHeader });
          return jsonRes(res.data);
        }

        if (action === "fetch") {
          const scriptName = formData.get("scriptName");
          if (!scriptName) return jsonRes({ success: false, errors: [{ message: "脚本名称为空" }] });

          const contentRes = await fetch(`${baseUrl}/${scriptName}`, { headers: authHeader });
          let code = "";
          const ct = contentRes.headers.get("content-type") || "";
          if (ct.includes("multipart")) {
            const multi = await contentRes.formData();
            let entry = multi.get("worker.js") || multi.get("index.js");
            code = (typeof entry === 'string') ? entry : await entry.text();
          } else {
            code = await contentRes.text();
          }

          const settingsRes = await safeFetch(`${baseUrl}/${scriptName}/settings`, {
            headers: { ...authHeader, 'Content-Type': 'application/json' }
          });
          let bindings = settingsRes.ok && settingsRes.data.result ? settingsRes.data.result.bindings || [] : [];
          return jsonRes({ success: true, code, bindings });
        }

        if (action === "deploy") {
          const scriptName = formData.get("scriptName");
          const code = formData.get("code");
          const settingsRes = await safeFetch(`${baseUrl}/${scriptName}/settings`, {
             headers: { ...authHeader, 'Content-Type': 'application/json' }
          });
          let bindings = settingsRes.ok && settingsRes.data.result ? settingsRes.data.result.bindings || [] : [];

          const cfFormData = new FormData();
          cfFormData.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');
          cfFormData.append('metadata', JSON.stringify({
            main_module: 'worker.js', compatibility_date: '2024-01-01', bindings: bindings 
          }));

          const deployRes = await safeFetch(`${baseUrl}/${scriptName}`, {
            method: 'PUT', headers: authHeader, body: cfFormData 
          });
          return jsonRes(deployRes.data);
        }

      } catch (err) {
        return jsonRes({ success: false, errors: [{ message: `系统错误: ${err.message}` }] });
      }
    }

    return new Response(this.renderUI(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  },

  renderUI() {
    return `
 <!DOCTYPE html>
 <html lang="zh-CN">
 <head>
   <meta charset="UTF-8">
   <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
   <title>Workers Pro Editor</title>
   <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M13%202L3%2014H12L11%2022L21%2010H12L13%202Z%22%20stroke%3D%22%23F59E0B%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E">
   <script src="https://cdn.tailwindcss.com"></script>
   <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
   <style>
     :root { --bg: #f1f5f9; --card: #ffffff; --text: #1e293b; --border: #e2e8f0; --input-bg: #f8fafc; --input-text: #1e293b; --btn-bg: #e2e8f0; }
     .dark { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --border: #334155; --input-bg: #0f172a; --input-text: #f8fafc; --btn-bg: #334155; }
     body { background-color: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; padding: 2rem 1rem; margin: 0; min-height: 100vh; display: flex; justify-content: center; transition: 0.3s; }
     
     .custom-content-wrapper { position: relative; width: 75% !important; max-width: 1200px; padding: 2rem; border-radius: 1.5rem; background: var(--card); border: 1px solid var(--border); box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.15); display: flex; flex-direction: column; }
     @media (max-width: 768px) { .custom-content-wrapper { width: 100% !important; padding: 1.25rem; } }
     
     .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem; }
     .header-title { font-size: 1.875rem; font-weight: 900; color: #2563eb; letter-spacing: -0.05em; text-transform: uppercase; }
     .header-actions { display: flex; align-items: center; gap: 0.75rem; }

     .action-icon-btn { width: 2.5rem; height: 2.5rem; display: flex; align-items: center; justify-content: center; border-radius: 0.75rem; background: var(--btn-bg); border: 1px solid var(--border); cursor: pointer; transition: all 0.2s; color: var(--text); }
     .action-icon-btn:hover { opacity: 0.8; transform: translateY(-1px); }
     
     input, select { background-color: var(--input-bg) !important; color: var(--input-text) !important; border: 1px solid var(--border) !important; }
     #monaco-container { height: 50vh; border-radius: 0.75rem; border: 2px solid var(--border); overflow: hidden; margin: 1rem 0; }
     
     .toast { position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%); padding: 0.8rem 2rem; border-radius: 1rem; color: white; opacity: 0; transition: 0.3s; z-index: 2000; }
     .toast.show { opacity: 1; }
     
     .mobile-action-btn { font-size: 0.75rem; padding: 0.25rem 0.75rem; border-radius: 0.5rem; margin-left: 0.5rem; color: white; font-weight: bold; transition: opacity 0.2s; }
     .mobile-action-btn:active { transform: scale(0.95); }

     .footer-signature { margin-top: 1.5rem; padding-top: 1.2rem; border-top: 1px solid var(--border); text-align: center; }
     .footer-link { color: #2563eb; font-weight: 700; font-size: 0.9rem; text-decoration: none; }
     .footer-link:hover { text-decoration: underline; }

     .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000; display: none; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
     .modal-backdrop.active { display: flex; }
     
     /* Token Modal */
     .token-modal { background: var(--card); width: 90%; max-width: 800px; max-height: 90vh; border-radius: 1.5rem; padding: 2rem; overflow-y: auto; border: 1px solid var(--border); }
     
     .login-box { background: var(--card); width: 100%; max-width: 420px; padding: 2.5rem; border-radius: 2rem; border: 1px solid var(--border); box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); text-align: center; }
     .tab-btn { padding: 0.75rem; flex: 1; border-bottom: 2px solid transparent; color: #94a3b8; font-weight: 600; cursor: pointer; transition: 0.2s; }
     .tab-btn.active { color: #2563eb; border-color: #2563eb; }
     
     .delete-box { background: var(--card); width: 100%; max-width: 360px; padding: 2rem; border-radius: 1.5rem; border: 1px solid var(--border); text-align: center; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1); }

     .token-card { background: var(--input-bg); border: 1px solid var(--border); border-radius: 1rem; padding: 1rem; margin-bottom: 1rem; position: relative; }
     .token-val { font-family: monospace; word-break: break-all; font-weight: bold; color: #0ea5e9; }
     .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; font-weight: 700; }
     .badge-green { background: #dcfce7; color: #166534; }
     .badge-red { background: #fee2e2; color: #991b1b; }
     .dark .badge-green { background: #064e3b; color: #a7f3d0; }
     .dark .badge-red { background: #7f1d1d; color: #fecaca; }
     .delete-btn { position: absolute; top: 1rem; right: 1rem; color: #ef4444; cursor: pointer; padding: 4px; border-radius: 6px; transition: 0.2s; }
     .delete-btn:hover { background: #fee2e2; }
     .dark .delete-btn:hover { background: #450a0a; }

   </style>
 </head>
 <body class="light">
  
   <div id="login-gateway" class="fixed inset-0 bg-slate-100 dark:bg-slate-900 z-[5000] flex items-center justify-center p-4">
       <div class="login-box">
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
         
         <button onclick="doLogin()" id="login-btn" class="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-xl font-bold text-lg shadow-lg active:scale-95 transition">
             进入系统
         </button>
       </div>
   </div>

   <div class="custom-content-wrapper blur-sm transition duration-500" id="main-interface">
     
     <div class="header-row">
         <h1 class="header-title">WORKERS PRO IDE</h1>
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

     <div class="flex justify-between items-center mb-2">
       <div>
           <button onclick="doAction('fetch')" class="text-blue-500 font-black hover:underline text-sm uppercase">验证并拉取代码</button>
           <button onclick="editorSelectAll()" class="mobile-action-btn bg-green-500">全选</button>
           <button onclick="editorCopyAll()" class="mobile-action-btn bg-green-500">复制</button>
           <button onclick="editorPaste()" class="mobile-action-btn bg-green-500">粘贴</button>
       </div>
       <div id="binding-container"></div>
     </div>

     <div id="monaco-container"></div>

     <button id="p-btn" onclick="openDeployModal()" class="w-full mt-6 bg-blue-600 hover:bg-blue-700 text-white py-5 rounded-2xl font-black text-xl shadow-2xl transition active:scale-95">
       🚀 同步部署
     </button>

     <div class="footer-signature">
       <a href="https://github.com/Kevin-YST-Du/Cloudflare-Workers" target="_blank" class="footer-link">Powered by Kevin-YST-Du/Cloudflare-Workers</a>
     </div>
   </div>

   <div id="deploy-modal" class="fixed inset-0 bg-black/60 hidden z-[1000] flex items-center justify-center p-6 backdrop-blur-sm">
     <div class="bg-white dark:bg-slate-900 w-full max-w-sm rounded-3xl p-8 border border-slate-200 text-center shadow-2xl">
       <h3 class="text-2xl font-black mb-2 text-slate-800 dark:text-slate-100">确认同步部署？</h3>
       <p class="text-slate-500 text-sm mb-6">部署将合并现有配置。</p>
       <div class="flex gap-3">
         <button onclick="closeModal('deploy-modal')" class="flex-1 py-4 rounded-xl font-bold bg-slate-100 dark:bg-slate-800 text-slate-600">取消</button>
         <button onclick="executeDeploy()" class="flex-1 py-4 rounded-xl font-bold bg-red-600 text-white">确认部署</button>
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
           <h4 class="font-bold mb-4">生成新 Token (继承当前凭证)</h4>
           
           <div class="flex flex-col md:flex-row gap-3">
             <select id="token-expiry" onchange="toggleCustomExpiry()" class="p-3 rounded-lg flex-1">
               <option value="-1">永不过期</option>
               <option value="1">1 天后过期</option>
               <option value="7">7 天后过期</option>
               <option value="30">30 天后过期</option>
               <option value="custom">自定义天数...</option>
             </select>
             <input id="custom-days" type="number" min="1" max="365" placeholder="输入天数 (max 365)" class="p-3 rounded-lg flex-1 hidden border border-blue-400">
             
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
       <h3 class="text-xl font-bold mb-2 text-slate-800 dark:text-slate-100">删除 Token?</h3>
       <p class="text-slate-500 text-sm mb-6">此操作将永久废弃该 Token，无法恢复。</p>
       <div class="flex gap-3">
         <button onclick="closeModal('delete-modal')" class="flex-1 py-3 rounded-xl font-bold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">取消</button>
         <button onclick="confirmDeleteToken()" class="flex-1 py-3 rounded-xl font-bold bg-red-600 text-white hover:bg-red-700">确认删除</button>
       </div>
     </div>
   </div>

   <div id="toast" class="toast"></div>

   <script>
     const $ = id => document.getElementById(id);
     let editor = null;
     let authState = { mode: 'none', data: {} };
     let tokenToDelete = null;

     function init() {
         require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }});
         require(['vs/editor/editor.main'], () => {
           const savedTheme = localStorage.getItem('theme');
           if(savedTheme === 'dark') {
               document.body.classList.add('dark');
               $('theme-icon').innerText = '🌙';
           }
           editor = monaco.editor.create($('monaco-container'), {
               value: '// 请先登录并刷新列表...',
               language: 'javascript',
               automaticLayout: true,
               minimap: { enabled: false },
               fontSize: 14,
               theme: document.body.classList.contains('dark') ? 'vs-dark' : 'vs'
           });
         });

         const path = window.location.pathname;
         if (path.startsWith('/tk_')) {
             const token = path.substring(1);
             switchTab('token');
             $('login-ck').value = token;
             setTimeout(doLogin, 500);
         } else {
             const urlParams = new URLSearchParams(window.location.search);
             const magicToken = urlParams.get('token');
             if (magicToken) {
                 switchTab('token');
                 $('login-ck').value = magicToken;
                 setTimeout(doLogin, 500);
             } else {
                 checkLogin();
             }
         }
     }
     init();

     function switchTab(tab) {
         if(tab === 'admin') {
           $('tab-admin').classList.add('active'); $('tab-token').classList.remove('active');
           $('form-admin').classList.remove('hidden'); $('form-token').classList.add('hidden');
         } else {
           $('tab-token').classList.add('active'); $('tab-admin').classList.remove('active');
           $('form-token').classList.remove('hidden'); $('form-admin').classList.add('hidden');
         }
     }

     function checkLogin() {
         const sess = localStorage.getItem('wpe_session');
         if(sess) {
             const session = JSON.parse(sess);
             authState = session;
             showInterface();
         } else {
             $('login-gateway').classList.remove('hidden');
         }
     }

     async function doLogin() {
         const isTokenMode = $('tab-token').classList.contains('active');
         const btn = $('login-btn');
         btn.innerText = "验证中..."; btn.disabled = true;

         let payload = { action: 'verifyLogin' };
         if(isTokenMode) {
             payload.loginToken = $('login-ck').value.trim();
             if(!payload.loginToken) return resetLoginBtn("请输入 Token");
         } else {
             payload.accountId = $('login-aid').value.trim();
             payload.apiToken = $('login-key').value.trim();
             if(!payload.accountId || !payload.apiToken) return resetLoginBtn("请输入完整凭证");
         }

         try {
             const res = await apiCall(payload);
             if(res.success) {
                 authState = {
                     mode: isTokenMode ? 'token' : 'root',
                     data: payload
                 };
                 localStorage.setItem('wpe_session', JSON.stringify(authState));
                 showInterface();
             } else {
                 resetLoginBtn(res.errors?.[0]?.message || "验证失败");
             }
         } catch(e) {
             resetLoginBtn("网络错误");
         }
     }

     function resetLoginBtn(msg) {
         const btn = $('login-btn');
         btn.innerText = "进入系统"; btn.disabled = false;
         if(msg) showToast(msg, true);
     }

     function showInterface() {
         $('login-gateway').classList.add('hidden');
         $('main-interface').classList.remove('blur-sm');
         
         const badge = $('user-badge');
         if(authState.mode === 'root') {
             badge.innerHTML = "Root 管理员";
             badge.className = "px-3 py-1 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold";
         } else {
             badge.innerHTML = "Token 管理员";
             badge.className = "px-3 py-1 bg-blue-50 text-blue-600 border border-blue-200 rounded-lg text-xs font-bold";
         }
     }

     function doLogout() {
         localStorage.removeItem('wpe_session');
         const url = new URL(window.location);
         url.searchParams.delete('token');
         if(url.pathname.startsWith('/tk_')) {
             url.pathname = '/';
         }
         window.history.pushState({}, '', url);
         location.reload();
     }

     async function apiCall(data) {
         const fd = new FormData();
         for(let k in data) fd.append(k, data[k]);
         
         if(data.action !== 'verifyLogin' && authState.mode !== 'none') {
             if(authState.mode === 'token') {
                 fd.append('loginToken', authState.data.loginToken);
             } else {
                 fd.append('accountId', authState.data.accountId);
                 fd.append('apiToken', authState.data.apiToken);
             }
         }

         const response = await fetch(location.href, { method: 'POST', body: fd });
         return await response.json();
     }

     async function doAction(action, extra = {}) {
       if(authState.mode === 'none') return showToast("请先登录", true);
       
       const scriptName = $('script-select').value;
       if ((action === 'fetch' || action === 'deploy') && !scriptName) {
           return showToast("请先在列表中选择一个脚本！", true);
       }

       try {
         const res = await apiCall({ action, scriptName, ...extra });
         
         if(res.success || res.result) {
           if(action === 'listScripts') {
             $('script-select').innerHTML = res.result.map(s => \`<option value="\${s.id}">\${s.id}</option>\`).join('');
             showToast("列表更新成功");
           } else if(action === 'fetch') {
             editor.setValue(res.code);
             showToast("拉取成功");
           } else if(action === 'deploy') {
             showToast("🎉 部署成功！");
           }
         } else {
           showToast(res.errors?.[0]?.message || "异常", true);
         }
       } catch(e) { showToast("请求失败: " + e.message, true); }
     }

     function openTokenModal() {
         $('token-modal').classList.add('active');
         fetchTokens();
     }
     function closeModal(id) { 
         if(id === 'deploy-modal') $(id).classList.add('hidden'); 
         if(id === 'token-modal') $(id).classList.remove('active'); 
         if(id === 'delete-modal') $(id).classList.remove('active'); 
     }

     async function fetchTokens() {
       try {
           const res = await apiCall({ action: 'listTokens' });
           if(res.success) renderTokenList(res.result);
           else $('token-list').innerHTML = '<div class="text-center text-red-500">'+res.errors[0].message+'</div>';
       } catch(e) { $('token-list').innerHTML = 'ERR'; }
     }
     
     function toggleCustomExpiry() {
         const val = $('token-expiry').value;
         const customInput = $('custom-days');
         if (val === 'custom') {
             customInput.classList.remove('hidden');
             customInput.focus();
         } else {
             customInput.classList.add('hidden');
         }
     }

     async function generateToken() {
       let expiry = $('token-expiry').value;
       if (expiry === 'custom') {
           expiry = $('custom-days').value;
           if (!expiry || expiry <= 0) return showToast('请输入有效天数', true);
           if (expiry > 365) return showToast('自定义天数不能超过 365 天', true);
       }

       try {
           const res = await apiCall({ action: 'createToken', expiryDays: expiry });
           if(res.success) { 
               showToast("Token 生成成功"); 
               fetchTokens(); 
               $('token-expiry').value = "-1";
               $('custom-days').classList.add('hidden');
               $('custom-days').value = "";
           }
           else showToast(res.errors?.[0]?.message || "生成失败", true);
       } catch(e) { showToast("请求失败", true); }
     }

     function openDeleteModal(id) {
         tokenToDelete = id;
         $('delete-modal').classList.add('active');
     }

     async function confirmDeleteToken() {
       if(!tokenToDelete) return;
       closeModal('delete-modal');
       try {
           const res = await apiCall({ action: 'deleteToken', tokenId: tokenToDelete });
           if(res.success) { showToast("已删除"); fetchTokens(); }
       } catch(e) {}
       tokenToDelete = null;
     }
     
     function formatTime(ts) {
         const d = new Date(ts);
         const pad = n => n.toString().padStart(2, '0');
         return \`\${d.getFullYear()}/\${pad(d.getMonth()+1)}/\${pad(d.getDate())} \${pad(d.getHours())}:\${pad(d.getMinutes())}\`;
     }

     function renderTokenList(tokens) {
       const container = $('token-list');
       if(!tokens || tokens.length === 0) return container.innerHTML = '<div class="text-center text-slate-400">无 Token</div>';
       
       container.innerHTML = tokens.map(t => {
           const expiryDate = t.expiry === -1 ? '永不过期' : formatTime(t.expiry);
           const createdDate = formatTime(t.created);
           const status = t.isExpired ? '<span class="badge badge-red">过期</span>' : '<span class="badge badge-green">有效</span>';
           const deleteIcon = \`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>\`;
           
           return \`
             <div class="token-card">
                 <div onclick="openDeleteModal('\${t.id}')" class="delete-btn" title="删除">\${deleteIcon}</div>
                 <div class="flex flex-col gap-1 pr-8">
                     <div class="flex items-center gap-2">
                         <div class="token-val text-lg cursor-pointer" onclick="copyText('\${t.token}')">\${t.token}</div>
                         \${status}
                     </div>
                     <div class="text-sm text-slate-500 mt-1">
                         创建: \${createdDate} | 过期: \${expiryDate}
                     </div>
                 </div>
             </div>\`;
       }).join('');
     }

     function toggleTheme() {
       const isDark = document.body.classList.toggle('dark');
       $('theme-icon').innerText = isDark ? '🌙' : '☀️';
       if(editor) monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
       localStorage.setItem('theme', isDark ? 'dark' : 'light');
     }
     function showToast(m, isE = false) {
       const t = $('toast'); t.innerText = m;
       t.className = 'toast ' + (isE ? 'bg-red-500' : 'bg-emerald-600') + ' show';
       setTimeout(() => t.classList.remove('show'), 3000);
     }
     function openDeployModal() { 
       if(!$('script-select').value) return showToast("请先选择脚本", true); 
       $('deploy-modal').classList.remove('hidden'); 
     }
     async function executeDeploy() {
       closeModal('deploy-modal');
       const btn = $('p-btn'); btn.disabled = true; btn.innerText = "⌛ 同步中...";
       await doAction('deploy', { code: editor.getValue() });
       btn.disabled = false; btn.innerText = "🚀 同步部署";
     }
     function editorSelectAll() { editor?.focus(); editor?.setSelection(editor.getModel().getFullModelRange()); showToast("已全选"); }
     function editorCopyAll() { 
         navigator.clipboard.writeText(editor.getValue())
             .then(() => showToast("已复制"))
             .catch(() => { editorSelectAll(); showToast("请手动复制", true); });
     }
     async function editorPaste() {
       editor?.focus();
       try {
           const t = await navigator.clipboard.readText();
           if(t) { 
               editor.executeEdits('p', [{ range: editor.getSelection(), text: t, forceMoveMarkers: true }]);
               showToast("已粘贴");
           }
        } catch(e) { showToast("请允许剪贴板权限", true); }
     }
     function copyText(t) { navigator.clipboard.writeText(t).then(()=>showToast("Token 已复制")); }
   </script>
 </body>
 </html>
   `;
  }
};

// ==========================================
// 4. Node.js HTTP Server Entry Point
// ==========================================
// 优先使用 .env 中的 PORT，否则使用默认值 21111
const PORT = process.env.PORT || 21111;

const server = http.createServer(async (req, res) => {
  try {
    // 1. 构造 Web Standard Request
    const headers = new Headers();
    for (let key in req.headers) {
      if (req.headers[key]) headers.append(key, req.headers[key]);
    }

    const requestInit = {
      method: req.method,
      headers: headers,
      duplex: 'half' // Node 18+ fetch 需要
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      requestInit.body = Readable.toWeb(req);
    }

    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || `localhost:${PORT}`;
    const url = `${protocol}://${host}${req.url}`;
    
    const request = new Request(url, requestInit);

    // 2. 构造环境变量 (混合 .env 和 KV)
    const envParams = {
        KV_STORAGE, 
        ...process.env // 注入 .env 中的环境变量
    };

    // 3. 调用 Worker 逻辑
    const response = await workerLogic.fetch(request, envParams);

    // 4. 转换回 Node Response
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    
    // 处理流式响应
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();

  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end('Internal Server Error: ' + e.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Workers] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[Workers] Data directory: ${DATA_DIR}`);
  console.log(`[Workers] Environment loaded from .env`);
});