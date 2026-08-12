import { useState, useRef, useLayoutEffect, useEffect } from 'react'
import { motion } from 'framer-motion'
import * as api from './api'
import FluidBackground from './FluidBackground'

/**
 * 登录 / 注册页面（梦幻流体版）
 * - 背景：交互式流体 + 粒子 + 点击涟漪（FluidBackground Canvas）
 * - 标题 / 简介 / 切换胶囊：浮动固定，逐字错峰入场退场
 * - 填写模块：3D 翻转（正面登录 / 背面注册），胶囊滑块右滑→翻到背面，左滑→翻回正面
 * - 表单字段：列表错峰入场退场；登录/注册成功时整体错峰退场
 */

const EASE = [0.16, 1, 0.3, 1]

/* ---------- 逐字错峰组件 ---------- */
function StaggerChars({ text, animate = 'show', step = 0.05, delayChildren = 0 }) {
    const chars = text.split('')
    return (
        <motion.span
            className="auth-chars"
            initial="hidden"
            animate={animate}
            variants={{
                hidden: {},
                show: { transition: { staggerChildren: step, delayChildren } },
                exit: { transition: { staggerChildren: step * 0.4, staggerDirection: -1 } },
            }}
        >
            {chars.map((c, i) => (
                <motion.span
                    key={i}
                    className="auth-char"
                    variants={{
                        hidden: { opacity: 0, y: 28, rotateX: 90, filter: 'blur(8px)' },
                        show: { opacity: 1, y: 0, rotateX: 0, filter: 'blur(0px)', transition: { duration: 0.55, ease: EASE } },
                        exit: { opacity: 0, y: -20, filter: 'blur(6px)', transition: { duration: 0.26, ease: 'easeIn' } },
                    }}
                >
                    {c === ' ' ? '\u00A0' : c}
                </motion.span>
            ))}
        </motion.span>
    )
}

/* ---------- 列表错峰（表单字段） ---------- */
const listV = {
    hidden: {},
    show: { transition: { staggerChildren: 0.06, delayChildren: 0.35 } },
    exit: { transition: { staggerChildren: 0.035, staggerDirection: -1 } },
}
const itemV = {
    hidden: { opacity: 0, y: 16, scale: 0.98 },
    show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: EASE } },
    exit: { opacity: 0, y: -14, scale: 0.99, transition: { duration: 0.2, ease: 'easeIn' } },
}

/* ---------- 表单字段单元 ---------- */
function AuthField({ label, children, hint, item }) {
    return (
        <motion.div className="auth-field" variants={item}>
            <label>{label}</label>
            {children}
            {hint && <span className="auth-hint">{hint}</span>}
        </motion.div>
    )
}

/* ============ 正面：登录 ============ */
function LoginFace({ form, setField, error, expired, loading, leaving, onSubmit, onGuest }) {
    return (
        <motion.form
            className="auth-form-list"
            onSubmit={onSubmit}
            noValidate
            variants={listV}
            initial="hidden"
            animate={leaving ? 'exit' : 'show'}
        >
            <AuthField item={itemV} label="用户名">
                <input value={form.username} onChange={setField('username')}
                    placeholder="请输入用户名" autoComplete="username" />
            </AuthField>
            <AuthField item={itemV} label="密码">
                <input type="password" value={form.password} onChange={setField('password')}
                    placeholder="请输入密码" autoComplete="current-password" />
            </AuthField>

            {error && (expired ? (
                <motion.div variants={itemV} className="auth-error auth-error-expired" role="alert">
                    <strong>⚠️ 您的账户已过期</strong>
                    <span>{error}</span>
                </motion.div>
            ) : (
                <motion.div variants={itemV} className="auth-error">{error}</motion.div>
            ))}

            <motion.button variants={itemV} className="btn btn-primary auth-submit" type="submit" disabled={loading}>
                {loading ? '登录中...' : '登 录'}
            </motion.button>

            <motion.div variants={itemV} className="auth-divider"><span>或</span></motion.div>

            <motion.button variants={itemV} type="button" className="btn btn-outline auth-guest-btn"
                onClick={onGuest} disabled={loading}>
                🚪 以游客身份登录
            </motion.button>
            <motion.p variants={itemV} className="auth-hint auth-guest-hint">
                ⚠️ <b>游客模式不保留任何数据</b>：可试用全部功能（需自行配置 API Key），无用户管理权限；
                退出登录后，账号、映射匹配库、API Key、上传与输出文件等<b>所有数据将被自动清除</b>。
            </motion.p>
        </motion.form>
    )
}

