import { FileUp, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { formatDuration } from "~/lib/format";
import { type MediaType, mediaTypeOf, sizeLabel, UPLOAD_ACCEPT, UPLOAD_LIMITS } from "~/lib/uploads";

import { cn } from "~/lib/cn";

import { Button } from "./ui/button";

/** Whether a drag carries files, rather than text or a link. */
const carriesFiles = (event: { dataTransfer: DataTransfer | null }) => event.dataTransfer?.types.includes("Files") === true;

/** An upload the server has kept, ready to publish with. */
export interface Uploaded {
  key: string;
  media: MediaType;
  /** The uploader's own copy, for the preview. */
  preview: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  posterKey: string | null;
}

/** Sends a body to the upload endpoint, reporting progress, which fetch cannot. */
function send(body: Blob, role: "media" | "poster", onProgress?: (share: number) => void) {
  return new Promise<{ ok: true; key: string; media: MediaType } | { ok: false; error: string }>((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/submit/upload${role === "poster" ? "?role=poster" : ""}`);
    request.setRequestHeader("Content-Type", body.type || "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    request.onload = () => {
      try {
        resolve(JSON.parse(request.responseText) as { ok: true; key: string; media: MediaType });
      } catch {
        resolve({ ok: false, error: "That did not upload. Try again." });
      }
    };
    request.onerror = () => resolve({ ok: false, error: "That did not upload. Check your connection and try again." });
    request.send(body);
  });
}

/** The size and length of a file, read by the browser that plays it. */
function probe(file: File, media: MediaType, url: string) {
  return new Promise<{ width: number | null; height: number | null; duration: number | null; poster: Blob | null }>(
    (resolve) => {
      if (media === "image") {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight, duration: null, poster: null });
        image.onerror = () => resolve({ width: null, height: null, duration: null, poster: null });
        image.src = url;
        return;
      }
      const element = document.createElement(media === "video" ? "video" : "audio");
      element.preload = "metadata";
      element.muted = true;
      const done = (poster: Blob | null) => {
        const video = element as HTMLVideoElement;
        resolve({
          width: media === "video" ? video.videoWidth || null : null,
          height: media === "video" ? video.videoHeight || null : null,
          duration: Number.isFinite(element.duration) ? Math.round(element.duration) : null,
          poster,
        });
      };
      element.onerror = () => done(null);
      element.onloadedmetadata = () => {
        if (media !== "video") return done(null);
        // The poster is a frame a little way in, past any black lead-in.
        element.currentTime = Math.min(1, (element.duration || 0) / 10);
      };
      element.onseeked = () => {
        const video = element as HTMLVideoElement;
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight, 1));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => done(blob), "image/jpeg", 0.85);
      };
      element.src = url;
    },
  );
}

/**
 * Picks a picture, video, or audio file and uploads it at once, with its
 * poster frame for a video, so Publish only has to name it. A file can be
 * chosen or dropped on it; one dropped elsewhere on the page is ignored,
 * rather than opened in place of the form.
 */
export function UploadPicker({
  value,
  onChange,
  error,
}: {
  value: Uploaded | null;
  onChange: (next: Uploaded | null) => void;
  error?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  // A file dropped beside the picker would replace the page, and what was typed.
  useEffect(() => {
    const ignore = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", ignore);
    window.addEventListener("drop", ignore);
    return () => {
      window.removeEventListener("dragover", ignore);
      window.removeEventListener("drop", ignore);
    };
  }, []);

  // The preview is the uploader's own file; let it go when replaced.
  useEffect(() => () => (value ? URL.revokeObjectURL(value.preview) : undefined), [value]);

  const choose = async (file: File) => {
    setProblem(null);
    const media = mediaTypeOf(file.type);
    if (!media) return setProblem("Choose a picture, a video, or an audio file.");
    if (file.size > UPLOAD_LIMITS[media]) {
      return setProblem(`That file is ${sizeLabel(file.size)}; ${media === "image" ? "pictures" : media} can be at most ${sizeLabel(UPLOAD_LIMITS[media])}.`);
    }
    const preview = URL.createObjectURL(file);
    const shape = await probe(file, media, preview);
    setProgress(0);
    const sent = await send(file, "media", setProgress);
    if (!sent.ok) {
      setProgress(null);
      URL.revokeObjectURL(preview);
      return setProblem(sent.error);
    }
    let posterKey: string | null = null;
    if (shape.poster) {
      const poster = await send(shape.poster, "poster");
      if (poster.ok) posterKey = poster.key;
    }
    setProgress(null);
    onChange({ key: sent.key, media: sent.media, preview, width: shape.width, height: shape.height, duration: shape.duration, posterKey });
  };

  if (value) {
    return (
      <div className="space-y-2">
        <div className="relative overflow-hidden rounded-xl bg-surface-2">
          {value.media === "image" ? (
            <img src={value.preview} alt="Your upload" className="mx-auto max-h-80 w-auto max-w-full object-contain" />
          ) : value.media === "video" ? (
            <video src={value.preview} controls playsInline className="mx-auto max-h-80 w-auto max-w-full" />
          ) : (
            <audio src={value.preview} controls className="w-full p-3" />
          )}
        </div>
        <div className="flex items-center justify-between gap-3 text-meta text-text-muted">
          <span>
            Uploaded{value.duration ? ` · ${formatDuration(value.duration)}` : ""}. It is published with the post.
          </span>
          <Button variant="ghost" onClick={() => onChange(null)}>
            <X size={16} aria-hidden /> Remove
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      // Handled here, as a disabled button gets no drag events while a file uploads.
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = progress === null ? "copy" : "none";
        setOver(progress === null);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file && progress === null) void choose(file);
      }}
    >
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={progress !== null}
        aria-describedby={hintId}
        className={cn(
          "flex w-full flex-col items-center rounded-xl border border-dashed border-border-strong px-4 py-6 text-center hover:bg-surface-2 disabled:opacity-70",
          over && "border-accent bg-accent-soft",
        )}
      >
        <FileUp size={24} aria-hidden className="text-text-faint" />
        <span className="mt-2 text-body font-medium">
          {progress === null ? "Choose or drop a picture, video, or audio file" : `Uploading… ${Math.round(progress * 100)}%`}
        </span>
        <span id={hintId} className="mt-1 max-w-sm text-meta text-text-muted">
          Pictures up to {sizeLabel(UPLOAD_LIMITS.image)}, audio up to {sizeLabel(UPLOAD_LIMITS.audio)}, video up to{" "}
          {sizeLabel(UPLOAD_LIMITS.video)}. Location data is removed from JPEG photos; other files keep theirs.
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label="Upload a file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void choose(file);
        }}
      />
      {problem || error ? (
        <p role="alert" className="mt-1 text-meta text-danger">
          {problem ?? error}
        </p>
      ) : null}
    </div>
  );
}
