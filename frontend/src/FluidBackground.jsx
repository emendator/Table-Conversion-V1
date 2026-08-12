import { useEffect, useRef } from 'react'

/**
 * 太空流体背景（Canvas 2D）v4
 * - 氛围：深邃太空（深蓝黑 + 微弱青蓝星云），底色色相缓慢漂移
 * - 划痕：鼠标划过 → 暖黄色流光拖尾（圆头圆角、头亮尾渐隐）
 * - 点击涟漪：点击 → 多圈（4 圈）同心涟漪向外扩散 + 溅开粒子
 * - 星座交互：星点间的连线可被鼠标滑动/点击摧毁，缓慢自发重连；星点受鼠标拖拽/推开更强
 * - 自发变化：流星频繁划过、随机星座定时闪亮、星云/波浪持续缓动、底色色相缓慢漂移
 * - 尊重 prefers-reduced-motion：仅绘制一帧静态画面
 */
export default function FluidBackground({ density = 140 }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let W = 0, H = 0, DPR = 1
    let raf = 0
    let running = !reduced
    let t = 0

    const mouse = { x: -9999, y: -9999, px: -9999, py: -9999, vx: 0, vy: 0, active: false }
    const trail = []        // 划痕轨迹点 {x,y,age,spd}
    const clicks = []       // 点击涟漪圈 {x,y,r,maxR,alpha,seed,sway}
    const meteors = []      // 流星 {x,y,vx,vy,life,len,spd,col}
    const sparks = []       // 流光光尘 {x,y,vx,vy,life,r}
    let meteorTimers = []   // 4 个独立流星计时器（同一时间最多同时 4 颗流星）
    let nextFlash = 0
    let particles = []
    let nebulas = []

    const rand = (a, b) => a + Math.random() * (b - a)

    /* 在星点稀疏区域随机选一个重组位置（使整体分布更均匀） */
    const randomSparseHome = () => {
      const cols = 16, rows = 10
      const counts = new Array(cols * rows).fill(0)
      for (const p of particles) {
        const cx = Math.min(cols - 1, Math.max(0, Math.floor((p.x / W) * cols)))
        const cy = Math.min(rows - 1, Math.max(0, Math.floor((p.y / H) * rows)))
        counts[cy * cols + cx]++
      }
      // 星越少权重越大（空区域最可能被选中）
      let total = 0
      const weights = counts.map(c => { const w = 1 / (c + 0.6); total += w; return w })
      let r = Math.random() * total
      let idx = 0
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i]
        if (r <= 0) { idx = i; break }
      }
      const cx = idx % cols, cy = Math.floor(idx / cols)
      return {
        x: ((cx + rand(0.15, 0.85)) / cols) * W,
        y: ((cy + rand(0.15, 0.85)) / rows) * H,
      }
    }

    /* 在星点密集区域随机选一个重组位置（与稀疏相反，权重=格内星数） */
    const randomDenseHome = () => {
      const cols = 16, rows = 10
      const counts = new Array(cols * rows).fill(0)
      for (const p of particles) {
        const cx = Math.min(cols - 1, Math.max(0, Math.floor((p.x / W) * cols)))
        const cy = Math.min(rows - 1, Math.max(0, Math.floor((p.y / H) * rows)))
        counts[cy * cols + cx]++
      }
      // 星越多权重越大（密集区最可能被选中）
      let total = 0
      const weights = counts.map(c => { const w = c + 0.5; total += w; return w })
      let r = Math.random() * total
      let idx = 0
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i]
        if (r <= 0) { idx = i; break }
      }
      const cx = idx % cols, cy = Math.floor(idx / cols)
      return {
        x: ((cx + rand(0.15, 0.85)) / cols) * W,
        y: ((cy + rand(0.15, 0.85)) / rows) * H,
      }
    }

    /* 每次交互被打乱的星点，按比例分配新去向：
       1/3 偏稀疏区 · 1/3 偏密集区 · 2/9 完全随机 · 1/9 原地停留（返回 null） */
    const pickMoveHome = () => {
      const r = Math.random()
      if (r < 1 / 3) return randomSparseHome()
      if (r < 2 / 3) return randomDenseHome()
      if (r < 8 / 9) return { x: rand(0, W), y: rand(0, H) }
      return null
    }

    const makeNebulas = () => {
      nebulas = [
        { hue: 205, ox: -200, oy: -140, r: 430 },
        { hue: 225, ox: 220, oy: -120, r: 380 },
        { hue: 185, ox: -160, oy: 200, r: 360 },
      ].map(b => ({ ...b, x: rand(0, W), y: rand(0, H), wob: rand(0, Math.PI * 2) }))
    }

    const makeParticles = () => {
      const n = Math.min(density * 1.1, Math.max(90, Math.floor((W * H) / 7500) * 1.1))
      particles = Array.from({ length: n }, () => {
        const x = rand(0, W)
        const y = rand(0, H)
        return {
          x, y,
          homeX: x, homeY: y,          // 当前位置/目标位：被打乱后获得新的随机目标位（随机重组）
          vx: rand(-0.2, 0.2),
          vy: rand(-0.2, 0.2),
          r: rand(0.6, 1.7),
          tw: rand(0, Math.PI * 2),
          twSp: rand(0.02, 0.07),
          big: Math.random() < 0.22,
          disp: 0,                     // 连接被摧毁程度 0~1（缓慢恢复）
          flash: 0,                    // 星座闪亮程度（随机触发）
          lastHit: 0,                  // 上次被打乱的时间戳（用于随机重组防抖）
        }
      })
    }

    const resize = () => {
      DPR = Math.min(window.devicePixelRatio || 1, 1.5)
      W = window.innerWidth
      H = window.innerHeight
      canvas.width = Math.floor(W * DPR)
      canvas.height = Math.floor(H * DPR)
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      makeParticles()
      makeNebulas()
    }

    /* ---------- 水波交互 ---------- */
    const onMove = (e) => {
      mouse.px = mouse.x; mouse.py = mouse.y
      mouse.x = e.clientX; mouse.y = e.clientY
      mouse.vx = mouse.x - mouse.px
      mouse.vy = mouse.y - mouse.py
      mouse.active = true
      const speed = Math.hypot(mouse.vx, mouse.vy)
      if (speed > 0.3) {
        trail.push({ x: mouse.x, y: mouse.y, age: 0, spd: Math.min(speed, 22) })
        if (trail.length > 40) trail.shift()
      }
    }
    const onLeave = () => { mouse.active = false }
    const onDown = (e) => {
      const x = e.clientX, y = e.clientY
      // 点击：多圈同心涟漪向外扩散
      const rings = 4
      const gap = 30
      const base = rand(90, 130)
      for (let k = 0; k < rings; k++) {
        clicks.push({
          x, y,
          r: 4 + k * gap,
          maxR: base + k * gap + rand(10, 40),
          alpha: 0.72 * (1 - k * 0.14),
          seed: rand(0, Math.PI * 2),
          sway: 1.2 + k * 0.3,
        })
      }
      // 摧毁附近星座连接 + 溅开粒子 + 随机重组（星点获得新原位）
      for (const p of particles) {
        const dx = p.x - x, dy = p.y - y
        const d = Math.hypot(dx, dy) || 1
        if (d < 220) {
          p.disp = 1
          p.lastHit = performance.now()
          const home = pickMoveHome()
          if (home) { p.homeX = home.x; p.homeY = home.y }
          const f = (1 - d / 220) * 6
          p.vx += (dx / d) * f
          p.vy += (dy / d) * f
        }
      }
    }

    /* ---------- 绘制 ---------- */
    const drawBase = () => {
      const g = ctx.createLinearGradient(0, 0, W, H)
      g.addColorStop(0, '#04070F')
      g.addColorStop(0.5, '#071023')
      g.addColorStop(1, '#03050C')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
      // 底色色相缓慢漂移（自发变化，不单调）
      const pulse = 0.5 + Math.sin(t * 0.3) * 0.5
      const hue = 215 + Math.sin(t * 0.1) * 26 + Math.sin(t * 0.04) * 14
      const vg = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.7)
      vg.addColorStop(0, `hsla(${hue}, 60%, 32%, ${0.05 + pulse * 0.03})`)
      vg.addColorStop(1, 'hsla(0,0%,0%,0)')
      ctx.fillStyle = vg
      ctx.fillRect(0, 0, W, H)
    }

    const drawNebulas = () => {
      ctx.globalCompositeOperation = 'lighter'
      for (const b of nebulas) {
        b.wob += 0.004
        const wx = Math.sin(t * 0.2 + b.wob) * 70
        const wy = Math.cos(t * 0.16 + b.wob * 1.2) * 64
        let tx = W * 0.5 + wx, ty = H * 0.4 + wy
        if (mouse.active) {
          tx = mouse.x + b.ox + mouse.vx * 16 + wx * 0.4
          ty = mouse.y + b.oy + mouse.vy * 16 + wy * 0.4
        }
        b.x += (tx - b.x) * 0.012
        b.y += (ty - b.y) * 0.012
        const hue = (b.hue + Math.sin(t * 0.08) * 12) % 360
        const rg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r)
        rg.addColorStop(0, `hsla(${hue}, 80%, 52%, 0.13)`)
        rg.addColorStop(0.6, `hsla(${hue}, 85%, 45%, 0.05)`)
        rg.addColorStop(1, `hsla(${hue}, 90%, 40%, 0)`)
        ctx.fillStyle = rg
        ctx.beginPath()
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    const drawWaves = () => {
      const layers = [
        { base: H * 0.88, amp: 13, freq: 0.006, sp: 0.8, col: '120,180,255', a: 0.06 },
        { base: H * 0.95, amp: 17, freq: 0.004, sp: 0.5, col: '90,200,235', a: 0.055 },
      ]
      for (const L of layers) {
        ctx.beginPath()
        ctx.moveTo(0, H)
        for (let x = 0; x <= W; x += 8) {
          let amp = L.amp
          if (mouse.active) {
            const md = Math.abs(x - mouse.x)
            const speed = Math.hypot(mouse.vx, mouse.vy)
            if (md < 320) amp += (1 - md / 320) * 46 * Math.max(0.15, Math.min(1, speed * 0.16))
          }
          const y = L.base
            + Math.sin(x * L.freq + t * L.sp + L.base) * amp
            + Math.sin(x * L.freq * 0.5 - t * 0.4) * amp * 0.3
          ctx.lineTo(x, y)
        }
        ctx.lineTo(W, H)
        ctx.closePath()
        ctx.fillStyle = `rgba(${L.col},${L.a})`
        ctx.fill()
      }
    }

    /* 流光拖尾：径向光晕叠加成的「光」，而非线条。
       亮白头球（白核+暖晕）在前，柔光尾由重叠光晕渐隐，另有飘散的光尘。
       轨迹按 ~8px 细分 + 半径保底覆盖步距 → 任意移动速度都连续无断点 */
    const drawLightTrail = () => {
      if (trail.length < 2) return
      ctx.globalCompositeOperation = 'lighter'
      // 细分轨迹：沿路径每约 STEP 像素一个光晕点
      const STEP = 8
      const pts = []
      for (let i = 0; i < trail.length; i++) {
        const p = trail[i]
        if (i === 0) { pts.push({ x: p.x, y: p.y, age: p.age, spd: p.spd }); continue }
        const prev = trail[i - 1]
        const dx = p.x - prev.x, dy = p.y - prev.y
        const dist = Math.hypot(dx, dy)
        const seg = Math.max(1, Math.round(dist / STEP))
        for (let s = 1; s <= seg; s++) {
          const k = s / seg
          pts.push({
            x: prev.x + dx * k,
            y: prev.y + dy * k,
            age: prev.age + (p.age - prev.age) * k,
            spd: prev.spd + (p.spd - prev.spd) * k,
          })
        }
      }
      // 1) 柔光尾：重叠光晕（半径至少覆盖步距 → 连续）
      for (const p of pts) {
        const life = 1 - p.age
        if (life <= 0) continue
        const r = Math.max((6 + p.spd * 1.3) * (0.35 + life * 0.9), STEP * 0.7)
        const a = life * life * 0.27
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r)
        g.addColorStop(0, `rgba(255, 204, 102, ${a})`)
        g.addColorStop(0.45, `rgba(255, 172, 70, ${a * 0.5})`)
        g.addColorStop(1, 'rgba(255, 132, 36, 0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fill()
      }
      // 2) 头部光球：柔和暖黄（去白核，中心温和不刺眼）
      const head = trail[trail.length - 1]
      const hr = 8 + head.spd * 0.8
      const hg = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, hr * 2.3)
      hg.addColorStop(0, 'rgba(255, 206, 106, 0.22)')
      hg.addColorStop(0.3, 'rgba(255, 184, 86, 0.18)')
      hg.addColorStop(0.6, 'rgba(255, 156, 62, 0.12)')
      hg.addColorStop(1, 'rgba(255, 132, 36, 0)')
      ctx.fillStyle = hg
      ctx.beginPath()
      ctx.arc(head.x, head.y, hr * 2.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
    }

    /* 流光光尘：从光尾头部飘散的金色光点，渐隐 */
    const emitSparks = () => {
      if (!trail.length) return
      const head = trail[trail.length - 1]
      if (head.age > 0.15) return
      for (let k = 0; k < 2; k++) {
        sparks.push({
          x: head.x + rand(-2, 2),
          y: head.y + rand(-2, 2),
          vx: rand(-0.9, 0.9),
          vy: rand(-0.9, 0.9),
          life: rand(0.4, 0.9),
          r: rand(0.6, 1.8),
        })
      }
      if (sparks.length > 120) sparks.splice(0, sparks.length - 120)
    }

    const drawSparks = () => {
      ctx.globalCompositeOperation = 'lighter'
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i]
        s.x += s.vx
        s.y += s.vy
        s.vx *= 0.98
        s.vy *= 0.98
        s.life -= 0.012
        if (s.life <= 0) { sparks.splice(i, 1); continue }
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 3)
        g.addColorStop(0, `rgba(255, 230, 170, ${s.life * 0.85})`)
        g.addColorStop(1, 'rgba(255, 190, 90, 0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    /* 点击涟漪：多圈同心圈向外扩散 */
    const drawClicks = () => {
      ctx.globalCompositeOperation = 'lighter'
      for (let i = clicks.length - 1; i >= 0; i--) {
        const c = clicks[i]
        c.r += (c.maxR - c.r) * 0.1 + 1.4
        c.alpha *= 0.97
        if (c.alpha < 0.02 || c.r >= c.maxR * 1.8) { clicks.splice(i, 1); continue }
        ctx.strokeStyle = `rgba(165, 220, 255, ${c.alpha * 0.7})`
        ctx.lineWidth = 1.5
        ctx.beginPath()
        for (let a = 0; a < Math.PI * 2; a += 0.12) {
          const rr = c.r + Math.sin(a * 3 + t * 6 + c.seed) * (1.6 + c.sway)
          const x = c.x + Math.cos(a) * rr
          const y = c.y + Math.sin(a) * rr * 0.9
          if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.stroke()
        ctx.strokeStyle = `rgba(205, 235, 255, ${c.alpha * 0.35})`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(c.x, c.y, Math.max(1, c.r * 0.62), 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    /* 自发流动：流星从顶部跨全宽出现，斜向下划过（方向左右随机）。
       4 个独立计时器各自随机 → 同一时间最多同时出现 4 颗流星 */
    /* 自发流动：流星从顶部跨全宽出现，斜向下划过，100% 撞向星星最密集处 */
    const denseTarget = () => {
      // 网格(16×10)统计每格星数，找到星数最多的格子（最密集处）
      const cols = 16, rows = 10
      const counts = new Array(cols * rows).fill(0)
      for (const p of particles) {
        const cx = Math.min(cols - 1, Math.max(0, Math.floor((p.x / W) * cols)))
        const cy = Math.min(rows - 1, Math.max(0, Math.floor((p.y / H) * rows)))
        counts[cy * cols + cx]++
      }
      let bi = 0
      for (let i = 1; i < counts.length; i++) if (counts[i] > counts[bi]) bi = i
      const cx = bi % cols, cy = Math.floor(bi / cols)
      return {
        x: ((cx + 0.5) / cols) * W,                 // 最密集格中心 x
        y: ((cy + 0.5) / rows) * H,                 // 最密集格中心 y
        topX: ((cx + rand(0.15, 0.85)) / cols) * W, // 顶部出生 x（密集列上方）
      }
    }
    const spawnMeteor = () => {
      const y = rand(-120, -30)          // 顶部范围均匀随机
      let x, angle
      if (Math.random() < 0.5) {
        // 50%：精确瞄准星星最密集处（最密格中心）
        const t = denseTarget()
        x = t.topX
        angle = Math.atan2(t.y - y, t.x - x)
        if (angle < 0) angle += Math.PI * 2
        // 保护：若几乎水平/朝上，则夹取为斜向下
        if (Math.sin(angle) < 0.2) {
          angle = t.x >= x ? rand(0.4, 1.2) : Math.PI - rand(0.4, 1.2)
        }
      } else {
        // 50%：均匀随机位置与朝向
        x = rand(0, W)
        angle = Math.random() < 0.5 ? rand(0.4, 1.2) : Math.PI - rand(0.4, 1.2)
      }
      const spd = rand(4, 8)
      const cols = ['180,220,255', '235,245,255', '170,215,255', '210,230,255']
      meteors.push({
        x, y, vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd,
        life: 1, len: rand(200, 320), spd,
        col: cols[Math.floor(Math.random() * cols.length)],
      })
    }
    const maybeSpawnMeteor = () => {
      const now = performance.now()
      for (let i = 0; i < meteorTimers.length; i++) {
        if (now < meteorTimers[i]) continue
        meteorTimers[i] = now + rand(8000, 10000)
        spawnMeteor()
      }
    }

    const drawMeteors = () => {
      ctx.globalCompositeOperation = 'lighter'
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i]
        m.x += m.vx; m.y += m.vy
        const tx = m.x - (m.vx / m.spd) * m.len
        const ty = m.y - (m.vy / m.spd) * m.len
        // 移出屏幕才移除：头部与尾端（拖尾）都完全移出屏幕下边界，拖尾完整划过屏幕后才消失
        const outX = (m.x < -60 && tx < -60) || (m.x > W + 60 && tx > W + 60)
        const outY = m.y > H + 60 && ty > H + 60
        if (outX || outY) { meteors.splice(i, 1); continue }
        // 暖黄锥形尾：从头部到尾部逐渐变细收尖，末端轻微渐隐（不过度衰减）
        const steps = 44
        const spacing = m.len / steps
        for (let s = 0; s <= steps; s++) {
          const k = s / steps
          const px = tx + (m.x - tx) * k
          const py = ty + (m.y - ty) * k
          const headK = s / steps                     // 0=尾端 1=头部
          const fade = headK < 0.12 ? headK / 0.12 : 1
          // 锥形：尾部细(0.5x) → 头部粗(1.65x)，从头到尾逐渐变细
          const r = Math.max((6 + m.spd * 0.5) * (0.5 + headK * 1.15) * m.life, spacing * 0.5)
          // 亮度呼应锥形：尾部暗、头部亮（压低整体，避免头部叠加过亮）
          const a = m.life * (0.3 + headK * 0.14) * 0.55 * fade
          const g = ctx.createRadialGradient(px, py, 0, px, py, r)
          g.addColorStop(0, `rgba(255, 204, 102, ${a})`)
          g.addColorStop(0.45, `rgba(255, 172, 70, ${a * 0.5})`)
          g.addColorStop(1, 'rgba(255, 132, 36, 0)')
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(px, py, r, 0, Math.PI * 2)
          ctx.fill()
        }
        // 头部光球：柔和暖黄（去白核，中心不刺眼，比鼠标流光小一些）
        const hr = 4.5 + m.spd * 0.2
        const hg = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, hr * 2.3)
        hg.addColorStop(0, 'rgba(255, 206, 106, 0.24)')
        hg.addColorStop(0.25, 'rgba(255, 184, 86, 0.2)')
        hg.addColorStop(0.6, 'rgba(255, 156, 62, 0.14)')
        hg.addColorStop(1, 'rgba(255, 132, 36, 0)')
        ctx.fillStyle = hg
        ctx.beginPath()
        ctx.arc(m.x, m.y, hr * 2.5, 0, Math.PI * 2)
        ctx.fill()
        // 流星扰动附近星星：摧毁连接 + 按比例随机重组 + 沿流星方向强力推离（类似鼠标滑动）
        for (const p of particles) {
          const dx = p.x - m.x, dy = p.y - m.y
          const d = Math.hypot(dx, dy)
          if (d < 170 && d > 0.001) {
            const f = 1 - d / 170
            p.disp = Math.max(p.disp, f)
            if (f > 0.3 && performance.now() - (p.lastHit || 0) > 600) {
              p.lastHit = performance.now()
              const home = pickMoveHome()
              if (home) { p.homeX = home.x; p.homeY = home.y }
            }
            // 沿流星运动方向的扫过力（比鼠标更强）+ 径向推开
            p.vx += (m.vx / m.spd) * f * 3.4
            p.vy += (m.vy / m.spd) * f * 3.4
            p.vx += (dx / d) * f * 0.3
            p.vy += (dy / d) * f * 0.3
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    /* 自发流动：随机星座定时闪亮 */
    const maybeFlashConstellation = () => {
      if (performance.now() < nextFlash) return
      nextFlash = performance.now() + rand(3000, 6500)
      if (!particles.length) return
      const c = particles[Math.floor(Math.random() * particles.length)]
      for (const p of particles) {
        if (Math.hypot(p.x - c.x, p.y - c.y) < 135) p.flash = 1
      }
    }

    const drawParticles = () => {
      // 更新：鼠标移动时拖拽/推开并摧毁连接；静止后缓慢自发回连
      for (const p of particles) {
        const mSpeed = Math.hypot(mouse.vx, mouse.vy)
        if (mouse.active && mSpeed > 0.5) {
          const dx = p.x - mouse.x, dy = p.y - mouse.y
          const d = Math.hypot(dx, dy)
          if (d < 160 && d > 0.001) {
            const f = 1 - d / 160
            p.disp = Math.max(p.disp, f)          // 滑动摧毁星座连接
            // 打乱后随机重组：按比例分配去向（1/3 稀疏、1/3 密集、2/9 随机、1/9 原地），防抖
            if (f > 0.35 && performance.now() - (p.lastHit || 0) > 600) {
              p.lastHit = performance.now()
              const home = pickMoveHome()
              if (home) { p.homeX = home.x; p.homeY = home.y }
            }
            p.vx += mouse.vx * f * 0.16
            p.vy += mouse.vy * f * 0.16
            p.vx += (dx / d) * f * 0.2
            p.vy += (dy / d) * f * 0.2
          }
        }
        // 自发均匀化：少量星星每帧把目标位缓慢移向更稀疏的区域 → 移动后自发缓慢均匀布满全屏
        if (Math.random() < 0.0025) {
          const h = randomSparseHome()
          p.homeX += (h.x - p.homeX) * 0.05
          p.homeY += (h.y - p.homeY) * 0.05
        }
        // 缓慢自发回连（无振荡的指数趋近）
        p.x += (p.homeX - p.x) * 0.014
        p.y += (p.homeY - p.y) * 0.014
        p.disp *= 0.985     // 连接缓慢恢复
        p.flash *= 0.955    // 闪亮衰减
        p.vx *= 0.96
        p.vy *= 0.96
        const sp = Math.hypot(p.vx, p.vy)
        const max = 1.8
        if (sp > max) { p.vx *= max / sp; p.vy *= max / sp }
        p.x += p.vx
        p.y += p.vy
        // 屏幕内约束（不环绕，保证能回连）
        p.x = Math.min(W + 10, Math.max(-10, p.x))
        p.y = Math.min(H + 10, Math.max(-10, p.y))
      }
      // 星座连线（受 disp 影响：被鼠标摧毁的线淡出，缓慢恢复）
      ctx.globalCompositeOperation = 'lighter'
      const linkDist = 135
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i]
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j]
          const dx = a.x - b.x, dy = a.y - b.y
          const d = Math.hypot(dx, dy)
          if (d < linkDist) {
            const dmg = Math.max(a.disp, b.disp)
            if (dmg < 1) {
              ctx.strokeStyle = `rgba(150, 195, 255, ${(1 - d / linkDist) * 0.5 * (1 - dmg)})`
              ctx.lineWidth = 1
              ctx.beginPath()
              ctx.moveTo(a.x, a.y)
              ctx.lineTo(b.x, b.y)
              ctx.stroke()
            }
          }
        }
      }
      // 星点（闪烁 + 星座闪亮）
      for (const p of particles) {
        p.tw += p.twSp
        const tw = 0.45 + Math.sin(p.tw) * 0.3
        const boost = Math.min(1, 0.92 * tw + p.flash * 0.85)
        const rr = p.big ? p.r * 1.6 : p.r
        if (p.big) {
          const gg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr * 4.5)
          gg.addColorStop(0, `rgba(200, 228, 255, ${0.3 * boost})`)
          gg.addColorStop(1, 'rgba(200,228,255,0)')
          ctx.fillStyle = gg
          ctx.beginPath()
          ctx.arc(p.x, p.y, rr * 4.5, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.fillStyle = `rgba(220, 238, 255, ${boost})`
        ctx.beginPath()
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    const frame = () => {
      if (!running) return
      t += 0.006
      // 老化划痕轨迹
      for (let i = trail.length - 1; i >= 0; i--) {
        trail[i].age += 0.03
        if (trail[i].age > 1) trail.splice(i, 1)
      }
      emitSparks()
      maybeSpawnMeteor()
      maybeFlashConstellation()
      drawBase()
      drawNebulas()
      drawWaves()
      drawLightTrail()
      drawSparks()
      drawClicks()
      drawMeteors()
      drawParticles()
      raf = requestAnimationFrame(frame)
    }

    const drawOnce = () => {
      drawBase()
      ctx.globalCompositeOperation = 'lighter'
      for (const b of nebulas) {
        b.x = rand(0.2, 0.8) * W
        b.y = rand(0.2, 0.8) * H
        const rg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r)
        rg.addColorStop(0, `hsla(${b.hue}, 80%, 52%, 0.13)`)
        rg.addColorStop(1, 'hsla(0,0%,0%,0)')
        ctx.fillStyle = rg
        ctx.beginPath()
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      drawParticles()
    }

    const onVis = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!reduced) {
        running = true
        raf = requestAnimationFrame(frame)
      }
    }

    resize()
    // 4 个独立流星计时器：初始分别间隔 5 秒（0s/5s/10s/15s 各触发一次，均匀错开）
    meteorTimers = Array.from({ length: 4 }, (_, i) => performance.now() + i * 5000)
    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mousedown', onDown)
    document.addEventListener('mouseleave', onLeave)
    document.addEventListener('visibilitychange', onVis)
    if (reduced) drawOnce()
    else raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mousedown', onDown)
      document.removeEventListener('mouseleave', onLeave)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [density])

  return (
    <canvas
      ref={canvasRef}
      className="fluid-bg"
      aria-hidden="true"
    />
  )
}
