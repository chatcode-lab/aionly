import { ChevronLeft, ChevronRight, FileUp, ImagePlus, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { formatDuration } from "~/lib/format";
import { GALLERY_MAX } from "~/lib/gallery";
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
function send(body: Blob, role: "media" | "poster", onProgress?: (share: number) => void, set: string | null = null) {
  return new Promise<{ ok: true; key: string; media: MediaType } | { ok: false; error: string }>((resolve) => {
    const request = new XMLHttpRequest();
    const query = new URLSearchParams(role === "poster" ? { role } : set ? { set } : {});
    request.open("POST", `/submit/upload${query.size > 0 ? `?${query}` : ""}`);
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

/** One set per form, so its pictures gather into one gallery on the server. */
function newSet(): string {
  return crypto.randomUUID();
}

/**
 * Picks pictures, up to GALLERY_MAX for a gallery, or one video or audio
 * file, and uploads each at once, a video with its poster frame, so
 * Publish only has to name them. Pictures can be put in order, the first
 * being the cover, and taken out. Files can be chosen or dropped on it; one
 * dropped elsewhere on the page is ignored, rather than opened in place of
 * the form.
 */
export function UploadPicker({
  value,
  onChange,
  error,
}: {
  value: Uploaded[];
  onChange: (next: Uploaded[]) => void;
  error?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const set = useRef<string | null>(null);
  const [progress, setProgress] = useState<{ index: number; of: number; share: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const busy = progress !== null;
  const pictures = value.length > 0 && value.every((item) => item.media === "image");
  // More can be added to an empty picker, or to pictures below the limit.
  const room = value.length === 0 || (pictures && value.length < GALLERY_MAX);

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

  /** Checks a choice of files whole, then uploads them one after another. */
  const add = async (files: File[]) => {
    setProblem(null);
    if (files.length === 0) return;
    const kinds = files.map((file) => mediaTypeOf(file.type));
    if (kinds.some((kind) => kind === null)) return setProblem("Choose pictures, a video, or an audio file.");
    const playable = kinds.some((kind) => kind !== "image");
    if (playable && (files.length > 1 || value.length > 0)) {
      return setProblem(
        value.length > 0 ? "A gallery is pictures only. Remove the pictures first to post a video or audio." : "Choose one video or audio file, or pictures.",
      );
    }
    if (!playable && value.some((item) => item.media !== "image")) return setProblem("Remove the video or audio first to post pictures.");
    if (value.length + files.length > GALLERY_MAX) return setProblem(`A gallery holds at most ${GALLERY_MAX} pictures.`);
    for (const [index, file] of files.entries()) {
      const media = kinds[index]!;
      if (file.size > UPLOAD_LIMITS[media]) {
        return setProblem(
          `${file.name} is ${sizeLabel(file.size)}; ${media === "image" ? "pictures" : media} can be at most ${sizeLabel(UPLOAD_LIMITS[media])}.`,
        );
      }
    }
    let list = value;
    for (const [index, file] of files.entries()) {
      const media = kinds[index]!;
      setProgress({ index, of: files.length, share: 0 });
      const preview = URL.createObjectURL(file);
      const shape = await probe(file, media, preview);
      const sent = await send(file, "media", (share) => setProgress({ index, of: files.length, share }), media === "image" ? (set.current ??= newSet()) : null);
      if (!sent.ok) {
        URL.revokeObjectURL(preview);
        setProblem(sent.error);
        break;
      }
      let posterKey: string | null = null;
      if (shape.poster) {
        const poster = await send(shape.poster, "poster");
        if (poster.ok) posterKey = poster.key;
      }
      list = [...list, { key: sent.key, media: sent.media, preview, width: shape.width, height: shape.height, duration: shape.duration, posterKey }];
      onChange(list);
    }
    setProgress(null);
  };

  /** Takes one out, and lets go of its file on the server, so it counts no more. */
  const remove = (key: string) => {
    const item = value.find((upload) => upload.key === key);
    if (item?.preview.startsWith("blob:")) URL.revokeObjectURL(item.preview);
    onChange(value.filter((upload) => upload.key !== key));
    void fetch(`/submit/upload?${new URLSearchParams({ key })}`, { method: "DELETE" }).catch(() => undefined);
  };

  /** Moves a picture one place earlier or later. */
  const move = (index: number, by: -1 | 1) => {
    const next = [...value];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next);
  };

  const status = progress
    ? `Uploading${progress.of > 1 ? ` ${progress.index + 1} of ${progress.of}` : ""}… ${Math.round(progress.share * 100)}%`
    : null;

  const dropHandlers = {
    // Handled here, as a disabled button gets no drag events while a file uploads.
    onDragOver: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = !busy && room ? "copy" : "none";
      setOver(!busy && room);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setOver(false);
      if (!busy && room) void add([...event.dataTransfer.files]);
    },
  };

  const fileInput = (
    <input
      ref={input}
      type="file"
      accept={UPLOAD_ACCEPT}
      multiple={value.length === 0 || pictures}
      className="sr-only"
      tabIndex={-1}
      aria-label="Upload a file"
      onChange={(event) => {
        const files = [...(event.target.files ?? [])];
        event.target.value = "";
        void add(files);
      }}
    />
  );
  const message =
    problem || error ? (
      <p role="alert" className="mt-1 text-meta text-danger">
        {problem ?? error}
      </p>
    ) : null;

  // One video or audio file.
  const single = value.length === 1 && value[0]!.media !== "image" ? value[0]! : null;
  if (single) {
    return (
      <div className="space-y-2">
        <div className="relative overflow-hidden rounded-xl bg-surface-2">
          {single.media === "video" ? (
            <video src={single.preview} controls playsInline className="mx-auto max-h-80 w-auto max-w-full" />
          ) : (
            <audio src={single.preview} controls className="w-full p-3" />
          )}
        </div>
        <div className="flex items-center justify-between gap-3 text-meta text-text-muted">
          <span>
            Uploaded{single.duration ? ` · ${formatDuration(single.duration)}` : ""}. It is published with the post.
          </span>
          <Button variant="ghost" onClick={() => remove(single.key)}>
            <X size={16} aria-hidden /> Remove
          </Button>
        </div>
        {message}
      </div>
    );
  }

  // Pictures: one, or a gallery, in order.
  if (pictures) {
    return (
      <div className="space-y-2" {...dropHandlers}>
        <ol
          aria-label="Pictures, in order"
          // Two to a row on a phone, so each tile's buttons fit.
          className={cn("grid grid-cols-2 gap-2 rounded-xl min-[26rem]:grid-cols-3 sm:grid-cols-4", over && "ring-2 ring-accent")}
        >
          {value.map((item, index) => (
            <li key={item.key} className="relative aspect-square overflow-hidden rounded-lg bg-surface-2">
              <img src={item.preview} alt={`Picture ${index + 1}`} className="size-full object-cover" />
              {index === 0 ? (
                <span className="absolute top-1 left-1 rounded bg-overlay px-1.5 py-0.5 text-meta font-medium text-on-overlay">Cover</span>
              ) : null}
              <span className="absolute top-1 right-1">
                <TileButton label={`Remove picture ${index + 1}`} disabled={busy} onClick={() => remove(item.key)}>
                  <X size={16} aria-hidden />
                </TileButton>
              </span>
              <div className="absolute inset-x-1 bottom-1 flex justify-between gap-1">
                {index > 0 ? (
                  <TileButton label={`Move picture ${index + 1} earlier`} disabled={busy} onClick={() => move(index, -1)}>
                    <ChevronLeft size={16} aria-hidden />
                  </TileButton>
                ) : (
                  <span />
                )}
                {index < value.length - 1 ? (
                  <TileButton label={`Move picture ${index + 1} later`} disabled={busy} onClick={() => move(index, 1)}>
                    <ChevronRight size={16} aria-hidden />
                  </TileButton>
                ) : null}
              </div>
            </li>
          ))}
          {room ? (
            <li>
              <button
                type="button"
                onClick={() => input.current?.click()}
                disabled={busy}
                className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong p-2 text-center text-meta text-text-muted hover:bg-surface-2 disabled:opacity-70"
              >
                <ImagePlus size={20} aria-hidden className="text-text-faint" />
                {status ?? "Add pictures"}
              </button>
            </li>
          ) : null}
        </ol>
        <p className="text-meta text-text-muted">
          {value.length > 1
            ? `A gallery of ${value.length}, the first its cover. It is published with the post.`
            : `Uploaded. Add pictures for a gallery, up to ${GALLERY_MAX}.`}
        </p>
        {fileInput}
        {message}
      </div>
    );
  }

  return (
    <div {...dropHandlers}>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        aria-describedby={hintId}
        className={cn(
          "flex w-full flex-col items-center rounded-xl border border-dashed border-border-strong px-4 py-6 text-center hover:bg-surface-2 disabled:opacity-70",
          over && "border-accent bg-accent-soft",
        )}
      >
        <FileUp size={24} aria-hidden className="text-text-faint" />
        <span className="mt-2 text-body font-medium">{status ?? "Choose or drop pictures, a video, or an audio file"}</span>
        <span id={hintId} className="mt-1 max-w-sm text-meta text-text-muted">
          Up to {GALLERY_MAX} pictures for a gallery, each up to {sizeLabel(UPLOAD_LIMITS.image)}; audio up to{" "}
          {sizeLabel(UPLOAD_LIMITS.audio)}, video up to {sizeLabel(UPLOAD_LIMITS.video)}. Location data is removed from
          JPEG photos; other files keep theirs.
        </span>
      </button>
      {fileInput}
      {message}
    </div>
  );
}

/** A small control on a picture's tile, readable over any picture. */
function TileButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-md bg-overlay text-on-overlay hover:bg-scrim disabled:opacity-50 pointer-coarse:size-9"
    >
      {children}
    </button>
  );
}
