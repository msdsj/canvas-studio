import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    TanStackRouterVite({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 27180,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:27181',
        changeOrigin: true,
        // 协作通道走 WebSocket：代理不显式开 ws 的话握手会被当普通 HTTP 转发，
        // 浏览器侧表现为「连上就断、一直重连」。开发环境没有它协作根本跑不起来。
        ws: true,
        // 长连接不能有超时：默认值会让空闲画布隔一会儿就掉线重连一次
        timeout: 0,
        proxyTimeout: 0,
      },
      '/static': {
        target: 'http://127.0.0.1:27181',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
