/**
 * 磁性吸附（Magnetic Hover）
 * 所有按钮与关键图标在光标靠近时被轻微「吸附」过去，移开时平滑弹回。
 * 全局事件委托：mousemove 时遍历目标元素计算偏移，写入 inline transform。
 * - 果冻回弹（:active animation）优先级高于 inline transform，按下时不冲突
 * - hover 时叠加 -1.5px 抬升，保留原有悬浮感
 * - rAF 节流，仅处理距离光标范围内的元素
 */
export function initMagnetic() {
    if (window.__magneticInit) return
    window.__magneticInit = true

    const targets = () => {
        const list = document.querySelectorAll(
            'button, a, [role="button"], [data-magnetic], label, .upload-zone, .collapse-header, .tag-clickable, .compare-tab, .step, .nav-btn, .auth-capsule-btn, .auth-mode-btn, .btn-icon, .lib-arrow, .auth-logo-inline, .header-logo, .user-avatar, .step-num, .role-badge'
        )
        const out = []
        for (const el of list) {
            // button / 链接 / role=button / data-magnetic：无条件吸附
            if (el.matches('button, a, [role="button"], [data-magnetic]')) { out.push(el); continue }
            if (el.disabled) continue
            // 其余（label、可点击 div/span 等）：按 cursor:pointer 自动识别为可交互 → 吸附
            if (getComputedStyle(el).cursor === 'pointer') out.push(el)
        }
        return out
    }

    const reset = () => {
        for (const el of targets()) {
            el.style.transform = ''
            el.classList.remove('magnetic-on')
        }
    }

    let raf = 0
    const onMove = (e) => {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => {
            const els = targets()
            // 1) 先找出光标范围内「最近」的一个目标（同一时间只吸附最近的一个）
            let nearest = null
            let nearestDist = Infinity
            let nearestRange = 0
            for (let i = 0; i < els.length; i++) {
                const el = els[i]
                if (el.disabled || el.closest('.no-magnetic')) continue
                const r = el.getBoundingClientRect()
                if (!r.width && !r.height) continue
                const cx = r.left + r.width / 2
                const cy = r.top + r.height / 2
                const dx = e.clientX - cx
                const dy = e.clientY - cy
                const dist = Math.hypot(dx, dy)
                const range = Math.max(70, Math.min(170, r.width * 0.8))
                if (dist < range && dist < nearestDist) {
                    nearest = el
                    nearestDist = dist
                    nearestRange = range
                }
            }
            // 2) 只吸附最近的一个，其余恢复原位
            for (let i = 0; i < els.length; i++) {
                const el = els[i]
                if (el === nearest) continue
                if (el.classList.contains('magnetic-on')) {
                    el.style.transform = ''
                    el.classList.remove('magnetic-on')
                }
            }
            if (nearest) {
                const r = nearest.getBoundingClientRect()
                const cx = r.left + r.width / 2
                const cy = r.top + r.height / 2
                const dx = e.clientX - cx
                const dy = e.clientY - cy
                const s = 0.5 * (1 - nearestDist / nearestRange)
                const lift = nearest.matches(':hover') ? -1.5 : 0
                nearest.style.transform = `translate(${(dx * s).toFixed(1)}px, ${(dy * s + lift).toFixed(1)}px)`
                nearest.classList.add('magnetic-on')
            }
        })
    }

    document.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseleave', reset, { passive: true })
    window.addEventListener('blur', reset, { passive: true })
}
