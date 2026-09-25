/*
 * The Pen mark and the Pen logotype.
 *
 * GENERATED — do not edit. `node packages/design/scripts/mark.ts` writes this
 * file from `packages/design/brand/*.svg`, which is the owner's artwork exactly
 * as it arrived, and `test/brand-mark.test.ts` fails if the two have drifted.
 * Every `d` below is copied out of that artwork byte for byte.
 *
 * Two substitutions are made on the way in, and only two:
 *
 *   The ink becomes `var(--color-mark-ink)`, on the fill and on the stroke
 *   alike. The owner draws the mark twice — #000000 on light, #FFFFFF on dark,
 *   identical geometry — and shipping the light one alone puts a logo at
 *   1.27:1 on `surface-container`, which is to say no logo at all on half the
 *   product. The token carries both, so the pair is one component and a theme
 *   switch rather than two assets somebody has to remember to change together.
 *   It is pure white in dark and not `on-surface` (#e2e2e2): body text is
 *   softened on a dark page so it does not glare, a mark is not, and that is
 *   the owner's drawing.
 *
 *   The artwork's red becomes `var(--color-mark-accent)`: the brand itself,
 *   #A9124A, the same on both grounds by the owner's ruling (ADR-0054).
 *
 * The diagonals are strokes, not filled shapes: `stroke-width`, the round cap
 * and `fill="none"` are copied across with the `d`, because each of them is
 * the difference between this drawing and a different one. It also means the
 * artwork's real extent is wider than its geometry — the box this is cropped
 * to includes the caps. See `BBOX` in the generator.
 *
 * Size is a height. A mark is set against a line of text, and it is the height
 * that has to agree with it; the width follows from the artwork's own aspect,
 * so neither of these can be squashed by passing the wrong number.
 *
 * The default is 22, and it is a height that has been held across three
 * drawings on purpose. What the header carried before this component was a
 * 22 px mark beside "Pen" set at `title-large`; an early attempt at 26 was
 * caught immediately, because a logotype that grows when it becomes artwork is
 * a redesign nobody asked for.
 *
 * What *has* moved is the width that height buys, and it is worth knowing. The
 * lockup's aspect was 3.08 and is now 2.39, because this drawing gives the
 * delta more height above the lettering than the last one did. So 22 px of
 * height is 52.5 px of width where it used to be 67.8, and the wordmark inside
 * it is set smaller against the same line of text. That is the drawing, not a
 * bug — but it is the kind of change only the owner can sign off, so the
 * height stays where it was and the question is asked rather than answered
 * here.
 */
import type { SVGProps } from 'react';

const ICON = { w: 409.343, h: 459 } as const;
const LOGO = { w: 1143.843, h: 459 } as const;

export interface PenArtProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  /** Height in px. The width follows the artwork. */
  size?: number;
  /**
   * An accessible name. Omit it where the parent already carries one — a link
   * labelled "Pen Playground home" does not want the mark announced twice.
   */
  title?: string;
}

function label(title: string | undefined) {
  return title === undefined
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': title } as const);
}

/**
 * The icon alone: the red delta and the two strokes. Use it where the word
 * "Pen" is already on the screen beside it, or where there is no room for the
 * lockup — a 16 px footer line, a 28 px tile.
 */
export function PenMark({ size = 22, title, ...rest }: PenArtProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: `label()` sets aria-hidden, or role="img" with a name when `title` is given; the rule cannot see through the spread
    <svg
      {...label(title)}
      {...rest}
      width={(size * ICON.w) / ICON.h}
      height={size}
      viewBox="0 0 409.343 459"
      fill="none"
    >
      <g transform="translate(-1068.5 -217.5)">
        <path
          d="M 1090.000 655.000 Q 1218.694 477.050 1411.000 371.000"
          fill="none"
          stroke="var(--color-mark-ink)"
          strokeWidth="43"
          strokeLinecap="round"
        />
        <path
          d="M 1202.714 640.098 Q 1311.158 516.878 1456.343 435.187"
          fill="none"
          stroke="var(--color-mark-ink)"
          strokeWidth="43"
          strokeLinecap="round"
        />
        <path
          d="M1101.3897705078125 384.17230224609375 1159.28369140625 219.1722869873047Q1159.54736328125 218.42095947265625 1160.1968994140625 217.96047973632812Q1160.846435546875 217.5 1161.6427001953125 217.5H1200.4791259765625Q1201.2757568359375 217.5 1201.925537109375 217.96095275878906Q1202.5753173828125 218.42190551757812 1202.838623046875 219.17384338378906L1260.6107177734375 384.173828125Q1260.77490234375 384.64312744140625 1260.7470703125 385.1396484375Q1260.71923828125 385.63616943359375 1260.503662109375 386.08424377441406Q1260.2880859375 386.5323181152344 1259.9173583984375 386.86375427246094Q1259.546630859375 387.1951904296875 1259.077392578125 387.35955810546875Q1258.67626953125 387.5 1258.251220703125 387.5H1103.748779296875Q1103.25146484375 387.5 1102.7919921875 387.3096923828125Q1102.33251953125 387.119384765625 1101.98095703125 386.7677307128906Q1101.62939453125 386.41607666015625 1101.4390869140625 385.9566650390625Q1101.248779296875 385.49725341796875 1101.248779296875 385.0Q1101.248779296875 384.5741271972656 1101.3897705078125 384.17230224609375ZM1181.00537109375 260.69610595703125 1149.03369140625 356.509521484375H1213.1806640625L1181.00537109375 260.69610595703125Z"
          fill="var(--color-mark-accent)"
        />
      </g>
    </svg>
  );
}

