import React from 'react'
import { createRoot } from 'react-dom/client'
import Popout from './Popout'
import '../styles/global.css'
import '../styles/shared.css'
import './Popout.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Popout />
  </React.StrictMode>
)
