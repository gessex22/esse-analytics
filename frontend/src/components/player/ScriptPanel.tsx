interface ScriptPanelProps {
  ideaNucleo: string;
  resumenVisual: string;
}

export function ScriptPanel({ ideaNucleo, resumenVisual }: ScriptPanelProps) {
  return (
    <div className="flex flex-col h-full overflow-y-auto space-y-5 pr-1">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
          Idea Núcleo
        </h3>
        <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
          {ideaNucleo || <span className="text-muted-foreground italic">Sin guión asociado</span>}
        </p>
      </div>

      {resumenVisual && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
            Resumen Visual
          </h3>
          <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
            {resumenVisual}
          </p>
        </div>
      )}
    </div>
  );
}
