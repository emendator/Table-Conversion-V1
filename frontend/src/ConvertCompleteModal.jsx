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
 *   onDownload(): 下载结果文件
 *   onReset():    转换新文件（重置会话，回到上传步骤）
 *   onClose():    关闭弹窗
 */
import { createPortal } from 'react-dom'

export default function ConvertCompleteModal({ open, outputName, downloading, onDownload, onReset, onClose }) {
    if (!open) return null
    return createPortal(
        <div className="done-modal-overlay" onClick={onClose}>
            <div className="done-modal" onClick={e => e.stopPropagation()}>
                <div className="done-modal-header">
                    <h3>✅ 转换完成</h3>
                    <button className="done-modal-close" onClick={onClose} aria-label="关闭">✕</button>
                </div>
                <div className="done-modal-body">
                    <div className="done-modal-icon">🎉</div>
                    <p>表格转换成功！请下载转换结果文件：</p>
                    <div className="done-modal-file">
                        <span className="file-icon">📁</span>
                        <span className="done-modal-name" title={outputName}>{outputName}</span>
                    </div>
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
