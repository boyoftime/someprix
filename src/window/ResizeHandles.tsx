import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

type ResizeDirection = Parameters<Window["startResizeDragging"]>[0];

const HANDLES: { direction: ResizeDirection; className: string }[] = [
  { direction: "North", className: "rz-n" },
  { direction: "South", className: "rz-s" },
  { direction: "East", className: "rz-e" },
  { direction: "West", className: "rz-w" },
  { direction: "NorthWest", className: "rz-nw" },
  { direction: "NorthEast", className: "rz-ne" },
  { direction: "SouthWest", className: "rz-sw" },
  { direction: "SouthEast", className: "rz-se" },
];

/** Resize grips that fill the transparent gutter around the frame, like Windows' own borders. */
export function ResizeHandles() {
  return (
    <div className="resize-handles" aria-hidden="true">
      {HANDLES.map(({ direction, className }) => (
        <div
          key={direction}
          className={`rz ${className}`}
          onMouseDown={(event) => {
            if (event.button === 0) void getCurrentWindow().startResizeDragging(direction);
          }}
        />
      ))}
    </div>
  );
}
