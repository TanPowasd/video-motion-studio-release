import React, { useRef, useState } from 'react';
import type { Asset } from '../core/model.js';
import { Icon } from './Icons.js';
export const ASSET_DROP_EVENT = 'vmotion-asset-drop';
export type AssetDropDetail = { assetId: string; clientX: number; clientY: number };
export function AssetItem({
  asset,
  revision,
  selected,
  onSelect,
  onPlace,
}: {
  asset: Asset;
  revision: string;
  selected: boolean;
  onSelect: () => void;
  onPlace: () => void;
}) {
  const gesture = useRef<{ id: number; x: number; y: number; moved: boolean } | undefined>(
      undefined,
    ),
    suppressClick = useRef(false),
    [ghost, setGhost] = useState<{ x: number; y: number; valid: boolean }>();
  const cancel = () => {
    gesture.current = undefined;
    setGhost(undefined);
  };
  return (
    <>
      <button
        className={`asset-row ${selected ? 'selected' : ''}`}
        title="拖入画布或时间轴放置；双击添加"
        data-asset-id={asset.id}
        onClick={() => {
          if (!suppressClick.current) onSelect();
          suppressClick.current = false;
        }}
        onDoubleClick={onPlace}
        onPointerDown={(e) => {
          if (e.button !== 0 || !e.isPrimary || asset.type === 'font') return;
          e.preventDefault();
          gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
          suppressClick.current = false;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const g = gesture.current;
          if (!g || g.id !== e.pointerId) return;
          if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 4) return;
          g.moved = true;
          suppressClick.current = true;
          const target = document
            .elementFromPoint(e.clientX, e.clientY)
            ?.closest('.canvas-interaction,.tl-scroll');
          setGhost({ x: e.clientX, y: e.clientY, valid: !!target });
        }}
        onPointerUp={(e) => {
          const g = gesture.current;
          if (!g || g.id !== e.pointerId) return;
          cancel();
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
          if (g.moved) {
            suppressClick.current = true;
            window.dispatchEvent(
              new CustomEvent<AssetDropDetail>(ASSET_DROP_EVENT, {
                detail: { assetId: asset.id, clientX: e.clientX, clientY: e.clientY },
              }),
            );
          } else onSelect();
        }}
        onPointerCancel={cancel}
        onLostPointerCapture={() => {
          if (gesture.current) cancel();
        }}
      >
        <div className="asset-thumb">
          {['image', 'video', 'drawing'].includes(asset.type) ? (
            <img
              src={`/api/asset-thumbnail?id=${encodeURIComponent(asset.id)}&revision=${revision}`}
              alt={`${asset.name} 缩略图`}
              loading="lazy"
              draggable={false}
            />
          ) : (
            <Icon
              name={asset.type === 'audio' ? 'music' : asset.type === 'font' ? 'text' : 'image'}
            />
          )}
        </div>
        <div>
          <strong>{asset.name}</strong>
          <small>
            {asset.soundSource
              ? '可编辑乐曲 / 音效'
              : `${asset.type} · ${asset.managed ? 'copied' : 'linked'}`}
          </small>
        </div>
      </button>
      {ghost && (
        <div
          className={`asset-drag-ghost ${ghost.valid ? 'valid' : ''}`}
          style={{ left: ghost.x + 14, top: ghost.y + 12 }}
        >
          <Icon name={asset.type === 'audio' ? 'music' : 'image'} />
          <span>{asset.name}</span>
          <small>{ghost.valid ? '松开放置' : '拖到画布或时间轴'}</small>
        </div>
      )}
    </>
  );
}
