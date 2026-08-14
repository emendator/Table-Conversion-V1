/**
 * 点击涟漪（Ripple）
 * 点击按钮 / 可点击区域时，从点击处扩散一圈波纹。
 * - 事件委托 pointerdown，动画结束自动移除元素
 * - 尊重 prefers-reduced-motion：直接不启用
 * - 与磁性吸附 / 果冻回弹互不冲突（涟漪是内部子元素）
 */
export function initRipple() {
    if (window.__rippleInit) return
    window.__rippleInit = true

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const SELECTOR = [
        '.btn', '.nav-btn', '.btn-icon', '.tag-clickable', '.compare-tab',
        '.auth-capsule-btn', '.auth-mode-btn', '.upload-zone',
        '.lib-checkbox', '.collapse-header', '.step',
    ].join(', ')

    document.addEventListener('pointerdown', (e) => {
        const el = e.target.closest(SELECTOR)
        if (!el || el.disabled || el.closest('.no-ripple')) return
        const rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        const size = Math.max(rect.width, rect.height) * 2.2
        const span = document.createElement('span')
        span.className = 'ripple'
        span.style.width = size + 'px'
        span.style.height = size + 'px'
        span.style.left = (e.clientX - rect.left - size / 2) + 'px'
        span.style.top = (e.clientY - rect.top - size / 2) + 'px'
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
        el.appendChild(span)
        span.addEventListener('animationend', () => span.remove())
    }, { passive: true })
}
