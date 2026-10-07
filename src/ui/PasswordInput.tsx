import { useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

/** A password box with its own show/hide eye; the browser's built-in reveal button is hidden in CSS. */
export function PasswordInput(props: PasswordInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <span className="password-input">
      <input {...props} type={shown ? "text" : "password"} autoComplete="off" spellCheck={false} />
      <button
        type="button"
        className="password-eye"
        // Keep the caret in the box while toggling.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        data-tip={shown ? "Hide" : "Show"}
      >
        {shown ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
      </button>
    </span>
  );
}
