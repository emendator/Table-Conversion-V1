import { useEffect, useRef, useState } from 'react'

/**
 * 数字滚动（Count-up）
 * 数值变化时从旧值平滑滚动到新值（easeOutQuart），体现「数据流动感」。
 * - 尊重 prefers-reduced-motion：直接跳变到目标值
 * - 首次渲染不播放动画（直接显示初始值）
 */
export default function CountUp({ value, duration = 900, className = '' }) {
    const [display, setDisplay] = useState(value)
    const prevRef = useRef(value)

    useEffect(() => {
        const from = prevRef.current
        const to = value
        prevRef.current = to
        if (from === to) { setDisplay(to); return }
        if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            setDisplay(to)
            return
        }
        let raf = 0
        const start = performance.now()
        const tick = (now) => {
            const p = Math.min(1, (now - start) / duration)
            const eased = 1 - Math.pow(1 - p, 4)   // easeOutQuart
            setDisplay(Math.round(from + (to - from) * eased))
            if (p < 1) raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
    }, [value, duration])

    return <div className={className}>{display}</div>
}
