import { describe, it, expect } from 'vitest';
import { defaultMusicAsset, musicUrl, NEW_MUSIC_ROUTE } from '../src/editor/music/music-model.js';

/* Bug: Ctrl+4 (music mode, route #/music) opened a blank new song even when the project had music. */
const snapshot = (activeSequence: string, used: string[]) => ({
  project: {
    activeSequence,
    assets: [
      { id: 'logo', type: 'image' },
      { id: 'sting', soundSource: 'sounds/sting.sound.json' },
      { id: 'bed', soundSource: 'sounds/bed.sound.json' },
    ],
  },
  sequences: [
    { id: 'main', tracks: [{ clips: used.map((assetId) => ({ assetId })) }] },
    { id: 'alt', tracks: [{ clips: [{ assetId: 'sting' }] }] },
  ],
});

describe('music mode default route', () => {
  it('opens the sound asset used in the active sequence', () => {
    expect(defaultMusicAsset(snapshot('main', ['logo', 'bed']))).toBe('bed');
    expect(defaultMusicAsset(snapshot('alt', []))).toBe('sting');
  });
  it('falls back to the first sound asset, and to a blank song only without any', () => {
    expect(defaultMusicAsset(snapshot('main', ['logo']))).toBe('sting');
    expect(defaultMusicAsset({ project: { activeSequence: 'main', assets: [{ id: 'logo' }] }, sequences: [] })).toBeUndefined();
  });
  it('keeps #/music/new as the explicit blank-song route', () => {
    expect(musicUrl(NEW_MUSIC_ROUTE)).toBe('#/music/new');
    expect(musicUrl()).toBe('#/music');
    expect(musicUrl('bed')).toBe('#/music/bed');
  });
});
