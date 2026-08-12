<script lang="ts">
  import { onMount } from 'svelte'
  import { cssVar, resolveColor } from './cssVar.ts'
  import { themeStore } from './theme.svelte.ts'

  interface Point { date: string; value: string }

  let {
    points = [],
    label = '',
    color = 'var(--accent)',
    height = 200,
    formatY = (v: number) => `£${v.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
  }: {
    points?: Point[]
    label?: string
    color?: string
    height?: number
    formatY?: (v: number) => string
  } = $props()

  let canvas: HTMLCanvasElement = $state()!
  let container: HTMLDivElement = $state()!

  function draw() {
    if (!canvas || points.length === 0) return
    const ctx = canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    const W = container.clientWidth
    const H = height

    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)

    const PAD = { top: 16, right: 16, bottom: 36, left: 72 }
    const chartW = W - PAD.left - PAD.right
    const chartH = H - PAD.top - PAD.bottom

    const values = points.map(p => parseFloat(p.value))
    const minV = Math.min(...values)
    const maxV = Math.max(...values)
    const range = maxV - minV || 1

    function px(i: number) {
      return PAD.left + (points.length > 1 ? (i / (points.length - 1)) : 0.5) * chartW
    }
    function py(v: number) {
      return PAD.top + chartH - ((v - minV) / range) * chartH
    }

    // Grid lines (5 horizontal)
    ctx.strokeStyle = cssVar('--border')
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const y = PAD.top + (i / 4) * chartH
      ctx.beginPath()
      ctx.moveTo(PAD.left, y)
      ctx.lineTo(PAD.left + chartW, y)
      ctx.stroke()

      const v = maxV - (i / 4) * range
      ctx.fillStyle = cssVar('--text-muted')
      ctx.font = '11px system-ui, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(formatY(v), PAD.left - 6, y + 4)
    }

    // X-axis labels — show ~5 evenly spaced
    const labelCount = Math.min(5, points.length)
    const step = Math.floor((points.length - 1) / (labelCount - 1)) || 1
    ctx.fillStyle = cssVar('--text-muted')
    ctx.font = '10px system-ui, sans-serif'
    ctx.textAlign = 'center'
    for (let i = 0; i < points.length; i += step) {
      const x = px(i)
      const d = points[i].date.slice(0, 7) // YYYY-MM
      ctx.fillText(d, x, H - PAD.bottom + 16)
    }

    // Fill gradient under line
    const resolvedColor = resolveColor(color, '#0d6efd')
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + chartH)
    grad.addColorStop(0, resolvedColor + '33')
    grad.addColorStop(1, resolvedColor + '00')

    ctx.beginPath()
    ctx.moveTo(px(0), py(values[0]))
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(px(i), py(values[i]))
    }
    ctx.lineTo(px(points.length - 1), PAD.top + chartH)
    ctx.lineTo(px(0), PAD.top + chartH)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()

    // Line
    ctx.beginPath()
    ctx.moveTo(px(0), py(values[0]))
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(px(i), py(values[i]))
    }
    ctx.strokeStyle = resolvedColor
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.stroke()
  }

  onMount(() => {
    draw()
    const ro = new ResizeObserver(() => draw())
    ro.observe(container)
    return () => ro.disconnect()
  })

  $effect(() => {
    // Re-draw when points or theme change
    points
    themeStore.theme
    draw()
  })
</script>

<div class="chart-wrap" bind:this={container}>
  {#if points.length === 0}
    <div class="empty">No data for this period</div>
  {:else}
    <canvas bind:this={canvas}></canvas>
  {/if}
</div>

<style>
  .chart-wrap { position: relative; width: 100%; }
  canvas { display: block; }
  .empty { display: flex; align-items: center; justify-content: center; height: 120px; color: var(--text-muted); font-size: .875rem; }
</style>
