import { useEffect, useId, useRef } from "react";
import { gsap } from "@/lib/gsap";
import { shouldReduceMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** 轨道：倾角 / 半径 / 节点数 / 角速度（弧度每秒）。倾角不同，三条轨道才有立体交错感。 */
const ORBITS = [
  { tilt: -18, rx: 104, ry: 34, nodes: 3, speed: 0.42 },
  { tilt: 34, rx: 92, ry: 30, nodes: 2, speed: -0.58 },
  { tilt: 88, rx: 82, ry: 26, nodes: 2, speed: 0.74 },
] as const;

/** 节点配色：配色1 的三色轮转（蓝 #598BFD / 青 #35B3C9 / 薄荷 #9AD4CB） */
const NODE_COLORS = ["#598BFD", "#35B3C9", "#9AD4CB"] as const;

const C = 120; // viewBox 中心

interface NodeRef {
  dot: SVGCircleElement | null;
  link: SVGLineElement | null;
  orbit: number;
  phase: number;
}

/**
 * Agent 核心：一颗「会思考」的信号球。
 *
 * 视觉语言：中心是青柠信号色的核（= Agent 本体），三条倾斜轨道上的节点
 * 是它正在调度的技能 / 模型；核与节点之间的连线随节点深度明暗变化，
 * 像神经元在传递信号。
 *
 * 实现取舍：
 * - 节点沿椭圆运动无法用纯 transform 表达，所以用**一个** gsap.ticker 回调
 *   统一写 cx/cy（属性写入不触发布局，7 个节点的开销可以忽略）；
 * - 离开视口就把 ticker 摘掉，首页往下滚时不在后台白白跑；
 * - 减弱动效 / 低性能设备只画一帧静态构图。
 */
export function AgentCore({ className }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<SVGGElement>(null);
  const coreRef = useRef<SVGGElement>(null);
  const haloRef = useRef<SVGCircleElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const nodesRef = useRef<NodeRef[]>([]);
  const gradId = useId().replace(/:/g, "");

  // 每条轨道上的节点均匀分布，初始相位错开
  if (nodesRef.current.length === 0) {
    ORBITS.forEach((orbit, orbitIndex) => {
      for (let i = 0; i < orbit.nodes; i += 1) {
        nodesRef.current.push({
          dot: null,
          link: null,
          orbit: orbitIndex,
          phase: (Math.PI * 2 * i) / orbit.nodes + orbitIndex * 0.9,
        });
      }
    });
  }

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let elapsed = 0;
    /** 按当前时间把节点摆到椭圆上；sin<0 视为「在核后面」，变暗变小 */
    const place = () => {
      nodesRef.current.forEach((node) => {
        const orbit = ORBITS[node.orbit];
        const angle = node.phase + elapsed * orbit.speed;
        const rad = (orbit.tilt * Math.PI) / 180;
        const ex = Math.cos(angle) * orbit.rx;
        const ey = Math.sin(angle) * orbit.ry;
        const x = C + ex * Math.cos(rad) - ey * Math.sin(rad);
        const y = C + ex * Math.sin(rad) + ey * Math.cos(rad);
        const depth = (Math.sin(angle) + 1) / 2; // 0 = 后，1 = 前
        if (node.dot) {
          node.dot.setAttribute("cx", x.toFixed(2));
          node.dot.setAttribute("cy", y.toFixed(2));
          node.dot.setAttribute("r", (2.2 + depth * 2.6).toFixed(2));
          node.dot.style.opacity = String(0.35 + depth * 0.65);
        }
        if (node.link) {
          node.link.setAttribute("x2", x.toFixed(2));
          node.link.setAttribute("y2", y.toFixed(2));
          node.link.style.opacity = String(0.08 + depth * 0.42);
        }
      });
    };

    place();
    if (shouldReduceMotion()) return;

    const tick = (_time: number, deltaTime: number) => {
      // deltaTime 是毫秒；切后台回来时 lagSmoothing 已经把它压住，不会一下转半圈
      elapsed += deltaTime / 1000;
      place();
    };

    /** 循环补间单独收集：离开视口时整体暂停，回来再续上 */
    const loops: gsap.core.Tween[] = [];
    const ctx = gsap.context(() => {
      // 核心呼吸：缩放幅度很小，读起来像"在运转"而不是"在跳"
      loops.push(
        gsap.to(coreRef.current, {
          scale: 1.06,
          svgOrigin: `${C} ${C}`,
          duration: 2.2,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        }),
      );
      // 信号波：从核向外扩散后淡出，每 2.8s 一次
      loops.push(
        gsap.fromTo(
          haloRef.current,
          { scale: 0.7, opacity: 0.5, svgOrigin: `${C} ${C}` },
          {
            scale: 2.1,
            opacity: 0,
            duration: 2.8,
            ease: "power2.out",
            repeat: -1,
          },
        ),
      );
      // 内环虚线慢转：给核一个"齿轮在咬合"的细节
      loops.push(
        gsap.to(ringRef.current, {
          rotation: 360,
          svgOrigin: `${C} ${C}`,
          duration: 26,
          ease: "none",
          repeat: -1,
        }),
      );
    }, root);

    // 指针视差：整组轨道轻微偏转，quickTo 合并同帧多次调用，不会堆积补间
    const tilt = tiltRef.current;
    const toX = tilt
      ? gsap.quickTo(tilt, "x", { duration: 1.2, ease: "power3.out" })
      : null;
    const toY = tilt
      ? gsap.quickTo(tilt, "y", { duration: 1.2, ease: "power3.out" })
      : null;
    const onMove = (event: PointerEvent) => {
      toX?.((event.clientX / window.innerWidth - 0.5) * 14);
      toY?.((event.clientY / window.innerHeight - 0.5) * 10);
    };

    let running = false;
    const start = () => {
      if (running) return;
      running = true;
      gsap.ticker.add(tick);
      loops.forEach((tween) => tween.resume());
    };
    const stop = () => {
      if (!running) return;
      running = false;
      gsap.ticker.remove(tick);
      loops.forEach((tween) => tween.pause());
    };

    const io = new IntersectionObserver(([entry]) =>
      entry.isIntersecting ? start() : stop(),
    );
    io.observe(root);
    start();
    window.addEventListener("pointermove", onMove, { passive: true });

    return () => {
      io.disconnect();
      stop();
      window.removeEventListener("pointermove", onMove);
      ctx.revert();
    };
  }, []);

  let nodeIndex = 0;

  return (
    <div
      ref={rootRef}
      aria-hidden
      className={cn("pointer-events-none relative aspect-square", className)}
    >
      {/* 外层弥散光：蓝 + 薄荷两团叠在 SVG 后面，和首页环境光同一套色，
          核的边缘因此没有硬轮廓，像"浮在光里"而不是贴一张图 */}
      <div className="absolute inset-[16%] rounded-full bg-[#598BFD]/30 blur-[46px]" />
      <div className="absolute inset-[27%] rounded-full bg-[#9AD4CB]/45 blur-[28px]" />
      <svg
        viewBox="0 0 240 240"
        className="relative h-full w-full overflow-visible"
      >
        <defs>
          {/* 核：亮部偏左上（薄荷），底色落到深青，避开"塑料球"的均匀渐变 */}
          <radialGradient id={`${gradId}-core`} cx="34%" cy="26%" r="82%">
            <stop offset="0%" stopColor="#F4FDFF" />
            <stop offset="24%" stopColor="#9AD4CB" />
            <stop offset="58%" stopColor="#35B3C9" />
            <stop offset="100%" stopColor="#1C6FA6" />
          </radialGradient>
          {/* 轨道：蓝 → 青 → 薄荷，和全站弥散渐变同向，替换原来的暖米色 */}
          <linearGradient id={`${gradId}-orbit`} x1="6%" y1="0%" x2="94%" y2="100%">
            <stop offset="0%" stopColor="#598BFD" />
            <stop offset="52%" stopColor="#35B3C9" />
            <stop offset="100%" stopColor="#9AD4CB" />
          </linearGradient>
        </defs>

        <g ref={tiltRef}>
          {/* 轨道线 */}
          {ORBITS.map((orbit, index) => (
            <ellipse
              key={`orbit-${index}`}
              cx={C}
              cy={C}
              rx={orbit.rx}
              ry={orbit.ry}
              transform={`rotate(${orbit.tilt} ${C} ${C})`}
              fill="none"
              strokeWidth={index === 0 ? 1.2 : 1}
              strokeDasharray={index === 1 ? "2 5" : undefined}
              style={{ stroke: `url(#${gradId}-orbit)`, opacity: 0.5 + index * 0.08 }}
            />
          ))}

          {/* 神经连线：核 → 节点 */}
          {nodesRef.current.map((node, index) => (
            <line
              key={`link-${index}`}
              ref={(el) => {
                node.link = el;
              }}
              x1={C}
              y1={C}
              x2={C}
              y2={C}
              strokeWidth={1}
              strokeLinecap="round"
              style={{ stroke: `url(#${gradId}-orbit)` }}
            />
          ))}

          {/* 核 */}
          <circle
            ref={haloRef}
            cx={C}
            cy={C}
            r={34}
            fill="none"
            strokeWidth={1.5}
            style={{ stroke: "var(--color-brand-blue)" }}
          />
          <circle
            ref={ringRef}
            cx={C}
            cy={C}
            r={45}
            fill="none"
            strokeWidth={1}
            strokeDasharray="1 6"
            strokeLinecap="round"
            style={{ stroke: "var(--color-brand-mint)", opacity: 0.7 }}
          />
          <g ref={coreRef}>
            <circle cx={C} cy={C} r={32} fill={`url(#${gradId}-core)`} />
            {/* 玻璃感：先一层内侧高光收边，再在左上压一个柔和的反光点 */}
            <circle
              cx={C}
              cy={C}
              r={31.4}
              fill="none"
              strokeWidth={1.2}
              style={{ stroke: "rgba(255,255,255,0.55)" }}
            />
            <ellipse
              cx={109}
              cy={105}
              rx={13}
              ry={9}
              transform="rotate(-24 109 105)"
              style={{ fill: "rgba(255,255,255,0.42)", filter: "blur(1.6px)" }}
            />
            {/* 四芒星：Agent 的「火花」。改成白色 + 外发光，
                压在蓝青渐变球上比深墨更像"光"，也不会在暗色主题里糊成一个黑块 */}
            <path
              d="M120 104 C121.6 114 126 118.4 136 120 C126 121.6 121.6 126 120 136 C118.4 126 114 121.6 104 120 C114 118.4 118.4 114 120 104 Z"
              style={{
                fill: "#FFFFFF",
                filter: "drop-shadow(0 1px 6px rgba(12,66,120,0.55))",
              }}
            />
          </g>

          {/* 节点：技能 / 模型 */}
          {ORBITS.map((orbit, orbitIndex) =>
            Array.from({ length: orbit.nodes }).map((_, i) => {
              const node = nodesRef.current[nodeIndex];
              nodeIndex += 1;
              return (
                <circle
                  key={`node-${orbitIndex}-${i}`}
                  ref={(el) => {
                    node.dot = el;
                  }}
                  cx={C}
                  cy={C}
                  r={3}
                  // 三个节点色轮着来（蓝 / 青 / 薄荷），并用纸色描一圈，
                  // 压到轨道线上时不会糊成一个点，像「被挖出来」的信号
                  stroke="var(--color-surface)"
                  strokeWidth={1}
                  style={{ fill: NODE_COLORS[(orbitIndex * 3 + i) % NODE_COLORS.length] }}
                />
              );
            }),
          )}
        </g>
      </svg>
    </div>
  );
}
