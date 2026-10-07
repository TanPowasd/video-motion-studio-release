import type { SoundDocument, SoundPattern, SoundTrack } from '../../core/sound-schema.js';
import type { useMusic } from './use-music.js';
import type { MusicDraft } from './music-model.js';
export const colors = ['#f2aa62', '#86c7b1', '#a798e1', '#74b8dc', '#dc8c9e', '#b9c67b'];
export interface MusicPanelProps {
  doc: SoundDocument;
  m: ReturnType<typeof useMusic>;
  edit: (change: (doc: SoundDocument) => void) => void;
  busy: boolean;
  grid: number;
  setTab: (tab: string) => void;
  owner: string;
  setOwner: (owner: string) => void;
  pattern?: SoundPattern;
  track?: SoundTrack;
  draft: MusicDraft;
  length: number;
  addTrack: (preset: string) => void;
  selectTrack: (id: string) => void;
}
