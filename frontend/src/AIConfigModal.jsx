import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * DeepSeek API 设置弹窗
 *
 * - 展示当前 API Key（掩码）与当前 Key 累计消耗的 token
 * - 允许输入 / 更换 API Key，保存后由父组件加密上传到后端
 * - forced=true 时（未配置 Key），禁止关闭，强制用户填写
 *
 * Props:
 *   open:       是否显示
 *   forced:     是否强制（无 Key 时不可取消）
 *   hasKey:     当前是否已配置 Key
 *   maskedKey:  当前 Key 的掩码显示
 *   totalTokens:当前 Key 累计消耗 token
 *   saving:     保存中的 loading
 *   onSave(apiKey): 保存回调
 *   onClose():      关闭回调（forced 时不生效）
 */
export default function AIConfigModal({ open, forced, hasKey, maskedKey, totalTokens, saving, onSave, onClose }) {
    const [apiKey, setApiKey] = useState('')

    // 打开时清空输入框
    useEffect(() => {
        if (open) setApiKey('')
    }, [open])

    if (!open) return null

    const canSave = apiKey.trim().startsWith('sk-') && !saving

    return createPortal(
        <div className="ai-modal-overlay">
            <div className="ai-modal">
                <div className="ai-modal-header">
                    <h3>⚙️ DeepSeek API 设置</h3>
                    {!forced && (
                        <button className="ai-modal-close" onClick={onClose} aria-label="关闭">✕</button>
                    )}
                </div>

                {forced && (
                    <p className="ai-modal-warn">
                        ⚠️ 尚未配置 DeepSeek API Key。使用「AI 匹配」前必须填写你的 API Key。
                    </p>
                )}

                <div className="ai-modal-status">
                    <div className="ai-status-item">
                        <span className="ai-status-label">当前 Key</span>
                        <span className="ai-status-value">
                            {hasKey
                                ? <span className="ai-key-masked">🔑 {maskedKey || '(已配置)'}</span>
                                : <span className="ai-key-none">未配置</span>}
                        </span>
                    </div>
                    <div className="ai-status-item">
                        <span className="ai-status-label">当前 Key 累计消耗</span>
                        <span className="ai-status-value">
                            {totalTokens > 0 ? `${totalTokens.toLocaleString()} tokens` : '0 tokens'}
                        </span>
                    </div>
                </div>

                <div className="ai-modal-field">
                    <label>新的 API Key{hasKey ? '（留空则保持不变）' : ''}</label>
                    <input
                        type="password"
                        autoComplete="off"
                        placeholder="sk-..."
                        value={apiKey}
                        onChange={e => setApiKey(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && canSave) onSave(apiKey.trim()) }}
                    />
                    {apiKey.trim() && !apiKey.trim().startsWith('sk-') && (
                        <span className="ai-field-error">API Key 应以 sk- 开头</span>
                    )}
                </div>

                <p className="ai-modal-foot">
                    🔒 你的 API Key 只保存在你自己的电脑上，页面不会明文展示。
                    token 消耗按账户独立统计。
                </p>

                <div className="ai-modal-actions">
                    <button className="btn btn-primary" disabled={!canSave} onClick={() => onSave(apiKey.trim())}>
                        {saving ? '保存中...' : (hasKey ? '💾 更新 API Key' : '💾 保存 API Key')}
                    </button>
                    {!forced && (
                        <button className="btn btn-ghost" disabled={saving} onClick={onClose}>取消</button>
                    )}
                </div>
            </div>
        </div>,
        document.body
    )
}
