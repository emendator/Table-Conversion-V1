import { useState, useEffect } from 'react'
import { motion, useMotionValue, useSpring } from 'framer-motion'

/**
 * 光标跟随柔光（Cursor Follow / Dynamic Cursor）
 * 一个随鼠标运动的柔光斑（弹簧缓动），给界面一层「追光」氛围。
 * - 仅在精细指针（鼠标/触控板）且未开启减少动效时启用
 * - pointer-events: none，不干扰任何交互
 */
export default function CursorGlow() {
    const [enabled, setEnabled] = useState(false)

    useEffect(() => {
        if (typeof window === 'undefined') return
        const fine = window.matchMedia('(pointer: fine)').matches
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        setEnabled(fine && !reduced)
    }, [])

    const x = useMotionValue(-600)
    const y = useMotionValue(-600)
    const sx = useSpring(x, { stiffness: 320, damping: 30, mass: 0.55 })
    const sy = useSpring(y, { stiffness: 320, damping: 30, mass: 0.55 })

    useEffect(() => {
        if (!enabled) return
        const onMove = (e) => { x.set(e.clientX); y.set(e.clientY) }
        window.addEventListener('mousemove', onMove, { passive: true })
        return () => window.removeEventListener('mousemove', onMove)
    }, [enabled, x, y])

    if (!enabled) return null

    return (
        <motion.div
            className="cursor-glow"
            aria-hidden="true"
            style={{ x: sx, y: sy, translateX: '-50%', translateY: '-50%' }}
        />
    )
}
