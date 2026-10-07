import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy } from "lucide-react";
import { errorMessage, useAppData } from "../state/AppData";

type CopyButtonProps = {
  text: string;
  /** What gets copied, e.g. "Copy full path". */
  label: string;
};

/** An icon button that copies `text` and shows a check mark for a moment to confirm. */
export function CopyButton({ text, label }: CopyButtonProps) {
  const { notify } = useAppData();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await writeText(text);
      setCopied(true);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }

  return (
    <button
      type="button"
      className="icon-btn copy-btn"
      data-copied={copied ? "" : undefined}
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      data-tip={copied ? "Copied" : label}
    >
      {copied ? <Check size={15} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
    </button>
  );
}
