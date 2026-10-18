/** @jsxImportSource @vmotion/sdk */
// Five beat-locked scenes. Every value is a pure function of useClock(): seek anywhere.
import { useClock, remap, springTo, beatClock, mixColor, cycle, random, type VmChild } from '@vmotion/sdk';
import { logoPoints, scatter, spectrum } from './geometry';

export const BPM = 128;
const W = 1280,
  H = 720;

/* 01 — typewriter opener ------------------------------------------------------------ */
export function Typewriter({ line, accent }: { line: string; accent: string }) {
  const clock = useClock();
  const chars = Array.from(line),
    typed = Math.min(chars.length, Math.floor(clock.frame / 2.2)),
    beat = beatClock(clock, BPM),
    caret = beat.phase < 0.5 || typed < chars.length ? '|' : ' ',
    lift = springTo(clock, { from: 24, to: 0, start: 0 });
  return (
    <group id="typewriter" x={140} y={250 + lift} width={1000} height={220}>
      <text id="prompt" y={0} width={1000} height={34} fontSize={22} fill={accent}>
        {'> vmotion render --jsx'}
      </text>
      <text id="line" y={56} width={1000} height={90} fontSize={56} fontWeight={700} fill="#f4f7ff">
        {chars.slice(0, typed).join('') + caret}
      </text>
      <rect
        id="underline"
        y={160}
        height={4}
        width={remap(typed, [0, chars.length], [0, 760], { easing: 'outCubic' })}
        style={{ background: `linear-gradient(90deg, ${accent}, #ff5fa2)`, borderRadius: 2 }}
      />
    </group>
  );
}

/* 02 — pseudo-3D card array (carousel steps one card per beat) ------------------------ */
const cardLabels = ['<Stage>', '<LocalTime>', '<Steps>', '<text>', '<group>', '<path>', '<image>'];
export function CardArray({ accent }: { accent: string }) {
  const clock = useClock();
  const beat = beatClock(clock, BPM),
    // Each beat advances one slot with a spring (frame math, no timers).
    step = beat.index + springTo({ frame: beat.phase * beat.framesPerBeat, fps: clock.fps }, { stiffness: 220, damping: 18 }),
    n = cardLabels.length,
    enter = springTo(clock, { stiffness: 120, damping: 16 });
  return (
    <group id="cards" width={W} height={H}>
      {cardLabels.map((label, i) => {
        const theta = ((i - step) / n) * Math.PI * 2,
          depth = (Math.cos(theta) + 1) / 2,
          x = W / 2 + Math.sin(theta) * 430 * enter,
          y = H / 2 + 10 - depth * 30,
          facing = Math.cos(theta),
          s = 0.55 + depth * 0.5,
          w = 220,
          h = 300;
        return (
          <group
            key={`card${i}`}
            width={w}
            height={h}
            zIndex={Math.round(depth * 100)}
            opacity={0.25 + depth * 0.75}
            style={{
              left: x - w / 2,
              top: y - h / 2,
              transform: `scale(${(Math.abs(facing) * 0.85 + 0.15) * s}, ${s}) skewY(${-Math.sin(theta) * 14}deg)`,
            }}
          >
            <rect
              id="face"
              width={w}
              height={h}
              style={{
                borderRadius: 18,
                background: `linear-gradient(160deg, ${mixColor('#1b2440', accent, depth * 0.6)}, #0c1020)`,
                border: `2px solid ${mixColor('#33415f', '#ffffff', depth)}`,
                boxShadow: `0 ${10 + depth * 20}px ${20 + depth * 30}px rgba(0,0,0,0.55)`,
              }}
            />
            <text id="label" x={18} y={22} width={w - 36} height={40} fontSize={24} fontWeight={700} fill="#f4f7ff">
              {label}
            </text>
            {[0, 1, 2].map((row) => (
              <rect key={`bar${row}`} x={18} y={90 + row * 34} width={(w - 36) * (0.9 - row * 0.22)} height={14} radius={7} fill={row ? '#3a4766' : accent} />
            ))}
          </group>
        );
      })}
    </group>
  );
}

