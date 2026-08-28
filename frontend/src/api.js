/**
 * API 调用模块
 * 自动管理 X-Session-Id 会话 与 登录令牌（Authorization: Bearer）
 */

const SESSION_KEY = 'table_converter_session_id';
const TOKEN_KEY = 'table_converter_token';
const USER_KEY = 'table_converter_user';

/**
 * 生成会话 ID。
 * crypto.randomUUID() 仅在安全上下文（HTTPS / localhost）可用，
 * 生产环境用 http://IP 访问时不可用，因此提供 Math.random 兜底实现。
 */
function generateSessionId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch (e) { /* 忽略，走兜底实现 */ }
    // 兜底：基于 Math.random 的 UUID v4 格式
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : ((r & 0x3) | 0x8);
        return v.toString(16);
    });
}

function getSessionId() {
    let sid = localStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = generateSessionId();
        localStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

/* ===================== 登录令牌管理 ===================== */
export function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
}

export function getStoredUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}

export function setStoredUser(user) {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
}

/** 登录过期/失效统一处理：清令牌 + 清用户 + 通知 App 跳转登录页 */
function handleUnauthorized() {
    clearToken();
    setStoredUser(null);
    try {
        window.dispatchEvent(new Event('auth-expired'));
    } catch (e) { /* 非浏览器环境忽略 */ }
}

/**
 * 捕获 fetch 网络错误（Failed to fetch / 连接被拒），转为友好中文提示
 * 根因通常是：后端服务未启动、端口不对、或访问地址未走 /api 代理
 */
async function safeFetch(url, options = {}) {
    try {
        return await fetch(url, options);
    } catch {
        throw new Error('无法连接服务器，请确认后端服务已启动（端口 8004）');
    }
}

async function api(url, options = {}) {
    const token = getToken();
    const headers = {
        'X-Session-Id': getSessionId(),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {}),
    };
    const res = await safeFetch(url, { ...options, headers });
    // 401：登录失效，清理令牌并通知路由守卫跳转登录页
    if (res.status === 401) handleUnauthorized();
    const text = await res.text();
    try {
        const data = JSON.parse(text);
        if (data.sessionId) localStorage.setItem(SESSION_KEY, data.sessionId);
        if (!res.ok) {
            // 后端错误统一归一化：FastAPI 抛错返回 {"detail": "..."}
            let detail = (data && data.detail !== undefined)
                ? data.detail
                : (data && data.error) || ('服务器返回异常 (' + res.status + ')');
            if (typeof detail !== 'string') detail = JSON.stringify(detail);
            return { success: false, error: detail, ...data };
        }
        return data;
    } catch {
        // 非 2xx 且非 JSON：抛出可读错误，避免前端显示 undefined
        if (!res.ok) throw new Error('服务器返回异常 (' + res.status + ')，请检查后端服务或网络');
        // 后端返回了 HTML（如 404/502 错误页或 index.html）而非 JSON
        throw new Error('服务器返回异常 (' + res.status + ')，请确认后端服务已启动、接口地址正确');
    }
}

export async function uploadSource(files) {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    return api('/api/upload/source', { method: 'POST', body: formData });
}

export async function uploadReference(file) {
    const formData = new FormData();
    formData.append('file', file);
    return api('/api/upload/reference', { method: 'POST', body: formData });
}

export async function clearSource() {
    return api('/api/clear/source', { method: 'POST' });
}

export async function deleteSource(filename) {
    return api('/api/delete/source', {
        method: 'POST',
        body: JSON.stringify({ filename }),
    });
}

export async function clearReference() {
    return api('/api/clear/reference', { method: 'POST' });
}

export async function runMatch(useAI = true) {
    return api('/api/match', {
        method: 'POST',
        body: JSON.stringify({ useAI }),
    });
}

export async function runConvert(mappings, onDuplicate = 'overwrite') {
    return api('/api/convert', {
        method: 'POST',
        body: JSON.stringify({ mappings, on_duplicate: onDuplicate }),
    });
}

export async function resetSession() {
    return api('/api/reset', { method: 'POST' });
}

