"use client";

import { useEffect, useRef, useState } from "react";
import { AudioLines, FileText } from "lucide-react";
import type { ExhibitionChapter, Locale } from "@/contracts/guild";
import type { ExhibitionUi } from "@/exhibition/locales";
import { safeMediaUrl } from "@/exhibition/safety";

export function ExhibitionAudio({ chapter, locale, ui }: { chapter: ExhibitionChapter; locale: Locale; ui: ExhibitionUi }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const transcriptRef = useRef<HTMLOListElement>(null);
  const [time, setTime] = useState(0);
  const [failed, setFailed] = useState(false);
  const [follow, setFollow] = useState(true);
  const recording = chapter.audio[locale];
  const url = safeMediaUrl(recording?.url);
  const segments = recording?.segments.filter((segment, index, all) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start && (index === 0 || segment.start >= (all[index - 1]?.end ?? 0))) ?? [];
  const current = segments.findIndex((segment) => time >= segment.start && time < segment.end);

  useEffect(() => { const audio = audioRef.current; audio?.pause(); setTime(0); setFailed(false); }, [locale, url]);
  useEffect(() => {
    if (!follow || current < 0 || audioRef.current?.paused) return;
    const element = transcriptRef.current?.children.item(current) as HTMLElement | null;
    if (element && transcriptRef.current) transcriptRef.current.scrollTo({ top: element.offsetTop - transcriptRef.current.offsetTop - 16, behavior: "instant" });
  }, [current, follow]);

  function seek(start: number) {
    if (!audioRef.current) return;
    audioRef.current.currentTime = start;
    void audioRef.current.play().catch(() => setFailed(true));
  }

  return <div className="ex-audio" data-audio-state={url && !failed ? "available" : "transcript-only"}>
    <div className="ex-audio-label">{url && !failed ? <AudioLines size={19} aria-hidden="true" /> : <FileText size={19} aria-hidden="true" />}<span>{url && !failed ? ui.audio : ui.transcriptOnly}</span></div>
    {url && <>
      <audio ref={audioRef} key={`${chapter.id}-${locale}`} controls preload="metadata" src={url} aria-label={`${ui.audio}: ${chapter.content[locale].title.replace(/\n/g, " ")}`} onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} onError={() => setFailed(true)} />
      {!failed && <div className="ex-audio-options"><label>{ui.playbackSpeed}<select defaultValue="1" onChange={(event) => { if (audioRef.current) audioRef.current.playbackRate = Number(event.target.value); }}>{[0.75, 1, 1.25, 1.5].map((speed) => <option key={speed} value={speed}>{new Intl.NumberFormat(locale).format(speed)}×</option>)}</select></label><a href={url} download>{ui.downloadAudio}</a></div>}
    </>}
    {(!url || failed) && <p className="ex-audio-disclosure">{failed ? ui.audioUnavailable : ui.transcriptDisclosure}</p>}
    <details className="ex-transcript" open>
      <summary>{ui.transcript}</summary>
      {url && !failed && segments.length > 0 ? <>
        <label className="ex-follow"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />{ui.followTranscript}</label>
        <ol ref={transcriptRef} className="ex-transcript-segments">{segments.map((segment, index) => <li key={`${segment.start}-${index}`} data-current={current === index || undefined}><button type="button" onClick={() => seek(segment.start)} aria-label={`${ui.jumpToSegment}: ${segment.text}`} aria-current={current === index ? "true" : undefined}><span className="ex-timestamp" aria-hidden="true" dir="ltr">{Math.floor(segment.start / 60)}:{String(Math.floor(segment.start % 60)).padStart(2, "0")}</span><span>{segment.text}</span></button></li>)}</ol>
      </> : <p>{chapter.content[locale].transcript}</p>}
    </details>
  </div>;
}
