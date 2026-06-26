import type { ReactNode } from "react";

const KEYWORDS = new Set([
  "fn", "let", "mut", "async", "await", "pub", "struct", "enum", "impl", "match",
  "return", "if", "else", "for", "while", "loop", "use", "const", "self", "Self",
  "move", "true", "false", "None", "Some", "Ok", "Err", "function", "export",
  "import", "from", "const", "type", "interface", "void", "new", "class", "extends",
  "POST", "GET", "PUT", "DELETE", "SELECT", "INSERT", "CREATE", "TABLE", "FROM",
  "WHERE", "REFERENCES", "PRIMARY", "KEY", "NOT", "NULL",
]);

// A single left-to-right tokenizer: comments, strings, numbers, then words.
const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*|--[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_][A-Za-z0-9_]*)/g;

function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const [, comment, str, num, word] = m;
    if (comment) out.push(<span key={i} className="tok-com">{comment}</span>);
    else if (str) out.push(<span key={i} className="tok-str">{str}</span>);
    else if (num) out.push(<span key={i} className="tok-num">{num}</span>);
    else if (word) {
      if (KEYWORDS.has(word)) out.push(<span key={i} className="tok-key">{word}</span>);
      else if (line[m.index + word.length] === "(") out.push(<span key={i} className="tok-fn">{word}</span>);
      else out.push(word);
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function CodeBlock({
  code,
  lang = "rust",
  file,
  highlightLines = [],
}: {
  code: string;
  lang?: string;
  file?: string;
  highlightLines?: number[];
}) {
  const lines = code.replace(/\n$/, "").split("\n");
  const hl = new Set(highlightLines);
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-ink-950/80 shadow-xl shadow-black/40">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.03] px-4 py-2">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        </div>
        <span className="font-mono text-[11px] text-slate-500">{file ?? lang}</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed">
        <code>
          {lines.map((line, idx) => (
            <span
              key={idx}
              className={`code-line -mx-4 px-4 ${
                hl.has(idx + 1) ? "border-l-2 border-brand-400 bg-brand-500/[0.08]" : "border-l-2 border-transparent"
              }`}
            >
              <span className="mr-4 inline-block w-6 select-none text-right text-slate-700">
                {idx + 1}
              </span>
              {highlight(line)}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
