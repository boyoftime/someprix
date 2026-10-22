import { useEffect, useState } from "react";

const NAMES = ["SOMELESS ADO", "SAMWEL ADONIA"] as const;
/** One tile per letter of the longer name: the board never changes size. */
const SLOTS = Math.max(...NAMES.map((name) => name.length));
/** The board's colours, one after another: each shows both names, then the next flips in. */
const BOARDS = ["amber", "ice", "paper", "terminal", "ember"] as const;

/** How long a name stays up; how far apart the tiles flip, left to right. */
const HOLD = 2800;
const STAGGER = 60;

type Tile = { ch: string; board: (typeof BOARDS)[number] };

const tilesOf = (name: string, board: Tile["board"]): Tile[] =>
  Array.from({ length: SLOTS }, (_, i) => ({ ch: name[i] ?? " ", board }));
const holdStill = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A split-flap board under the studio's logo: SOMELESS ADO, then SAMWEL ADONIA, over and over.
 * Only the letters that differ flip, one tile after another; after both names the whole board
 * flips over into its next colours.
 */
export function NameShow() {
  const [tiles, setTiles] = useState<Tile[]>(() => tilesOf("", BOARDS[0]));

  useEffect(() => {
    let live = true;
    const timers = new Set<number>();
    const later = (ms: number, run: () => void) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (live) run();
      }, ms);
      timers.add(timer);
    };
    const still = holdStill();
    // Each tile takes its new letter at its own moment, so the old one stays until it flips.
    const flipTo = (next: Tile[]) =>
      next.forEach((tile, i) =>
        later(still ? 0 : i * STAGGER, () =>
          setTiles((now) => {
            if (now[i].ch === tile.ch && now[i].board === tile.board) return now;
            const changed = [...now];
            changed[i] = tile;
            return changed;
          }),
        ),
      );
    let step = 0;
    const advance = () => {
      const board = BOARDS[Math.floor(step / NAMES.length) % BOARDS.length];
      flipTo(tilesOf(NAMES[step % NAMES.length], board));
      step++;
      later(SLOTS * STAGGER + HOLD, advance);
    };
    later(250, advance);
    return () => {
      live = false;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  return (
    <div className="about-names" data-board={tiles[0].board}>
      <span className="sr-only">Someless Ado, also known as Samwel Adonia</span>
      <span className="nm-board" aria-hidden="true">
        {tiles.map((tile, i) => (
          <span key={i} className="nm-tile">
            {/* A new letter (or colour) is a new face, so it flips in over the tile. */}
            <span key={`${tile.board}-${tile.ch}`} className="nm-face" data-board={tile.board}>
              {tile.ch === " " ? "\u00a0" : tile.ch}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}
