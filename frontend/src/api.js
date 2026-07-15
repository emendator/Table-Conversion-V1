/**
 * API 调用模块
 * 自动管理 X-Session-Id 会话
 */

const SESSION_KEY = 'table_converter_session_id';

function getSessionId() {
    let sid = localStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = crypto.randomUUID();
        localStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

async function api(url, options = {}) {
    const headers = {
        'X-Session-Id': getSessionId(),
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {}),
    };
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    try {
        const data = JSON.parse(text);
        if (data.sessionId) localStorage.setItem(SESSION_KEY, data.sessionId);
        return data;
    } catch {
        throw new Error(`服务器错误 (${res.status}): ${text.substring(0, 200)}`);
    }
}

export async function uploadSource(files) {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    const res = await fetch('/api/upload/source', {
        method: 'POST',
        body: formData,
        headers: { 'X-Session-Id': getSessionId() },
    });
    const text = await res.text();
    const data = JSON.parse(text);
    if (data.sessionId) localStorage.setItem(SESSION_KEY, data.sessionId);
    return data;
}

export async function uploadReference(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload/reference', {
        method: 'POST',
        body: formData,
        headers: { 'X-Session-Id': getSessionId() },
    });
    const text = await res.text();
    const data = JSON.parse(text);
    if (data.sessionId) localStorage.setItem(SESSION_KEY, data.sessionId);
    return data;
}

export async function clearSource() {
    return api('/api/clear/source', { method: 'POST' });
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

export async function runConvert(mappings) {
    return api('/api/convert', {
        method: 'POST',
        body: JSON.stringify({ mappings }),
    });
}

export async function getStatus() {
    return api('/api/status');
}

export async function resetSession() {
    return api('/api/reset', { method: 'POST' });
}

export async function downloadFile(filename) {
    const res = await fetch('/api/download', {
        headers: { 'X-Session-Id': getSessionId() },
    });
    if (!res.ok) throw new Error('下载失败');
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