/* ============ 背面：注册 ============ */
function RegisterFace({ form, setField, registerMode, setRegisterMode, invite, inviteChecking, error, loading, leaving, onSubmit }) {
    return (
        <motion.form
            className="auth-form-list"
            onSubmit={onSubmit}
            noValidate
            variants={listV}
            initial="hidden"
            animate={leaving ? 'exit' : 'show'}
        >
            {/* 两行两行：用户名/密码 */}
            <motion.div className="auth-fields-2col" variants={itemV}>
                <AuthField item={itemV} label="用户名">
                    <input value={form.username} onChange={setField('username')}
                        placeholder="请输入用户名" autoComplete="username" />
                </AuthField>
                <AuthField item={itemV} label="密码">
                    <input type="password" value={form.password} onChange={setField('password')}
                        placeholder="至少 6 位" autoComplete="new-password" />
                </AuthField>
            </motion.div>
            {/* 两行两行：确认密码/邮箱 */}
            <motion.div className="auth-fields-2col" variants={itemV}>
                <AuthField item={itemV} label="确认密码">
                    <input type="password" value={form.confirm} onChange={setField('confirm')}
                        placeholder="请再次输入密码" autoComplete="new-password" />
                </AuthField>
                <AuthField item={itemV} label="邮箱">
                    <input value={form.email} onChange={setField('email')}
                        placeholder="请输入邮箱" autoComplete="email" />
                </AuthField>
            </motion.div>

            {/* 邀请码单独一行 */}
            <motion.div variants={itemV} className="auth-field">
                <label>邀请码</label>
                <input value={form.invite_code} onChange={setField('invite_code')}
                    placeholder="请输入邀请码（由管理员分发）" />
                {inviteChecking && <span className="invite-status checking">⏳ 正在识别邀请码...</span>}
                {invite && invite.invalid && <span className="invite-status error">❌ 邀请码无效，请检查后重新输入</span>}
                {invite && invite.level === 1 && <span className="invite-status ok">✅ 管理员邀请码 · 可新建公司或登录已有公司</span>}
                {invite && invite.level === 2 && <span className="invite-status ok">✅ 用户邀请码 · 仅可登录已有公司</span>}
            </motion.div>

            {/* 识别到邀请码后，按级别展开公司信息 */}
            {invite && invite.level === 1 && (
                <>
                    <motion.div variants={itemV} className="auth-field">
                        <label>公司归属</label>
                        <div className="auth-mode-select">
                            <button type="button" className={`auth-mode-btn ${registerMode === 'new' ? 'active' : ''}`}
                                onClick={() => setRegisterMode('new')}>🏢 新建公司</button>
                            <button type="button" className={`auth-mode-btn ${registerMode === 'login' ? 'active' : ''}`}
                                onClick={() => setRegisterMode('login')}>🔑 登录已有公司</button>
                        </div>
                    </motion.div>
                    {registerMode === 'new' ? (
                        <>
                            <AuthField item={itemV} label="新公司名称"
                                hint={<span className="auth-hint">⚠️ 公司名注册后不可修改，请仔细填写</span>}>
                                <input value={form.company} onChange={setField('company')} placeholder="请输入新公司名称" />
                            </AuthField>
                            <AuthField item={itemV} label="新公司数据库密码">
                                <input type="password" value={form.company_db_password} onChange={setField('company_db_password')}
                                    placeholder="为新公司设置数据库密码（至少 6 位）" />
                            </AuthField>
                        </>
                    ) : (
                        <>
                            <AuthField item={itemV} label="公司名称">
                                <input value={form.company} onChange={setField('company')} placeholder="请输入要加入的公司名称" />
                            </AuthField>
                            <AuthField item={itemV} label="公司数据库密码">
                                <input type="password" value={form.company_db_password} onChange={setField('company_db_password')}
                                    placeholder="请输入该公司的数据库密码" />
                            </AuthField>
                        </>
                    )}
                </>
            )}

            {invite && invite.level === 2 && (
                <>
                    <motion.div variants={itemV} className="auth-field">
                        <label>公司归属</label>
                        <span className="invite-note">🔑 用户仅可登录已有公司（管理员邀请码才可新建公司）</span>
                    </motion.div>
                    <AuthField item={itemV} label="公司名称">
                        <input value={form.company} onChange={setField('company')} placeholder="请输入要加入的公司名称" />
                    </AuthField>
                    <AuthField item={itemV} label="公司数据库密码">
                        <input type="password" value={form.company_db_password} onChange={setField('company_db_password')}
                            placeholder="请输入该公司的数据库密码" />
                    </AuthField>
                </>
            )}

            {error && (
                <motion.div variants={itemV} className="auth-error">{error}</motion.div>
            )}

            <motion.button variants={itemV} className="btn btn-primary auth-submit" type="submit" disabled={loading}>
                {loading ? '注册中...' : '注 册'}
            </motion.button>
        </motion.form>
    )
}

