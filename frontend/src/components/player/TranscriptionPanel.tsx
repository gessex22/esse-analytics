import { useRef, useEffect, useMemo } from "react";

interface TranscriptionPanelProps {
  text: string;
  duration: number;
  wordsPerMinute: number;
  currentTime: number;
  onSeek: (time: number) => void;
}

interface Sentence {
  text: string;
  startTime: number;
  endTime: number;
  startWord: number;
  endWord: number;
}

function buildSentences(text: string, duration: number, wpm: number): Sentence[] {
  if (!text) return [];
  const words = text.trim().split(/\s+/);
  const totalWords = words.length;
  const secondsPerWord = wpm > 0 ? 60 / wpm : duration / Math.max(totalWords, 1);

  // Split by sentence-ending punctuation
  const rawSentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const sentences: Sentence[] = [];
  let wordCursor = 0;

  for (const raw of rawSentences) {
    const sentenceWords = raw.trim().split(/\s+/).filter(Boolean);
    if (sentenceWords.length === 0) continue;
    const startWord = wordCursor;
    const endWord   = wordCursor + sentenceWords.length - 1;
    const rawStart  = startWord * secondsPerWord;
    const rawEnd    = (endWord + 1) * secondsPerWord;
    const startTime = duration > 0 ? Math.min(rawStart, duration) : rawStart;
    const endTime   = duration > 0 ? Math.min(rawEnd,   duration) : rawEnd;
    sentences.push({ text: raw.trim(), startTime, endTime, startWord, endWord });
    wordCursor += sentenceWords.length;
  }

  return sentences;
}

function formatTimestamp(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function TranscriptionPanel({
  text,
  duration,
  wordsPerMinute,
  currentTime,
  onSeek,
}: TranscriptionPanelProps) {
  const sentences = useMemo(
    () => buildSentences(text, duration, wordsPerMinute || 150),
    [text, duration, wordsPerMinute]
  );

  const activeRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Find active sentence
  const activeIndex = useMemo(() => {
    if (sentences.length === 0) return -1;
    for (let i = sentences.length - 1; i >= 0; i--) {
      if (currentTime >= sentences[i].startTime) return i;
    }
    return 0;
  }, [currentTime, sentences]);

  // Auto-scroll active sentence into view
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex]);

  if (!text) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground italic">Sin transcripción disponible</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-y-auto space-y-1 pr-1">
      {sentences.map((s, i) => {
        const isActive = i === activeIndex;
        return (
          <button
            key={i}
            ref={isActive ? activeRef : null}
            onClick={() => onSeek(s.startTime)}
            className={`w-full text-left px-3 py-2 rounded-lg transition-colors group ${
              isActive
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
            }`}
          >
            <span
              className={`text-[10px] font-mono mr-2 ${
                isActive ? "text-primary" : "text-muted-foreground/50 group-hover:text-muted-foreground"
              }`}
            >
              {formatTimestamp(s.startTime)}
            </span>
            <span className={`text-xs leading-snug ${isActive ? "font-medium" : ""}`}>
              {s.text}
            </span>
          </button>
        );
      })}
    </div>
  );
}
