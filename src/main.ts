import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Antd from 'antdv-next'
import App from './App.vue'
import router from './router'
import { useSettingsStore } from './stores/settings'
import { useThemeStore } from './stores/theme'
import 'antdv-next/dist/reset.css'
import './style.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(Antd)

useThemeStore().load()
useSettingsStore().load()

app.mount('#app')
