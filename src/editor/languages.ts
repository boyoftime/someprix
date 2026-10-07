import type { Extension } from "@codemirror/state";
import { StreamLanguage, type StreamParser } from "@codemirror/language";

/** How the editor treats a kind of file: its name in the status bar, its colouring, and the
 *  indent to use when the file itself doesn't show one. Colouring loads on first use. */
export type Language = { label: string; load?: () => Promise<Extension>; indent?: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each mode has its own state type
const legacy = (parser: Promise<StreamParser<any>>) => parser.then((p) => StreamLanguage.define(p));
const js = (options: { jsx?: boolean; typescript?: boolean }) => () =>
  import("@codemirror/lang-javascript").then((m) => m.javascript(options));

const PLAIN: Language = { label: "Plain text" };
const SHELL: Language = { label: "Shell", load: () => legacy(import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell)) };
const DOCKER: Language = {
  label: "Dockerfile",
  load: () => legacy(import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile)),
};
const NGINX: Language = { label: "Nginx", load: () => legacy(import("@codemirror/legacy-modes/mode/nginx").then((m) => m.nginx)) };
const CONFIG: Language = {
  label: "Config",
  load: () => legacy(import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties)),
};
const YAML: Language = { label: "YAML", load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()), indent: 2 };
const JSON_: Language = { label: "JSON", load: () => import("@codemirror/lang-json").then((m) => m.json()), indent: 2 };
const XML: Language = { label: "XML", load: () => import("@codemirror/lang-xml").then((m) => m.xml()), indent: 2 };
const CPP: Language = { label: "C++", load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()) };
const CSS: Language = { label: "CSS", load: () => import("@codemirror/lang-css").then((m) => m.css()), indent: 2 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clike = (label: string, pick: (m: typeof import("@codemirror/legacy-modes/mode/clike")) => StreamParser<any>): Language => ({
  label,
  load: () => legacy(import("@codemirror/legacy-modes/mode/clike").then(pick)),
});

const BY_EXTENSION: Record<string, Language> = {
  js: { label: "JavaScript", load: js({}), indent: 2 },
  mjs: { label: "JavaScript", load: js({}), indent: 2 },
  cjs: { label: "JavaScript", load: js({}), indent: 2 },
  jsx: { label: "JavaScript JSX", load: js({ jsx: true }), indent: 2 },
  ts: { label: "TypeScript", load: js({ typescript: true }), indent: 2 },
  mts: { label: "TypeScript", load: js({ typescript: true }), indent: 2 },
  cts: { label: "TypeScript", load: js({ typescript: true }), indent: 2 },
  tsx: { label: "TypeScript JSX", load: js({ typescript: true, jsx: true }), indent: 2 },
  py: { label: "Python", load: () => import("@codemirror/lang-python").then((m) => m.python()), indent: 4 },
  pyw: { label: "Python", load: () => import("@codemirror/lang-python").then((m) => m.python()), indent: 4 },
  html: { label: "HTML", load: () => import("@codemirror/lang-html").then((m) => m.html()), indent: 2 },
  htm: { label: "HTML", load: () => import("@codemirror/lang-html").then((m) => m.html()), indent: 2 },
  vue: { label: "Vue", load: () => import("@codemirror/lang-html").then((m) => m.html()), indent: 2 },
  css: CSS,
  scss: { ...CSS, label: "SCSS" },
  less: { ...CSS, label: "Less" },
  json: JSON_,
  jsonc: JSON_,
  webmanifest: JSON_,
  md: { label: "Markdown", load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()) },
  markdown: { label: "Markdown", load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()) },
  yml: YAML,
  yaml: YAML,
  xml: XML,
  svg: XML,
  xsd: XML,
  plist: XML,
  php: { label: "PHP", load: () => import("@codemirror/lang-php").then((m) => m.php()) },
  sql: { label: "SQL", load: () => import("@codemirror/lang-sql").then((m) => m.sql()) },
  rs: { label: "Rust", load: () => import("@codemirror/lang-rust").then((m) => m.rust()) },
  go: { label: "Go", load: () => import("@codemirror/lang-go").then((m) => m.go()) },
  java: { label: "Java", load: () => import("@codemirror/lang-java").then((m) => m.java()) },
  c: { ...CPP, label: "C" },
  h: CPP,
  cpp: CPP,
  cc: CPP,
  cxx: CPP,
  hpp: CPP,
  hh: CPP,
  cs: clike("C#", (m) => m.csharp),
  kt: clike("Kotlin", (m) => m.kotlin),
  kts: clike("Kotlin", (m) => m.kotlin),
  scala: clike("Scala", (m) => m.scala),
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  ksh: SHELL,
  dockerfile: DOCKER,
  toml: { label: "TOML", load: () => legacy(import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml)) },
  ini: CONFIG,
  cfg: CONFIG,
  conf: CONFIG,
  cnf: CONFIG,
  properties: CONFIG,
  env: CONFIG,
  lua: { label: "Lua", load: () => legacy(import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua)) },
  rb: { label: "Ruby", load: () => legacy(import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby)), indent: 2 },
  ps1: {
    label: "PowerShell",
    load: () => legacy(import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell)),
  },
  pl: { label: "Perl", load: () => legacy(import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl)) },
  swift: { label: "Swift", load: () => legacy(import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift)) },
  r: { label: "R", load: () => legacy(import("@codemirror/legacy-modes/mode/r").then((m) => m.r)), indent: 2 },
  diff: { label: "Diff", load: () => legacy(import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff)) },
  patch: { label: "Diff", load: () => legacy(import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff)) },
};

