/** @jsxImportSource @vmotion/sdk */
// 22.5 s JSX demo: 48 beats at 128 BPM (675 frames @ 30 fps), six chapters cut on beat boundaries.
import { defineComponent, useClock, beatClock, remap, Stage, Steps, Step } from '@vmotion/sdk';
import { BPM, Typewriter, CardArray, Explosion, BeatSwitch, Converge } from './lab/scenes';
import { GridReflow, FlexText } from './lab/layout';

const beats = (n: number, fps: number) => (n * fps * 60) / BPM;
const chapters = ['打字机', '3D 卡片阵列', '组件爆炸', '节拍切换', '弹性/网格布局', '汇聚成标'];
const plan = [6, 8, 6, 6, 16, 6]; // beats per chapter; sums to 48 beats = 675 frames

function Hud({ accent }: { accent: string }) {
  const clock = useClock();
  const beat = beatClock(clock, BPM),
    starts = plan.map((_, i) => beats(plan.slice(0, i).reduce((a, b) => a + b, 0), clock.fps)),
    active = starts.filter((s) => clock.frame >= s).length - 1;
  return (
    <group id="hud" width={1280} height={720}>
      <rect id="strip" x={0} y={652} width={1280} height={68} fill="rgba(7,9,15,0.72)" />
      {[0, 1, 2, 3].map((i) => (
        <ellipse
          key={`tick${i}`}
          x={1160 + i * 22}
          y={34}
          width={12}
          height={12}
          fill={i === beat.beatInBar ? accent : '#2a3350'}
          scale={i === beat.beatInBar ? 1 + beat.pulse * 0.6 : 1}
          origin="center"
        />
      ))}
      {chapters.map((label, i) => (
        <text
          key={`chapter${i}`}
          x={40 + i * 150}
          y={676}
          width={146}
          height={26}
          fontSize={16}
          fill={i === active ? accent : '#5d6a8c'}
          fontWeight={i === active ? 700 : 400}
        >
          {`0${i + 1} ${label}`}
        </text>
      ))}
      <rect id="progress" x={40} y={664} height={3} radius={1.5} fill={accent} width={remap(clock.frame, [0, beats(48, clock.fps)], [0, 1200])} />
    </group>
  );
}

export default defineComponent({
  name: 'JSX Lab',
  parameters: {
    line: { type: 'string', default: '用 JSX 写动画，Skia 原生渲染。' },
    title: { type: 'string', default: 'Vmotion JSX' },
    accent: { type: 'color', default: '#7cf3ff' },
  },
  render(ctx, p) {
    return (
      <Stage id="stage" background="#07090f">
        <Steps>
          <Step key="s1" duration={beats(6, ctx.fps)}>
            <Typewriter line={p.line} accent={p.accent} />
          </Step>
          <Step key="s2" duration={beats(8, ctx.fps)}>
            <CardArray accent={p.accent} />
          </Step>
          <Step key="s3" duration={beats(6, ctx.fps)}>
            <Explosion accent={p.accent} />
          </Step>
          <Step key="s4" duration={beats(6, ctx.fps)}>
            <BeatSwitch />
          </Step>
          <Step key="s5" duration={beats(8, ctx.fps)}>
            <GridReflow accent={p.accent} />
          </Step>
          <Step key="s6" duration={beats(8, ctx.fps)}>
            <FlexText accent={p.accent} />
          </Step>
          <Step key="s7">
            <Converge title={p.title} accent={p.accent} />
          </Step>
        </Steps>
        <Hud accent={p.accent} />
      </Stage>
    );
  },
});
