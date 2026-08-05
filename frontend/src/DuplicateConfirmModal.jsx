import { useState } from 'react'

/**
 * 重复数据处理确认弹窗
 *
 * 当需要向映射库写入记录，但检测到「源列名已存在」的重复数据时，
 * 弹出此弹窗让用户选择处理方式：覆盖 / 跳过 / 取消。
 *
 * 查重规则：仅以原始列名（source）为准，原始列相同即视为重复。
 *
 * Props:
 *   - title:    弹窗标题
 *   - hint:     提示文案（可选）
 *   - duplicates: [{source, target, existing_target, ...}]
 *   - onConfirm(mode): 用户选择 'overwrite' | 'skip' | 'cancel'
 *   - processing: 提交中的 loading 状态
 */
export default function DuplicateConfirmModal({ title, hint, duplicates, onConfirm, processing }) {
    const [checked, setChecked] = useState({})
    const [scope, setScope] = useState('all') // all | selected

    if (!duplicates || duplicates.length === 0) return null

    // 若存在可单独勾选的模式，用于「仅处理选中的重复项」
    const toggle = (idx) => {
        setChecked(prev => ({ ...prev, [idx]: !prev[idx] }))
    }

    const selectedDups = scope === 'all'
        ? duplicates
        : duplicates.filter((_, i) => checked[i])

    return (
        <div className="dup-modal-overlay">
            <div className="dup-modal">
                <h3>{title || '⚠️ 检测到重复数据'}</h3>
                {hint && <p className="dup-modal-hint">{hint}</p>}
                <p className="dup-modal-desc">
                    以下 <b>{duplicates.length}</b> 条记录的<b>原始列名</b>已存在于映射匹配库中：
                </p>

                <div className="dup-modal-list">
                    {duplicates.map((d, i) => (
                        <div key={i} className="dup-modal-item">
                            {duplicates.length > 1 && (
                                <label className="dup-modal-check" title="仅对勾选项执行处理">
                                    <input type="checkbox" checked={!!checked[i]}
                                        onChange={() => toggle(i)} />
                                </label>
                            )}
                            <div className="dup-modal-cols">
                                <div className="dup-modal-src" title={d.source}>
                                    <span className="dup-label">原始列</span>
                                    <b>{d.source}</b>
                                </div>
                                <div className="dup-modal-arrow">→</div>
                                <div className="dup-modal-tgt">
                                    <span className="dup-label">新目标</span>
                                    <b>{d.target || '(空)'}</b>
                                    <span className="dup-modal-exist">
                                        库中已有: {d.existing_target || '(空)'}
                                    </span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {duplicates.length > 1 && (
                    <div className="dup-modal-scope">
                        <label>
                            <input type="radio" name="dup-scope" checked={scope === 'all'}
                                onChange={() => setScope('all')} />
                            处理全部 {duplicates.length} 条
                        </label>
                        <label>
                            <input type="radio" name="dup-scope" checked={scope === 'selected'}
                                onChange={() => setScope('selected')} />
                            仅处理勾选的 {selectedDups.length} 条
                        </label>
                    </div>
                )}

                <div className="dup-modal-actions">
                    <button className="btn btn-primary"
                        disabled={processing || selectedDups.length === 0}
                        onClick={() => onConfirm('overwrite', selectedDups)}>
                        ✅ 覆盖{selectedDups.length > 0 && selectedDups.length < duplicates.length
                            ? ` (${selectedDups.length})` : ''}
                    </button>
                    <button className="btn btn-outline"
                        disabled={processing || selectedDups.length === 0}
                        onClick={() => onConfirm('skip', selectedDups)}>
                        ⏭️ 跳过{selectedDups.length > 0 && selectedDups.length < duplicates.length
                            ? ` (${selectedDups.length})` : ''}
                    </button>
                    <button className="btn btn-ghost" disabled={processing}
                        onClick={() => onConfirm('cancel', [])}>
                        取消
                    </button>
                </div>
                <p className="dup-modal-foot">
                    覆盖 = 用新记录替换库中同源列名的旧记录；跳过 = 保留库中原记录，不写入。
                </p>
            </div>
        </div>
    )
}