/** Files known by their whole name rather than an extension. */
const BY_NAME: Record<string, Language> = {
  dockerfile: DOCKER,
  containerfile: DOCKER,
  ".bashrc": SHELL,
  ".bash_profile": SHELL,
  ".profile": SHELL,
  ".zshrc": SHELL,
  ".env": CONFIG,
  ".gitconfig": CONFIG,
  ".editorconfig": CONFIG,
  ".npmrc": CONFIG,
  "nginx.conf": NGINX,
};

/** The language for a file, by its name (and, for nginx's site files, its folder). */
export function languageFor(path: string): Language {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith("dockerfile.") || name.startsWith("containerfile.")) return DOCKER;
  if (name.startsWith(".env.")) return CONFIG;
  if (/[\\/]nginx[\\/]/i.test(path) || name.endsWith(".nginx")) return NGINX;
  const dot = name.lastIndexOf(".");
  return (dot > 0 && BY_EXTENSION[name.slice(dot + 1)]) || PLAIN;
}

/** Extensions of files that are never text: these open in their own app (or not at all). */
const BINARY = new Set(
  (
    "png jpg jpeg gif webp bmp ico icns tif tiff psd ai heic avif mp3 wav ogg flac m4a aac opus wma mp4 mkv mov avi webm " +
    "wmv flv m4v zip gz tgz bz2 xz 7z rar tar zst lz4 exe dll so dylib bin iso dmg img msi deb rpm apk ipa pdf doc docx " +
    "xls xlsx ppt pptx odt ods odp woff woff2 ttf otf eot class jar war pyc pyo o a lib obj sqlite sqlite3 db wasm " +
    "blend fbx glb gltf unitypackage pak dat"
  ).split(" "),
);

/** Whether a file is worth opening in the editor, judged by its name. */
export function isTextFile(name: string) {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || !BINARY.has(name.slice(dot + 1).toLowerCase());
}

/** The indent a file already uses: a tab, or the most common step of spaces. */
export function detectIndent(text: string): string | null {
  let tabbed = 0;
  let spaced = 0;
  let previous = 0;
  const steps = new Map<number, number>();
  for (const line of text.split("\n", 4000)) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)![0];
    if (lead.startsWith("\t")) {
      tabbed++;
      continue;
    }
    const width = lead.length;
    if (width > 0) spaced++;
    const step = Math.abs(width - previous);
    if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    previous = width;
  }
  if (tabbed > spaced) return "\t";
  if (!spaced || !steps.size) return null;
  const [best] = [...steps].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  return " ".repeat(best);
}
