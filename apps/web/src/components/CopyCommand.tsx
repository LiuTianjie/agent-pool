import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="copy-command">
      {label ? <span>{label}</span> : null}
      <div>
        <span className="command-prompt" aria-hidden="true">
          $
        </span>
        <code>{command}</code>
        <button
          className="icon-button"
          type="button"
          aria-label="复制命令"
          onClick={() => void copy()}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
