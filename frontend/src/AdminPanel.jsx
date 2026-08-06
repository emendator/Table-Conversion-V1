import { useState, useEffect, useCallback } from 'react'
import * as api from './api'

const ROLE_LABELS = { admin: '最高级管理员', manager: '管理员', user: '用户' }

/** 格式化本地日期为 YYYY-MM-DD */
const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** 默认有效期截止日期 = 今天 + 7 天 */
const defaultExpire = () => {
    const d = new Date()
    d.setDate(d.getDate() + 7)
    return fmtDate(d)
}

/**
 * 用户管理面板（最高级管理员 / 管理员）
 * - 邀请码：生成（admin 可发管理员/用户邀请；manager 仅用户）、列表、延长
 * - 账号：列表（注册时间/最后登录时间/过期时间）、延长、清除（admin 清除 manager 时级联）
 */
export default function AdminPanel({ user, onGoBack }) {
    const [invites, setInvites] = useState([])
    const [users, setUsers] = useState([])
    const [loading, setLoading] = useState(false)
    const [msg, setMsg] = useState(null)
    const [invLevel, setInvLevel] = useState(2)
    const [invExpire, setInvExpire] = useState(defaultExpire())
    const [newInvite, setNewInvite] = useState(null)
    // 公司数据库密码（映射库隔离凭证）
    const [companyInfo, setCompanyInfo] = useState(null)
    const [newCompanyPwd, setNewCompanyPwd] = useState('')

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const [iv, us, ci] = await Promise.all([api.listInvites(), api.listAdminUsers(), api.getCompanyInfo()])
            if (iv.success) setInvites(iv.invites || [])
            if (us.success) setUsers(us.users || [])
            if (ci.success) setCompanyInfo(ci)
        } catch (e) { /* 网络失败保持现状 */ }
        finally { setLoading(false) }
    }, [])

    useEffect(() => { load() }, [load])

    const showMsg = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000) }

    const handleGenerate = async () => {
        setNewInvite(null)
        const res = await api.generateInvite(invLevel, invExpire)
        if (res.success) {
            setNewInvite(res)
            showMsg('ok', '邀请码已生成')
            load()
        } else showMsg('error', res.detail || res.message || '生成失败')
    }

    const handleDeleteInvite = async (iv) => {
        const tip = iv.used
            ? `确认删除已使用的邀请码「${iv.code}」？（仅清理记录）`
            : `确认删除邀请码「${iv.code}」？删除后该邀请码将不可使用。`
        if (!window.confirm(tip)) return
        const res = await api.deleteInvite(iv.code)
        if (res.success) showMsg('ok', res.message || '已删除')
        else showMsg('error', res.detail || res.message || '删除失败')
        load()
    }

    const handleExtendUser = async (u) => {
        const cur = u.expires_at ? u.expires_at.slice(0, 10) : ''
        const input = window.prompt(
            `为账号「${u.username}」设置新的有效期截止日期（YYYY-MM-DD，留空 = 永久）：\n当前有效期：${u.expires_at || '永久'}`,
            cur
        )
        if (input === null) return
        const res = await api.extendAdminUser(u.id, input.trim())
        if (res.success) showMsg('ok', res.message || '已设置有效期')
        else showMsg('error', res.detail || res.message || '设置失败')
        load()
    }

    const handleDisable = async (u) => {
        const tip = u.role === 'manager'
            ? `⚠️ 清除管理员「${u.username}」将同步清除其下关联的所有用户账号，确定？`
            : `确认清除账号「${u.username}」？`
        if (!window.confirm(tip)) return
        const res = await api.disableAdminUser(u.id)
        if (res.success) showMsg('ok', res.message || '已清除')
        else showMsg('error', res.detail || res.message || '清除失败')
        load()
    }

    const handleSetCompanyPwd = async () => {
        if (newCompanyPwd.trim().length < 6) { showMsg('error', '公司数据库密码至少 6 位'); return }
        const res = await api.updateCompanyPassword(newCompanyPwd.trim(), '')
        if (res.success) {
            showMsg('ok', res.message || '已更新')
            setNewCompanyPwd('')
            load()
        } else showMsg('error', res.detail || res.message || '更新失败')
    }

    return (
        <div className="admin-panel">
            <div className="admin-header">
                <h2>👥 用户与邀请码管理</h2>
                <button className="btn btn-outline" onClick={onGoBack}>← 返回转换工具</button>
            </div>

            {msg && <div className={`match-status ${msg.type === 'ok' ? 'success' : msg.type}`}>{msg.text}</div>}
            {loading && <div className="admin-loading">加载中...</div>}

            {/* ===== 邀请码管理 ===== */}
            <section className="card admin-section">
                <h3>🎫 邀请码管理</h3>
                <div className="admin-invite-form">
                    <label>角色
                        <select value={invLevel} onChange={e => setInvLevel(Number(e.target.value))} disabled={user.role !== 'admin'}>
                            <option value={2}>用户</option>
                            {user.role === 'admin' && <option value={1}>管理员</option>}
                        </select>
                    </label>
                    <label>账户有效期至
                        <input type="date" value={invExpire} onChange={e => setInvExpire(e.target.value)} />
                        <span style={{ fontSize: 12, color: '#94A3B8' }}>留空 = 永久</span>
                    </label>
                    <button className="btn btn-primary" onClick={handleGenerate}>生成邀请码</button>
                </div>

                {newInvite && (
                    <div className="admin-new-invite">
                        🎉 新邀请码：<b>{newInvite.code}</b>
                        <span>（{newInvite.level === 1 ? '管理员' : '用户'} · 注册账户有效期至 {newInvite.expires_at || '永久'}）</span>
                        <span className="admin-copy-tip">请复制并分发给需要注册的人，绑定后即作废</span>
                    </div>
                )}

                <div className="admin-table-wrap">
                    <table className="admin-table">
                        <thead>
                            <tr>
                                <th>邀请码</th><th>角色</th><th>创建者</th><th>状态</th>
                                <th>绑定账号</th><th>创建时间</th><th>账户有效期</th><th>操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {invites.length === 0 ? (
                                <tr><td colSpan={8} style={{ textAlign: 'center', color: '#94A3B8', padding: 16 }}>暂无邀请码</td></tr>
                            ) : invites.map((iv, i) => (
                                <tr key={i}>
                                    <td><code className="admin-code">{iv.code}</code></td>
                                    <td>{iv.level === 1 ? '管理员' : '用户'}</td>
                                    <td>{iv.creator}</td>
                                    <td>{iv.used ? <span className="badge-used">已使用</span> : <span className="badge-unused">未使用</span>}</td>
                                    <td>{iv.used_by || '—'}</td>
                                    <td>{iv.created_at}</td>
                                    <td>{iv.expires_at ? `至 ${iv.expires_at}` : (iv.valid_days ? `注册后 ${iv.valid_days} 天` : '永久')}</td>
                                    <td className="admin-actions">
                                        <button className="btn btn-sm btn-danger" onClick={() => handleDeleteInvite(iv)}>删除</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {/* ===== 账号管理 ===== */}
            <section className="card admin-section">
                <h3>👤 账号管理</h3>
                <div className="admin-table-wrap">
                    <table className="admin-table">
                        <thead>
                            <tr>
                                <th>用户名</th><th>角色</th><th>公司</th><th>邮箱</th>
                                <th>注册时间</th><th>最后登录</th><th>过期时间</th><th>状态</th><th>操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.length === 0 ? (
                                <tr><td colSpan={9} style={{ textAlign: 'center', color: '#94A3B8', padding: 16 }}>暂无账号</td></tr>
                            ) : users.map((u) => (
                                <tr key={u.id} className={u.username === 'admin' ? 'admin-row' : ''}>
                                    <td><b>{u.username}</b></td>
                                    <td>{ROLE_LABELS[u.role] || u.role}</td>
                                    <td>{u.company}</td>
                                    <td>{u.email || '—'}</td>
                                    <td>{u.created_at}</td>
                                    <td>{u.last_login_at || '—'}</td>
                                    <td>{u.expires_at || '永久'}</td>
                                    <td>
                                        {u.expires_at && new Date(u.expires_at) < new Date()
                                            ? <span className="badge-used">已过期</span>
                                            : (u.status === 'active'
                                                ? <span className="badge-unused">正常</span>
                                                : <span className="badge-used">禁用</span>)}
                                    </td>
                                    <td className="admin-actions">
                                        {u.username !== 'admin' && (
                                            <>
                                                <button className="btn btn-sm btn-outline" onClick={() => handleExtendUser(u)}>延长</button>
                                                <button className="btn btn-sm btn-danger" onClick={() => handleDisable(u)}>清除</button>
                                            </>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {/* ===== 公司数据库密码（映射库隔离凭证） ===== */}
            <section className="card admin-section">
                <h3>🔐 公司数据库密码（映射库隔离凭证）</h3>
                <p className="section-hint">
                    映射库按「公司名 + 公司数据库密码」隔离。新用户加入本公司时需填写正确的公司数据库密码；
                    公司名不存在时，仅管理员可创建新公司并设置密码。
                </p>
                <div className="admin-invite-form">
                    <span className="company-pwd-status">
                        {companyInfo?.is_set
                            ? `✅ 已设置（创建于 ${companyInfo.created_at} · 最近修改 ${companyInfo.updated_at}）`
                            : '⚠️ 尚未设置公司数据库密码'}
                    </span>
                </div>
                <div className="admin-invite-form">
                    <label>新密码
                        <input type="password" value={newCompanyPwd}
                            onChange={e => setNewCompanyPwd(e.target.value)}
                            placeholder="至少 6 位" />
                    </label>
                    <button className="btn btn-primary"
                        onClick={handleSetCompanyPwd}
                        disabled={newCompanyPwd.trim().length < 6}>
                        💾 创建 / 修改公司数据库密码
                    </button>
                </div>
                <p className="section-hint">
                    修改后，本公司所有用户的访问键将同步更新、映射库数据自动迁移，
                    请将新密码告知公司成员；修改前请确认已知晓新密码。
                </p>
            </section>
        </div>
    )
}