/**
 * The full lockup: the word and the icon, spaced as they were drawn. Prefer it
 * anywhere the product is naming itself — the header, the drawer — over
 * setting "Pen" in a UI face beside the mark, which is a different logo on
 * every operating system.
 */
export function PenLogo({ size = 22, title, ...rest }: PenArtProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: `label()` sets aria-hidden, or role="img" with a name when `title` is given; the rule cannot see through the spread
    <svg
      {...label(title)}
      {...rest}
      width={(size * LOGO.w) / LOGO.h}
      height={size}
      viewBox="0 0 1143.843 459"
      fill="none"
    >
      <g transform="translate(-382 -217.5)">
        <path
          d="M218.808 31.238Q230.551 40.573 237.996 56.243Q244.772 70.505 246.775 87.168Q251.301 129.822 226.277 160.801Q226.248 160.837 226.219 160.875L224.504 163.119Q213.426 176.661 194.956 184.963Q178.351 192.426 158.631 194.52Q146.694 195.657 125.049 195.6L122.529 195.599L120.032 195.59L101.626 195.56L60.005 195.5Q59.309 195.499 58.665 195.764Q58.022 196.03 57.529 196.522Q57.036 197.013 56.768 197.656Q56.501 198.299 56.5 198.995L56.5 199V304.17Q53.853 304.63 51.37 304.63L48.597 304.64L45.652 304.63L42.559 304.64L36.115 304.63L26.296 304.64L23.166 304.635L20.026 304.63H20.02L17.068 304.64L14.282 304.63L14.094 304.63H11.921Q9.036 304.494 3.5 303.875V3.5Q117.633 3.508 138.876 4.03Q153.557 4.391 160.511 5.266Q165.041 5.835 172.003 7.638L172.203 7.69L174.646 8.297Q198.467 14.494 216.764 29.692Q216.827 29.745 216.893 29.795L218.808 31.238ZM56.5 47V152Q56.5 152.694 56.765 153.336Q57.03 153.977 57.52 154.469Q58.009 154.961 58.65 155.229Q59.29 155.497 59.984 155.5L62.896 155.513L100.043 155.69L100.928 155.694L112.597 155.77L118.344 155.783L120.166 155.79L122.639 155.797L125.118 155.82Q142.498 155.968 153.74 153.259Q169.287 149.513 179.755 139.454Q179.87 139.343 179.975 139.222Q195.225 121.624 193.494 92.79Q193.486 92.668 193.47 92.546Q190.227 67.746 173.171 54.255Q173.025 54.14 172.868 54.04Q155.809 43.272 132.752 43.39L130.33 43.39L122.625 43.4L122.586 43.4L117.783 43.41L115.034 43.411L100.053 43.44L97.143 43.444L59.995 43.5Q59.299 43.501 58.657 43.768Q58.015 44.035 57.523 44.527Q57.032 45.019 56.766 45.662Q56.5 46.304 56.5 47Z"
          fill="var(--color-mark-ink)"
          stroke="var(--color-mark-ink)"
          strokeWidth="3"
          strokeLinejoin="round"
          transform="translate(380,278)"
        />
        <path
          d="M-14.022 131.626Q-0.815 134.418 15.374 138.656L19.5 139.728L20.499 139.99L25.327 141.264L28.645 142.139Q28.88 142.221 29.071 142.29Q28.041 144.331 26.859 146.353L26.687 146.647L25.743 148.273Q21.06 156.12 13.649 164.348L11.397 166.878Q-2.281 181.424 -22.62 189.344Q-41.384 196.65 -63.222 197.412Q-101.045 198.237 -131.055 181.628L-131.745 181.245L-134 180.003Q-165.361 161.336 -177.392 117.019Q-182.25 95.303 -178.319 72.137Q-174.396 49.015 -162.674 30.051Q-139.228 -5.152 -98.926 -14.908L-95.143 -15.866Q-71.129 -21.313 -46.397 -16.676Q-20.529 -11.827 -2.238 2.692Q0.45 5.032 2.882 7.267L5.648 9.754Q28.796 31.627 34.75 72.94V102.19H-124.75Q-125.446 102.19 -126.089 102.456Q-126.733 102.723 -127.225 103.215Q-127.717 103.707 -127.984 104.351Q-128.25 104.994 -128.25 105.69Q-128.25 106.074 -128.167 106.45Q-124.353 123.602 -121.027 130.878Q-115.517 142.931 -104.381 150.352Q-104.31 150.399 -104.238 150.443Q-78.866 165.632 -48.37 158.19Q-48.252 158.161 -48.136 158.124Q-26.106 151.092 -14.022 131.626ZM-112.417 34.147Q-125.026 48.469 -127.229 68.304Q-127.305 68.996 -127.112 69.664Q-126.918 70.333 -126.483 70.877Q-126.048 71.42 -125.438 71.756Q-124.828 72.092 -124.136 72.169Q-123.944 72.19 -123.75 72.19H-17.75Q-16.62 72.19 -15.704 71.529Q-14.787 70.869 -14.43 69.797Q-12.725 64.683 -14.349 58.015Q-15.225 54.415 -17.962 47.931L-17.975 47.899Q-18.022 47.789 -18.076 47.682Q-28.223 27.585 -45.739 21.249Q-45.803 21.226 -45.867 21.205Q-63.876 15.463 -80.684 18.23Q-99.04 21.252 -112.217 33.939Q-112.321 34.039 -112.417 34.147Z"
          fill="var(--color-mark-ink)"
          stroke="var(--color-mark-ink)"
          strokeWidth="3"
          strokeLinejoin="round"
          transform="translate(804.75,390.3125)"
        />
        <path
          d="M-119.483 197.683Q-137.95 198.559 -171.5 197.601V-6.5H-121.345L-120.496 12.159Q-120.465 12.854 -120.169 13.485Q-119.874 14.115 -119.36 14.585Q-118.846 15.054 -118.191 15.291Q-117.537 15.528 -116.841 15.496Q-115.496 15.435 -114.539 14.489L-114.174 14.128L-109.622 9.571Q-86.938 -9.781 -56.953 -11.901Q-26.433 -14.059 -2.073 2.822Q22.128 21.659 27.075 51.806Q27.62 56.273 27.62 61.38V65.14L27.61 69.191L27.61 73.52L27.6 85.187L27.595 91.299L27.59 97.407L27.584 108.963L27.57 120.526L27.56 133.692L27.55 146.857L27.529 173.914L27.504 197.56L-23.514 198.439L-23.61 173.896L-23.631 169.808L-23.71 156.19L-23.784 142.212L-23.85 128.163L-23.95 107.733L-23.95 107.728L-24 96.934Q-24.061 65.386 -25.579 58.255Q-26.71 52.944 -29.5 48.754Q-31.259 46.113 -36.451 40.405Q-36.527 40.321 -36.609 40.242Q-49.415 27.882 -72.143 28.291Q-72.205 28.292 -72.268 28.295Q-93.993 29.462 -107.774 44.287Q-107.887 44.41 -107.989 44.542Q-114.388 52.9 -116.865 63.108Q-118.794 71.057 -118.82 83.042L-118.82 83.331L-118.85 86.891L-118.851 87.071L-118.9 97.353L-118.97 108.22L-118.97 108.291L-119.037 118.571L-119.09 128.972L-119.156 140.72L-119.23 152.538L-119.373 176.912L-119.483 197.683Z"
          fill="var(--color-mark-ink)"
          stroke="var(--color-mark-ink)"
          strokeWidth="3"
          strokeLinejoin="round"
          transform="translate(1031,384)"
        />
        {/* The icon sits LOCKUP_GAP further from the word than the artwork draws it. */}
        <g transform="translate(48 0)">
          <path
            d="M 1090.000 655.000 Q 1218.694 477.050 1411.000 371.000"
            fill="none"
            stroke="var(--color-mark-ink)"
            strokeWidth="43"
            strokeLinecap="round"
          />
          <path
            d="M 1202.714 640.098 Q 1311.158 516.878 1456.343 435.187"
            fill="none"
            stroke="var(--color-mark-ink)"
            strokeWidth="43"
            strokeLinecap="round"
          />
          <path
            d="M1101.3897705078125 384.17230224609375 1159.28369140625 219.1722869873047Q1159.54736328125 218.42095947265625 1160.1968994140625 217.96047973632812Q1160.846435546875 217.5 1161.6427001953125 217.5H1200.4791259765625Q1201.2757568359375 217.5 1201.925537109375 217.96095275878906Q1202.5753173828125 218.42190551757812 1202.838623046875 219.17384338378906L1260.6107177734375 384.173828125Q1260.77490234375 384.64312744140625 1260.7470703125 385.1396484375Q1260.71923828125 385.63616943359375 1260.503662109375 386.08424377441406Q1260.2880859375 386.5323181152344 1259.9173583984375 386.86375427246094Q1259.546630859375 387.1951904296875 1259.077392578125 387.35955810546875Q1258.67626953125 387.5 1258.251220703125 387.5H1103.748779296875Q1103.25146484375 387.5 1102.7919921875 387.3096923828125Q1102.33251953125 387.119384765625 1101.98095703125 386.7677307128906Q1101.62939453125 386.41607666015625 1101.4390869140625 385.9566650390625Q1101.248779296875 385.49725341796875 1101.248779296875 385.0Q1101.248779296875 384.5741271972656 1101.3897705078125 384.17230224609375ZM1181.00537109375 260.69610595703125 1149.03369140625 356.509521484375H1213.1806640625L1181.00537109375 260.69610595703125Z"
            fill="var(--color-mark-accent)"
          />
        </g>
      </g>
    </svg>
  );
}
