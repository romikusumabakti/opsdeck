// Pure geometry for the avatar cropper. An offset is the top-left corner of the
// scaled image in viewport pixels; it is always <= 0 and clamped so the image
// covers the whole square viewport.

export type Size = { width: number; height: number };
export type Offset = { x: number; y: number };

/** Scaled image size: at zoom 1 the shorter side exactly covers the viewport. */
export function cropLayout(natural: Size, zoom: number, view: number): Size {
  const scale = (view / Math.min(natural.width, natural.height)) * zoom;
  return { width: natural.width * scale, height: natural.height * scale };
}

export function clampOffset(o: Offset, layout: Size, view: number): Offset {
  return {
    x: Math.min(0, Math.max(view - layout.width, o.x)),
    y: Math.min(0, Math.max(view - layout.height, o.y)),
  };
}

export function centerOffset(layout: Size, view: number): Offset {
  return { x: (view - layout.width) / 2, y: (view - layout.height) / 2 };
}

/** New offset after a zoom change that keeps the viewport centre on the same image point. */
export function zoomOffset(
  o: Offset,
  from: Size,
  to: Size,
  view: number
): Offset {
  const fx = (view / 2 - o.x) / from.width;
  const fy = (view / 2 - o.y) / from.height;
  return clampOffset(
    { x: view / 2 - fx * to.width, y: view / 2 - fy * to.height },
    to,
    view
  );
}
