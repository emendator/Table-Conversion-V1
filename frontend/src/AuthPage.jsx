import { useState } from 'react'
import * as api from './api'

/**
 * 登录 / 注册页面
 * - 登录：用户名 + 密码
 * - 注册：用户名 + 密码 + 确认密码 + 邮箱 + 邀请码 + 公司名称
 * 成功后自动登录并回调 onAuthSuccess(user)
 */
export default function AuthPage({ onAuthSuccess }) {
    const [mode, setMode] = useState('login')   // 'login' | 'register'
    // 注册时的公司归属：'new'=新注册公司（创建） 'login'=登录已有公司（加入）
    const [registerMode, setRegisterMode] = useState('new')
    const [form, setForm] = useState({ username: '', password: '', confirm: '', email: '', invite_code: '', company: '', company_db_password: '' })
    const [error, setError] = useState('')
    const [expired, setExpired] = useState(false)
    const [loading, setLoading] = useState(false)

    const setField = (key) => (e) => setForm({ ...form, [key]: e.target.value })

    const handleGuest = async () => {
        setError('')
        setLoading(true)
        try {
            const res = await api.guestLogin()
            if (res.success) {
                api.setToken(res.token)
                api.setStoredUser(res.user)
                onAuthSuccess(res.user)
            } else {
                setError(res.detail || res.message || '游客登录失败')
            }
        } catch (err) { setError('网络错误: ' + err.message) }
        finally { setLoading(false) }
    }

    const handleSubmit = async (e) => {
        e.preventDefault()
        setError('')
        setExpired(false)

        if (mode === 'login') {
            if (!form.username.trim() || !form.password) { setError('请输入用户名和密码'); return }
            setLoading(true)
            try {
                const res = await api.login({ username: form.username.trim(), password: form.password })
                if (res.success) {
                    api.setToken(res.token)
                    api.setStoredUser(res.user)
                    onAuthSuccess(res.user)
                } else {
                    // 兼容 detail 为字符串（普通错误）或对象（结构化错误，如「账户已过期」）
                    const detail = res.detail
                    setExpired(!!(detail && typeof detail === 'object' && detail.code === 'ACCOUNT_EXPIRED'))
                    setError(typeof detail === 'object' ? (detail.message || '登录失败') : (detail || res.message || '登录失败'))
                }
            } catch (err) { setError('网络错误: ' + err.message) }
            finally { setLoading(false) }
            return
        }

        // 注册
        if (!form.username.trim() || !form.password || !form.email.trim() || !form.invite_code.trim()
            || !form.company.trim() || !form.company_db_password.trim()) {
            setError('请填写完整信息（用户名、密码、邮箱、邀请码、公司名称、公司数据库密码）'); return
        }
        if (form.password.length < 6) { setError('密码至少 6 位'); return }
        if (form.password !== form.confirm) { setError('两次输入的密码不一致'); return }
        if (form.company_db_password.length < 6) { setError('公司数据库密码至少 6 位'); return }
        setLoading(true)
        try {
            const res = await api.register({
                username: form.username.trim(),
                password: form.password,
                email: form.email.trim(),
                invite_code: form.invite_code.trim(),
                company: form.company.trim(),
                company_db_password: form.company_db_password.trim(),
            })
            if (res.success) {
                api.setToken(res.token)
                api.setStoredUser(res.user)
                onAuthSuccess(res.user)
            } else {
                setError(res.detail || res.message || '注册失败')
            }
        } catch (err) { setError('网络错误: ' + err.message) }
        finally { setLoading(false) }
    }

    return (
        <div className="auth-page">
            <div className="auth-card">
                <div className="auth-brand">
                    <div className="auth-logo">📊</div>
                    <h1>表格转换工具</h1>
                    <p>智能匹配列名 · 自动转换格式 · 公式保留</p>
                </div>

                <div className="auth-tabs">
                    <button type="button" className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
                        onClick={() => { setMode('login'); setError('') }}>登 录</button>
                    <button type="button" className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
                        onClick={() => { setMode('register'); setError('') }}>注 册</button>
                </div>

                <form onSubmit={handleSubmit} noValidate>
                    <div className="auth-field">
                        <label>用户名</label>
                        <input value={form.username} onChange={setField('username')}
                            placeholder="请输入用户名" autoComplete="username" />
                    </div>
                    <div className="auth-field">
                        <label>密码</label>
                        <input type="password" value={form.password} onChange={setField('password')}
                            placeholder="请输入密码" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
                    </div>

                    {mode === 'register' && (
                        <>
                            <div className="auth-field">
                                <label>确认密码</label>
                                <input type="password" value={form.confirm} onChange={setField('confirm')}
                                    placeholder="请再次输入密码" autoComplete="new-password" />
                            </div>
                            <div className="auth-field">
                                <label>邮箱</label>
                                <input value={form.email} onChange={setField('email')}
                                    placeholder="请输入邮箱（用于绑定账号）" autoComplete="email" />
                            </div>
                            <div className="auth-field">
                                <label>邀请码</label>
                                <input value={form.invite_code} onChange={setField('invite_code')}
                                    placeholder="请输入邀请码（由管理员分发）" />
                            </div>
                            <div className="auth-field">
                                <label>公司归属</label>
                                <div className="auth-mode-select">
                                    <button type="button" className={`auth-mode-btn ${registerMode === 'new' ? 'active' : ''}`}
                                        onClick={() => setRegisterMode('new')}>🏢 新注册公司</button>
                                    <button type="button" className={`auth-mode-btn ${registerMode === 'login' ? 'active' : ''}`}
                                        onClick={() => setRegisterMode('login')}>🔑 登录已有公司</button>
                                </div>
                                <span className="auth-hint">
                                    {registerMode === 'new'
                                        ? '创建新公司并设置公司数据库密码（仅管理员可创建新公司）'
                                        : '加入已存在的公司，需填写正确的公司数据库密码'}
                                </span>
                            </div>
                            {registerMode === 'new' ? (
                                <>
                                    <div className="auth-field">
                                        <label>新公司名称</label>
                                        <input value={form.company} onChange={setField('company')}
                                            placeholder="请输入新公司名称" />
                                        <span className="auth-hint">⚠️ 公司名注册后不可修改，请仔细填写</span>
                                    </div>
                                    <div className="auth-field">
                                        <label>新公司数据库密码</label>
                                        <input type="password" value={form.company_db_password} onChange={setField('company_db_password')}
                                            placeholder="为新公司设置数据库密码（至少 6 位）" />
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="auth-field">
                                        <label>公司名称</label>
                                        <input value={form.company} onChange={setField('company')}
                                            placeholder="请输入要加入的公司名称" />
                                    </div>
                                    <div className="auth-field">
                                        <label>公司数据库密码</label>
                                        <input type="password" value={form.company_db_password} onChange={setField('company_db_password')}
                                            placeholder="请输入该公司的数据库密码" />
                                    </div>
                                </>
                            )}
                        </>
                    )}

                    {error && (expired ? (
                        <div className="auth-error auth-error-expired" role="alert">
                            <strong>⚠️ 您的账户已过期</strong>
                            <span>{error}</span>
                        </div>
                    ) : (
                        <div className="auth-error">{error}</div>
                    ))}

                    <button className="btn btn-primary auth-submit" type="submit" disabled={loading}>
                        {loading ? '请稍候...' : (mode === 'login' ? '登 录' : '注 册')}
                    </button>
                </form>

                <div className="auth-divider"><span>或</span></div>

                <button type="button" className="btn btn-outline auth-guest-btn"
                    onClick={handleGuest} disabled={loading}>
                    🚪 以游客身份登录
                </button>
                <p className="auth-hint auth-guest-hint">
                    游客可试用全部功能（需自行配置 API Key），无用户管理权限；
                    退出登录后自动清除所有使用数据。
                </p>

                <div className="auth-foot">
                    {mode === 'login'
                        ? '还没有账号？请先获取邀请码后注册'
                        : '已有账号？点击上方「登录」'}
                </div>
            </div>
        </div>
    )
}
