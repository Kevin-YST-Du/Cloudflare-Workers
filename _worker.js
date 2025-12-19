/**
 * Worker Pro Editor - 旗舰功能版
 * 修改项：
 * 1. API Token 增加“显示/隐藏”切换小图标
 * 2. Account ID 保持明文显示 (type="text")
 * 3. 标题 Worker Pro IDE 不加粗 (font-normal)
 * 4. 报错信息支持鼠标选中复制，代码保持格式化
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

        // 1. 获取脚本列表
        if (action === "listScripts") {
          const res = await fetch(baseUrl, {
            headers: { ...authHeader, 'Content-Type': 'application/json' }
          });
          return new Response(await res.text());
        }

        // 2. 验证并拉取代码
        if (action === "fetch") {
          const res = await fetch(`${baseUrl}/${scriptName}`, {
            headers: { ...authHeader, 'Content-Type': 'application/json' }
          });
          if (!res.ok) return new Response(await res.text(), { status: res.status });

          const contentType = res.headers.get("content-type") || "";
          let code = "";
          
          if (contentType.includes("multipart")) {
            const multiData = await res.formData();
            let entry = multiData.get("worker.js") || multiData.get("index.js");
            code = (typeof entry === 'string') ? entry : await entry.text();
          } else {
            code = await res.text();
          }
          return new Response(JSON.stringify({ success: true, code }));
        }

        // 3. 部署代码
        if (action === "deploy") {
          const code = formData.get("code");
          const cfFormData = new FormData();
          cfFormData.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');
          cfFormData.append('metadata', JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-01-01' }));

          const res = await fetch(`${baseUrl}/${scriptName}`, {
            method: 'PUT',
            headers: authHeader,
            body: cfFormData
          });
          return new Response(await res.text());
        }
      } catch (err) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: err.message }] }), { status: 500 });
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
  <title>Worker Pro Editor</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
  <style>
    :root { --bg: #f1f5f9; --card: #ffffff; --text: #1e293b; --border: #e2e8f0; }
    .dark { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --border: #334155; }

    body { 
      background-color: var(--bg); 
      color: var(--text); 
      font-family: 'Inter', sans-serif; 
      transition: 0.3s; 
      padding: 2rem 1rem; 
      margin: 0; 
      min-height: 100vh; 
      display: flex; 
      justify-content: center; 
    }

    .custom-content-wrapper { 
      width: 75% !important; 
      max-width: 1200px; 
      padding: 2.5rem; 
      border-radius: 1.5rem; 
      background: var(--card); 
      border: 1px solid var(--border); 
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.15); 
    }

    @media (max-width: 768px) { 
      .custom-content-wrapper { width: 100% !important; padding: 1.25rem; } 
    }

    #monaco-container { 
      height: 55vh; 
      border-radius: 0.75rem; 
      border: 2px solid var(--border); 
      overflow: hidden; 
      margin: 1rem 0; 
      background: #fff; 
    }

    /* 核心修改：允许报错提示直接选中并复制 */
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
      text-align: center;
      pointer-events: auto !important; 
      user-select: text !important;
      cursor: text;
    }
    .toast.show { opacity: 1; }

    /* Token 输入框容器 */
    .input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }

    .eye-icon {
      position: absolute;
      right: 1rem;
      cursor: pointer;
      color: #94a3b8;
      user-select: none;
      font-size: 1.2rem;
    }
    .eye-icon:hover { color: #3b82f6; }

    .modal-overlay { 
      position: fixed; 
      inset: 0; 
      background: rgba(0,0,0,0.6); 
      backdrop-filter: blur(4px); 
      z-index: 1000; 
      display: none; 
      align-items: center; 
      justify-content: center; 
      padding: 1.5rem; 
      opacity: 0; 
      transition: 0.3s; 
    }
    .modal-overlay.visible { display: flex; opacity: 1; }

    .modal-card { 
      background: var(--card); 
      width: 100%; 
      max-width: 450px; 
      border-radius: 1.5rem; 
      padding: 2rem; 
      transform: scale(0.9); 
      transition: 0.3s; 
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); 
      border: 1px solid var(--border); 
    }
    .modal-overlay.visible .modal-card { transform: scale(1); }
  </style>
