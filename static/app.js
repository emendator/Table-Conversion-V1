/**
 * 表格转换工具 - 前端脚本
 * 简约高效，原生 JS 无依赖
 */

// ============================================================
// 状态管理
// ============================================================
const state = {
    sourceReady: false,
    referenceReady: false,
    mappings: [],
    targetOptions: [],
    sourceHeaders: [],
    outputName: '',
};

// ============================================================
// 工具函数
// ============================================================
const $ = (sel, ctx) => (ctx || document).querySelector(sel);
const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];
const show = el => el.style.display = '';
const hide = el => el.style.display = 'none';
const showFlex = el => el.style.display = 'flex';

async function api(url, opts = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
    });
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        // 服务器返回了非JSON内容（如HTML错误页）
        const preview = text.substring(0, 200);
        throw new Error(`服务器错误 (HTTP ${res.status}): ${preview}`);
    }
}

function showOverlay(text = '处理中...') {
    showFlex($('#overlay'));
    $('#overlay-text').textContent = text;
}

function hideOverlay() {
    hide($('#overlay'));
}

function updateSteps(activeStep) {
    $$('.step').forEach(s => {
        const n = parseInt(s.dataset.step);
        s.classList.remove('active', 'done');
        if (n < activeStep) s.classList.add('done');
        if (n === activeStep) s.classList.add('active');
    });
}

// ============================================================
// 文件上传处理
// ============================================================
function setupUpload(boxId, inputId, infoId, nameId, metaId, type) {
    const zone = $(`#${boxId} .upload-zone`);
    const input = $(`#${inputId}`);
    const info = $(`#${infoId}`);
    const nameEl = $(`#${nameId}`);
    const metaEl = $(`#${metaId}`);

    // 点击选择
    zone.addEventListener('click', () => input.click());

    // 拖拽上传
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0], type);
    });

    // 文件选择
    input.addEventListener('change', () => {
        if (input.files.length) handleFile(input.files[0], type);
    });
}

async function handleFile(file, type) {
    const formData = new FormData();
    formData.append('file', file);

    const endpoint = type === 'source' ? '/api/upload/source' : '/api/upload/reference';
    const fileSizeMB = (file.size / 1024 / 1024).toFixed(1);

    showOverlay(`正在上传并解析文件 (${fileSizeMB}MB)...`);
    try {
        const res = await fetch(endpoint, { method: 'POST', body: formData });
        const text = await res.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            if (res.status === 413) {
                throw new Error('文件过大，超过服务器上传限制。请压缩表格中的图片后重试。');
            }
            throw new Error(`服务器返回异常 (HTTP ${res.status})`);
        }

        if (result.success) {
            if (type === 'source') {
                state.sourceReady = true;
                $('#source-filename').textContent = result.filename;
                $('#source-meta').textContent = `${result.rowCount} 行 · ${result.headers.length} 列`;
                hide($('#source-dropzone'));
                showFlex($('#source-info'));
            } else {
                state.referenceReady = true;
                $('#reference-filename').textContent = result.filename;
                $('#reference-meta').textContent = `${result.headers.length} 列 · ${result.formulaCount} 公式列`;
                hide($('#reference-dropzone'));
                showFlex($('#reference-info'));
            }
            checkUploadReady();
        } else {
            alert('上传失败: ' + result.error);
        }
    } catch (e) {
        alert('网络错误: ' + e.message);
    } finally {
        hideOverlay();
    }
}

function clearFile(type) {
    if (type === 'source') {
        state.sourceReady = false;
        $('#source-file').value = '';
        show($('#source-dropzone'));
        hide($('#source-info'));
    } else {
        state.referenceReady = false;
        $('#reference-file').value = '';
        show($('#reference-dropzone'));
        hide($('#reference-info'));
    }

    // 重置后续步骤
    hide($('#section-match'));
    hide($('#section-preview'));
    hide($('#section-download'));
    hide($('#section-compare'));
    state.mappings = [];
    updateSteps(1);
}

function checkUploadReady() {
    if (state.sourceReady && state.referenceReady) {
        show($('#section-match'));
        updateSteps(2);
    }
}

