/**
 * GSAP 注册中心。
 *
 * 所有插件在这里集中注册一次，业务代码只 `import { gsap } from '@/lib/gsap'`。
 * 分散注册会有两个坑：
 *  1. 某个组件先 import 插件前就 new 了 timeline，插件还没挂上（表现为"动画完全没效果"）；
 *  2. 打包时被 tree-shake 掉，dev 正常、build 后失效。
 */
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { SplitText } from 'gsap/SplitText'
import { Flip } from 'gsap/Flip'
import { CustomEase } from 'gsap/CustomEase'

// SSR 保护：这些插件依赖 window，Node 预览构建时会炸
if (typeof window !== 'undefined') {
  gsap.registerPlugin(ScrollTrigger, SplitText, Flip, CustomEase)

  // "纸"的曲线：快进慢出，末端保留一点余速，像物体滑到停止而不是被切断
  CustomEase.create('csPaper', 'M0,0 C0.22,0.61 0.36,1 1,1')
  // "弹性入位"：用于标签滑块、开关
  CustomEase.create('csSnap', 'M0,0 C0.3,1.12 0.4,1 1,1')
  // "重物落地"：用于画布图片放入
  CustomEase.create('csDrop', 'M0,0 C0.4,0 0.2,1.35 1,1')

  gsap.defaults({ ease: 'csPaper', duration: 0.42 })
  // 后台标签页暂停补间，回来时续上（不是重置）
  gsap.ticker.lagSmoothing(500, 33)
}

export { gsap, ScrollTrigger, SplitText, Flip, CustomEase }
