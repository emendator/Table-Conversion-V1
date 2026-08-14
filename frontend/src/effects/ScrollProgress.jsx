import { motion, useScroll, useSpring } from 'framer-motion'

/**
 * 阅读进度指示器（Reading Progress）
 * 页面顶部一条细渐变进度条，随滚动填满，指示当前浏览进度。
 * 弹簧缓动让进度条跟手但不突兀。
 */
export default function ScrollProgress() {
    const { scrollYProgress } = useScroll()
    const scaleX = useSpring(scrollYProgress, {
        stiffness: 140,
        damping: 28,
        restDelta: 0.001,
    })

    return (
        <motion.div
            className="scroll-progress"
            aria-hidden="true"
            style={{ scaleX }}
        />
    )
}
