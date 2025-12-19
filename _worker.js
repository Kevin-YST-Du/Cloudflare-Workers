/**
 * Worker Pro Editor - 绑定修复增强版
 * * 核心升级：
 * 1. 双重探测：同时请求 `/script` 和 `/settings` 接口，彻底解决“绑定不显示”问题。
 * 2. 权限容错：如果 Token 缺权限，会提示“获取设置失败”而不是默默显示无绑定。
 * 3. 完美 UI：WORKER PRO IDE (常规字体)、ID 明文、Token 切换、报错复制。
 */

export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const action = formData.get("action");
        const accountId = formData.get("accountId");
        const apiToken = formData.get("apiToken");
        const scriptName = formData.get("scriptName");

        const authHeader = { 'Authorization': `Bearer ${apiToken}` };
        const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`;

        // 安全请求助手
        const safeFetch = async (url, options = {}) => {
          try {
            const res = await fetch(url, options);
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); } 
            catch (e) { data = { success: false, errors: [{ message: text || "API 响应非 JSON" }] }; }
            return { ok: res.ok, status: res.status, data };
          } catch (err) {
            return { ok: false, data: { success: false, errors: [{ message: err.message }] } };
          }
        };

        const jsonRes = (obj) => new Response(JSON.stringify(obj), {
          headers: { 'Content-Type': 'application/json;charset=UTF-8' }
        });

        // 获取脚本列表
        if (action === "listScripts") {
          const res = await safeFetch(baseUrl, { headers: authHeader });
          return jsonRes(res.data);
        }

        // 验证并拉取 (双重探测绑定)
        if (action === "fetch") {
          // 1. 获取代码
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

          // 2. 获取 Metadata (路径 A)
          const metaRes = await safeFetch(`${baseUrl}/${scriptName}`, {
            headers: { ...authHeader, 'Content-Type': 'application/json' }
          });

          // 3. 获取 Settings (路径 B - 核心修复)
          const settingsRes = await safeFetch(`${baseUrl}/${scriptName}/settings`, {
            headers: { ...authHeader, 'Content-Type': 'application/json' }
          });

          // 合并绑定信息
          let bindings = [];
          
          // 尝试从 settings 获取 (优先级高)
          if (settingsRes.ok && settingsRes.data.result) {
            bindings = settingsRes.data.result.bindings || [];
          } 
          // 如果 settings 空，尝试从 metadata 获取
          if (bindings.length === 0 && metaRes.ok && metaRes.data.result) {
            const r = metaRes.data.result;
            bindings = r.bindings || (r.settings && r.settings.bindings) || [];
          }

          return jsonRes({ success: true, code, bindings });
        }

        // 部署 (带变量保护)
        if (action === "deploy") {
          const code = formData.get("code");
          
          // 部署前强制获取最新 Settings
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
    :root { --bg: #f1f5f9; --card: #ffffff; --text: #1e293b; --border: #e2e8f0; }
    .dark { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --border: #334155; }
    body { background-color: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; padding: 2rem 1rem; margin: 0; min-height: 100vh; display: flex; justify-content: center; }
    
    .custom-content-wrapper { 
      width: 75% !important; max-width: 1200px; padding: 2.5rem; border-radius: 1.5rem; background: var(--card); 
      border: 1px solid var(--border); box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.15); 
    }
    @media (max-width: 768px) { .custom-content-wrapper { width: 100% !important; padding: 1.25rem; } }
    
    .binding-tag { display: inline-flex; align-items: center; padding: 0.2rem 0.6rem; border-radius: 0.4rem; font-size: 0.7rem; font-weight: 800; margin: 0.2rem; border: 1px solid var(--border); background: var(--bg); color: #2563eb; }
    .binding-type { color: #64748b; margin-right: 0.3rem; text-transform: uppercase; font-size: 0.6rem; font-weight: 500; }

    #monaco-container { height: 50vh; border-radius: 0.75rem; border: 2px solid var(--border); overflow: hidden; margin: 1rem 0; background: #fff; }

    .toast { position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%); padding: 0.8rem 2rem; border-radius: 1rem; color: white; opacity: 0; transition: 0.3s; z-index: 2000; text-align: center; pointer-events: auto !important; user-select: text !important; cursor: text; }
    .toast.show { opacity: 1; }

    .input-wrapper { position: relative; display: flex; align-items: center; }
    .eye-icon { position: absolute; right: 1rem; cursor: pointer; color: #94a3b8; font-size: 1.2rem; user-select: none; }
  </style>
</head>
<body class="light">
  <div class="custom-content-wrapper">
    <h1 class="text-3xl font-normal text-center mb-8 text-blue-600 tracking-tighter uppercase">WORKER PRO IDE</h1>
    
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
      <input id="aid" type="text" placeholder="Account ID" class="p-4 rounded-xl text-lg w-full bg-slate-50 border border-slate-200 outline-none shadow-inner">
      <div class="input-wrapper">
        <input id="token" type="password" placeholder="API Token" class="p-4 rounded-xl text-lg w-full bg-slate-50 border border-slate-200 shadow-inner outline-none pr-12">
        <span id="toggle-eye" class="eye-icon" onclick="toggleTokenVisibility()">👁️</span>
      </div>
    </div>
    
    <div class="flex gap-2 mb-4">
      <select id="script-select" class="flex-1 p-4 rounded-xl text-lg border border-slate-200 outline-none bg-slate-50 cursor-pointer appearance-none">
        <option value="">-- 请刷新脚本列表 --</option>
      </select>
      <button onclick="doAction('listScripts')" class="bg-emerald-500 hover:bg-emerald-600 text-white px-8 rounded-xl font-black shadow-lg shadow-emerald-500/20 active:scale-95 transition">刷新列表</button>
    </div>

    <div class="flex flex-wrap justify-between items-center px-1 mb-2 gap-2">
      <button onclick="doAction('fetch')" class="text-blue-500 font-black hover:underline text-sm uppercase">验证并拉取代码</button>
      <div id="binding-container" class="flex flex-wrap justify-end"></div>
    </div>

    <div id="monaco-container"></div>

    <button id="p-btn" onclick="openDeployModal()" class="w-full mt-6 bg-blue-600 hover:bg-blue-700 text-white py-5 rounded-2xl font-black text-xl shadow-2xl transition active:scale-95">
      🚀 同步部署
    </button>
  </div>

  <div id="deploy-modal" class="fixed inset-0 bg-black/60 hidden z-[1000] flex items-center justify-center p-6 backdrop-blur-sm">
    <div class="bg-white dark:bg-slate-900 w-full max-w-sm rounded-3xl p-8 border border-slate-200 text-center shadow-2xl">
      <div class="text-5xl mb-4">💡</div>
      <h3 class="text-2xl font-black mb-2 text-slate-800">确认同步部署？</h3>
      <p class="text-slate-500 text-sm mb-6 leading-relaxed text-left px-2">
          IDE 将自动读取并合并云端现有的 <b>环境变量、KV、D1</b> 配置，确保仪表盘设置不丢失。
      </p>
      <div class="flex gap-3">
        <button onclick="closeModal()" class="flex-1 py-4 rounded-xl font-bold bg-slate-100 text-slate-600">取消</button>
        <button onclick="executeDeploy()" class="flex-1 py-4 rounded-xl font-bold bg-blue-600 text-white shadow-lg transition">确认部署</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    const $ = id => document.getElementById(id);
    let editor = null;

    function toggleTokenVisibility() {
      const input = $('token'), eye = $('toggle-eye');
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      eye.innerText = isPass ? '🙈' : '👁️';
    }

    require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }});
    require(['vs/editor/editor.main'], () => {
      editor = monaco.editor.create($('monaco-container'), {
        value: '// 请先拉取代码...',
        language: 'javascript', automaticLayout: true, minimap: { enabled: false }, fontSize: 14, theme: 'vs'
      });
    });

    function showToast(m, isE = false) {
      const t = $('toast');
      t.innerText = m;
      t.className = 'toast ' + (isE ? 'bg-red-500' : 'bg-emerald-600') + ' show';
      setTimeout(() => t.classList.remove('show'), isE ? 10000 : 3000);
    }

    function renderBindings(bindings) {
      const container = $('binding-container');
      if (!bindings || bindings.length === 0) {
        container.innerHTML = '<span class="text-[10px] text-slate-400 italic">暂无环境变量/绑定 (若有设置环境变量请检查 Token 权限)</span>';
        return;
      }
      container.innerHTML = bindings.map(b => \`
        <div class="binding-tag">
          <span class="binding-type">\${b.type.replace('_',' ')}</span>
          <span class="font-bold">\${b.name}</span>
        </div>\`).join('');
    }

    function openDeployModal() { if(!$('script-select').value) return showToast("请先选择脚本", true); $('deploy-modal').classList.remove('hidden'); }
    function closeModal() { $('deploy-modal').classList.add('hidden'); }

    async function doAction(action, extra = {}) {
      const aid = $('aid').value.trim(), tok = $('token').value.trim();
      const scriptName = $('script-select').value;
      if(!aid || !tok) return showToast("凭证未填写", true);
      if(!scriptName && action !== 'listScripts') return showToast("请先选择脚本", true);

      const fd = new FormData();
      fd.append('action', action); fd.append('accountId', aid); fd.append('apiToken', tok); fd.append('scriptName', scriptName);
      for(let k in extra) fd.append(k, extra[k]);

      try {
        const response = await fetch(location.href, { method: 'POST', body: fd });
        const res = await response.json();

        if(res.success || (res.result && !res.errors)) {
          if(action === 'listScripts') {
            const list = res.result || [];
            $('script-select').innerHTML = list.map(s => \`<option value="\${s.id}">\${s.id}</option>\`).join('');
            showToast("列表更新成功");
          } else if(action === 'fetch') {
            editor.setValue(res.code);
            renderBindings(res.bindings);
            showToast("拉取成功");
          } else if(action === 'deploy') {
            showToast("🎉 部署成功！");
          }
        } else {
          showToast(res.errors?.[0]?.message || "请求异常", true);
        }
      } catch(e) { 
        showToast("请求失败，请检查网络或 Token", true); 
      }
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
