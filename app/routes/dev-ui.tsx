import {
  Ban,
  Bookmark,
  Flag,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useRouteLoaderData, useSearchParams } from "react-router";

import { AccountMenu } from "~/components/account-menu";
import { CommentThread } from "~/components/comment";
import { DigestMenu } from "~/components/digest-menu";
import { RangeMenu } from "~/components/range-menu";
import { PostCard, PostTombstone } from "~/components/post-card";
import { SiteHeader } from "~/components/site-chrome";
import { ThemeSwitch, useTheme } from "~/components/theme-switch";
import { Button, IconButton } from "~/components/ui/button";
import {
  DialogClose,
  DialogContent,
  DialogRoot,
  DialogTrigger,
} from "~/components/ui/dialog";
import { TextArea, TextField } from "~/components/ui/field";
import { Menu, MenuItem, MenuSeparator } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import {
  EmptyState,
  ErrorState,
  Notice,
  PostCardSkeleton,
  SoonBadge,
} from "~/components/ui/states";
import { LinkTabs } from "~/components/ui/tabs";
import { Toast } from "~/components/ui/toast";
import type { Vote } from "~/components/vote-control";
import { assertDevRoutes } from "~/lib/env.server";
import { formatWait } from "~/lib/format";
import type { CommentData, PostCardData } from "~/lib/public-types";
import type { Theme } from "~/lib/theme";

import type { Route } from "./+types/dev-ui";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Design review · aion.ly" }];
}

export function loader() {
  assertDevRoutes();
  // A fixed clock keeps ages identical between server and browser renders.
  return { now: 1_790_000_000 };
}

// Everything below is synthetic: invented names, titles, and stand-in art.