/* ===================== AI 配置（API Key 加密管理） ===================== */

const TRANSPORT_SALT = 'table-converter-ai-transport-v1';

/** 纯 JS SHA-256（任意环境可用，兼容非安全上下文） */
function sha256(ascii) {
    function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
    const maxWord = Math.pow(2, 32);
    let result = '';
    const words = [];
    const asciiBitLength = ascii.length * 8;
    let hash = sha256.h = sha256.h || [];
    const k = sha256.k = sha256.k || [];
    let primeCounter = k.length;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
        if (!isComposite[candidate]) {
            for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
            hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
            k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
        }
    }
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (let i = 0; i < ascii.length; i++) {
        const j = ascii.charCodeAt(i);
        if (j >> 8) return; // ASCII only
        words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = ((asciiBitLength / maxWord) | 0);
    words[words.length] = asciiBitLength;
    for (let j = 0; j < words.length;) {
        const w = words.slice(j, j += 16);
        const oldHash = hash;
        hash = hash.slice(0, 8);
        for (let i = 0; i < 64; i++) {
            const w15 = w[i - 15], w2 = w[i - 2];
            const a = hash[0], e = hash[4];
            const temp1 = hash[7]
                + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
                + ((e & hash[5]) ^ ((~e) & hash[6]))
                + k[i]
                + (w[i] = (i < 16) ? w[i] : (
                    w[i - 16]
                    + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
                    + w[i - 7]
                    + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
                ) | 0);
            const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
                + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
            hash = [(temp1 + temp2) | 0].concat(hash);
            hash[4] = (hash[4] + temp1) | 0;
        }
        for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (let i = 0; i < 8; i++) {
        for (let j = 3; j + 1; j--) {
            const b = (hash[i] >> (j * 8)) & 255;
            result += ((b < 16) ? 0 : '') + b.toString(16);
        }
    }
    return result;
}

/** 使用会话 nonce 对 API Key 做 XOR 流加密（与后端 _transport_decrypt 对应） */
export async function encryptWithNonce(plain, nonce) {
    const keyHex = sha256(TRANSPORT_SALT + nonce);
    const key = [];
    for (let i = 0; i < keyHex.length; i += 2) key.push(parseInt(keyHex.substr(i, 2), 16));
    const data = new TextEncoder().encode(plain);
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
    let bin = '';
    out.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 读取 AI 配置状态（是否已配置 Key、掩码、当前 Key 总消耗、会话 nonce） */
export async function getAIConfig() {
    return api('/api/ai/config');
}

/** 保存新的 API Key（前端加密后上传），后端会重置该 Key 的消耗统计 */
export async function saveAIConfig(apiKeyEnc) {
    return api('/api/ai/config', {
        method: 'POST',
        body: JSON.stringify({ api_key_enc: apiKeyEnc }),
    });
}

export async function downloadFile(filename) {
    const res = await safeFetch('/api/download', {
        headers: { 'X-Session-Id': getSessionId(), ...(getToken() ? { 'Authorization': `Bearer ${getToken()}` } : {}) },
    });
    if (res.status === 401) handleUnauthorized();
    if (!res.ok) throw new Error('下载失败，请确认后端服务已启动');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/* ===================== 映射匹配库 API ===================== */

export async function getMappingLibrary() {
    return api('/api/mapping-library');
}

export async function addMappingRecord(source, target, onDuplicate = 'overwrite') {
    return api('/api/mapping-library', {
        method: 'POST',
        body: JSON.stringify({ source, target, on_duplicate: onDuplicate }),
    });
}

export async function checkMappingDuplicates(records) {
    /* 检查待写入记录中哪些源列名已存在于库中（仅以原始列名为准） */
    return api('/api/mapping-library/check-duplicates', {
        method: 'POST',
        body: JSON.stringify({ records }),
    });
}

export async function checkConvertDuplicates(mappings) {
    /* 预检转换完成后将保存到库的映射中的重复项 */
    return api('/api/mapping-library/check-convert-duplicates', {
        method: 'POST',
        body: JSON.stringify({ mappings }),
    });
}

export async function updateMappingRecord(id, source, target) {
    return api(`/api/mapping-library/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ source, target }),
    });
}

export async function deleteMappingRecord(id) {
    return api(`/api/mapping-library/${id}`, { method: 'DELETE' });
}

export async function clearMappingLibrary() {
    return api('/api/mapping-library', { method: 'DELETE' });
}

export async function exportMappingLibrary() {
    /* 导出为 Excel 表格 (.xlsx) 并触发下载 */
    const res = await safeFetch('/api/mapping-library/export', {
        headers: { 'X-Session-Id': getSessionId(), ...(getToken() ? { 'Authorization': `Bearer ${getToken()}` } : {}) },
    });
    if (res.status === 401) handleUnauthorized();
    if (!res.ok) throw new Error('导出失败，请确认后端服务已启动');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    let filename = `映射匹配库_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
    if (m) filename = decodeURIComponent(m[1]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export async function parseMappingImportFile(file) {
    /* 上传表格文件(.xlsx/.xls/.csv)，由后端解析出映射记录 */
    const formData = new FormData();
    formData.append('file', file);
    const res = await safeFetch('/api/mapping-library/import/parse', {
        method: 'POST',
        body: formData,
        headers: { 'X-Session-Id': getSessionId(), ...(getToken() ? { 'Authorization': `Bearer ${getToken()}` } : {}) },
    });
    if (res.status === 401) handleUnauthorized();
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`解析失败 (${res.status})，请确认后端服务已启动`);
    }
}

export async function importMappingLibrary(records, mode = 'merge', onDuplicate = 'overwrite') {
    return api('/api/mapping-library/import', {
        method: 'POST',
        body: JSON.stringify({ records, mode, on_duplicate: onDuplicate }),
    });
}

export async function batchDeleteMappingRecords(ids) {
    return api('/api/mapping-library/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
    });
}

/* ===================== 认证（登录/注册/登出/当前用户） ===================== */

export async function register(payload) {
    return api('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) });
}

export async function login(payload) {
    return api('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
}

/** 游客登录：创建临时游客账号，退出登录后后端自动清除全部使用痕迹 */
export async function guestLogin() {
    return api('/api/auth/guest', { method: 'POST' });
}

export async function logout() {
    return api('/api/auth/logout', { method: 'POST' });
}

export async function fetchMe() {
    return api('/api/auth/me');
}

/* ===================== 邀请码（admin / manager） ===================== */

export async function generateInvite(level, expiresAt) {
    return api('/api/invite/generate', { method: 'POST', body: JSON.stringify({ level, expires_at: expiresAt }) });
}

export async function listInvites() {
    return api('/api/invite/list');
}

export async function extendInvite(code, expiresAt) {
    return api('/api/invite/extend', { method: 'POST', body: JSON.stringify({ code, expires_at: expiresAt }) });
}

export async function deleteInvite(code) {
    return api('/api/invite/delete', { method: 'POST', body: JSON.stringify({ code }) });
}

/** 校验邀请码（注册页识别级别：level 1=管理员 2=用户） */
export async function validateInvite(code) {
    return api('/api/invite/validate', { method: 'POST', body: JSON.stringify({ code }) });
}

/* ===================== 用户管理（admin / manager） ===================== */

export async function listAdminUsers() {
    return api('/api/admin/users');
}

export async function extendAdminUser(userId, expiresAt) {
    return api(`/api/admin/users/${userId}/extend`, { method: 'POST', body: JSON.stringify({ expires_at: expiresAt }) });
}

export async function disableAdminUser(userId) {
    return api(`/api/admin/users/${userId}/disable`, { method: 'POST' });
}

/* ===================== 公司数据库密码（映射库隔离凭证） ===================== */

/** 查看当前公司数据库信息（是否已设置、创建/更新时间，不返回明文密码） */
export async function getCompanyInfo() {
    return api('/api/company/info');
}

/** 创建/修改公司数据库密码（manager 本公司；admin 可传 company 指定其他公司） */
export async function updateCompanyPassword(newPassword, company = '') {
    return api('/api/company/password', {
        method: 'POST',
        body: JSON.stringify({ new_password: newPassword, company }),
    });
}
