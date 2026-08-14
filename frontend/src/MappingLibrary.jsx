import { useState, useEffect, useCallback, useRef } from 'react'
import * as api from './api'
import DuplicateConfirmModal from './DuplicateConfirmModal'
import CollapsibleSection from './CollapsibleSection'

/**
 * 映射匹配库管理页面
 * 提供对映射匹配库的增删改查（CRUD）、多选批量操作、导入导出功能
 */

const SOURCE_LABELS = { ai: 'AI自动', manual: '手动', import: '导入' }

/** 标准化列名（与后端 _normalize_column_name 一致：仅去除换行/首尾空格） */
function norm(name) {
    return (name || '').replace(/\n/g, '').replace(/\r/g, '').trim()
}

export default function MappingLibrary({ onGoBack }) {
    const [records, setRecords] = useState([])
    const [loading, setLoading] = useState(false)
    const [search, setSearch] = useState('')
    const [msg, setMsg] = useState(null)
    // 编辑状态: null=非编辑; {id, source, target} 正在编辑的记录
    const [editing, setEditing] = useState(null)
    // 新增表单
    const [form, setForm] = useState({ source: '', target: '' })
    // 多选: 选中的记录 id 集合
    const [selected, setSelected] = useState(new Set())
    const importInputRef = useRef(null)
    // 重复确认弹窗状态: null 或 {title, hint, duplicates, resolve}
    // resolve(mode) 中 mode ∈ 'overwrite' | 'skip' | 'cancel'
    const [dupConfirm, setDupConfirm] = useState(null)
    const [dupProcessing, setDupProcessing] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        setMsg(null)
        try {
            const r = await api.getMappingLibrary()
            if (r.success) setRecords(r.records || [])
            else setMsg({ type: 'error', text: '加载失败：' + (r.error || '') + '，请刷新后重试' })
        } catch (e) { setMsg({ type: 'error', text: '网络请求失败：' + e.message + '，请检查网络连接后重试' }) }
        finally { setLoading(false) }
    }, [])

    useEffect(() => { load() }, [load])

    const showMsg = (type, text) => {
        setMsg({ type, text })
        setTimeout(() => setMsg(null), 2500)
    }

    // ========== 新增 ==========
    const doAdd = async (src, tgt, mode) => {
        setDupProcessing(true)
        try {
            const r = await api.addMappingRecord(src, tgt, mode)
            if (r.success) {
                if (r.action === 'skipped') showMsg('info', '⏭️ 已跳过：源列名已存在，未写入')
                else if (r.action === 'updated') showMsg('ok', '✅ 已覆盖更新同源列名的记录')
                else showMsg('ok', '✅ 已添加到映射匹配库')
                setForm({ source: '', target: '' })
                load()
            } else showMsg('error', '添加失败：' + (r.error || ''))
        } catch (e) { showMsg('error', '添加失败：' + e.message + '，请重试') }
        finally { setDupProcessing(false) }
    }

    const handleAdd = async () => {
        const src = form.source.trim()
        const tgt = form.target.trim()
        if (!src || !tgt) { showMsg('error', '请填写源列名和目标列名'); return }
        // 查重：仅以原始列名为准（标准化比较）
        const dup = records.find(r => norm(r.source_column) === norm(src))
        if (dup) {
            setDupConfirm({
                title: '⚠️ 源列名已存在',
                hint: `「${src}」已在映射匹配库中存在，目标列为「${dup.target_column}」。`,
                duplicates: [{ source: src, target: tgt, existing_target: dup.target_column }],
                resolve: (mode) => {
                    setDupConfirm(null)
                    if (mode === 'cancel') return
                    doAdd(src, tgt, mode)
                },
            })
            return
        }
        doAdd(src, tgt, 'overwrite')
    }

    // ========== 编辑 ==========
    const startEdit = (rec) => {
        setEditing({ id: rec.id, source: rec.source_column, target: rec.target_column })
    }

    const cancelEdit = () => setEditing(null)

    const handleSaveEdit = async () => {
        if (!editing) return
        if (!editing.source.trim() || !editing.target.trim()) { showMsg('error', '请填写源列名和目标列名'); return }
        const src = editing.source.trim()
        const tgt = editing.target.trim()
        // 查重：修改后的源列名若与其他记录（非本条）重复，需用户确认
        const dup = records.find(r => r.id !== editing.id && norm(r.source_column) === norm(src))
        const doUpdate = async (mode) => {
            try {
                const r = await api.updateMappingRecord(editing.id, src, tgt)
                if (r.success) {
                    showMsg('ok', '✅ 已更新')
                    setEditing(null)
                    load()
                } else showMsg('error', '更新失败：' + (r.error || ''))
            } catch (e) { showMsg('error', '更新失败：' + e.message + '，请重试') }
        }
        if (dup) {
            setDupConfirm({
                title: '⚠️ 源列名与其他记录重复',
                hint: `修改后的源列名「${src}」与另一条记录重复（其目标列为「${dup.target_column}」）。`,
                duplicates: [{ source: src, target: tgt, existing_target: dup.target_column }],
                resolve: (mode) => {
                    setDupConfirm(null)
                    if (mode === 'cancel') return
                    // 覆盖 = 直接保存（后端 update 按 source 唯一，会覆盖同源列记录）
                    // 跳过 = 放弃本次修改
                    if (mode === 'overwrite') doUpdate('overwrite')
                    else showMsg('info', '⏭️ 已跳过，未修改')
                },
            })
            return
        }
        doUpdate('overwrite')
    }

    // ========== 删除 ==========
    const handleDelete = async (rec) => {
        if (!confirm(`确定删除映射「${rec.source_column} → ${rec.target_column}」？`)) return
        try {
            const r = await api.deleteMappingRecord(rec.id)
            if (r.success) {
                showMsg('ok', '🗑️ 已删除')
                load()
            } else showMsg('error', '删除失败：' + (r.error || ''))
        } catch (e) { showMsg('error', '删除失败：' + e.message + '，请重试') }
    }

    const handleClearAll = async () => {
        if (!confirm(`确定清空映射匹配库？\n全部 ${records.length} 条记录将被删除，且无法恢复。`)) return
        try {
            const r = await api.clearMappingLibrary()
            if (r.success) {
                showMsg('ok', `🗑️ 已清空 ${r.deleted} 条记录`)
                setSelected(new Set())
                load()
            }
        } catch (e) { showMsg('error', '清空失败：' + e.message + '，请重试') }
    }

    // ========== 多选 ==========
    const toggleSelect = (id) => {
        setSelected(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const filtered = search.trim()
        ? records.filter(r => {
            const kw = search.trim().toLowerCase()
            return (r.source_column || '').toLowerCase().includes(kw) ||
                (r.target_column || '').toLowerCase().includes(kw)
        })
        : records

    const allSelected = filtered.length > 0 && filtered.every(r => selected.has(r.id))

    const toggleSelectAll = () => {
        if (allSelected) setSelected(new Set())
        else setSelected(new Set(filtered.map(r => r.id)))
    }

    const handleBatchDelete = async () => {
        const ids = Array.from(selected)
        if (!ids.length) return
        if (!confirm(`将删除选中的 ${ids.length} 条映射记录，删除后无法恢复。确定继续？`)) return
        try {
            const r = await api.batchDeleteMappingRecords(ids)
            if (r.success) {
                showMsg('ok', `🗑️ 已删除 ${r.deleted} 条记录`)
                setSelected(new Set())
                load()
            } else showMsg('error', '批量删除失败：' + (r.error || ''))
        } catch (e) { showMsg('error', '批量删除失败：' + e.message + '，请重试') }
    }

    // ========== 导出（Excel 表格） ==========
    const handleExport = async () => {
        try {
            await api.exportMappingLibrary()
            showMsg('ok', `📤 已导出 Excel 表格（${records.length} 条记录）`)
        } catch (e) { showMsg('error', '导出失败: ' + e.message) }
    }

    // ========== 导入（Excel / CSV 表格） ==========
    const handleImportFile = async (file) => {
        if (!file) return
        try {
            // 后端解析表格文件，返回映射记录
            const parsed = await api.parseMappingImportFile(file)
            if (!parsed.success) { showMsg('error', '解析失败: ' + (parsed.detail || '')); return }
            const recordsToImport = parsed.records || []
            if (!recordsToImport.length) { showMsg('error', '文件中没有有效的映射记录'); return }

            // 询问导入模式：覆盖 或 合并
            const mode = confirm(
                `从表格中解析出 ${recordsToImport.length} 条映射记录。\n\n点击「确定」= 覆盖现有库\n点击「取消」= 合并到现有库`
            ) ? 'replace' : 'merge'

            if (mode === 'replace') {
                // 覆盖模式：清空后导入，无需查重
                const res = await api.importMappingLibrary(recordsToImport, 'replace', 'overwrite')
                if (res.success) {
                    showMsg('ok', `📥 已导入 ${res.imported} 条记录（覆盖模式）`)
                    setSelected(new Set())
                    load()
                } else showMsg('error', '导入失败: ' + (res.error || ''))
                return
            }

            // 合并模式：先查重（仅以源列名为准），有重复则让用户确认处理方式
            const check = await api.checkMappingDuplicates(recordsToImport)
            const duplicates = (check && check.duplicates) || []
            if (duplicates.length > 0) {
                setDupConfirm({
                    title: '⚠️ 导入存在重复数据',
                    hint: `待导入的 ${recordsToImport.length} 条记录中，有 ${duplicates.length} 条源列名已存在于映射匹配库。`,
                    duplicates,
                    resolve: async (mode, selectedDups) => {
                        setDupConfirm(null)
                        if (mode === 'cancel') { showMsg('info', '已取消导入'); return }
                        setDupProcessing(true)
                        try {
                            const res = await api.importMappingLibrary(recordsToImport, 'merge', mode)
                            if (res.success) {
                                showMsg('ok', `📥 已导入 ${res.imported} 条记录（${mode === 'skip' ? '跳过重复' : '覆盖重复'}模式）`)
                                setSelected(new Set())
                                load()
                            } else showMsg('error', '导入失败: ' + (res.error || ''))
                        } catch (e) { showMsg('error', '导入失败: ' + e.message) }
                        finally { setDupProcessing(false) }
                    },
                })
                return
            }

            // 无重复：直接合并导入
            const res = await api.importMappingLibrary(recordsToImport, 'merge', 'overwrite')
            if (res.success) {
                showMsg('ok', `📥 已导入 ${res.imported} 条记录（合并模式）`)
                setSelected(new Set())
                load()
            } else showMsg('error', '导入失败: ' + (res.error || ''))
        } catch (e) {
            showMsg('error', '导入失败，请确认是有效的 Excel/CSV 表格文件')
        } finally {
            if (importInputRef.current) importInputRef.current.value = ''
        }
    }

    const selectedCount = selected.size

    return (
        <div className="library-page">
            <div className="library-header">
                <h2><span aria-hidden="true">📚</span> <span className="page-title-text">映射匹配库</span></h2>
                <p className="section-hint">
                    管理列名映射记录。匹配时优先按此库中的记录匹配，AI 只处理剩余的列。
                    未修改的 AI 匹配结果与勾选了「加入库」的映射会自动存入此库。
                </p>
            </div>

            {msg && <div className={`match-status ${msg.type === 'ok' ? 'success' : msg.type}`}>{msg.text}</div>}

            {/* 新增表单 */}
            <CollapsibleSection title="➕ 新增映射记录" summary="填写源列名与目标列名，一键存入映射匹配库">
                <div className="library-add-row">
                    <input
                        className="lib-input"
                        placeholder="源列名（客户表格列名）"
                        value={form.source}
                        onChange={e => setForm({ ...form, source: e.target.value })}
                    />
                    <span className="lib-arrow">→</span>
                    <input
                        className="lib-input"
                        placeholder="目标列名（参考表格列名）"
                        value={form.target}
                        onChange={e => setForm({ ...form, target: e.target.value })}
                    />
                    <button className="btn btn-primary" onClick={handleAdd}>添加</button>
                </div>
            </CollapsibleSection>

            {/* 列表 */}
            <CollapsibleSection title="📋 映射记录列表" summary={`${records.length} 条记录`}>
                <div className="library-toolbar">
                    <input
                        className="lib-search"
                        placeholder="🔍 搜索源列名 / 目标列名..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                    />
                    <span className="library-count">共 {records.length} 条记录</span>
                    <button className="btn btn-sm btn-outline" onClick={handleExport}>📤 导出</button>
                    <button className="btn btn-sm btn-outline" onClick={() => importInputRef.current?.click()}>📥 导入</button>
                    <input ref={importInputRef} type="file" accept=".xlsx,.xls,.csv" hidden
                        onChange={e => handleImportFile(e.target.files[0])} />
                    {records.length > 0 && (
                        <button className="btn btn-sm btn-danger" onClick={handleClearAll}>清空全部</button>
                    )}
                </div>

                {selectedCount > 0 && (
                    <div className="batch-bar">
                        <span>已选中 <b>{selectedCount}</b> 条记录</span>
                        <button className="btn btn-sm btn-danger" onClick={handleBatchDelete}>🗑️ 批量删除</button>
                        <button className="btn btn-sm btn-outline" onClick={() => setSelected(new Set())}>取消选择</button>
                    </div>
                )}

                <div className="mapping-table-wrap">
                    <table className="mapping-table">
                        <thead>
                            <tr>
                                <th className="col-check">
                                    <input
                                        type="checkbox"
                                        checked={allSelected}
                                        onChange={toggleSelectAll}
                                        title="全选 / 取消全选"
                                    />
                                </th>
                                <th className="col-idx">#</th>
                                <th className="col-src">源列名</th>
                                <th className="col-arrow" />
                                <th className="col-tgt">目标列名</th>
                                <th className="col-source">来源</th>
                                <th className="col-count">使用次数</th>
                                <th className="col-time">最近使用</th>
                                <th className="col-act">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr>
                                    <td colSpan={9} className="skeleton-cell">
                                        {Array.from({ length: 4 }).map((_, k) => (
                                            <div key={k} className="skeleton-line"
                                                style={{ animationDelay: `${k * 0.12}s` }} />
                                        ))}
                                    </td>
                                </tr>
                            ) : filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={9} style={{ padding: 0 }}>
                                        <div className="empty-state">
                                            <div className="empty-icon">{search ? '🔍' : '🗂️'}</div>
                                            <p className="empty-title">
                                                {search ? '没有匹配的搜索结果' : '映射库还是空的'}
                                            </p>
                                            <p className="empty-hint">
                                                {search
                                                    ? `换个关键词试试 —— 当前共 ${records.length} 条记录。`
                                                    : '在上方「新增映射记录」中填写源列名与目标列名，或让 AI 匹配结果一键入库；也支持从 Excel / CSV 快速导入。'}
                                            </p>
                                        </div>
                                    </td>
                                </tr>
                            ) : filtered.map((r, i) => (
                                <tr key={r.id || i} className={selected.has(r.id) ? 'row-selected' : ''}>
                                    <td className="col-check">
                                        <input
                                            type="checkbox"
                                            checked={selected.has(r.id)}
                                            onChange={() => toggleSelect(r.id)}
                                        />
                                    </td>
                                    <td className="col-idx">{i + 1}</td>
                                    {editing && editing.id === r.id ? (
                                        <>
                                            <td className="col-src">
                                                <input className="lib-input lib-input-inline" value={editing.source}
                                                    onChange={e => setEditing({ ...editing, source: e.target.value })} />
                                            </td>
                                            <td className="col-arrow">→</td>
                                            <td className="col-tgt">
                                                <input className="lib-input lib-input-inline" value={editing.target}
                                                    onChange={e => setEditing({ ...editing, target: e.target.value })} />
                                            </td>
                                            <td className="col-source"><SourceBadge source={r.source} /></td>
                                            <td className="col-count">{r.use_count || 0}</td>
                                            <td className="col-time">{(r.last_used || '').replace('T', ' ').slice(0, 16)}</td>
                                            <td className="col-act lib-actions">
                                                <button className="btn btn-sm btn-primary" onClick={handleSaveEdit}>保存</button>
                                                <button className="btn btn-sm btn-outline" onClick={cancelEdit}>取消</button>
                                            </td>
                                        </>
                                    ) : (
                                        <>
                                            <td className="col-src" title={r.source_column}>{r.source_column}</td>
                                            <td className="col-arrow">→</td>
                                            <td className="col-tgt" title={r.target_column}>{r.target_column}</td>
                                            <td className="col-source"><SourceBadge source={r.source} /></td>
                                            <td className="col-count"><span className="count-badge">{r.use_count || 0}</span></td>
                                            <td className="col-time">{(r.last_used || '').replace('T', ' ').slice(0, 16)}</td>
                                            <td className="col-act lib-actions">
                                                <button className="btn btn-sm btn-outline" onClick={() => startEdit(r)}>✏️ 编辑</button>
                                                <button className="btn btn-sm btn-danger" onClick={() => handleDelete(r)}>🗑️ 删除</button>
                                            </td>
                                        </>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </CollapsibleSection>

            <div className="action-bar-secondary">
                <button className="btn btn-primary" onClick={onGoBack}>← 返回转换工具</button>
            </div>

            {/* 重复数据处理确认弹窗 */}
            {dupConfirm && (
                <DuplicateConfirmModal
                    title={dupConfirm.title}
                    hint={dupConfirm.hint}
                    duplicates={dupConfirm.duplicates}
                    processing={dupProcessing}
                    onConfirm={(mode, selectedDups) => dupConfirm.resolve(mode, selectedDups)}
                />
            )}
        </div>
    )
}

/** 来源标签徽章 */
function SourceBadge({ source }) {
    const label = SOURCE_LABELS[source] || '—'
    const cls = source === 'ai' ? 'src-ai' : source === 'import' ? 'src-import' : 'src-manual'
    return <span className={`source-badge ${cls}`}>{label}</span>
}
