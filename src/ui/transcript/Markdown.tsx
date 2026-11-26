import { memo, useEffect, useMemo, useState } from "react";
import { markdownBlocks } from "./markdown";

type Mermaid = typeof import("mermaid").default;

let loaded: Promise<Mermaid> | undefined;
let seq = 0;
const cache = new Map<string, { svg: string } | { error: string }>();

/** Mermaid is large: it is imported the first time a diagram appears. */
function loadMermaid(): Promise<Mermaid> {
  loaded ??= import("mermaid").then((m) => {
    m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
    return m.default;
  });
  return loaded;
}

function Diagram({ src }: { src: string }) {
  const [result, setResult] = useState(() => cache.get(src));
  useEffect(() => {
    if (cache.has(src)) {
      setResult(cache.get(src));
      return;
    }
    let live = true;
    const id = `mm${++seq}`;
    loadMermaid()
      .then((m) => m.render(id, src))
      .then((r) => ({ svg: r.svg }))
      .catch((e: unknown) => {
        document.getElementById(`d${id}`)?.remove(); // mermaid leaves its error graphic in the body
        return { error: String(e instanceof Error ? e.message : e).split("\n")[0]! };
      })
      .then((r) => {
        cache.set(src, r);
        if (live) setResult(r);
      });
    return () => {
      live = false;
    };
  }, [src]);

  if (result && "svg" in result) return <div className="mermaid-box" dangerouslySetInnerHTML={{ __html: result.svg }} />;
  return (
    <div className={result ? "mermaid-box failed" : "mermaid-box pending"}>
      <pre>
        <code>{src}</code>
      </pre>
      {result && "error" in result && <div className="mm-err">{result.error}</div>}
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  return (
    <>
      {blocks.map((b, i) => (b.kind === "html" ? <div key={i} className="md" dangerouslySetInnerHTML={{ __html: b.html }} /> : <Diagram key={`${i}:${b.src}`} src={b.src} />))}
    </>
  );
});
