/**
 * Worker Pro Editor - 红色警告版
 * 修改内容：
 * 1. 部署确认按钮：改为红色 (bg-red-600)，强调操作风险。
 * 2. 代码格式：CSS 和 HTML 结构完全展开，不再压缩。
 * 3. 功能保持：修复 JSON 报错、双重变量探测、自动合并保护。
 */

export default {
    async fetch(request, env) {
      const jsonRes = (obj) => new Response(JSON.stringify(obj), {
        headers: { 'Content-Type': 'application/json;charset=UTF-8' }
      });
  
      if (request.method === "POST") {
        try {
          const formData = await request.formData();
          const action = formData.get("action");
          const accountId = formData.get("accountId");
          const apiToken = formData.get("apiToken");
          const scriptName = formData.get("scriptName");
  
          const authHeader = { 'Authorization': `Bearer ${apiToken}` };
          const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`;
  
          const safeFetch = async (url, options = {}) => {
            try {
              const res = await fetch(url, options);
              const text = await res.text();
              let data;
              try {
                data = JSON.parse(text);
              } catch (e) {
                data = { success: false, errors: [{ message: text || "API 响应非 JSON 格式" }] };
              }
              return { ok: res.ok, status: res.status, data };
            } catch (err) {
              return { ok: false, data: { success: false, errors: [{ message: err.message }] } };
            }
          };
  
          if (action === "listScripts") {
            const res = await safeFetch(baseUrl, { headers: authHeader });
            return jsonRes(res.data);
          }
  
          if (action === "fetch") {
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
  
            let bindings = [];
            if (settingsRes.ok && settingsRes.data.result) {
              bindings = settingsRes.data.result.bindings || [];
            }
  
            return jsonRes({ success: true, code, bindings });
          }
  
          if (action === "deploy") {
            const code = formData.get("code");
            const settingsRes = await safeFetch(`${baseUrl}/${scriptName}/settings`, {
               headers: { ...authHeader, 'Content-Type': 'application/json' }
            });
            
            let bindings = [];
            if (settingsRes.ok && settingsRes.data.result) {
               bindings = settingsRes.data.result.bindings || [];
            }
  
            const cfFormData = new FormData();
            cfFormData.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');
            cfFormData.append('metadata', JSON.stringify({
              main_module: 'worker.js',
              compatibility_date: '2024-01-01',
              bindings: bindings 
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
  
      return new Response(renderUI(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    },
  };
  
  function renderUI() {
    return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Worker Pro IDE</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
    <style>
      :root {
        --bg: #f1f5f9;
        --card: #ffffff;
        --text: #1e293b;
        --border: #e2e8f0;
        --input-bg: #f8fafc;
        --input-text: #1e293b;
      }
  
      .dark {
        --bg: #0f172a;
        --card: #1e293b;
        --text: #f8fafc;
        --border: #334155;
        --input-bg: #0f172a;
        --input-text: #f8fafc;
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
        transition: background-color 0.3s, color 0.3s;
      }
      
      .custom-content-wrapper {
        position: relative;
        width: 75% !important;
        max-width: 1200px;
        padding: 2.5rem;
        border-radius: 1.5rem;
        background: var(--card);
        border: 1px solid var(--border);
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.15);
        transition: background-color 0.3s, border-color 0.3s;
        /* 使用 flex 布局让署名靠下 */
        display: flex;
        flex-direction: column;
      }
  
      @media (max-width: 768px) {
        .custom-content-wrapper { width: 100% !important; padding: 1.25rem; }
      }
      
      .theme-toggle {
        position: absolute;
        top: 1.5rem;
        right: 1.5rem;
        cursor: pointer;
        font-size: 1.2rem;
        padding: 0.5rem;
        border-radius: 0.75rem;
        background: var(--bg);
        border: 1px solid var(--border);
        transition: all 0.2s;
        z-index: 10;
      }
  
      input, select {
        background-color: var(--input-bg) !important;
        color: var(--input-text) !important;
        border: 1px solid var(--border) !important;
      }
  
      #monaco-container {
        height: 50vh;
        border-radius: 0.75rem;
        border: 2px solid var(--border);
        overflow: hidden;
        margin: 1rem 0;
      }
  
      /* 重点修改：容器内部的署名样式 */
      .footer-signature {
        margin-top: 1.5rem;
        padding-top: 1.2rem;
        border-top: 1px solid var(--border);
        text-align: center;
      }
  
      .footer-link {
        color: #3b82f6;
        font-weight: 600;
        font-size: 0.85rem;
        text-decoration: none;
        transition: 0.2s;
      }
  
      .footer-link:hover {
        text-decoration: underline;
        opacity: 0.8;
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
      .toast.show { opacity: 1; }
    </style>
  </head>
  <body class="light">
    <div class="custom-content-wrapper">
      <button onclick="toggleTheme()" class="theme-toggle" id="theme-icon">☀️</button>
      
      <h1 class="text-3xl font-blod text-center mb-8 text-blue-600 tracking-tighter uppercase">WORKER PRO IDE</h1>
      
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <input id="aid" type="text" placeholder="Account ID" class="p-4 rounded-xl text-lg w-full shadow-inner outline-none">
        <div class="relative flex items-center">
          <input id="token" type="password" placeholder="API Token" class="p-4 rounded-xl text-lg w-full shadow-inner outline-none pr-12">
        </div>
      </div>
      
      <div class="flex gap-2 mb-4">
        <select id="script-select" class="flex-1 p-4 rounded-xl text-lg outline-none cursor-pointer appearance-none">
          <option value="">-- 请刷新脚本列表 --</option>
        </select>
        <button onclick="doAction('listScripts')" class="bg-emerald-500 hover:bg-emerald-600 text-white px-8 rounded-xl font-black active:scale-95 transition">刷新列表</button>
      </div>
  
      <div class="flex justify-between items-center mb-2">
        <button onclick="doAction('fetch')" class="text-blue-500 font-black hover:underline text-sm uppercase">验证并拉取代码</button>
        <div id="binding-container"></div>
      </div>
  
      <div id="monaco-container"></div>
  
      <button id="p-btn" onclick="openDeployModal()" class="w-full mt-6 bg-blue-600 hover:bg-blue-700 text-white py-5 rounded-2xl font-black text-xl shadow-2xl transition active:scale-95">
        🚀 同步部署
      </button>
  
      <div class="footer-signature">
        <a href="https://github.com/Kevin-YST-Du/Cloudflare-Accel" target="_blank" class="footer-link">
          Powered by Kevin-YST-Du/Cloudflare-Accel
        </a>
      </div>
    </div>
  
    <div id="deploy-modal" class="fixed inset-0 bg-black/60 hidden z-[1000] flex items-center justify-center p-6 backdrop-blur-sm">
      <div class="bg-white dark:bg-slate-900 w-full max-w-sm rounded-3xl p-8 border border-slate-200 text-center shadow-2xl">
        <h3 class="text-2xl font-black mb-2 text-slate-800 dark:text-slate-100">确认同步部署？</h3>
        <p class="text-slate-500 text-sm mb-6">部署将合并现有配置。</p>
        <div class="flex gap-3">
          <button onclick="closeModal()" class="flex-1 py-4 rounded-xl font-bold bg-slate-100 dark:bg-slate-800 text-slate-600">取消</button>
          <button onclick="executeDeploy()" class="flex-1 py-4 rounded-xl font-bold bg-red-600 text-white">确认部署</button>
        </div>
      </div>
    </div>
  
    <div id="toast" class="toast"></div>
  
    <script>
      const $ = id => document.getElementById(id);
      let editor = null;
  
      function toggleTheme() {
        const isDark = document.body.classList.toggle('dark');
        const themeIcon = $('theme-icon');
        themeIcon.innerText = isDark ? '🌙' : '☀️';
        if(editor) monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
      }
  
      require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }});
      require(['vs/editor/editor.main'], () => {
        const savedTheme = localStorage.getItem('theme');
        if(savedTheme === 'dark') {
          document.body.classList.add('dark');
          $('theme-icon').innerText = '🌙';
        }
        editor = monaco.editor.create($('monaco-container'), {
          value: '// 请先拉取代码...',
          language: 'javascript',
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 14,
          theme: document.body.classList.contains('dark') ? 'vs-dark' : 'vs'
        });
      });
  
      function showToast(m, isE = false) {
        const t = $('toast');
        t.innerText = m;
        t.className = 'toast ' + (isE ? 'bg-red-500' : 'bg-emerald-600') + ' show';
        setTimeout(() => t.classList.remove('show'), 3000);
      }
  
      function openDeployModal() { 
        if(!$('script-select').value) return showToast("请先选择脚本", true); 
        $('deploy-modal').classList.remove('hidden'); 
      }
      function closeModal() { $('deploy-modal').classList.add('hidden'); }
  
      async function doAction(action, extra = {}) {
        const aid = $('aid').value.trim(), tok = $('token').value.trim();
        const scriptName = $('script-select').value;
        if(!aid || !tok) return showToast("凭证未填写", true);
        const fd = new FormData();
        fd.append('action', action); fd.append('accountId', aid); fd.append('apiToken', tok); fd.append('scriptName', scriptName);
        for(let k in extra) fd.append(k, extra[k]);
  
        try {
          const response = await fetch(location.href, { method: 'POST', body: fd });
          const res = await response.json();
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
        } catch(e) { showToast("失败", true); }
      }
  
      async function executeDeploy() {
        closeModal();
        const btn = $('p-btn');
        btn.disabled = true; btn.innerText = "⌛ 同步中...";
        await doAction('deploy', { code: editor.getValue() });
        btn.disabled = false; btn.innerText = "🚀 同步部署";
      }
    </script>
  </body>
  </html>
    `;
  }
