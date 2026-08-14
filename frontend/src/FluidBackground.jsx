import { useEffect, useRef } from 'react'

/**
 * 极光流体背景（Canvas 2D）v5 —— 登录页高级氛围
 * 分层渲染（由远到近）：
 *   1. 底色：深邃太空渐变 + 色相缓慢漂移的辉光
 *   2. 丁达尔光线（God Rays）：顶部 3 束柔和光柱，缓慢摇摆 + 呼吸
 *   3. 极光幕帘（Aurora）：3 层正弦流光幕帘（靛/紫/青），叠加 'lighter'，跟随鼠标轻微倾斜
 *   4. 星云视差：多层大光斑，按深度(dep)不同速度跟随鼠标（视差分层）
 *   5. 底部波浪 + 鼠标暖黄流光拖尾 + 点击涟漪（保留）
 *   6. 流星划过（瞄准星群最密处）+ 星座连线/闪亮 + 光尘（保留）
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
    let meteorTimers = []   // 4 个独立流星计时器
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

    /* 每次交互被打乱的星点，按比例分配新去向（1/3 稀疏 · 1/3 密集 · 2/9 随机 · 1/9 原地） */
    const pickMoveHome = () => {
      const r = Math.random()
      if (r < 1 / 3) return randomSparseHome()
      if (r < 2 / 3) return randomDenseHome()
      if (r < 8 / 9) return { x: rand(0, W), y: rand(0, H) }
      return null
    }

    /* ---------- 星云（视差层）：dep = 深度（越大跟随鼠标越快） ---------- */
    const makeNebulas = () => {
      nebulas = [
        { hue: 245, ox: -220, oy: -160, r: 460, dep: 0.35 },
        { hue: 270, ox: 240, oy: -140, r: 400, dep: 0.55 },
        { hue: 200, ox: -180, oy: 210, r: 380, dep: 0.45 },
        { hue: 185, ox: 160, oy: 240, r: 340, dep: 0.7 },
      ].map(b => ({ ...b, x: rand(0, W), y: rand(0, H), wob: rand(0, Math.PI * 2) }))
    }

    const makeParticles = () => {
      const n = Math.min(density * 1.1, Math.max(90, Math.floor((W * H) / 7500) * 1.1))
      particles = Array.from({ length: n }, () => {
        const x = rand(0, W)
        const y = rand(0, H)
        return {
          x, y,
          homeX: x, homeY: y,
          vx: rand(-0.2, 0.2),
          vy: rand(-0.2, 0.2),
          r: rand(0.6, 1.7),
          tw: rand(0, Math.PI * 2),
          twSp: rand(0.02, 0.07),
          big: Math.random() < 0.22,
          disp: 0,
          flash: 0,
          lastHit: 0,
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

    /* ---------- 绘制：底色 ---------- */
    const drawBase = () => {
      const g = ctx.createLinearGradient(0, 0, W, H)
      g.addColorStop(0, '#02030A')
      g.addColorStop(0.5, '#0A0E24')
      g.addColorStop(1, '#03040E')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
      // 底色色相缓慢漂移（自发变化，不单调）
      const pulse = 0.5 + Math.sin(t * 0.3) * 0.5
      const hue = 248 + Math.sin(t * 0.1) * 24 + Math.sin(t * 0.04) * 12
      const vg = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, Math.max(W, H) * 0.72)
      vg.addColorStop(0, `hsla(${hue}, 65%, 34%, ${0.06 + pulse * 0.035})`)
      vg.addColorStop(1, 'hsla(0,0%,0%,0)')
      ctx.fillStyle = vg
      ctx.fillRect(0, 0, W, H)
    }

    /* ---------- 绘制：星云视差 ---------- */
    const drawNebulas = () => {
      ctx.globalCompositeOperation = 'lighter'
      for (const b of nebulas) {
        b.wob += 0.004
        const wx = Math.sin(t * 0.2 + b.wob) * 70
        const wy = Math.cos(t * 0.16 + b.wob * 1.2) * 64
        let tx = W * 0.5 + wx, ty = H * 0.4 + wy
        if (mouse.active) {
          // 深度视差：dep 越深跟随越快
          tx = mouse.x + b.ox * b.dep + mouse.vx * 14 * b.dep + wx * 0.4
          ty = mouse.y + b.oy * b.dep + mouse.vy * 14 * b.dep + wy * 0.4
        }
        b.x += (tx - b.x) * 0.012
        b.y += (ty - b.y) * 0.012
        const hue = (b.hue + Math.sin(t * 0.08) * 12) % 360
        const rg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r)
        rg.addColorStop(0, `hsla(${hue}, 82%, 54%, 0.12)`)
        rg.addColorStop(0.6, `hsla(${hue}, 88%, 46%, 0.05)`)
        rg.addColorStop(1, `hsla(${hue}, 92%, 40%, 0)`)
        ctx.fillStyle = rg
        ctx.beginPath()
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    /* ---------- 绘制：极光幕帘（Aurora） ----------
       每层 = 一条随 x 正弦起伏的带状区域（上边缘波形 + 下边缘波形），
       上下边缘波形频率/相位不同 → 产生「幕帘飘动」感 */
    const aurora = [
      { hue: 255, h2: 210, base: 0.28, amp: 70, f1: 0.0036, s1: 0.55, f2: 0.0082, s2: -0.8, height: 230, alpha: 0.10, dep: 0.5 },
      { hue: 285, h2: 250, base: 0.40, amp: 92, f1: 0.0028, s1: -0.42, f2: 0.0065, s2: 0.6, height: 280, alpha: 0.08, dep: 0.85 },
      { hue: 195, h2: 230, base: 0.54, amp: 62, f1: 0.0044, s1: 0.36, f2: 0.0090, s2: -0.5, height: 190, alpha: 0.065, dep: 0.3 },
    ]

    const drawAurora = () => {
      ctx.globalCompositeOperation = 'lighter'
      const mx = mouse.active ? (mouse.x / W - 0.5) * 2 : 0
      for (const A of aurora) {
        const baseY = H * A.base
        const top = []
        for (let x = -24; x <= W + 24; x += 8) {
          top.push({
            x,
            y: baseY
              + Math.sin(x * A.f1 + t * A.s1) * A.amp
              + Math.sin(x * A.f2 - t * A.s2) * A.amp * 0.45
              + mx * A.dep * 46,
          })
        }
        ctx.beginPath()
        ctx.moveTo(top[0].x, top[0].y)
        for (const p of top) ctx.lineTo(p.x, p.y)
        for (let i = top.length - 1; i >= 0; i--) {
          const p = top[i]
          const h = A.height
            + Math.sin(p.x * 0.0055 + t * 0.5 + A.dep * 3) * A.height * 0.38
          ctx.lineTo(p.x, p.y + h)
        }
        ctx.closePath()
        const g = ctx.createLinearGradient(0, baseY - A.amp - 60, 0, baseY + A.height + 80)
        g.addColorStop(0, `hsla(${A.hue}, 88%, 64%, ${A.alpha})`)
        g.addColorStop(0.55, `hsla(${A.h2}, 92%, 60%, ${A.alpha * 0.55})`)
        g.addColorStop(1, 'hsla(0, 0%, 0%, 0)')
        ctx.fillStyle = g
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    /* ---------- 绘制：丁达尔光线（God Rays） ---------- */
    const rays = [
      { ox: 0.5, oy: -70, len: 0.95, w: 34, a: 0.04, sp: 0.1, ph: 0 },
      { ox: 0.16, oy: -50, len: 0.78, w: 24, a: 0.028, sp: -0.08, ph: 2.1 },
      { ox: 0.84, oy: -50, len: 0.8, w: 26, a: 0.032, sp: 0.07, ph: 4.2 },
    ]

    const drawRays = () => {
      ctx.globalCompositeOperation = 'lighter'
      for (const R of rays) {
        const breathe = 0.62 + 0.38 * Math.sin(t * 0.3 + R.ph)
        const sway = Math.sin(t * R.sp + R.ph) * 0.4
        const ox = W * R.ox, oy = R.oy
        const len = Math.max(W, H) * R.len
        const ex = ox + sway * len * 0.12
        const ey = oy + len
        const w = R.w * (0.55 + breathe * 0.45)
        const g = ctx.createLinearGradient(ox, oy, ex, ey)
        g.addColorStop(0, `hsla(205, 95%, 82%, ${R.a * breathe})`)
        g.addColorStop(0.55, `hsla(215, 90%, 72%, ${R.a * breathe * 0.45})`)
        g.addColorStop(1, 'hsla(215, 90%, 72%, 0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.moveTo(ox, oy)
        ctx.lineTo(ex - w, ey)
        ctx.lineTo(ex + w, ey)
        ctx.closePath()
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    const drawWaves = () => {
      const layers = [
        { base: H * 0.9, amp: 13, freq: 0.006, sp: 0.8, col: '140,190,255', a: 0.06 },
        { base: H * 0.96, amp: 17, freq: 0.004, sp: 0.5, col: '110,200,240', a: 0.05 },
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

    /* 流光拖尾：径向光晕叠加成的「光」，而非线条 */
    const drawLightTrail = () => {
      if (trail.length < 2) return
      ctx.globalCompositeOperation = 'lighter'
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

    /* ---------- 流星：100% 撞向星星最密集处 ---------- */
    const denseTarget = () => {
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
        x: ((cx + 0.5) / cols) * W,
        y: ((cy + 0.5) / rows) * H,
        topX: ((cx + rand(0.15, 0.85)) / cols) * W,
      }
    }
    const spawnMeteor = () => {
      const y = rand(-120, -30)
      let x, angle
      if (Math.random() < 0.5) {
        const tgt = denseTarget()
        x = tgt.topX
        angle = Math.atan2(tgt.y - y, tgt.x - x)
        if (angle < 0) angle += Math.PI * 2
        if (Math.sin(angle) < 0.2) {
          angle = tgt.x >= x ? rand(0.4, 1.2) : Math.PI - rand(0.4, 1.2)
        }
      } else {
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
        const outX = (m.x < -60 && tx < -60) || (m.x > W + 60 && tx > W + 60)
        const outY = m.y > H + 60 && ty > H + 60
        if (outX || outY) { meteors.splice(i, 1); continue }
        const steps = 44
        const spacing = m.len / steps
        for (let s = 0; s <= steps; s++) {
          const k = s / steps
          const px = tx + (m.x - tx) * k
          const py = ty + (m.y - ty) * k
          const headK = s / steps
          const fade = headK < 0.12 ? headK / 0.12 : 1
          const r = Math.max((6 + m.spd * 0.5) * (0.5 + headK * 1.15) * m.life, spacing * 0.5)
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
      for (const p of particles) {
        const mSpeed = Math.hypot(mouse.vx, mouse.vy)
        if (mouse.active && mSpeed > 0.5) {
          const dx = p.x - mouse.x, dy = p.y - mouse.y
          const d = Math.hypot(dx, dy)
          if (d < 160 && d > 0.001) {
            const f = 1 - d / 160
            p.disp = Math.max(p.disp, f)
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
        if (Math.random() < 0.0025) {
          const h = randomSparseHome()
          p.homeX += (h.x - p.homeX) * 0.05
          p.homeY += (h.y - p.homeY) * 0.05
        }
        p.x += (p.homeX - p.x) * 0.014
        p.y += (p.homeY - p.y) * 0.014
        p.disp *= 0.985
        p.flash *= 0.955
        p.vx *= 0.96
        p.vy *= 0.96
        const sp = Math.hypot(p.vx, p.vy)
        const max = 1.8
        if (sp > max) { p.vx *= max / sp; p.vy *= max / sp }
        p.x += p.vx
        p.y += p.vy
        p.x = Math.min(W + 10, Math.max(-10, p.x))
        p.y = Math.min(H + 10, Math.max(-10, p.y))
      }
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
              ctx.strokeStyle = `rgba(160, 200, 255, ${(1 - d / linkDist) * 0.5 * (1 - dmg)})`
              ctx.lineWidth = 1
              ctx.beginPath()
              ctx.moveTo(a.x, a.y)
              ctx.lineTo(b.x, b.y)
              ctx.stroke()
            }
          }
        }
      }
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
      for (let i = trail.length - 1; i >= 0; i--) {
        trail[i].age += 0.03
        if (trail[i].age > 1) trail.splice(i, 1)
      }
      emitSparks()
      maybeSpawnMeteor()
      maybeFlashConstellation()
      drawBase()
      drawNebulas()
      drawAurora()
      drawRays()
      drawWaves()
      drawLightTrail()
      drawSparks()
      drawClicks()
      drawMeteors()
      drawParticles()
      raf = requestAnimationFrame(frame)
    }

    /* 减少动效：仅静态绘制一帧（含极光/光线，呈现静帧氛围） */
    const drawOnce = () => {
      drawBase()
      ctx.globalCompositeOperation = 'lighter'
      for (const b of nebulas) {
        b.x = rand(0.2, 0.8) * W
        b.y = rand(0.2, 0.8) * H
        const rg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r)
        rg.addColorStop(0, `hsla(${b.hue}, 82%, 54%, 0.12)`)
        rg.addColorStop(1, 'hsla(0,0%,0%,0)')
        ctx.fillStyle = rg
        ctx.beginPath()
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      drawAurora()
      drawRays()
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