/* ============ 主页面 ============ */
export default function AuthPage({ onAuthSuccess }) {
    const [mode, setMode] = useState('login')   // 'login' | 'register'
    const [registerMode, setRegisterMode] = useState('new')
    const [form, setForm] = useState({ username: '', password: '', confirm: '', email: '', invite_code: '', company: '', company_db_password: '' })
    const [error, setError] = useState('')
    const [expired, setExpired] = useState(false)
    const [loading, setLoading] = useState(false)
    const [leaving, setLeaving] = useState(false)   // 登录/注册成功 → 错峰离场
    const [flipH, setFlipH] = useState(null)
    const [invite, setInvite] = useState(null)          // 邀请码识别结果: {level:1|2} | {invalid:true} | null
    const [inviteChecking, setInviteChecking] = useState(false)
    const frontRef = useRef(null)
    const backRef = useRef(null)

    const setField = (key) => (e) => setForm({ ...form, [key]: e.target.value })

    // 3D 翻转容器高度 = 正反两面中较高者
    // 测量各面内部表单的自然高度（面本身是 absolute，需量内容 + 内边距）
    useLayoutEffect(() => {
        const PAD = 62   // 面上下内边距(30+26) + 边框(2) + 余量
        const measure = () => {
            const h1 = frontRef.current ? (frontRef.current.querySelector('.auth-form-list')?.offsetHeight || 0) : 0
            const h2 = backRef.current ? (backRef.current.querySelector('.auth-form-list')?.offsetHeight || 0) : 0
            setFlipH(Math.max(h1, h2) + PAD)
        }
        measure()
        const id = setTimeout(measure, 120)   // 等字体/动画稳定后复测
        window.addEventListener('resize', measure)
        return () => { clearTimeout(id); window.removeEventListener('resize', measure) }
    }, [mode, registerMode, invite])

    // 识别邀请码（防抖）：按级别展开公司填写区（1=管理员可新建/加入；2=用户仅可加入）
    useEffect(() => {
        const code = (form.invite_code || '').trim()
        if (!code) { setInvite(null); setInviteChecking(false); return }
        setInviteChecking(true)
        const id = setTimeout(async () => {
            try {
                const res = await api.validateInvite(code)
                if (res && res.valid) {
                    setInvite({ level: res.level })
                    if (res.level === 2) setRegisterMode('login')   // 用户仅可登录已有公司
                } else {
                    setInvite({ invalid: true })
                }
            } catch (e) {
                setInvite(null)
            } finally {
                setInviteChecking(false)
            }
        }, 450)
        return () => clearTimeout(id)
    }, [form.invite_code])

    const switchMode = (m) => {
        if (m === mode || leaving) return
        setMode(m)
        setError('')
        setExpired(false)
    }

    /** 认证成功：先播放错峰离场动画，再进入应用 */
    const finishAuth = (user) => {
        if (leaving) return
        setLeaving(true)
        setTimeout(() => onAuthSuccess(user), 780)
    }

    const handleGuest = async () => {
        setError('')
        setLoading(true)
        try {
            const res = await api.guestLogin()
            if (res.success) {
                api.setToken(res.token)
                api.setStoredUser(res.user)
                finishAuth(res.user)
            } else {
                setError(res.detail || res.message || '游客登录失败')
            }
        } catch (err) { setError('网络请求失败：' + err.message + '，请检查网络连接后重试') }
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
                    finishAuth(res.user)
                } else {
                    const detail = res.detail
                    setExpired(!!(detail && typeof detail === 'object' && detail.code === 'ACCOUNT_EXPIRED'))
                    setError(typeof detail === 'object' ? (detail.message || '登录失败') : (detail || res.message || '登录失败'))
                }
            } catch (err) { setError('网络请求失败：' + err.message + '，请检查网络连接后重试') }
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
                finishAuth(res.user)
            } else {
                setError(res.detail || res.message || '注册失败')
            }
        } catch (err) { setError('网络请求失败：' + err.message + '，请检查网络连接后重试') }
        finally { setLoading(false) }
    }

    const titleAnimate = leaving ? 'exit' : 'show'

    return (
        <div className={`auth-page ${leaving ? 'auth-leaving' : ''}`}>
            <FluidBackground />

            <div className="auth-center">
                {/* ===== 浮动固定的品牌区：小图标前置 + 标题/简介 逐字错峰 ===== */}
                <div className="auth-brand">
                    <h1 className="auth-title-row">
                        <motion.span
                            className="auth-logo-inline"
                            aria-hidden="true"
                            initial={{ opacity: 0, scale: 0.4, rotate: -30 }}
                            animate={leaving ? { opacity: 0, scale: 0.6 } : { opacity: 1, scale: 1, rotate: 0 }}
                            transition={{ delay: leaving ? 0 : 0.2, duration: 0.55, ease: EASE }}
                        >📊</motion.span>
                        <StaggerChars text="表格转换工具" animate={titleAnimate} step={0.09} delayChildren={0.32} />
                    </h1>
                    <p className="auth-slogan">
                        <StaggerChars text="智能匹配列名 · 自动转换格式 · 公式保留" animate={titleAnimate} step={0.012} delayChildren={0.75} />
                    </p>
                </div>

                {/* ===== 胶囊滑块切换（浮动固定） ===== */}
                <motion.div
                    className="auth-capsule"
                    role="tablist"
                    aria-label="登录 / 注册切换"
                    initial={{ opacity: 0, y: 20, scale: 0.92 }}
                    animate={leaving ? { opacity: 0, y: -16, scale: 0.9 } : { opacity: 1, y: 0, scale: 1 }}
                    transition={{ delay: leaving ? 0 : 1.05, duration: 0.5, ease: EASE }}
                >
                    <span className={`auth-capsule-slider ${mode === 'login' ? 'pos-left' : 'pos-right'}`} aria-hidden="true" />
                    <button type="button" role="tab" aria-selected={mode === 'login'}
                        className={`auth-capsule-btn ${mode === 'login' ? 'active' : ''}`}
                        onClick={() => switchMode('login')}>登 录</button>
                    <button type="button" role="tab" aria-selected={mode === 'register'}
                        className={`auth-capsule-btn ${mode === 'register' ? 'active' : ''}`}
                        onClick={() => switchMode('register')}>注 册</button>
                </motion.div>

                {/* ===== 3D 翻转表单模块：正面登录 / 背面注册 ===== */}
                <motion.div
                    className="auth-flip"
                    initial={{ opacity: 0, y: 46, scale: 0.95 }}
                    animate={leaving ? { opacity: 0, y: -40, scale: 0.92 } : { opacity: 1, y: 0, scale: 1 }}
                    transition={{ delay: leaving ? 0 : 0.6, duration: 0.65, ease: EASE }}
                >
                    <motion.div
                        className="auth-flip-inner"
                        style={{ height: flipH, transformStyle: 'preserve-3d' }}
                        animate={{ rotateY: mode === 'login' ? 0 : 180 }}
                        transition={{ duration: 0.7, ease: [0.45, 0, 0.2, 1] }}
                    >
                        <div className="auth-face auth-front" ref={frontRef}>
                            <LoginFace
                                form={form} setField={setField}
                                error={error} expired={expired}
                                loading={loading} leaving={leaving}
                                onSubmit={handleSubmit} onGuest={handleGuest}
                            />
                        </div>
                        <div className="auth-face auth-back" ref={backRef}>
                            <RegisterFace
                                form={form} setField={setField}
                                registerMode={registerMode} setRegisterMode={setRegisterMode}
                                invite={invite} inviteChecking={inviteChecking}
                                error={error} loading={loading} leaving={leaving}
                                onSubmit={handleSubmit}
                            />
                        </div>
                    </motion.div>
                </motion.div>
            </div>
        </div>
    )
}
