import '@radix-ui/themes/styles.css'
import '@fontsource-variable/caveat'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/fraunces'
import './styles.css'
import './theme-shell.css'
import { App } from './App'
import './interface.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
