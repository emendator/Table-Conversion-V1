/**
 * 转换完成弹窗
 *
 * 点击「开始转换」且转换成功后自动弹出，提示用户转换完成，
 * 并在弹窗底部提供「下载转换结果」按钮。
 *
 * Props:
 *   open:         是否显示
 *   outputName:   输出文件名（展示 + 下载）
 *   downloading:  下载中的 loading 状态
 *   imageWarning: .xls 图片位置错位提醒（后端 imageWarning，可为 null）
 *   onDownload(): 下载结果文件
 *   onReset():    转换新文件（重置会话，回到上传步骤）
 *   onClose():    关闭弹窗
 */
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'

const EASE = [0.16, 1, 0.3, 1]

/** 成功对勾：圆环描边 + 对勾描边 依次绘制 */
function SuccessCheck() {
    return (
        <div className="done-icon" aria-hidden="true">
            <svg viewBox="0 0 64 64" fill="none">
                <defs>
                    <linearGradient id="done-ring-g" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#34D399" />
                        <stop offset="1" stopColor="#10B981" />
                    </linearGradient>
                </defs>
                <motion.circle
                    cx="32" cy="32" r="26"
                    stroke="url(#done-ring-g)"
                    strokeWidth="4.5"
                    strokeLinecap="round"
                    initial={{ pathLength: 0, rotate: -90 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.65, ease: EASE }}
                    style={{ transformOrigin: '50% 50%' }}
                />
                <motion.path
                    d="M20 33 L28.5 41.5 L45 24"
                    stroke="#fff"
                    strokeWidth="5.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ delay: 0.5, duration: 0.38, ease: EASE }}
                />
            </svg>
        </div>
    )
}

export default function ConvertCompleteModal({ open, outputName, downloading, imageWarning, onDownload, onReset, onClose }) {
    if (!open) return null
    return createPortal(
        <div className="done-modal-overlay" onClick={onClose}>
            <div className="done-modal" onClick={e => e.stopPropagation()}>
                <div className="done-modal-header">
                    <h3>✅ 转换完成</h3>
                    <button className="done-modal-close" onClick={onClose} aria-label="关闭">✕</button>
                </div>
                <div className="done-modal-body">
                    <SuccessCheck />
                    <p>表格转换成功！请下载转换结果文件：</p>
                    <div className="done-modal-file">
                        <span className="file-icon">📁</span>
                        <span className="done-modal-name" title={outputName}>{outputName}</span>
                    </div>
                    {imageWarning && (
                        <div className="done-modal-warning" role="alert">
                            <strong>⚠️ 图片位置可能错位</strong>
                            <p>{imageWarning.message}</p>
                            <p className="done-modal-warning-meta">
                                涉及文件：{(imageWarning.files || []).join('、')} · {imageWarning.imageCount || 0} 张图片按顺序放置
                            </p>
                        </div>
                    )}
                </div>
                <div className="done-modal-actions">
                    <button className="btn btn-success btn-lg" disabled={downloading} onClick={onDownload}>
                        {downloading ? '下载中...' : '📥 下载转换结果'}
                    </button>
                    <button className="btn btn-primary" disabled={downloading} onClick={onReset}>🔄 转换新文件</button>
                    <button className="btn btn-ghost" disabled={downloading} onClick={onClose}>关闭</button>
                </div>
            </div>
        </div>,
        document.body
    )
}