// ============================================================
// AI 匹配
// ============================================================
async function runMatch() {
    const useAI = $('#use-ai').checked;
    const statusEl = $('#match-status');

    showOverlay(useAI ? '正在调用 DeepSeek AI 进行列名匹配...' : '正在执行规则匹配...');
    statusEl.className = 'match-status';
    hide(statusEl);

    try {
        const result = await api('/api/match', {
            method: 'POST',
            body: JSON.stringify({ useAI }),
        });

        if (result.success) {
            state.mappings = result.mappings;
            state.targetOptions = result.targetOptions;
            state.sourceHeaders = result.sourceHeaders;

            renderMappingTable();
            renderUnmapped(result.unmappedSources);

            show($('#section-preview'));
            updateSteps(3);

            statusEl.className = 'match-status info';
            statusEl.textContent = `✅ 匹配完成: ${result.mappings.length} 个列成功匹配`;
            show(statusEl);
        } else {
            statusEl.className = 'match-status error';
            statusEl.textContent = '❌ ' + result.error;
            show(statusEl);
        }
    } catch (e) {
        statusEl.className = 'match-status error';
        statusEl.textContent = '❌ 网络错误: ' + e.message;
        show(statusEl);
    } finally {
        hideOverlay();
    }
}

// ============================================================
// 映射表格渲染
// ============================================================
function renderMappingTable() {
    const tbody = $('#mapping-tbody');
    tbody.innerHTML = '';

    if (state.mappings.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px;">暂无匹配结果</td></tr>';
        return;
    }

    state.mappings.forEach((m, i) => {
        const tr = document.createElement('tr');

        // 匹配度
        const tdConf = document.createElement('td');
        tdConf.className = 'col-conf';
        const badge = document.createElement('span');
        badge.className = `conf-badge conf-${m.confidence}`;
        const confLabels = { high: '高', medium: '中', low: '低', manual: '手动' };
        badge.textContent = confLabels[m.confidence] || m.confidence;
        if (m.reason) badge.title = m.reason;
        tdConf.appendChild(badge);
        tr.appendChild(tdConf);

        // 源列名
        const tdSrc = document.createElement('td');
        tdSrc.className = 'col-src';
        tdSrc.textContent = m.source;
        tr.appendChild(tdSrc);

        // 箭头
        const tdArrow = document.createElement('td');
        tdArrow.className = 'col-arrow';
        tdArrow.textContent = '→';
        tr.appendChild(tdArrow);

        // 目标列名（可编辑下拉）
        const tdTgt = document.createElement('td');
        tdTgt.className = 'col-tgt';
        const select = document.createElement('select');
        select.className = 'target-select';
        select.innerHTML = '<option value="">-- 不映射 --</option>' +
            state.targetOptions.map(h => {
                const clean = (h || '').replace(/\n/g, '').trim();
                const selected = clean === (m.target || '').replace(/\n/g, '').trim() ? ' selected' : '';
                return `<option value="${escapeHtml(h || '')}"${selected}>${escapeHtml(h || '(空)')}</option>`;
            }).join('');
        select.addEventListener('change', () => {
            state.mappings[i].target = select.value;
        });
        tdTgt.appendChild(select);
        tr.appendChild(tdTgt);

        // 操作
        const tdAct = document.createElement('td');
        tdAct.className = 'col-act';
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm btn-danger';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', () => {
            state.mappings.splice(i, 1);
            renderMappingTable();
            renderUnmapped(getUnmappedSources());
        });
        tdAct.appendChild(delBtn);
        tr.appendChild(tdAct);

        tbody.appendChild(tr);
    });
}

function getUnmappedSources() {
    const mappedSources = new Set(state.mappings.map(m => m.source));
    return state.sourceHeaders.filter(h => !mappedSources.has(h));
}

function renderUnmapped(unmapped) {
    const section = $('#unmapped-section');
    const list = $('#unmapped-list');

    if (!unmapped || unmapped.length === 0) {
        hide(section);
        return;
    }

    show(section);
    list.innerHTML = unmapped.map(h =>
        `<span class="tag">${escapeHtml(h)}</span>`
    ).join('');
}

// ============================================================
// 执行转换
// ============================================================
async function runConvert() {
    const btn = $('#btn-convert');
    const statusEl = $('#convert-status');
    btn.disabled = true;

    showOverlay('正在转换表格...');
    statusEl.className = 'convert-status';
    hide(statusEl);

    try {
        const result = await api('/api/convert', {
            method: 'POST',
            body: JSON.stringify({ mappings: state.mappings }),
        });

        if (result.success) {
            state.outputName = result.outputName;
            $('#btn-download').href = result.downloadUrl;
            $('#btn-download').download = result.outputName;

            show($('#section-download'));

            // 渲染对比预览
            if (result.comparison && !result.comparison.error) {
                renderComparison(result.comparison);
                show($('#section-compare'));
            }

            updateSteps(4);
            // 滚动到下载区域
            $('#section-download').scrollIntoView({ behavior: 'smooth' });
        } else {
            statusEl.className = 'convert-status error';
            statusEl.textContent = '❌ ' + result.error;
            show(statusEl);
        }
    } catch (e) {
        statusEl.className = 'convert-status error';
        statusEl.textContent = '❌ 网络错误: ' + e.message;
        show(statusEl);
    } finally {
        btn.disabled = false;
        hideOverlay();
    }
}

