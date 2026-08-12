import { useState, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import './App.css'
import * as api from './api'
import MappingLibrary from './MappingLibrary'
import DuplicateConfirmModal from './DuplicateConfirmModal'
import AIConfigModal from './AIConfigModal'
import CollapsibleSection from './CollapsibleSection'
import ConvertCompleteModal from './ConvertCompleteModal'
import AuthPage from './AuthPage'
import AdminPanel from './AdminPanel'

const CONF_LABELS = { high: '高', medium: '中', low: '低', manual: '手动' }

const ROLE_LABELS = { admin: '最高级管理员', manager: '管理员', user: '用户' }

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str || ''
  return d.innerHTML
}

/** 判断某列名是否在公式列名单中（标准化比较，忽略换行/空格） */
function isFormulaCol(col, formulaCols) {
  const clean = (col || '').replace(/\n/g, '').replace(/\r/g, '').trim()
  return (formulaCols || []).some(c => (c || '').replace(/\n/g, '').replace(/\r/g, '').trim() === clean)
}

/** 根据源/目标列是否为公式列，给出默认的公式处理方式（与后端 _default_formula_action 一致） */
function defaultFormulaAction(isSrcFormula, isTgtFormula) {
  if (isSrcFormula && isTgtFormula) return 'target_formula'
  if (isTgtFormula) return 'target_formula'
  if (isSrcFormula) return 'source_data'
  return 'default'
}

/**
 * 根据源列 / 目标列是否为公式列，返回公式处理选项
 * 返回 null 表示该映射不涉及公式列，无需选择
 */
function formulaOptions(m) {
  if (m.source_is_formula && m.target_is_formula) {
    return {
      hint: '源列与参考列均为公式列，请选择保留任意一边的公式',
      options: [
        { value: 'target_formula', label: '保留参考公式' },
        { value: 'source_formula', label: '保留源公式' },
      ],
    }
  }
  if (m.target_is_formula) {
    return {
      hint: '参考列为公式列，选择是否保留公式',
      options: [
        { value: 'target_formula', label: '保留公式' },
        { value: 'target_data', label: '用数据覆盖' },
      ],
    }
  }
  if (m.source_is_formula) {
    return {
      hint: '源列为公式列，选择映射具体数据还是计算公式',
      options: [
        { value: 'source_data', label: '用源数据' },
        { value: 'source_formula', label: '用源公式' },
      ],
    }
  }
  return null
}

/** 标准化列名：去换行、去首尾空格 */
function cleanName(s) {
  return (s || '').replace(/\n/g, '').replace(/\r/g, '').trim()
}

/**
 * 判断某映射的 (源列名, 目标列名) 是否已存在于映射库中（完全重复）
 * @param {object} m            映射项 {source, target}
 * @param {Set<string>} libraryPairs 库中已有的 "源|||目标" 组合集合
 */
function isMappingInLibrary(m, libraryPairs) {
  const src = cleanName(m.source)
  const tgt = cleanName(m.target)
  return !!src && !!tgt && libraryPairs.has(`${src}|||${tgt}`)
}

