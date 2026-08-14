/**
 * 3D 悬浮卡片（3D Tilt / Hover Card）
 * 鼠标移动时，卡片跟随指针轻微 3D 倾斜 + 抬升；移开后弹簧回正。
 * - 仅应用于 [data-tilt] 元素
 * - 仅精细指针 + 未开启减少动效时启用
 * - 激活后添加 .tilt-active：移除 CSS transform 过渡避免与逐帧 lerp 冲突
 */
export function initTilt() {
    if (window.__tiltInit) return
    window.__tiltInit = true

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (!window.matchMedia('(pointer: fine)').matches) return

    let lastX = -9999, lastY = -9999
    let raf = 0
    const targets = new Map()   // el -> { rx, ry, hover }

    const els = () => document.querySelectorAll('[data-tilt]')

    const loop = () => {
        raf = 0
        for (const el of els()) {
            const rect = el.getBoundingClientRect()
            if (!rect.width || !rect.height) continue
            const over = lastX >= rect.left && lastX <= rect.right &&
                lastY >= rect.top && lastY <= rect.bottom
            let cur = targets.get(el)
            if (!cur) { cur = { rx: 0, ry: 0, hover: false }; targets.set(el, cur) }
            if (over) {
                cur.hover = true
                el.classList.add('tilt-active')
                const dx = (lastX - (rect.left + rect.width / 2)) / (rect.width / 2)
                const dy = (lastY - (rect.top + rect.height / 2)) / (rect.height / 2)
                const targetRX = -dy * 5.5
                const targetRY = dx * 7
                cur.rx += (targetRX - cur.rx) * 0.14
                cur.ry += (targetRY - cur.ry) * 0.14
                el.style.transform =
                    `perspective(900px) rotateX(${cur.rx.toFixed(2)}deg) rotateY(${cur.ry.toFixed(2)}deg) translateY(-3px)`
            } else if (cur.hover) {
                cur.hover = false
                cur.rx += (0 - cur.rx) * 0.16
                cur.ry += (0 - cur.ry) * 0.16
                el.style.transform =
                    `perspective(900px) rotateX(${cur.rx.toFixed(2)}deg) rotateY(${cur.ry.toFixed(2)}deg)`
                if (Math.abs(cur.rx) < 0.04 && Math.abs(cur.ry) < 0.04) {
                    el.style.transform = ''
                    el.classList.remove('tilt-active')
                    targets.delete(el)
                }
            }
        }
    }

    const schedule = () => {
        if (!raf) raf = requestAnimationFrame(loop)
    }

    document.addEventListener('mousemove', (e) => {
        lastX = e.clientX
        lastY = e.clientY
        schedule()
    }, { passive: true })

    document.addEventListener('mouseleave', () => {
        lastX = -9999
        lastY = -9999
        schedule()
    }, { passive: true })
}
