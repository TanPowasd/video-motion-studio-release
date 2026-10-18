/** @jsxImportSource @vmotion/sdk */
// 06 — flex + grid layout (taffy). Layout is recomputed every frame from props, so gaps,
// widths and column counts are animatable and every frame is still seekable.
import { useClock, remap, springTo, beatClock, cycle, mixColor, LocalTime } from '@vmotion/sdk';
import { BPM } from './scenes';

const palette = ['#7cf3ff', '#ff5fa2', '#b58cff', '#ffd166', '#5dffa8', '#ff8a5b'];
const labels = ['flex', 'grid', 'gap', 'wrap', 'span', 'fr', 'auto', 'minmax', 'padding', 'align', 'justify', 'order'];

/** Card grid that reflows on beats: the column count steps every two beats. */
export function GridReflow({ accent }: { accent: string }) {
  const clock = useClock();
  const beat = beatClock(clock, BPM),
    cols = cycle([3, 4, 6, 4], Math.floor(beat.beat / 2)),
    enter = springTo(clock, { stiffness: 140, damping: 18 }),
    width = 640 + 480 * enter,
    gap = 12 + beat.pulse * 10;
  return (
    <group id="layout-grid" width={1280} height={720}>
      <text id="title" x={80} y={26} width={1120} height={50} fontSize={30} fontWeight={700} fill="#f4f7ff"
        style={{ letterSpacing: 2 }}>
        {`display: grid · repeat(${cols}, 1fr) · gap ${Math.round(gap)}px`}
      </text>
      <group
        id="grid"
        style={{
          display: 'grid',
          left: 640 - width / 2,
          top: 118,
          width,
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap,
          gridAutoRows: 'minmax(80px, auto)',
        }}
      >
        {labels.map((label, i) => {
          const color = palette[i % palette.length],
            hit = i % cols === beat.index % cols;
          return (
            <group
              key={`card${i}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: 14,
                gridColumn: i === 0 ? `span ${Math.min(2, cols)}` : undefined,
                transform: `scale(${hit ? 1 + beat.pulse * 0.06 : 1})`,
              }}
            >
              <rect
                id="bg"
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: '100%',
                  height: '100%',
                  borderRadius: 14,
                  background: mixColor('#121a2e', color, hit ? 0.35 * beat.pulse + 0.1 : 0.06),
                  border: `1.5px solid ${hit ? color : '#26304d'}`,
                }}
              />
              <text id="label" fontSize={22} fontWeight={700} fill={color}>
                {label}
              </text>
              <group id="meter" style={{ display: 'flex', gap: 6, height: 8 }}>
                <rect id="on" style={{ flexGrow: 1 + ((i * 7) % 5), borderRadius: 4 }} fill={color} />
                <rect id="off" style={{ flexGrow: 3, borderRadius: 4 }} fill="#26304d" />
              </group>
            </group>
          );
        })}
      </group>
      <text id="caption" x={80} y={76} width={1120} height={30} fontSize={18} fill={accent}>
        {'每两拍切换列数；宽度、gap 都是帧函数 —— 布局在 Rust taffy（wasm）里逐帧计算'}
      </text>
    </group>
  );
}

const pills = ['拆分', 'flexWrap', '自动换行', 'gap', '对齐', 'CJK 测量', 'letterSpacing', 'overflow'];
/** Flex text block: tracked headline, wrapping CJK paragraph, pills appearing per beat. */
export function FlexText({ accent }: { accent: string }) {
  const clock = useClock();
  const beat = beatClock(clock, BPM),
    spacing = remap(clock.frame, [0, beat.framesPerBeat * 4], [0, 18], { easing: 'outCubic' }),
    side = remap(clock.frame, [0, beat.framesPerBeat * 3, beat.framesPerBeat * 6], [300, 440, 340], {
      easing: 'inOutCubic',
    }),
    reveal = springTo(clock, { stiffness: 90, damping: 16 });
  return (
    <group
      id="layout-flex"
      style={{ display: 'flex', left: 80, top: 70, width: 1120, height: 560, gap: 28 }}
    >
      <group
        id="main"
        style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, gap: 18, padding: 28, overflow: 'hidden' }}
      >
        <rect id="panel" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', borderRadius: 20 }} fill="#10172a" stroke="#26304d" strokeWidth={1.5} />
        <text id="kicker" fontSize={18} fill={accent} style={{ letterSpacing: spacing / 3, textTransform: 'uppercase' }}>
          flexbox · column · gap 18
        </text>
        <text id="headline" fontSize={52} fontWeight={800} fill="#f4f7ff" style={{ letterSpacing: spacing }}>
          布局随节拍呼吸
        </text>
        <text id="body" fontSize={24} fill="#aab6d6" lineHeight={1.5}>
          {'文字节点用渲染时同一套 Skia 字体度量来测量：中文按字断行，English words wrap at word boundaries, and the paragraph re-flows as the sidebar width changes on the beat.'}
        </text>
        <group id="pills" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 'auto' }}>
          {pills.map((label, i) => (
            <LocalTime key={`pill${i}`} start={i * beat.framesPerBeat * 0.75}>
              <group id="pill" style={{ display: 'flex', padding: '8px 16px', alignItems: 'center' }}>
                <rect id="bg" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', borderRadius: 18 }} fill={mixColor('#1b2440', palette[i % palette.length], 0.25)} />
                <text id="t" fontSize={20} fill={palette[i % palette.length]}>
                  {label}
                </text>
              </group>
            </LocalTime>
          ))}
        </group>
      </group>
      <group
        id="side"
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: side,
          padding: 22,
          opacity: reveal,
        }}
      >
        <rect id="panel" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', borderRadius: 20 }} fill="#151d33" />
        {[0, 1, 2, 3].map((i) => (
          <group key={`row${i}`} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ellipse id="dot" style={{ width: 18, height: 18, flexShrink: 0 }} fill={i === beat.beatInBar ? accent : '#38446a'} />
            <text id="t" fontSize={20} fill={i === beat.beatInBar ? '#f4f7ff' : '#7d89ab'} style={{ flexShrink: 0 }}>
              {['justifyContent', 'space-between', `width ${Math.round(side)}px`, '侧栏宽度动画'][i]}
            </text>
            <rect id="bar" style={{ flexGrow: 1, minWidth: 24, height: 4, borderRadius: 2 }} fill={i === beat.beatInBar ? accent : '#26304d'} />
          </group>
        ))}
      </group>
    </group>
  );
}