function App() {
  const [view, setView] = useState('tool')  // 'tool' | 'library' | 'admin'
  // ========== 登录状态 ==========
  const [currentUser, setCurrentUser] = useState(null)   // 当前登录用户
  const [authLoading, setAuthLoading] = useState(true)   // 正在验证登录状态
  const [step, setStep] = useState(1)
  const [sourceFiles, setSourceFiles] = useState([])
  const [sourceReady, setSourceReady] = useState(false)
  const [referenceReady, setReferenceReady] = useState(false)
  const [referenceMeta, setReferenceMeta] = useState(null)
  const [mappings, setMappings] = useState([])
  const [targetOptions, setTargetOptions] = useState([])
  const [sourceHeaders, setSourceHeaders] = useState([])
  const [sourceFormulaCols, setSourceFormulaCols] = useState([])
  const [targetFormulaCols, setTargetFormulaCols] = useState([])
  const [outputName, setOutputName] = useState('')
  const [comparison, setComparison] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingText, setLoadingText] = useState('处理中...')
  const [useAI, setUseAI] = useState(true)
  const [matchStatus, setMatchStatus] = useState(null)
  // 匹配完成后自动收起「上传文件」「AI 智能列匹配」模块
  const [matchCollapsed, setMatchCollapsed] = useState(false)
  const [convertStatus, setConvertStatus] = useState(null)
  const [compareTab, setCompareTab] = useState('output')
  // 转换完成弹窗
  const [convertDoneOpen, setConvertDoneOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  // 转换前重复确认弹窗: null 或 {duplicates, resolve}
  const [dupConfirm, setDupConfirm] = useState(null)
  const [dupProcessing, setDupProcessing] = useState(false)
  // AI 配置（API Key 加密管理 + token 统计）
  const [aiConfig, setAIConfig] = useState({ hasKey: false, maskedKey: '', totalTokens: 0, nonce: '' })
  const [aiConfigOpen, setAIConfigOpen] = useState(false)
  const [aiConfigForced, setAIConfigForced] = useState(false)
  const [aiSaving, setAISaving] = useState(false)
  const sourceInputRef = useRef(null)
  const refInputRef = useRef(null)

  // ========== 映射库中已有的 (源列名, 目标列名) 组合（映射预览中显示「已在库中」标记） ==========
  const [libraryPairs, setLibraryPairs] = useState(new Set())

  // ========== 登录状态验证（启动时根据本地令牌校验会话） ==========
  useEffect(() => {
    const token = api.getToken()
    if (!token) { setAuthLoading(false); return }
    api.fetchMe()
      .then(res => {
        if (res && res.success) {
          api.setStoredUser(res.user)
          setCurrentUser(res.user)
        } else {
          api.clearToken()
        }
      })
      .catch(() => { api.clearToken() })
      .finally(() => setAuthLoading(false))
  }, [])

  // ========== 登录过期统一处理：任意请求返回 401 时，自动登出并回到登录页 ==========
  useEffect(() => {
    const onAuthExpired = () => {
      setCurrentUser(null)
      setView('tool')
      setStep(1); setSourceReady(false); setSourceFiles([])
      setReferenceReady(false); setReferenceMeta(null); setMappings([])
      setTargetOptions([]); setSourceHeaders([])
      setSourceFormulaCols([]); setTargetFormulaCols([])
      setOutputName(''); setComparison(null); setMatchStatus(null); setConvertStatus(null)
      setConvertDoneOpen(false); setMatchCollapsed(false)
      setLibraryPairs(new Set())
      setAIConfig({ hasKey: false, maskedKey: '', totalTokens: 0, nonce: '' })
    }
    window.addEventListener('auth-expired', onAuthExpired)
    return () => window.removeEventListener('auth-expired', onAuthExpired)
  }, [])

  // 登录成功后加载映射库记录（按账号隔离）
  useEffect(() => {
    if (!currentUser) return
    api.getMappingLibrary()
      .then(res => {
        if (res && res.success) {
          const pairs = new Set()
            ; (res.records || []).forEach(r => {
              const src = cleanName(r.source_column)
              const tgt = cleanName(r.target_column)
              if (src && tgt) pairs.add(`${src}|||${tgt}`)
            })
          setLibraryPairs(pairs)
        }
      })
      .catch(() => { })
  }, [currentUser])

  // ========== 未匹配列（实时计算，随用户操作自动变化） ==========
  // 一个源列只要在映射列表中已有对应行（即使目标列尚未选择），即视为「已添加」
  const unmapped = sourceHeaders.filter(h => {
    const cleanH = (h || '').replace(/\n/g, '').trim()
    return !mappings.some(m => {
      const cleanSrc = (m.source || '').replace(/\n/g, '').trim()
      return cleanH === cleanSrc
    })
  })

  // ========== 文件上传 ==========
  const handleSourceUpload = useCallback(async (files) => {
    if (!files || files.length === 0) return
    setLoading(true)
    setLoadingText(`正在上传并解析 ${files.length} 个文件...`)
    try {
      const result = await api.uploadSource(Array.from(files))
      if (result.success) {
        setSourceFiles(result.files || [])
        setSourceReady(true)
      } else alert('上传失败：' + result.error)
    } catch (e) { alert('网络请求失败：' + e.message + '，请检查网络连接后重试') }
    finally { setLoading(false) }
  }, [])

  const handleRefUpload = useCallback(async (file) => {
    if (!file) return
    setLoading(true)
    setLoadingText('正在上传并解析文件...')
    try {
      const result = await api.uploadReference(file)
      if (result.success) {
        setReferenceMeta(result)
        setReferenceReady(true)
      } else alert('上传失败：' + result.error)
    } catch (e) { alert('网络请求失败：' + e.message + '，请检查网络连接后重试') }
    finally { setLoading(false) }
  }, [])

  const handleClearSource = useCallback(async () => {
    await api.clearSource()
    setSourceReady(false); setSourceFiles([]); setMappings([]); setStep(1)
  }, [])

  // 删除单个原始表格文件
  const handleDeleteSource = useCallback(async (filename) => {
    if (!filename) return
    setLoading(true); setLoadingText('正在删除文件...')
    try {
      const result = await api.deleteSource(filename)
      if (result.success) {
        setSourceFiles(result.files || [])
        setMappings([]); setStep(1)
        if (!result.files || result.files.length === 0) {
          setSourceReady(false)
        }
      } else alert('删除失败：' + result.error)
    } catch (e) { alert('网络请求失败：' + e.message + '，请检查网络连接后重试') }
    finally { setLoading(false) }
  }, [])

  const handleClearRef = useCallback(async () => {
    await api.clearReference()
    setReferenceReady(false); setReferenceMeta(null); setMappings([]); setStep(1)
  }, [])

  // ========== AI 配置（API Key 加密管理 + token 统计） ==========
  const refreshAIConfig = useCallback(async () => {
    try {
      const c = await api.getAIConfig()
      if (c && c.success) {
        const cfg = { hasKey: !!c.hasKey, maskedKey: c.maskedKey || '', totalTokens: c.totalTokens || 0, nonce: c.nonce || '' }
        setAIConfig(cfg)
        return cfg
      }
    } catch (e) { /* 网络失败则保持现状 */ }
    return null
  }, [])

  // 登录成功后加载当前账号的 AI 配置
  useEffect(() => {
    if (!currentUser) return
    refreshAIConfig()
  }, [refreshAIConfig, currentUser])

  const openAIConfig = useCallback(async (forced = false) => {
    setAIConfigForced(forced)
    await refreshAIConfig()
    setAIConfigOpen(true)
  }, [refreshAIConfig])

  const handleSaveApiKey = useCallback(async (apiKey) => {
    if (!apiKey) return
    setAISaving(true)
    try {
      let nonce = aiConfig.nonce
      if (!nonce) {
        const cfg = await refreshAIConfig()
        nonce = (cfg && cfg.nonce) || ''
      }
      if (!nonce) { alert('无法获取加密会话，请刷新页面后重试'); return }
      // 前端加密后再上传，避免明文出现在网络请求/日志中
      const enc = await api.encryptWithNonce(apiKey, nonce)
      const res = await api.saveAIConfig(enc)
      if (res && res.success) {
        await refreshAIConfig()
        setAIConfigOpen(false); setAIConfigForced(false)
        setMatchStatus(null); setConvertStatus(null)
      } else {
        alert('保存失败：' + ((res && res.detail) || '未知错误'))
      }
    } catch (e) {
      alert('保存失败：' + e.message + '，请重试')
    } finally { setAISaving(false) }
  }, [aiConfig.nonce, refreshAIConfig])

  // ========== AI 匹配 ==========
  const handleMatch = useCallback(async () => {
    // 使用 AI 前：确保已配置 API Key，否则强制打开设置
    if (useAI) {
      let cfg = aiConfig
      if (!cfg || !cfg.nonce) {
        cfg = (await refreshAIConfig()) || { hasKey: false, nonce: '' }
      }
      if (!cfg.hasKey) {
        setMatchStatus({ type: 'error', text: '❌ 使用 AI 匹配前请先配置 DeepSeek API Key' })
        openAIConfig(true)
        return
      }
    }
    setLoading(true)
    setLoadingText(useAI ? '正在调用 DeepSeek AI 进行列名匹配...' : '正在执行规则匹配...')
    setMatchStatus(null)
    setMatchCollapsed(false)   // 重新匹配前允许展开
    try {
      const result = await api.runMatch(useAI)
      if (result.success) {
        // AI 匹配结果默认加入库；记录 base_add_to_library（原始入库意愿），
        // 供切回默认公式处理时恢复「已在库中」状态
        setMappings((result.mappings || []).map(m => ({ ...m, base_add_to_library: m.add_to_library !== false })))
        setTargetOptions(result.targetOptions)
        setSourceHeaders(result.sourceHeaders)
        setSourceFormulaCols(result.sourceFormulaColumns || [])
        setTargetFormulaCols(result.targetFormulaColumns || [])
        setStep(3)
        const usage = (result.aiUsage && result.aiUsage.totalTokens) || 0
        const tokensText = useAI && usage > 0 ? ` · 本次消耗 ${usage.toLocaleString()} tokens` : ''
        setMatchStatus({ type: 'info', text: `✅ 匹配完成: ${result.mappings.length} 个列成功匹配${tokensText}` })
        setMatchCollapsed(true)   // 匹配完成自动收起上传/AI 模块
        if (useAI) refreshAIConfig()  // 刷新当前 Key 的总消耗
      } else setMatchStatus({ type: 'error', text: '❌ ' + result.error })
    } catch (e) { setMatchStatus({ type: 'error', text: '❌ 网络请求失败：' + e.message + '，请检查网络连接后重试' }) }
    finally { setLoading(false) }
  }, [useAI, aiConfig, refreshAIConfig, openAIConfig])

  // ========== 映射操作 ==========
  const updateMapping = useCallback((index, field, value) => {
    setMappings(prev => {
      const n = [...prev]
      const cur = n[index]
      if (field === 'source' || field === 'target') {
        // 修改源/目标列时，重新计算公式列状态，并同步默认公式动作
        const newSource = field === 'source' ? value : cur.source
        const newTarget = field === 'target' ? value : cur.target
        const newIsS = isFormulaCol(newSource, sourceFormulaCols)
        const newIsT = isFormulaCol(newTarget, targetFormulaCols)
        const prevIsS = isFormulaCol(cur.source, sourceFormulaCols)
        const prevIsT = isFormulaCol(cur.target, targetFormulaCols)
        // 公式状态未变化时保留用户选择的动作；变化时重置为默认
        const action = (newIsS === prevIsS && newIsT === prevIsT)
          ? (cur.formula_action || 'default')
          : defaultFormulaAction(newIsS, newIsT)
        n[index] = {
          ...cur,
          [field]: value,
          source_is_formula: newIsS,
          target_is_formula: newIsT,
          formula_action: action,
          add_to_library: false,   // 用户修改过列 → 不默认勾选「加入库」
        }
      } else if (field === 'formula_action') {
        // 修改公式处理选项：
        // 若切回该映射的默认处理方式 → 视为未修改，恢复原始入库意愿（已在库中）
        // 否则 → 视为修改，不默认勾选「加入库」
        const defaultAct = defaultFormulaAction(cur.source_is_formula, cur.target_is_formula)
        const reverted = value === defaultAct
        const base = typeof cur.base_add_to_library === 'boolean' ? cur.base_add_to_library : true
        n[index] = { ...cur, [field]: value, add_to_library: reverted ? base : false }
      } else {
        n[index] = { ...cur, [field]: value }
      }
      return n
    })
  }, [sourceFormulaCols, targetFormulaCols])

  const removeMapping = useCallback((index) => {
    setMappings(prev => prev.filter((_, i) => i !== index))
  }, [])

  // 为指定源列添加一条映射（点击未匹配列 / 手动添加按钮共用）
  const addMappingForSource = useCallback((src) => {
    if (!src) return
    const isS = isFormulaCol(src, sourceFormulaCols)
    setMappings(prev => [...prev, {
      source: src,
      target: '',
      confidence: 'manual',
      reason: '用户手动添加',
      add_to_library: false,   // 手动添加默认不勾选「加入库」
      base_add_to_library: false,
      source_is_formula: isS,
      target_is_formula: false,
      formula_action: defaultFormulaAction(isS, false),
    }])
  }, [sourceFormulaCols])

  const addManualMapping = useCallback(() => {
    if (!unmapped.length) { alert('所有原始列已全部映射，无需手动添加。'); return }
    addMappingForSource(unmapped[0])
  }, [unmapped, addMappingForSource])

  // ========== 转换 ==========
  const doConvert = useCallback(async (onDuplicate) => {
    setLoading(true); setLoadingText('正在按映射关系生成转换结果...'); setConvertStatus(null)
    try {
      const result = await api.runConvert(mappings, onDuplicate)
      if (result.success) {
        setOutputName(result.outputName)
        setComparison(result.comparison)
        setStep(3)
        setConvertDoneOpen(true)
      } else setConvertStatus({ type: 'error', text: '❌ ' + result.error })
    } catch (e) { setConvertStatus({ type: 'error', text: '❌ 网络请求失败：' + e.message + '，请检查网络连接后重试' }) }
    finally { setLoading(false) }
  }, [mappings])

  const handleConvert = useCallback(async () => {
    // 转换前预检：将保存到库的映射中是否有重复（仅以原始列名为准）
    setConvertStatus(null)
    try {
      const check = await api.checkConvertDuplicates(mappings)
      const duplicates = (check && check.duplicates) || []
      if (duplicates.length > 0) {
        setDupConfirm({
          duplicates,
          saveableCount: check.saveableCount || 0,
          resolve: (mode, selectedDups) => {
            setDupConfirm(null)
            if (mode === 'cancel') return
            setDupProcessing(true)
            doConvert(mode).finally(() => setDupProcessing(false))
          },
        })
        return
      }
    } catch (e) {
      // 预检失败不阻塞转换，按默认覆盖处理
      console.warn('重复预检失败，按默认处理: ', e)
    }
    doConvert('overwrite')
  }, [mappings, doConvert])

  // ========== 下载 ==========
  const handleDownload = useCallback(async () => {
    if (!outputName || downloading) return
    setDownloading(true)
    try { await api.downloadFile(outputName) } catch (e) { alert('下载失败：' + e.message + '，请重试') }
    finally { setDownloading(false) }
  }, [outputName, downloading])

  // ========== 重置 ==========
  const handleReset = useCallback(async () => {
    await api.resetSession()
    setStep(1); setSourceReady(false); setSourceFiles([])
    setReferenceReady(false); setReferenceMeta(null); setMappings([])
    setTargetOptions([]); setSourceHeaders([])
    setSourceFormulaCols([]); setTargetFormulaCols([])
    setOutputName(''); setComparison(null); setMatchStatus(null); setConvertStatus(null)
    setConvertDoneOpen(false)
    setMatchCollapsed(false)
  }, [])

  // ========== 登出：调用后端撤销令牌 + 清空本地登录态与业务状态 ==========
  const handleLogout = useCallback(async () => {
    try { await api.logout() } catch (e) { /* 忽略网络错误，仍然本地登出 */ }
    api.clearToken()
    setCurrentUser(null)
    setView('tool')
    setStep(1); setSourceReady(false); setSourceFiles([])
    setReferenceReady(false); setReferenceMeta(null); setMappings([])
    setTargetOptions([]); setSourceHeaders([])
    setSourceFormulaCols([]); setTargetFormulaCols([])
    setOutputName(''); setComparison(null); setMatchStatus(null); setConvertStatus(null)
    setConvertDoneOpen(false); setMatchCollapsed(false)
    setLibraryPairs(new Set())
    setAIConfig({ hasKey: false, maskedKey: '', totalTokens: 0, nonce: '' })
  }, [])

  // ========== 渲染 ==========
  const totalRows = sourceFiles.reduce((s, f) => s + f.rows, 0)

  // 登录校验中 / 未登录 → 显示登录页面
  if (authLoading) {
    return (
      <div className="app">
        <div className="auth-loading">⏳ 正在校验登录状态...</div>
      </div>
    )
  }
  if (!currentUser) {
    return <AuthPage onAuthSuccess={setCurrentUser} />
  }

  const canManage = currentUser.role === 'admin' || currentUser.role === 'manager'

  return (
    <div className="app">
      <header className="header">
        <div className="header-main">
          <nav className="header-nav header-left">
            <button
              className={`nav-btn ${view === 'tool' ? 'active' : ''}`}
              onClick={() => setView('tool')}
            >🔧 转换工具</button>
            <button
              className={`nav-btn ${view === 'library' ? 'active' : ''}`}
              onClick={() => setView('library')}
            >📚 映射匹配库</button>
            {canManage && (
              <button
                className={`nav-btn ${view === 'admin' ? 'active' : ''}`}
                onClick={() => setView('admin')}
              >👥 用户管理</button>
            )}
          </nav>
          <div className="header-title">
            <h1><span className="header-logo" aria-hidden="true">📊</span><span className="header-title-text">表格转换工具</span></h1>
            <p className="subtitle">智能匹配列名 · 自动转换格式 · 公式保留</p>
          </div>
          <div className="header-actions header-right">
            <button
              className={`btn btn-sm ai-config-btn ${aiConfig.hasKey ? '' : 'ai-config-warn'}`}
              onClick={() => openAIConfig(false)}
              title={aiConfig.hasKey ? `当前 Key: ${aiConfig.maskedKey}` : '尚未配置 DeepSeek API Key'}
            >
              ⚙️ API 设置{aiConfig.hasKey ? '' : ' ⚠️'}
            </button>
            <div className="user-box" title={currentUser.is_guest
              ? '游客模式 · 退出登录后自动清除全部数据'
              : `${currentUser.company} · ${ROLE_LABELS[currentUser.role] || currentUser.role}`}>
              <span className="user-avatar">👤</span>
              <span className="user-name">{currentUser.is_guest ? '游客' : currentUser.username}</span>
              <span className={`role-badge ${currentUser.is_guest ? 'role-user' : `role-${currentUser.role}`}`}>
                {currentUser.is_guest ? '游客' : (ROLE_LABELS[currentUser.role] || currentUser.role)}
              </span>
            </div>
            <button className="btn btn-sm btn-outline logout-btn" onClick={handleLogout}>退出登录</button>
          </div>
        </div>
      </header>

      {currentUser.is_guest && (
        <div className="guest-notice">
          🚪 <b>游客模式 · 不保留任何数据</b>
          <span>退出登录后，账号、映射匹配库、API Key、上传与输出文件等所有数据将被自动清除</span>
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view}
          className="view-reveal"
          initial={{ opacity: 0, filter: 'blur(16px)', scale: 0.998 }}
          animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }}
          exit={{ opacity: 0, filter: 'blur(16px)', scale: 0.998 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          {view === 'admin' ? (
            <AdminPanel user={currentUser} onGoBack={() => setView('tool')} />
          ) : view === 'library' ? (
            <MappingLibrary onGoBack={() => setView('tool')} />
          ) : (
            <main>
              {/* ======== 数据概览 ======== */}
              <div className="overview-bar" aria-label="数据概览">
                <div className="overview-item">
                  <span className="overview-ico">📄</span>
                  <div>
                    <div className="overview-num">{sourceFiles.length}</div>
                    <div className="overview-label">源文件</div>
                  </div>
                </div>
                <div className="overview-item">
                  <span className="overview-ico">🔢</span>
                  <div>
                    <div className="overview-num">{totalRows}</div>
                    <div className="overview-label">总行数</div>
                  </div>
                </div>
                <div className="overview-item">
                  <span className="overview-ico">📋</span>
                  <div>
                    <div className="overview-num">{referenceReady ? '✓' : '—'}</div>
                    <div className="overview-label">{referenceReady ? '参考模板就绪' : '参考模板'}</div>
                  </div>
                </div>
              </div>

            {/* ======== 步骤指示器 ======== */}
            <div className="stepper" aria-label="转换步骤">
              <div className={`step ${step >= 2 ? 'done' : ''} ${step === 1 ? 'current' : ''}`}>
                <span className="step-num">1</span>
                <span className="step-label">上传文件</span>
              </div>
              <div className="step-line" aria-hidden="true" />
              <div className={`step ${step >= 3 ? 'done' : ''} ${step === 2 ? 'current' : ''}`}>
                <span className="step-num">2</span>
                <span className="step-label">匹配列名</span>
              </div>
              <div className="step-line" aria-hidden="true" />
              <div className={`step ${step === 3 ? 'current' : ''}`}>
                <span className="step-num">3</span>
                <span className="step-label">预览转换</span>
              </div>
            </div>

            {/* ======== 步骤1: 上传文件 ======== */}
            <CollapsibleSection
              title="📤 上传文件"
              collapsed={matchCollapsed}
              actions={
                <button className="btn btn-sm btn-outline" onClick={handleReset}>🔄 转换新文件</button>
              }
              summary={
                !sourceReady && !referenceReady
                  ? '尚未上传文件'
                  : `${sourceFiles.length} 个源文件 · ${totalRows} 行` +
                  (referenceReady ? ` · 参考: ${referenceMeta.filename}` : '')
              }
            >
              <div className="upload-grid">
                {/* 原始表格 */}
                <div className="upload-box">
                  {!sourceReady ? (
                    <div className="upload-zone"
                      onClick={() => sourceInputRef.current?.click()}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => { e.preventDefault(); handleSourceUpload(e.dataTransfer.files) }}>
                      <div className="upload-icon">📄</div>
                      <p className="upload-title">原始表格（客户发来的）</p>
                      <p className="upload-hint">拖拽文件到此处，或点击选择（可多选）</p>
                      <p className="upload-formats">支持 .xlsx / .xls · 可一次选择多个文件</p>
                      <input ref={sourceInputRef} type="file" accept=".xlsx,.xls" multiple hidden
                        onChange={e => handleSourceUpload(e.target.files)} />
                    </div>
                  ) : (
                    <div className="upload-info">
                      <div className="source-file-list">
                        <div className="source-file-summary">
                          {sourceFiles.length} 个文件 · 共 {totalRows} 行
                        </div>
                        {sourceFiles.map((f, i) => (
                          <div key={f.filename || i} className="source-file-item">
                            <span className="sf-name">📄 {esc(f.filename || f.name)}</span>
                            <span className="sf-meta">{f.rows} 行 · {(f.headers || []).length} 列</span>
                            <button className="btn-icon" title="删除该文件"
                              onClick={() => handleDeleteSource(f.filename)}>✕</button>
                          </div>
                        ))}
                      </div>
                      <div className="source-actions">
                        <button className="btn btn-sm btn-outline" onClick={() => sourceInputRef.current?.click()}>
                          ➕ 添加文件
                        </button>
                        <input ref={sourceInputRef} type="file" accept=".xlsx,.xls" multiple hidden
                          onChange={e => handleSourceUpload(e.target.files)} />
                        <button className="btn-icon" onClick={handleClearSource}>✕ 清空</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* 参考模板 */}
                <div className="upload-box">
                  {!referenceReady ? (
                    <div className="upload-zone"
                      onClick={() => refInputRef.current?.click()}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => { e.preventDefault(); handleRefUpload(e.dataTransfer.files[0]) }}>
                      <div className="upload-icon">📋</div>
                      <p className="upload-title">参考模板（公司内部格式）</p>
                      <p className="upload-hint">拖拽文件到此处，或点击选择</p>
                      <p className="upload-formats">支持 .xlsx / .xls</p>
                      <input ref={refInputRef} type="file" accept=".xlsx,.xls" hidden
                        onChange={e => handleRefUpload(e.target.files[0])} />
                    </div>
                  ) : (
                    <div className="upload-info" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="file-icon">📋</span>
                      <span className="file-name">{referenceMeta.filename}</span>
                      <span className="file-meta">{referenceMeta.headers.length} 列 · {referenceMeta.formulaCount} 公式列</span>
                      <button className="btn-icon" onClick={handleClearRef}>✕</button>
                    </div>
                  )}
                </div>
              </div>

              {sourceReady && referenceReady && step === 1 && (
                <div style={{ textAlign: 'center', marginTop: 16 }}>
                  <button className="btn btn-primary" onClick={() => { setStep(2); setMatchCollapsed(false); setMatchStatus(null) }}>下一步 → 匹配</button>
                </div>
              )}
            </CollapsibleSection>

            {/* ======== 步骤2: AI 匹配 ======== */}
            {step >= 2 && (
              <CollapsibleSection
                title="🤖 AI 智能列匹配"
                collapsed={matchCollapsed}
                summary={mappings.length > 0 ? `已匹配 ${mappings.length} 列` : '未开始匹配'}
              >
                <div className="match-controls">
                  <label className="toggle">
                    <input type="checkbox" checked={useAI}
                      onChange={e => {
                        const on = e.target.checked
                        setUseAI(on); setStep(2); setMappings([])
                        // 开启 AI 但未配置 Key → 强制打开 API 设置
                        if (on && !aiConfig.hasKey) {
                          setMatchStatus({ type: 'error', text: '使用 AI 匹配前请先配置 DeepSeek API Key' })
                          openAIConfig(true)
                        }
                      }} />
                    <span className="toggle-slider" />
                    <span className="toggle-label">使用 DeepSeek AI 匹配</span>
                  </label>
                  <button className="btn btn-primary" onClick={handleMatch}>🔍 开始匹配</button>
                </div>
                {matchStatus && <div className={`match-status ${matchStatus.type}`}>{matchStatus.text}</div>}
              </CollapsibleSection>
            )}

            {/* ======== 步骤3: 预览调整 ======== */}
            {step >= 3 && (
              <CollapsibleSection
                title="📝 映射预览与调整"
                summary={`${mappings.length} 条映射` + (unmapped.length ? ` · ${unmapped.length} 列未匹配` : '')}
              >
                <p className="section-hint">
                  确认或调整列名映射关系，然后点击转换。
                  未修改的 AI 匹配结果会自动存入映射匹配库；调整/手动添加的映射需勾选「加入库」才会存入。
                </p>

                <div className="mapping-table-wrap">
                  <table className="mapping-table">
                    <thead>
                      <tr>
                        <th className="col-idx">#</th>
                        <th className="col-conf">匹配度</th>
                        <th className="col-src">原始表格列名</th>
                        <th className="col-arrow" />
                        <th className="col-tgt">参考表格列名</th>
                        <th className="col-formula">公式处理</th>
                        <th className="col-lib">加入库</th>
                        <th className="col-act">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mappings.length === 0 ? (
                        <tr><td colSpan={8} style={{ textAlign: 'center', color: '#94A3B8', padding: 20 }}>暂无匹配结果</td></tr>
                      ) : mappings.map((m, i) => {
                        const used = mappings.filter((_, idx) => idx !== i).map(mm => mm.source)
                        const formulaOpts = formulaOptions(m)
                        return (
                          <tr key={i} className={(m.source_is_formula || m.target_is_formula) ? 'row-formula' : ''}>
                            <td className="col-idx">{i + 1}</td>
                            <td className="col-conf">
                              <span className={`conf-badge conf-${m.confidence}`} title={m.reason}>
                                {CONF_LABELS[m.confidence] || m.confidence}
                              </span>
                            </td>
                            <td className="col-src">
                              <div className="col-name-wrap">
                                <select className="source-select" value={m.source} onChange={e => {
                                  updateMapping(i, 'source', e.target.value)
                                }}>
                                  {sourceHeaders.map((h, si) => {
                                    const cleanH = (h || '').replace(/\n/g, '').trim()
                                    const cleanSrc = (m.source || '').replace(/\n/g, '').trim()
                                    const isF = isFormulaCol(h, sourceFormulaCols)
                                    return (
                                      <option key={`src-${si}`} value={h}
                                        disabled={cleanH !== cleanSrc && used.includes(h)}>
                                        {isF ? 'ƒ ' : ''}{esc(h || '(空)')}
                                      </option>
                                    )
                                  })}
                                </select>
                                {isFormulaCol(m.source, sourceFormulaCols) && (
                                  <span className="formula-tag" title="该列是原始表格中的公式列">ƒ 公式</span>
                                )}
                              </div>
                            </td>
                            <td className="col-arrow">→</td>
                            <td className="col-tgt">
                              <div className="col-name-wrap">
                                <select className="target-select" value={m.target}
                                  onChange={e => updateMapping(i, 'target', e.target.value)}>
                                  <option value="">-- 不映射 --</option>
                                  {targetOptions.map((h, ti) => (
                                    <option key={`tgt-${ti}`} value={h}>
                                      {isFormulaCol(h, targetFormulaCols) ? 'ƒ ' : ''}{esc(h || '(空)')}
                                    </option>
                                  ))}
                                </select>
                                {isFormulaCol(m.target, targetFormulaCols) && (
                                  <span className="formula-tag" title="该列是参考表格中的公式列">ƒ 公式</span>
                                )}
                              </div>
                            </td>
                            <td className="col-formula">
                              {formulaOpts ? (
                                <select
                                  className="formula-select"
                                  value={m.formula_action || 'default'}
                                  onChange={e => updateMapping(i, 'formula_action', e.target.value)}
                                  title={formulaOpts.hint}
                                >
                                  {formulaOpts.options.map(o => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                  ))}
                                </select>
                              ) : (
                                <span className="formula-none">—</span>
                              )}
                            </td>
                            <td className="col-lib">
                              {m.add_to_library && isMappingInLibrary(m, libraryPairs) ? (
                                <span className="lib-existing"
                                  title="该映射的源列名与目标列名均已存在于映射匹配库中">✅ 已在库中</span>
                              ) : (
                                <label className="lib-checkbox"
                                  title={m.add_to_library ? '勾选：转换后加入映射匹配库' : '未勾选：转换后不加入映射匹配库'}>
                                  <input
                                    type="checkbox"
                                    checked={!!m.add_to_library}
                                    onChange={e => updateMapping(i, 'add_to_library', e.target.checked)}
                                  />
                                  <span>加入库</span>
                                </label>
                              )}
                            </td>
                            <td className="col-act">
                              <button className="btn btn-sm btn-danger" onClick={() => removeMapping(i)}>删除</button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {unmapped.length > 0 && (
                  <div className="unmapped-box">
                    <h3>⚠️ 未匹配的原始列</h3>
                    <p className="unmapped-hint">💡 直接点击下方未匹配列，可快速为该列添加一条映射</p>
                    <div className="unmapped-list">
                      {unmapped.map((h, ui) => (
                        <button key={`u-${ui}`} type="button" className="tag tag-clickable"
                          onClick={() => addMappingForSource(h)}
                          title={`点击为「${esc(h)}」添加映射`}>
                          {esc(h)} ＋
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="action-bar">
                  <button className="btn btn-outline" onClick={addManualMapping}>➕ 手动添加映射</button>
                  <button className="btn btn-primary btn-lg" onClick={handleConvert}>🚀 开始转换</button>
                </div>
                {convertStatus && <div className={`convert-status ${convertStatus.type}`}>{convertStatus.text}</div>}
              </CollapsibleSection>
            )}

            {/* ======== 对比预览 ======== */}
            {comparison && !comparison.error && (
              <CollapsibleSection
                title="🔍 表格内容预览"
                defaultOpen={false}
                summary={
                  comparison && (() => {
                    const d = compareTab === 'source'
                      ? { h: comparison.sourceHeaders, r: comparison.sourceRowCount }
                      : { h: comparison.outputHeaders, r: comparison.outputRowCount }
                    return `${d.r} 行 · ${d.h.length} 列`
                  })()
                }
              >
                <div className="compare-tabs">
                  <button className={`compare-tab ${compareTab === 'source' ? 'active' : ''}`}
                    onClick={() => setCompareTab('source')}>📄 原始表格</button>
                  <button className={`compare-tab ${compareTab === 'output' ? 'active' : ''}`}
                    onClick={() => setCompareTab('output')}>✅ 转换结果</button>
                </div>
                {(() => {
                  const d = compareTab === 'source'
                    ? { h: comparison.sourceHeaders, r: comparison.sourcePreview, t: comparison.sourceRowCount }
                    : { h: comparison.outputHeaders, r: comparison.outputPreview, t: comparison.outputRowCount }
                  return (
                    <>
                      <div className="compare-info">共 {d.t} 行 · {d.h.length} 列（预览前 {d.r.length} 行）</div>
                      <div className="spreadsheet-container">
                        <div className="spreadsheet-wrapper">
                          <table className="spreadsheet">
                            <thead>
                              <tr><th>#</th>{d.h.map((h, i) => <th key={i} title={h}>{esc(h || '(空)')}</th>)}</tr>
                            </thead>
                            <tbody>
                              {d.r.map((row, i) => (
                                <tr key={i}>
                                  <td>{i + 1}</td>
                                  {d.h.map((h, j) => {
                                    const v = row[h] || ''
                                    const isNum = v !== '' && !isNaN(parseFloat(v)) && isFinite(v) && !/^=/.test(v) && !/^https?:/.test(v)
                                    return <td key={j} className={isNum ? 'num' : ''} title={esc(v)}>{esc(v.length > 80 ? v.substring(0, 80) + '...' : v)}</td>
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="spreadsheet-scroll-hint">← 左右滑动查看更多列 →</div>
                      </div>
                    </>
                  )
                })()}
              </CollapsibleSection>
            )}
          </main>
          )}
        </motion.div>
      </AnimatePresence>

      {/* 加载遮罩：portal 到 body，避免被 .app 的 filter 捕获导致 fixed 定位失效（跑到长页面居中） */}
      {loading && createPortal(
        <div className="overlay">
          <div className="spinner" />
          <p>{loadingText}</p>
        </div>,
        document.body
      )}

      {/* 转换前重复数据确认弹窗 */}
      {dupConfirm && (
        <DuplicateConfirmModal
          title="⚠️ 将保存到映射匹配库的映射存在重复"
          hint={dupConfirm.saveableCount > 0
            ? `本次转换完成后将有 ${dupConfirm.saveableCount} 条映射写入映射匹配库，其中 ${dupConfirm.duplicates.length} 条原始列名已存在。`
            : '检测到部分映射的原始列名已存在于映射匹配库中。'}
          duplicates={dupConfirm.duplicates}
          processing={dupProcessing}
          onConfirm={(mode, selectedDups) => dupConfirm.resolve(mode, selectedDups)}
        />
      )}

      {/* DeepSeek API 设置弹窗 */}
      <AIConfigModal
        open={aiConfigOpen}
        forced={aiConfigForced}
        hasKey={aiConfig.hasKey}
        maskedKey={aiConfig.maskedKey}
        totalTokens={aiConfig.totalTokens}
        saving={aiSaving}
        onSave={handleSaveApiKey}
        onClose={() => setAIConfigOpen(false)}
      />

      {/* 转换完成弹窗 */}
      <ConvertCompleteModal
        open={convertDoneOpen}
        outputName={outputName}
        downloading={downloading}
        onDownload={handleDownload}
        onReset={handleReset}
        onClose={() => setConvertDoneOpen(false)}
      />
    </div>
  )
}

export default App

