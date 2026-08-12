import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './App.css'
import { initMagnetic } from './magnetic.js'

// 全局磁性吸附（所有按钮与图标）：光标靠近被吸附、移开弹回
initMagnetic()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
