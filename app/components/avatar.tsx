import { generatedAvatar } from "~/lib/avatar";

/**
 * The default avatar, drawn inline so it needs no image request. A Google
 * photo is shown only when the user has opted in.
 */
export function Avatar({
  userId,
  username,
  photoUrl,
  size = 24,
}: {
  userId: string;
  username: string;
  /** A first-party `/img/<key>` snapshot of an opted-in photo. */
  photoUrl?: string;
  size?: number;
}) {
  if (photoUrl) {
    // Sized in its style too: the base styles give images `height: auto`,
    // which would draw a picture that is not square as an oval.
    return (
      <img
        src={photoUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        loading="lazy"
        decoding="async"
        className="shrink-0 rounded-full object-cover"
      />
    );
  }

  const { color, letter } = generatedAvatar(userId, username);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden
      className="shrink-0"
    >
      <rect width="32" height="32" rx="16" fill={color} />
      <text
        x="16"
        y="16"
        dominantBaseline="central"
        textAnchor="middle"
        fontSize="15"
        fontWeight="600"
        fill="#ffffff"
      >
        {letter}
      </text>
    </svg>
  );
}
