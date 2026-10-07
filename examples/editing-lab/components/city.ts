import {
  defineComponent,
  rect,
  text,
  ellipse,
  path,
  group,
  particles,
  glow,
  linearGradient,
  type Node,
} from '@vmotion/sdk';
export default defineComponent({
  name: 'Night City · 原生镜头',
  parameters: { shot: { type: 'enum', options: ['wide', 'street', 'detail'], default: 'wide' } },
  render(ctx, params) {
    const s = ctx.seconds,
      mode = params.shot,
      accent = mode === 'detail' ? '#ffad83' : '#7bc8ff',
      nodes: Node[] = [
        rect('sky', {
          width: 1280,
          height: 720,
          gradient: linearGradient({ x: 0, y: 0 }, { x: 0, y: 720 }, [
            '#061026',
            '#183345',
            '#071522',
          ]),
        }),
        ellipse('moon', {
          x: 970,
          y: 75,
          width: 88,
          height: 88,
          fill: '#c6daf3',
          opacity: 0.68,
          effects: [glow('#96c5ff', 16, 0.2)],
        }),
      ],
      buildings: Node[] = [];
    for (let i = 0; i < 13; i++) {
      const x = i * 116 - 130,
        h = 180 + ((i * 71) % 245);
      buildings.push(
        rect(`b${i}`, { x, y: 540 - h, width: 94, height: h, fill: i % 2 ? '#10283c' : '#0b2030' }),
      );
      for (let row = 0; row < Math.floor(h / 38); row++)
        for (let col = 0; col < 3; col++)
          buildings.push(
            rect(`w${i}-${row}-${col}`, {
              x: x + 13 + col * 25,
              y: 550 - h + row * 35,
              width: 10,
              height: 15,
              fill: (i + row + col) % 5 === 0 ? '#edb485' : '#346181',
              opacity: (i + row) % 3 ? 0.7 : 0.3,
            }),
          );
    }
    nodes.push(
      ...group('city', buildings, {
        x: -s * (mode === 'wide' ? 16 : mode === 'street' ? 44 : 25),
        scaleX: mode === 'detail' ? 1.15 : 1,
        scaleY: mode === 'detail' ? 1.15 : 1,
        originX: 640,
        originY: 360,
      }),
      rect('ground', {
        y: 540,
        width: 1280,
        height: 180,
        gradient: linearGradient({ x: 0, y: 540 }, { x: 0, y: 720 }, ['#163544', '#04111c']),
      }),
      path('road', 'M0 633H1280', { fill: 'transparent', stroke: '#2a546d', strokeWidth: 3 }),
      rect('sign', {
        x: mode === 'detail' ? 190 : 740 - s * 30,
        y: mode === 'detail' ? 190 : 370,
        width: 220,
        height: 98,
        radius: 8,
        fill: '#123047',
        stroke: accent,
        strokeWidth: 3,
        effects: [glow(accent, 9, 0.4)],
      }),
      text('sign-text', mode === 'detail' ? 'NIGHT CITY' : 'OPEN LATE', {
        x: mode === 'detail' ? 210 : 760 - s * 30,
        y: mode === 'detail' ? 218 : 398,
        width: 180,
        height: 60,
        fontFamily: 'Consolas',
        fontSize: 26,
        fill: accent,
        align: 'center',
      }),
      ...group(
        'rain',
        particles('drop', ctx, {
          seed: 41,
          count: 90,
          origin: { x: 640, y: -50 },
          spread: { x: 1400, y: 40 },
          velocity: { x: -30, y: 330 },
          velocitySpread: { x: 5, y: 30 },
          size: [1, 2],
          lifetime: 2.5,
          colors: ['#70a2b8', '#92bad2'],
        }),
        { opacity: 0.28 },
      ),
      text('shot-code', `${mode.toUpperCase()} / NATIVE SHOT`, {
        x: 54,
        y: 54,
        width: 900,
        height: 34,
        fontSize: 18,
        fill: '#678aab',
      }),
    );
    if (mode !== 'wide')
      nodes.push(
        ellipse('wheel-a', { x: 410 + s * 15, y: 546, width: 21, height: 21, fill: '#071019' }),
        ellipse('wheel-b', { x: 490 + s * 15, y: 546, width: 21, height: 21, fill: '#071019' }),
        rect('car', {
          x: 390 + s * 15,
          y: 520,
          width: 140,
          height: 33,
          radius: 7,
          fill: '#244158',
        }),
        rect('light', {
          x: 519 + s * 15,
          y: 532,
          width: 9,
          height: 9,
          fill: '#ffeecc',
          effects: [glow('#eac893', 6, 0.6)],
        }),
      );
    return nodes;
  },
});
