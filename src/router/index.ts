import { createRouter, createWebHistory } from 'vue-router'
import ProjectList from '@/views/ProjectList.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: ProjectList },
    {
      path: '/p/:id',
      component: () => import('@/views/CanvasView.vue'),
    },
  ],
})

export default router
