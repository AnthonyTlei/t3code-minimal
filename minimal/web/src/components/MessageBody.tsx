import { CopyIcon, CheckIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <span className="copy-control"><Button size="icon-xs" variant="ghost-muted" aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setFailed(false); } catch { setFailed(true); }
  }}>{copied ? <CheckIcon /> : <CopyIcon />}</Button>{failed && <span role="status">Select text to copy</span>}</span>;
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  return <div className="code-block"><div className="code-heading"><span>{language || "text"}</span><CopyButton text={code} label="Copy code" /></div><pre><code>{code}</code></pre></div>;
}

export function MessageBody({ text }: { text: string }) {
  const parts = text.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/gm);
  return <div className="message-body">{parts.map((part, index) => {
    const match = /^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/m.exec(part);
    if (match) return <CodeBlock key={index} language={match[1].trim()} code={match[2].replace(/\n$/, "")} />;
    return part.split("\n\n").filter(Boolean).map((paragraph, offset) => {
      const heading = /^(#{1,3})\s+(.+)$/.exec(paragraph);
      if (heading) return <h3 key={`${index}:${offset}`}>{heading[2]}</h3>;
      return <p key={`${index}:${offset}`}>{paragraph.split(/(`[^`\n]+`)/g).map((span, n) => span.startsWith("`") && span.endsWith("`") ? <code key={n}>{span.slice(1, -1)}</code> : span)}</p>;
    });
  })}</div>;
}
