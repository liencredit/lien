import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import type { Band, Limit, Status } from "../scoring/types.js";

// Shareable credit-certificate card (1200×630, OG-friendly) rendered server-side
// so links to an agent unfurl with the agent's actual score. Styling mirrors the
// lien.credit certificate aesthetic: bone paper, oxblood ink, Playfair + JetBrains Mono.

const W = 1200;
const H = 630;

// Brand palette (matches the frontend theme).
const C = {
  bone: "#F2ECDF",
  boneDeep: "#E9E0CD",
  oxblood: "#7A2230",
  ink: "#211C17",
  inkSoft: "#6B5F50",
  green: "#2E6B4A",
  amber: "#B5791F",
  red: "#9B2D2D",
};

const BAND_LABEL: Record<Band, string> = {
  poor: "Poor",
  fair: "Fair",
  good: "Good",
  very_good: "Very good",
  excellent: "Excellent",
};

const STATUS_META: Record<Status, { label: string; color: string }> = {
  good_standing: { label: "GOOD STANDING", color: C.green },
  on_watch: { label: "ON WATCH", color: C.amber },
  defaulted: { label: "DEFAULTED", color: C.red },
};

export interface CardData {
  agentId: string;
  name: string | null;
  score: number;
  band: Band;
  status: Status;
  limit: Limit | null;
  verified8004: boolean;
}

// --- Fonts (loaded once) ---

const fontsDir = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));
const font = (file: string) => readFileSync(`${fontsDir}${file}`);

const FONTS = [
  { name: "Playfair Display", data: font("PlayfairDisplay-Bold.ttf"), weight: 700 as const, style: "normal" as const },
  { name: "Playfair Display", data: font("PlayfairDisplay-Black.ttf"), weight: 900 as const, style: "normal" as const },
  { name: "JetBrains Mono", data: font("JetBrainsMono-Regular.ttf"), weight: 400 as const, style: "normal" as const },
  { name: "JetBrains Mono", data: font("JetBrainsMono-Bold.ttf"), weight: 700 as const, style: "normal" as const },
];

// --- Tiny hyperscript helper so we avoid JSX in a plain .ts file ---

type Node = string | number | Element | null | undefined;
interface Element {
  type: string;
  props: { style?: Record<string, unknown>; children?: Node | Node[] };
}

function h(type: string, style: Record<string, unknown>, ...children: Node[]): Element {
  return { type, props: { style, children: children.length === 1 ? children[0] : children } };
}

const MONO = "JetBrains Mono";
const SERIF = "Playfair Display";

function shortId(id: string): string {
  const tail = id.includes(":") ? id.split(":").pop()! : id;
  if (tail.length <= 22) return tail;
  return `${tail.slice(0, 12)}…${tail.slice(-6)}`;
}

function formatLimit(limit: Limit | null): string {
  if (!limit) return "No credit line";
  const major = Math.round(limit.amount / 1_000_000);
  return `$${major.toLocaleString("en-US")} / ${limit.period}`;
}

function buildTree(d: CardData): Element {
  const status = STATUS_META[d.status];
  const name = d.name?.trim() || shortId(d.agentId);
  const today = new Date().toISOString().slice(0, 10);

  return h(
    "div",
    {
      width: W,
      height: H,
      display: "flex",
      padding: 26,
      backgroundColor: C.bone,
      fontFamily: MONO,
    },
    // Framed certificate
    h(
      "div",
      {
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        border: `2px solid ${C.oxblood}`,
        backgroundColor: C.bone,
      },
      // Header
      h(
        "div",
        {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          padding: "26px 40px",
          borderBottom: `1px solid ${C.oxblood}`,
        },
        h(
          "div",
          { display: "flex", flexDirection: "column" },
          h("div", { fontFamily: SERIF, fontWeight: 900, fontSize: 40, color: C.oxblood, lineHeight: 1 }, "LIEN"),
          h(
            "div",
            { fontSize: 12, letterSpacing: 3, color: C.inkSoft, marginTop: 6 },
            "AGENT CREDIT BUREAU",
          ),
        ),
        h(
          "div",
          { display: "flex", flexDirection: "column", alignItems: "flex-end" },
          h("div", { fontSize: 13, letterSpacing: 3, color: C.oxblood }, "CREDIT CERTIFICATE"),
          h("div", { fontSize: 13, color: C.inkSoft, marginTop: 6 }, `ISSUED ${today}`),
        ),
      ),
      // Body
      h(
        "div",
        { display: "flex", flexGrow: 1, padding: "36px 40px", alignItems: "center" },
        // Left: identity + status + limit
        h(
          "div",
          { display: "flex", flexDirection: "column", flexGrow: 1, paddingRight: 30 },
          h(
            "div",
            { display: "flex", fontFamily: SERIF, fontWeight: 700, fontSize: 52, color: C.ink, lineHeight: 1.05 },
            name,
          ),
          h(
            "div",
            { display: "flex", fontSize: 16, color: C.inkSoft, marginTop: 12 },
            shortId(d.agentId),
          ),
          h(
            "div",
            {
              display: "flex",
              alignSelf: "flex-start",
              marginTop: 26,
              padding: "9px 16px",
              border: `2px solid ${status.color}`,
              color: status.color,
              fontSize: 17,
              fontWeight: 700,
              letterSpacing: 3,
            },
            status.label,
          ),
          h(
            "div",
            { display: "flex", flexDirection: "column", marginTop: 24 },
            h("div", { fontSize: 12, letterSpacing: 2, color: C.inkSoft }, "RECOMMENDED LIMIT"),
            h("div", { fontSize: 28, color: C.ink, marginTop: 4 }, formatLimit(d.limit)),
          ),
        ),
        // Right: the score
        h(
          "div",
          {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            width: 380,
            borderLeft: `1px solid ${C.oxblood}`,
          },
          h("div", { fontSize: 12, letterSpacing: 3, color: C.inkSoft }, "LIEN SCORE"),
          h(
            "div",
            { fontFamily: MONO, fontWeight: 700, fontSize: 168, color: C.oxblood, lineHeight: 1, marginTop: 4 },
            String(d.score),
          ),
          h("div", { fontSize: 16, color: C.inkSoft }, "300 – 850"),
          h(
            "div",
            { fontFamily: SERIF, fontWeight: 700, fontSize: 26, color: C.oxblood, marginTop: 10 },
            BAND_LABEL[d.band],
          ),
        ),
      ),
      // Footer
      h(
        "div",
        {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 40px",
          borderTop: `1px solid ${C.oxblood}`,
          fontSize: 13,
          letterSpacing: 2,
          color: C.inkSoft,
        },
        h("div", { display: "flex" }, d.verified8004 ? "8004 VERIFIED · SOLANA MAINNET" : "PAYMENT WALLET · SOLANA"),
        h("div", { display: "flex" }, "LIEN.CREDIT"),
      ),
    ),
  );
}

/** Render the certificate to a PNG buffer. */
export async function renderCardPng(data: CardData): Promise<Buffer> {
  const tree = buildTree(data) as unknown as Parameters<typeof satori>[0];
  const svg = await satori(tree, { width: W, height: H, fonts: FONTS });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng();
  return png;
}
