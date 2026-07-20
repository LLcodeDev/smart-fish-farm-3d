import { defineConfig } from 'vite'

export default defineConfig({
  base: './',  // 相对路径，部署到任意位置都能用
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
})
