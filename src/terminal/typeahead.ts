import type { Terminal } from "@xterm/xterm";

/**
 * Shows typed characters at once on a slow link, instead of waiting a round trip for the server
 * to echo them. Every key still goes to the server straight away; only the drawing is early.
 *
 * Kept deliberately cautious, so the screen always ends up as the server draws it:
 * - only plain characters typed at the end of a line are shown early, never in full-screen
 *   programs (editors, top) and never past the edge of the screen;
 * - only once the server has echoed a typed character on this line, so hidden input (passwords)
 *   is never shown;
 * - when the server's output is exactly the echo, the early characters simply stay; anything else
 *   rubs them out first and lets the server draw.
 */
export class TypeAhead {
  /** Characters drawn early that the server hasn't echoed yet. */
  private predicted = "";
  /** The server has been echoing what's typed on this line. */
  private trusted = false;
  /** A character sent without drawing it early, to see whether the server echoes it. */
  private awaiting: number | null = null;

  constructor(private readonly term: Terminal) {}

  /** What the user typed, just before it's sent. */
  typed(data: string) {
    const plain = data.length === 1 && data >= " " && data <= "~";
    if (!plain) {
      // Enter, Tab, arrows, Ctrl keys, pastes: the server decides what happens next.
      this.trusted = false;
      this.awaiting = null;
      return;
    }
    if (this.trusted && this.canDraw()) {
      this.predicted += data;
      this.term.write(data);
    } else if (!this.predicted) {
      this.awaiting = data.charCodeAt(0);
    }
  }

  /** Output from the server: drawn, after settling anything drawn early. */
  received(bytes: Uint8Array) {
    if (!this.predicted) {
      if (this.awaiting !== null) this.trusted = bytes.length > 0 && bytes[0] === this.awaiting;
      this.awaiting = null;
      this.term.write(bytes);
      return;
    }
    const drawn = this.predicted.length;
    let echoed = 0;
    while (echoed < drawn && echoed < bytes.length && bytes[echoed] === this.predicted.charCodeAt(echoed)) echoed++;
    const back = `\x1b[${drawn}D`;
    if (echoed > 0 && echoed === bytes.length) {
      // Just the echo of what's already on screen: redraw it in place, keep the rest.
      this.predicted = this.predicted.slice(echoed);
      this.term.write(back);
      this.term.write(bytes);
      if (this.predicted) this.term.write(`\x1b[${this.predicted.length}C`);
      return;
    }
    // Anything else wins: rub out what was drawn early and let the server draw.
    this.drop();
    this.trusted = false;
    this.term.write(back + "\x1b[K");
    this.term.write(bytes);
  }

  /** Rubs out anything drawn early (the session ended, or the screen changed size). */
  clear() {
    if (this.predicted) this.term.write(`\x1b[${this.predicted.length}D\x1b[K`);
    this.drop();
    this.trusted = false;
  }

  private drop() {
    this.predicted = "";
    this.awaiting = null;
  }

  /** At the end of a line in the normal screen, with room left on it. */
  private canDraw() {
    const buffer = this.term.buffer.active;
    if (buffer.type !== "normal") return false;
    if (buffer.cursorX + 1 >= this.term.cols) return false;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    return !line || line.translateToString(true, buffer.cursorX).length === 0;
  }
}
