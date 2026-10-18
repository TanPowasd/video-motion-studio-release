/** @jsxImportSource @vmotion/sdk */
// Starter: a 3 s title card authored as a JSX component (Vmotion skill example).
// Every value is a pure function of the clock: seekable, deterministic, no state.
import { defineComponent, useClock, remap, springTo, beatClock, mixColor, Stage, LocalTime } from '@vmotion/sdk';

const BPM = 120; // 15 frames per beat at 30 fps

/** One chip in the flex row; pops in with a spring released at `delay` frames. */
function Chip({ label, delay, accent }: { label: string; delay: number; accent: string }) {
  const clock = useClock();
  const pop = springTo(clock, { start: delay, stiffness: 220, damping: 16 });
  const beat = beatClock(clock, BPM);
  return (
    <group
      id="chip"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '10px 22px',
        transform: `scale(${pop * (1 + beat.pulse * 0.04)})`,
        opacity: remap(clock.frame, [delay, delay + 6], [0, 1]),
      }}
    >
      <rect
        id="bg"
        style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', borderRadius: 22 }}
        fill={mixColor('#141b2e', accent, 0.18)}
        stroke={accent}
        strokeWidth={1.5}
      />
      <text id="label" fontSize={26} fontWeight={600} fill="#e8eeff">
        {label}
      </text>
    </group>
  );
}

export default defineComponent({
  name: 'Title card',
  parameters: {
    title: { type: 'string', default: 'Hello, Vmotion' },
    accent: { type: 'color', default: '#7cf3ff' },
  },
  render(ctx, p) {
    const rise = springTo(ctx, { from: 40, to: 0, stiffness: 120, damping: 18 });
    return (
      <Stage id="stage" background="#07090f">
        <text
          id="title"
          x={0}
          y={230 + rise}
          width={1280}
          height={110}
          align="center"
          fontSize={84}
          fontWeight={700}
          fill="#f4f7ff"
          opacity={remap(ctx.frame, [0, 12], [0, 1], { easing: 'outCubic' })}
        >
          {p.title}
        </text>
        <rect
          id="underline"
          x={640 - 180}
          y={360}
          height={6}
          radius={3}
          width={remap(ctx.frame, [6, 30], [0, 360], { easing: 'outCubic' })}
          fill={p.accent}
        />
        <LocalTime start={24}>
          <group id="chips" style={{ display: 'flex', gap: 18, justifyContent: 'center', left: 0, top: 420, width: 1280 }}>
            {['JSX', 'Flex 布局', '节拍同步'].map((label, i) => (
              <Chip key={`chip${i}`} label={label} delay={i * 6} accent={p.accent} />
            ))}
          </group>
        </LocalTime>
      </Stage>
    );
  },
});
