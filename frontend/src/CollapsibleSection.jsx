import { useState, useEffect, useRef } from 'react'

/**
 * 可折叠模块卡片（下拉列表）
 * 点击标题栏即可展开 / 收起模块内容，节省页面空间。
 * 收起后可在标题旁显示模块简要内容（summary）。
 *
 * @param {ReactNode}  title       模块标题（可含 emoji）
 * @param {boolean}    [defaultOpen=true] 初始是否展开
 * @param {ReactNode}  [actions]   标题栏右侧附加操作（如按钮），点击不会触发折叠
 * @param {ReactNode}  [summary]   收起时在标题旁显示的模块简要内容
 * @param {boolean}    [collapsed] 外部触发收起（为 true 时自动收起，如匹配完成后）
 * @param {ReactNode}  children    模块内容
 */
export default function CollapsibleSection({ title, defaultOpen = true, actions, summary, collapsed, children }) {
    const [open, setOpen] = useState(defaultOpen)
    const prevCollapsed = useRef(collapsed)
    // 外部控制收起/展开：collapsed=true 时收起；
    // 解除收起（如重新进入匹配步骤）时自动展开（仅 true→false 转变时触发，不影响 defaultOpen）
    useEffect(() => {
        if (collapsed) setOpen(false)
        else if (prevCollapsed.current === true) setOpen(true)
        prevCollapsed.current = collapsed
    }, [collapsed])
    return (
        <section className={`card collapsible ${open ? 'collapsible-open' : 'collapsible-closed'}`}>
            <div className="collapse-header-row">
                <button
                    type="button"
                    className="collapse-header"
                    onClick={() => setOpen(o => !o)}
                    aria-expanded={open}
                    title={open ? '点击收起该模块' : '点击展开该模块'}
                >
                    <span className="collapse-title-wrap">
                        <span className="collapse-title">{title}</span>
                        {!open && summary && <span className="collapse-summary">{summary}</span>}
                    </span>
                    <span className={`collapse-arrow${open ? ' open' : ''}`}>{open ? '▾' : '▸'}</span>
                </button>
                {actions && <div className="collapse-actions">{actions}</div>}
            </div>
            {open && <div className="collapse-body">{children}</div>}
        </section>
    )
}