// ============================================================
// 电子表格预览
// ============================================================
let compareData = { source: null, output: null };

function renderComparison(comparison) {
    compareData = {
        source: {
            headers: comparison.sourceHeaders,
            rows: comparison.sourcePreview,
            totalRows: comparison.sourceRowCount || comparison.sourcePreview.length,
        },
        output: {
            headers: comparison.outputHeaders,
            rows: comparison.outputPreview,
            totalRows: comparison.outputRowCount || comparison.outputPreview.length,
        },
    };

    // 默认显示转换结果
    switchCompareTab('output');

    // 绑定tab切换
    $$('.compare-tab').forEach(tab => {
        tab.addEventListener('click', () => switchCompareTab(tab.dataset.tab));
    });
}

function switchCompareTab(tabName) {
    const data = compareData[tabName];
    if (!data) return;

    // 更新tab状态
    $$('.compare-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.compare-tab[data-tab="${tabName}"]`).classList.add('active');

    // 更新信息
    $('#compare-info').textContent = `共 ${data.totalRows} 行 · ${data.headers.length} 列（预览前 ${data.rows.length} 行）`;

    // 渲染表格
    renderSpreadsheet(data.headers, data.rows);
}

function renderSpreadsheet(headers, rows) {
    const thead = $('#compare-spreadsheet thead');
    const tbody = $('#compare-spreadsheet tbody');

    // 表头（第一列为行号）
    thead.innerHTML = '<tr><th>#</th>' +
        headers.map(h => `<th title="${escapeHtml(h)}">${escapeHtml(h || '(空)')}</th>`).join('') +
        '</tr>';

    // 数据行
    tbody.innerHTML = rows.map((row, i) => {
        const cells = headers.map(h => {
            const val = row[h] || '';
            // 判断是否为数字
            const isNum = val !== '' && !isNaN(parseFloat(val)) && isFinite(val) &&
                !/^=/.test(val) && !/^https?:/.test(val);
            const displayVal = val.length > 80 ? val.substring(0, 80) + '...' : val;
            const cls = isNum ? ' class="num"' : '';
            return `<td${cls} title="${escapeHtml(val)}">${escapeHtml(displayVal)}</td>`;
        }).join('');
        return `<tr><td>${i + 1}</td>${cells}</tr>`;
    }).join('');

    // 重置滚动位置
    $('#spreadsheet-wrapper').scrollTop = 0;
    $('#spreadsheet-wrapper').scrollLeft = 0;
}

// ============================================================
// 重置
// ============================================================
async function resetAll() {
    try { await api('/api/reset', { method: 'POST' }); } catch (e) { /* ignore */ }

    state.sourceReady = false;
    state.referenceReady = false;
    state.mappings = [];
    state.targetOptions = [];
    state.sourceHeaders = [];
    state.outputName = '';

    $('#source-file').value = '';
    $('#reference-file').value = '';
    show($('#source-dropzone'));
    hide($('#source-info'));
    show($('#reference-dropzone'));
    hide($('#reference-info'));
    hide($('#section-match'));
    hide($('#section-preview'));
    hide($('#section-download'));
    hide($('#section-compare'));
    hide($('#match-status'));
    hide($('#convert-status'));
    $('#match-status').className = 'match-status';
    $('#convert-status').className = 'convert-status';

    updateSteps(1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================
// 辅助
// ============================================================
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    setupUpload('source-upload', 'source-file', 'source-info', 'source-filename', 'source-meta', 'source');
    setupUpload('reference-upload', 'reference-file', 'reference-info', 'reference-filename', 'reference-meta', 'reference');

    // AI 开关变化时清除旧匹配
    $('#use-ai').addEventListener('change', () => {
        hide($('#section-preview'));
        hide($('#section-download'));
        hide($('#section-compare'));
        state.mappings = [];
        updateSteps(2);
    });
});
