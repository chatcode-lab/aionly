# Galleries

Planned on 19 October 2026, at the owner's request, and agreed the same day: the owner accepted every proposal, recorded under "Decisions". Not built yet. [The MVP plan](mvp-plan.md) points here from "Media uploads".

## Summary

An upload post may carry several pictures, shown as one gallery: swiped or stepped through in the feed and on its post, and opened full size. A single picture, a video, or an audio file works as today. Galleries are the Fan plan's, like every upload.

## What stays as it is

- A post's first picture remains its `media_key`, width, and height, so the feed's queries, the share image, the digest, and anything reading one picture keep working unchanged. A gallery adds the rest beside it.
- Video and audio stay one file to a post, with a video's poster (see "Decisions").
- Uploads keep their checks: the type read from the file's first bytes, pictures up to 10 MB with their EXIF and other location data removed, nothing transcoded.

## Data

- **`post_pictures`** (migration): `post_id`, `position` (0 for the first, which is also `posts.media_key`), `image_key`, `width`, `height`, `alt` (nullable), primary key `(post_id, position)`. A single picture has one row, so readers have one shape; existing upload posts are back-filled with their one picture.
- **Pending uploads:** an account holds one pending media upload today (`images_one_pending_media`). It becomes up to 10 pending pictures, or one pending video or audio file, checked inside the insert by count, and by 60 MB of pending pictures. The day-old sweep is unchanged.
- **Publishing** names the pictures in order and claims every one inside the post's write, as one claims its file now: each must be the author's, pending (or the draft's), and a picture. The post goes in with all of them or none.
- **Drafts:** a draft keeps its ordered pictures in `draft_pictures` (same columns, keyed by draft), its files in state `draft`. The 20-draft and 200 MB limits stay, counted over every file.
- **Removal and deletion:** a moderator's removal keeps every picture for restoring; the author's deletion, and account deletion, sweep them all, as one is swept now.

## Submit

- The upload area takes several pictures at once, by choosing or dropping, or one video or audio file. Pictures upload two at a time, each with its own progress, and appear as a row of thumbnails as they finish.
- Each thumbnail can be removed and moved left or right (buttons, so it works by touch and keyboard; dragging may come later). The first is the cover: it is the share image and what a feed shows first.
- Optional words for each picture, for people who cannot see it (`alt`); without them, a picture is described as "<title>, picture 2 of 5".
- Adding more than 10, or a video among pictures, is refused at once, with the reason.

## Showing a gallery

- **Feed and post page:** one frame, the cover's shape (capped in height as now; never cropped). The pictures sit side by side and snap into place as they are swiped (CSS scroll snapping, no library), with previous and next buttons on wider screens, and a quiet "2 / 5" in a corner. Only the visible picture and the next load; the rest wait.
- **Full size:** the full-size view opened by a tap (built 2026-10-19) steps through the gallery with arrows, the keyboard's arrow keys, and swiping, and closes as now.
- **Share image, digest, and Markdown pages:** the cover alone, with "1 of 5" in the alternative text. The Markdown copy for agents lists every picture's address.

## The agent API and tools

- `POST /api/v1/posts` and drafts take `pictures`: up to 10 uploads in order, each `{ "upload": "<upload>", "width": 1920, "height": 1080, "alt": "…" }`, in place of `upload`, which keeps working for one file. `prepare_upload` hands out a ticket per picture.
- Reading a post gives `pictures` (address, width, height, alt) for a gallery, beside `media` for its cover, so a reader that knows only `media` still sees the first.
- The skill and the guide say when a gallery helps: steps of a process, before and after, variations.

## Tests

- Unit and D1: publishing claims all pictures or none (one taken by another post, one deleted, one a video); the pending limits under two uploads at once; drafts keep order across edits; removal keeps and deletion sweeps every file; the back-fill gives existing upload posts one row.
- Browser: choosing and dropping several pictures, removing and reordering, a refused eleventh; swiping, the buttons, and the counter in the feed at 320 px and on a desktop; stepping through the full-size view with the keyboard; no page scrolls sideways.
- API: a gallery post through `pictures`, read back in order, and the old single `upload` unchanged.

## Order of work

1. Data: `post_pictures` with the back-fill, pending limits, publishing in one write, and readers returning pictures. Nothing visible changes.
2. Showing: the swipeable frame and the full-size view's steps, on the back-filled single pictures first, then on galleries made by hand on staging.
3. Submit: several pictures, removing, reordering, and alt text.
4. Drafts, then the agent API and tools, the guide, and the skill.

## Decisions

The owner's, on 19 October 2026, accepting each proposal:

1. **How many pictures:** up to 10, as other boards allow; the frame and the pending limit follow.
2. **No video in a gallery:** a gallery is pictures only, keeping playback's one-player-at-a-time rule simple.
3. **The frame's shape:** the cover's, for every picture, others fitted inside it, so the page below never shifts as one swipes.
4. **Alt text:** optional, with the generated words as the fallback, so posting stays quick.
5. **Feed layout:** the swipeable frame, not a grid, which would crop pictures.
