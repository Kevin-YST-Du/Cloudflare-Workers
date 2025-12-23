/**
 * WorkerS Pro Editor - 红色警告版 + 移动端增强补丁 (全选/复制/粘贴)
 * * 变更说明：
 * 1. 严格保留原有“红色警告版”所有逻辑。
 * 2. 新增 [粘贴] 按钮。
 * 3. 新增 editorPaste 函数。
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
    <title>Workers Pro IDE</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M13%202L3%2014H12L11%2022L21%2010H12L13%202Z%22%20stroke%3D%22%23F59E0B%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E">
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
        --btn-bg: #e2e8f0;
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
        display: flex;
        flex-direction: column;
      }
  
      @media (max-width: 768px) {
        .custom-content-wrapper { width: 100% !important; padding: 1.25rem; }
      }
      
      /* 按钮组容器：定位在右上角 */
      .top-actions-group {
        position: absolute;
        top: 1.5rem;
        right: 1.5rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        z-index: 10;
      }
  
      /* 统一按钮样式 */
      .action-icon-btn {
        width: 2.5rem;   /* 40px */
        height: 2.5rem;  /* 40px */
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
  
      #theme-icon { font-size: 1.1rem; }
  
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
      
      .mobile-action-btn {
        font-size: 0.75rem; 
        padding: 0.25rem 0.75rem; 
        border-radius: 0.5rem; 
        margin-left: 0.5rem;
        color: white;
        font-weight: bold;
        transition: opacity 0.2s;
      }
      .mobile-action-btn:active { transform: scale(0.95); }
    </style>
  </head>
  <body class="light">
    <div class="custom-content-wrapper">
      <div class="top-actions-group">
        <a href="https://github.com/Kevin-YST-Du/Cloudflare-Workers" target="_blank" class="action-icon-btn" title="GitHub">
          <svg height="20" viewBox="0 0 16 16" version="1.1" width="20" aria-hidden="true" fill="currentColor">
            <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 01-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 010 8c0-4.42 3.58-8 8-8Z"></path>
          </svg>
        </a>
        <button onclick="toggleTheme()" class="action-icon-btn" id="theme-icon">☀️</button>
      </div>
      
      <h1 class="text-3xl font-black text-center mb-8 text-blue-600 tracking-tighter uppercase">WORKERS PRO IDE</h1>
      
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
        <a href="https://github.com/Kevin-YST-Du/Cloudflare-Workers" target="_blank" class="footer-link">
          Powered by Kevin-YST-Du/Cloudflare-Workers
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
  
      function editorSelectAll() {
        if (!editor) return;
        editor.focus();
        editor.setSelection(editor.getModel().getFullModelRange());
        showToast("已全选");
      }
  
      function editorCopyAll() {
        if (!editor) return;
        const val = editor.getValue();
        navigator.clipboard.writeText(val).then(() => {
            showToast("已复制到剪贴板");
        }).catch(() => {
            editorSelectAll();
            showToast("复制失败，请手动长按复制", true);
        });
      }
  
      async function editorPaste() {
        if (!editor) return;
        editor.focus();
        try {
            const text = await navigator.clipboard.readText();
            if(!text) return showToast("剪贴板为空", true);
            const selection = editor.getSelection();
            editor.executeEdits('paste-source', [{
                range: selection,
                text: text,
                forceMoveMarkers: true
            }]);
            showToast("已粘贴");
        } catch(e) {
            showToast("粘贴失败：请允许浏览器访问剪贴板", true);
        }
      }
    </script>
  </body>
  </html>
    `;
  }
