import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { captionsSchema, parseCaptions } from '../core/captions.js';
import {
  newNode,
  sceneSchema,
  VmotionError,
  type Snapshot,
  type Operation,
} from '../core/model.js';
export const captionsImportSchema = z
  .object({
    sequenceId: z.string().optional(),
    content: z
      .string()
      .max(5 * 1024 * 1024)
      .optional(),
    path: z.string().optional(),
    format: z.enum(['srt', 'vtt']).default('srt'),
    name: z.string().default('字幕'),
    fontSize: z.number().finite().min(8).max(200).default(42),
    fontFamily: z.string().default('Microsoft YaHei'),
    color: z.string().default('#ffffff'),
    bottom: z.number().finite().min(0).max(2160).default(72),
    revision: z.string().optional(),
  })
  .strict()
  .refine(
    (r) => Boolean(r.content) !== Boolean(r.path),
    'Provide subtitle content or a local file path',
  );
export async function importCaptions(snapshot: Snapshot, raw: unknown) {
  const request = captionsImportSchema.parse(raw),
    sequence = snapshot.sequences.find(
      (s) => s.id === (request.sequenceId ?? snapshot.project.activeSequence),
    );
  if (!sequence) throw new VmotionError('NOT_FOUND', 'Sequence not found');
  const content = request.content ?? (await readFile(request.path!, 'utf8')),
    document = parseCaptions(content, snapshot.project.fps, request.format);
  if (document.cues.some((c) => c.end > sequence.duration))
    throw new VmotionError(
      'CAPTION_RANGE',
      'Subtitle duration exceeds the sequence; extend the sequence or trim the subtitle cues',
    );
  if (!document.cues.length) throw new VmotionError('CAPTION_EMPTY', 'Subtitle file has no cues');
  const id = randomUUID(),
    dataFile = `components/captions-${id}.json`,
    componentFile = `components/captions-${id}.ts`,
    sceneId = `captions-${id}`,
    trackId = randomUUID(),
    clipId = randomUUID();
  const source = `import {defineComponent,rect,text,measureTextBlock}from '@vmotion/sdk';\nimport document from './captions-${id}.json';\nexport default defineComponent({name:${JSON.stringify(request.name)},parameters:{\nfontSize:{type:'number',default:${request.fontSize},min:8,max:200},fontFamily:{type:'string',default:${JSON.stringify(request.fontFamily)}},color:{type:'color',default:${JSON.stringify(request.color)}},bottom:{type:'number',default:${request.bottom},min:0,max:2160}\n},render(ctx,params){\nlet lo=0,hi=document.cues.length;while(lo<hi){const mid=(lo+hi)>>1;if(document.cues[mid].start<=ctx.frame)lo=mid+1;else hi=mid;}const cue=document.cues[lo-1];if(!cue||ctx.frame>=cue.end)return [];\nconst height=measureTextBlock(cue.text,{fontSize:params.fontSize,fontFamily:params.fontFamily,width:ctx.width*.8,lineHeight:1.35}).height,y=ctx.height-params.bottom-height;\nreturn [rect('plate-'+cue.id,{x:ctx.width*.08,y:y-12,width:ctx.width*.84,height:height+24,radius:12,fill:'#000000ba'}),text(cue.id,cue.text,{name:cue.text.slice(0,30),x:ctx.width*.1,y,width:ctx.width*.8,height,fontSize:params.fontSize,fontFamily:params.fontFamily,fill:params.color,align:'center',lineHeight:1.35})];\n}});\n`;
  const scene = sceneSchema.parse({
    id: sceneId,
    name: request.name,
    duration: sequence.duration,
    background: 'transparent',
    nodes: [
      newNode({
        id: 'captions',
        type: 'component',
        name: request.name,
        component: componentFile,
        width: snapshot.project.width,
        height: snapshot.project.height,
      }),
    ],
  });
  const operations: Operation[] = [
    { type: 'writeSource', path: dataFile, content: JSON.stringify(document, null, 2) + '\n' },
    { type: 'writeSource', path: componentFile, content: source },
    { type: 'addScene', scene },
    {
      type: 'updateSequence',
      sequenceId: sequence.id,
      patch: {
        tracks: [
          ...sequence.tracks,
          {
            id: trackId,
            name: request.name,
            type: 'video',
            muted: false,
            clips: [
              {
                id: clipId,
                name: request.name,
                sceneId,
                start: 0,
                duration: sequence.duration,
                sourceIn: 0,
                speed: 1,
                volume: 1,
                fadeIn: 0,
                fadeOut: 0,
                audioEnabled: false,
              },
            ],
          },
        ],
      },
    },
  ];
  return { request, operations, document, dataFile, componentFile, sceneId, trackId, clipId };
}
export function inspectCaptions(snapshot: Snapshot, dataFile: string, offset = 0, limit = 100) {
  if (
    !/^components\/captions-[\w-]+\.json$/.test(dataFile) ||
    snapshot.files[dataFile] === undefined
  )
    throw new VmotionError('CAPTION_FILE', 'Subtitle data file not found');
  const document = captionsSchema.parse(JSON.parse(snapshot.files[dataFile]));
  return {
    revision: snapshot.revision,
    dataFile,
    fps: document.fps,
    total: document.cues.length,
    cues: document.cues.slice(offset, offset + Math.min(500, Math.max(1, limit))),
  };
}