/* 03 — component explosion + spectrum ----------------------------------------------- */
export function Explosion({ accent }: { accent: string }) {
  const clock = useClock();
  const t = clock.seconds,
    beat = beatClock(clock, BPM),
    cols = 12,
    rows = 8,
    cw = 300 / cols,
    ch = 200 / rows,
    rng = random(7),
    bands = spectrum(40, beat.beat, beat.phase);
  const fragments: VmChild[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const vx = (c - cols / 2 + rng() - 0.5) * 95,
        vy = (r - rows / 2 + rng() - 0.5) * 80 - 160,
        spin = (rng() - 0.5) * 720,
        delay = rng() * 0.12,
        age = Math.max(0, t - 0.35 - delay);
      fragments.push(
        <rect
          key={`f${r}-${c}`}
          x={490 + c * cw + vx * age}
          y={200 + r * ch + vy * age + 0.5 * 520 * age * age}
          width={cw - 1}
          height={ch - 1}
          origin="center"
          rotation={spin * age}
          fill={mixColor(accent, '#ff5fa2', (r + c) / (rows + cols))}
          opacity={remap(age, [0, 1.6], [1, 0])}
        />,
      );
    }
  const shake = Math.max(0, 1 - Math.abs(t - 0.35) * 8) * 10;
  return (
    <group id="explosion" width={W} height={H}>
      {t < 0.4 && (
        <text id="warning" x={490} y={150} width={300} height={36} fontSize={24} fill="#ffcf5a" align="center">
          {'<Card /> 即将拆解'}
        </text>
      )}
      <group id="fragments" x={(random(Math.floor(clock.frame))() - 0.5) * shake} width={W} height={H}>
        {fragments}
      </group>
      <ellipse
        id="shockwave"
        origin="center"
        x={640 - 400}
        y={300 - 400}
        width={800}
        height={800}
        fill="transparent"
        stroke="#ffffff"
        strokeWidth={6}
        scale={remap(t, [0.35, 1.1], [0.02, 1], { easing: 'outCubic' })}
        opacity={remap(t, [0.35, 1.1], [0.8, 0])}
      />
      <group id="spectrum" x={140} y={470} width={1000} height={160}>
        {bands.map((v, i) => (
          <rect
            key={`band${i}`}
            x={i * 25}
            y={160 - v * 160}
            width={19}
            height={v * 160}
            radius={4}
            style={{ background: `linear-gradient(0deg, ${accent}, #ff5fa2)` }}
          />
        ))}
      </group>
    </group>
  );
}

/* 04 — per-beat style switches (hard cut every beat) --------------------------------- */
const looks = [
  { word: '组件', bg: '#ff5fa2', ink: '#0b0d18', weight: 900, tilt: -4 },
  { word: 'PROPS', bg: '#0b0d18', ink: '#7cf3ff', weight: 700, tilt: 3 },
  { word: '帧', bg: '#ffcf5a', ink: '#141018', weight: 900, tilt: 0 },
  { word: 'SKIA', bg: '#7c8cff', ink: '#ffffff', weight: 900, tilt: -2 },
  { word: '节拍', bg: '#101826', ink: '#ffcf5a', weight: 700, tilt: 5 },
  { word: '原生', bg: '#59ffb0', ink: '#0b0d18', weight: 900, tilt: -6 },
];
export function BeatSwitch() {
  const clock = useClock();
  const beat = beatClock(clock, BPM),
    look = cycle(looks, beat.index),
    punch = 1 + beat.pulse * 0.18;
  return (
    <group id="beats" width={W} height={H}>
      <rect id="cut" width={W} height={H} fill={look.bg} />
      <text
        id="word"
        x={140}
        y={250}
        width={1000}
        height={220}
        align="center"
       
        fontSize={170}
        fontWeight={look.weight}
        fill={look.ink}
        origin="center"
        rotation={look.tilt}
        scale={punch}
      >
        {look.word}
      </text>
      <text id="counter" x={140} y={520} width={1000} height={40} align="center" fontSize={24} fill={look.ink} opacity={0.8}>
        {`beat ${beat.index + 1} · ${BPM} BPM · ${beat.framesPerBeat.toFixed(4)} frames/beat`}
      </text>
    </group>
  );
}

/* 05 — fragments converge into the logo --------------------------------------------- */
export function Converge({ title, accent }: { title: string; accent: string }) {
  const clock = useClock();
  const count = 96,
    from = scatter(count, 11, W, H),
    to = logoPoints(count, { x: 640, y: 290 }, 120),
    reveal = springTo(clock, { start: 40, stiffness: 140, damping: 14 });
  return (
    <group id="converge" width={W} height={H}>
      {to.map((target, i) => {
        const k = springTo(clock, { start: (i % 24) * 0.8, stiffness: 90, damping: 13 }),
          size = 9 - k * 3;
        return (
          <ellipse
            key={`p${i}`}
            x={from[i].x + (target.x - from[i].x) * k - size / 2}
            y={from[i].y + (target.y - from[i].y) * k - size / 2}
            width={size}
            height={size}
            fill={mixColor('#ff5fa2', accent, k)}
            style={{ boxShadow: `0 0 ${6 + k * 6}px ${accent}` }}
          />
        );
      })}
      <text
        id="logo"
        x={240}
        y={440}
        width={800}
        height={90}
        align="center"
        fontSize={64}
        fontWeight={800}
        fill="#f4f7ff"
       
        origin="center"
        opacity={reveal}
        scale={0.8 + reveal * 0.2}
      >
        {title}
      </text>
      <text id="tagline" x={240} y={530} width={800} height={36} align="center" fontSize={22} fill={accent} opacity={reveal}>
        JSX authoring · native Skia rendering
      </text>
    </group>
  );
}
