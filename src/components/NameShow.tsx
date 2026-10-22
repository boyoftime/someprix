import { useEffect, useState, type CSSProperties } from "react";

const NAMES = ["SOMELESS ADO", "SAMWEL ADONIA"] as const;

/**
 * The five looks, in turn. decode: terminal letters scramble, then lock in. flap: a split-flap
 * board, only the letters that differ flip. focus: bold white, sharpening out of a blur. type: a
 * terminal types, erases, types again. fire: the studio logo's flame colours, rising, then
 * burning away.
 */
const LOOKS = ["decode", "flap", "focus", "type", "fire"] as const;
type Look = (typeof LOOKS)[number];

/** How long a name stays up, once it's in. */
const HOLD = 2300;
/** How long each look takes to bring a name in, and to take it away (matching the CSS). */
const ENTER: Partial<Record<Look, number>> = { flap: 1250, focus: 900, fire: 1250 };
const LEAVE: Record<Look, number> = { decode: 350, flap: 700, focus: 550, type: 0, fire: 780 };
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+/<>=?";

type Frame = {
  look: Look;
  text: string;
  /** Leaving: the look's exit plays. */
  out: boolean;
  /** Letters still scrambling (decode). */
  wild: number[];
  /** Counts the names brought in: a new one restarts the look's entrance. */
  word: number;
};

const holdStill = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** SOMELESS ADO, then SAMWEL ADONIA, over and over, in a different look each time. */
export function NameShow() {
  const [frame, setFrame] = useState<Frame>({ look: "decode", text: "", out: false, wild: [], word: 0 });

  useEffect(() => {
    let live = true;
    const timers = new Set<number>();
    const wait = (ms: number) =>
      new Promise<void>((done) => {
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          done();
        }, ms);
        timers.add(timer);
      });
    let word = 0;
    const show = (look: Look, text: string, wild: number[] = []) => {
      if (live) setFrame({ look, text, out: false, wild, word });
    };
    const leave = async (look: Look) => {
      if (live) setFrame((now) => ({ ...now, out: true }));
      await wait(LEAVE[look]);
    };

    // Each letter scrambles until its moment, left to right with a little chance in it.
    const scramble = async (from: string, to: string) => {
      const length = Math.max(from.length, to.length);
      const lockAt = Array.from({ length }, (_, i) => 250 + i * 60 + Math.random() * 120);
      const end = Math.max(...lockAt);
      for (let t = 0; t <= end; t += 45) {
        const wild: number[] = [];
        let text = "";
        for (let i = 0; i < length; i++) {
          if (t >= lockAt[i]) {
            text += to[i] ?? " ";
          } else {
            wild.push(i);
            text += t < 120 && from[i] ? from[i] : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
          }
        }
        show("decode", text, wild);
        await wait(45);
      }
      show("decode", to);
    };
    const type = async (text: string) => {
      for (let i = 1; i <= text.length; i++) {
        show("type", text.slice(0, i));
        await wait(text[i - 1] === " " ? 170 : 70 + Math.random() * 60);
      }
    };
    const erase = async (text: string) => {
      for (let i = text.length - 1; i >= 0; i--) {
        show("type", text.slice(0, i));
        await wait(34);
      }
    };

    void (async () => {
      const [first, second] = NAMES;
      if (holdStill()) {
        // No motion: the names simply take turns.
        for (let n = 0; live; n++) {
          word++;
          show("focus", NAMES[n % 2]);
          await wait(4000);
        }
        return;
      }
      for (let run = 0; live; run++) {
        const look = LOOKS[run % LOOKS.length];
        if (look === "decode") {
          await scramble("", first);
          await wait(HOLD);
          await scramble(first, second);
          await wait(HOLD);
          await leave(look);
        } else if (look === "type") {
          show(look, "");
          await wait(400);
          await type(first);
          await wait(HOLD);
          await erase(first);
          await wait(300);
          await type(second);
          await wait(HOLD);
          await erase(second);
          await wait(400);
        } else if (look === "flap") {
          // The same board: the second name flips over the first, letter by letter.
          word++;
          show(look, first);
          await wait(ENTER.flap! + HOLD);
          show(look, second);
          await wait(ENTER.flap! + HOLD);
          await leave(look);
        } else {
          for (const name of NAMES) {
            word++;
            show(look, name);
            await wait(ENTER[look]! + HOLD);
            await leave(look);
          }
        }
      }
    })();

    return () => {
      live = false;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  return (
    <div className="about-names" data-look={frame.look}>
      <span className="sr-only">Someless Ado, also known as Samwel Adonia</span>
      <span key={`${frame.look}-${frame.word}`} className="nm-word" data-out={frame.out ? "" : undefined} aria-hidden="true">
        {frame.look === "type" && <span className="nm-prompt">$</span>}
        {[...frame.text].map((ch, i) => (
          <span
            // On the board, a letter that changes is a new tile, so it flips.
            key={frame.look === "flap" ? `${i}-${ch}` : i}
            className={ch === " " ? "nm-ch nm-gap" : "nm-ch"}
            data-wild={frame.wild.includes(i) ? "" : undefined}
            style={{ "--i": i } as CSSProperties}
          >
            {ch === " " ? " " : ch}
          </span>
        ))}
        {frame.look === "type" && <span className="nm-caret" />}
      </span>
    </div>
  );
}