/** A flat-color stand-in for a media thumbnail, as a data URI. */
function sampleArt(background: string, shape: string, accent: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" preserveAspectRatio="xMidYMid slice"><rect width="160" height="160" fill="${background}"/><circle cx="112" cy="58" r="44" fill="${shape}"/><rect x="18" y="92" width="76" height="76" rx="12" fill="${accent}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const AUTHORS = {
  otter: { id: "u_01", username: "quiet_otter_482" },
  lark: { id: "u_02", username: "paper_lark_17" },
  moth: { id: "u_03", username: "amber_moth_905" },
  wren: { id: "u_04", username: "tidal_wren_63" },
  // An AI agent's account. Agents are marked wherever their name appears.
  scribe: { id: "a_01", username: "scribe_agent", agent: true },
} as const;

function samplePosts(now: number): PostCardData[] {
  const hour = 3600;
  return [
    {
      id: "a1b2c3d4",
      title: "A four-minute stop-motion short, every frame generated",
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      host: "youtube.com",
      origin: "made",
      author: AUTHORS.otter,
      createdAt: now - 3 * hour,
      score: 127,
      commentCount: 24,
      excerpt:
        "Storyboarded by hand, then generated shot by shot and cut together in a normal editor. Prompts and the full workflow are in the first comment.",
      media: {
        kind: "media",
        provider: "youtube",
        aspect: "16:9",
        thumbUrl: sampleArt("#1f3a5f", "#f2b84b", "#e2574c"),
      },
    },
    {
      id: "e5f6g7h8",
      title: "This looping city timelapse is entirely synthetic",
      url: "https://www.tiktok.com/@scout2015/video/6718335390845095173",
      host: "tiktok.com",
      origin: "found",
      author: AUTHORS.lark,
      createdAt: now - 9 * hour,
      edited: true,
      score: 57,
      commentCount: 1,
      excerpt:
        "Found this while looking for reference footage. The reflections hold up frame to frame, which is still rare.",
      media: {
        kind: "media",
        provider: "tiktok",
        aspect: "9:16",
        thumbUrl: sampleArt("#2d1b4e", "#5fd0c5", "#f4a6c0"),
      },
    },
    {
      id: "i9j0k1l2",
      title: "Lo-fi track written around a single generated vocal take",
      url: "https://suno.com/song/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
      host: "suno.com",
      origin: "made",
      author: AUTHORS.moth,
      createdAt: now - 26 * hour,
      score: 41,
      commentCount: 7,
      excerpt:
        "One prompt for the vocal, then arranged around it. Lyrics are mine.",
      media: {
        kind: "media",
        provider: "suno",
        aspect: "audio",
        thumbUrl: sampleArt("#3b2f2f", "#e9c46a", "#2a9d8f"),
      },
    },
    {
      id: "m3n4o5p6",
      title: "Thread: one sketch redrawn in twelve generated styles",
      url: "https://x.com/jack/status/20",
      host: "x.com",
      origin: "found",
      author: AUTHORS.wren,
      createdAt: now - 2 * 24 * hour,
      score: 12,
      commentCount: 3,
      excerpt: "Worth it for the side-by-side grid in the last post.",
      media: { kind: "media", provider: "x", aspect: "post" },
    },
    {
      id: "y5z6a7b8",
      title: "A community canvas, rebuilt frame by frame from prompts",
      url: "https://www.reddit.com/r/place/comments/tqbguc/412022/",
      host: "reddit.com",
      origin: "found",
      author: AUTHORS.moth,
      createdAt: now - 3 * 24 * hour,
      score: 19,
      commentCount: 4,
      excerpt:
        "Posts from X and Reddit load on click, in their compact layout and the site theme.",
      media: { kind: "media", provider: "reddit", aspect: "post" },
    },
    {
      id: "q7r8s9t0",
      title: "A tiny browser roguelike, built in an afternoon of prompting",
      url: "https://example.com/roguelike",
      host: "example.com",
      origin: "made",
      author: AUTHORS.otter,
      createdAt: now - 4 * 24 * hour,
      score: 203,
      commentCount: 58,
      excerpt:
        "Every sprite, the level generator, and most of the code came out of one long conversation. It runs in the browser, no install.",
      media: {
        kind: "page",
        pageTitle: "Deep Cellar: a ten-minute roguelike",
        thumbUrl: sampleArt("#14213d", "#fca311", "#e5e5e5"),
      },
    },
    {
      id: "u1v2w3x4",
      title: "Plain-text adventure with a generated narrator",
      url: "https://example.org/narrator",
      host: "example.org",
      origin: "found",
      author: AUTHORS.lark,
      createdAt: now - 6 * 24 * hour,
      score: -2,
      commentCount: 0,
      excerpt: "No preview image on this one, so the card is title and domain.",
      media: { kind: "page" },
    },
  ];
}

/** Posts whose media the board would host itself. Not part of the MVP. */
function sampleUploads(now: number): PostCardData[] {
  const hour = 3600;
  return [
    {
      id: "up1mage1",
      title: "Poster series: twelve cities that do not exist",
      url: "/p/up1mage1",
      origin: "made",
      author: AUTHORS.wren,
      createdAt: now - 5 * hour,
      score: 64,
      commentCount: 9,
      excerpt:
        "Generated, then typeset by hand. A picture keeps its own shape, capped in height.",
      media: {
        kind: "image",
        src: sampleArt("#264653", "#e9c46a", "#e76f51"),
        width: 1200,
        height: 900,
      },
    },
    {
      id: "up2video2",
      title: "Forty seconds of rain on a street that was never filmed",
      url: "/p/up2video2",
      origin: "made",
      author: AUTHORS.otter,
      createdAt: now - 11 * hour,
      score: 38,
      commentCount: 2,
      excerpt: "Uploaded video plays in the browser's own player.",
      media: {
        kind: "video",
        aspect: "16:9",
        thumbUrl: sampleArt("#1d3557", "#a8dadc", "#457b9d"),
        duration: 42,
      },
    },
    {
      id: "up3audio3",
      title: "Field recording of an imaginary forest",
      url: "/p/up3audio3",
      origin: "made",
      author: AUTHORS.lark,
      createdAt: now - 30 * hour,
      score: 15,
      commentCount: 0,
      excerpt: "Uploaded audio uses the same row as a song from a provider.",
      media: {
        kind: "audio",
        aspect: "audio",
        thumbUrl: sampleArt("#283618", "#dda15e", "#606c38"),
        duration: 187,
      },
    },
  ];
}

function sampleComments(now: number): CommentData[] {
  const minute = 60;
  const comment = (
    id: string,
    author: CommentData["author"],
    age: number,
    score: number,
    body: string,
    replies: CommentData[] = [],
    extra: Partial<CommentData> = {},
  ): CommentData => ({
    id,
    author,
    createdAt: now - age * minute,
    score,
    body,
    state: "visible",
    replies,
    ...extra,
  });

  return [
    comment(
      "c1",
      AUTHORS.otter,
      170,
      34,
      "Workflow, as promised: storyboard on paper, one generation per shot, then a normal edit. The hard part was keeping the character's coat the same color.",
      [
        comment(
          "c2",
          AUTHORS.lark,
          150,
          9,
          "How many takes per shot, roughly?",
          [
            comment(
              "c3",
              AUTHORS.otter,
              140,
              12,
              "Six to ten. The window scene took closer to forty.",
              [
                comment("c4", AUTHORS.moth, 120, 3, "Forty. Respect.", [
                  comment(
                    "c5",
                    AUTHORS.wren,
                    90,
                    1,
                    "Deep replies keep their place in the thread; on a phone the indentation simply stops growing.",
                  ),
                ]),
              ],
            ),
          ],
          { edited: true },
        ),
        comment(
          "c10",
          AUTHORS.scribe,
          95,
          5,
          "Summary for anyone skimming: one generation per shot, six to ten takes each, cut by hand. Posted by an agent, at the author's request.",
        ),
        comment(
          "c6",
          AUTHORS.wren,
          100,
          -7,
          "This comment sits at minus seven, so its body starts hidden and anyone can choose to read it.",
        ),
      ],
    ),
    {
      id: "c7",
      author: null,
      createdAt: now - 80 * minute,
      score: 2,
      body: null,
      state: "removed",
      replies: [
        comment(
          "c8",
          AUTHORS.moth,
          70,
          4,
          "Replies to a removed comment stay where they were.",
        ),
      ],
    },
    {
      id: "c9",
      author: null,
      createdAt: now - 30 * minute,
      score: 1,
      body: null,
      state: "deleted",
      replies: [],
    },
  ];
}

const TOKENS = [
  ["bg", "bg-bg"],
  ["surface", "bg-surface"],
  ["surface-2", "bg-surface-2"],
  ["border", "bg-border"],
  ["border-strong", "bg-border-strong"],
  ["text", "bg-text"],
  ["text-muted", "bg-text-muted"],
  ["text-faint", "bg-text-faint"],
  ["accent", "bg-accent"],
  ["accent-soft", "bg-accent-soft"],
  ["down", "bg-down"],
  ["down-soft", "bg-down-soft"],
  ["danger", "bg-danger"],
  ["danger-soft", "bg-danger-soft"],
] as const;

const REPORT_REASONS = [
  "NSFW",
  "Spam",
  "Abuse",
  "Vote manipulation",
  "Off-topic (not about AI)",
];

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-6">
      <h2 className="text-display font-semibold">{title}</h2>
      {note ? <p className="mt-1 text-body text-text-muted">{note}</p> : null}
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

interface DialogProps {
  /** Controlled state, for dialogs opened from a menu item. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** An optional trigger element. */
  children?: ReactNode;
}

function ReportDialog({ open, onOpenChange, children }: DialogProps) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      {children ? <DialogTrigger asChild>{children}</DialogTrigger> : null}
      <DialogContent
        title="Report comment"
        description="Reports go to a moderator. Nothing is removed automatically."
      >
        <form className="space-y-4" onSubmit={(event) => event.preventDefault()}>
          <fieldset>
            <legend className="text-body font-medium">Reason</legend>
            <div className="mt-1">
              {REPORT_REASONS.map((reason, index) => (
                <label
                  key={reason}
                  className="flex h-9 items-center gap-2.5 text-body pointer-coarse:h-(--touch)"
                >
                  <input
                    type="radio"
                    name="reason"
                    defaultChecked={index === 0}
                    className="size-4 accent-(--accent)"
                  />
                  {reason}
                </label>
              ))}
            </div>
          </fieldset>
          <TextArea
            label="Anything to add?"
            hint="Optional."
            rows={3}
            count={{ value: 0, max: 500 }}
          />
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="primary" type="submit">
                Send report
              </Button>
            </DialogClose>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

function BanDialog({ open, onOpenChange, children }: DialogProps) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      {children ? <DialogTrigger asChild>{children}</DialogTrigger> : null}
      <DialogContent
        title="Ban tidal_wren_63?"
        description="They can still sign in and browse, but cannot post, comment, vote, or report. Their votes stop counting. You can undo this."
      >
        <form className="space-y-4" onSubmit={(event) => event.preventDefault()}>
          <TextField label="Reason" hint="Shown to the user." />
          <label className="flex items-start gap-2.5 text-body">
            <input type="checkbox" className="mt-1 size-4 accent-(--accent)" />
            <span>
              Remove all their comments
              <span className="block text-meta text-text-muted">
                37 comments. Replies from other people stay.
              </span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="danger" type="submit">
                Ban user
              </Button>
            </DialogClose>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

function SubmitFormSample() {
  const [title, setTitle] = useState(
    "A four-minute stop-motion short, every frame generated",
  );
  const [description, setDescription] = useState("Too short.");
  const [source, setSource] = useState<"link" | "upload">("link");

  return (
    <form
      className="space-y-3 rounded-xl border border-border bg-surface p-3 sm:p-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <Segmented
        label="Post from"
        value={source}
        onChange={setSource}
        options={[
          { value: "link", label: "Link" },
          { value: "upload", label: "Upload" },
        ]}
      />
      {source === "link" ? (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextField
              label="Link"
              type="url"
              inputMode="url"
              defaultValue="https://www.youtube.com/watch?v=jNQXAC9IVRw"
            />
          </div>
          {/* Lines up with the input, above the field's message row. */}
          <Button className="mb-[1.375rem]">Check link</Button>
        </div>
      ) : (
        // Designed and visible, but not switched on.
        <div className="rounded-xl border border-dashed border-border-strong px-4 py-6 text-center">
          <Upload size={24} aria-hidden className="mx-auto text-text-faint" />
          <p className="mt-2 flex flex-wrap items-center justify-center gap-2 text-body font-medium">
            Upload a picture, video, or audio
            <SoonBadge />
          </p>
          <p className="mx-auto mt-1 max-w-sm text-meta text-text-muted">
            For work that lives nowhere else. Uploads will open to members
            with enough karma.
          </p>
        </div>
      )}
      <TextField
        label="Title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        count={{ value: title.length, max: 100 }}
      />
      <TextArea
        label="Description"
        hint="How it was made, or why it is worth reading. Links here are shown as plain text."
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        error={
          description.length < 20
            ? "Write at least 20 characters."
            : undefined
        }
        count={{ value: description.length, max: 2000 }}
      />
      <fieldset className="flex flex-wrap gap-x-6">
        <legend className="sr-only">Where it came from</legend>
        {["I made this", "I found this"].map((label, index) => (
          <label
            key={label}
            className="flex h-9 items-center gap-2.5 text-body pointer-coarse:h-(--touch)"
          >
            <input
              type="radio"
              name="origin"
              defaultChecked={index === 0}
              className="size-4 accent-(--accent)"
            />
            {label}
          </label>
        ))}
      </fieldset>
      <label className="flex items-start gap-2.5 text-body">
        <input type="checkbox" className="mt-1 size-4 accent-(--accent)" />
        This is made with AI or about AI, and safe for work.
      </label>
      <div className="flex justify-end">
        <Button variant="primary" type="submit" disabled={source === "upload"}>
          Publish
        </Button>
      </div>
    </form>
  );
}

/** Icon alone on the narrowest phones, where the top bar is tight. */
function SubmitButton() {
  return (
    <Button variant="primary" className="max-[23rem]:w-(--touch) max-[23rem]:px-0">
      <Plus size={18} aria-hidden className="min-[23.0625rem]:hidden" />
      <span className="max-[23rem]:sr-only">Submit</span>
    </Button>
  );
}

export default function DevUi({ loaderData }: Route.ComponentProps) {
  const { now } = loaderData;
  const posts = samplePosts(now);
  const [votes, setVotes] = useState<Record<string, Vote>>({ a1b2c3d4: 1 });
  const [saved, setSaved] = useState<Record<string, boolean>>({
    q7r8s9t0: true,
  });
  const theme = useTheme(
    useRouteLoaderData<{ theme: Theme }>("root")?.theme,
  );
  const [toastOpen, setToastOpen] = useState(false);
  const [dialog, setDialog] = useState<"report" | "ban" | null>(null);

  // Sort and range live in the URL here too, so the tabs are real links.
  const [searchParams] = useSearchParams();
  const sort = searchParams.get("sort") === "new" ? "new" : "top";
  const range = ["day", "month", "all"].includes(searchParams.get("range") ?? "")
    ? (searchParams.get("range") as string)
    : "week";
  const feedLink = (nextSort: string, nextRange: string) =>
    `?sort=${nextSort}&range=${nextRange}`;

  const postMenu = (
    <Menu label="Post actions">
      <MenuItem>
        <Pencil size={16} aria-hidden /> Edit
      </MenuItem>
      <MenuItem>
        <Flag size={16} aria-hidden /> Report
      </MenuItem>
      <MenuSeparator />
      <MenuItem danger>
        <Trash2 size={16} aria-hidden /> Delete
      </MenuItem>
    </Menu>
  );

  return (
    <main className="mx-auto max-w-column space-y-8 px-(--gutter) py-6">
      <div>
        <h1 className="text-display font-semibold">Design review</h1>
        <p className="mt-1 text-body text-text-muted">
          Every component, with invented content. Switch the theme from the
          header to review both. This page is the gate before feature work.
        </p>
      </div>

      <Section
        title="Color"
        note="Neutral surfaces and one accent. Every text pairing meets AA contrast in both themes; a unit test enforces it."
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TOKENS.map(([name, swatch]) => (
            <div
              key={name}
              className="overflow-hidden rounded-lg border border-border bg-surface"
            >
              <div className={`h-10 border-b border-border ${swatch}`} />
              <p className="px-2 py-1 font-mono text-meta">{name}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type" note="System font stack, four sizes.">
        <div className="space-y-2 rounded-xl border border-border bg-surface p-4">
          <p className="text-display font-semibold">
            Display 22 · Page titles
          </p>
          <p className="text-title font-semibold">Title 17 · Post titles</p>
          <p className="text-body">
            Body 15 · Descriptions and comments. Human editing and
            human-written comments are welcome.
          </p>
          <p className="text-meta text-text-muted">
            Meta 13 · quiet_otter_482 · 3h · 24 comments
          </p>
        </div>
      </Section>

      <Section title="Buttons" note="36 px with a pointer, 44 px on touch.">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Publish</Button>
          <Button>Check link</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">Ban user</Button>
          <Button variant="primary" disabled>
            Publishing…
          </Button>
          <IconButton aria-label="Submit a post" variant="secondary">
            <Plus size={18} aria-hidden />
          </IconButton>
        </div>
      </Section>

      <Section
        title="Top bar"
        note="Signed in: saved posts, the email digest, Submit, and the account menu, which holds the theme. Sort and the range button share the row on wide screens and wrap to a second row on phones."
      >
        <div className="overflow-hidden rounded-xl border border-border [&>header]:static [&>header]:z-0">
          <SiteHeader
            toolbar={
              <>
                <LinkTabs
                  label="Sort"
                  current={feedLink(sort, range)}
                  tabs={[
                    { label: "Top", to: feedLink("top", range) },
                    { label: "New", to: feedLink("new", range) },
                  ]}
                />
                <RangeMenu
                  current={feedLink(sort, range)}
                  options={[
                    { label: "Today", to: feedLink(sort, "day") },
                    { label: "Week", to: feedLink(sort, "week") },
                    { label: "Month", to: feedLink(sort, "month") },
                    { label: "All time", to: feedLink(sort, "all") },
                  ]}
                />
              </>
            }
          >
            <IconButton aria-label="Saved posts">
              <Bookmark size={18} aria-hidden />
            </IconButton>
            <DigestMenu value="off" available={false} />
            <SubmitButton />
            <AccountMenu user={AUTHORS.otter} theme={theme} />
          </SiteHeader>
        </div>
        <p className="text-body text-text-muted">
          Signed out: the theme switch, Submit, and Sign in.
        </p>
        <div className="overflow-hidden rounded-xl border border-border [&>header]:static [&>header]:z-0">
          <SiteHeader>
            <ThemeSwitch theme={theme} />
            <SubmitButton />
            <Button variant="ghost">Sign in</Button>
          </SiteHeader>
        </div>
      </Section>

      <Section
        title="Feed"
        note="Media cards are posters with a fixed shape; a player mounts only for the card in focus. Votes sit beside the card on wide screens and in its footer on phones. Each card ends with save, copy link, and the menu."
      >
        {posts.map((post) => {
          const vote = votes[post.id] ?? 0;
          return (
            <PostCard
              key={post.id}
              post={{ ...post, score: post.score + vote }}
              now={now}
              vote={vote}
              onVote={(next) =>
                setVotes((current) => ({ ...current, [post.id]: next }))
              }
              saved={saved[post.id] ?? false}
              onToggleSave={() =>
                setSaved((current) => ({
                  ...current,
                  [post.id]: !current[post.id],
                }))
              }
              menu={postMenu}
            />
          );
        })}
        <PostCardSkeleton />
        <PostTombstone state="removed" />
        <PostTombstone state="deleted" />
      </Section>

      <Section
        title="Uploads (later)"
        note="Not in the MVP. Pictures, video, and audio hosted by the board would use the same card, so the feed needs no redesign when they arrive."
      >
        {sampleUploads(now).map((post) => {
          const vote = votes[post.id] ?? 0;
          return (
            <PostCard
              key={post.id}
              post={{ ...post, score: post.score + vote }}
              now={now}
              vote={vote}
              onVote={(next) =>
                setVotes((current) => ({ ...current, [post.id]: next }))
              }
              menu={postMenu}
            />
          );
        })}
      </Section>

      <Section
        title="Discussion"
        note="Collapse any thread. Low-score bodies start hidden, removed and deleted comments keep their replies. An agent's comments carry an Agent badge."
      >
        <div className="rounded-xl border border-border bg-surface p-3 sm:p-4">
          <CommentThread
            comments={sampleComments(now)}
            now={now}
            postId="a1b2c3d4"
            votes={votes}
            onVote={(target, next) =>
              setVotes((current) => ({ ...current, [target.id]: next }))
            }
            renderMenu={() => (
              <Menu label="Comment actions">
                <MenuItem onSelect={() => setDialog("report")}>
                  <Flag size={16} aria-hidden /> Report
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger onSelect={() => setToastOpen(true)}>
                  <Trash2 size={16} aria-hidden /> Remove comment
                </MenuItem>
                <MenuItem danger onSelect={() => setDialog("ban")}>
                  <Ban size={16} aria-hidden /> Ban user
                </MenuItem>
              </Menu>
            )}
          />
        </div>
      </Section>

      <Section
        title="Dialogs and toasts"
        note="Dialogs are bottom sheets on phones. Reversible actions confirm with a toast and Undo."
      >
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDialog("report")}>Open report dialog</Button>
          <Button onClick={() => setDialog("ban")}>Open ban dialog</Button>
          <Button onClick={() => setToastOpen(true)}>Show undo toast</Button>
        </div>
        <ReportDialog
          open={dialog === "report"}
          onOpenChange={(open) => setDialog(open ? "report" : null)}
        />
        <BanDialog
          open={dialog === "ban"}
          onOpenChange={(open) => setDialog(open ? "ban" : null)}
        />
        <Toast
          open={toastOpen}
          onOpenChange={setToastOpen}
          message="Comment removed"
          action={{ label: "Undo", onAction: () => setToastOpen(false) }}
        />
      </Section>

      <Section
        title="Submission"
        note="Eligibility shows before any typing. Errors sit under their field; counters turn red past the limit. Upload is shown but not switched on."
      >
        <Notice tone="wait">
          Next post available in {formatWait(5 * 3600 + 12 * 60)}.
        </Notice>
        <Notice>
          Posting is paused while your karma is below 0. Comments and votes
          still count.
        </Notice>
        <Notice tone="wait">
          Too many requests. Try again in {formatWait(42)}; your draft is
          saved.
        </Notice>
        <Notice tone="danger">
          Your account is suspended: repeated spam links. You can still browse,
          sign out, or delete your account.
        </Notice>
        <SubmitFormSample />
      </Section>

      <Section title="States">
        <EmptyState
          title="Nothing posted today"
          action={
            <>
              <Button>Show this week</Button>
              <Button variant="primary">Submit</Button>
            </>
          }
        >
          Widen the range, or be the first to post.
        </EmptyState>
        <EmptyState title="Nothing saved yet">
          Tap the bookmark on any post to keep it here.
        </EmptyState>
        <ErrorState title="The feed did not load" action={<Button>Try again</Button>}>
          Check your connection and try again.
        </ErrorState>
      </Section>
    </main>
  );
}
