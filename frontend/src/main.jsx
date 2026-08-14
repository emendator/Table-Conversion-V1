import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './App.css'
import { initMagnetic } from './magnetic.js'
import { initRipple } from './effects/ripple.js'
import { initTilt } from './effects/tilt.js'
import CursorGlow from './effects/CursorGlow.jsx'

// 全局磁性吸附（所有按钮与图标）：光标靠近被吸附、移开弹回
initMagnetic()
// 点击涟漪：按钮按下处扩散波纹
initRipple()
// 3D 悬浮卡片：仅对 [data-tilt] 元素生效（数据概览卡片等）
initTilt()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <CursorGlow />
    <App />
  </StrictMode>,
)
