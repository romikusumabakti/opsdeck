"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  centerOffset,
  clampOffset,
  cropLayout,
  type Offset,
  zoomOffset,
} from "@/lib/avatar-crop";

const VIEW = 256; // on-screen viewport, px
const OUT = 512; // exported square, px

/** Square crop with drag-to-pan and a zoom slider. Exports WebP (PNG fallback). */
export function AvatarCropper({
  file,
  onCancel,
  onCropped,
}: {
  file: File;
  onCancel: () => void;
  onCropped: (blob: Blob) => void;
}) {
  const t = useTranslations("profile");
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const drag = useRef<Offset | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      // Start centered; from here on the offset is always a real, clamped position.
      setOffset(
        centerOffset(
          cropLayout(
            { width: image.naturalWidth, height: image.naturalHeight },
            1,
            VIEW
          ),
          VIEW
        )
      );
      setImg(image);
    };
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const natural = img
    ? { width: img.naturalWidth, height: img.naturalHeight }
    : { width: VIEW, height: VIEW };
  const layout = cropLayout(natural, zoom, VIEW);

  function exportCrop() {
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const k = OUT / VIEW;
    ctx.drawImage(
      img,
      offset.x * k,
      offset.y * k,
      layout.width * k,
      layout.height * k
    );
    canvas.toBlob(
      (blob) => {
        if (blob?.type === "image/webp") onCropped(blob);
        else canvas.toBlob((png) => png && onCropped(png), "image/png");
      },
      "image/webp",
      0.9
    );
  }

  function onZoom(next: number) {
    setOffset((o) =>
      zoomOffset(o, layout, cropLayout(natural, next, VIEW), VIEW)
    );
    setZoom(next);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("cropTitle")}</DialogTitle>
        </DialogHeader>
        <div
          className="relative mx-auto touch-none cursor-grab overflow-hidden rounded-full bg-muted active:cursor-grabbing"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
          }}
          onPointerMove={(e) => {
            if (drag.current) {
              setOffset(
                clampOffset(
                  {
                    x: e.clientX - drag.current.x,
                    y: e.clientY - drag.current.y,
                  },
                  layout,
                  VIEW
                )
              );
            }
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          {img && (
            // biome-ignore lint/performance/noImgElement: local object URL preview
            <img
              src={img.src}
              alt=""
              draggable={false}
              className="absolute max-w-none select-none"
              style={{
                left: offset.x,
                top: offset.y,
                width: layout.width,
                height: layout.height,
              }}
            />
          )}
        </div>
        <input
          type="range"
          min={1}
          max={4}
          step={0.01}
          value={zoom}
          aria-label={t("zoom")}
          onChange={(e) => onZoom(Number(e.target.value))}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button onClick={exportCrop} disabled={!img}>
            {t("saveAvatar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