</head>
<body class="light">
  <div class="custom-content-wrapper">
    <h1 class="text-3xl font-normal text-center mb-8 text-blue-600 tracking-tighter">WORKER PRO IDE</h1>
    
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
      <input id="aid" type="text" placeholder="Account ID" class="p-4 rounded-xl text-lg w-full bg-slate-50 border border-slate-200 shadow-inner outline-none">
      
      <div class="input-wrapper">
        <input id="token" type="password" placeholder="API Token" class="p-4 rounded-xl text-lg w-full bg-slate-50 border border-slate-200 shadow-inner outline-none pr-12">
        <span id="toggle-eye" class="eye-icon" onclick="toggleTokenVisibility()">👁️</span>
      </div>
    </div>
    
    <div class="flex gap-2 mb-4">
      <select id="script-select" class="flex-1 p-4 rounded-xl text-lg border border-slate-200 outline-none cursor-pointer appearance-none bg-slate-50">
        <option value="">-- 请先获取列表 --</option>
      </select>
      <button onclick="doAction('listScripts')" class="bg-emerald-500 hover:bg-emerald-600 text-white px-8 rounded-xl font-black transition active:scale-95 shadow-lg shadow-emerald-500/20">刷新</button>
    </div>

    <div class="flex px-1 mb-2">
      <button onclick="doAction('fetch')" class="text-blue-500 font-black hover:underline text-sm uppercase">验证并拉取代码</button>
    </div>

    <div id="monaco-container"></div>

    <button id="p-btn" onclick="openDeployModal()" class="w-full mt-6 bg-blue-600 hover:bg-blue-700 text-white py-5 rounded-2xl font-black text-xl shadow-2xl transition active:scale-95">
      🚀 同步部署
    </button>
  </div>

  <div id="deploy-modal" class="modal-overlay">
    <div class="modal-card text-center">
      <div class="text-5xl mb-4">⚠️</div>
      <h3 class="text-2xl font-black mb-2 text-red-600">确认同步部署？</h3>
      <p class="text-slate-500 text-sm mb-6 leading-relaxed">
          当前操作将覆盖远程边缘节点的代码。<br>
          <span class="text-red-600 font-black">🔥 远程现有代码将被直接覆盖。</span>
      </p>
      <div class="flex gap-3">
        <button onclick="closeModal('deploy-modal')" class="flex-1 py-4 rounded-xl font-bold bg-slate-100 text-slate-600">取消</button>
        <button onclick="executeDeploy()" class="flex-1 py-4 rounded-xl font-bold bg-red-600 text-white shadow-lg shadow-red-500/30">立即同步</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    const $ = id => document.getElementById(id);
    let editor = null;

    // Token 显示/隐藏切换逻辑
    function toggleTokenVisibility() {
      const tokenInput = $('token');
      const eyeIcon = $('toggle-eye');
      if (tokenInput.type === 'password') {
        tokenInput.type = 'text';
        eyeIcon.innerText = '🙈';
      } else {
        tokenInput.type = 'password';
        eyeIcon.innerText = '👁️';
      }
    }

    require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }});
    require(['vs/editor/editor.main'], () => {
      editor = monaco.editor.create($('monaco-container'), {
        value: '// 请先刷新并选择脚本...',
        language: 'javascript',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 14,
        theme: 'vs'
      });
    });

    function showToast(m, isE = false) {
      const t = $('toast');
      t.innerText = m;
      t.className = 'toast ' + (isE ? 'bg-red-500' : 'bg-emerald-600') + ' show';
      setTimeout(() => t.classList.remove('show'), isE ? 10000 : 3000);
    }

    function openModal(id) { $(id).classList.add('visible'); }
    function closeModal(id) { $(id).classList.remove('visible'); }

    async function doAction(action, extra = {}) {
      const aid = $('aid').value.trim(), tok = $('token').value.trim();
      const scriptName = $('script-select').value;
      if(!aid || !tok) return showToast("凭证未填写", true);
      if(!scriptName && action !== 'listScripts') return showToast("请选择脚本", true);

      const fd = new FormData();
      fd.append('action', action);
      fd.append('accountId', aid);
      fd.append('apiToken', tok);
      fd.append('scriptName', scriptName);
      for(let k in extra) fd.append(k, extra[k]);

      try {
        const res = await fetch(location.href, { method: 'POST', body: fd }).then(r => r.json());
        if(res.success) {
          if(action === 'listScripts') {
            $('script-select').innerHTML = res.result.map(s => \`<option value="\${s.id}">\${s.id}</option>\`).join('');
            showToast("列表已同步更新");
          } else if(action === 'fetch') {
            editor.setValue(res.code);
            showToast("代码已拉取成功");
          } else if(action === 'deploy') {
            showToast("🚀 部署成功！");
          }
          return res;
        } else { showToast(res.errors[0].message, true); }
      } catch(e) { showToast("⚠️ 请求异常", true); }
    }

    function openDeployModal() {
      if(!$('script-select').value) return showToast("请选择脚本", true);
      openModal('deploy-modal');
    }

    async function executeDeploy() {
      closeModal('deploy-modal');
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
