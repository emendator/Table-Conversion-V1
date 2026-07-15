import { useState, useCallback, useRef } from 'react'
import './App.css'
import * as api from './api'

const CONF_LABELS = { high: '高', medium: '中', low: '低', manual: '手动' }

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str || ''
  return d.innerHTML
}

function App() {
  const [step, setStep] = useState(1)
  const [sourceFiles, setSourceFiles] = useState([])
  const [sourceReady, setSourceReady] = useState(false)
  const [referenceReady, setReferenceReady] = useState(false)
  const [referenceMeta, setReferenceMeta] = useState(null)
  const [mappings, setMappings] = useState([])
  const [targetOptions, setTargetOptions] = useState([])
  const [sourceHeaders, setSourceHeaders] = useState([])
  const [unmapped, setUnmapped] = useState([])
  const [outputName, setOutputName] = useState('')
  const [comparison, setComparison] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingText, setLoadingText] = useState('处理中...')
  const [useAI, setUseAI] = useState(true)
  const [matchStatus, setMatchStatus] = useState(null)
  const [convertStatus, setConvertStatus] = useState(null)
  const [compareTab, setCompareTab] = useState('output')
  const sourceInputRef = useRef(null)
  const refInputRef = useRef(null)

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
      } else alert('上传失败: ' + result.error)
    } catch (e) { alert('网络错误: ' + e.message) }
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
      } else alert('上传失败: ' + result.error)
    } catch (e) { alert('网络错误: ' + e.message) }
    finally { setLoading(false) }
  }, [])

  const handleClearSource = useCallback(async () => {
    await api.clearSource()
    setSourceReady(false); setSourceFiles([]); setMappings([]); setStep(1)
  }, [])

  const handleClearRef = useCallback(async () => {
    await api.clearReference()
    setReferenceReady(false); setReferenceMeta(null); setMappings([]); setStep(1)
  }, [])

  // ========== AI 匹配 ==========
  const handleMatch = useCallback(async () => {
    setLoading(true)
    setLoadingText(useAI ? '正在调用 DeepSeek AI 进行列名匹配...' : '正在执行规则匹配...')
    setMatchStatus(null)
    try {
      const result = await api.runMatch(useAI)
      if (result.success) {
        setMappings(result.mappings)
        setTargetOptions(result.targetOptions)
        setSourceHeaders(result.sourceHeaders)
        setUnmapped(result.unmappedSources || [])
        setStep(3)
        setMatchStatus({ type: 'info', text: `✅ 匹配完成: ${result.mappings.length} 个列成功匹配` })
      } else setMatchStatus({ type: 'error', text: '❌ ' + result.error })
    } catch (e) { setMatchStatus({ type: 'error', text: '❌ 网络错误: ' + e.message }) }
    finally { setLoading(false) }
  }, [useAI])

  // ========== 映射操作 ==========
  const updateMapping = useCallback((index, field, value) => {
    setMappings(prev => { const n = [...prev]; n[index] = { ...n[index], [field]: value }; return n })
  }, [])

  const removeMapping = useCallback((index) => {
    setMappings(prev => prev.filter((_, i) => i !== index))
  }, [])

  const addManualMapping = useCallback(() => {
    const mapped = new Set(mappings.map(m => m.source))
    const avail = sourceHeaders.filter(h => !mapped.has(h))
    if (!avail.length) { alert('所有原始列已全部映射，无需手动添加。'); return }
    setMappings(prev => [...prev, { source: avail[0], target: '', confidence: 'manual', reason: '用户手动添加' }])
  }, [mappings, sourceHeaders])

  // ========== 转换 ==========
  const handleConvert = useCallback(async () => {
    setLoading(true); setLoadingText('正在转换表格...'); setConvertStatus(null)
    try {
      const result = await api.runConvert(mappings)
      if (result.success) {
        setOutputName(result.outputName)
        setComparison(result.comparison)
        setStep(4)
      } else setConvertStatus({ type: 'error', text: '❌ ' + result.error })
    } catch (e) { setConvertStatus({ type: 'error', text: '❌ 网络错误: ' + e.message }) }
    finally { setLoading(false) }
  }, [mappings])

  // ========== 下载 ==========
  const handleDownload = useCallback(async () => {
    try { await api.downloadFile(outputName) } catch (e) { alert('下载失败: ' + e.message) }
  }, [outputName])

  // ========== 重置 ==========
  const handleReset = useCallback(async () => {
    await api.resetSession()
    setStep(1); setSourceReady(false); setSourceFiles([])
    setReferenceReady(false); setReferenceMeta(null); setMappings([])
    setTargetOptions([]); setSourceHeaders([]); setUnmapped([])
    setOutputName(''); setComparison(null); setMatchStatus(null); setConvertStatus(null)
  }, [])

  // ========== 渲染 ==========
  const totalRows = sourceFiles.reduce((s, f) => s + f.rows, 0)

  return (
    <div className="app">
      <header className="header">
        <h1>📊 表格转换工具</h1>
        <p className="subtitle">智能匹配列名 · 自动转换格式 · 公式保留</p>
      </header>

      {/* 步骤指示器 */}
      <div className="steps">
        {[
          { n: 1, l: '上传文件' }, { n: 2, l: 'AI匹配' },
          { n: 3, l: '预览调整' }, { n: 4, l: '下载结果' },
        ].map(s => (
          <div key={s.n} style={{ display: 'flex', alignItems: 'center' }}>
            {s.n > 1 && <div className="step-connector" />}
            <div className={`step ${step === s.n ? 'active' : ''} ${step > s.n ? 'done' : ''}`}>
              <div className="step-dot">{step > s.n ? '✓' : s.n}</div>
              <span>{s.l}</span>
            </div>
          </div>
        ))}
      </div>

      <main>
        {/* ======== 步骤1: 上传文件 ======== */}
        <section className="card">
          <h2>📤 上传文件</h2>
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
                      <div key={i} className="source-file-item">
                        <span className="sf-name">📄 {esc(f.filename || f.name)}</span>
                        <span className="sf-meta">{f.rows} 行 · {(f.headers || []).length} 列</span>
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
              <button className="btn btn-primary" onClick={() => setStep(2)}>下一步 → AI 匹配</button>
            </div>
          )}
        </section>

        {/* ======== 步骤2: AI 匹配 ======== */}
        {step >= 2 && (
          <section className="card">
            <h2>🤖 AI 智能列匹配</h2>
            <div className="match-controls">
              <label className="toggle">
                <input type="checkbox" checked={useAI}
                  onChange={e => { setUseAI(e.target.checked); setStep(2); setMappings([]) }} />
                <span className="toggle-slider" />
                <span className="toggle-label">使用 DeepSeek AI 匹配</span>
              </label>
              <button className="btn btn-primary" onClick={handleMatch}>🔍 开始匹配</button>
            </div>
            {matchStatus && <div className={`match-status ${matchStatus.type}`}>{matchStatus.text}</div>}
          </section>
        )}

        {/* ======== 步骤3: 预览调整 ======== */}
        {step >= 3 && (
          <section className="card">
            <h2>📝 映射预览与调整</h2>
            <p className="section-hint">确认或调整列名映射关系，然后点击转换</p>

            <div className="mapping-table-wrap">
              <table className="mapping-table">
                <thead>
                  <tr>
                    <th className="col-conf">匹配度</th>
                    <th className="col-src">原始表格列名</th>
                    <th className="col-arrow" />
                    <th className="col-tgt">参考表格列名</th>
                    <th className="col-act">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.length === 0 ? (
                    <tr><td colSpan={5} style={{ textAlign: 'center', color: '#94A3B8', padding: 20 }}>暂无匹配结果</td></tr>
                  ) : mappings.map((m, i) => {
                    const used = mappings.filter((_, idx) => idx !== i).map(mm => mm.source)
                    return (
                      <tr key={i}>
                        <td className="col-conf">
                          <span className={`conf-badge conf-${m.confidence}`} title={m.reason}>
                            {CONF_LABELS[m.confidence] || m.confidence}
                          </span>
                        </td>
                        <td className="col-src">
                          <select className="source-select" value={m.source} onChange={e => {
                            updateMapping(i, 'source', e.target.value)
                            const nm = mappings.map((mm, idx) => idx === i ? { ...mm, source: e.target.value } : mm)
                            const ms = new Set(nm.map(mm => mm.source))
                            setUnmapped(sourceHeaders.filter(h => !ms.has(h)))
                          }}>
                            {sourceHeaders.map(h => {
                              const cleanH = (h || '').replace(/\n/g, '').trim()
                              const cleanSrc = (m.source || '').replace(/\n/g, '').trim()
                              return (
                                <option key={h} value={h}
                                  disabled={cleanH !== cleanSrc && used.includes(h)}>
                                  {esc(h || '(空)')}
                                </option>
                              )
                            })}
                          </select>
                        </td>
                        <td className="col-arrow">→</td>
                        <td className="col-tgt">
                          <select className="target-select" value={m.target}
                            onChange={e => updateMapping(i, 'target', e.target.value)}>
                            <option value="">-- 不映射 --</option>
                            {targetOptions.map(h => (
                              <option key={h} value={h}>{esc(h || '(空)')}</option>
                            ))}
                          </select>
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
                <div className="unmapped-list">
                  {unmapped.map(h => <span key={h} className="tag">{esc(h)}</span>)}
                </div>
              </div>
            )}

            <div className="action-bar">
              <button className="btn btn-outline" onClick={addManualMapping}>➕ 手动添加映射</button>
              <button className="btn btn-primary btn-lg" onClick={handleConvert}>🚀 开始转换</button>
            </div>
            {convertStatus && <div className={`convert-status ${convertStatus.type}`}>{convertStatus.text}</div>}
          </section>
        )}

        {/* ======== 步骤4: 下载结果 ======== */}
        {step >= 4 && (
          <section className="card">
            <h2>✅ 转换完成</h2>
            <div className="success-box">
              <div className="success-icon">🎉</div>
              <p>表格转换成功！点击下方按钮下载结果文件。</p>
              <button className="btn btn-success btn-lg" onClick={handleDownload}>📥 下载转换结果</button>
            </div>
            <div className="action-bar-secondary">
              <button className="btn btn-outline" onClick={handleReset}>🔄 转换新文件</button>
            </div>
          </section>
        )}

        {/* ======== 对比预览 ======== */}
        {comparison && !comparison.error && (
          <section className="card">
            <h2>🔍 表格内容预览</h2>
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
          </section>
        )}
      </main>

      {/* 加载遮罩 */}
      {loading && (
        <div className="overlay">
          <div className="spinner" />
          <p>{loadingText}</p>
        </div>
      )}
    </div>
  )
}

export default App

